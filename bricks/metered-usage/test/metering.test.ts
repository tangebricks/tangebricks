import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_metered_usage.sql?raw";
import migration0002 from "../migrations/0002_workspace_scoped_idempotency.sql?raw";
import {
  MeteringService,
  createMeteringRoutes,
  meterRoute,
  getCurrentWindow,
} from "../src/index.ts";
import type { MeterEnv } from "../src/middleware.ts";
import { stubWorkspaceContext } from "../../multi-workspace/test/support/stub-workspace-context.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_meter_alpha";
const WS_BETA = "ws_meter_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS meter_aggregates").run();
  await db.prepare("DROP TABLE IF EXISTS meter_events").run();
  await db.prepare("DROP TABLE IF EXISTS meter_definitions").run();
  await applyMigration(db, migration);
  await applyMigration(db, migration0002);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Metering Service Core Logic", () => {
  it("registers meters and lists them", async () => {
    const service = new MeteringService(db);
    const m1 = await service.defineMeter("api_calls", "API Requests Counter", "count");
    const m2 = await service.defineMeter("compute_ms", "Serverless Compute Duration", "sum");

    expect(m1.key).toBe("api_calls");
    expect(m1.aggregation).toBe("count");
    expect(m2.key).toBe("compute_ms");

    const list = await service.listMeters();
    expect(list).toHaveLength(2);
    expect(list.map((m) => m.key)).toEqual(["api_calls", "compute_ms"]);
  });

  it("accumulates events with sum and count aggregations", async () => {
    const service = new MeteringService(db);
    await service.defineMeter("storage_mb", "Storage Usage", "sum");

    const w = getCurrentWindow();
    await service.ingestEvent({ workspaceId: WS_ALPHA, meterKey: "storage_mb", value: 100 });
    await service.ingestEvent({ workspaceId: WS_ALPHA, meterKey: "storage_mb", value: 250 });
    await service.ingestEvent({ workspaceId: WS_ALPHA, meterKey: "storage_mb", value: 50 });

    const usage = await service.getUsage(WS_ALPHA, "storage_mb", w);
    expect(usage.total_value).toBe(400);
    expect(usage.event_count).toBe(3);
  });

  it("handles max and last aggregation strategies correctly", async () => {
    const service = new MeteringService(db);
    await service.defineMeter("peak_concurrency", "Peak Connections", "max");
    await service.defineMeter("active_seats", "Active Seat Count", "last");

    const w = getCurrentWindow();

    // Max testing: 10 -> 45 -> 30 => max is 45
    await service.ingestEvent({ workspaceId: WS_ALPHA, meterKey: "peak_concurrency", value: 10 });
    await service.ingestEvent({ workspaceId: WS_ALPHA, meterKey: "peak_concurrency", value: 45 });
    await service.ingestEvent({ workspaceId: WS_ALPHA, meterKey: "peak_concurrency", value: 30 });

    const maxUsage = await service.getUsage(WS_ALPHA, "peak_concurrency", w);
    expect(maxUsage.total_value).toBe(45);
    expect(maxUsage.event_count).toBe(3);

    // Last testing: 5 -> 12 -> 8 => last is 8
    await service.ingestEvent({ workspaceId: WS_ALPHA, meterKey: "active_seats", value: 5 });
    await service.ingestEvent({ workspaceId: WS_ALPHA, meterKey: "active_seats", value: 12 });
    await service.ingestEvent({ workspaceId: WS_ALPHA, meterKey: "active_seats", value: 8 });

    const lastUsage = await service.getUsage(WS_ALPHA, "active_seats", w);
    expect(lastUsage.total_value).toBe(8);
    expect(lastUsage.event_count).toBe(3);
  });

  it("safely ignores duplicate events with idempotency keys", async () => {
    const service = new MeteringService(db);
    await service.defineMeter("charge_units", "Billable Units", "sum");

    const w = getCurrentWindow();
    const idemKey = "idempotent_order_998877";

    const res1 = await service.ingestEvent({
      workspaceId: WS_ALPHA,
      meterKey: "charge_units",
      value: 50,
      idempotencyKey: idemKey,
    });
    expect(res1.ok).toBe(true);
    expect(res1.duplicate).toBe(false);

    // Duplicate call with same key
    const res2 = await service.ingestEvent({
      workspaceId: WS_ALPHA,
      meterKey: "charge_units",
      value: 50,
      idempotencyKey: idemKey,
    });
    expect(res2.ok).toBe(true);
    expect(res2.duplicate).toBe(true);

    // Verify usage was only counted once
    const usage = await service.getUsage(WS_ALPHA, "charge_units", w);
    expect(usage.total_value).toBe(50);
    expect(usage.event_count).toBe(1);
  });

  // METER_KEY_REUSE (story 0.7): idempotency keys are per workspace, so B's key never swallows A's usage.
  it("records A's usage when A reuses an idempotency key that B already used", async () => {
    const service = new MeteringService(db);
    await service.defineMeter("charge_units", "Billable Units", "sum");
    const w = getCurrentWindow();

    const b = await service.ingestEvent({ workspaceId: WS_BETA, meterKey: "charge_units", value: 7, idempotencyKey: "u1" });
    const a = await service.ingestEvent({ workspaceId: WS_ALPHA, meterKey: "charge_units", value: 50, idempotencyKey: "u1" });
    expect(b).toMatchObject({ ok: true, duplicate: false });
    expect(a).toMatchObject({ ok: true, duplicate: false });
    expect(a.eventId).not.toBe(b.eventId);

    expect((await service.getUsage(WS_ALPHA, "charge_units", w)).total_value).toBe(50);
    expect((await service.getUsage(WS_BETA, "charge_units", w)).total_value).toBe(7);

    // The same key again in A is A's duplicate, answered with A's own event.
    const again = await service.ingestEvent({ workspaceId: WS_ALPHA, meterKey: "charge_units", value: 50, idempotencyKey: "u1" });
    expect(again).toEqual({ ok: true, duplicate: true, eventId: a.eventId });
    expect((await service.getUsage(WS_ALPHA, "charge_units", w)).event_count).toBe(1);
  });

  // MIGRATION_PRESERVES (story 0.7): 0002 rebuilds meter_events and keeps every row, CHECK and index.
  it("keeps every usage event written under 0001 when 0002 rebuilds the table", async () => {
    await db.prepare("DROP TABLE IF EXISTS meter_aggregates").run();
    await db.prepare("DROP TABLE IF EXISTS meter_events").run();
    await db.prepare("DROP TABLE IF EXISTS meter_definitions").run();
    await applyMigration(db, migration);

    const service = new MeteringService(db);
    await service.defineMeter("calls", "Calls", "count");
    await service.ingestEvent({ workspaceId: WS_ALPHA, meterKey: "calls", idempotencyKey: "k-a", metadata: { route: "/x" } });
    await service.ingestEvent({ workspaceId: WS_BETA, meterKey: "calls", idempotencyKey: "k-b" });
    await service.ingestEvent({ workspaceId: WS_BETA, meterKey: "calls" });
    const before = (await db.prepare("SELECT * FROM meter_events ORDER BY rowid").all()).results;
    const aggregatesBefore = (await db.prepare("SELECT * FROM meter_aggregates ORDER BY workspace_id").all()).results;
    expect(before).toHaveLength(3);

    await applyMigration(db, migration0002);

    expect((await db.prepare("SELECT * FROM meter_events ORDER BY rowid").all()).results).toEqual(before);
    expect((await db.prepare("SELECT * FROM meter_aggregates ORDER BY workspace_id").all()).results).toEqual(aggregatesBefore);
    const indexes = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'meter_events'").all<{ name: string }>();
    expect(indexes.results.map((r) => r.name)).toContain("meter_events_ws_time_idx");
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE name = 'meter_events_v2'").first()).toBeNull();
    // The length CHECK survived the rebuild.
    await expect(
      db.prepare("INSERT INTO meter_events (id, workspace_id, meter_key, idempotency_key) VALUES ('e1', ?, 'calls', ?)").bind(WS_ALPHA, "x".repeat(129)).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    // Old keys deduplicate in their own workspace and are free in the other.
    expect(await service.ingestEvent({ workspaceId: WS_ALPHA, meterKey: "calls", idempotencyKey: "k-a" })).toMatchObject({ ok: true, duplicate: true });
    expect(await service.ingestEvent({ workspaceId: WS_BETA, meterKey: "calls", idempotencyKey: "k-a" })).toMatchObject({ ok: true, duplicate: false });
  });

  it("strictly isolates usage counters between workspaces", async () => {
    const service = new MeteringService(db);
    await service.defineMeter("tokens", "AI Tokens", "sum");

    const w = getCurrentWindow();
    await service.ingestEvent({ workspaceId: WS_ALPHA, meterKey: "tokens", value: 1000 });
    await service.ingestEvent({ workspaceId: WS_BETA, meterKey: "tokens", value: 5000 });

    const alpha = await service.getUsage(WS_ALPHA, "tokens", w);
    const beta = await service.getUsage(WS_BETA, "tokens", w);

    expect(alpha.total_value).toBe(1000);
    expect(beta.total_value).toBe(5000);
  });
});

