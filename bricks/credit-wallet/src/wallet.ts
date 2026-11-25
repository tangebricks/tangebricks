import { NotConfiguredError, checkGatewayOrder, findWorkspaceState, hasWorkspaceRegistry, isPaymentCurrency, scoped, toMilli, toMinorUnits } from "@poc/sdk";
import type { PaymentMismatchField } from "@poc/sdk";
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
//
// Units (story 2.5, migration 0004): every credit amount in this file is a whole number of thousandths of a credit
// ("milli-credits"), and every name that holds one ends in `Milli`. Conversion from and to decimal credits happens at
// the edges (the routes, with `toMilli` / `fromMilli` from @poc/sdk); nothing here adds or subtracts a float. Order
// amounts (`credit_orders.amount`) are money in whole major units, not credits, and are unchanged.

export type DeductResult =
  | { ok: true; balanceAfterMilli: number; duplicate: boolean }
  /**
   * Story 2.5: idempotency keys share one space per workspace (deductions, top-ups, charges, transfers). A key already on
   * the ledger for a different operation is refused: nothing is taken, and the answer is never ok.
   */
  | { ok: false; reason: "insufficient_balance" | "wallet_not_found" | "idempotency_key_reused"; balanceMilli: number | null };

/** What a retry must repeat to count as the same operation: the same amount, and these metadata values. */
export type IdempotencyMatch = Record<string, string | number | boolean>;

/** Story 2.5: the outcome of a transfer between two workspaces' wallets. Every refusal moved nothing. */
export type TransferResult =
  | { ok: true; transferCode: string; amountMilli: number; balanceAfterMilli: number; duplicate: boolean }
  | {
      ok: false;
      reason: "insufficient_balance" | "source_wallet_not_found" | "destination_not_found" | "same_workspace" | "idempotency_key_reused";
      balanceMilli: number | null;
    };

export type ConfirmResult =
  | { status: "PAID"; credited: true; creditsMilli: number; amount: number; balanceAfterMilli: number }
  | { status: "already_processed"; credited: false }
  /** Story 2.3: the provider's order differs from the stored one in `field`. Nothing was credited. */
  | { status: "verification_mismatch"; credited: false; field: PaymentMismatchField; workspaceId: string }
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
  /** Creates the workspace's wallet if it has none, holding `initialBalanceMilli` thousandths (default 0). */
  openWallet(workspaceId: string, initialBalanceMilli?: number): Promise<void>;
  /** The balance in thousandths of a credit, or null when the workspace has no wallet. */
  getBalanceMilli(workspaceId: string): Promise<number | null>;
  /**
   * Takes `amountMilli` once per key. Every deduction records an operation tag in its metadata: `op` ("wallet" unless
   * `match` says otherwise, e.g. "deduct", "node", "charger", "action") plus the rest of `match`. A key already on the
   * ledger answers `duplicate: true` only when that row is a deduction of the same amount carrying the same tags; any
   * other row, including one written before tags existed, is `idempotency_key_reused` and nothing is taken.
   */
  deduct(input: { workspaceId: string; userId: string; amountMilli: number; reason: string; metadata?: Record<string, unknown>; idempotencyKey?: string; match?: IdempotencyMatch }): Promise<DeductResult>;
  refund(input: { workspaceId: string; userId: string; amountMilli: number; reason: string; metadata?: Record<string, unknown>; idempotencyKey?: string }): Promise<DeductResult>;
  /**
   * Story 2.5: moves `amountMilli` from one workspace's wallet to another's in one D1 batch, idempotent per (source
   * workspace, key). The caller has already decided that `userId` may spend the source workspace's credits.
   */
  transfer(input: { fromWorkspaceId: string; toWorkspaceId: string; userId: string; amountMilli: number; idempotencyKey: string; note?: string }): Promise<TransferResult>;
  createOrder(input: { workspaceId: string; userId: string; amount: number }): Promise<{ orderId: string; paymentSessionId: string }>;
  getOrder(orderId: string): Promise<OrderRow | null>;
  confirmOrder(orderId: string): Promise<ConfirmResult>;
}

