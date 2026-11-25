import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { applyMigration, findWorkspaceState, hasWorkspaceRegistry } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { workspaceMiddleware } from "@poc/multi-workspace";
import type { WorkspaceEnv } from "@poc/multi-workspace";
import mwMigration from "../../multi-workspace/migrations/0001_multi_workspace.sql?raw";
import { stubIdentity } from "../../multi-workspace/test/support/stub-identity.ts";
import migration0001 from "../migrations/0001_credit_wallet.sql?raw";
import migration0002 from "../migrations/0002_workspace_scoped_idempotency.sql?raw";
import migration0003 from "../migrations/0003_order_currency.sql?raw";
import migration0004 from "../migrations/0004_milli_credits.sql?raw";
import manifest from "../brick.manifest.json";
import { chargeAction, createFakeGateway, createWallet, createWalletRoutes, deductCreditsExecutor, importWalletBalances, parseBalanceFile, parseDefaultActionCosts, walletCharger } from "../src/index.ts";
import { seeded } from "./support/workload.ts";

// Story 2.5: credits are whole thousandths. Fractional debits are exact, actions have per-workspace costs, credits move
// between workspaces atomically, and decimal balances import exactly.

const db = env.DB as D1Like;

async function reset(): Promise<void> {
  for (const table of ["credit_ledger", "credit_orders", "credit_wallets", "credit_action_costs", "mw_members", "mw_workspaces"]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await applyMigration(db, mwMigration);
  for (const sql of [migration0001, migration0002, migration0003, migration0004]) await applyMigration(db, sql);
}

const ledger = async (workspaceId: string) =>
  (
    await db
      .prepare("SELECT type, amount_milli, balance_after_milli, user_id, reason, metadata, idempotency_key, transfer_code FROM credit_ledger WHERE workspace_id = ? ORDER BY rowid")
      .bind(workspaceId)
      .all<{ type: string; amount_milli: number; balance_after_milli: number; user_id: string; reason: string; metadata: string; idempotency_key: string | null; transfer_code: string | null }>()
  ).results;

beforeEach(async () => {
  expect.hasAssertions();
  await reset();
});

describe("exactness: fractional debits end exactly", () => {
  test("10,000 debits of 0.2 then 10,000 of 0.5 from 10,000 credits end at exactly 3,000, and the ledger replays exactly", async () => {
    const wallet = createWallet(db, undefined);
    await wallet.openWallet("ws-exact", 10_000_000);
    for (const milli of [200, 500]) {
      for (let chunk = 0; chunk < 10_000; chunk += 100) {
        const results = await Promise.all(Array.from({ length: 100 }, () => wallet.deduct({ workspaceId: "ws-exact", userId: "u", amountMilli: milli, reason: "usage" })));
        expect(results.every((r) => r.ok)).toBe(true);
      }
    }
    expect(await wallet.getBalanceMilli("ws-exact")).toBe(3_000_000);
    const totals = await db
      .prepare("SELECT COUNT(*) AS n, SUM(amount_milli) AS total, MIN(balance_after_milli) AS lowest FROM credit_ledger WHERE workspace_id = ?")
      .bind("ws-exact")
      .first<{ n: number; total: number; lowest: number }>();
    expect(totals).toEqual({ n: 20_000, total: -7_000_000, lowest: 3_000_000 });
    // What floats would have done with the same amounts: not exact.
    let float = 10_000;
    for (let i = 0; i < 10_000; i += 1) float -= 0.2;
    for (let i = 0; i < 10_000; i += 1) float -= 0.5;
    expect(float).not.toBe(3_000);
  }, 120_000);

  test("10,000 mixed debits of 0.2 and 0.5 in a random order end exactly at start minus their sum", async () => {
    const wallet = createWallet(db, undefined);
    await wallet.openWallet("ws-mixed", 7_777_777);
    const next = seeded(25);
    const amounts = Array.from({ length: 10_000 }, () => (next() < 0.5 ? 200 : 500));
    for (let i = 0; i < amounts.length; i += 100) {
      await Promise.all(amounts.slice(i, i + 100).map((amountMilli) => wallet.deduct({ workspaceId: "ws-mixed", userId: "u", amountMilli, reason: "usage" })));
    }
    const spent = amounts.reduce((a, b) => a + b, 0);
    expect(await wallet.getBalanceMilli("ws-mixed")).toBe(7_777_777 - spent);
    const rows = await ledger("ws-mixed");
    let running = 7_777_777;
    expect(rows.every((r) => (running += r.amount_milli) === r.balance_after_milli)).toBe(true);
  }, 120_000);

  test("a decimal creditsPerUnit multiplies the order's whole amount in thousandths", async () => {
    const gateway = createFakeGateway();
    const wallet = createWallet(db, gateway, { creditsPerUnit: "2.125", currency: "INR" });
    await wallet.openWallet("ws-order", 0);
    const { orderId } = await wallet.createOrder({ workspaceId: "ws-order", userId: "u", amount: 100 });
    gateway.setOrder(orderId, { status: "PAID" });
    expect(await wallet.confirmOrder(orderId)).toMatchObject({ credited: true, creditsMilli: 212_500, balanceAfterMilli: 212_500 });
    expect(() => createWallet(db, gateway, { creditsPerUnit: 0.0001 })).toThrow(RangeError);
    expect(() => createWallet(db, gateway, { creditsPerUnit: 0 })).toThrow(RangeError);
  });
});

describe("transfers between workspaces (wallet)", () => {
  const A = "ws-tr-a";
  const B = "ws-tr-b";
  // Both are live workspaces (the row the workspace guard reads), as a transfer's destination must be.
  const open = async (a = 10_000, b = 0) => {
    for (const id of [A, B]) await db.prepare("INSERT OR IGNORE INTO mw_workspaces (id, name, owner_id) VALUES (?, ?, 'o')").bind(id, id).run();
    const wallet = createWallet(db, undefined);
    await wallet.openWallet(A, a);
    await wallet.openWallet(B, b);
    return wallet;
  };

  test("moves the amount in one step: two ledger rows sharing a transfer code, and the destination's says nothing of the source", async () => {
    const wallet = await open();
    const result = await wallet.transfer({ fromWorkspaceId: A, toWorkspaceId: B, userId: "alice", amountMilli: 1_500, idempotencyKey: "t1", note: "for the campaign" });
    expect(result).toMatchObject({ ok: true, amountMilli: 1_500, balanceAfterMilli: 8_500, duplicate: false });
    const code = result.ok ? result.transferCode : "";
    expect(code).toMatch(/^tr_[0-9a-f]{32}$/);
    expect(await wallet.getBalanceMilli(A)).toBe(8_500);
    expect(await wallet.getBalanceMilli(B)).toBe(1_500);
    expect(await ledger(A)).toEqual([
      { type: "transfer_out", amount_milli: -1_500, balance_after_milli: 8_500, user_id: "alice", reason: "for the campaign", metadata: JSON.stringify({ to_workspace_id: B }), idempotency_key: "t1", transfer_code: code },
    ]);
    const incoming = await ledger(B);
    expect(incoming).toEqual([
      { type: "transfer_in", amount_milli: 1_500, balance_after_milli: 1_500, user_id: "transfer", reason: "Transfer in", metadata: "{}", idempotency_key: null, transfer_code: code },
    ]);
    expect(JSON.stringify(incoming)).not.toMatch(/alice|ws-tr-a|campaign/);
  });

  test("insufficient balance moves nothing; a retry with the same key moves nothing twice", async () => {
    const wallet = await open(1_000);
    expect(await wallet.transfer({ fromWorkspaceId: A, toWorkspaceId: B, userId: "alice", amountMilli: 2_000, idempotencyKey: "big" })).toEqual({
      ok: false,
      reason: "insufficient_balance",
      balanceMilli: 1_000,
    });
    expect([await wallet.getBalanceMilli(A), await wallet.getBalanceMilli(B)]).toEqual([1_000, 0]);
    expect([...(await ledger(A)), ...(await ledger(B))]).toEqual([]);

    const first = await wallet.transfer({ fromWorkspaceId: A, toWorkspaceId: B, userId: "alice", amountMilli: 600, idempotencyKey: "once" });
    // The retry could not be covered again (400 left), and is still answered as the same transfer.
    const again = await wallet.transfer({ fromWorkspaceId: A, toWorkspaceId: B, userId: "alice", amountMilli: 600, idempotencyKey: "once" });
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(again).toMatchObject({ ok: true, duplicate: true, transferCode: first.ok ? first.transferCode : "x", balanceAfterMilli: 400 });
    expect([await wallet.getBalanceMilli(A), await wallet.getBalanceMilli(B)]).toEqual([400, 600]);
    expect((await ledger(B)).length).toBe(1);
    // The same key for another destination or amount is a conflict, not a second transfer.
    expect(await wallet.transfer({ fromWorkspaceId: A, toWorkspaceId: B, userId: "alice", amountMilli: 100, idempotencyKey: "once" })).toMatchObject({
      ok: false,
      reason: "idempotency_key_reused",
    });
  });

  test("parallel retries of one transfer move it once", async () => {
    const wallet = await open(5_000);
    const results = await Promise.all(Array.from({ length: 10 }, () => wallet.transfer({ fromWorkspaceId: A, toWorkspaceId: B, userId: "alice", amountMilli: 1_000, idempotencyKey: "p" })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && !r.duplicate)).toHaveLength(1);
    expect([await wallet.getBalanceMilli(A), await wallet.getBalanceMilli(B)]).toEqual([4_000, 1_000]);
  });

  test("a transfer to itself, or to a workspace without a wallet, moves nothing", async () => {
    const wallet = await open();
    expect(await wallet.transfer({ fromWorkspaceId: A, toWorkspaceId: A, userId: "alice", amountMilli: 1, idempotencyKey: "self" })).toMatchObject({ ok: false, reason: "same_workspace" });
    expect(await wallet.transfer({ fromWorkspaceId: A, toWorkspaceId: "ws-nowhere", userId: "alice", amountMilli: 1, idempotencyKey: "gone" })).toMatchObject({
      ok: false,
      reason: "destination_not_found",
    });
    expect(await wallet.transfer({ fromWorkspaceId: "ws-no-wallet", toWorkspaceId: B, userId: "alice", amountMilli: 1, idempotencyKey: "src" })).toMatchObject({
      ok: false,
      reason: "source_wallet_not_found",
    });
    expect(await wallet.getBalanceMilli(A)).toBe(10_000);
    expect(await ledger(A)).toEqual([]);
    await expect(wallet.transfer({ fromWorkspaceId: A, toWorkspaceId: B, userId: "alice", amountMilli: 0, idempotencyKey: "z" })).rejects.toThrow(RangeError);
    await expect(wallet.transfer({ fromWorkspaceId: A, toWorkspaceId: B, userId: "alice", amountMilli: 0.5, idempotencyKey: "h" })).rejects.toThrow(RangeError);
  });

  test("a destination that is suspended, or whose workspace row is gone, gets the same answer as one without a wallet; nothing moves", async () => {
    const wallet = await open();
    await db.prepare("UPDATE mw_workspaces SET suspended = 1 WHERE id = ?").bind(B).run();
    expect(await wallet.transfer({ fromWorkspaceId: A, toWorkspaceId: B, userId: "alice", amountMilli: 1, idempotencyKey: "susp" })).toEqual({
      ok: false,
      reason: "destination_not_found",
      balanceMilli: null,
    });
    await db.prepare("UPDATE mw_workspaces SET suspended = 0 WHERE id = ?").bind(B).run();
    await db.prepare("DELETE FROM mw_workspaces WHERE id = ?").bind(B).run(); // the wallet row is still there
    expect(await wallet.transfer({ fromWorkspaceId: A, toWorkspaceId: B, userId: "alice", amountMilli: 1, idempotencyKey: "gone" })).toEqual({
      ok: false,
      reason: "destination_not_found",
      balanceMilli: null,
    });
    expect([await wallet.getBalanceMilli(A), await wallet.getBalanceMilli(B)]).toEqual([10_000, 0]);
    expect([...(await ledger(A)), ...(await ledger(B))]).toEqual([]);
  });

  test("a caller who cannot cover the amount gets insufficient whatever the destination is", async () => {
    const wallet = await open(1_000);
    for (const to of [B, "ws-nowhere"]) {
      expect(await wallet.transfer({ fromWorkspaceId: A, toWorkspaceId: to, userId: "alice", amountMilli: 5_000, idempotencyKey: `probe-${to}` })).toEqual({
        ok: false,
        reason: "insufficient_balance",
        balanceMilli: 1_000,
      });
    }
  });

  test("one key space per workspace: a transfer's key reused for a deduction, a charge or a charger debit takes nothing and is never ok", async () => {
    const wallet = await open();
    expect((await wallet.transfer({ fromWorkspaceId: A, toWorkspaceId: B, userId: "alice", amountMilli: 1_000, idempotencyKey: "shared" })).ok).toBe(true);
    await db.prepare("INSERT INTO credit_action_costs (workspace_id, action, cost_milli) VALUES (?, 'email.send', 200)").bind(A).run();
    expect(await wallet.deduct({ workspaceId: A, userId: "u", amountMilli: 1_000, reason: "x", idempotencyKey: "shared" })).toEqual({
      ok: false,
      reason: "idempotency_key_reused",
      balanceMilli: null,
    });
    expect(await chargeAction(db, A, { userId: "u", action: "email.send", idempotencyKey: "shared" })).toEqual({ ok: false, code: "IDEMPOTENCY_KEY_REUSED" });
    expect(await walletCharger.debit(db, A, 1_000, "shared", "x")).toEqual({ ok: false, code: "IDEMPOTENCY_KEY_REUSED", balanceMilli: 0 });
    // A top-up's key, too.
    await wallet.refund({ workspaceId: A, userId: "u", amountMilli: 5, reason: "r", idempotencyKey: "topup-key" });
    expect((await wallet.deduct({ workspaceId: A, userId: "u", amountMilli: 5, reason: "x", idempotencyKey: "topup-key" })).ok).toBe(false);
    // A deduction's key reused for a different amount, or for a refund.
    await wallet.deduct({ workspaceId: A, userId: "u", amountMilli: 7, reason: "x", idempotencyKey: "ded-key" });
    expect(await wallet.deduct({ workspaceId: A, userId: "u", amountMilli: 8, reason: "x", idempotencyKey: "ded-key" })).toMatchObject({ ok: false, reason: "idempotency_key_reused" });
    expect(await wallet.refund({ workspaceId: A, userId: "u", amountMilli: 7, reason: "x", idempotencyKey: "ded-key" })).toMatchObject({ ok: false, reason: "idempotency_key_reused" });
    // The same deduction again is still a duplicate.
    expect(await wallet.deduct({ workspaceId: A, userId: "u", amountMilli: 7, reason: "x", idempotencyKey: "ded-key" })).toMatchObject({ ok: true, duplicate: true });
    expect(await wallet.getBalanceMilli(A)).toBe(10_000 - 1_000 + 5 - 7);
  });

  test("a charge's key reused with another action or another quantity takes nothing", async () => {
    await open();
    for (const [action, cost] of [["email.send", 200], ["sms.send", 300]] as const) {
      await db.prepare("INSERT INTO credit_action_costs (workspace_id, action, cost_milli) VALUES (?, ?, ?)").bind(A, action, cost).run();
    }
    expect(await chargeAction(db, A, { userId: "u", action: "email.send", quantity: 2, idempotencyKey: "c1" })).toMatchObject({ ok: true, chargedMilli: 400, duplicate: false });
    expect(await chargeAction(db, A, { userId: "u", action: "email.send", quantity: 2, idempotencyKey: "c1" })).toMatchObject({ ok: true, chargedMilli: 400, duplicate: true });
    expect(await chargeAction(db, A, { userId: "u", action: "email.send", quantity: 3, idempotencyKey: "c1" })).toEqual({ ok: false, code: "IDEMPOTENCY_KEY_REUSED" });
    expect(await chargeAction(db, A, { userId: "u", action: "sms.send", quantity: 2, idempotencyKey: "c1" })).toEqual({ ok: false, code: "IDEMPOTENCY_KEY_REUSED" });
    // A plain deduction's key is not a charge either.
    await createWallet(db, undefined).deduct({ workspaceId: A, userId: "u", amountMilli: 400, reason: "x", idempotencyKey: "d1" });
    expect(await chargeAction(db, A, { userId: "u", action: "email.send", quantity: 2, idempotencyKey: "d1" })).toEqual({ ok: false, code: "IDEMPOTENCY_KEY_REUSED" });
    expect(await createWallet(db, undefined).getBalanceMilli(A)).toBe(10_000 - 400 - 400);
  });

  test("a destination wallet removed between the check and the batch rolls the whole transfer back", async () => {
    const wallet = await open();
    // The batch's own guard, without the early check: the destination's ledger row reads a NULL balance and raises.
    await db.prepare("DELETE FROM credit_wallets WHERE workspace_id = ?").bind(B).run();
    await expect(
      db.batch([
        db.prepare("UPDATE credit_wallets SET balance_milli = balance_milli - 5 WHERE workspace_id = ?").bind(A),
        db.prepare("UPDATE credit_wallets SET balance_milli = balance_milli + 5 WHERE workspace_id = ?").bind(B),
        db
          .prepare(
            "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount_milli, balance_after_milli, reason, transfer_code) VALUES ('x', ?, 'transfer', 'transfer_in', 5, (SELECT balance_milli FROM credit_wallets WHERE workspace_id = ?), 'Transfer in', 'tr_x')",
          )
          .bind(B, B),
      ]),
    ).rejects.toThrow(/NOT NULL constraint failed: credit_ledger\.balance_after_milli/);
    expect(await wallet.getBalanceMilli(A)).toBe(10_000);
  });

  test("a transfer racing debits on the source is all or nothing, and the total across both wallets is conserved", async () => {
    let transferred = 0;
    let refused = 0;
    for (let run = 1; run <= 20; run += 1) {
      await reset();
      const wallet = await open(10_000, 3_000);
      const next = seeded(run);
      const debits = Array.from({ length: 12 }, () => 200 + Math.floor(next() * 4) * 100);
      const ops = [
        ...debits.map((amountMilli, i) => async () => ({ kind: "debit" as const, amountMilli, r: await wallet.deduct({ workspaceId: A, userId: "u", amountMilli, reason: `d${i}` }) })),
        async () => ({ kind: "transfer" as const, amountMilli: 6_000, r: await wallet.transfer({ fromWorkspaceId: A, toWorkspaceId: B, userId: "alice", amountMilli: 6_000, idempotencyKey: `race-${run}` }) }),
      ];
      // A different interleaving each run: the transfer starts somewhere among the debits.
      const at = Math.floor(next() * ops.length);
      const ordered = [...ops.slice(0, at), ops[ops.length - 1]!, ...ops.slice(at, ops.length - 1)];
      const outcomes = await Promise.all(ordered.map((op) => op()));

      const transfer = outcomes.find((o) => o.kind === "transfer")!;
      const debited = outcomes.filter((o) => o.kind === "debit" && o.r.ok).reduce((sum, o) => sum + o.amountMilli, 0);
      const a = (await wallet.getBalanceMilli(A))!;
      const b = (await wallet.getBalanceMilli(B))!;
      expect(a + b).toBe(13_000 - debited);
      const outRows = (await ledger(A)).filter((r) => r.type === "transfer_out");
      const inRows = (await ledger(B)).filter((r) => r.type === "transfer_in");
      if (transfer.r.ok) {
        transferred += 1;
        expect(b).toBe(9_000);
        expect(outRows).toHaveLength(1);
        expect(inRows).toHaveLength(1);
        expect(outRows[0]!.transfer_code).toBe(inRows[0]!.transfer_code);
      } else {
        refused += 1;
        expect(b).toBe(3_000);
        expect(outRows).toHaveLength(0);
        expect(inRows).toHaveLength(0);
      }
      // The source's ledger replays exactly to its balance.
      let running = 10_000;
      for (const row of await ledger(A)) expect((running += row.amount_milli)).toBe(row.balance_after_milli);
      expect(running).toBe(a);
    }
    expect(transferred + refused).toBe(20);
    expect(transferred).toBeGreaterThan(0);
  });
});

describe("routes: action costs, charge and transfer", () => {
  const app = new Hono<WorkspaceEnv>();
  app.use("/api/*", stubIdentity);
  // An API-key identity (story 1.11) for `x-test-key: <workspace>`: the key's own workspace, as an owner.
  app.use("/api/*", async (c, next) => {
    const ws = c.req.header("x-test-key");
    if (ws) {
      c.set("user", { id: "apikey:k1", uid: "apikey:k1", email: "" } as never);
      c.set("authenticatedBy" as never, "api-key" as never);
      c.set("ctx", Object.freeze({ userId: "apikey:k1", workspaceId: ws, role: "owner" }));
    }
    await next();
  });
  app.use("/api/wallet", workspaceMiddleware);
  app.use("/api/wallet/*", workspaceMiddleware);
  app.route("/api", createWalletRoutes({ gateway: createFakeGateway(), currency: "INR", defaultActionCosts: "email.send:0.3,message.send:0.5" }));

  const call = (method: string, path: string, user: string | null, workspace: string | null, body?: unknown, extra: Record<string, string> = {}) =>
    app.fetch(
      new Request(`http://localhost/api${path}`, {
        method,
        headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}), ...(workspace ? { "x-workspace-id": workspace } : {}), ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { DB: db },
    );
  const json = async (res: Response) => (await res.json()) as Record<string, any>;

  beforeEach(async () => {
    for (const [ws, user, role] of [
      ["ws-a", "alice", "owner"],
      ["ws-a", "adam", "admin"],
      ["ws-a", "mel", "member"],
      ["ws-b", "bob", "owner"],
    ] as const) {
      await db.prepare("INSERT OR IGNORE INTO mw_workspaces (id, name, owner_id) VALUES (?, ?, ?)").bind(ws, ws, user).run();
      await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, ?, ?)").bind(ws, user, role).run();
    }
    const wallet = createWallet(db, undefined);
    await wallet.openWallet("ws-a", 10_000);
    await wallet.openWallet("ws-b", 0);
  });

  test("an owner or admin sets and removes costs; a member reads them but cannot set them", async () => {
    expect(await json(await call("PUT", "/wallet/costs/email.send", "alice", "ws-a", { cost: 0.2 }))).toEqual({ action: "email.send", cost: 0.2, costMilli: 200, source: "workspace" });
    expect((await call("PUT", "/wallet/costs/sms.send", "adam", "ws-a", { cost: "1.25" })).status).toBe(200);
    expect((await call("PUT", "/wallet/costs/sms.send", "mel", "ws-a", { cost: 0 })).status).toBe(403);
    expect((await call("DELETE", "/wallet/costs/sms.send", "mel", "ws-a")).status).toBe(403);
    const costs = await json(await call("GET", "/wallet/costs", "mel", "ws-a"));
    expect(costs.costs.map((c: { action: string; costMilli: number }) => [c.action, c.costMilli])).toEqual([
      ["email.send", 200],
      ["sms.send", 1_250],
    ]);
    // The default for email.send is overridden by the workspace's own; message.send's still applies.
    expect(costs.defaults).toEqual([{ action: "message.send", cost: 0.5, costMilli: 500, source: "default" }]);
    expect((await call("DELETE", "/wallet/costs/sms.send", "alice", "ws-a")).status).toBe(200);
    expect((await call("DELETE", "/wallet/costs/sms.send", "alice", "ws-a")).status).toBe(404);
    // Costs are the workspace's own: B sees none of A's.
    expect((await json(await call("GET", "/wallet/costs", "bob", "ws-b"))).costs).toEqual([]);
  });

  test.each([[{ cost: 0.0001 }], [{ cost: "1e-3" }], [{ cost: -1 }], [{ cost: 1_000_001 }], [{}], [{ cost: "abc" }]])("a cost of %j is refused with 400", async (body) => {
    expect((await call("PUT", "/wallet/costs/email.send", "alice", "ws-a", body)).status).toBe(400);
  });

  test("a malformed action name is refused with 400", async () => {
    expect((await call("PUT", "/wallet/costs/Email.Send", "alice", "ws-a", { cost: 1 })).status).toBe(400);
    expect((await call("POST", "/wallet/charge", "alice", "ws-a", { action: "1x", idempotencyKey: "k" })).status).toBe(400);
  });

  test("charge takes cost x quantity once per key; an unknown action is 404 and insufficient is 402", async () => {
    await call("PUT", "/wallet/costs/email.send", "alice", "ws-a", { cost: 0.2 });
    const charged = await call("POST", "/wallet/charge", "mel", "ws-a", { action: "email.send", quantity: 3, idempotencyKey: "batch-1" });
    expect(charged.status).toBe(200);
    expect(await json(charged)).toEqual({
      action: "email.send",
      quantity: 3,
      cost: 0.2,
      costMilli: 200,
      charged: 0.6,
      chargedMilli: 600,
      balanceAfter: 9.4,
      balanceAfterMilli: 9_400,
      duplicate: false,
    });
    expect(await json(await call("POST", "/wallet/charge", "mel", "ws-a", { action: "email.send", quantity: 3, idempotencyKey: "batch-1" }))).toMatchObject({ duplicate: true, chargedMilli: 600 });
    // A default cost applies to an action the workspace has not priced.
    expect(await json(await call("POST", "/wallet/charge", "mel", "ws-a", { action: "message.send", idempotencyKey: "m-1" }))).toMatchObject({ chargedMilli: 500, balanceAfterMilli: 8_900 });
    const unknown = await call("POST", "/wallet/charge", "mel", "ws-a", { action: "fax.send", idempotencyKey: "f-1" });
    expect(unknown.status).toBe(404);
    expect((await json(unknown)).code).toBe("UNKNOWN_ACTION");
    const tooMuch = await call("POST", "/wallet/charge", "mel", "ws-a", { action: "email.send", quantity: 10_000, idempotencyKey: "big" });
    expect(tooMuch.status).toBe(402);
    expect(await json(tooMuch)).toMatchObject({ code: "INSUFFICIENT_CREDITS", balance: 8.9, balanceMilli: 8_900 });
    for (const body of [{ action: "email.send", quantity: 0, idempotencyKey: "q" }, { action: "email.send", quantity: 10_001, idempotencyKey: "q" }, { action: "email.send", quantity: 1.5, idempotencyKey: "q" }, { action: "email.send" }]) {
      expect((await call("POST", "/wallet/charge", "mel", "ws-a", body)).status).toBe(400);
    }
    expect(await createWallet(db, undefined).getBalanceMilli("ws-a")).toBe(8_900);
  });

  test("transfer: an owner or admin moves credits to another workspace; both see their own row and the same code", async () => {
    const res = await call("POST", "/wallet/transfer", "adam", "ws-a", { toWorkspaceId: "ws-b", amount: 1.5, idempotencyKey: "tr-1", note: "seed b" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ amount: 1.5, amountMilli: 1_500, balanceAfter: 8.5, balanceAfterMilli: 8_500, duplicate: false });
    const a = (await json(await call("GET", "/wallet/history", "alice", "ws-a"))).ledgers;
    const b = (await json(await call("GET", "/wallet/history", "bob", "ws-b"))).ledgers;
    expect(a[0]).toMatchObject({ type: "transfer_out", amount: -1.5, amountMilli: -1_500, transferCode: body.transferCode });
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ type: "transfer_in", amount: 1.5, amountMilli: 1_500, balanceAfter: 1.5, transferCode: body.transferCode, description: "Transfer in", metadata: {} });
    expect(JSON.stringify(b)).not.toMatch(/ws-a|adam|seed b/);
    expect((await json(await call("GET", "/wallet", "bob", "ws-b")))).toMatchObject({ currentBalance: 1.5, currentBalanceMilli: 1_500 });
  });

  test("transfer refusals: a member, an API key, itself, too much, an unknown destination, a bad amount; nothing moves", async () => {
    const send = (user: string | null, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
      call("POST", "/wallet/transfer", user, "ws-a", { toWorkspaceId: "ws-b", amount: 1, idempotencyKey: "k", ...body }, extra);
    expect((await send("mel", {})).status).toBe(403);
    const key = await send(null, {}, { "x-test-key": "ws-a" });
    expect(key.status).toBe(403);
    expect((await json(key)).code).toBe("API_KEY_FORBIDDEN");
    expect((await send("alice", { toWorkspaceId: "ws-a" })).status).toBe(400);
    const tooMuch = await send("alice", { amount: 11 });
    expect(tooMuch.status).toBe(402);
    expect(await json(tooMuch)).toMatchObject({ code: "INSUFFICIENT_CREDITS", balanceMilli: 10_000 });
    // A workspace that does not exist and one that exists without a wallet get the same answer.
    await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES ('ws-c', 'c', 'carol')").run();
    const missing = await send("alice", { toWorkspaceId: "ws-c" });
    const unknown = await send("alice", { toWorkspaceId: "ws-zzz" });
    expect([missing.status, unknown.status]).toEqual([404, 404]);
    expect(await json(missing)).toEqual(await json(unknown));
    for (const amount of [0, 0.0001, "1e-3", -1, "x"]) expect((await send("alice", { amount })).status).toBe(400);
    expect((await call("POST", "/wallet/transfer", "alice", "ws-a", { toWorkspaceId: "ws-b", amount: 1 })).status).toBe(400); // no key
    expect(await createWallet(db, undefined).getBalanceMilli("ws-a")).toBe(10_000);
    expect(await createWallet(db, undefined).getBalanceMilli("ws-b")).toBe(0);
    expect(await ledger("ws-a")).toEqual([]);
  });

  test("a transfer retried with the same key answers the same transfer and moves nothing more", async () => {
    const first = await json(await call("POST", "/wallet/transfer", "alice", "ws-a", { toWorkspaceId: "ws-b", amount: "2.5", idempotencyKey: "same" }));
    const second = await json(await call("POST", "/wallet/transfer", "alice", "ws-a", { toWorkspaceId: "ws-b", amount: "2.5", idempotencyKey: "same" }));
    expect(second).toMatchObject({ transferCode: first.transferCode, duplicate: true });
    expect(await createWallet(db, undefined).getBalanceMilli("ws-b")).toBe(2_500);
  });

  test("a transfer's key reused on /wallet/deduct or /wallet/charge is 409 IDEMPOTENCY_KEY_REUSED and takes nothing", async () => {
    await call("PUT", "/wallet/costs/email.send", "alice", "ws-a", { cost: 0.2 });
    expect((await call("POST", "/wallet/transfer", "alice", "ws-a", { toWorkspaceId: "ws-b", amount: 1, idempotencyKey: "k-shared" })).status).toBe(200);
    const deduct = await call("POST", "/wallet/deduct", "mel", "ws-a", { amount: 1, idempotencyKey: "k-shared" });
    const charge = await call("POST", "/wallet/charge", "mel", "ws-a", { action: "email.send", idempotencyKey: "k-shared" });
    expect([deduct.status, charge.status]).toEqual([409, 409]);
    expect((await json(deduct)).code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await json(charge)).code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await createWallet(db, undefined).getBalanceMilli("ws-a")).toBe(9_000);
  });
});

