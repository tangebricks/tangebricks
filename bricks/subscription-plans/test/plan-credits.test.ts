// Story 1.20: plan credits. A plan grants its `planCredits` once per credit period through credit-wallet's walletCharger
// (the real one, against credit-wallet's real migrations and the multi-workspace registry), lazily on read or create
// and from the per-minute sweep. The ledger key plan-credits:<plan>:<period> is the guard; the column only spares rescans.
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { walletCharger } from "@poc/credit-wallet";
import mwMigration from "../../multi-workspace/migrations/0001_multi_workspace.sql?raw";
import wallet0001 from "../../credit-wallet/migrations/0001_credit_wallet.sql?raw";
import wallet0002 from "../../credit-wallet/migrations/0002_workspace_scoped_idempotency.sql?raw";
import wallet0003 from "../../credit-wallet/migrations/0003_order_currency.sql?raw";
import wallet0004 from "../../credit-wallet/migrations/0004_milli_credits.sql?raw";
import migration0001 from "../migrations/0001_subscription_plans.sql?raw";
import migration0002 from "../migrations/0002_plan_credits.sql?raw";
import {
  PLAN_CREDIT_RETRY_DELAY_MS,
  PLAN_CREDIT_SWEEP_LIMIT,
  PlanService,
  createPlanRoutes,
  creditPeriodIndex,
  parsePlanCredits,
  planCreditKey,
  runPlanCreditSweep,
} from "../src/index.ts";
import type { PlanCreditCharger, PlanCreditsConfig } from "../src/index.ts";
import type { PlanEnv } from "../src/middleware.ts";

// walletCharger is handed to this brick as its PlanCreditCharger: checked at compile time here.
const charger: PlanCreditCharger = walletCharger;

const db = env.DB as D1Like;
const WS_A = "ws_credits_alpha";
const WS_B = "ws_credits_beta";
const CREDITS: PlanCreditsConfig = { charger, planCredits: "free:100,pro:1000" };
const DAY = 86_400_000;

async function reset(): Promise<void> {
  for (const t of [
    "sub_subscriptions",
    "sub_plans",
    "credit_ledger",
    "credit_orders",
    "credit_wallets",
    "credit_action_costs",
    "mw_invites",
    "mw_members",
    "mw_workspaces",
  ]) {
    await db.prepare(`DROP TABLE IF EXISTS ${t}`).run();
  }
  for (const sql of [mwMigration, wallet0001, wallet0002, wallet0003, wallet0004, migration0001, migration0002]) await applyMigration(db, sql);
  for (const id of [WS_A, WS_B]) await registerWorkspace(id);
}

async function registerWorkspace(id: string): Promise<void> {
  await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES (?, ?, ?)").bind(id, `Workspace ${id}`, `owner-${id}`).run();
  await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").bind(id, `owner-${id}`).run();
}

const balance = (ws: string) => walletCharger.balanceMilli(db, ws);
const ledgerKeys = async (ws: string) =>
  (await db.prepare("SELECT idempotency_key FROM credit_ledger WHERE workspace_id = ? ORDER BY rowid").bind(ws).all<{ idempotency_key: string }>()).results.map(
    (r) => r.idempotency_key,
  );
const marker = async (ws: string) =>
  (await db.prepare("SELECT credits_granted_period AS p FROM sub_subscriptions WHERE workspace_id = ?").bind(ws).first<{ p: number | null }>())?.p;
/** Moves the subscription's start back, which is the same as moving the clock forward for the period count. */
const backdate = (ws: string, days: number) =>
  db
    .prepare("UPDATE sub_subscriptions SET created_at = ? WHERE workspace_id = ?")
    .bind(new Date(Date.now() - days * DAY).toISOString(), ws)
    .run();

beforeEach(async () => {
  expect.hasAssertions();
  await reset();
});