const isWholeAmount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isOverdraw = (error: unknown) => /CHECK constraint failed: (balance_milli|balance_after_milli) >= 0/.test(errorText(error));
// Migration 0002 makes the key unique per (workspace_id, idempotency_key); SQLite names both columns.
const isDuplicateKey = (error: unknown) =>
  /UNIQUE constraint failed: credit_ledger\.workspace_id, credit_ledger\.idempotency_key/.test(errorText(error));
// A transfer's ledger rows read their balance with a scalar subquery, which is NULL when that wallet does not exist:
// the NOT NULL column then raises, and the whole batch is rolled back.
const isMissingWallet = (error: unknown) => /NOT NULL constraint failed: credit_ledger\.balance_after_milli/.test(errorText(error));

/** A ledger row's metadata as an object, or null when it is missing, unreadable or not an object. */
function parseMetadata(text: string | null): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text ?? "null");
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface WalletOptions {
  /**
   * Credits added per whole unit of money paid. Story 2.5: a decimal with up to three places (a number or decimal text,
   * e.g. 0.5 or "2.125"), above zero; it is held as a whole number of thousandths and multiplies the order's whole
   * amount in integers. Default 1.
   */
  creditsPerUnit?: number | string;
  minOrderAmount?: number;
  /**
   * Story 2.3: the currency every order is created and verified in (ISO 4217, three uppercase letters). Required
   * whenever a gateway is used; there is no default, so creating or confirming an order without it fails NOT_CONFIGURED.
   */
  currency?: string;
}