describe("importing decimal balances", () => {
  const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const csv = "workspaceId,balance,ignored\nws-i1,12.345,x\nws-i2,0.2,y\n\"ws-i3\",\"7\",z\nws-i4,0,\n";
  /** Live workspaces (the rows the workspace guard reads); `wallets` also get an empty wallet. */
  const live = async (ids: string[], wallets = true) => {
    for (const id of ids) {
      await db.prepare("INSERT OR IGNORE INTO mw_workspaces (id, name, owner_id) VALUES (?, ?, 'o')").bind(id, id).run();
      if (wallets) await createWallet(db, undefined).openWallet(id, 0);
    }
  };

  beforeEach(async () => {
    await live(["ws-i1", "ws-i2", "ws-i3", "ws-i4"]);
  });

  test("a decimal fixture converts exactly and reconciles to the thousandth, balance by balance; a dry run writes nothing", async () => {
    const rows = parseBalanceFile(csv, "csv");
    const dry = await importWalletBalances(db, rows, { fileHash: HASH });
    expect(dry.rows.map((r) => [r.workspaceId, r.milli, r.status, r.resultingBalanceMilli])).toEqual([
      ["ws-i1", 12_345, "would_import", 12_345],
      ["ws-i2", 200, "would_import", 200],
      ["ws-i3", 7_000, "would_import", 7_000],
      ["ws-i4", 0, "zero", 0],
    ]);
    expect(dry).toMatchObject({ applied: false, sourceTotal: "19.545", importedTotal: "19.545", importedTotalMilli: 19_545, mismatchedRows: 0, reconciled: true });
    expect(await createWallet(db, undefined).getBalanceMilli("ws-i1")).toBe(0);

    const applied = await importWalletBalances(db, rows, { fileHash: HASH, apply: true });
    expect(applied).toMatchObject({ applied: true, importedTotal: "19.545", resultingTotalMilli: 19_545, ledgerMismatches: 0, balanceMismatches: 0, reconciled: true });
    expect(applied.rows.map((r) => [r.status, r.resultingBalanceMilli, r.balanceMatches])).toEqual([
      ["imported", 12_345, true],
      ["imported", 200, true],
      ["imported", 7_000, true],
      ["zero", 0, true],
    ]);
    const wallet = createWallet(db, undefined);
    expect([await wallet.getBalanceMilli("ws-i1"), await wallet.getBalanceMilli("ws-i2"), await wallet.getBalanceMilli("ws-i3"), await wallet.getBalanceMilli("ws-i4")]).toEqual([
      12_345, 200, 7_000, 0,
    ]);
    expect((await ledger("ws-i1"))[0]).toMatchObject({ type: "topup", amount_milli: 12_345, idempotency_key: `import:${HASH}:ws-i1` });
  });

  test("a re-run of the same file credits nothing twice", async () => {
    const rows = parseBalanceFile(csv, "csv");
    await importWalletBalances(db, rows, { fileHash: HASH, apply: true });
    const again = await importWalletBalances(db, rows, { fileHash: HASH, apply: true });
    expect(again.rows.map((r) => r.status)).toEqual(["already_imported", "already_imported", "already_imported", "zero"]);
    expect(again.reconciled).toBe(true);
    expect(await createWallet(db, undefined).getBalanceMilli("ws-i1")).toBe(12_345);
    expect(await ledger("ws-i1")).toHaveLength(1);
  });

  test("a wallet that already holds credits, or an earlier import, is refused unless allowExisting, which is recorded", async () => {
    await createWallet(db, undefined).refund({ workspaceId: "ws-i1", userId: "u", amountMilli: 1_000, reason: "earlier", idempotencyKey: "earlier" });
    await importWalletBalances(db, parseBalanceFile("workspaceId,balance\nws-i2,1\n", "csv"), { fileHash: "ab".repeat(32), apply: true });
    const rows = parseBalanceFile("workspaceId,balance\nws-i1,2\nws-i2,3\n", "csv");
    const strict = await importWalletBalances(db, rows, { fileHash: HASH, apply: true });
    expect(strict.rows.map((r) => r.status)).toEqual(["refused", "refused"]);
    expect(strict.rows[0]!.error).toMatch(/already holds credits or has an earlier import/);
    expect([await createWallet(db, undefined).getBalanceMilli("ws-i1"), await createWallet(db, undefined).getBalanceMilli("ws-i2")]).toEqual([1_000, 1_000]);

    const added = await importWalletBalances(db, rows, { fileHash: HASH, apply: true, allowExisting: true });
    expect(added).toMatchObject({ allowExisting: true, balanceMismatches: 0, resultingTotalMilli: 5_000 });
    expect(added.rows.map((r) => [r.status, r.balanceBeforeMilli, r.resultingBalanceMilli, r.balanceMatches])).toEqual([
      ["imported", 1_000, 3_000, true],
      ["imported", 1_000, 4_000, true],
    ]);
  });

  test("an id that is not a live workspace is refused; a workspace without a wallet needs createWallets", async () => {
    await live(["ws-new"], false);
    const rows = parseBalanceFile("workspaceId,balance\nws-ghost,1\nws-new,2\n", "csv");
    const strict = await importWalletBalances(db, rows, { fileHash: HASH, apply: true });
    expect(strict.rows.map((r) => [r.status, r.error])).toEqual([
      ["refused", "no such workspace"],
      ["refused", expect.stringMatching(/has no wallet/)],
    ]);
    const created = await importWalletBalances(db, rows, { fileHash: HASH, apply: true, createWallets: true });
    expect(created.rows.map((r) => r.status)).toEqual(["refused", "imported"]);
    expect(await createWallet(db, undefined).getBalanceMilli("ws-ghost")).toBeNull();
    expect(await createWallet(db, undefined).getBalanceMilli("ws-new")).toBe(2_000);
  });

  test("more than three decimals is refused, unless a rounding mode is given, and then every rounded row is reported", async () => {
    await live(["ws-r1", "ws-r2"]);
    const rows = parseBalanceFile(JSON.stringify([{ workspaceId: "ws-r1", balance: "1.2345" }, { workspaceId: "ws-r2", balance: "2.5" }]), "json");
    const strict = await importWalletBalances(db, rows, { fileHash: HASH, apply: true });
    expect(strict.rows[0]).toMatchObject({ status: "refused", milli: null });
    expect(strict).toMatchObject({ refusedRows: 1, mismatchedRows: 1, sourceTotal: "3.7345", importedTotal: "2.5", reconciled: false });
    expect(await createWallet(db, undefined).getBalanceMilli("ws-r1")).toBe(0);

    const up = await importWalletBalances(db, rows, { fileHash: "ab".repeat(32), rounding: "half-up" });
    expect(up.rows[0]).toMatchObject({ milli: 1_235, rounded: true, status: "would_import" });
    // ws-r2 already holds the earlier import, so this other file is refused there.
    expect(up).toMatchObject({ roundedRows: 1, refusedRows: 1, mismatchedRows: 2, importedTotal: "1.235", reconciled: false });
    const down = await importWalletBalances(db, rows, { fileHash: "cd".repeat(32), rounding: "down" });
    expect(down.rows[0]).toMatchObject({ milli: 1_234, rounded: true });
  });

  test("bad rows are refused one by one and the rest still import; a JSON number balance is refused", async () => {
    await live(["ws-ok", "ws-neg", "ws-exp", "ws-num"]);
    const rows = parseBalanceFile(
      JSON.stringify([
        { workspaceId: "ws-ok", balance: "3" },
        { workspaceId: "", balance: "1" },
        { workspaceId: "ws-neg", balance: "-1" },
        { workspaceId: "ws-exp", balance: "1e3" },
        { workspaceId: "ws-ok", balance: "4" },
        { workspaceId: "ws-num", balance: 0.5 },
      ]),
      "json",
    );
    const report = await importWalletBalances(db, rows, { fileHash: HASH, apply: true });
    expect(report.rows.map((r) => r.status)).toEqual(["imported", "refused", "refused", "refused", "refused", "refused"]);
    expect(report.rows[5]!.error).toMatch(/must be a string/);
    expect(report.refusedRows).toBe(5);
    expect(await createWallet(db, undefined).getBalanceMilli("ws-num")).toBe(0);
    await expect(importWalletBalances(db, rows, { fileHash: "not-a-hash" })).rejects.toThrow(RangeError);
    await expect(importWalletBalances(db, rows, { fileHash: HASH, apply: true, checkDatabase: false })).rejects.toThrow(RangeError);
    expect(() => parseBalanceFile("id,amount\nx,1", "csv")).toThrow(/workspaceId and balance/);
  });

  test("totals past a safe integer stop the import before anything is written", async () => {
    await live(["ws-big1", "ws-big2"]);
    const rows = parseBalanceFile("workspaceId,balance\nws-big1,9000000000000\nws-big2,9000000000000\n", "csv");
    await expect(importWalletBalances(db, rows, { fileHash: HASH, apply: true })).rejects.toThrow(/too large/);
    expect([await createWallet(db, undefined).getBalanceMilli("ws-big1"), await createWallet(db, undefined).getBalanceMilli("ws-big2")]).toEqual([0, 0]);
  });
});

