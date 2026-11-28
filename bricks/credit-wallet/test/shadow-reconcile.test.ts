// Story 2.9: what a host needs to run credit-wallet as a shadow of its own wallet. The charger carries the host's own
// reference in the ledger metadata, and `reconcileWallets` compares the host's balances with the brick's, read-only.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { applyMigration } from "@poc/sdk";
import mwMigration from "../../multi-workspace/migrations/0001_multi_workspace.sql?raw";
import migration0001 from "../migrations/0001_credit_wallet.sql?raw";
import migration0002 from "../migrations/0002_workspace_scoped_idempotency.sql?raw";
import migration0003 from "../migrations/0003_order_currency.sql?raw";
import migration0004 from "../migrations/0004_milli_credits.sql?raw";
import { createWallet, reconcileWallets, walletCharger } from "../src/index.ts";
import type { D1Like } from "../src/index.ts";

const db = env.DB as D1Like;

const metadataOf = async (workspaceId: string, key: string) => {
  const row = await db
    .prepare("SELECT metadata FROM credit_ledger WHERE workspace_id = ? AND idempotency_key = ?")
    .bind(workspaceId, key)
    .first<{ metadata: string }>();
  return JSON.parse(row!.metadata) as Record<string, unknown>;
};

const ledgerCount = async () => (await db.prepare("SELECT COUNT(*) AS n FROM credit_ledger").first<{ n: number }>())!.n;

