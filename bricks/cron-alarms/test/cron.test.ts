import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { assemble } from "@poc/assembler";
import { catalog } from "@poc/assembler/catalog";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import shellWorker from "../../../out/max-compatible/src/index.ts";
import migration from "../migrations/0001_cron_alarms.sql?raw";
import { createScheduleRoutes, CronService, validateCron, computeNextRun } from "../src/index.ts";
import type { CronEnv } from "../src/routes.ts";

const db = env.DB as D1Like;
const WS_A = "ws_cron_alpha";
const WS_B = "ws_cron_beta";

async function resetDb(): Promise<void> {
  for (const table of ["cron_history", "cron_schedules"]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Cron Validation & Next Run Calculation", () => {
  it("validates standard 5-part cron expressions correctly", () => {
    expect(validateCron("*/5 * * * *")).toBe(true);
    expect(validateCron("0 12 * * 1-5")).toBe(true);
    expect(validateCron("0 0 1 1 *")).toBe(true);

    // Invalid formats
    expect(validateCron("invalid")).toBe(false);
    expect(validateCron("* * *")).toBe(false); // only 3 fields
    expect(validateCron("99 * * * *")).toBe(false); // minute out of range
  });

  it("computes next run timestamp accurately", () => {
    const base = new Date("2026-10-25T10:02:00Z");
    const next = computeNextRun("*/5 * * * *", base);
    expect(next.getUTCMinutes()).toBe(5);
    expect(next.getUTCSeconds()).toBe(0);
  });
});