describe("defaultActionCosts: the manifest's pattern and the parser agree", () => {
  const pattern = new RegExp(manifest.settings.defaultActionCosts.pattern);
  const action64 = `a${"z".repeat(63)}`;

  test("every boundary the pattern accepts parses without throwing, to the cost it names; the first entry for an action wins", () => {
    const accepted = [
      "",
      "a:0",
      "a:999999.999",
      `${action64}:1`,
      "email.send:0.2,message.send:0.5",
      "message:wa:1",
      "a-b_c.d:e:0.001",
      "a:1,a:2",
      "a:000999",
    ];
    for (const spec of accepted) {
      expect(pattern.test(spec), spec).toBe(true);
      expect(() => parseDefaultActionCosts(spec), spec).not.toThrow();
    }
    expect(parseDefaultActionCosts("a:999999.999").get("a")).toBe(999_999_999);
    expect(parseDefaultActionCosts("a:1,a:2").get("a")).toBe(1_000);
    expect(parseDefaultActionCosts("message:wa:1").get("message:wa")).toBe(1_000);
  });

  test("past the cap, or malformed, the pattern refuses it (the parser never sees it in an assembled app)", () => {
    for (const spec of ["a:1000000", "a:0.0001", `${action64}z:1`, "A:1", "1a:1", "a:1,", " a:1", "a:1e3", "a:-1", "a:", ":1"]) {
      expect(pattern.test(spec), spec).toBe(false);
    }
    expect(() => parseDefaultActionCosts("a:1000000")).toThrow(RangeError);
  });
});