describe("the planCredits setting and the credit period", () => {
  it("parses tier:credits entries; the first entry for a tier wins; a bad value is refused with the format", () => {
    expect([...parsePlanCredits("free:100,pro:1000,free:5")]).toEqual([
      ["free", 100],
      ["pro", 1000],
    ]);
    expect(parsePlanCredits("").size).toBe(0);
    for (const bad of ["free", "free:-1", "free:1.5", "Free:1", "free:1,", " free:1", "free:1234567890"]) {
      expect(() => parsePlanCredits(bad), bad).toThrow(/tier:credits/);
    }
    expect(() => parsePlanCredits(Array.from({ length: 21 }, (_, i) => `t${i}:1`).join(","))).toThrow();
    expect(parsePlanCredits(Array.from({ length: 20 }, (_, i) => `t${i}:1`).join(",")).size).toBe(20);
  });

  it("counts whole months (or years) from created_at in UTC; one_time plans stay in period 0", () => {
    const created = "2026-01-31T10:00:00.000Z";
    const at = (iso: string, period: "month" | "year" = "month", interval?: string) => creditPeriodIndex(created, Date.parse(iso), period, interval);
    expect(at("2026-01-31T10:00:00.000Z")).toBe(0);
    expect(at("2026-02-28T23:59:59.999Z")).toBe(0);
    expect(at("2026-03-01T00:00:00.000Z")).toBe(1);
    expect(at("2026-03-31T09:59:59.999Z")).toBe(1);
    expect(at("2026-03-31T10:00:00.000Z")).toBe(2);
    expect(at("2027-01-31T10:00:00.000Z")).toBe(12);
    expect(at("2027-01-31T09:00:00.000Z", "year")).toBe(0);
    expect(at("2027-01-31T10:00:00.000Z", "year")).toBe(1);
    expect(at("2030-06-01T00:00:00.000Z", "month", "one_time")).toBe(0);
    expect(at("2025-01-01T00:00:00.000Z")).toBe(0); // a clock behind created_at is period 0
    // SQLite's datetime('now') form is read as UTC too.
    expect(creditPeriodIndex("2026-01-31 10:00:00", Date.parse("2026-03-31T10:00:00Z"), "month")).toBe(2);
    expect(planCreditKey("free", 3)).toBe("plan-credits:free:3");
  });
});