beforeEach(async () => {
  expect.hasAssertions();
  for (const table of ["credit_ledger", "credit_orders", "credit_wallets", "credit_action_costs", "mw_members", "mw_workspaces"]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await applyMigration(db, mwMigration);
  for (const sql of [migration0001, migration0002, migration0003, migration0004]) await applyMigration(db, sql);
  for (const id of ["ws-a", "ws-b"]) {
    await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES (?, ?, 'o')").bind(id, id).run();
  }
  await createWallet(db, undefined).openWallet("ws-a", 10_000);
});

describe("walletCharger metadata passthrough", () => {
  test("debit records the caller's metadata, and the op tag wins over a key of the same name", async () => {
    const result = await walletCharger.debit(db, "ws-a", 3000, "host-ledger:L1", "Generation", "u1", { host_ledger_id: "L1", op: "spoofed" });
    expect(result).toEqual({ ok: true, balanceAfterMilli: 7000, duplicate: false });
    expect(await metadataOf("ws-a", "host-ledger:L1")).toEqual({ host_ledger_id: "L1", op: "charger" });
  });

  test("metadata plays no part in the idempotency match: a retry with other metadata is the same debit, taken once", async () => {
    await walletCharger.debit(db, "ws-a", 3000, "host-ledger:L1", "Generation", "u1", { host_ledger_id: "L1" });
    expect(await walletCharger.debit(db, "ws-a", 3000, "host-ledger:L1", "Generation", "u1", { other: true })).toEqual({
      ok: true,
      balanceAfterMilli: 7000,
      duplicate: true,
    });
    expect(await walletCharger.debit(db, "ws-a", 3000, "host-ledger:L1", "Generation", "u1")).toMatchObject({ ok: true, duplicate: true });
    // A different amount under the key is still refused.
    expect(await walletCharger.debit(db, "ws-a", 2000, "host-ledger:L1", "Generation", "u1", { host_ledger_id: "L1" })).toEqual({
      ok: false,
      code: "IDEMPOTENCY_KEY_REUSED",
      balanceMilli: 0,
    });
    expect(await walletCharger.balanceMilli(db, "ws-a")).toBe(7000);
  });

  test("grant records the caller's metadata (op stays grant), opens a live workspace's wallet, and replays once", async () => {
    const first = await walletCharger.grant(db, "ws-b", 5000, "host-ledger:L2", "Top-up", "u1", { host_ledger_id: "L2", op: "x" });
    expect(first).toEqual({ ok: true, balanceAfterMilli: 5000, duplicate: false, opened: true });
    expect(await metadataOf("ws-b", "host-ledger:L2")).toEqual({ host_ledger_id: "L2", op: "grant" });
    expect(await walletCharger.grant(db, "ws-b", 5000, "host-ledger:L2", "Top-up", "u1", { different: 1 })).toMatchObject({ ok: true, duplicate: true });
    expect(await walletCharger.grant(db, "ws-b", 4000, "host-ledger:L2", "Top-up")).toMatchObject({ ok: false, code: "IDEMPOTENCY_KEY_REUSED" });
    expect(await walletCharger.balanceMilli(db, "ws-b")).toBe(5000);
  });

  test("refund keeps `refunds` over the caller's key of the same name", async () => {
    await walletCharger.debit(db, "ws-a", 3000, "d1", "Generation");
    expect(await walletCharger.refund(db, "ws-a", 1000, "r1", "d1", "Refund", "u1", { host_ledger_id: "L3", refunds: "nope" })).toMatchObject({
      ok: true,
      milli: 1000,
    });
    expect(await metadataOf("ws-a", "r1")).toEqual({ host_ledger_id: "L3", refunds: "d1" });
  });

  test("metadata that is not a plain object is refused before anything is written", async () => {
    const before = await ledgerCount();
    await expect(walletCharger.debit(db, "ws-a", 1000, "k1", "x", "u", [] as unknown as Record<string, unknown>)).rejects.toThrow(RangeError);
    await expect(walletCharger.grant(db, "ws-a", 1000, "k2", "x", "u", null as unknown as Record<string, unknown>)).rejects.toThrow(RangeError);
    await expect(walletCharger.debit(db, "ws-a", 1000, "k3", "x", "u", { big: "x".repeat(3000) })).rejects.toThrow(RangeError);
    expect(await ledgerCount()).toBe(before);
    expect(await walletCharger.balanceMilli(db, "ws-a")).toBe(10_000);
  });
});

describe("reconcileWallets", () => {
  test("equal balances are exact; a workspace with no wallet counts as 0", async () => {
    const report = await reconcileWallets(db, [
      { workspaceId: "ws-a", balanceMilli: 10_000 },
      { workspaceId: "ws-b", balanceMilli: 0 },
    ]);
    expect(report).toEqual({
      rows: [
        { workspaceId: "ws-a", hostMilli: 10_000, brickMilli: 10_000, diffMilli: 0, refused: false },
        { workspaceId: "ws-b", hostMilli: 0, brickMilli: null, diffMilli: 0, refused: false },
      ],
      hostTotalMilli: 10_000,
      brickTotalMilli: 10_000,
      diffTotalMilli: 0,
      mismatchedRows: 0,
      missingWallets: 1,
      refusedRows: 0,
      exact: true,
    });
  });

  test("a difference is reported per workspace and in total, and is not exact", async () => {
    await createWallet(db, undefined).openWallet("ws-b", 2500);
    const report = await reconcileWallets(db, [
      { workspaceId: "ws-a", balanceMilli: 9_800 },
      { workspaceId: "ws-b", balanceMilli: 2500 },
      { workspaceId: "ws-c", balanceMilli: 400 },
    ]);
    expect(report.rows.map((r) => [r.workspaceId, r.diffMilli])).toEqual([
      ["ws-a", 200],
      ["ws-b", 0],
      ["ws-c", -400],
    ]);
    expect(report).toMatchObject({ hostTotalMilli: 12_700, brickTotalMilli: 12_500, diffTotalMilli: -200, mismatchedRows: 2, missingWallets: 1, exact: false });
  });

  test("a negative host balance (a host with no overdraw check) is compared as given", async () => {
    const report = await reconcileWallets(db, [{ workspaceId: "ws-b", balanceMilli: -1500 }]);
    expect(report.rows[0]).toEqual({ workspaceId: "ws-b", hostMilli: -1500, brickMilli: null, diffMilli: 1500, refused: false });
    expect(report.exact).toBe(false);
  });

  test("bad rows are refused and make the report inexact; nothing is written", async () => {
    const before = await ledgerCount();
    const report = await reconcileWallets(db, [
      { workspaceId: "ws-a", balanceMilli: 10_000 },
      { workspaceId: "ws-a", balanceMilli: 10_000 },
      { workspaceId: "", balanceMilli: 1 },
      { workspaceId: "ws-b", balanceMilli: 0.5 },
    ]);
    expect(report.rows.map((r) => r.refused)).toEqual([false, true, true, true]);
    expect(report).toMatchObject({ refusedRows: 3, mismatchedRows: 0, hostTotalMilli: 10_000, exact: false });
    expect(await ledgerCount()).toBe(before);
    expect(await walletCharger.balanceMilli(db, "ws-a")).toBe(10_000);
  });

  test("more workspaces than one IN list holds are read in chunks, with the same answer", async () => {
    const ids = Array.from({ length: 205 }, (_, n) => `ws-many-${n}`);
    const wallet = createWallet(db, undefined);
    for (const [n, id] of ids.entries()) {
      await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES (?, ?, 'o')").bind(id, id).run();
      if (n % 2 === 0) await wallet.openWallet(id, n * 1000);
    }
    const queries: string[] = [];
    const counting: D1Like = {
      prepare: (sql: string) => {
        queries.push(sql);
        return db.prepare(sql);
      },
      batch: (s) => db.batch(s),
      exec: (sql) => db.exec(sql),
    };
    const report = await reconcileWallets(
      counting,
      ids.map((id, n) => ({ workspaceId: id, balanceMilli: n % 2 === 0 ? n * 1000 : 0 })),
    );
    expect(report.exact).toBe(true);
    expect(report.missingWallets).toBe(102);
    expect(report.rows.find((r) => r.workspaceId === "ws-many-204")).toMatchObject({ brickMilli: 204_000, diffMilli: 0 });
    expect(queries.length).toBe(3);
  });

  test("an empty list is exact", async () => {
    expect(await reconcileWallets(db, [])).toMatchObject({ rows: [], exact: true, hostTotalMilli: 0, brickTotalMilli: 0 });
  });
});
