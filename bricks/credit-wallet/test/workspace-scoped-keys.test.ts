import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { applyMigration, createWallet } from "../src/index.ts";
import type { D1Like } from "../src/index.ts";
import migration0001 from "../migrations/0001_credit_wallet.sql?raw";
import migration0002 from "../migrations/0002_workspace_scoped_idempotency.sql?raw";
import migration0003 from "../migrations/0003_order_currency.sql?raw";
import migration0004 from "../migrations/0004_milli_credits.sql?raw";

// Story 0.7 (AD-V2): idempotency keys belong to a workspace. Before migration 0002 the ledger's key was unique across
// the platform and looked up without a workspace, so a second workspace that reused a key got the first workspace's
// "duplicate" answer (and its balance) without being charged.
//
// Story 2.5: amounts are thousandths of a credit (migration 0004); the wallet API below speaks thousandths.

const db = env.DB as D1Like;
const A = "ws-keys-a";
const B = "ws-keys-b";

async function drop(): Promise<void> {
  for (const table of ["credit_ledger", "credit_ledger_v2", "credit_ledger_v3", "credit_orders", "credit_wallets", "credit_action_costs"]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
}

async function ledgerRows(workspaceId: string) {
  const { results } = await db
    .prepare("SELECT id, workspace_id, amount_milli, balance_after_milli, idempotency_key FROM credit_ledger WHERE workspace_id = ? ORDER BY rowid")
    .bind(workspaceId)
    .all<{ id: string; workspace_id: string; amount_milli: number; balance_after_milli: number; idempotency_key: string | null }>();
  return results;
}

describe("idempotency keys are per workspace (wallet)", () => {
  beforeEach(async () => {
    await drop();
    await applyMigration(db, migration0001);
    await applyMigration(db, migration0002);
    await applyMigration(db, migration0003);
    await applyMigration(db, migration0004);
  });

  test("KEY_REUSE_OTHER_TENANT: A is charged normally after B used the same key, and never sees B's balance", async () => {
    const wallet = createWallet(db, undefined);
    await wallet.openWallet(A, 1000);
    await wallet.openWallet(B, 50);

    const b = await wallet.deduct({ workspaceId: B, userId: "user-b", amountMilli: 20, reason: "usage", idempotencyKey: "k1" });
    expect(b).toEqual({ ok: true, balanceAfterMilli: 30, duplicate: false });

    const a = await wallet.deduct({ workspaceId: A, userId: "user-a", amountMilli: 100, reason: "usage", idempotencyKey: "k1" });
    expect(a).toEqual({ ok: true, balanceAfterMilli: 900, duplicate: false });
    expect(await wallet.getBalanceMilli(A)).toBe(900);
    expect(await wallet.getBalanceMilli(B)).toBe(30);
    expect(await ledgerRows(A)).toHaveLength(1);
    expect(await ledgerRows(B)).toHaveLength(1);
  });

  test("KEY_REUSE_OTHER_TENANT on refunds: A is credited normally after B used the same key", async () => {
    const wallet = createWallet(db, undefined);
    await wallet.openWallet(A, 10);
    await wallet.openWallet(B, 500);

    expect(await wallet.refund({ workspaceId: B, userId: "user-b", amountMilli: 5, reason: "refund", idempotencyKey: "r1" })).toEqual({
      ok: true,
      balanceAfterMilli: 505,
      duplicate: false,
    });
    expect(await wallet.refund({ workspaceId: A, userId: "user-a", amountMilli: 7, reason: "refund", idempotencyKey: "r1" })).toEqual({
      ok: true,
      balanceAfterMilli: 17,
      duplicate: false,
    });
  });

  test("KEY_REUSE_SAME_TENANT: a second call with A's key is a duplicate with A's earlier balance_after, and no second charge", async () => {
    const wallet = createWallet(db, undefined);
    await wallet.openWallet(A, 1000);
    await wallet.openWallet(B, 50);
    await wallet.deduct({ workspaceId: B, userId: "user-b", amountMilli: 20, reason: "usage", idempotencyKey: "k1" });

    const first = await wallet.deduct({ workspaceId: A, userId: "user-a", amountMilli: 100, reason: "usage", idempotencyKey: "k1" });
    // B spends again so that B's balance differs from anything A could be answered with.
    await wallet.deduct({ workspaceId: B, userId: "user-b", amountMilli: 5, reason: "usage", idempotencyKey: "k2" });
    const second = await wallet.deduct({ workspaceId: A, userId: "user-a", amountMilli: 100, reason: "usage", idempotencyKey: "k1" });

    expect(first).toEqual({ ok: true, balanceAfterMilli: 900, duplicate: false });
    expect(second).toEqual({ ok: true, balanceAfterMilli: 900, duplicate: true });
    expect(await wallet.getBalanceMilli(A)).toBe(900);
    expect(await ledgerRows(A)).toHaveLength(1);
  });

  test("KEY_REUSE_SAME_TENANT under concurrency: one charge, every answer is A's own balance", async () => {
    const wallet = createWallet(db, undefined);
    await wallet.openWallet(A, 1000);
    await wallet.openWallet(B, 7);
    await wallet.deduct({ workspaceId: B, userId: "user-b", amountMilli: 1, reason: "usage", idempotencyKey: "same" });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => wallet.deduct({ workspaceId: A, userId: "user-a", amountMilli: 10, reason: "usage", idempotencyKey: "same" })),
    );
    expect(results.filter((r) => r.ok && !r.duplicate)).toHaveLength(1);
    for (const r of results) expect(r).toMatchObject({ ok: true, balanceAfterMilli: 990 });
    expect(await wallet.getBalanceMilli(A)).toBe(990);
    expect(await wallet.getBalanceMilli(B)).toBe(6);
  });
});