describe("grants on read and create (story 1.20)", () => {
  it("a new free workspace gets 100 credits once on its first read, also under five concurrent reads", async () => {
    const service = () => new PlanService(db, "free", CREDITS);
    await Promise.all(Array.from({ length: 5 }, () => service().getSubscription(WS_A)));
    expect(await balance(WS_A)).toBe(100_000);
    for (let i = 0; i < 3; i += 1) await service().getSubscription(WS_A);
    await service().subscribe(WS_A, "free");
    expect(await balance(WS_A)).toBe(100_000);
    expect(await ledgerKeys(WS_A)).toEqual(["plan-credits:free:0"]);
    expect(await marker(WS_A)).toBe(0);
    expect(await balance(WS_B)).toBe(0);
  });

  it("a renewal (the clock in the next month) grants once more; reads in that period add nothing", async () => {
    const service = new PlanService(db, "free", CREDITS);
    await service.getSubscription(WS_A);
    await backdate(WS_A, 35);
    await Promise.all([service.getSubscription(WS_A), service.getSubscription(WS_A), service.getSubscription(WS_A)]);
    expect(await balance(WS_A)).toBe(200_000);
    expect(await ledgerKeys(WS_A)).toEqual(["plan-credits:free:0", "plan-credits:free:1"]);
  });

  it("a plan change mid-period grants the new plan's credits once; going back does not repeat free's", async () => {
    const service = new PlanService(db, "free", CREDITS);
    await service.createPlan("pro", "Pro", 0, "month");
    await service.getSubscription(WS_A);
    await service.changePlan(WS_A, "pro");
    await service.changePlan(WS_A, "pro");
    await service.getSubscription(WS_A);
    expect(await balance(WS_A)).toBe(1_100_000);
    await service.changePlan(WS_A, "free");
    await service.getSubscription(WS_A);
    expect(await balance(WS_A)).toBe(1_100_000);
    expect(await ledgerKeys(WS_A)).toEqual(["plan-credits:free:0", "plan-credits:pro:0"]);
  });

  it("canceled and past_due subscriptions get nothing, and cancelling or downgrading never takes credits back", async () => {
    const service = new PlanService(db, "free", CREDITS);
    await service.getSubscription(WS_A);
    await service.cancelSubscription(WS_A, true);
    await backdate(WS_A, 35);
    await service.getSubscription(WS_A);
    await db.prepare("UPDATE sub_subscriptions SET status = 'past_due' WHERE workspace_id = ?").bind(WS_A).run();
    await service.getSubscription(WS_A);
    await runPlanCreditSweep({ env: { DB: db }, options: CREDITS, controller: { scheduledTime: Date.now() } });
    expect(await balance(WS_A)).toBe(100_000);
    await db.prepare("UPDATE sub_subscriptions SET status = 'trialing' WHERE workspace_id = ?").bind(WS_A).run();
    await service.getSubscription(WS_A);
    expect(await balance(WS_A)).toBe(200_000);
  });

  it("a one_time plan grants once, whatever the period", async () => {
    const service = new PlanService(db, "free", { ...CREDITS, planCredits: "lifetime:50" });
    await service.createPlan("lifetime", "Lifetime", 0, "one_time");
    await service.subscribe(WS_A, "lifetime");
    await backdate(WS_A, 400);
    await service.getSubscription(WS_A);
    await runPlanCreditSweep({ env: { DB: db }, options: { ...CREDITS, planCredits: "lifetime:50" } });
    expect(await ledgerKeys(WS_A)).toEqual(["plan-credits:lifetime:0"]);
    expect(await balance(WS_A)).toBe(50_000);
  });

  it("with credits off (no setting or no charger) nothing is granted and the marker column is never written", async () => {
    for (const config of [{}, { charger }, { planCredits: "free:100" }, { charger, planCredits: "" }] as PlanCreditsConfig[]) {
      const service = new PlanService(db, "free", config);
      await service.getSubscription(WS_A);
      await service.subscribe(WS_A, "free");
      await runPlanCreditSweep({ env: { DB: db }, options: config });
    }
    expect(await balance(WS_A)).toBe(0);
    expect(await ledgerKeys(WS_A)).toEqual([]);
    expect(await marker(WS_A)).toBeNull();
  });

  it("a key already used with another amount (the setting changed mid-period) counts as granted, never as an error", async () => {
    await new PlanService(db, "free", CREDITS).getSubscription(WS_A);
    const changed = new PlanService(db, "free", { charger, planCredits: "free:250" });
    const sub = await changed.getSubscription(WS_A);
    expect(sub.plan_id).toBe("free");
    expect(await balance(WS_A)).toBe(100_000);
  });

  it("a workspace the registry does not know gets no wallet and no credits, and its read still answers", async () => {
    const sub = await new PlanService(db, "free", CREDITS).getSubscription("ws_unregistered");
    expect(sub.status).toBe("active");
    expect(await balance("ws_unregistered")).toBe(0);
  });

  it("the routes grant only to the workspace the guard resolved, whatever the request names", async () => {
    const app = new Hono<PlanEnv>();
    app.use("/api/*", async (c, next) => {
      // The guard resolved WS_A; every other workspace in the request is attacker input.
      c.set("workspace", { id: WS_A, role: "owner" });
      c.set("user", { uid: "alice" });
      c.set("ctx", { workspaceId: WS_A, userId: "alice", role: "owner" } as never);
      await next();
    });
    app.route("/api", createPlanRoutes({ defaultTier: "free", planCredits: "free:100,pro:1000", creditPeriod: "month", charger }));
    const headers = { "x-workspace-id": WS_B, "content-type": "application/json" };
    const reads = [
      new Request(`https://x.test/api/subscriptions/current?workspaceId=${WS_B}&workspace_id=${WS_B}`, { headers }),
      new Request("https://x.test/api/subscriptions/change", {
        method: "POST",
        headers,
        body: JSON.stringify({ planId: "free", workspaceId: WS_B, workspace_id: WS_B }),
      }),
    ];
    for (const req of reads) expect((await app.fetch(req, { DB: db })).status).toBe(200);
    expect(await balance(WS_A)).toBe(100_000);
    expect(await balance(WS_B)).toBe(0);
    expect(await ledgerKeys(WS_B)).toEqual([]);
  });
});