/** A new D1Like object over the same database, so the registry cache (kept per database object) starts empty. */
const freshHandle = (base: D1Like, beforeBatch?: () => Promise<void>): D1Like => ({
  prepare: (sql) => base.prepare(sql),
  batch: async (statements) => {
    if (beforeBatch) await beforeBatch();
    return base.batch(statements);
  },
  exec: (sql) => base.exec(sql),
});

describe("operation tags: a key answers duplicate only for the very same operation", () => {
  const W = "ws-tags";
  beforeEach(async () => {
    await createWallet(db, undefined).openWallet(W, 100_000);
    await db.prepare("INSERT INTO credit_action_costs (workspace_id, action, cost_milli) VALUES (?, 'email.send', 1000)").bind(W).run();
  });
  const node = (nodeId: string, key: string) =>
    deductCreditsExecutor({
      nodeId,
      workspaceId: W,
      data: { amount: 1 },
      inputs: { in: { userId: "u", idempotencyKey: key } },
      binding: () => db,
    } as unknown as Parameters<typeof deductCreditsExecutor>[0]);

  test("two graph nodes sharing a key: the second is refused, not answered with the first's debit", async () => {
    expect(await node("pay-1", "run-1")).toMatchObject({ out: { chargedMilli: 1_000, duplicate: false } });
    expect(await node("pay-1", "run-1")).toMatchObject({ out: { duplicate: true } });
    await expect(node("pay-2", "run-1")).rejects.toThrow(/IDEMPOTENCY_KEY_REUSED/);
    expect(await createWallet(db, undefined).getBalanceMilli(W)).toBe(99_000);
  });

  test("a library deduction of the same amount after an action charge, and a charger debit after a deduction, are refused", async () => {
    expect((await chargeAction(db, W, { userId: "u", action: "email.send", idempotencyKey: "k-a" })).ok).toBe(true);
    expect(await createWallet(db, undefined).deduct({ workspaceId: W, userId: "u", amountMilli: 1_000, reason: "x", idempotencyKey: "k-a" })).toMatchObject({
      ok: false,
      reason: "idempotency_key_reused",
    });
    await createWallet(db, undefined).deduct({ workspaceId: W, userId: "u", amountMilli: 2_000, reason: "x", idempotencyKey: "k-d", match: { op: "deduct" } });
    expect(await walletCharger.debit(db, W, 2_000, "k-d", "x")).toEqual({ ok: false, code: "IDEMPOTENCY_KEY_REUSED", balanceMilli: 0 });
    expect(await createWallet(db, undefined).getBalanceMilli(W)).toBe(97_000);
  });

  test("a row whose metadata is null or not an object is never the same operation, and reuse of its key does not throw", async () => {
    for (const [key, meta] of [["k-null", "null"], ["k-num", "7"], ["k-bad", "{not json"]] as const) {
      await db
        .prepare("INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount_milli, balance_after_milli, reason, metadata, idempotency_key) VALUES (?, ?, 'u', 'deduction', -1000, 99000, 'x', ?, ?)")
        .bind(`row-${key}`, W, meta, key)
        .run();
      expect(await createWallet(db, undefined).deduct({ workspaceId: W, userId: "u", amountMilli: 1_000, reason: "x", idempotencyKey: key })).toMatchObject({ ok: false, reason: "idempotency_key_reused" });
      expect(await chargeAction(db, W, { userId: "u", action: "email.send", idempotencyKey: key })).toEqual({ ok: false, code: "IDEMPOTENCY_KEY_REUSED" });
    }
    await db
      .prepare("INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount_milli, balance_after_milli, reason, metadata, idempotency_key, transfer_code) VALUES ('row-t', ?, 'u', 'transfer_out', -1000, 99000, 'x', 'null', 'k-tr', 'tr_x')")
      .bind(W)
      .run();
    await createWallet(db, undefined).openWallet("ws-tags-b", 0);
    await db.prepare("INSERT OR IGNORE INTO mw_workspaces (id, name, owner_id) VALUES ('ws-tags-b', 'b', 'o')").run();
    expect(await createWallet(db, undefined).transfer({ fromWorkspaceId: W, toWorkspaceId: "ws-tags-b", userId: "u", amountMilli: 1_000, idempotencyKey: "k-tr" })).toMatchObject({
      ok: false,
      reason: "idempotency_key_reused",
    });
  });
});

