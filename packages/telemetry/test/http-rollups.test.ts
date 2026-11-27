import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import type { D1Like } from "@poc/sdk";
import {
  PX_TELEMETRY_MIGRATION_SQL,
  TELEMETRY_SIGNATURE_HEADER,
  computeLatencyQuantiles,
  ensureTelemetryTables,
  handleTelemetryMetricsRequest,
  pruneExpiredTelemetryRuns,
  queryEnvironmentMetrics,
  reconcileCloudflareAnalyticsWithD1Metrics,
  recordHttpRequestSamples,
  signControlPlaneRequest,
  signTelemetryPayload,
  upsertHttpRollup,
  upsertQueueMetrics,
  upsertRunRecord,
} from "../src/index.ts";

const db = (env as unknown as { DB: D1Like }).DB;
const TELEMETRY_SECRET = "test_px_metrics_hmac_secret_6_4";

describe("@poc/telemetry — Story 6.4 HTTP rollups, queue metrics, latency quantiles, and /__px/metrics", () => {
  beforeEach(async () => {
    await ensureTelemetryTables(db);
    await db.batch([
      db.prepare("DELETE FROM px_http_rollups"),
      db.prepare("DELETE FROM px_queue_metrics"),
      db.prepare("DELETE FROM px_logs"),
      db.prepare("DELETE FROM px_step_events"),
      db.prepare("DELETE FROM px_runs"),
    ]);
  });

  test("creates px_http_rollups and px_queue_metrics tables with required columns and indexes", async () => {
    expect(PX_TELEMETRY_MIGRATION_SQL).toContain("CREATE TABLE IF NOT EXISTS px_http_rollups");
    expect(PX_TELEMETRY_MIGRATION_SQL).toContain("CREATE TABLE IF NOT EXISTS px_queue_metrics");
    expect(PX_TELEMETRY_MIGRATION_SQL).toContain("idx_px_http_rollups_env_bucket");

    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('px_http_rollups', 'px_queue_metrics')")
      .all<{ name: string }>();
    const names = (tables.results ?? []).map((r) => r.name);
    expect(names).toContain("px_http_rollups");
    expect(names).toContain("px_queue_metrics");
  });

  test("computes deterministic p50, p95, and p99 latency quantiles and aggregates HTTP request samples across 1h, 24h, and 7d windows", async () => {
    const baseNow = new Date("2026-06-15T12:00:00.000Z");
    const min10Ago = new Date(baseNow.getTime() - 10 * 60_000).toISOString();
    const min25Ago = new Date(baseNow.getTime() - 25 * 60_000).toISOString();
    const hours6Ago = new Date(baseNow.getTime() - 6 * 3600_000).toISOString();
    const days3Ago = new Date(baseNow.getTime() - 3 * 86_400_000).toISOString();

    const rawLatencies = [10, 12, 15, 18, 20, 22, 25, 30, 35, 40, 45, 50, 60, 80, 110, 140, 180, 220, 310, 480];
    const directQuantiles = computeLatencyQuantiles(rawLatencies);
    expect(directQuantiles.p50Ms).toBeGreaterThanOrEqual(35);
    expect(directQuantiles.p50Ms).toBeLessThanOrEqual(45);
    expect(directQuantiles.p95Ms).toBeGreaterThanOrEqual(310);
    expect(directQuantiles.p99Ms).toBeGreaterThanOrEqual(440);

    // Record 20 samples within the last 1h across two bricks (webhook-gateway and credit-wallet)
    await recordHttpRequestSamples(
      db,
      rawLatencies.map((latencyMs, idx) => ({
        workspaceId: "ws_alpha",
        ts: idx < 10 ? min10Ago : min25Ago,
        routePrefix: idx < 12 ? "/webhooks/stripe" : "/api/wallet/debit",
        brickId: idx < 12 ? "webhook-gateway" : "credit-wallet",
        status: idx === 0 || idx === 15 ? 500 : idx === 3 ? 422 : 200,
        latencyMs,
        d1Queries: 2,
        d1LatencyMs: 4 + (idx % 5),
        d1Errors: idx === 15 ? 1 : 0,
        envName: "preview",
      })),
    );

    // Record an older rollup 6 hours ago (included in 24h & 7d, excluded from 1h)
    await upsertHttpRollup(db, {
      workspaceId: "ws_alpha",
      bucketMinute: hours6Ago,
      routePrefix: "/api/entities/orders",
      brickId: "dynamic-entities",
      requestCount: 30,
      error4xxCount: 2,
      error5xxCount: 3,
      latencySamplesMs: [15, 25, 35, 95, 190],
      d1QueryCount: 60,
      d1LatencyMs: 6.5,
      d1ErrorCount: 1,
      envName: "preview",
    });

    // Record an even older rollup 3 days ago (included in 7d only)
    await upsertHttpRollup(db, {
      workspaceId: "ws_alpha",
      bucketMinute: days3Ago,
      routePrefix: "/api/notify/send",
      brickId: "in-app-notifications",
      requestCount: 50,
      error4xxCount: 1,
      error5xxCount: 0,
      latencySamplesMs: [8, 12, 16, 24, 42],
      d1QueryCount: 50,
      d1LatencyMs: 3.2,
      d1ErrorCount: 0,
      envName: "preview",
    });

    // Seed workflow runs in 1h window
    await upsertRunRecord(db, {
      runId: "run_ok_01",
      workflowId: "wf_order_created",
      revision: 1,
      triggerType: "webhook",
      workspaceId: "ws_alpha",
      status: "succeeded",
      durationMs: 42,
      retries: 0,
      startedAt: min10Ago,
      endedAt: min10Ago,
    });
    await upsertRunRecord(db, {
      runId: "run_fail_01",
      workflowId: "wf_payment_sync",
      revision: 2,
      triggerType: "webhook",
      workspaceId: "ws_alpha",
      status: "failed",
      durationMs: 118,
      retries: 2,
      errorStack: "Error: upstream gateway 502",
      startedAt: min25Ago,
      endedAt: min25Ago,
    });
    await upsertRunRecord(db, {
      runId: "run_fail_02",
      workflowId: "wf_payment_sync",
      revision: 2,
      triggerType: "webhook",
      workspaceId: "ws_alpha",
      status: "failed",
      durationMs: 135,
      retries: 2,
      errorStack: "Error: wallet lock timeout",
      startedAt: min10Ago,
      endedAt: min10Ago,
    });

    // Seed queue metrics
    await upsertQueueMetrics(db, {
      workspaceId: "ws_alpha",
      queueName: "px-outbound-dispatch",
      pendingCount: 14,
      dlqCount: 3,
      updatedAt: min10Ago,
      envName: "preview",
    });
    await upsertQueueMetrics(db, {
      workspaceId: "ws_alpha",
      queueName: "px-webhook-ingest",
      pendingCount: 2,
      dlqCount: 0,
      updatedAt: min10Ago,
      envName: "preview",
    });

    // Another workspace's traffic, queue and failed run in the same minutes never count for ws_alpha (story 1.4).
    await recordHttpRequestSamples(db, [
      { workspaceId: "ws_beta", ts: min10Ago, routePrefix: "/webhooks/stripe", brickId: "webhook-gateway", status: 500, latencyMs: 9999, envName: "preview" },
    ]);
    await upsertQueueMetrics(db, {
      workspaceId: "ws_beta",
      queueName: "px-outbound-dispatch",
      pendingCount: 999,
      dlqCount: 99,
      updatedAt: min10Ago,
      envName: "preview",
    });
    await upsertRunRecord(db, {
      runId: "run_beta_fail",
      workflowId: "wf_beta",
      revision: 1,
      triggerType: "webhook",
      workspaceId: "ws_beta",
      status: "failed",
      durationMs: 1,
      retries: 0,
      startedAt: min10Ago,
      endedAt: min10Ago,
    });
    const betaOnly = await queryEnvironmentMetrics(db, { workspaceId: "ws_beta" }, { env: "preview", window: "1h", now: baseNow });
    expect(betaOnly.requestCount).toBe(1);
    expect(betaOnly.workflows.totalRuns).toBe(1);
    expect(betaOnly.queues).toEqual([expect.objectContaining({ queueName: "px-outbound-dispatch", depth: 999 })]);

    // 1. Verify 1h window
    const summary1h = await queryEnvironmentMetrics(
      db,
      { workspaceId: "ws_alpha" },
      {
        env: "preview",
        window: "1h",
        now: baseNow,
      },
    );
    expect(summary1h.window).toBe("1h");
    expect(summary1h.requestCount).toBe(20);
    expect(summary1h.error4xxCount).toBe(1);
    expect(summary1h.error5xxCount).toBe(2);
    expect(summary1h.errorRatePercent).toBe(10); // 2 / 20 * 100
    expect(summary1h.latencyP50Ms).toBe(directQuantiles.p50Ms);
    expect(summary1h.latencyP95Ms).toBe(directQuantiles.p95Ms);
    expect(summary1h.latencyP99Ms).toBe(directQuantiles.p99Ms);
    expect(summary1h.d1.queryCount).toBe(40);
    expect(summary1h.d1.errorCount).toBe(1);
    expect(summary1h.workflows.totalRuns).toBe(3);
    expect(summary1h.workflows.succeededRuns).toBe(1);
    expect(summary1h.workflows.failedRuns).toBe(2);
    expect(summary1h.workflows.topFailingWorkflows[0]).toEqual({
      workflowId: "wf_payment_sync",
      failedCount: 2,
      lastFailedRunId: "run_fail_02",
    });
    expect(summary1h.queues).toHaveLength(2);
    expect(summary1h.queues[0]).toMatchObject({
      queueName: "px-outbound-dispatch",
      depth: 14,
      dlqCount: 3,
    });
    expect(summary1h.perBrick).toHaveLength(2);
    expect(summary1h.series).toHaveLength(12);

    // 2. Verify 24h window includes 6h-ago rollup (20 + 30 = 50 requests, 2 + 3 = 5 5xx errors)
    const summary24h = await queryEnvironmentMetrics(
      db,
      { workspaceId: "ws_alpha" },
      {
        env: "preview",
        window: "24h",
        now: baseNow,
      },
    );
    expect(summary24h.requestCount).toBe(50);
    expect(summary24h.error5xxCount).toBe(5);
    expect(summary24h.errorRatePercent).toBe(10);
    expect(summary24h.perBrick).toHaveLength(3);

    // 3. Verify 7d window includes 3d-ago rollup (50 + 50 = 100 requests, 5 5xx errors => 5%)
    const summary7d = await queryEnvironmentMetrics(
      db,
      { workspaceId: "ws_alpha" },
      {
        env: "preview",
        window: "7d",
        now: baseNow,
      },
    );
    expect(summary7d.requestCount).toBe(100);
    expect(summary7d.error5xxCount).toBe(5);
    expect(summary7d.errorRatePercent).toBe(5);
    expect(summary7d.perBrick).toHaveLength(4);
  });

  test("authenticates GET /__px/metrics with HMAC signature and reconciles Cloudflare GraphQL Analytics snapshot", async () => {
    const baseNow = new Date("2026-06-15T12:00:00.000Z");
    await upsertHttpRollup(db, {
      workspaceId: "ws_alpha",
      bucketMinute: "2026-06-15T11:45:00.000Z",
      routePrefix: "/webhooks/inbound",
      brickId: "webhook-gateway",
      requestCount: 100,
      error4xxCount: 4,
      error5xxCount: 5,
      latencySamplesMs: [12, 18, 24, 38, 92, 145],
      d1QueryCount: 200,
      d1LatencyMs: 4.5,
      d1ErrorCount: 0,
      envName: "preview",
    });

    // Rejects unsigned request with 401
    const unsignedRes = await handleTelemetryMetricsRequest(new Request("https://worker.local/__px/metrics?workspaceId=ws_alpha&window=1h"), {
      db,
      telemetrySecret: TELEMETRY_SECRET,
      pxEnv: "preview",
      now: baseNow,
    });
    expect(unsignedRes?.status).toBe(401);

    // Rejects the old scheme (a signature over GET:<path and query>) with 401
    const legacyUrl = new URL("https://worker.local/__px/metrics?workspaceId=ws_alpha&window=1h");
    const legacyRes = await handleTelemetryMetricsRequest(
      new Request(legacyUrl.toString(), {
        headers: { [TELEMETRY_SIGNATURE_HEADER]: await signTelemetryPayload(`GET:${legacyUrl.pathname}${legacyUrl.search}`, TELEMETRY_SECRET) },
      }),
      { db, telemetrySecret: TELEMETRY_SECRET, pxEnv: "preview", now: baseNow },
    );
    expect(legacyRes?.status).toBe(401);

    // Rejects invalid window with 400
    const badWindowUrl = new URL("https://worker.local/__px/metrics?workspaceId=ws_alpha&window=99d");
    const badWindowRes = await handleTelemetryMetricsRequest(
      new Request(badWindowUrl.toString(), { headers: await signControlPlaneRequest(TELEMETRY_SECRET, "GET", badWindowUrl) }),
      { db, telemetrySecret: TELEMETRY_SECRET, pxEnv: "preview", now: baseNow },
    );
    expect(badWindowRes?.status).toBe(400);

    // Accepts a valid control-plane signature over the whole query
    const signedUrl = new URL("https://worker.local/__px/metrics?workspaceId=ws_alpha&window=1h&env=preview");
    const validRes = await handleTelemetryMetricsRequest(
      new Request(signedUrl.toString(), { headers: await signControlPlaneRequest(TELEMETRY_SECRET, "GET", signedUrl) }),
      { db, telemetrySecret: TELEMETRY_SECRET, pxEnv: "preview", now: baseNow },
    );
    expect(validRes?.status).toBe(200);
    const body = (await validRes!.json()) as Awaited<ReturnType<typeof queryEnvironmentMetrics>>;
    expect(body.ok).toBe(true);
    expect(body.requestCount).toBe(100);
    expect(body.error5xxCount).toBe(5);
    expect(body.errorRatePercent).toBe(5);

    // Reconcile with Cloudflare GraphQL Analytics within <= 1% delta
    const reconciled = reconcileCloudflareAnalyticsWithD1Metrics(body, {
      workersInvocationsAdaptive: {
        requests: 101,
        errors: 5,
        p50Ms: 21,
        p95Ms: 138,
        p99Ms: 145,
      },
      queuesBacklogAdaptive: [
        {
          queueName: "px-events-queue",
          depth: 9,
          dlqCount: 1,
        },
      ],
    });
    expect(reconciled.analyticsReconciliation?.source).toBe("cloudflare-graphql+d1");
    expect(reconciled.analyticsReconciliation?.deltaPercent).toBeLessThanOrEqual(1);
    expect(reconciled.requestCount).toBe(101);
    expect(reconciled.queues).toContainEqual(
      expect.objectContaining({
        queueName: "px-events-queue",
        depth: 9,
        dlqCount: 1,
      }),
    );
  });

  test("prunes expired px_http_rollups rows alongside expired runs and logs", async () => {
    const now = new Date("2026-06-15T12:00:00.000Z");
    const expiredBucket = new Date(now.getTime() - 20 * 86_400_000).toISOString();
    const freshBucket = new Date(now.getTime() - 2 * 86_400_000).toISOString();

    await upsertHttpRollup(db, {
      workspaceId: "ws_alpha",
      bucketMinute: expiredBucket,
      routePrefix: "/old",
      brickId: "webhook-gateway",
      requestCount: 15,
      envName: "preview",
    });
    await upsertHttpRollup(db, {
      workspaceId: "ws_alpha",
      bucketMinute: freshBucket,
      routePrefix: "/fresh",
      brickId: "webhook-gateway",
      requestCount: 25,
      envName: "preview",
    });

    const pruneRes = await pruneExpiredTelemetryRuns(db, {
      retentionDays: 14,
      now,
    });
    expect(pruneRes.deletedHttpRollups).toBe(1);

    const summary7d = await queryEnvironmentMetrics(
      db,
      { workspaceId: "ws_alpha" },
      {
        env: "preview",
        window: "7d",
        now,
      },
    );
    expect(summary7d.requestCount).toBe(25);
  });
});