describe("the self-serve plan change cannot mint credits (story 1.20)", () => {
  /** WS_A's owner, through the real routes with credits on. */
  const ownerApp = () => {
    const app = new Hono<PlanEnv>();
    app.use("/api/*", async (c, next) => {
      c.set("workspace", { id: WS_A, role: "owner" });
      c.set("user", { uid: "alice" });
      c.set("ctx", { workspaceId: WS_A, userId: "alice", role: "owner" } as never);
      await next();
    });
    app.route("/api", createPlanRoutes({ defaultTier: "free", planCredits: "free:100,pro:1000,enterprise:5000", creditPeriod: "month", charger }));
    return app;
  };
  const change = (planId: string) =>
    ownerApp().fetch(
      new Request("https://x.test/api/subscriptions/change", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId }),
      }),
      { DB: db },
    );
  const planIds = async () => (await db.prepare("SELECT id FROM sub_plans ORDER BY id").all<{ id: string }>()).results.map((r) => r.id);

  it("an owner switching to a credited tier that has no plan row is refused: no grant, no plan row created", async () => {
    // The default tier needs no row: switching to it provisions it, as the lazy first read does.
    expect(await new PlanService(db, "free", CREDITS).changePlan(WS_B, "free")).toMatchObject({ ok: true });
    expect(await new PlanService(db, "free", CREDITS).changePlan(WS_B, "pro")).toMatchObject({ ok: false, status: 404, code: "PLAN_NOT_FOUND" });
    expect((await ownerApp().fetch(new Request("https://x.test/api/subscriptions/current"), { DB: db })).status).toBe(200);
    for (const planId of ["pro", "enterprise", " PRO "]) {
      const res = await change(planId);
      expect(res.status, planId).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe("PLAN_NOT_FOUND");
    }
    expect(await planIds()).toEqual(["free"]);
    expect(await ledgerKeys(WS_A)).toEqual(["plan-credits:free:0"]);
    expect(await balance(WS_A)).toBe(100_000);
    expect(await ledgerKeys(WS_B)).toEqual(["plan-credits:free:0"]);
  });

  it("cycling between tiers grants each existing tier once per period, nothing more", async () => {
    await new PlanService(db).createPlan("pro", "Pro", 0, "month"); // an operator-made zero-price plan
    for (const planId of ["pro", "free", "pro", "enterprise", "free", "pro"]) await change(planId);
    expect(await ledgerKeys(WS_A)).toEqual(["plan-credits:free:0", "plan-credits:pro:0"]); // free: the first read provisions it
    expect(await balance(WS_A)).toBe(1_100_000);
    expect(await planIds()).toEqual(["free", "pro"]);
  });

  it("once the period is granted, further reads (route, middleware, entitlements) make no grant call", async () => {
    let calls = 0;
    const counting: PlanCreditCharger = { grant: (...args) => ((calls += 1), walletCharger.grant(...args)) };
    const service = new PlanService(db, "free", { charger: counting, planCredits: "free:100" });
    await service.getSubscription(WS_A);
    expect(calls).toBe(1);
    await service.getSubscription(WS_A);
    await service.hasFeature(WS_A, "x");
    await service.getQuota(WS_A, "x");
    expect(calls).toBe(1);
    expect(await balance(WS_A)).toBe(100_000);
  });
});

