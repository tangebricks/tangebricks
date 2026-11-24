import { scoped } from "@poc/sdk";
import type { D1Like } from "./d1.ts";
import type { PaymentGateway } from "./gateway.ts";

// Every change to a balance in this file is one D1 batch, and the batch is the only place a balance is written.
// No balance is ever read into JavaScript, changed there and written back. Three facts about D1 carry the design
// (each is pinned by a test in H5.control.test.ts):
//   1. a batch runs its statements in order, and no other batch interleaves with it;
//   2. a statement that raises (a CHECK or UNIQUE violation) rolls the whole batch back;
//   3. an UPDATE that matches no rows raises nothing and does not roll back.
// So the rules the wallet needs are written as constraints in the migrations (balance >= 0, one ledger row per
// idempotency key per workspace), and a violation reaches this code as an error that means "refuse", not as a
// half-done write.
//
// Idempotency keys belong to a workspace (migration 0002, AD-V2): the same key used by two workspaces is two
// different operations, and every lookup by key also filters by workspace, so one workspace can never be answered
// with another's ledger row or balance.

export type DeductResult =
  | { ok: true; balanceAfter: number; duplicate: boolean }
  | { ok: false; reason: "insufficient_balance" | "wallet_not_found"; balance: number | null };

export type ConfirmResult =
  | { status: "PAID"; credited: true; credits: number; amount: number; balanceAfter: number }
  | { status: "already_processed"; credited: false }
  | { status: "order_not_found" | "wallet_not_found" | "gateway_error" | "invalid_amount"; credited: false }
  | { status: string; credited: false };

export interface OrderRow {
  orderId: string;
  workspaceId: string;
  userId: string;
  amount: number;
  processed: boolean;
}

export interface Wallet {
  openWallet(workspaceId: string, initialBalance?: number): Promise<void>;
  getBalance(workspaceId: string): Promise<number | null>;
  deduct(input: { workspaceId: string; userId: string; amount: number; reason: string; metadata?: Record<string, unknown>; idempotencyKey?: string }): Promise<DeductResult>;
  refund(input: { workspaceId: string; userId: string; amount: number; reason: string; metadata?: Record<string, unknown>; idempotencyKey?: string }): Promise<DeductResult>;
  createOrder(input: { workspaceId: string; userId: string; amount: number }): Promise<{ orderId: string; paymentSessionId: string }>;
  getOrder(orderId: string): Promise<OrderRow | null>;
  confirmOrder(orderId: string): Promise<ConfirmResult>;
}

const isWholeAmount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isOverdraw = (error: unknown) => /CHECK constraint failed: (balance|balance_after) >= 0/.test(errorText(error));
// Migration 0002 makes the key unique per (workspace_id, idempotency_key); SQLite names both columns.
const isDuplicateKey = (error: unknown) =>
  /UNIQUE constraint failed: credit_ledger\.workspace_id, credit_ledger\.idempotency_key/.test(errorText(error));

