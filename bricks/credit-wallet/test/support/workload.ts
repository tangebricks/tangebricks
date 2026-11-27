import type { D1Like } from "../../src/d1.ts";

/** One operation in a mixed workload. */
export interface Op {
  kind: "topup" | "deduct";
  amount: number;
  /** Top-ups carry the payment order they confirm. */
  orderId?: string;
}

/** What happened to one operation. A deduction can be refused for insufficient balance; a top-up is always accepted. */
export interface Outcome {
  op: Op;
  accepted: boolean;
}

export interface Workload {
  start: number;
  ops: Op[];
}

/** A small deterministic generator, so every one of the 20 runs is different and any run can be replayed from its number. */
export function seeded(seed: number): () => number {
  let a = (seed + 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fifty mixed operations on whole-number credits. The starting balance is low enough that some deductions are
 * refused in some orders, so the refusal path is exercised, and high enough that most are accepted.
 */
export function workload(run: number, size = 50): Workload {
  const next = seeded(run);
  const start = Math.floor(next() * 40);
  const ops: Op[] = Array.from({ length: size }, (_, i) => {
    const kind = next() < 0.5 ? "topup" : "deduct";
    const amount = 1 + Math.floor(next() * 20);
    return kind === "topup" ? { kind, amount, orderId: `run${run}-order${i}` } : { kind, amount };
  });
  return { start, ops };
}

export interface LedgerRow {
  id: string;
  type: string;
  amount: number;
  balance_after: number;
  metadata: string | null;
}

/**
 * Where a schema keeps the balance and the ledger, so one checker serves cephlow's tables and the brick's. Story 2.5: the
 * brick holds thousandths of a credit (migration 0004), so its columns are the `_milli` ones and its `scale` is 1000:
 * the workload's whole-credit amounts are converted at this boundary, and the invariants are checked in thousandths.
 */
export interface Tables {
  wallet: string;
  walletKey: string;
  balance: string;
  ledger: string;
  amount: string;
  balanceAfter: string;
  /** Stored units per whole credit of the workload. */
  scale: number;
}
export const CEPHLOW2_TABLES: Tables = {
  wallet: "workspaces",
  walletKey: "id",
  balance: "current_balance",
  ledger: "ledgers",
  amount: "amount",
  balanceAfter: "balance_after",
  scale: 1,
};
export const BRICK_TABLES: Tables = {
  wallet: "credit_wallets",
  walletKey: "workspace_id",
  balance: "balance_milli",
  ledger: "credit_ledger",
  amount: "amount_milli",
  balanceAfter: "balance_after_milli",
  scale: 1000,
};

/**
 * Applies the epic's definition of a violating run to what is in the database after the workload, and returns the
 * reasons (empty when the run is clean). The database is read; nothing here knows how the operations were run.
 *
 *  1. the final balance is start plus accepted top-ups minus accepted deductions;
 *  2. the ledger has one row per accepted operation (so refused ones left nothing, and nothing was lost or invented);
 *  3. replaying the ledger in insertion order from the starting balance reproduces every row's balance_after,
 *     and none is negative;
 *  4. no payment order was credited more than once.
 */
export async function violations(db: D1Like, workspaceId: string, start: number, outcomes: Outcome[], tables: Tables = CEPHLOW2_TABLES): Promise<string[]> {
  const reasons: string[] = [];
  const accepted = outcomes.filter((o) => o.accepted);
  const expected = accepted.reduce((sum, o) => sum + (o.op.kind === "topup" ? o.op.amount : -o.op.amount) * tables.scale, start * tables.scale);

  // Table and column names come from the two constants above, never from input.
  const ws = await db
    .prepare(`SELECT ${tables.balance} AS current_balance FROM ${tables.wallet} WHERE ${tables.walletKey} = ?`)
    .bind(workspaceId)
    .first<{ current_balance: number }>();
  if (!ws) return ["workspace row is missing"];
  if (ws.current_balance !== expected) reasons.push(`final balance ${ws.current_balance}, expected ${expected}`);
  if (ws.current_balance < 0) reasons.push(`final balance is negative: ${ws.current_balance}`);

  const { results: rows } = await db
    .prepare(
      `SELECT id, type, ${tables.amount} AS amount, ${tables.balanceAfter} AS balance_after, metadata FROM ${tables.ledger} WHERE workspace_id = ? ORDER BY rowid`,
    )
    .bind(workspaceId)
    .all<LedgerRow>();
  if (rows.length !== accepted.length) reasons.push(`ledger has ${rows.length} rows for ${accepted.length} accepted operations`);

  let running = start * tables.scale;
  let mismatches = 0;
  let negatives = 0;
  for (const row of rows) {
    running += row.amount;
    if (row.balance_after !== running) mismatches += 1;
    if (row.balance_after < 0) negatives += 1;
  }
  if (mismatches > 0) reasons.push(`${mismatches} ledger rows whose balance_after does not match a replay of the ledger`);
  if (negatives > 0) reasons.push(`${negatives} ledger rows with a negative balance_after`);

  const credited = new Map<string, number>();
  for (const row of rows) {
    if (row.type !== "topup") continue;
    const order = (JSON.parse(row.metadata ?? "{}") as { order_id?: string }).order_id;
    if (order) credited.set(order, (credited.get(order) ?? 0) + 1);
  }
  const twice = [...credited.values()].filter((n) => n > 1).length;
  if (twice > 0) reasons.push(`${twice} orders credited more than once`);

  return reasons;
}
