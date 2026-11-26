// Story 1.20: plan credits in a real assembled app (test/support/blueprints.ts PLAN_CREDITS_BLUEPRINT: subscription-plans
// with planCredits "free:100,pro:1000" beside credit-wallet), in workerd. The assembler hands the brick credit-wallet's
// walletCharger through route and schedule options; the brick grants once per period on read and from scheduled().
//
//   - a new free workspace gets exactly 100 credits on its first subscription read, also under five concurrent reads;
//   - with the clock in the next month, two sweeps and a read add exactly 100 more;
//   - cross-workspace: Alice (workspace A) names workspace B in a header, the query or the body; B's wallet never moves.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import type { D1Like } from "@poc/sdk";
import { call, resetAndMigrate } from "./support/assembled-app.ts";
import type { App } from "./support/assembled-app.ts";

type AssembledApp = App & { scheduled(controller: { scheduledTime?: number; cron?: string }, env: unknown, ctx?: unknown): Promise<void> };
const entryLoaders = import.meta.glob("../../../out/plan-credits/src/index.ts") as Record<string, () => Promise<{ default: AssembledApp }>>;
const app = (await Object.values(entryLoaders)[0]?.())?.default;
const sql = import.meta.glob("../../../out/plan-credits/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const db = env.DB as unknown as D1Like;
const DAY = 86_400_000;

type Reply = { status: number; json: Record<string, any> };
async function api(method: string, path: string, opts: { user?: string; ws?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const res = await call(app!, method, path, opts);
  return { status: res.status, json: JSON.parse(res.text || "{}") as Record<string, any> };
}

const balanceMilli = async (ws: string) =>
  (await db.prepare("SELECT balance_milli FROM credit_wallets WHERE workspace_id = ?").bind(ws).first<{ balance_milli: number }>())?.balance_milli ?? 0;
const ledger = async (ws: string) =>
  (await db.prepare("SELECT idempotency_key, amount_milli FROM credit_ledger WHERE workspace_id = ? ORDER BY rowid").bind(ws).all<{ idempotency_key: string; amount_milli: number }>()).results;

async function workspaceOf(user: string): Promise<string> {
  const created = await api("POST", "/api/workspaces", { user, body: { name: `${user}'s` } });
  expect(created.status).toBe(201);
  return created.json.workspace.id as string;
}

describe("plan credits in an assembled app (story 1.20)", () => {
  test("the app is wired: the charger in the route and the per-minute schedule", async () => {
    expect(app, "out/plan-credits/src/index.ts was not assembled").toBeDefined();
    expect(typeof app!.scheduled).toBe("function");
    const entry = Object.values(import.meta.glob("../../../out/plan-credits/src/index.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>)[0]!;
    expect(entry).toContain('createPlanRoutes({ defaultTier: "free", planCredits: "free:100,pro:1000", creditPeriod: "month", charger: walletCharger })');
    expect(entry).toContain('options: { planCredits: "free:100,pro:1000", creditPeriod: "month", charger: walletCharger } });');
  });

  test("a new free workspace is credited exactly 100 once on its first read, under five concurrent reads", async () => {
    await resetAndMigrate(db, sql);
    const wsA = await workspaceOf("alice");
    const reads = await Promise.all(Array.from({ length: 5 }, () => api("GET", "/api/subscriptions/current", { user: "alice", ws: wsA })));
    for (const r of reads) {
      expect(r.status).toBe(200);
      expect(r.json.subscription).toMatchObject({ workspace_id: wsA, plan_id: "free", status: "active" });
    }
    expect(await balanceMilli(wsA)).toBe(100_000);
    expect((await api("GET", "/api/wallet", { user: "alice", ws: wsA })).json.currentBalanceMilli).toBe(100_000);
    for (let i = 0; i < 3; i += 1) await api("GET", "/api/subscriptions/current", { user: "alice", ws: wsA });
    await app!.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" }, env);
    expect(await ledger(wsA)).toEqual([{ idempotency_key: "plan-credits:free:0", amount_milli: 100_000 }]);
  });

  test("with the clock in the next month, two sweeps and a read add exactly 100 more", async () => {
    await resetAndMigrate(db, sql);
    const wsA = await workspaceOf("alice");
    expect((await api("GET", "/api/subscriptions/current", { user: "alice", ws: wsA })).status).toBe(200);
    const created = (await db.prepare("SELECT created_at FROM sub_subscriptions WHERE workspace_id = ?").bind(wsA).first<{ created_at: string }>())!.created_at;
    const nextMonth = Date.parse(created) + 35 * DAY;
    await app!.scheduled({ scheduledTime: nextMonth, cron: "* * * * *" }, env);
    await app!.scheduled({ scheduledTime: nextMonth + 60_000, cron: "* * * * *" }, env);
    expect((await api("GET", "/api/subscriptions/current", { user: "alice", ws: wsA })).status).toBe(200);
    expect(await balanceMilli(wsA)).toBe(200_000);
    expect((await ledger(wsA)).map((r) => r.idempotency_key)).toEqual(["plan-credits:free:0", "plan-credits:free:1"]);

    // The lazy path renews too: a subscription that started over a month ago gains one more period on its next read.
    const wsC = await workspaceOf("carol");
    await api("GET", "/api/subscriptions/current", { user: "carol", ws: wsC });
    await db.prepare("UPDATE sub_subscriptions SET created_at = ? WHERE workspace_id = ?").bind(new Date(Date.now() - 35 * DAY).toISOString(), wsC).run();
    await Promise.all([1, 2, 3].map(() => api("GET", "/api/subscriptions/current", { user: "carol", ws: wsC })));
    await app!.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" }, env);
    expect(await balanceMilli(wsC)).toBe(200_000);
  });

  test("a canceled subscription is not renewed by the sweep or a read", async () => {
    await resetAndMigrate(db, sql);
    const wsA = await workspaceOf("alice");
    await api("GET", "/api/subscriptions/current", { user: "alice", ws: wsA });
    expect((await api("POST", "/api/subscriptions/cancel", { user: "alice", ws: wsA, body: { immediately: true } })).status).toBe(200);
    await app!.scheduled({ scheduledTime: Date.now() + 35 * DAY, cron: "* * * * *" }, env);
    await db.prepare("UPDATE sub_subscriptions SET created_at = ? WHERE workspace_id = ?").bind(new Date(Date.now() - 35 * DAY).toISOString(), wsA).run();
    await api("GET", "/api/subscriptions/current", { user: "alice", ws: wsA });
    expect(await balanceMilli(wsA)).toBe(100_000);
  });

  test("cross-workspace: requests in A that name B in a header, the query or the body never credit B", async () => {
    await resetAndMigrate(db, sql);
    const wsA = await workspaceOf("alice");
    const wsB = await workspaceOf("bob");
    const smuggled = { workspaceId: wsB, workspace_id: wsB };
    const query = `?workspaceId=${wsB}&workspace_id=${wsB}`;

    // Header B: Alice is no member of B, so the guard refuses before the brick runs.
    for (const [method, path, body] of [
      ["GET", "/api/subscriptions/current", undefined],
      ["POST", "/api/subscriptions/change", { planId: "free" }],
      ["POST", "/api/subscriptions/cancel", { immediately: false }],
    ] as const) {
      const refused = await api(method, path, { user: "alice", ws: wsB, ...(body ? { body } : {}) });
      expect(refused.status, `${method} ${path} with header B`).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
    }
    // Header A with B in the query and the body: served for A only.
    expect((await api("GET", `/api/subscriptions/current${query}`, { user: "alice", ws: wsA })).json.subscription.workspace_id).toBe(wsA);
    expect((await api("POST", `/api/subscriptions/change${query}`, { user: "alice", ws: wsA, body: { planId: "free", ...smuggled } })).status).toBe(200);
    expect((await api("GET", `/api/plans${query}`, { user: "alice", ws: wsB })).status).toBe(200); // the global catalog, no workspace
    // Two workspace headers, a header naming B with an A body, and no header at all.
    expect((await api("GET", "/api/subscriptions/current", { user: "alice", headers: { "x-workspace-id": `${wsA},${wsB}` } })).status).toBeGreaterThanOrEqual(400);
    expect((await api("GET", `/api/subscriptions/current${query}`, { user: "alice" })).status).toBeGreaterThanOrEqual(400);
    await app!.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" }, env);

    expect(await balanceMilli(wsA)).toBe(100_000);
    expect(await balanceMilli(wsB)).toBe(0);
    expect(await ledger(wsB)).toEqual([]);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM sub_subscriptions WHERE workspace_id = ?").bind(wsB).first<{ n: number }>()).toEqual({ n: 0 });

    // B's own owner reading B is what credits B, once.
    await api("GET", "/api/subscriptions/current", { user: "bob", ws: wsB });
    expect(await balanceMilli(wsB)).toBe(100_000);
    expect(await balanceMilli(wsA)).toBe(100_000);
  });

  test("an owner cannot mint credits by switching to a tier that has no plan row, or by cycling tiers", async () => {
    await resetAndMigrate(db, sql);
    const wsA = await workspaceOf("alice");
    await api("GET", "/api/subscriptions/current", { user: "alice", ws: wsA });
    for (const planId of ["pro", "PRO", "enterprise"]) {
      const refused = await api("POST", "/api/subscriptions/change", { user: "alice", ws: wsA, body: { planId } });
      expect(refused.status, planId).toBe(404);
      expect(refused.json.code).toBe("PLAN_NOT_FOUND");
    }
    for (const planId of ["free", "pro", "free", "pro"]) await api("POST", "/api/subscriptions/change", { user: "alice", ws: wsA, body: { planId } });
    expect((await db.prepare("SELECT id FROM sub_plans").all<{ id: string }>()).results.map((r) => r.id)).toEqual(["free"]);
    expect(await ledger(wsA)).toEqual([{ idempotency_key: "plan-credits:free:0", amount_milli: 100_000 }]);
  });
});