describe("the destination's state inside the transfer's batch, and the optional workspace registry", () => {
  const A = "ws-reg-a";
  const B = "ws-reg-b";
  beforeEach(async () => {
    for (const id of [A, B]) await db.prepare("INSERT OR IGNORE INTO mw_workspaces (id, name, owner_id) VALUES (?, ?, 'o')").bind(id, id).run();
    await createWallet(db, undefined).openWallet(A, 10_000);
    await createWallet(db, undefined).openWallet(B, 0);
  });

  test("a destination suspended after the check but before the batch: the whole transfer rolls back", async () => {
    const racing = freshHandle(db, async () => {
      await db.prepare("UPDATE mw_workspaces SET suspended = 1 WHERE id = ?").bind(B).run();
    });
    expect(await createWallet(racing, undefined).transfer({ fromWorkspaceId: A, toWorkspaceId: B, userId: "u", amountMilli: 1_000, idempotencyKey: "race" })).toEqual({
      ok: false,
      reason: "destination_not_found",
      balanceMilli: null,
    });
    expect([await createWallet(db, undefined).getBalanceMilli(A), await createWallet(db, undefined).getBalanceMilli(B)]).toEqual([10_000, 0]);
    expect([...(await ledger(A)), ...(await ledger(B))]).toEqual([]);
  });

  test("with a registry an unknown workspace is null; without one every id is unchecked, and transfers and imports fall back to the wallet", async () => {
    expect(await hasWorkspaceRegistry(freshHandle(db))).toBe(true);
    expect(await findWorkspaceState(freshHandle(db), "ws-unknown")).toBeNull();
    expect(await findWorkspaceState(freshHandle(db), A)).toEqual({ suspended: false, reason: null, deleting: false, checked: true });

    await db.prepare("DROP TABLE mw_members").run();
    await db.prepare("DROP TABLE mw_workspaces").run();
    const bare = freshHandle(db);
    expect(await hasWorkspaceRegistry(bare)).toBe(false);
    expect(await findWorkspaceState(bare, "anything")).toEqual({ suspended: false, reason: null, deleting: false, checked: false });
    const wallet = createWallet(bare, undefined);
    expect(await wallet.transfer({ fromWorkspaceId: A, toWorkspaceId: B, userId: "u", amountMilli: 1_000, idempotencyKey: "nr" })).toMatchObject({ ok: true });
    expect(await wallet.transfer({ fromWorkspaceId: A, toWorkspaceId: "ws-no-wallet", userId: "u", amountMilli: 1_000, idempotencyKey: "nr-2" })).toMatchObject({
      ok: false,
      reason: "destination_not_found",
    });
    const report = await importWalletBalances(bare, parseBalanceFile("workspaceId,balance\nws-reg-b,0\nws-new,1\n", "csv"), {
      fileHash: "ef".repeat(32),
      apply: true,
      createWallets: true,
      allowExisting: true,
    });
    expect(report.rows.map((r) => r.status)).toEqual(["zero", "refused"]);
    expect(report.rows[1]!.error).toMatch(/without a workspace registry/);
    expect(await wallet.getBalanceMilli("ws-new")).toBeNull();
  });
});

