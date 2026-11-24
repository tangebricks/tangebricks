import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { applyMigration, createWallet } from "../src/index.ts";
import type { D1Like } from "../src/index.ts";
import migration0001 from "../migrations/0001_credit_wallet.sql?raw";
import migration0002 from "../migrations/0002_workspace_scoped_idempotency.sql?raw";

// Story 0.7 (AD-V2): idempotency keys belong to a workspace. Before migration 0002 the ledger's key was unique across
// the platform and looked up without a workspace, so a second workspace that reused a key got the first workspace's
// "duplicate" answer (and its balance) without being charged.

const db = env.DB as D1Like;
const A = "ws-keys-a";
const B = "ws-keys-b";

async function drop(): Promise<void> {
  for (const table of ["credit_ledger", "credit_ledger_v2", "credit_orders", "credit_wallets"]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
}

async function ledgerRows(workspaceId: string) {
  const { results } = await db
    .prepare("SELECT id, workspace_id, amount, balance_after, idempotency_key FROM credit_ledger WHERE workspace_id = ? ORDER BY rowid")
    .bind(workspaceId)
    .all<{ id: string; workspace_id: string; amount: number; balance_after: number; idempotency_key: string | null }>();
  return results;
}

describe("idempotency keys are per workspace (wallet)", () => {
  beforeEach(async () => {
    await drop();
    await applyMigration(db, migration0001);
    await applyMigration(db, migration0002);
  });

  test("KEY_REUSE_OTHER_TENANT: A is charged normally after B used the same key, and never sees B's balance", async () => {
    const wallet = createWallet(db, undefined);
    await wallet.openWallet(A, 1000);
    await wallet.openWallet(B, 50);

    const b = await wallet.deduct({ workspaceId: B, userId: "user-b", amount: 20, reason: "usage", idempotencyKey: "k1" });
    expect(b).toEqual({ ok: true, balanceAfter: 30, duplicate: false });

    const a = await wallet.deduct({ workspaceId: A, userId: "user-a", amount: 100, reason: "usage", idempotencyKey: "k1" });
    expect(a).toEqual({ ok: true, balanceAfter: 900, duplicate: false });
    expect(await wallet.getBalance(A)).toBe(900);
    expect(await wallet.getBalance(B)).toBe(30);
    expect(await ledgerRows(A)).toHaveLength(1);
    expect(await ledgerRows(B)).toHaveLength(1);
  });

  test("KEY_REUSE_OTHER_TENANT on refunds: A is credited normally after B used the same key", async () => {
    const wallet = createWallet(db, undefined);
    await wallet.openWallet(A, 10);
    await wallet.openWallet(B, 500);

    expect(await wallet.refund({ workspaceId: B, userId: "user-b", amount: 5, reason: "refund", idempotencyKey: "r1" })).toEqual({
      ok: true,
      balanceAfter: 505,
      duplicate: false,
    });
    expect(await wallet.refund({ workspaceId: A, userId: "user-a", amount: 7, reason: "refund", idempotencyKey: "r1" })).toEqual({
      ok: true,
      balanceAfter: 17,
      duplicate: false,
    });
  });

  test("KEY_REUSE_SAME_TENANT: a second call with A's key is a duplicate with A's earlier balance_after, and no second charge", async () => {
    const wallet = createWallet(db, undefined);
    await wallet.openWallet(A, 1000);
    await wallet.openWallet(B, 50);
    await wallet.deduct({ workspaceId: B, userId: "user-b", amount: 20, reason: "usage", idempotencyKey: "k1" });

    const first = await wallet.deduct({ workspaceId: A, userId: "user-a", amount: 100, reason: "usage", idempotencyKey: "k1" });
    // B spends again so that B's balance differs from anything A could be answered with.
    await wallet.deduct({ workspaceId: B, userId: "user-b", amount: 5, reason: "usage", idempotencyKey: "k2" });
    const second = await wallet.deduct({ workspaceId: A, userId: "user-a", amount: 100, reason: "usage", idempotencyKey: "k1" });

    expect(first).toEqual({ ok: true, balanceAfter: 900, duplicate: false });
    expect(second).toEqual({ ok: true, balanceAfter: 900, duplicate: true });
    expect(await wallet.getBalance(A)).toBe(900);
    expect(await ledgerRows(A)).toHaveLength(1);
  });

  test("KEY_REUSE_SAME_TENANT under concurrency: one charge, every answer is A's own balance", async () => {
    const wallet = createWallet(db, undefined);
    await wallet.openWallet(A, 1000);
    await wallet.openWallet(B, 7);
    await wallet.deduct({ workspaceId: B, userId: "user-b", amount: 1, reason: "usage", idempotencyKey: "same" });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => wallet.deduct({ workspaceId: A, userId: "user-a", amount: 10, reason: "usage", idempotencyKey: "same" })),
    );
    expect(results.filter((r) => r.ok && !r.duplicate)).toHaveLength(1);
    for (const r of results) expect(r).toMatchObject({ ok: true, balanceAfter: 990 });
    expect(await wallet.getBalance(A)).toBe(990);
    expect(await wallet.getBalance(B)).toBe(6);
  });
});