describe("Metering correctness (story 1.9)", () => {
  it("refuses negative and non-finite values and writes nothing", async () => {
    const service = new MeteringService(db);
    await service.defineMeter("credits_used", "Credits used", "sum");
    for (const bad of [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, 1e13, null as unknown as number]) {
      const res = await service.ingestEvent({ workspaceId: WS_ALPHA, meterKey: "credits_used", value: bad });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/INVALID_VALUE/);
    }
    const usage = await service.getUsage(WS_ALPHA, "credits_used");
    expect(usage.total_value).toBe(0);
    expect(usage.event_count).toBe(0);
    const events = await db.prepare("SELECT count(*) AS n FROM meter_events").first<{ n: number }>();
    expect(events?.n).toBe(0);
  });

  it("totals exactly under 50 concurrent events (sum and count)", async () => {
    const service = new MeteringService(db);
    await service.defineMeter("tokens", "Tokens", "sum");
    await service.defineMeter("calls", "Calls", "count");
    const at = new Date().toISOString();
    const window = getCurrentWindow(new Date(at));
    await Promise.all([
      ...Array.from({ length: 50 }, (_, i) => service.ingestEvent({ workspaceId: WS_ALPHA, meterKey: "tokens", value: (i % 5) + 1, timestamp: at })),
      ...Array.from({ length: 50 }, () => service.ingestEvent({ workspaceId: WS_ALPHA, meterKey: "calls", timestamp: at })),
    ]);
    const tokens = await service.getUsage(WS_ALPHA, "tokens", window);
    const calls = await service.getUsage(WS_ALPHA, "calls", window);
    expect(tokens.event_count).toBe(50);
    expect(tokens.total_value).toBe(150); // ten rounds of 1+2+3+4+5
    expect(calls.event_count).toBe(50);
    expect(calls.total_value).toBe(50);
  });

  it("a concurrent duplicate idempotency key counts once", async () => {
    const service = new MeteringService(db);
    await service.defineMeter("jobs", "Jobs", "sum");
    const results = await Promise.all(
      Array.from({ length: 10 }, () => service.ingestEvent({ workspaceId: WS_ALPHA, meterKey: "jobs", value: 7, idempotencyKey: "job-1" })),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.duplicate === true)).toHaveLength(9);
    const usage = await service.getUsage(WS_ALPHA, "jobs");
    expect(usage.event_count).toBe(1);
    expect(usage.total_value).toBe(7);
  });

  it("the HTTP route refuses a negative value with 400", async () => {
    const service = new MeteringService(db);
    await service.defineMeter("credits_used", "Credits used", "sum");
    const app = new Hono<MeterEnv>();
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createMeteringRoutes());
    const res = await app.request("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({ meterKey: "credits_used", value: -5 }),
    }, { DB: db });
    expect(res.status).toBe(400);
    expect((await service.getUsage(WS_ALPHA, "credits_used")).total_value).toBe(0);
  });
});

