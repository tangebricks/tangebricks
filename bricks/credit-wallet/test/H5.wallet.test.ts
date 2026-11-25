import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { attach, record } from "@poc/harness";
import { applyMigration, createFakeGateway, createWallet } from "../src/index.ts";
import type { D1Like } from "../src/index.ts";
import migration from "../migrations/0001_credit_wallet.sql?raw";
import migration0002 from "../migrations/0002_workspace_scoped_idempotency.sql?raw";
import migration0003 from "../migrations/0003_order_currency.sql?raw";
import { BRICK_TABLES, type Op, type Outcome, violations, workload } from "./support/workload.ts";

const db = env.DB as D1Like;
const WS = "ws-brick";
const RUNS = 20;

async function reset(): Promise<void> {
  for (const table of ["credit_ledger", "credit_orders", "credit_wallets"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await applyMigration(db, migration);
  await applyMigration(db, migration0002);
  await applyMigration(db, migration0003);
}

async function ledgerCount(workspaceId = WS): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE workspace_id = ?").bind(workspaceId).first<{ n: number }>();
  return row!.n;
}

/** Computes once and shares the answer between the tests and the report. */
const once = <T>(make: () => Promise<T>): (() => Promise<T>) => {
  let pending: Promise<T> | undefined;
  return () => (pending ??= make());
};

// ---------------------------------------------------------------------------------------------------------------
// The claim: fifty mixed operations at once, twenty times over. Each top-up is confirmed twice at the same moment,
// so the one-credit-per-order rule is under load inside the same runs.
// ---------------------------------------------------------------------------------------------------------------
interface RunReport {
  run: number;
  start: number;
  end: number | null;
  acceptedTopups: number;
  acceptedDeductions: number;
  refusedDeductions: number;
  reasons: string[];
}

async function brickRun(run: number): Promise<RunReport> {
  const w = workload(run);
  await reset();
  const gateway = createFakeGateway();
  const wallet = createWallet(db, gateway, { currency: "INR" });
  await wallet.openWallet(WS, w.start);

  const orderFor = new Map<Op, string>();
  for (const op of w.ops) {
    if (op.kind !== "topup") continue;
    const { orderId } = await wallet.createOrder({ workspaceId: WS, userId: "user-1", amount: op.amount });
    gateway.setOrder(orderId, { status: "PAID" });
    orderFor.set(op, orderId);
  }

  const extra: string[] = [];
  const outcomes: Outcome[] = await Promise.all(
    w.ops.map(async (op): Promise<Outcome> => {
      if (op.kind === "topup") {
        const id = orderFor.get(op)!;
        const [a, b] = await Promise.all([wallet.confirmOrder(id), wallet.confirmOrder(id)]);
        const credited = [a, b].filter((r) => r.credited).length;
        if (credited > 1) extra.push(`order ${id} reported credited ${credited} times`);
        if (credited === 0) extra.push(`order ${id} was credited zero times (${a.status}, ${b.status})`);
        return { op, accepted: credited >= 1 };
      }
      const result = await wallet.deduct({ workspaceId: WS, userId: "user-1", amount: op.amount, reason: "usage" });
      if (!result.ok && result.reason !== "insufficient_balance") extra.push(`deduction refused for ${result.reason}`);
      return { op, accepted: result.ok };
    }),
  );

  const reasons = [...(await violations(db, WS, w.start, outcomes, BRICK_TABLES)), ...extra];
  return {
    run,
    start: w.start,
    end: await wallet.getBalance(WS),
    acceptedTopups: outcomes.filter((o) => o.op.kind === "topup" && o.accepted).length,
    acceptedDeductions: outcomes.filter((o) => o.op.kind === "deduct" && o.accepted).length,
    refusedDeductions: outcomes.filter((o) => o.op.kind === "deduct" && !o.accepted).length,
    reasons,
  };
}

const sweep = once(async () => {
  const runs: RunReport[] = [];
  for (let run = 1; run <= RUNS; run += 1) runs.push(await brickRun(run));
  return { runs, violatingRuns: runs.filter((r) => r.reasons.length > 0).length };
});

// ---------------------------------------------------------------------------------------------------------------
// One payment order, many parallel confirmations.
// ---------------------------------------------------------------------------------------------------------------
const orderScenario = once(async () => {
  await reset();
  const gateway = createFakeGateway();
  const wallet = createWallet(db, gateway, { currency: "INR" });
  await wallet.openWallet(WS, 7);
  const { orderId } = await wallet.createOrder({ workspaceId: WS, userId: "user-1", amount: 100 });
  gateway.setOrder(orderId, { status: "PAID" });

  const results = await Promise.all(Array.from({ length: 30 }, () => wallet.confirmOrder(orderId)));
  const order = await db.prepare("SELECT processed FROM credit_orders WHERE order_id = ?").bind(orderId).first<{ processed: number }>();
  const creditedResults = results.filter((r) => r.credited).length;
  const balance = await wallet.getBalance(WS);
  const rows = await ledgerCount();
  return {
    creditedResults,
    balance,
    rows,
    processed: order?.processed,
    others: [...new Set(results.filter((r) => !r.credited).map((r) => r.status))],
    ok: creditedResults === 1 && balance === 107 && rows === 1 && order?.processed === 1,
  };
});

// ---------------------------------------------------------------------------------------------------------------
// A deduction the wallet cannot cover: refused, and nothing else changes.
// ---------------------------------------------------------------------------------------------------------------
const refusalScenario = once(async () => {
  await reset();
  const wallet = createWallet(db, createFakeGateway(), { currency: "INR" });

  await wallet.openWallet(WS, 5);
  const single = await wallet.deduct({ workspaceId: WS, userId: "user-1", amount: 10, reason: "usage" });
  const afterSingle = { balance: await wallet.getBalance(WS), rows: await ledgerCount() };

  await wallet.openWallet("ws-race", 10);
  const results = await Promise.all(Array.from({ length: 5 }, () => wallet.deduct({ workspaceId: "ws-race", userId: "user-1", amount: 4, reason: "usage" })));
  const accepted = results.filter((r) => r.ok).length;
  const afterRace = { balance: await wallet.getBalance("ws-race"), rows: await ledgerCount("ws-race") };

  return {
    single,
    afterSingle,
    accepted,
    afterRace,
    ok:
      !single.ok &&
      single.reason === "insufficient_balance" &&
      afterSingle.balance === 5 &&
      afterSingle.rows === 0 &&
      accepted === 2 &&
      afterRace.balance === 2 &&
      afterRace.rows === 2,
  };
});

describe("fifty mixed operations at once, twenty times over", () => {
  test("every run ends exactly at start plus top-ups minus deductions, with a matching ledger", async () => {
    const { runs, violatingRuns } = await sweep();
    expect(runs.filter((r) => r.reasons.length > 0).map((r) => `run ${r.run}: ${r.reasons.join("; ")}`)).toEqual([]);
    expect(violatingRuns).toBe(0);
  });

  test("the runs exercised both accepted and refused deductions and real top-ups", async () => {
    const { runs } = await sweep();
    expect(runs.reduce((n, r) => n + r.refusedDeductions, 0)).toBeGreaterThan(0);
    expect(runs.reduce((n, r) => n + r.acceptedDeductions, 0)).toBeGreaterThan(0);
    expect(runs.reduce((n, r) => n + r.acceptedTopups, 0)).toBeGreaterThan(0);
  });

  test("the runs differ from one another (the workloads are not one run repeated)", async () => {
    const { runs } = await sweep();
    expect(new Set(runs.map((r) => `${r.start}:${r.end}`)).size).toBeGreaterThan(10);
  });
});

describe("one payment order confirmed by thirty parallel calls", () => {
  test("is credited once: one success, balance up by the order, one ledger row, order closed", async () => {
    const s = await orderScenario();
    expect(s.creditedResults).toBe(1);
    expect(s.balance).toBe(107);
    expect(s.rows).toBe(1);
    expect(s.processed).toBe(1);
  });

  test("the other twenty-nine are told it was already processed", async () => {
    expect((await orderScenario()).others).toEqual(["already_processed"]);
  });
});

describe("a deduction the wallet cannot cover", () => {
  test("is refused with the balance unchanged and no ledger row", async () => {
    const s = await refusalScenario();
    expect(s.single.ok).toBe(false);
    expect(s.afterSingle).toEqual({ balance: 5, rows: 0 });
  });

  test("five parallel deductions of 4 from a balance of 10: exactly two succeed, balance 2, two ledger rows", async () => {
    const s = await refusalScenario();
    expect(s.accepted).toBe(2);
    expect(s.afterRace).toEqual({ balance: 2, rows: 2 });
  });
});

describe("the rest of the wallet's behaviour", () => {
  test("the database itself refuses a negative balance, even for a write that goes around the wallet code", async () => {
    await reset();
    const wallet = createWallet(db, createFakeGateway(), { currency: "INR" });
    await wallet.openWallet(WS, 5);
    await expect(db.prepare("UPDATE credit_wallets SET balance = balance - 6 WHERE workspace_id = ?").bind(WS).run()).rejects.toThrow(/CHECK constraint failed: balance >= 0/);
    expect(await wallet.getBalance(WS)).toBe(5);
  });

  test("the ledger refuses a negative balance_after on its own, and a second row with the same idempotency key", async () => {
    await reset();
    const insert = (id: string, balanceAfter: number, key: string | null) =>
      db
        .prepare("INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason, idempotency_key) VALUES (?, 'w', 'u', 'topup', 1, ?, 'r', ?)")
        .bind(id, balanceAfter, key)
        .run();
    await expect(insert("a", -1, null)).rejects.toThrow(/CHECK constraint failed: balance_after >= 0/);
    await insert("b", 1, "k");
    // Unique per workspace since migration 0002 (story 0.7): the constraint names both columns.
    await expect(insert("c", 2, "k")).rejects.toThrow(/UNIQUE constraint failed: credit_ledger\.workspace_id, credit_ledger\.idempotency_key/);
  });

  test("a deduction with an idempotency key made twice takes the money once", async () => {
    await reset();
    const wallet = createWallet(db, createFakeGateway(), { currency: "INR" });
    await wallet.openWallet(WS, 50);
    const first = await wallet.deduct({ workspaceId: WS, userId: "u", amount: 10, reason: "usage", idempotencyKey: "job-1" });
    const second = await wallet.deduct({ workspaceId: WS, userId: "u", amount: 10, reason: "usage", idempotencyKey: "job-1" });
    expect(first).toMatchObject({ ok: true, duplicate: false, balanceAfter: 40 });
    expect(second).toMatchObject({ ok: true, duplicate: true });
    expect(await wallet.getBalance(WS)).toBe(40);
    expect(await ledgerCount()).toBe(1);
  });

  test("a deduction from a workspace with no wallet changes nothing", async () => {
    await reset();
    const wallet = createWallet(db, createFakeGateway(), { currency: "INR" });
    const result = await wallet.deduct({ workspaceId: "nobody", userId: "u", amount: 1, reason: "usage" });
    expect(result).toEqual({ ok: false, reason: "wallet_not_found", balance: null });
    expect(await ledgerCount("nobody")).toBe(0);
  });

  test.each([0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60])("an amount of %s is rejected before touching the database", async (amount) => {
    await reset();
    const wallet = createWallet(db, createFakeGateway(), { currency: "INR" });
    await wallet.openWallet(WS, 10);
    await expect(wallet.deduct({ workspaceId: WS, userId: "u", amount, reason: "usage" })).rejects.toThrow(RangeError);
    expect(await wallet.getBalance(WS)).toBe(10);
  });

  test("an order the gateway has not marked PAID credits nothing and stays open", async () => {
    await reset();
    const gateway = createFakeGateway();
    const wallet = createWallet(db, gateway, { currency: "INR" });
    await wallet.openWallet(WS, 0);
    const { orderId } = await wallet.createOrder({ workspaceId: WS, userId: "u", amount: 100 });
    expect(await wallet.confirmOrder(orderId)).toEqual({ status: "ACTIVE", credited: false });
    expect(await wallet.getBalance(WS)).toBe(0);
    const row = await db.prepare("SELECT processed FROM credit_orders WHERE order_id = ?").bind(orderId).first<{ processed: number }>();
    expect(row?.processed).toBe(0);
  });

  test("a gateway outage leaves the order open, and confirming again after it credits once", async () => {
    await reset();
    const gateway = createFakeGateway();
    const wallet = createWallet(db, gateway, { currency: "INR" });
    await wallet.openWallet(WS, 0);
    const { orderId } = await wallet.createOrder({ workspaceId: WS, userId: "u", amount: 100 });
    gateway.setOrder(orderId, { status: "PAID" });
    gateway.failFetches(true);
    expect(await wallet.confirmOrder(orderId)).toEqual({ status: "gateway_error", credited: false });
    expect(await wallet.getBalance(WS)).toBe(0);
    gateway.failFetches(false);
    expect(await wallet.confirmOrder(orderId)).toMatchObject({ status: "PAID", credited: true, credits: 100, balanceAfter: 100 });
    expect(await wallet.confirmOrder(orderId)).toEqual({ status: "already_processed", credited: false });
    expect(await wallet.getBalance(WS)).toBe(100);
  });

  test("an order that does not exist credits nothing", async () => {
    await reset();
    const wallet = createWallet(db, createFakeGateway(), { currency: "INR" });
    expect(await wallet.confirmOrder("order_missing")).toEqual({ status: "order_not_found", credited: false });
  });

  test("credits per unit scales the top-up", async () => {
    await reset();
    const gateway = createFakeGateway();
    const wallet = createWallet(db, gateway, { creditsPerUnit: 10, currency: "INR" });
    await wallet.openWallet(WS, 0);
    const { orderId } = await wallet.createOrder({ workspaceId: WS, userId: "u", amount: 100 });
    gateway.setOrder(orderId, { status: "PAID" });
    expect(await wallet.confirmOrder(orderId)).toMatchObject({ credited: true, credits: 1000 });
  });

  test("a top-up for a workspace whose wallet is missing credits nothing and leaves the order open", async () => {
    await reset();
    const gateway = createFakeGateway();
    const wallet = createWallet(db, gateway, { currency: "INR" });
    await wallet.openWallet(WS, 0);
    const { orderId } = await wallet.createOrder({ workspaceId: WS, userId: "u", amount: 100 });
    gateway.setOrder(orderId, { status: "PAID" });
    await db.prepare("DELETE FROM credit_wallets WHERE workspace_id = ?").bind(WS).run();
    expect(await wallet.confirmOrder(orderId)).toEqual({ status: "wallet_not_found", credited: false });
    const row = await db.prepare("SELECT processed FROM credit_orders WHERE order_id = ?").bind(orderId).first<{ processed: number }>();
    expect(row?.processed).toBe(0);
    expect(await ledgerCount()).toBe(0);
  });
});

test("H5 report", async ({ task }) => {
  const { runs, violatingRuns } = await sweep();
  const orders = await orderScenario();
  const refusals = await refusalScenario();
  attach(task, "h5-wallet", {
    note: "the credit-wallet brick: 50 mixed operations at once (each top-up confirmed twice at once), 20 runs, local D1",
    runs: RUNS,
    violatingRuns,
    perRun: runs,
    orderScenario: orders,
    refusalScenario: refusals,
  });
  record(task, {
    id: "H5",
    measured: violatingRuns,
    checks: { orderCreditedOnce: orders.ok, insufficientRefusesUnchanged: refusals.ok },
  });
});
