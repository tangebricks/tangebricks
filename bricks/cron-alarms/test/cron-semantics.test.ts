import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration0001 from "../migrations/0001_cron_alarms.sql?raw";
import migration0002 from "../migrations/0002_catch_up.sql?raw";
import cronSource from "../src/cron.ts?raw";
import { Hono } from "hono";
import { CronService, MAX_CATCH_UP, createScheduleRoutes, validateCron, computeNextRun } from "../src/index.ts";
import type { CronEnv } from "../src/index.ts";

const db = env.DB as D1Like;
const WS = "ws_cron_semantics";

async function resetDb(): Promise<void> {
  for (const table of ["cron_history", "cron_schedules", "px_schedules"]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await applyMigration(db, migration0001);
  await applyMigration(db, migration0002);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("UC7.6 — Cron Overlap, Missed-Run, and Double-Fire Semantics", () => {
  it("AC1 & Task (a): under 10 concurrent dispatcher invocations, each due schedule has exactly 1 history row and 1 workflow create call", async () => {
    const createFn = vi.fn().mockResolvedValue({ id: "mock_instance" });
    const fakeEnv = {
      DB: db,
      CRON_WORKFLOW_TARGETS: "wf_due_task",
      wf_due_task: { create: createFn },
    };

    const service = new CronService(db, 50, fakeEnv);
    const created = await service.createSchedule(WS, "* * * * *", {
      targetWorkflowId: "wf_due_task",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Set next_run_at to 10 seconds ago
    const pastTime = new Date(Date.now() - 10000).toISOString();
    await db
      .prepare("UPDATE cron_schedules SET next_run_at = ? WHERE id = ?")
      .bind(pastTime, created.schedule.id)
      .run();

    // 10 concurrent trigger invocations for the exact same due minute
    const now = new Date();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => service.triggerDueSchedules(now)),
    );

    const totalTriggered = results.flat();
    expect(totalTriggered).toHaveLength(1);

    const history = await service.getHistory(WS, created.schedule.id);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("success");
    expect(createFn).toHaveBeenCalledTimes(1);
    expect(createFn).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `cron:${created.schedule.id}:${pastTime}`,
      }),
    );
  });

  it("Task (b): double-fire with identical scheduledTime delivered twice produces exactly 1 history row", async () => {
    const service = new CronService(db, 50, undefined, undefined, { allowedWorkflowTargets: ["wf_double_fire"] });
    const created = await service.createSchedule(WS, "* * * * *", {
      targetWorkflowId: "wf_double_fire",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const dueTime = new Date(Date.now() - 5000);
    await db
      .prepare("UPDATE cron_schedules SET next_run_at = ? WHERE id = ?")
      .bind(dueTime.toISOString(), created.schedule.id)
      .run();

    // Deliver identical scheduledTime twice sequentially
    const run1 = await service.triggerDueSchedules(dueTime);
    const run2 = await service.triggerDueSchedules(dueTime);

    expect(run1).toHaveLength(1);
    expect(run2).toHaveLength(0);

    const history = await service.getHistory(WS, created.schedule.id);
    expect(history).toHaveLength(1);
  });

  it("AC2 & Task (c): missed-run behaviour matches catchUp policy (once, all, skip)", async () => {
    // 1. Policy 'once': 10 minutes missed -> gives 1 run and next_run_at in future
    const service = new CronService(db, 50, undefined, undefined, { allowedWorkflowTargets: ["wf_once", "wf_all", "wf_skip"] });
    const schedOnce = await (service as any).createSchedule(WS, "* * * * *", {
      targetWorkflowId: "wf_once",
      catchUp: "once",
    });
    expect(schedOnce.ok).toBe(true);

    const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000);
    await db
      .prepare("UPDATE cron_schedules SET next_run_at = ?, last_run_at = ? WHERE id = ?")
      .bind(tenMinsAgo.toISOString(), new Date(tenMinsAgo.getTime() - 60000).toISOString(), schedOnce.schedule.id)
      .run();

    const onceRuns = await service.triggerDueSchedules(new Date());
    expect(onceRuns.filter((r) => r.schedule_id === schedOnce.schedule.id)).toHaveLength(1);
    const updatedOnce = await service.getSchedule(WS, schedOnce.schedule.id);
    expect(new Date(updatedOnce!.next_run_at).getTime()).toBeGreaterThan(Date.now());

    // 2. Policy 'all': 10 minutes missed -> gives 10 runs capped at maxCatchUp (10)
    const schedAll = await (service as any).createSchedule(WS, "* * * * *", {
      targetWorkflowId: "wf_all",
      catchUp: "all",
      maxCatchUp: 10,
    });
    expect(schedAll.ok).toBe(true);

    await db
      .prepare("UPDATE cron_schedules SET next_run_at = ?, last_run_at = ? WHERE id = ?")
      .bind(tenMinsAgo.toISOString(), new Date(tenMinsAgo.getTime() - 60000).toISOString(), schedAll.schedule.id)
      .run();

    const allRuns = await service.triggerDueSchedules(new Date());
    const schedAllRuns = allRuns.filter((r) => r.schedule_id === schedAll.schedule.id);
    expect(schedAllRuns).toHaveLength(10);

    // 3. Policy 'skip': 10 minutes missed -> 0 runs and advance recorded as 'missed' in history
    const schedSkip = await (service as any).createSchedule(WS, "* * * * *", {
      targetWorkflowId: "wf_skip",
      catchUp: "skip",
    });
    expect(schedSkip.ok).toBe(true);

    await db
      .prepare("UPDATE cron_schedules SET next_run_at = ?, last_run_at = ? WHERE id = ?")
      .bind(tenMinsAgo.toISOString(), new Date(tenMinsAgo.getTime() - 60000).toISOString(), schedSkip.schedule.id)
      .run();

    const createSkipFn = vi.fn();
    const serviceSkip = new CronService(db, 50, { DB: db, CRON_WORKFLOW_TARGETS: "wf_skip", wf_skip: { create: createSkipFn } });
    const skipRuns = await serviceSkip.triggerDueSchedules(new Date());
    expect(createSkipFn).not.toHaveBeenCalled();

    const skipHistory = await serviceSkip.getHistory(WS, schedSkip.schedule.id);
    expect(skipHistory).toHaveLength(1);
    expect(skipHistory[0].status).toBe("missed");
    const updatedSkip = await serviceSkip.getSchedule(WS, schedSkip.schedule.id);
    expect(new Date(updatedSkip!.next_run_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("Task (d): allowedIds with a not-yet-due ID gives 0 runs (no bypass of due check)", async () => {
    const service = new CronService(db, 50, undefined, undefined, { allowedWorkflowTargets: ["wf_future"] });
    const created = await service.createSchedule(WS, "0 0 1 1 *", {
      targetWorkflowId: "wf_future",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Set next_run_at far in the future
    const futureTime = new Date(Date.now() + 86400 * 1000).toISOString();
    await db
      .prepare("UPDATE cron_schedules SET next_run_at = ? WHERE id = ?")
      .bind(futureTime, created.schedule.id)
      .run();

    // Invoking triggerDueSchedules with allowedIds containing the future schedule MUST NOT trigger it
    const triggered = await service.triggerDueSchedules(new Date(), [created.schedule.id]);
    expect(triggered).toHaveLength(0);

    const history = await service.getHistory(WS, created.schedule.id);
    expect(history).toHaveLength(0);
  });

  it("Task (e): target invocation throws -> status is 'failure' and error is recorded in response_summary", async () => {
    const throwingWorkflow = {
      create: vi.fn().mockRejectedValue(new Error("Workflow queue saturated: 503")),
    };
    const fakeEnv = {
      DB: db,
      CRON_WORKFLOW_TARGETS: "wf_failing",
      wf_failing: throwingWorkflow,
    };

    const service = new CronService(db, 50, fakeEnv);
    const created = await service.createSchedule(WS, "* * * * *", {
      targetWorkflowId: "wf_failing",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const pastTime = new Date(Date.now() - 5000).toISOString();
    await db
      .prepare("UPDATE cron_schedules SET next_run_at = ? WHERE id = ?")
      .bind(pastTime, created.schedule.id)
      .run();

    const triggered = await service.triggerDueSchedules(new Date());
    expect(triggered).toHaveLength(1);
    expect(triggered[0].status).toBe("failure");
    expect(triggered[0].response_summary).toContain("Workflow queue saturated: 503");

    const history = await service.getHistory(WS, created.schedule.id);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("failure");
    expect(history[0].response_summary).toContain("Workflow queue saturated: 503");
  });

  it("story 0.21 CATCHUP_CAP: catchUp 'all' with 50 missed slots and a stored max_catch_up of 100 fires at most 10 runs per tick", async () => {
    expect(MAX_CATCH_UP).toBe(10);
    const service = new CronService(db, 50, undefined, undefined, { allowedWorkflowTargets: ["wf_flood"] });
    const created = await service.createSchedule(WS, "* * * * *", { targetWorkflowId: "wf_flood", catchUp: "all", maxCatchUp: 100 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // A row written before the cap (or by hand) may still say 100: it is clamped when the schedule fires.
    const fiftyMinsAgo = new Date(Date.now() - 50 * 60 * 1000);
    await db
      .prepare("UPDATE cron_schedules SET next_run_at = ?, last_run_at = ?, max_catch_up = 100 WHERE id = ?")
      .bind(fiftyMinsAgo.toISOString(), new Date(fiftyMinsAgo.getTime() - 60000).toISOString(), created.schedule.id)
      .run();

    const runs = (await service.triggerDueSchedules(new Date())).filter((r) => r.schedule_id === created.schedule.id);
    expect(runs).toHaveLength(10);
    // The schedule has moved past now, so the remaining 40 missed slots are not replayed on the next tick either.
    const after = await service.getSchedule(WS, created.schedule.id);
    expect(new Date(after!.next_run_at).getTime()).toBeGreaterThan(Date.now());
    expect((await service.triggerDueSchedules(new Date())).filter((r) => r.schedule_id === created.schedule.id)).toHaveLength(0);
  });

  it("story 0.21 CATCHUP_SCHEMA: creating a schedule with maxCatchUp 11 gets 400; 10 is accepted", async () => {
    const app = new Hono<CronEnv>();
    app.use("*", async (c, next) => {
      c.set("workspace", { id: WS, role: "owner" });
      c.set("user", { uid: "usr_owner" });
      c.set("ctx", Object.freeze({ userId: "usr_owner", workspaceId: WS, role: "owner" }));
      await next();
    });
    app.route("/api", createScheduleRoutes());
    const create = (maxCatchUp: number) =>
      app.fetch(
        new Request("http://localhost/api/schedules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cronExpression: "*/15 * * * *", targetUrl: "https://api.test.com/task", catchUp: "all", maxCatchUp }),
        }),
        { DB: db },
      );
    expect((await create(11)).status).toBe(400);
    expect((await create(100)).status).toBe(400);
    expect((await create(10)).status).toBe(201);
  });

  it("AC3: status is derived from outcome; cron.ts source contains no constant 'success'", () => {
    // Must not have hardcoded `const status = "success"` or `status: "success"` assignment
    const hasConstSuccess = /const\s+status(?:\s*:\s*[^=]+)?\s*=\s*["']success["']/.test(
      cronSource,
    );
    expect(
      hasConstSuccess,
      "cron.ts must not hardcode status to constant 'success'",
    ).toBe(false);
  });
});