describe("MIGRATION_PRESERVES: 0002 keeps every ledger row and the overdraw refusal", () => {
  beforeEach(async () => {
    await drop();
  });

  test("rows written under 0001 survive 0002 unchanged, and the CHECKs still refuse an overdraw", async () => {
    await applyMigration(db, migration0001);
    const wallet = createWallet(db, undefined);
    await wallet.openWallet(A, 100);
    await wallet.openWallet(B, 40);
    // Under 0001, keys are written the way the old code wrote them: one row per key, platform-wide.
    await wallet.deduct({ workspaceId: A, userId: "user-a", amount: 30, reason: "usage", metadata: { n: 1 }, idempotencyKey: "old-a" });
    await wallet.refund({ workspaceId: A, userId: "user-a", amount: 5, reason: "refund" });
    await wallet.deduct({ workspaceId: B, userId: "user-b", amount: 15, reason: "usage", idempotencyKey: "old-b" });
    await db
      .prepare("INSERT INTO credit_orders (order_id, workspace_id, user_id, amount, processed) VALUES ('order_keep', ?, 'user-a', 9, 1)")
      .bind(A)
      .run();

    const before = await db.prepare("SELECT * FROM credit_ledger ORDER BY rowid").all();
    const walletsBefore = await db.prepare("SELECT * FROM credit_wallets ORDER BY workspace_id").all();
    const ordersBefore = await db.prepare("SELECT * FROM credit_orders ORDER BY order_id").all();
    expect(before.results).toHaveLength(3);

    await applyMigration(db, migration0002);

    expect((await db.prepare("SELECT * FROM credit_ledger ORDER BY rowid").all()).results).toEqual(before.results);
    expect((await db.prepare("SELECT * FROM credit_wallets ORDER BY workspace_id").all()).results).toEqual(walletsBefore.results);
    expect((await db.prepare("SELECT * FROM credit_orders ORDER BY order_id").all()).results).toEqual(ordersBefore.results);
    expect(await wallet.getBalance(A)).toBe(75);
    expect(await wallet.getBalance(B)).toBe(25);

    // The index is back, the temporary table is gone, and the key is now unique per (workspace_id, idempotency_key).
    const indexes = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'credit_ledger'").all<{ name: string }>();
    expect(indexes.results.map((r) => r.name)).toContain("credit_ledger_workspace_idx");
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE name = 'credit_ledger_v2'").first()).toBeNull();

    // An overdraw is still refused with nothing written: CHECK (balance >= 0) on the wallet...
    const ledgerCount = async () => (await db.prepare("SELECT COUNT(*) AS n FROM credit_ledger").first<{ n: number }>())!.n;
    const rowsBefore = await ledgerCount();
    expect(await wallet.deduct({ workspaceId: A, userId: "user-a", amount: 76, reason: "too much" })).toEqual({
      ok: false,
      reason: "insufficient_balance",
      balance: 75,
    });
    expect(await ledgerCount()).toBe(rowsBefore);
    // ...and CHECK (balance_after >= 0) on the rebuilt ledger.
    await expect(
      db
        .prepare("INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason) VALUES ('neg', ?, 'u', 'deduction', -1, -1, 'x')")
        .bind(A)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: balance_after >= 0/);
    // ...and the type CHECK survived too.
    await expect(
      db
        .prepare("INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason) VALUES ('bad', ?, 'u', 'gift', 1, 1, 'x')")
        .bind(A)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);

    // The old keys still deduplicate within their own workspace, and are free in the other one.
    expect(await wallet.deduct({ workspaceId: A, userId: "user-a", amount: 30, reason: "usage", idempotencyKey: "old-a" })).toEqual({
      ok: true,
      balanceAfter: 70,
      duplicate: true,
    });
    expect(await wallet.deduct({ workspaceId: B, userId: "user-b", amount: 5, reason: "usage", idempotencyKey: "old-a" })).toEqual({
      ok: true,
      balanceAfter: 20,
      duplicate: false,
    });
  });
});
