// Story 1.13: walletCharger, the billing surface the assembler hands to other bricks (llm-gateway) through a
// `$capability` route option. It is the wallet's own atomic deduction: idempotent per workspace and key, refused
// with nothing changed when the balance cannot cover the amount, and scoped to the one workspace it is given.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { applyMigration, createWallet, walletCharger } from "../src/index.ts";
import type { D1Like } from "../src/index.ts";
import migration from "../migrations/0001_credit_wallet.sql?raw";
import migration0002 from "../migrations/0002_workspace_scoped_idempotency.sql?raw";
import migration0003 from "../migrations/0003_order_currency.sql?raw";
import migration0004 from "../migrations/0004_milli_credits.sql?raw";

const db = env.DB as D1Like;
const WS_A = "ws-charger-a";
const WS_B = "ws-charger-b";

async function ledgerRows(workspaceId: string) {
  return (
    await db
      .prepare("SELECT amount_milli AS amount, reason, user_id, idempotency_key FROM credit_ledger WHERE workspace_id = ? ORDER BY rowid")
      .bind(workspaceId)
      .all<{ amount: number; reason: string; user_id: string; idempotency_key: string }>()
  ).results;
}

beforeEach(async () => {
  expect.hasAssertions();
  for (const table of ["credit_ledger", "credit_orders", "credit_wallets", "credit_action_costs"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await applyMigration(db, migration);
  await applyMigration(db, migration0002);
  await applyMigration(db, migration0003);
  await applyMigration(db, migration0004);
  const wallet = createWallet(db, undefined);
  await wallet.openWallet(WS_A, 10);
  await wallet.openWallet(WS_B, 10);
});

describe("walletCharger (story 1.13)", () => {
  test("balance reads the workspace's own wallet, and 0 for a workspace with none", async () => {
    expect(await walletCharger.balanceMilli(db, WS_A)).toBe(10);
    expect(await walletCharger.balanceMilli(db, "ws-without-wallet")).toBe(0);
  });

  test("debit takes the amount once per idempotency key, from that workspace only", async () => {
    expect(await walletCharger.debit(db, WS_A, 3, "ai:log1", "AI generation", "usr_alice")).toEqual({ ok: true, balanceAfterMilli: 7, duplicate: false });
    expect(await walletCharger.debit(db, WS_A, 3, "ai:log1", "AI generation", "usr_alice")).toEqual({ ok: true, balanceAfterMilli: 7, duplicate: true });
    expect(await walletCharger.balanceMilli(db, WS_A)).toBe(7);
    expect(await walletCharger.balanceMilli(db, WS_B)).toBe(10);
    expect(await ledgerRows(WS_A)).toEqual([{ amount: -3, reason: "AI generation", user_id: "usr_alice", idempotency_key: "ai:log1" }]);
    expect(await ledgerRows(WS_B)).toEqual([]);
    // The same key in another workspace is another operation.
    expect((await walletCharger.debit(db, WS_B, 2, "ai:log1", "AI generation")).ok).toBe(true);
    expect(await walletCharger.balanceMilli(db, WS_B)).toBe(8);
  });

  test("a debit the balance cannot cover is refused with nothing changed", async () => {
    expect(await walletCharger.debit(db, WS_A, 11, "ai:big", "AI generation")).toEqual({ ok: false, code: "INSUFFICIENT_CREDITS", balanceMilli: 10 });
    expect(await walletCharger.balanceMilli(db, WS_A)).toBe(10);
    expect(await ledgerRows(WS_A)).toEqual([]);
    expect(await walletCharger.debit(db, "ws-without-wallet", 1, "ai:x", "AI generation")).toEqual({ ok: false, code: "WALLET_NOT_FOUND", balanceMilli: 0 });
  });

  test("refund gives back at most what the debit under againstKey took, once per key, to that workspace only", async () => {
    expect((await walletCharger.debit(db, WS_A, 5, "ai:log2", "AI generation (reserved)", "usr_alice")).ok).toBe(true);
    const reason = "AI generation (unused reservation)";
    expect(await walletCharger.refund(db, WS_A, 2, "ai:log2:refund", "ai:log2", reason, "usr_alice")).toEqual({ ok: true, balanceAfterMilli: 7, duplicate: false, milli: 2 });
    expect(await walletCharger.refund(db, WS_A, 2, "ai:log2:refund", "ai:log2", reason, "usr_alice")).toEqual({ ok: true, balanceAfterMilli: 7, duplicate: true, milli: 2 });
    expect(await walletCharger.balanceMilli(db, WS_A)).toBe(7);
    expect(await walletCharger.balanceMilli(db, WS_B)).toBe(10);
    expect(await ledgerRows(WS_A)).toEqual([
      { amount: -5, reason: "AI generation (reserved)", user_id: "usr_alice", idempotency_key: "ai:log2" },
      { amount: 2, reason, user_id: "usr_alice", idempotency_key: "ai:log2:refund" },
    ]);
    // Capped at the debit's amount.
    expect((await walletCharger.debit(db, WS_A, 3, "ai:log3", "AI generation (reserved)")).ok).toBe(true);
    expect(await walletCharger.refund(db, WS_A, 50, "ai:log3:refund", "ai:log3", reason)).toMatchObject({ ok: true, milli: 3, balanceAfterMilli: 7 });
    // No debit under that key (it never committed, or it is another workspace's): nothing is refunded.
    expect(await walletCharger.refund(db, WS_A, 5, "ai:none:refund", "ai:none", reason)).toEqual({ ok: false, code: "NOTHING_TO_REFUND", balanceMilli: 0 });
    expect(await walletCharger.refund(db, WS_B, 5, "ai:log2:refund", "ai:log2", reason)).toEqual({ ok: false, code: "NOTHING_TO_REFUND", balanceMilli: 0 });
    // A top-up key is not a debit.
    expect(await walletCharger.refund(db, WS_A, 1, "ai:x:refund", "ai:log2:refund", reason)).toEqual({ ok: false, code: "NOTHING_TO_REFUND", balanceMilli: 0 });
    expect(await walletCharger.balanceMilli(db, WS_A)).toBe(7);
    expect(await walletCharger.balanceMilli(db, WS_B)).toBe(10);
    await expect(walletCharger.refund(db, WS_A, 0.5, "ai:half", "ai:log2", reason)).rejects.toThrow(RangeError);
    await expect(walletCharger.refund(db, WS_A, 1, "", "ai:log2", reason)).rejects.toThrow(RangeError);
  });

  test("settled reports the ledger entry under a key in that workspace only", async () => {
    expect(await walletCharger.settled(db, WS_A, "ai:s")).toBeNull();
    await walletCharger.debit(db, WS_A, 4, "ai:s", "AI generation (reserved)");
    await walletCharger.refund(db, WS_A, 1, "ai:s:refund", "ai:s", "r");
    expect(await walletCharger.settled(db, WS_A, "ai:s")).toEqual({ milli: 4, type: "deduction" });
    expect(await walletCharger.settled(db, WS_A, "ai:s:refund")).toEqual({ milli: 1, type: "topup" });
    expect(await walletCharger.settled(db, WS_B, "ai:s")).toBeNull();
  });

  test("a retried debit whose first attempt committed answers duplicate even when the balance left cannot cover it again", async () => {
    // The wallet checks the balance before the key: 10 - 8 leaves 2, so the retry alone would be refused for the balance.
    expect(await walletCharger.debit(db, WS_A, 8, "ai:retry", "AI generation (reserved)")).toEqual({ ok: true, balanceAfterMilli: 2, duplicate: false });
    expect(await walletCharger.debit(db, WS_A, 8, "ai:retry", "AI generation (reserved)")).toEqual({ ok: true, balanceAfterMilli: 2, duplicate: true });
    expect(await walletCharger.balanceMilli(db, WS_A)).toBe(2);
    expect(await ledgerRows(WS_A)).toHaveLength(1);
    // A different key is still refused.
    expect(await walletCharger.debit(db, WS_A, 8, "ai:other", "AI generation (reserved)")).toEqual({ ok: false, code: "INSUFFICIENT_CREDITS", balanceMilli: 2 });
  });

  test("parallel debits never take more than the balance: only the ones it covers succeed", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => walletCharger.debit(db, WS_A, 3, `ai:par${i}`, "AI generation (reserved)")));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === "INSUFFICIENT_CREDITS")).toBe(true);
    expect(await walletCharger.balanceMilli(db, WS_A)).toBe(1);
  });

  test("amounts stay whole thousandths and a key is required", async () => {
    await expect(walletCharger.debit(db, WS_A, 1.5, "ai:frac", "AI generation")).rejects.toThrow(RangeError);
    await expect(walletCharger.debit(db, WS_A, 0, "ai:zero", "AI generation")).rejects.toThrow(RangeError);
    await expect(walletCharger.debit(db, WS_A, 1, "", "AI generation")).rejects.toThrow(RangeError);
    expect(await walletCharger.balanceMilli(db, WS_A)).toBe(10);
  });
});