describe("import: a row that fails while writing", () => {
  const HASH = "12".repeat(32);
  beforeEach(async () => {
    for (const id of ["ws-w1", "ws-w2", "ws-w3"]) {
      await db.prepare("INSERT OR IGNORE INTO mw_workspaces (id, name, owner_id) VALUES (?, ?, 'o')").bind(id, id).run();
      await createWallet(db, undefined).openWallet(id, 0);
    }
  });

  test("is reported, leaves the imported total, and makes the report not reconciled; the other rows still import", async () => {
    let batches = 0;
    const flaky = freshHandle(db, async () => {
      batches += 1;
      if (batches === 2) throw new Error("network reset");
    });
    const report = await importWalletBalances(flaky, parseBalanceFile("workspaceId,balance\nws-w1,1\nws-w2,2\nws-w3,3\n", "csv"), { fileHash: HASH, apply: true });
    expect(report.rows.map((r) => [r.status, r.milli])).toEqual([
      ["imported", 1_000],
      ["refused", null],
      ["imported", 3_000],
    ]);
    expect(report.rows[1]).toMatchObject({ failedMilli: 2_000, error: expect.stringMatching(/writing failed: network reset/) });
    expect(report).toMatchObject({ importedTotal: "4", importedTotalMilli: 4_000, refusedRows: 1, reconciled: false });
  });

  test("a refused row is never reconciled, even when the totals agree", async () => {
    const report = await importWalletBalances(db, parseBalanceFile("workspaceId,balance\nws-w1,1\nws-ghost,0\n", "csv"), { fileHash: HASH });
    expect(report).toMatchObject({ sourceTotal: "1", importedTotal: "1", refusedRows: 1, reconciled: false });
  });
});
