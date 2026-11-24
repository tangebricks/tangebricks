import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import type { D1Like } from "@poc/sdk";
import {
  DEFAULT_RUN_RETENTION_DAYS,
  MIN_RUN_RETENTION_DAYS,
  ensureTelemetryTables,
  insertStepEvent,
  listRunRecords,
  listStepEventsForRun,
  pruneExpiredTelemetryRuns,
  queryRunHistory,
  resolveRunRetentionDays,
  runScheduledTelemetryRetentionPrune,
  upsertRunRecord,
} from "../src/index.ts";

const db = env.DB as D1Like;

describe("packages/telemetry retention pruning & filtered run history queries", () => {
  beforeEach(async () => {
    await ensureTelemetryTables(db);
    await db.batch([
      db.prepare("DELETE FROM px_step_events"),
      db.prepare("DELETE FROM px_runs"),
    ]);
  });

  test("enforces default 14 days and minimum floor 7 days for PX_RUN_RETENTION_DAYS", () => {
    expect(resolveRunRetentionDays(undefined)).toBe(DEFAULT_RUN_RETENTION_DAYS);
    expect(resolveRunRetentionDays(null)).toBe(14);
    expect(resolveRunRetentionDays("")).toBe(14);
    expect(resolveRunRetentionDays("invalid")).toBe(14);
    expect(resolveRunRetentionDays(0)).toBe(14);
    expect(resolveRunRetentionDays(3)).toBe(MIN_RUN_RETENTION_DAYS);
    expect(resolveRunRetentionDays("5")).toBe(7);
    expect(resolveRunRetentionDays(7)).toBe(7);
    expect(resolveRunRetentionDays(30)).toBe(30);
  });

  test("pruneExpiredTelemetryRuns deletes px_step_events and px_runs older than retention window while preserving recent runs", async () => {
    const fixedNow = new Date("2026-10-30T12:00:00.000Z");
    const twentyDaysAgo = new Date(
      fixedNow.getTime() - 20 * 86_400_000,
    ).toISOString();
    const fifteenDaysAgo = new Date(
      fixedNow.getTime() - 15 * 86_400_000,
    ).toISOString();
    const tenDaysAgo = new Date(
      fixedNow.getTime() - 10 * 86_400_000,
    ).toISOString();
    const twoDaysAgo = new Date(
      fixedNow.getTime() - 2 * 86_400_000,
    ).toISOString();

    await upsertRunRecord(db, {
      runId: "run_old_20d",
      workflowId: "wf_billing",
      revision: 1,
      triggerType: "manual",
      workspaceId: "ws_1",
      status: "succeeded",
      durationMs: 42,
      retries: 0,
      startedAt: twentyDaysAgo,
      endedAt: twentyDaysAgo,
    });
    await insertStepEvent(db, {
      eventId: "ev_old_20d_1",
      runId: "run_old_20d",
      workflowId: "wf_billing",
      revision: 1,
      workspaceId: "ws_1",
      nodeId: "node_trigger",
      status: "succeeded",
      durationMs: 42,
      retries: 0,
      inputPreview: "{}",
      outputPreview: '{"ok":true}',
      createdAt: twentyDaysAgo,
    });

    await upsertRunRecord(db, {
      runId: "run_old_15d",
      workflowId: "wf_billing",
      revision: 1,
      triggerType: "schedule",
      workspaceId: "ws_1",
      status: "failed",
      durationMs: 85,
      retries: 2,
      errorStack: "Error: card declined",
      startedAt: fifteenDaysAgo,
      endedAt: fifteenDaysAgo,
    });
    await insertStepEvent(db, {
      eventId: "ev_old_15d_1",
      runId: "run_old_15d",
      workflowId: "wf_billing",
      revision: 1,
      workspaceId: "ws_1",
      nodeId: "node_charge",
      status: "failed",
      durationMs: 85,
      retries: 2,
      inputPreview: '{"amount":100}',
      outputPreview: "{}",
      errorStack: "Error: card declined",
      createdAt: fifteenDaysAgo,
    });

    await upsertRunRecord(db, {
      runId: "run_recent_10d",
      workflowId: "wf_billing",
      revision: 2,
      triggerType: "webhook",
      workspaceId: "ws_1",
      status: "succeeded",
      durationMs: 18,
      retries: 0,
      startedAt: tenDaysAgo,
      endedAt: tenDaysAgo,
    });
    await insertStepEvent(db, {
      eventId: "ev_recent_10d_1",
      runId: "run_recent_10d",
      workflowId: "wf_billing",
      revision: 2,
      workspaceId: "ws_1",
      nodeId: "node_webhook",
      status: "succeeded",
      durationMs: 18,
      retries: 0,
      inputPreview: "{}",
      outputPreview: '{"received":true}',
      createdAt: tenDaysAgo,
    });

    await upsertRunRecord(db, {
      runId: "run_recent_2d",
      workflowId: "wf_onboarding",
      revision: 3,
      triggerType: "brick-event",
      workspaceId: "ws_1",
      status: "succeeded",
      durationMs: 12,
      retries: 0,
      startedAt: twoDaysAgo,
      endedAt: twoDaysAgo,
    });
    await insertStepEvent(db, {
      eventId: "ev_recent_2d_1",
      runId: "run_recent_2d",
      workflowId: "wf_onboarding",
      revision: 3,
      workspaceId: "ws_1",
      nodeId: "node_welcome",
      status: "succeeded",
      durationMs: 12,
      retries: 0,
      inputPreview: "{}",
      outputPreview: '{"sent":true}',
      createdAt: twoDaysAgo,
    });

    // Default retention (14 days): prunes 20d and 15d runs, keeps 10d and 2d runs
    const pruneDefault = await pruneExpiredTelemetryRuns(db, { now: fixedNow });
    expect(pruneDefault.retentionDays).toBe(14);
    expect(pruneDefault.deletedRuns).toBe(2);
    expect(pruneDefault.deletedStepEvents).toBe(2);

    const remainingAfterDefault = await listRunRecords(db, { workspaceId: "ws_1" });
    expect(remainingAfterDefault.map((r) => r.runId)).toEqual([
      "run_recent_2d",
      "run_recent_10d",
    ]);
    expect(await listStepEventsForRun(db, "run_old_20d", { workspaceId: "ws_1" })).toHaveLength(0);
    expect(await listStepEventsForRun(db, "run_old_15d", { workspaceId: "ws_1" })).toHaveLength(0);
    expect(await listStepEventsForRun(db, "run_recent_10d", { workspaceId: "ws_1" })).toHaveLength(1);
    expect(await listStepEventsForRun(db, "run_recent_2d", { workspaceId: "ws_1" })).toHaveLength(1);

    // Scheduled dispatcher with PX_RUN_RETENTION_DAYS=3 (clamped to minimum floor 7 days): prunes 10d run, keeps 2d run
    const pruneMinFloor = await runScheduledTelemetryRetentionPrune(
      { scheduledTime: fixedNow.getTime(), cron: "* * * * *" },
      { DB: db, PX_RUN_RETENTION_DAYS: 3 },
    );
    expect(pruneMinFloor.retentionDays).toBe(7);
    expect(pruneMinFloor.deletedRuns).toBe(1);
    expect(pruneMinFloor.deletedStepEvents).toBe(1);

    const remainingAfterMinFloor = await listRunRecords(db, { workspaceId: "ws_1" });
    expect(remainingAfterMinFloor.map((r) => r.runId)).toEqual(["run_recent_2d"]);
  });

  test("queryRunHistory filters by workflowId, status, trigger, and time range and populates failedNodeId", async () => {
    await upsertRunRecord(db, {
      runId: "run_a",
      workflowId: "wf_orders",
      revision: 1,
      triggerType: "webhook",
      workspaceId: "ws_1",
      status: "succeeded",
      durationMs: 30,
      retries: 0,
      startedAt: "2026-10-28T10:00:00.000Z",
      endedAt: "2026-10-28T10:00:00.030Z",
    });
    await upsertRunRecord(db, {
      runId: "run_b",
      workflowId: "wf_orders",
      revision: 2,
      triggerType: "manual",
      workspaceId: "ws_1",
      status: "failed",
      durationMs: 95,
      retries: 2,
      errorStack: "Error: insufficient balance",
      startedAt: "2026-10-29T10:00:00.000Z",
      endedAt: "2026-10-29T10:00:00.095Z",
    });
    await insertStepEvent(db, {
      eventId: "ev_b_debit",
      runId: "run_b",
      workflowId: "wf_orders",
      revision: 2,
      workspaceId: "ws_1",
      nodeId: "step_debit",
      status: "failed",
      durationMs: 95,
      retries: 2,
      inputPreview: '{"amount":500}',
      outputPreview: "{}",
      errorStack: "Error: insufficient balance",
      createdAt: "2026-10-29T10:00:00.095Z",
    });
    await upsertRunRecord(db, {
      runId: "run_c",
      workflowId: "wf_alerts",
      revision: 2,
      triggerType: "schedule",
      workspaceId: "ws_1",
      status: "succeeded",
      durationMs: 14,
      retries: 0,
      startedAt: "2026-10-30T10:00:00.000Z",
      endedAt: "2026-10-30T10:00:00.014Z",
    });

    const wfFiltered = await queryRunHistory(db, { workspaceId: "ws_1" }, { workflowId: "wf_orders" });
    expect(wfFiltered.runs.map((r) => r.runId)).toEqual(["run_b", "run_a"]);
    expect(wfFiltered.runs[0]?.failedNodeId).toBe("step_debit");
    expect(wfFiltered.runs[0]?.stepCount).toBe(1);

    const statusFiltered = await queryRunHistory(db, { workspaceId: "ws_1" }, { status: "failed" });
    expect(statusFiltered.runs.map((r) => r.runId)).toEqual(["run_b"]);

    const triggerFiltered = await queryRunHistory(db, { workspaceId: "ws_1" }, { trigger: "schedule" });
    expect(triggerFiltered.runs.map((r) => r.runId)).toEqual(["run_c"]);

    const timeFiltered = await queryRunHistory(db, { workspaceId: "ws_1" }, {
      from: "2026-10-29T00:00:00.000Z",
      to: "2026-10-29T23:59:59.000Z",
    });
    expect(timeFiltered.runs.map((r) => r.runId)).toEqual(["run_b"]);

    // Another workspace's run never appears in ws_1's history (story 1.4)
    await upsertRunRecord(db, {
      runId: "run_other_ws",
      workflowId: "wf_orders",
      revision: 1,
      triggerType: "manual",
      workspaceId: "ws_2",
      status: "failed",
      durationMs: 1,
      retries: 0,
      startedAt: "2026-10-29T12:00:00.000Z",
    });
    const ws1Only = await queryRunHistory(db, { workspaceId: "ws_1" }, { workflowId: "wf_orders" });
    expect(ws1Only.runs.map((r) => r.runId)).toEqual(["run_b", "run_a"]);
    const ws2Only = await queryRunHistory(db, { workspaceId: "ws_2" }, {});
    expect(ws2Only.runs.map((r) => r.runId)).toEqual(["run_other_ws"]);
  });
});
