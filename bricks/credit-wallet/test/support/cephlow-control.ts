// A TEST-ONLY copy of how cephlow changes a balance, kept so the 50-way test can be pointed at the original and
// shown to fail. It is the negative control: if this passed the invariant, the test could not see the bug and a
// pass on the brick would mean nothing. Nothing outside tests imports this file.
//
// Sources, read 2026-10-20 (cephlow is never modified):
//   top-up    apps/api-worker/src/routes/payments.ts, POST /payments/verify, lines 36-136
//   deduction apps/api-worker/src/routes/clientGenerate.ts, lines 99-130
// The sequence of awaited calls is kept the same; only the Hono request handling around them is removed.
import type { D1Like } from "../../src/d1.ts";
import { applyMigration } from "../../src/migrate.ts";
import type { Op, Outcome } from "./workload.ts";

// Copied unchanged from apps/api-worker/schema.sql (the three tables the wallet uses); balances are REAL there.
export const CEPHLOW2_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  current_balance REAL NOT NULL DEFAULT 0,
  transfer_code TEXT UNIQUE,
  generation_cost REAL NOT NULL DEFAULT 1.0,
  email_cost REAL NOT NULL DEFAULT 0.2,
  whatsapp_cost REAL NOT NULL DEFAULT 0.5,
  suspended INTEGER NOT NULL DEFAULT 0,
  suspended_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ledgers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  balance_after REAL NOT NULL,
  description TEXT NOT NULL,
  metadata TEXT,
  transfer_id TEXT,
  action_type TEXT CHECK (action_type IN ('generation', 'email', 'whatsapp')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payment_orders (
  order_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  amount REAL NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export async function setupControl(db: D1Like): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS workspaces").run();
  await db.prepare("DROP TABLE IF EXISTS ledgers").run();
  await db.prepare("DROP TABLE IF EXISTS payment_orders").run();
  await applyMigration(db, CEPHLOW2_SCHEMA);
}

export async function seedControl(db: D1Like, workspaceId: string, start: number, ops: Op[]): Promise<void> {
  await db.prepare("INSERT INTO workspaces (id, name, owner_id, current_balance) VALUES (?, 'control', 'user-1', ?)").bind(workspaceId, start).run();
  for (const op of ops) {
    if (op.kind !== "topup") continue;
    await db
      .prepare("INSERT INTO payment_orders (order_id, workspace_id, user_id, amount) VALUES (?, ?, 'user-1', ?)")
      .bind(op.orderId, workspaceId, op.amount)
      .run();
  }
}

/** The payment gateway as the original sees it after `fetchCashfreeOrder`: the order is PAID for its amount. */
const paidGateway = async (_orderId: string, amount: number) => ({ order_status: "PAID", order_amount: amount });

/**
 * cephlow's POST /payments/verify, minus HTTP. Read the order, check `processed`, ask the gateway, read the
 * balance, add in JavaScript, then write the absolute value in a batch.
 */
export async function cephlowVerify(db: D1Like, orderId: string): Promise<{ credited: boolean }> {
  const orderRow = await db
    .prepare("SELECT workspace_id, user_id, amount, processed FROM payment_orders WHERE order_id = ?")
    .bind(orderId)
    .first<{ workspace_id: string; user_id: string; amount: number; processed: number }>();
  if (!orderRow) return { credited: false };
  if (orderRow.processed) return { credited: false };

  const cfOrder = await paidGateway(orderId, orderRow.amount);
  if (cfOrder.order_status !== "PAID") return { credited: false };

  const credits = (cfOrder.order_amount || orderRow.amount) * 1; // CREDITS_PER_RUPEE = 1
  const ws = await db.prepare("SELECT current_balance FROM workspaces WHERE id = ?").bind(orderRow.workspace_id).first<{ current_balance: number }>();
  if (!ws) return { credited: false };

  const newBalance = ws.current_balance + credits;
  await db.batch([
    db.prepare("UPDATE workspaces SET current_balance = ? WHERE id = ?").bind(newBalance, orderRow.workspace_id),
    db
      .prepare(
        "INSERT INTO ledgers (id, workspace_id, user_id, type, amount, balance_after, description, metadata) VALUES (?, ?, ?, 'topup', ?, ?, 'Top-up via Cashfree', ?)",
      )
      .bind(crypto.randomUUID(), orderRow.workspace_id, orderRow.user_id, credits, newBalance, JSON.stringify({ order_id: orderId })),
    db.prepare("UPDATE payment_orders SET processed = 1 WHERE order_id = ?").bind(orderId),
  ]);
  return { credited: true };
}

/**
 * cephlow's deduction in clientGenerate.ts: read the balance, take the cost with one conditional UPDATE that
 * returns the new balance (this part is atomic), then record it in a later batch.
 */
export async function cephlowDeduct(db: D1Like, workspaceId: string, cost: number): Promise<{ accepted: boolean }> {
  const ws = await db.prepare("SELECT current_balance FROM workspaces WHERE id = ?").bind(workspaceId).first<{ current_balance: number }>();
  if (!ws) return { accepted: false };

  const updated = await db
    .prepare("UPDATE workspaces SET current_balance = current_balance - ? WHERE id = ? AND current_balance >= ? RETURNING current_balance")
    .bind(cost, workspaceId, cost)
    .first<{ current_balance: number }>();
  if (!updated) return { accepted: false };

  await db.batch([
    db
      .prepare(
        "INSERT INTO ledgers (id, workspace_id, user_id, type, amount, balance_after, description, metadata) VALUES (?, ?, 'user-1', 'deduction', ?, ?, 'Certificate generation', '{}')",
      )
      .bind(crypto.randomUUID(), workspaceId, -cost, updated.current_balance),
  ]);
  return { accepted: true };
}

export async function runControlOp(db: D1Like, workspaceId: string, op: Op): Promise<Outcome> {
  if (op.kind === "topup") {
    const { credited } = await cephlowVerify(db, op.orderId!);
    return { op, accepted: credited };
  }
  const { accepted } = await cephlowDeduct(db, workspaceId, op.amount);
  return { op, accepted };
}
