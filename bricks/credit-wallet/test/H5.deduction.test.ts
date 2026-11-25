import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { GraphInvalidError, runGraph, toyExecutors } from "@poc/runtime";
import { applyMigration, createRegistry, toyRegistry } from "@poc/sdk";
import type { D1Like, Executor, GraphEdge, GraphNode } from "@poc/sdk";
import walletMigration from "../migrations/0001_credit_wallet.sql?raw";
import walletMigration0002 from "../migrations/0002_workspace_scoped_idempotency.sql?raw";
import walletMigration0003 from "../migrations/0003_order_currency.sql?raw";
import { createWallet, creditWalletBricks, creditWalletExecutors } from "../src/index.ts";

// Rewritten from cephlow apps/api-worker/src/routes/clientGenerate.test.ts (see ported-tests.json). The originals drive
// POST /batches/:id/client-generate, which also needs a KV approvals cache, certificates and batches; those are out of
// scope. These carry the same three behaviours through the brick's own deduction, and, unlike the originals (which
// check only a status code, or that one SQL string was not prepared), they check the real balance and ledger.

const db = env.DB as D1Like;
const WS = "ws-abc";

const node = (id: string, type: string, data: Record<string, unknown> = {}): GraphNode => ({ id, type, data });
const edge = (source: string, target: string): GraphEdge => ({ id: `${source}-${target}`, source, target, sourceHandle: "out", targetHandle: "in" });
const registry = createRegistry([...toyRegistry.values(), ...creditWalletBricks]);
const executors = new Map<string, Executor>([...toyExecutors, ...creditWalletExecutors]);
const charge = (amount: number) =>
  runGraph(
    { nodes: [node("t", "trigger.manual"), node("pay", "credit-wallet.deduct", { amount })], edges: [edge("t", "pay")] },
    registry,
    executors,
    { payload: { workspaceId: WS, userId: "user-123" }, env: { DB: db }, workspaceId: WS },
  );
const ledger = async () =>
  (await db.prepare("SELECT type, amount, balance_after FROM credit_ledger WHERE workspace_id = ? ORDER BY rowid").bind(WS).all<{ type: string; amount: number; balance_after: number }>()).results;

beforeEach(async () => {
  expect.hasAssertions(); // a ported test that asserts nothing would pass whatever the code does; this makes it fail instead
  for (const table of ["credit_ledger", "credit_orders", "credit_wallets"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await applyMigration(db, walletMigration);
  await applyMigration(db, walletMigration0002);
  await applyMigration(db, walletMigration0003);
});

describe("POST /batches/:batchId/client-generate - Credit Security & Regeneration Rates", () => {
  it("should successfully charge standard rate for unpaid certificates", async () => {
    await createWallet(db, undefined).openWallet(WS, 100); // 100 credits available
    const RATE = 1;
    const unpaid = 2; // two unpaid certificates
    const result = await charge(unpaid * RATE);
    expect(result.ok).toBe(true);
    expect(await createWallet(db, undefined).getBalance(WS)).toBe(98);
    expect(await ledger()).toEqual([{ type: "deduction", amount: -2, balance_after: 98 }]);
  });

  it("should reject generation if workspace balance is insufficient (C-2)", async () => {
    await createWallet(db, undefined).openWallet(WS, 0); // nothing available; one unpaid certificate needs 1 credit
    const result = await charge(1);
    expect(result.ok).toBe(false);
    expect(result.failed.pay).toBe("insufficient balance: need 1, have 0");
    expect(await createWallet(db, undefined).getBalance(WS)).toBe(0);
    expect(await ledger()).toEqual([]);
  });

  it("regeneration is free: no balance change and no ledger row for a zero cost", async () => {
    const wallet = createWallet(db, undefined);
    await wallet.openWallet(WS, 100);
    // A free action has a cost of zero. The brick cannot be told to charge zero: the graph is refused before it runs,
    // and the wallet itself refuses before touching the database, so no zero-amount ledger row can exist.
    await expect(charge(0)).rejects.toThrow(GraphInvalidError);
    await expect(wallet.deduct({ workspaceId: WS, userId: "user-123", amount: 0, reason: "regeneration" })).rejects.toThrow(RangeError);
    expect(await wallet.getBalance(WS)).toBe(100);
    expect(await ledger()).toEqual([]);
  });

  it("the standard-rate charge uses whole credits only: a fractional cost is refused, not rounded", async () => {
    await createWallet(db, undefined).openWallet(WS, 100);
    await expect(charge(0.2)).rejects.toThrow(GraphInvalidError);
    expect(await createWallet(db, undefined).getBalance(WS)).toBe(100);
  });

  it("an insufficient balance is refused even when the balance is only one credit short", async () => {
    await createWallet(db, undefined).openWallet(WS, 4);
    expect((await charge(5)).failed.pay).toBe("insufficient balance: need 5, have 4");
    expect(await createWallet(db, undefined).getBalance(WS)).toBe(4);
    expect((await charge(4)).ok).toBe(true);
    expect(await createWallet(db, undefined).getBalance(WS)).toBe(0);
  });
});