describe("Metering HTTP API & Route Middleware", () => {
  it("defines meters, ingests events, and queries usage via HTTP", async () => {
    const app = new Hono<MeterEnv>();
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createMeteringRoutes());

    // 1. Define meter
    const defineRes = await app.request("/api/meters", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA, "x-test-user": "op_meters" },
      body: JSON.stringify({
        key: "webhook_dispatches",
        name: "Webhook Outbound Dispatches",
        aggregation: "sum",
      }),
    }, { DB: db, PX_PLATFORM_OPERATORS: "op_meters" });
    expect(defineRes.status).toBe(201);

    // 2. Ingest event
    const ingestRes = await app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({
        meterKey: "webhook_dispatches",
        value: 12,
        idempotencyKey: "evt_test_101",
      }),
    }, { DB: db });
    expect(ingestRes.status).toBe(201);

    // 3. Query usage
    const usageRes = await app.request("/api/usage", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(usageRes.status).toBe(200);
    const usageJson = (await usageRes.json()) as { usage: Array<{ meter_key: string; total_value: number }> };
    expect(usageJson.usage).toHaveLength(1);
    expect(usageJson.usage[0].meter_key).toBe("webhook_dispatches");
    expect(usageJson.usage[0].total_value).toBe(12);
  });

  it("automatically meters decorated routes on 2xx responses", async () => {
    const service = new MeteringService(db);
    await service.defineMeter("api_hits", "API Hits", "count");

    const app = new Hono<MeterEnv>();
    app.use("*", async (c, next) => {
      c.set("workspace", { id: WS_ALPHA, role: "member" });
      await next();
    });
    app.get("/items", meterRoute("api_hits"), (c) => {
      return c.json({ items: ["item_1", "item_2"] });
    });

    const res = await app.request("/items", {}, { DB: db });
    expect(res.status).toBe(200);

    const w = getCurrentWindow();
    const usage = await service.getUsage(WS_ALPHA, "api_hits", w);
    expect(usage.total_value).toBe(1);
    expect(usage.event_count).toBe(1);
  });
});