export function createWallet(db: D1Like, gateway: PaymentGateway | undefined, options: { creditsPerUnit?: number; minOrderAmount?: number } = {}): Wallet {
  const creditsPerUnit = options.creditsPerUnit ?? 1;
  const minOrderAmount = options.minOrderAmount ?? 1;

  async function getBalance(workspaceId: string): Promise<number | null> {
    const row = await scoped(db, workspaceId).first<{ balance: number }>("credit_wallets");
    return row ? row.balance : null;
  }

  async function ledgerRowFor(workspaceId: string, key: string) {
    return db
      .prepare("SELECT balance_after FROM credit_ledger WHERE workspace_id = ? AND idempotency_key = ?")
      .bind(workspaceId, key)
      .first<{ balance_after: number }>();
  }

  // This operation's own ledger row, found by its id and workspace: the newest row for the workspace could be
  // another caller's.
  async function ownLedgerRow(workspaceId: string, ledgerId: string) {
    return db
      .prepare("SELECT balance_after FROM credit_ledger WHERE id = ? AND workspace_id = ?")
      .bind(ledgerId, workspaceId)
      .first<{ balance_after: number }>();
  }

  return {
    getBalance,

    async getOrder(orderId) {
      // POST /payments/verify has no workspace context by design (a suspended workspace must still be able to complete
      // a charged payment); the route checks the order's user_id against the caller before anything else.
      // tenant-lint: allow payment verification resolves an order by its unguessable id, then checks its owner
      const row = await db
        .prepare("SELECT order_id, workspace_id, user_id, amount, processed FROM credit_orders WHERE order_id = ?")
        .bind(orderId)
        .first<{ order_id: string; workspace_id: string; user_id: string; amount: number; processed: number }>();
      return row ? { orderId: row.order_id, workspaceId: row.workspace_id, userId: row.user_id, amount: row.amount, processed: Boolean(row.processed) } : null;
    },

    async openWallet(workspaceId, initialBalance = 0) {
      if (!Number.isSafeInteger(initialBalance) || initialBalance < 0) throw new RangeError("initialBalance must be a whole number, zero or more");
      await db.prepare("INSERT OR IGNORE INTO credit_wallets (workspace_id, balance) VALUES (?, ?)").bind(workspaceId, initialBalance).run();
    },

    async deduct({ workspaceId, userId, amount, reason, metadata = {}, idempotencyKey }) {
      if (!isWholeAmount(amount)) throw new RangeError("amount must be a positive whole number");
      const ledgerId = crypto.randomUUID();
      try {
        const [debit] = await db.batch([
          // Raises (CHECK balance >= 0) when the wallet cannot cover the amount; that rolls the whole batch back.
          db.prepare("UPDATE credit_wallets SET balance = balance - ? WHERE workspace_id = ?").bind(amount, workspaceId),
          // balance_after is read here, inside the batch, after the debit and before anything else can run.
          // No wallet row means no ledger row: a refusal leaves no trace.
          db
            .prepare(
              "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason, metadata, idempotency_key) " +
                "SELECT ?, workspace_id, ?, 'deduction', ?, balance, ?, ?, ? FROM credit_wallets WHERE workspace_id = ?",
            )
            .bind(ledgerId, userId, -amount, reason, JSON.stringify(metadata), idempotencyKey ?? null, workspaceId),
        ]);
        if (debit!.meta.changes === 0) return { ok: false, reason: "wallet_not_found", balance: null };
        const own = await ownLedgerRow(workspaceId, ledgerId);
        return { ok: true, balanceAfter: own!.balance_after, duplicate: false };
      } catch (error) {
        if (isOverdraw(error)) return { ok: false, reason: "insufficient_balance", balance: await getBalance(workspaceId) };
        if (idempotencyKey && isDuplicateKey(error)) {
          const earlier = await ledgerRowFor(workspaceId, idempotencyKey);
          return { ok: true, balanceAfter: earlier?.balance_after ?? 0, duplicate: true };
        }
        throw error;
      }
    },

    async refund({ workspaceId, userId, amount, reason, metadata = {}, idempotencyKey }) {
      if (!isWholeAmount(amount)) throw new RangeError("amount must be a positive whole number");
      const ledgerId = crypto.randomUUID();
      try {
        const [credit] = await db.batch([
          db.prepare("UPDATE credit_wallets SET balance = balance + ? WHERE workspace_id = ?").bind(amount, workspaceId),
          db
            .prepare(
              "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason, metadata, idempotency_key) " +
                "SELECT ?, workspace_id, ?, 'topup', ?, balance, ?, ?, ? FROM credit_wallets WHERE workspace_id = ?",
            )
            .bind(ledgerId, userId, amount, reason, JSON.stringify(metadata), idempotencyKey ?? null, workspaceId),
        ]);
        if (credit!.meta.changes === 0) return { ok: false, reason: "wallet_not_found", balance: null };
        const own = await ownLedgerRow(workspaceId, ledgerId);
        return { ok: true, balanceAfter: own!.balance_after, duplicate: false };
      } catch (error) {
        if (idempotencyKey && isDuplicateKey(error)) {
          const earlier = await ledgerRowFor(workspaceId, idempotencyKey);
          return { ok: true, balanceAfter: earlier?.balance_after ?? 0, duplicate: true };
        }
        throw error;
      }
    },

    async createOrder({ workspaceId, userId, amount }) {
      if (!isWholeAmount(amount)) throw new RangeError("amount must be a positive whole number");
      if (amount < minOrderAmount) throw new RangeError(`amount is below the minimum of ${minOrderAmount}`);
      const orderId = `order_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      if (!gateway) throw new Error("this wallet was created without a payment gateway");
      const created = await gateway.createOrder({ orderId, amount, customerId: userId });
      await scoped(db, workspaceId).insert("credit_orders", {
        order_id: orderId,
        user_id: userId,
        amount,
        processed: 0,
      });
      return { orderId, paymentSessionId: created.paymentSessionId };
    },

    async confirmOrder(orderId) {
      // The order row is what names the workspace (see getOrder); every statement after this one binds it.
      // tenant-lint: allow payment confirmation resolves an order by its unguessable id to learn its workspace
      const order = await db
        .prepare("SELECT workspace_id, user_id, amount, processed FROM credit_orders WHERE order_id = ?")
        .bind(orderId)
        .first<{ workspace_id: string; user_id: string; amount: number; processed: number }>();
      if (!order) return { status: "order_not_found", credited: false };
      if (order.processed) return { status: "already_processed", credited: false };

      if (!gateway) throw new Error("this wallet was created without a payment gateway");
      let gatewayOrder;
      try {
        gatewayOrder = await gateway.fetchOrder(orderId);
      } catch {
        return { status: "gateway_error", credited: false };
      }
      if (gatewayOrder.status !== "PAID") return { status: gatewayOrder.status, credited: false };

      const credits = (gatewayOrder.amount || order.amount) * creditsPerUnit;
      if (!isWholeAmount(credits)) return { status: "invalid_amount", credited: false };
      const key = `order:${orderId}`;

      try {
        const results = await db.batch([
          db.prepare("UPDATE credit_wallets SET balance = balance + ? WHERE workspace_id = ?").bind(credits, order.workspace_id),
          // The (workspace_id, idempotency_key) unique key is what makes a second confirmation of this order
          // impossible to commit: it raises, and the balance change above is rolled back with it.
          db
            .prepare(
              "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason, metadata, idempotency_key) " +
                "SELECT ?, workspace_id, ?, 'topup', ?, balance, 'Top-up', ?, ? FROM credit_wallets WHERE workspace_id = ?",
            )
            .bind(crypto.randomUUID(), order.user_id, credits, JSON.stringify({ order_id: orderId, amount_paid: gatewayOrder.amount, credits_per_unit: creditsPerUnit }), key, order.workspace_id),
          // Marked processed only if the ledger row above exists, so an order can never be closed without a credit.
          db
            .prepare(
              "UPDATE credit_orders SET processed = 1 WHERE order_id = ? AND workspace_id = ? AND processed = 0 " +
                "AND EXISTS (SELECT 1 FROM credit_ledger WHERE workspace_id = ? AND idempotency_key = ?)",
            )
            .bind(orderId, order.workspace_id, order.workspace_id, key),
        ]);
        if (results[0]!.meta.changes === 0) return { status: "wallet_not_found", credited: false };
        const balanceAfter = (await ledgerRowFor(order.workspace_id, key))?.balance_after ?? 0;
        return { status: "PAID", credited: true, credits, amount: gatewayOrder.amount, balanceAfter };
      } catch (error) {
        if (isDuplicateKey(error)) return { status: "already_processed", credited: false };
        throw error;
      }
    },
  };
}