describe("the per-minute sweep (story 1.20)", () => {
  it("grants the current period to due workspaces only, never creates a subscription, and is idempotent across runs", async () => {
    const service = new PlanService(db, "free", CREDITS);
    await service.getSubscription(WS_A);
    const first = await runPlanCreditSweep({ env: { DB: db }, options: CREDITS });
    expect(first).toEqual({ scanned: 0, granted: 0, alreadyGranted: 0, failed: 0 }); // A's period 0 is marked
    expect(await db.prepare("SELECT COUNT(*) AS n FROM sub_subscriptions").first<{ n: number }>()).toEqual({ n: 1 });

    const nextMonth = Date.now() + 35 * DAY;
    const run = () => runPlanCreditSweep({ env: { DB: db }, options: CREDITS, controller: { scheduledTime: nextMonth } });
    expect(await run()).toMatchObject({ scanned: 1, granted: 1 });
    expect(await run()).toMatchObject({ scanned: 0, granted: 0 });
    expect(await marker(WS_A)).toBe(1);
    // The read in the real (earlier) month finds period 0 already granted.
    await service.getSubscription(WS_A);
    expect(await balance(WS_A)).toBe(200_000);
    expect(await balance(WS_B)).toBe(0);
  });

  it("a cleared marker is only a rescan: the ledger key still grants once", async () => {
    const service = new PlanService(db, "free", CREDITS);
    await service.getSubscription(WS_A);
    await db.prepare("UPDATE sub_subscriptions SET credits_granted_period = NULL").run();
    expect(await runPlanCreditSweep({ env: { DB: db }, options: CREDITS })).toMatchObject({ scanned: 1, granted: 0, alreadyGranted: 1 });
    expect(await balance(WS_A)).toBe(100_000);
  });

  it(`handles at most ${PLAN_CREDIT_SWEEP_LIMIT} workspaces per run, never-granted first; a failed grant waits out its retry delay; uncredited plans are not scanned`, async () => {
    const ids = Array.from({ length: PLAN_CREDIT_SWEEP_LIMIT + 5 }, (_, i) => `ws_sweep_${String(i).padStart(3, "0")}`);
    for (const id of ids) {
      await registerWorkspace(id);
      await new PlanService(db).subscribe(id, "free"); // no credits config: provisioned, nothing granted
    }
    await new PlanService(db).createPlan("enterprise", "Enterprise", 0, "month");
    await new PlanService(db).subscribe(WS_A, "enterprise"); // a plan without credits is not scanned
    await db.prepare("UPDATE mw_workspaces SET suspended = 1 WHERE id = ?").bind(ids[0]).run();
    const firstRun = await runPlanCreditSweep({ env: { DB: db }, options: CREDITS });
    expect(firstRun.scanned).toBe(PLAN_CREDIT_SWEEP_LIMIT);
    expect(firstRun.granted).toBe(PLAN_CREDIT_SWEEP_LIMIT - 1);
    expect(firstRun.failed).toBe(1); // suspended with no wallet: credit-wallet opens none
    const secondRun = await runPlanCreditSweep({ env: { DB: db }, options: CREDITS });
    expect(secondRun).toEqual({ scanned: 5, granted: 5, alreadyGranted: 0, failed: 0 }); // the failed one is waiting to retry
    expect(await marker(ids[0]!)).toBeNull();
    expect(await balance(ids[0]!)).toBe(0);
    expect(await balance(ids[1]!)).toBe(100_000);
    expect(await balance(ids.at(-1)!)).toBe(100_000);
    expect(await balance(WS_A)).toBe(0);
  });

  it("a workspace whose grant fails is not marked, is retried after the delay, and is granted once grantable", async () => {
    await new PlanService(db).subscribe("ws_late", "free"); // not in the registry: credit-wallet opens it no wallet
    const at = (offsetMs: number) => runPlanCreditSweep({ env: { DB: db }, options: CREDITS, controller: { scheduledTime: Date.now() + offsetMs } });
    expect(await at(0)).toMatchObject({ scanned: 1, granted: 0, failed: 1 });
    expect(await marker("ws_late")).toBeNull();
    expect(await at(60_000)).toMatchObject({ scanned: 0 }); // waiting out the retry delay
    await registerWorkspace("ws_late");
    expect(await at(PLAN_CREDIT_RETRY_DELAY_MS + 60_000)).toMatchObject({ scanned: 1, granted: 1, failed: 0 });
    expect(await marker("ws_late")).toBe(0);
    expect(await db.prepare("SELECT credits_retry_after AS r FROM sub_subscriptions WHERE workspace_id = 'ws_late'").first<{ r: string | null }>()).toEqual({
      r: null,
    });
    expect(await balance("ws_late")).toBe(100_000);
  });
});