export function createWallet(db: D1Like, gateway: PaymentGateway | undefined, options: WalletOptions = {}): Wallet {
  const creditsPerUnitMilli = toMilli(options.creditsPerUnit ?? 1);
  if (creditsPerUnitMilli <= 0) throw new RangeError("creditsPerUnit must be above zero");
  const minOrderAmount = options.minOrderAmount ?? 1;
  const requireCurrency = (): string => {
    if (!isPaymentCurrency(options.currency)) throw new NotConfiguredError("no payment currency is configured (three uppercase letters, e.g. INR)");
    return options.currency;
  };

  async function getBalanceMilli(workspaceId: string): Promise<number | null> {
    const row = await scoped(db, workspaceId).first<{ balance_milli: number }>("credit_wallets");
    return row ? row.balance_milli : null;
  }

  async function ledgerRowFor(workspaceId: string, key: string) {
    return db
      .prepare("SELECT type, amount_milli, balance_after_milli, transfer_code, metadata FROM credit_ledger WHERE workspace_id = ? AND idempotency_key = ?")
      .bind(workspaceId, key)
      .first<{ type: string; amount_milli: number; balance_after_milli: number; transfer_code: string | null; metadata: string | null }>();
  }

  // This operation's own ledger row, found by its id and workspace: the newest row for the workspace could be
  // another caller's.
  async function ownLedgerRow(workspaceId: string, ledgerId: string) {
    return db
      .prepare("SELECT balance_after_milli FROM credit_ledger WHERE id = ? AND workspace_id = ?")
      .bind(ledgerId, workspaceId)
      .first<{ balance_after_milli: number }>();
  }

  // Whether the row already under `key` is this very operation: same type, same signed amount, and every `match` value
  // in its metadata. "none" when the key is free.
  async function sameOperation(workspaceId: string, key: string, type: string, signedMilli: number, match: IdempotencyMatch = {}) {
    const row = await ledgerRowFor(workspaceId, key);
    if (!row) return { verdict: "none" as const };
    const meta = parseMetadata(row.metadata);
    // A row with no readable metadata object (or none of the tags) is never the same operation.
    const same = meta !== null && row.type === type && row.amount_milli === signedMilli && Object.entries(match).every(([k, v]) => meta[k] === v);
    return same ? { verdict: "same" as const, balanceAfterMilli: row.balance_after_milli } : { verdict: "different" as const };
  }

  // The answer to a transfer whose key is already on the source's ledger: the earlier transfer, or a refusal when the
  // key was used for something else, or for a transfer to another workspace or of another amount.
  async function earlierTransfer(fromWorkspaceId: string, toWorkspaceId: string, amountMilli: number, key: string): Promise<TransferResult | null> {
    const row = await ledgerRowFor(fromWorkspaceId, key);
    if (!row) return null;
    const to = parseMetadata(row.metadata)?.to_workspace_id;
    if (row.type !== "transfer_out" || !row.transfer_code || to !== toWorkspaceId || -row.amount_milli !== amountMilli) {
      return { ok: false, reason: "idempotency_key_reused", balanceMilli: null };
    }
    return { ok: true, transferCode: row.transfer_code, amountMilli, balanceAfterMilli: row.balance_after_milli, duplicate: true };
  }

  return {
    getBalanceMilli,

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

    async openWallet(workspaceId, initialBalanceMilli = 0) {
      if (!Number.isSafeInteger(initialBalanceMilli) || initialBalanceMilli < 0) throw new RangeError("initialBalanceMilli must be a whole number of thousandths, zero or more");
      await db.prepare("INSERT OR IGNORE INTO credit_wallets (workspace_id, balance_milli) VALUES (?, ?)").bind(workspaceId, initialBalanceMilli).run();
    },

    async deduct({ workspaceId, userId, amountMilli, reason, metadata = {}, idempotencyKey, match }) {
      if (!isWholeAmount(amountMilli)) throw new RangeError("amountMilli must be a positive whole number of thousandths");
      // Every deduction records who made it (an operation tag, "wallet" by default), and a retry is honoured only when the
      // row under its key carries the same tags: one caller's key can never be answered with another caller's deduction.
      const tags: IdempotencyMatch = { op: "wallet", ...match };
      const recorded = { ...metadata, ...tags };
      const ledgerId = crypto.randomUUID();
      try {
        const [debit] = await db.batch([
          // Raises (CHECK balance_milli >= 0) when the wallet cannot cover the amount; that rolls the whole batch back.
          db.prepare("UPDATE credit_wallets SET balance_milli = balance_milli - ? WHERE workspace_id = ?").bind(amountMilli, workspaceId),
          // balance_after_milli is read here, inside the batch, after the debit and before anything else can run.
          // No wallet row means no ledger row: a refusal leaves no trace.
          db
            .prepare(
              "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount_milli, balance_after_milli, reason, metadata, idempotency_key) " +
                "SELECT ?, workspace_id, ?, 'deduction', ?, balance_milli, ?, ?, ? FROM credit_wallets WHERE workspace_id = ?",
            )
            .bind(ledgerId, userId, -amountMilli, reason, JSON.stringify(recorded), idempotencyKey ?? null, workspaceId),
        ]);
        if (debit!.meta.changes === 0) return { ok: false, reason: "wallet_not_found", balanceMilli: null };
        const own = await ownLedgerRow(workspaceId, ledgerId);
        return { ok: true, balanceAfterMilli: own!.balance_after_milli, duplicate: false };
      } catch (error) {
        // The balance is checked before the key, so an overdraw may hide a retry whose first attempt committed.
        if (idempotencyKey && (isOverdraw(error) || isDuplicateKey(error))) {
          const earlier = await sameOperation(workspaceId, idempotencyKey, "deduction", -amountMilli, tags);
          if (earlier.verdict === "same") return { ok: true, balanceAfterMilli: earlier.balanceAfterMilli, duplicate: true };
          if (earlier.verdict === "different") return { ok: false, reason: "idempotency_key_reused", balanceMilli: null };
        }
        if (isOverdraw(error)) return { ok: false, reason: "insufficient_balance", balanceMilli: await getBalanceMilli(workspaceId) };
        throw error;
      }
    },

    async refund({ workspaceId, userId, amountMilli, reason, metadata = {}, idempotencyKey }) {
      if (!isWholeAmount(amountMilli)) throw new RangeError("amountMilli must be a positive whole number of thousandths");
      const ledgerId = crypto.randomUUID();
      try {
        const [credit] = await db.batch([
          db.prepare("UPDATE credit_wallets SET balance_milli = balance_milli + ? WHERE workspace_id = ?").bind(amountMilli, workspaceId),
          db
            .prepare(
              "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount_milli, balance_after_milli, reason, metadata, idempotency_key) " +
                "SELECT ?, workspace_id, ?, 'topup', ?, balance_milli, ?, ?, ? FROM credit_wallets WHERE workspace_id = ?",
            )
            .bind(ledgerId, userId, amountMilli, reason, JSON.stringify(metadata), idempotencyKey ?? null, workspaceId),
        ]);
        if (credit!.meta.changes === 0) return { ok: false, reason: "wallet_not_found", balanceMilli: null };
        const own = await ownLedgerRow(workspaceId, ledgerId);
        return { ok: true, balanceAfterMilli: own!.balance_after_milli, duplicate: false };
      } catch (error) {
        if (idempotencyKey && isDuplicateKey(error)) {
          const earlier = await sameOperation(workspaceId, idempotencyKey, "topup", amountMilli);
          if (earlier.verdict === "same") return { ok: true, balanceAfterMilli: earlier.balanceAfterMilli, duplicate: true };
          return { ok: false, reason: "idempotency_key_reused", balanceMilli: null };
        }
        throw error;
      }
    },

    async transfer({ fromWorkspaceId, toWorkspaceId, userId, amountMilli, idempotencyKey, note }) {
      if (!isWholeAmount(amountMilli)) throw new RangeError("amountMilli must be a positive whole number of thousandths");
      if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || idempotencyKey.length > 200) {
        throw new RangeError("idempotencyKey must be 1 to 200 characters");
      }
      if (fromWorkspaceId === toWorkspaceId) return { ok: false, reason: "same_workspace", balanceMilli: null };

      // A retry whose transfer already committed is answered from the ledger first, because the balance check would
      // otherwise refuse a retry that the first attempt left too little for.
      const earlier = await earlierTransfer(fromWorkspaceId, toWorkspaceId, amountMilli, idempotencyKey);
      if (earlier) return earlier;
      const sourceBalance = await getBalanceMilli(fromWorkspaceId);
      if (sourceBalance === null) return { ok: false, reason: "source_wallet_not_found", balanceMilli: null };
      // Sufficiency first, so a caller who cannot cover the amount learns nothing about the destination (402 whatever it
      // is). The batch below still enforces it atomically.
      if (sourceBalance < amountMilli) return { ok: false, reason: "insufficient_balance", balanceMilli: sourceBalance };
      // The destination must be an existing workspace that is not suspended (the row the workspace guard reads) and must
      // already have a wallet. Every way of failing that is the same answer; nothing of it reaches the caller. Without a
      // workspace registry (a host with its own guard), the destination's wallet is the only evidence.
      const registry = await hasWorkspaceRegistry(db);
      const state = registry ? await findWorkspaceState(db, toWorkspaceId) : null;
      if (registry && (!state || state.suspended)) return { ok: false, reason: "destination_not_found", balanceMilli: null };
      const destination = await db.prepare("SELECT 1 AS present FROM credit_wallets WHERE workspace_id = ?").bind(toWorkspaceId).first<{ present: number }>();
      if (!destination) return { ok: false, reason: "destination_not_found", balanceMilli: null };

      const transferCode = `tr_${crypto.randomUUID().replace(/-/g, "")}`;
      // The destination's state is checked again inside the batch: its credit and its ledger row apply only while its
      // workspace row is there and not suspended, so a suspension or deletion that lands between the check above and the
      // batch makes the row's balance NULL, which raises and rolls the whole transfer back.
      // (Whole literal statements, so the tenant-query lint can read each one.)
      const destinationArgs = registry ? [toWorkspaceId] : [];
      const creditDestination = registry
        ? "UPDATE credit_wallets SET balance_milli = balance_milli + ? WHERE workspace_id = ? AND EXISTS (SELECT 1 FROM mw_workspaces WHERE id = ? AND suspended = 0)"
        : "UPDATE credit_wallets SET balance_milli = balance_milli + ? WHERE workspace_id = ?";
      const insertOut =
        "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount_milli, balance_after_milli, reason, metadata, idempotency_key, transfer_code) " +
        "VALUES (?, ?, ?, ?, ?, (SELECT balance_milli FROM credit_wallets WHERE workspace_id = ?), ?, ?, ?, ?)";
      const insertIn = registry
        ? "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount_milli, balance_after_milli, reason, metadata, idempotency_key, transfer_code) " +
          "VALUES (?, ?, ?, ?, ?, (SELECT balance_milli FROM credit_wallets WHERE workspace_id = ? AND EXISTS (SELECT 1 FROM mw_workspaces WHERE id = ? AND suspended = 0)), ?, ?, ?, ?)"
        : insertOut;
      try {
        // One batch, all or nothing: the debit raises on an overdraw (CHECK balance_milli >= 0); a ledger row whose wallet
        // has gone raises (its balance subquery is NULL); a reused key raises (UNIQUE). Any of them rolls back every
        // statement, the destination's credit included.
        await db.batch([
          db.prepare("UPDATE credit_wallets SET balance_milli = balance_milli - ? WHERE workspace_id = ?").bind(amountMilli, fromWorkspaceId),
          db
            .prepare(creditDestination)
            .bind(amountMilli, toWorkspaceId, ...destinationArgs),
          db
            .prepare(insertOut)
            .bind(
              crypto.randomUUID(),
              fromWorkspaceId,
              userId,
              "transfer_out",
              -amountMilli,
              fromWorkspaceId,
              (note ?? "").slice(0, 200) || "Transfer out",
              JSON.stringify({ to_workspace_id: toWorkspaceId }),
              idempotencyKey,
              transferCode,
            ),
          // The destination's row names neither the source workspace nor its user: only the amount and the code.
          db
            .prepare(insertIn)
            .bind(crypto.randomUUID(), toWorkspaceId, "transfer", "transfer_in", amountMilli, toWorkspaceId, ...destinationArgs, "Transfer in", "{}", null, transferCode),
        ]);
      } catch (error) {
        if (isOverdraw(error) || isDuplicateKey(error)) {
          const settled = await earlierTransfer(fromWorkspaceId, toWorkspaceId, amountMilli, idempotencyKey);
          if (settled) return settled;
          if (isOverdraw(error)) return { ok: false, reason: "insufficient_balance", balanceMilli: await getBalanceMilli(fromWorkspaceId) };
        }
        if (isMissingWallet(error)) {
          if ((await getBalanceMilli(fromWorkspaceId)) === null) return { ok: false, reason: "source_wallet_not_found", balanceMilli: null };
          return { ok: false, reason: "destination_not_found", balanceMilli: null };
        }
        throw error;
      }
      const own = await ledgerRowFor(fromWorkspaceId, idempotencyKey);
      return { ok: true, transferCode, amountMilli, balanceAfterMilli: own!.balance_after_milli, duplicate: false };
    },

    async createOrder({ workspaceId, userId, amount }) {
      if (!isWholeAmount(amount)) throw new RangeError("amount must be a positive whole number");
      if (amount < minOrderAmount) throw new RangeError(`amount is below the minimum of ${minOrderAmount}`);
      const orderId = `order_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      if (!gateway) throw new Error("this wallet was created without a payment gateway");
      const currency = requireCurrency();
      // The wallet's orders are whole major units (rupees); the gateway interface speaks minor units (paise).
      const created = await gateway.createOrder({ orderId, amountMinor: toMinorUnits(amount, currency), currency, customerId: userId });
      try {
        await scoped(db, workspaceId).insert("credit_orders", {
          order_id: orderId,
          user_id: userId,
          amount,
          currency,
          provider_ref: created.providerRef,
          processed: 0,
        });
      } catch (error) {
        // The provider has an order this wallet has no row for: say which, so it can be found and cancelled.
        console.error(`credit-wallet: provider order created but not recorded (order ${orderId}, provider ref ${created.providerRef})`);
        throw error;
      }
      return { orderId, paymentSessionId: created.paymentSessionId };
    },

    async confirmOrder(orderId) {
      // The order row is what names the workspace (see getOrder); every statement after this one binds it.
      // tenant-lint: allow payment confirmation resolves an order by its unguessable id to learn its workspace
      const order = await db
        .prepare("SELECT workspace_id, user_id, amount, currency, provider_ref, processed FROM credit_orders WHERE order_id = ?")
        .bind(orderId)
        .first<{ workspace_id: string; user_id: string; amount: number; currency: string | null; provider_ref: string | null; processed: number }>();
      if (!order) return { status: "order_not_found", credited: false };
      if (order.processed) return { status: "already_processed", credited: false };

      if (!gateway) throw new Error("this wallet was created without a payment gateway");
      const configuredCurrency = requireCurrency();
      let gatewayOrder;
      try {
        gatewayOrder = await gateway.fetchOrder(orderId, order.provider_ref ?? undefined);
      } catch {
        // A provider that fetches by its own reference cannot find an order stored without one: say so, or the
        // retries end in a permanent, unexplained 502.
        if (!order.provider_ref) console.error(`credit-wallet: order has no provider reference, so the provider could not be asked about it (order ${orderId})`);
        return { status: "gateway_error", credited: false };
      }
      if (gatewayOrder.status !== "PAID") return { status: gatewayOrder.status, credited: false };

      // Story 2.3 (A20): a "PAID" answer is believed only for this very order: the same id, exactly the stored amount,
      // the stored currency (a row from before migration 0003 has none and is held to the configured one) and the
      // user who created it. Any difference credits nothing. The amount credited is always the stored one.
      // The stored amount is in major units; the provider's is in minor units, so the stored one is converted (exactly).
      const orderCurrency = order.currency ?? configuredCurrency;
      let expectedMinor: number;
      try {
        expectedMinor = toMinorUnits(order.amount, orderCurrency);
      } catch {
        return { status: "invalid_amount", credited: false };
      }
      const check = checkGatewayOrder(
        { orderId, amountMinor: expectedMinor, currency: orderCurrency, customerId: order.user_id },
        gatewayOrder,
      );
      if (!check.ok) return { status: "verification_mismatch", credited: false, field: check.field, workspaceId: order.workspace_id };

      // The order's whole amount times the multiplier's thousandths: an integer product, never a float.
      const creditsMilli = order.amount * creditsPerUnitMilli;
      if (!isWholeAmount(creditsMilli)) return { status: "invalid_amount", credited: false };
      const key = `order:${orderId}`;

      try {
        const results = await db.batch([
          db.prepare("UPDATE credit_wallets SET balance_milli = balance_milli + ? WHERE workspace_id = ?").bind(creditsMilli, order.workspace_id),
          // The (workspace_id, idempotency_key) unique key is what makes a second confirmation of this order
          // impossible to commit: it raises, and the balance change above is rolled back with it.
          db
            .prepare(
              "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount_milli, balance_after_milli, reason, metadata, idempotency_key) " +
                "SELECT ?, workspace_id, ?, 'topup', ?, balance_milli, 'Top-up', ?, ? FROM credit_wallets WHERE workspace_id = ?",
            )
            .bind(crypto.randomUUID(), order.user_id, creditsMilli, JSON.stringify({ order_id: orderId, amount_paid: order.amount, credits_per_unit_milli: creditsPerUnitMilli }), key, order.workspace_id),
          // Marked processed only if the ledger row above exists, so an order can never be closed without a credit.
          db
            .prepare(
              "UPDATE credit_orders SET processed = 1 WHERE order_id = ? AND workspace_id = ? AND processed = 0 " +
                "AND EXISTS (SELECT 1 FROM credit_ledger WHERE workspace_id = ? AND idempotency_key = ?)",
            )
            .bind(orderId, order.workspace_id, order.workspace_id, key),
        ]);
        if (results[0]!.meta.changes === 0) return { status: "wallet_not_found", credited: false };
        const balanceAfterMilli = (await ledgerRowFor(order.workspace_id, key))?.balance_after_milli ?? 0;
        return { status: "PAID", credited: true, creditsMilli, amount: order.amount, balanceAfterMilli };
      } catch (error) {
        if (isDuplicateKey(error)) return { status: "already_processed", credited: false };
        throw error;
      }
    },
  };
}