/** Rows as the code before story 2.5 wrote them, in whole credits, under 0001's (or 0002's) columns. */
async function seedWholeCreditRows(): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO credit_wallets (workspace_id, balance) VALUES (?, 75), (?, 25)").bind(A, B),
    db
      .prepare(
        "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason, metadata, idempotency_key) VALUES ('l1', ?, 'user-a', 'deduction', -30, 70, 'usage', ?, 'old-a')",
      )
      .bind(A, JSON.stringify({ n: 1 })),
    db
      .prepare(
        "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason, metadata, idempotency_key) VALUES ('l2', ?, 'user-a', 'topup', 5, 75, 'refund', '{}', NULL)",
      )
      .bind(A),
    db
      .prepare(
        "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason, metadata, idempotency_key) VALUES ('l3', ?, 'user-b', 'deduction', -15, 25, 'usage', '{}', 'old-b')",
      )
      .bind(B),
    db.prepare("INSERT INTO credit_orders (order_id, workspace_id, user_id, amount, processed) VALUES ('order_keep', ?, 'user-a', 9, 1)").bind(A),
  ]);
}

describe("MIGRATION_PRESERVES: 0002 keeps every ledger row and the overdraw refusal", () => {
  beforeEach(async () => {
    await drop();
  });

  test("rows written under 0001 survive 0002 unchanged, and the CHECKs still refuse an overdraw", async () => {
    await applyMigration(db, migration0001);
    await seedWholeCreditRows();

    const before = await db.prepare("SELECT * FROM credit_ledger ORDER BY rowid").all();
    const walletsBefore = await db.prepare("SELECT * FROM credit_wallets ORDER BY workspace_id").all();
    const ordersBefore = await db.prepare("SELECT * FROM credit_orders ORDER BY order_id").all();
    expect(before.results).toHaveLength(3);

    await applyMigration(db, migration0002);

    expect((await db.prepare("SELECT * FROM credit_ledger ORDER BY rowid").all()).results).toEqual(before.results);
    expect((await db.prepare("SELECT * FROM credit_wallets ORDER BY workspace_id").all()).results).toEqual(walletsBefore.results);
    expect((await db.prepare("SELECT * FROM credit_orders ORDER BY order_id").all()).results).toEqual(ordersBefore.results);

    // The index is back, the temporary table is gone, and the key is now unique per (workspace_id, idempotency_key).
    const indexes = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'credit_ledger'").all<{ name: string }>();
    expect(indexes.results.map((r) => r.name)).toContain("credit_ledger_workspace_idx");
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE name = 'credit_ledger_v2'").first()).toBeNull();

    // CHECK (balance >= 0) on the wallet, CHECK (balance_after >= 0) and the type CHECK on the rebuilt ledger.
    await expect(db.prepare("UPDATE credit_wallets SET balance = balance - 76 WHERE workspace_id = ?").bind(A).run()).rejects.toThrow(
      /CHECK constraint failed: balance >= 0/,
    );
    await expect(
      db
        .prepare("INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason) VALUES ('neg', ?, 'u', 'deduction', -1, -1, 'x')")
        .bind(A)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: balance_after >= 0/);
    await expect(
      db
        .prepare("INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason) VALUES ('bad', ?, 'u', 'gift', 1, 1, 'x')")
        .bind(A)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    // The same key in another workspace is now allowed; in the same workspace it is not.
    await db
      .prepare(
        "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason, idempotency_key) VALUES ('l4', ?, 'u', 'deduction', -1, 24, 'x', 'old-a')",
      )
      .bind(B)
      .run();
    await expect(
      db
        .prepare(
          "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason, idempotency_key) VALUES ('l5', ?, 'u', 'deduction', -1, 69, 'x', 'old-a')",
        )
        .bind(A)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });
});

describe("MIGRATION_MILLI: 0004 converts whole credits to thousandths exactly, and every rule still holds", () => {
  beforeEach(async () => {
    await drop();
    await applyMigration(db, migration0001);
    await applyMigration(db, migration0002);
    await applyMigration(db, migration0003);
    await seedWholeCreditRows();
    await applyMigration(db, migration0004);
  });

  test("every balance and ledger amount is multiplied by 1000, in order, and nothing else changes", async () => {
    const wallets = await db.prepare("SELECT workspace_id, balance_milli FROM credit_wallets ORDER BY workspace_id").all();
    expect(wallets.results).toEqual([
      { workspace_id: A, balance_milli: 75_000 },
      { workspace_id: B, balance_milli: 25_000 },
    ]);
    const ledger = await db
      .prepare(
        "SELECT id, workspace_id, type, amount_milli, balance_after_milli, reason, metadata, idempotency_key, transfer_code FROM credit_ledger ORDER BY rowid",
      )
      .all();
    expect(ledger.results).toEqual([
      {
        id: "l1",
        workspace_id: A,
        type: "deduction",
        amount_milli: -30_000,
        balance_after_milli: 70_000,
        reason: "usage",
        metadata: JSON.stringify({ n: 1 }),
        idempotency_key: "old-a",
        transfer_code: null,
      },
      {
        id: "l2",
        workspace_id: A,
        type: "topup",
        amount_milli: 5_000,
        balance_after_milli: 75_000,
        reason: "refund",
        metadata: "{}",
        idempotency_key: null,
        transfer_code: null,
      },
      {
        id: "l3",
        workspace_id: B,
        type: "deduction",
        amount_milli: -15_000,
        balance_after_milli: 25_000,
        reason: "usage",
        metadata: "{}",
        idempotency_key: "old-b",
        transfer_code: null,
      },
    ]);
    // Order amounts are money, not credits: unchanged.
    expect(await db.prepare("SELECT amount FROM credit_orders WHERE order_id = 'order_keep'").first()).toEqual({ amount: 9 });
    // The old whole-credit columns are gone, so a reader still written for them fails loudly.
    await expect(db.prepare("SELECT balance FROM credit_wallets").all()).rejects.toThrow(/no such column/);
    await expect(db.prepare("SELECT amount, balance_after FROM credit_ledger").all()).rejects.toThrow(/no such column/);
    // The rebuild left its indexes and no temporary table, and created the action cost table.
    const indexes = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'credit_ledger'").all<{ name: string }>();
    expect(indexes.results.map((r) => r.name)).toEqual(expect.arrayContaining(["credit_ledger_workspace_idx", "credit_ledger_transfer_idx"]));
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE name = 'credit_ledger_v3'").first()).toBeNull();
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE name = 'credit_action_costs'").first()).toEqual({ name: "credit_action_costs" });
  });

  test("the CHECKs still refuse an overdraw, a negative balance_after, an unknown type and a transfer row without a code", async () => {
    const wallet = createWallet(db, undefined);
    const count = async () => (await db.prepare("SELECT COUNT(*) AS n FROM credit_ledger").first<{ n: number }>())!.n;
    const rows = await count();
    expect(await wallet.deduct({ workspaceId: A, userId: "user-a", amountMilli: 75_001, reason: "too much" })).toEqual({
      ok: false,
      reason: "insufficient_balance",
      balanceMilli: 75_000,
    });
    expect(await count()).toBe(rows);
    await expect(db.prepare("UPDATE credit_wallets SET balance_milli = balance_milli - 75001 WHERE workspace_id = ?").bind(A).run()).rejects.toThrow(
      /CHECK constraint failed: balance_milli >= 0/,
    );
    const insert = (id: string, type: string, balanceAfter: number, code: string | null) =>
      db
        .prepare(
          "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount_milli, balance_after_milli, reason, transfer_code) VALUES (?, ?, 'u', ?, -1, ?, 'x', ?)",
        )
        .bind(id, A, type, balanceAfter, code)
        .run();
    await expect(insert("neg", "deduction", -1, null)).rejects.toThrow(/CHECK constraint failed: balance_after_milli >= 0/);
    await expect(insert("bad", "gift", 1, null)).rejects.toThrow(/CHECK constraint failed/);
    await expect(insert("nocode", "transfer_out", 1, null)).rejects.toThrow(/CHECK constraint failed/);
    await expect(insert("stray", "deduction", 1, "tr_x")).rejects.toThrow(/CHECK constraint failed/);
    await insert("ok", "transfer_out", 1, "tr_x");
  });

  test("keys written before the migration are refused as reused (their rows carry no operation tag), and are free in the other workspace", async () => {
    const wallet = createWallet(db, undefined);
    // Story 2.5: an untagged row matches nothing new, so it is never honoured as somebody else's duplicate.
    expect(await wallet.deduct({ workspaceId: A, userId: "user-a", amountMilli: 30_000, reason: "usage", idempotencyKey: "old-a" })).toEqual({
      ok: false,
      reason: "idempotency_key_reused",
      balanceMilli: null,
    });
    expect(await wallet.deduct({ workspaceId: B, userId: "user-b", amountMilli: 5_000, reason: "usage", idempotencyKey: "old-a" })).toEqual({
      ok: true,
      balanceAfterMilli: 20_000,
      duplicate: false,
    });
    expect(await wallet.getBalanceMilli(A)).toBe(75_000);
    // A fractional spend lands exactly on the converted balance.
    expect(await wallet.deduct({ workspaceId: A, userId: "user-a", amountMilli: 200, reason: "email" })).toMatchObject({ ok: true, balanceAfterMilli: 74_800 });
  });

  test("the action cost table refuses a malformed action name and a negative cost", async () => {
    const put = (action: string, cost: number) =>
      db.prepare("INSERT INTO credit_action_costs (workspace_id, action, cost_milli) VALUES (?, ?, ?)").bind(A, action, cost).run();
    await put("email.send", 200);
    await put("message:whatsapp-out_2", 500);
    await expect(put("Email", 1)).rejects.toThrow(/CHECK constraint failed/);
    await expect(put("1email", 1)).rejects.toThrow(/CHECK constraint failed/);
    await expect(put("email send", 1)).rejects.toThrow(/CHECK constraint failed/);
    await expect(put("x".repeat(65), 1)).rejects.toThrow(/CHECK constraint failed/);
    await expect(put("refund", -1)).rejects.toThrow(/CHECK constraint failed/);
    await expect(put("email.send", 300)).rejects.toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
  });
});