describe("Metering authorisation (story 0.6)", () => {
  function app(): Hono<MeterEnv> {
    const a = new Hono<MeterEnv>();
    a.use("/api/*", stubWorkspaceContext);
    a.route("/api", createMeteringRoutes());
    return a;
  }
  const define = (headers: Record<string, string>) => ({
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ key: "global_meter", name: "Global meter", aggregation: "sum" }),
  });
  async function meterCount(): Promise<number> {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM meter_definitions").first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  it("OPERATOR_WRITE: a listed operator defines a meter (201)", async () => {
    const res = await app().request("/api/meters", define({ "x-workspace-id": WS_ALPHA, "x-test-user": "op_1", "x-test-role": "member" }), { DB: db, PX_PLATFORM_OPERATORS: "op_1" });
    expect(res.status).toBe(201);
    expect(await meterCount()).toBe(1);
  });

  it("NON_OPERATOR_WRITE: a workspace owner not in the list is refused (403)", async () => {
    const res = await app().request("/api/meters", define({ "x-workspace-id": WS_ALPHA, "x-test-user": "owner_1", "x-test-role": "owner" }), { DB: db, PX_PLATFORM_OPERATORS: "op_1" });
    expect(res.status).toBe(403);
    expect(await meterCount()).toBe(0);
  });

  it("NO_OPERATORS_CONFIGURED: with no env value nobody may define a meter", async () => {
    const res = await app().request("/api/meters", define({ "x-workspace-id": WS_ALPHA, "x-test-user": "op_1" }), { DB: db });
    expect(res.status).toBe(403);
    expect(await meterCount()).toBe(0);
  });

  it("UNAUTH_ADMIN: no user gets 401", async () => {
    const res = await app().request("/api/meters", define({}), { DB: db, PX_PLATFORM_OPERATORS: "op_1" });
    expect(res.status).toBe(401);
    expect(await meterCount()).toBe(0);
  });
});