describe("walletCharger.chargeAction (story 2.5)", () => {
  const setCost = (workspaceId: string, action: string, costMilli: number) =>
    db.prepare("INSERT INTO credit_action_costs (workspace_id, action, cost_milli) VALUES (?, ?, ?)").bind(workspaceId, action, costMilli).run();

  test("takes cost x quantity once per key, from that workspace, at that workspace's own price", async () => {
    await setCost(WS_A, "email.send", 2); // 0.002 credits; the wallet holds 10 thousandths
    await setCost(WS_B, "email.send", 5);
    expect(await walletCharger.chargeAction(db, WS_A, "email.send", 3, "job-1", "emails")).toEqual({
      ok: true,
      action: "email.send",
      quantity: 3,
      costMilli: 2,
      chargedMilli: 6,
      balanceAfterMilli: 4,
      duplicate: false,
    });
    expect(await walletCharger.chargeAction(db, WS_A, "email.send", 3, "job-1", "emails")).toMatchObject({ ok: true, chargedMilli: 6, duplicate: true });
    expect(await walletCharger.balanceMilli(db, WS_A)).toBe(4);
    expect(await walletCharger.chargeAction(db, WS_B, "email.send", 1, "job-1", "emails")).toMatchObject({ ok: true, chargedMilli: 5, balanceAfterMilli: 5 });
    expect(await ledgerRows(WS_A)).toEqual([{ amount: -6, reason: "emails", user_id: "system", idempotency_key: "job-1" }]);
  });

  test("an action priced by neither the workspace nor the defaults is UNKNOWN_ACTION, and nothing moves", async () => {
    expect(await walletCharger.chargeAction(db, WS_A, "sms.send", 1, "job-2", "sms")).toEqual({ ok: false, code: "UNKNOWN_ACTION" });
    expect(await walletCharger.balanceMilli(db, WS_A)).toBe(10);
    expect(await ledgerRows(WS_A)).toEqual([]);
  });

  test("defaults apply only to actions the workspace has not priced itself", async () => {
    await setCost(WS_A, "email.send", 1);
    const defaultCosts = "email.send:0.005,message.send:0.003";
    expect(await walletCharger.chargeAction(db, WS_A, "email.send", 1, "d-1", "x", { defaultCosts })).toMatchObject({ ok: true, costMilli: 1 });
    expect(await walletCharger.chargeAction(db, WS_A, "message.send", 2, "d-2", "x", { defaultCosts, userId: "usr_bob" })).toMatchObject({ ok: true, costMilli: 3, chargedMilli: 6, balanceAfterMilli: 3 });
    expect((await ledgerRows(WS_A))[1]).toMatchObject({ user_id: "usr_bob" });
    await expect(walletCharger.chargeAction(db, WS_A, "x", 1, "d-3", "x", { defaultCosts: "Bad Entry" })).rejects.toThrow(RangeError);
  });

  test("a charge the balance cannot cover is refused; a quantity out of range or a missing key throws", async () => {
    await setCost(WS_A, "email.send", 4);
    expect(await walletCharger.chargeAction(db, WS_A, "email.send", 3, "big", "x")).toEqual({ ok: false, code: "INSUFFICIENT_CREDITS", balanceMilli: 10 });
    expect(await walletCharger.balanceMilli(db, WS_A)).toBe(10);
    await expect(walletCharger.chargeAction(db, WS_A, "email.send", 0, "q0", "x")).rejects.toThrow(RangeError);
    await expect(walletCharger.chargeAction(db, WS_A, "email.send", 10_001, "q1", "x")).rejects.toThrow(RangeError);
    await expect(walletCharger.chargeAction(db, WS_A, "email.send", 1.5, "q2", "x")).rejects.toThrow(RangeError);
    await expect(walletCharger.chargeAction(db, WS_A, "email.send", 1, "", "x")).rejects.toThrow(RangeError);
  });

  test("a free action takes nothing but records a zero row under its key, so a retry after a price change is a duplicate; it still needs a wallet", async () => {
    await setCost(WS_A, "ping", 0);
    await setCost("ws-without-wallet", "ping", 0);
    expect(await walletCharger.chargeAction(db, WS_A, "ping", 5, "free", "x")).toMatchObject({ ok: true, chargedMilli: 0, balanceAfterMilli: 10, duplicate: false });
    expect(await ledgerRows(WS_A)).toEqual([{ amount: 0, reason: "x", user_id: "system", idempotency_key: "free" }]);
    await db.prepare("UPDATE credit_action_costs SET cost_milli = 2 WHERE workspace_id = ? AND action = 'ping'").bind(WS_A).run();
    expect(await walletCharger.chargeAction(db, WS_A, "ping", 5, "free", "x")).toMatchObject({ ok: true, chargedMilli: 0, duplicate: true });
    expect(await walletCharger.balanceMilli(db, WS_A)).toBe(10);
    expect(await walletCharger.chargeAction(db, "ws-without-wallet", "ping", 1, "free", "x")).toEqual({ ok: false, code: "WALLET_NOT_FOUND" });
  });
});