describe("Cron Service & Distributed Alarms Engine", () => {
  it("creates schedule, advances next_run_at, and records execution history", async () => {
    // A test workflow binding injected explicitly (story 0.9: a missing binding is a failure, not a success).
    const started: Array<{ id: string }> = [];
    const service = new CronService(db, 50, { wf_sync_123: { create: async (o: { id: string }) => { started.push(o); } } });
    const created = await service.createSchedule(WS_A, "*/5 * * * *", {
      targetWorkflowId: "wf_sync_123",
      timezone: "UTC",
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.schedule.cron_expression).toBe("*/5 * * * *");
    expect(created.schedule.target_workflow_id).toBe("wf_sync_123");
    expect(created.schedule.active).toBe(true);

    // Artificially set next_run_at to the past to test triggering
    const pastTime = new Date(Date.now() - 60000).toISOString();
    await db.prepare("UPDATE cron_schedules SET next_run_at = ? WHERE id = ?").bind(pastTime, created.schedule.id).run();

    // Trigger due schedules
    const triggered = await service.triggerDueSchedules(new Date());
    expect(triggered).toHaveLength(1);
    expect(triggered[0].schedule_id).toBe(created.schedule.id);
    expect(triggered[0].status).toBe("success");

    // Verify next_run_at was advanced and history logged in D1
    const updated = await service.getSchedule(WS_A, created.schedule.id);
    expect(new Date(updated!.next_run_at).getTime()).toBeGreaterThan(Date.now());

    const history = await service.getHistory(WS_A, created.schedule.id);
    expect(history).toHaveLength(1);
    expect(history[0].response_summary).toContain("wf_sync_123");
    expect(started).toHaveLength(1);
  });

  it("CRON_NO_BINDING: a workflow target with no binding is recorded as a failure, not a success (story 0.9, B14)", async () => {
    const service = new CronService(db);
    const created = await service.createSchedule(WS_A, "*/5 * * * *", { targetWorkflowId: "wf_unbound", timezone: "UTC" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const pastTime = new Date(Date.now() - 60000).toISOString();
    await db.prepare("UPDATE cron_schedules SET next_run_at = ? WHERE id = ?").bind(pastTime, created.schedule.id).run();

    const triggered = await service.triggerDueSchedules(new Date());
    expect(triggered).toHaveLength(1);
    expect(triggered[0].status).toBe("failure");
    const history = await service.getHistory(WS_A, created.schedule.id);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("failure");
    expect(history[0].response_summary).toMatch(/^NOT_CONFIGURED: no workflow binding for wf_unbound/);
  });

  it("ignores inactive schedules during trigger sweeps", async () => {
    const service = new CronService(db);
    const created = await service.createSchedule(WS_A, "*/5 * * * *", {
      targetUrl: "https://api.example.com/ping",
    });
    if (!created.ok) return;

    // Deactivate schedule
    await service.toggleSchedule(WS_A, created.schedule.id, false);

    // Set next_run_at to the past
    const pastTime = new Date(Date.now() - 60000).toISOString();
    await db.prepare("UPDATE cron_schedules SET next_run_at = ? WHERE id = ?").bind(pastTime, created.schedule.id).run();

    // Trigger sweeps should ignore it
    const triggered = await service.triggerDueSchedules(new Date());
    expect(triggered).toHaveLength(0);
  });

  it("SSRF: refuses an internal-address target URL and records the run as failed with the guard code", async () => {
    const calls: string[] = [];
    const fetcher = async (url: string | URL): Promise<Response> => {
      calls.push(String(url));
      return new Response("metadata secrets", { status: 200 });
    };
    const service = new CronService(db, 50, undefined, fetcher, { resolveHost: async () => ["93.184.216.34"] });
    const created = await service.createSchedule(WS_A, "*/5 * * * *", {
      targetUrl: "http://169.254.169.254/latest/meta-data/",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const pastTime = new Date(Date.now() - 60000).toISOString();
    await db.prepare("UPDATE cron_schedules SET next_run_at = ? WHERE id = ?").bind(pastTime, created.schedule.id).run();

    const triggered = await service.triggerDueSchedules(new Date());
    expect(triggered).toHaveLength(1);
    expect(calls).toHaveLength(0);
    expect(triggered[0]!.status).toBe("failure");
    expect(triggered[0]!.response_summary).toMatch(/^EGRESS_FORBIDDEN/);
    const history = await service.getHistory(WS_A, created.schedule.id);
    expect(history[0]!.status).toBe("failure");
    expect(history[0]!.response_summary).toMatch(/^EGRESS_FORBIDDEN/);
  });

  it("records only the status code (no upstream text) when a URL target fails", async () => {
    const fetcher = async (): Promise<Response> =>
      new Response("stack trace from internal service", { status: 503, statusText: "db 10.0.0.9 down" });
    const service = new CronService(db, 50, undefined, fetcher, { resolveHost: async () => ["93.184.216.34"] });
    const created = await service.createSchedule(WS_A, "*/5 * * * *", { targetUrl: "https://example.com/tick" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const pastTime = new Date(Date.now() - 60000).toISOString();
    await db.prepare("UPDATE cron_schedules SET next_run_at = ? WHERE id = ?").bind(pastTime, created.schedule.id).run();

    const triggered = await service.triggerDueSchedules(new Date());
    expect(triggered[0]!.status).toBe("failure");
    expect(triggered[0]!.response_summary).toBe("HTTP 503");
  });

  it("enforces multi-tenant isolation: Workspace B cannot see or modify Workspace A schedules", async () => {
    const service = new CronService(db);
    const created = await service.createSchedule(WS_A, "0 0 * * *", { targetUrl: "https://alpha.internal/cron" });
    if (!created.ok) return;

    // Workspace B cannot view
    expect(await service.getSchedule(WS_B, created.schedule.id)).toBeNull();

    // Workspace B cannot toggle
    const toggled = await service.toggleSchedule(WS_B, created.schedule.id, false);
    expect(toggled).toBe(false);

    // Workspace B cannot delete
    const deleted = await service.deleteSchedule(WS_B, created.schedule.id);
    expect(deleted).toBe(false);

    // Workspace A can still view
    expect(await service.getSchedule(WS_A, created.schedule.id)).not.toBeNull();
  });
});

describe("Cron Route Handlers (/api/schedules/*)", () => {
  const createApp = (wsId = WS_A, role: string | null = "owner") => {
    const app = new Hono<CronEnv>();

    // Mock workspace & user context (role null = nobody signed in)
    app.use("*", async (c, next) => {
      if (role) {
        c.set("workspace", { id: wsId, role });
        c.set("user", { uid: "usr_alice", email: "alice@test.com" });
        c.set("ctx", Object.freeze({ userId: "usr_alice", workspaceId: wsId, role }));
      }
      await next();
    });

    app.route("/api", createScheduleRoutes());
    return app;
  };

  it("POST /api/schedules -> creates schedule and returns 201", async () => {
    const app = createApp(WS_A);
    const res = await app.fetch(
      new Request("http://localhost/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cronExpression: "*/15 * * * *",
          targetUrl: "https://api.test.com/task",
        }),
      }),
      { DB: db }
    );

    expect(res.status).toBe(201);
    const json = (await res.json()) as { schedule: { id: string; cron_expression: string } };
    expect(json.schedule.cron_expression).toBe("*/15 * * * *");
    expect(json.schedule.id).toBeDefined();

    // Toggle active via PATCH /api/schedules/:id
    const patchRes = await app.fetch(
      new Request(`http://localhost/api/schedules/${json.schedule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
      }),
      { DB: db }
    );
    expect(patchRes.status).toBe(200);

    // Delete via DELETE /api/schedules/:id
    const deleteRes = await app.fetch(
      new Request(`http://localhost/api/schedules/${json.schedule.id}`, { method: "DELETE" }),
      { DB: db }
    );
    expect(deleteRes.status).toBe(200);
  });

  it("story 0.6: no user gets 401 and a plain member 403 (not 400) on create/toggle/delete; admin may; rows unchanged", async () => {
    const service = new CronService(db);
    const created = await service.createSchedule(WS_A, "*/5 * * * *", { targetUrl: "https://api.test.com/x" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.schedule.id;
    const createReq = (body: string) =>
      new Request("http://localhost/api/schedules", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    const patchReq = () =>
      new Request(`http://localhost/api/schedules/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: false }) });
    const deleteReq = () => new Request(`http://localhost/api/schedules/${id}`, { method: "DELETE" });

    for (const [role, status] of [[null, 401], ["member", 403]] as const) {
      const app = createApp(WS_A, role);
      expect((await app.fetch(createReq("{not json"), { DB: db })).status).toBe(status);
      expect((await app.fetch(createReq(JSON.stringify({ cronExpression: "*/15 * * * *" })), { DB: db })).status).toBe(status);
      expect((await app.fetch(patchReq(), { DB: db })).status).toBe(status);
      expect((await app.fetch(deleteReq(), { DB: db })).status).toBe(status);
    }
    expect((await service.listSchedules(WS_A)).length).toBe(1);
    expect((await service.getSchedule(WS_A, id))?.active).toBeTruthy();

    const admin = createApp(WS_A, "admin");
    expect((await admin.fetch(patchReq(), { DB: db })).status).toBe(200);
    expect((await admin.fetch(deleteReq(), { DB: db })).status).toBe(200);
    expect(await service.getSchedule(WS_A, id)).toBeNull();
  });

  it("story 0.11 ID_GUESS: GET /schedules/:id/history answers 404 for another workspace's schedule id, 200 for its own", async () => {
    const service = new CronService(db);
    const created = await service.createSchedule(WS_A, "*/5 * * * *", { targetUrl: "https://api.test.com/x" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const historyReq = () => new Request(`http://localhost/api/schedules/${created.schedule.id}/history`);

    const foreign = await createApp(WS_B).fetch(historyReq(), { DB: db });
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).not.toContain(created.schedule.id);

    const own = await createApp(WS_A).fetch(historyReq(), { DB: db });
    expect(own.status).toBe(200);
    expect(((await own.json()) as { history: unknown[] }).history).toEqual([]);

    expect((await createApp(WS_A).fetch(new Request("http://localhost/api/schedules/sch_missing/history"), { DB: db })).status).toBe(404);
  });
});

describe("Assembled Shell scheduled() Dispatcher in workerd (AC 3)", () => {
  it("creates schedules via API, invokes shell scheduled() via createScheduledController, and executes only the due workspace schedule", async () => {
    const assembled = assemble({ project: "cron-shell", bricks: ["multi-workspace", "cron-alarms"] }, catalog);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;

    for (const table of ["cron_history", "cron_schedules", "px_schedules", "mw_workspace_members", "mw_workspaces"]) {
      await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
    }
    const migrations = Object.entries(assembled.files)
      .filter(([p]) => p.startsWith("migrations/"))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    expect(migrations.map(([p]) => p)).toContain("migrations/0004_shell__px_schedules.sql");
    for (const [, sql] of migrations) {
      await applyMigration(db, sql);
    }

    const createWs = async (user: string, name: string): Promise<string> => {
      const res = await shellWorker.fetch(
        new Request("https://example.test/api/workspaces", {
          method: "POST",
          headers: { "content-type": "application/json", "x-test-user": user },
          body: JSON.stringify({ name }),
        }),
        { DB: db },
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { workspace: { id: string } }).workspace.id;
    };

    const wsAlpha = await createWs("alice", "Alpha Cron Workspace");
    const wsBeta = await createWs("bob", "Beta Cron Workspace");

    // Create a schedule in Workspace Alpha (every minute)
    const createAlphaRes = await shellWorker.fetch(
      new Request("https://example.test/api/schedules", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-user": "alice",
          "x-workspace-id": wsAlpha,
        },
        body: JSON.stringify({
          cronExpression: "* * * * *",
          targetWorkflowId: "wf_alpha_due",
        }),
      }),
      { DB: db },
    );
    expect(createAlphaRes.status).toBe(201);
    const alphaSchedule = ((await createAlphaRes.json()) as { schedule: { id: string; next_run_at: string } }).schedule;

    // Create a schedule in Workspace Beta and set its next_run_at far in the future so it is not due
    const createBetaRes = await shellWorker.fetch(
      new Request("https://example.test/api/schedules", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-user": "bob",
          "x-workspace-id": wsBeta,
        },
        body: JSON.stringify({
          cronExpression: "0 0 1 1 *",
          targetUrl: "https://beta.example.com/annual",
        }),
      }),
      { DB: db },
    );
    expect(createBetaRes.status).toBe(201);
    const betaSchedule = ((await createBetaRes.json()) as { schedule: { id: string; next_run_at: string } }).schedule;
    const farFuture = new Date(Date.now() + 365 * 86400 * 1000).toISOString();
    await db.prepare("UPDATE px_schedules SET next_run_at = ? WHERE id = ?").bind(farFuture, betaSchedule.id).run();
    await db.prepare("UPDATE cron_schedules SET next_run_at = ? WHERE id = ?").bind(farFuture, betaSchedule.id).run();

    // Invoke the assembled shell's scheduled() handler at the due time of Workspace Alpha's schedule
    const dueTimeMs = new Date(alphaSchedule.next_run_at).getTime() + 1000;
    const controller = createScheduledController({
      scheduledTime: dueTimeMs,
      cron: "* * * * *",
    });
    const ctx = createExecutionContext();
    // A test workflow binding injected explicitly (story 0.9: a missing binding is recorded as a failure).
    const started: Array<{ id: string }> = [];
    const wfAlphaDue = { create: async (o: { id: string }) => { started.push(o); } };
    await shellWorker.scheduled(controller, { DB: db, wf_alpha_due: wfAlphaDue }, ctx);
    await waitOnExecutionContext(ctx);

    // Verify Workspace Alpha's schedule ran and recorded a history row
    const alphaHistoryRes = await shellWorker.fetch(
      new Request(`https://example.test/api/schedules/${alphaSchedule.id}/history`, {
        headers: { "x-test-user": "alice", "x-workspace-id": wsAlpha },
      }),
      { DB: db },
    );
    expect(alphaHistoryRes.status).toBe(200);
    const alphaHistory = ((await alphaHistoryRes.json()) as { history: Array<{ schedule_id: string; status: string; response_summary: string }> }).history;
    expect(alphaHistory).toHaveLength(1);
    expect(alphaHistory[0]!.schedule_id).toBe(alphaSchedule.id);
    expect(alphaHistory[0]!.status).toBe("success");
    expect(alphaHistory[0]!.response_summary).toContain("wf_alpha_due");
    expect(started).toHaveLength(1);

    // Verify Workspace Beta's non-due schedule did NOT run
    const betaHistoryRes = await shellWorker.fetch(
      new Request(`https://example.test/api/schedules/${betaSchedule.id}/history`, {
        headers: { "x-test-user": "bob", "x-workspace-id": wsBeta },
      }),
      { DB: db },
    );
    expect(betaHistoryRes.status).toBe(200);
    const betaHistory = ((await betaHistoryRes.json()) as { history: unknown[] }).history;
    expect(betaHistory).toHaveLength(0);
  });
});
