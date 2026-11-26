import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import type { D1Like } from "@poc/sdk";
import {
  MAX_TOTAL_PREVIEW_BYTES,
  PX_TELEMETRY_MIGRATION_SQL,
  REDACTED_PLACEHOLDER,
  RunRecordSchema,
  StepEventSchema,
  SIGNED_AT_HEADER,
  TELEMETRY_SIGNATURE_HEADER,
  TelemetryScopeError,
  TelemetryWriteRefusedError,
  ensureTelemetryTables,
  forgetEnsuredTelemetryTables,
  getRunRecord,
  handleTelemetryEventsPullRequest,
  insertStepEvent,
  insertStructuredLog,
  listRunRecords,
  listStepEventsForRun,
  redactTelemetryPayload,
  signControlPlaneRequest,
  signTelemetryPayload,
  upsertHttpRollup,
  upsertQueueMetrics,
  truncateTelemetryPreview,
  upsertRunRecord,
  utf8ByteLength,
} from "../src/index.ts";

const db = (env as unknown as { DB: D1Like }).DB;

describe("@poc/telemetry — schemas, D1 migration, redaction engine, 16 KB truncator, and signed pull", () => {
  beforeEach(async () => {
    await ensureTelemetryTables(db);
    await db.batch([
      db.prepare("DELETE FROM px_step_events"),
      db.prepare("DELETE FROM px_runs"),
    ]);
  });

  test("exports Zod-validated RunRecord and StepEvent schemas and creates px_runs & px_step_events with required indexes", async () => {
    expect(PX_TELEMETRY_MIGRATION_SQL).toContain("CREATE TABLE IF NOT EXISTS px_runs");
    expect(PX_TELEMETRY_MIGRATION_SQL).toContain("CREATE TABLE IF NOT EXISTS px_step_events");
    expect(PX_TELEMETRY_MIGRATION_SQL).toContain("(workflow_id, started_at DESC)");
    expect(PX_TELEMETRY_MIGRATION_SQL).toContain("(run_id, node_id)");

    const indexRows = await db
      .prepare(
        "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('px_runs', 'px_step_events')",
      )
      .all<{ name: string; tbl_name: string; sql: string | null }>();
    const indexSql = (indexRows.results ?? []).map((r) => r.sql ?? "").join("\n");
    expect(indexSql).toContain("(workflow_id, started_at DESC)");
    expect(indexSql).toContain("(run_id, node_id)");

    const run = RunRecordSchema.parse({
      runId: "run_test_1",
      workflowId: "wf_orders",
      revision: 3,
      triggerType: "webhook",
      workspaceId: "ws_acme",
      status: "running",
      durationMs: 12.5,
      retries: 0,
      startedAt: "2026-10-30T12:00:00.000Z",
    });
    await upsertRunRecord(db, run);

    const step = StepEventSchema.parse({
      eventId: "run_test_1:node_a:succeeded:1",
      runId: "run_test_1",
      workflowId: "wf_orders",
      revision: 3,
      workspaceId: "ws_acme",
      nodeId: "node_a",
      status: "succeeded",
      durationMs: 8.2,
      retries: 1,
      inputPreview: '{"in":"hello"}',
      outputPreview: '{"out":"world"}',
      errorStack: null,
      createdAt: "2026-10-30T12:00:01.000Z",
    });
    const inserted = await insertStepEvent(db, step);
    expect(inserted.cursor).toBeGreaterThan(0);

    const fetchedRun = await getRunRecord(db, "run_test_1", { workspaceId: "ws_acme" });
    expect(fetchedRun?.workflowId).toBe("wf_orders");
    expect(fetchedRun?.revision).toBe(3);

    const runs = await listRunRecords(db, { workspaceId: "ws_acme" }, { workflowId: "wf_orders" });
    expect(runs).toHaveLength(1);

    const stepEvents = await listStepEventsForRun(db, "run_test_1", { workspaceId: "ws_acme" });
    expect(stepEvents).toHaveLength(1);
    expect(stepEvents[0]?.nodeId).toBe("node_a");
    expect(stepEvents[0]?.retries).toBe(1);
  });

  test("redactTelemetryPayload scrubs exact, base64, and URL-encoded secret values, widget:secret fields, and sensitive headers/keys", () => {
    const canaryApiSecret = "sk_live_canary_998877665544332211";
    const canaryConnToken = "xox" + "b-canary-slack-connection-774411";
    const base64Secret = btoa(canaryApiSecret);
    const urlEncodedSecret = encodeURIComponent("sec+val/with=special&chars!999");

    const rawPayload = {
      inputs: {
        endpoint: `https://api.example.com/v1/charge?key=${canaryApiSecret}&encoded=${urlEncodedSecret}`,
        basicHeaderValue: `Basic ${base64Secret}`,
        slackEcho: `token=${canaryConnToken}`,
      },
      data: {
        webhookSigningSecret: "whsec_widget_secret_value_12345",
        customWidgetSecretField: "super-private-widget-field-value",
        normalField: "visible-public-value",
      },
      headers: {
        Authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
        Cookie: "session_id=abc123xyz",
        "Set-Cookie": "sid=topsecret",
        "X-Api-Key": "x-api-key-value",
        "X-Custom-Token": "custom-token-header",
        "Content-Type": "application/json",
      },
      nested: {
        userPassword: "plaintext-password-value",
        refreshToken: "refresh-token-value",
        clientSecret: "client-secret-value",
        safeCount: 42,
      },
    };

    const redacted = redactTelemetryPayload(rawPayload, {
      secretValues: [
        canaryApiSecret,
        canaryConnToken,
        "sec+val/with=special&chars!999",
      ],
      secretFieldNames: ["customWidgetSecretField"],
    }) as Record<string, unknown>;

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(canaryApiSecret);
    expect(serialized).not.toContain(canaryConnToken);
    expect(serialized).not.toContain(base64Secret);
    expect(serialized).not.toContain(urlEncodedSecret);
    expect(serialized).not.toContain("whsec_widget_secret_value_12345");
    expect(serialized).not.toContain("super-private-widget-field-value");
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(serialized).not.toContain("session_id=abc123xyz");
    expect(serialized).not.toContain("plaintext-password-value");
    expect(serialized).not.toContain("refresh-token-value");
    expect(serialized).not.toContain("client-secret-value");

    const headers = redacted.headers as Record<string, unknown>;
    expect(headers.Authorization).toBe(REDACTED_PLACEHOLDER);
    expect(headers.Cookie).toBe(REDACTED_PLACEHOLDER);
    expect(headers["Set-Cookie"]).toBe(REDACTED_PLACEHOLDER);
    expect(headers["X-Api-Key"]).toBe(REDACTED_PLACEHOLDER);
    expect(headers["X-Custom-Token"]).toBe(REDACTED_PLACEHOLDER);
    expect(headers["Content-Type"]).toBe("application/json");

    const data = redacted.data as Record<string, unknown>;
    expect(data.customWidgetSecretField).toBe(REDACTED_PLACEHOLDER);
    expect(data.normalField).toBe("visible-public-value");
  });

  test("truncateTelemetryPreview caps individual fields > 8 KB and total payload preview to <= 16,384 UTF-8 bytes of valid JSON", () => {
    const tenKbField = "A".repeat(10 * 1024);
    const singleFieldTruncated = truncateTelemetryPreview({
      bigField: tenKbField,
      smallField: "ok",
    });
    expect(utf8ByteLength(singleFieldTruncated)).toBeLessThanOrEqual(MAX_TOTAL_PREVIEW_BYTES);
    const parsedSingle = JSON.parse(singleFieldTruncated) as {
      bigField: { __truncated: boolean; originalBytes: number; preview: string };
      smallField: string;
    };
    expect(parsedSingle.bigField.__truncated).toBe(true);
    expect(parsedSingle.bigField.originalBytes).toBe(10 * 1024);
    expect(parsedSingle.smallField).toBe("ok");

    // Multi-field payload exceeding 16 KB total UTF-8 byte length (including multi-byte UTF-8 characters)
    const hugeObject: Record<string, string> = {};
    for (let i = 0; i < 12; i += 1) {
      hugeObject[`chunk_${i}`] = `🚀-데이터-${i}-`.repeat(400);
    }

    const truncatedJson = truncateTelemetryPreview(hugeObject);
    const byteLen = utf8ByteLength(truncatedJson);
    expect(byteLen).toBeLessThanOrEqual(MAX_TOTAL_PREVIEW_BYTES);

    const parsedEnvelope = JSON.parse(truncatedJson) as {
      __truncated: boolean;
      originalBytes: number;
      preview: string;
    };
    expect(parsedEnvelope.__truncated).toBe(true);
    expect(parsedEnvelope.originalBytes).toBeGreaterThan(MAX_TOTAL_PREVIEW_BYTES);
    expect(typeof parsedEnvelope.preview).toBe("string");
    expect(parsedEnvelope.preview.length).toBeGreaterThan(100);
  });

  test("GET /__px/events?workspaceId=&after=&limit= verifies the control-plane signature and paginates one workspace's missed events", async () => {
    const secret = "px-worker-telemetry-secret-key-2026";
    for (let i = 1; i <= 3; i += 1) {
      await insertStepEvent(db, {
        eventId: `run_cursor:node_${i}:succeeded:${i}`,
        runId: "run_cursor",
        workflowId: "wf_cursor",
        revision: 1,
        workspaceId: "ws_cursor",
        nodeId: `node_${i}`,
        status: "succeeded",
        durationMs: i * 5,
        retries: 0,
        inputPreview: "{}",
        outputPreview: `{"step":${i}}`,
        errorStack: null,
        createdAt: `2026-10-30T12:00:0${i}.000Z`,
      });
    }

    // Another workspace's event never appears in this workspace's pull.
    await insertStepEvent(db, {
      eventId: "run_other:node_x:succeeded:1",
      runId: "run_other",
      workflowId: "wf_cursor",
      revision: 1,
      workspaceId: "ws_other",
      nodeId: "node_x",
      status: "succeeded",
      durationMs: 1,
      retries: 0,
      inputPreview: "{}",
      outputPreview: "{}",
      errorStack: null,
      createdAt: "2026-10-30T12:00:09.000Z",
    });

    const page1Url = "http://worker.local/__px/events?workspaceId=ws_cursor&after=0&limit=2";
    // Missing signature -> 401
    const unauthRes = await handleTelemetryEventsPullRequest(new Request(page1Url), { db, telemetrySecret: secret });
    expect(unauthRes?.status).toBe(401);

    // Forged signature -> 401
    const forgedRes = await handleTelemetryEventsPullRequest(
      new Request(page1Url, {
        headers: { [SIGNED_AT_HEADER]: String(Math.floor(Date.now() / 1000)), [TELEMETRY_SIGNATURE_HEADER]: "deadbeef0123456789" },
      }),
      { db, telemetrySecret: secret },
    );
    expect(forgedRes?.status).toBe(401);

    // The old body-only scheme (a signature over the bare path and query) -> 401
    const legacyRes = await handleTelemetryEventsPullRequest(
      new Request(page1Url, {
        headers: { [TELEMETRY_SIGNATURE_HEADER]: await signTelemetryPayload("/__px/events?workspaceId=ws_cursor&after=0&limit=2", secret) },
      }),
      { db, telemetrySecret: secret },
    );
    expect(legacyRes?.status).toBe(401);

    // Signed, but naming no workspace -> 400 WORKSPACE_ID_REQUIRED
    const noWsUrl = "http://worker.local/__px/events?after=0&limit=2";
    const noWsRes = await handleTelemetryEventsPullRequest(
      new Request(noWsUrl, { headers: await signControlPlaneRequest(secret, "GET", new URL(noWsUrl)) }),
      { db, telemetrySecret: secret },
    );
    expect(noWsRes?.status).toBe(400);
    expect(((await noWsRes!.json()) as { error: { code: string } }).error.code).toBe("WORKSPACE_ID_REQUIRED");

    // Valid signature -> 200 with page 1 (2 events)
    const validRes1 = await handleTelemetryEventsPullRequest(
      new Request(page1Url, { headers: await signControlPlaneRequest(secret, "GET", new URL(page1Url)) }),
      { db, telemetrySecret: secret },
    );
    expect(validRes1?.status).toBe(200);
    const body1 = (await validRes1!.json()) as {
      ok: boolean;
      events: Array<{ nodeId: string; cursor: number }>;
      nextCursor: number;
      hasMore: boolean;
    };
    expect(body1.ok).toBe(true);
    expect(body1.events).toHaveLength(2);
    expect(body1.hasMore).toBe(true);

    // Page 2 after nextCursor -> remaining 1 event (ws_other's later event is not part of it)
    const page2Url = `http://worker.local/__px/events?workspaceId=ws_cursor&after=${body1.nextCursor}&limit=2`;
    const validRes2 = await handleTelemetryEventsPullRequest(
      new Request(page2Url, { headers: await signControlPlaneRequest(secret, "GET", new URL(page2Url)) }),
      { db, telemetrySecret: secret },
    );
    expect(validRes2?.status).toBe(200);
    const body2 = (await validRes2!.json()) as {
      events: Array<{ nodeId: string }>;
      hasMore: boolean;
    };
    expect(body2.events).toHaveLength(1);
    expect(body2.events[0]?.nodeId).toBe("node_3");
    expect(body2.hasMore).toBe(false);
  });

  test("story 1.4: every read is scoped; a read naming neither project nor workspace throws", async () => {
    const base = { workflowId: "wf_scope", revision: 1, triggerType: "manual", status: "succeeded" as const, durationMs: 1, retries: 0, startedAt: "2026-10-30T12:00:00.000Z" };
    await upsertRunRecord(db, { ...base, runId: "run_pa", workspaceId: "ws_shared" }, { projectId: "proj_a" });
    await upsertRunRecord(db, { ...base, runId: "run_pb", workspaceId: "ws_shared" }, { projectId: "proj_b" });
    await upsertRunRecord(db, { ...base, runId: "run_wb", workspaceId: "ws_b" });

    expect(await getRunRecord(db, "run_pb", { projectId: "proj_a" })).toBeNull();
    expect((await getRunRecord(db, "run_pa", { projectId: "proj_a" }))?.runId).toBe("run_pa");
    expect(await getRunRecord(db, "run_wb", { workspaceId: "ws_shared" })).toBeNull();
    expect((await listRunRecords(db, { projectId: "proj_a" })).map((r) => r.runId)).toEqual(["run_pa"]);
    expect((await listRunRecords(db, { workspaceId: "ws_shared" })).map((r) => r.runId).sort()).toEqual(["run_pa", "run_pb"]);
    expect((await listRunRecords(db, { projectId: "proj_a", workspaceId: "ws_b" }))).toEqual([]);

    // The same run id written for another project never overwrites the first project's row, and is refused as a
    // collision rather than reported as a success.
    await expect(
      upsertRunRecord(db, { ...base, runId: "run_pa", workspaceId: "ws_shared", status: "failed" }, { projectId: "proj_b" }),
    ).rejects.toMatchObject({ kind: "ID_COLLISION" });
    expect((await getRunRecord(db, "run_pa", { projectId: "proj_a" }))?.status).toBe("succeeded");
    const ev = { eventId: "ev_pa", runId: "run_pa", workflowId: "wf_scope", revision: 1, nodeId: "n", status: "succeeded" as const, durationMs: 1, retries: 0, inputPreview: "{}", outputPreview: "{}", errorStack: null, createdAt: "2026-10-30T12:00:00.000Z" };
    await insertStepEvent(db, { ...ev, workspaceId: "ws_shared" }, { projectId: "proj_a" });
    await expect(insertStepEvent(db, { ...ev, workspaceId: "ws_other" }, { projectId: "proj_a" })).rejects.toMatchObject({ kind: "ID_COLLISION" });
    await insertStructuredLog(db, { logId: "log_pa", level: "info", message: "pa", workspaceId: "ws_shared" }, {}, { projectId: "proj_a" });
    await expect(
      insertStructuredLog(db, { logId: "log_pa", level: "info", message: "pb", workspaceId: "ws_shared" }, {}, { projectId: "proj_b" }),
    ).rejects.toMatchObject({ kind: "ID_COLLISION" });
    // The same scope updates in place.
    await upsertRunRecord(db, { ...base, runId: "run_pa", workspaceId: "ws_shared", status: "failed" }, { projectId: "proj_a" });
    expect((await getRunRecord(db, "run_pa", { projectId: "proj_a" }))?.status).toBe("failed");

    await expect(getRunRecord(db, "run_pa", {})).rejects.toBeInstanceOf(TelemetryScopeError);
    await expect(listRunRecords(db, { projectId: " ", workspaceId: "" })).rejects.toBeInstanceOf(TelemetryScopeError);
    await expect(listStepEventsForRun(db, "run_pa", {})).rejects.toBeInstanceOf(TelemetryScopeError);
  });

  test("story 1.4: a step event, run or metric without a workspace is a refused write", async () => {
    const event = {
      eventId: "run_nows:n:succeeded:1",
      runId: "run_nows",
      workflowId: "wf",
      revision: 0,
      nodeId: "n",
      status: "succeeded" as const,
      durationMs: 1,
      retries: 0,
      inputPreview: "{}",
      outputPreview: "{}",
      errorStack: null,
      createdAt: "2026-10-30T12:00:00.000Z",
    };
    await expect(insertStepEvent(db, event as never)).rejects.toBeInstanceOf(TelemetryWriteRefusedError);
    await expect(
      upsertRunRecord(db, { runId: "run_nows", workflowId: "wf", revision: 0, triggerType: "manual", status: "running", durationMs: 0, retries: 0, startedAt: "2026-10-30T12:00:00.000Z" } as never),
    ).rejects.toBeInstanceOf(TelemetryWriteRefusedError);
    await expect(upsertHttpRollup(db, { bucketMinute: "2026-10-30T12:00:00.000Z", requestCount: 1 } as never)).rejects.toBeInstanceOf(TelemetryWriteRefusedError);
    await expect(upsertQueueMetrics(db, { queueName: "q", depth: 1 } as never)).rejects.toBeInstanceOf(TelemetryWriteRefusedError);
    const leaked = await db.prepare("SELECT COUNT(*) AS c FROM px_step_events WHERE run_id = 'run_nows'").first<{ c: number }>();
    expect(Number(leaked?.c ?? 0)).toBe(0);
    expect(RunRecordSchema.safeParse({ runId: "r", workflowId: "w", revision: 0, status: "running", durationMs: 0, startedAt: "t" }).success).toBe(false);
  });

  test("story 1.4: older tables are upgraded in place (guarded ADD COLUMN and key rebuild) and keep every row", async () => {
    await db.batch([
      db.prepare("DROP VIEW IF EXISTS px_steps"),
      db.prepare("DROP TABLE IF EXISTS px_step_events"),
      db.prepare("DROP TABLE IF EXISTS px_runs"),
      db.prepare("DROP TABLE IF EXISTS px_http_rollups"),
      db.prepare("DROP TABLE IF EXISTS px_queue_metrics"),
      db.prepare("DROP TABLE IF EXISTS px_logs"),
      db.prepare(
        "CREATE TABLE px_runs (run_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, trigger_type TEXT NOT NULL DEFAULT 'manual', workspace_id TEXT NOT NULL DEFAULT 'ws_default', status TEXT NOT NULL, duration_ms REAL NOT NULL DEFAULT 0, retries INTEGER NOT NULL DEFAULT 0, retry_of_run_id TEXT, error_stack TEXT, started_at TEXT NOT NULL, ended_at TEXT)",
      ),
      db.prepare(
        "CREATE TABLE px_step_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL, workflow_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, node_id TEXT NOT NULL, status TEXT NOT NULL, duration_ms REAL NOT NULL DEFAULT 0, retries INTEGER NOT NULL DEFAULT 0, input_preview TEXT NOT NULL DEFAULT '{}', output_preview TEXT NOT NULL DEFAULT '{}', error_stack TEXT, created_at TEXT NOT NULL)",
      ),
      db.prepare("CREATE VIEW px_steps AS SELECT * FROM px_step_events"),
      db.prepare(
        "CREATE TABLE px_http_rollups (bucket_minute TEXT NOT NULL, route_prefix TEXT NOT NULL DEFAULT '/', brick_id TEXT NOT NULL DEFAULT 'runtime', request_count INTEGER NOT NULL DEFAULT 0, error_4xx_count INTEGER NOT NULL DEFAULT 0, error_5xx_count INTEGER NOT NULL DEFAULT 0, latency_buckets_json TEXT NOT NULL DEFAULT '{}', p50_ms REAL NOT NULL DEFAULT 0, p95_ms REAL NOT NULL DEFAULT 0, p99_ms REAL NOT NULL DEFAULT 0, d1_query_count INTEGER NOT NULL DEFAULT 0, d1_latency_ms REAL NOT NULL DEFAULT 0, d1_error_count INTEGER NOT NULL DEFAULT 0, env_name TEXT NOT NULL DEFAULT 'preview', PRIMARY KEY (bucket_minute, route_prefix, brick_id, env_name))",
      ),
      db.prepare(
        "CREATE TABLE px_queue_metrics (queue_name TEXT NOT NULL, pending_count INTEGER NOT NULL DEFAULT 0, dlq_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, env_name TEXT NOT NULL DEFAULT 'preview', PRIMARY KEY (queue_name, env_name))",
      ),
      db.prepare("INSERT INTO px_runs (run_id, workflow_id, status, started_at) VALUES ('run_legacy', 'wf', 'succeeded', '2026-10-01T00:00:00.000Z')"),
      db.prepare("INSERT INTO px_step_events (event_id, run_id, workflow_id, node_id, status, created_at) VALUES ('ev_legacy', 'run_legacy', 'wf', 'n', 'succeeded', '2026-10-01T00:00:00.000Z')"),
      db.prepare("INSERT INTO px_http_rollups (bucket_minute, request_count) VALUES ('2026-10-01T00:00:00.000Z', 7)"),
      db.prepare("INSERT INTO px_queue_metrics (queue_name, pending_count, updated_at) VALUES ('q_legacy', 3, '2026-10-01T00:00:00.000Z')"),
      // A stray copy from an interrupted rebuild does not block the next one.
      db.prepare("CREATE TABLE IF NOT EXISTS px_http_rollups_v2 (x TEXT)"),
    ]);

    forgetEnsuredTelemetryTables(db);
    await ensureTelemetryTables(db);
    forgetEnsuredTelemetryTables(db);
    await ensureTelemetryTables(db); // idempotent: the second pass finds the 1.4 keys and rebuilds nothing

    const cols = async (table: string) =>
      ((await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results ?? []).map((c) => c.name);
    expect(await cols("px_runs")).toContain("project_id");
    expect(await cols("px_step_events")).toEqual(expect.arrayContaining(["workspace_id", "project_id"]));
    expect(await cols("px_logs")).toContain("project_id");
    expect(await cols("px_http_rollups")).toEqual(expect.arrayContaining(["workspace_id", "project_id"]));
    expect(await cols("px_queue_metrics")).toEqual(expect.arrayContaining(["workspace_id", "project_id"]));

    const count = async (sql: string) => Number((await db.prepare(sql).first<{ c: number }>())?.c ?? 0);
    expect(await count("SELECT COUNT(*) AS c FROM px_runs WHERE run_id = 'run_legacy'")).toBe(1);
    // Existing workspaces are never rewritten: the run keeps the one it was stored with.
    expect(await count("SELECT COUNT(*) AS c FROM px_runs WHERE run_id = 'run_legacy' AND workspace_id = 'ws_default'")).toBe(1);
    expect((await listRunRecords(db, { workspaceId: "ws_default" })).map((r) => r.runId)).toEqual(["run_legacy"]);
    const pkCols = async (table: string) =>
      ((await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string; pk: number }>()).results ?? [])
        .filter((c) => c.pk > 0)
        .map((c) => c.name);
    expect(await pkCols("px_http_rollups")).toEqual(expect.arrayContaining(["workspace_id", "project_id"]));
    expect(await pkCols("px_queue_metrics")).toEqual(expect.arrayContaining(["workspace_id", "project_id"]));
    // A pre-1.4 step event takes its run's workspace.
    expect(await count("SELECT COUNT(*) AS c FROM px_step_events WHERE event_id = 'ev_legacy' AND workspace_id = 'ws_default'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS c FROM px_steps WHERE event_id = 'ev_legacy'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS c FROM px_http_rollups WHERE request_count = 7 AND workspace_id IS NULL")).toBe(1);
    expect(await count("SELECT COUNT(*) AS c FROM px_queue_metrics WHERE queue_name = 'q_legacy' AND workspace_id IS NULL")).toBe(1);

    // ...so it is read in that workspace only, and never by a project-scoped (Studio) read, since it has no project.
    expect((await listStepEventsForRun(db, "run_legacy", { workspaceId: "ws_default" })).map((e) => e.eventId)).toEqual(["ev_legacy"]);
    expect(await listStepEventsForRun(db, "run_legacy", { workspaceId: "ws_other" })).toEqual([]);
    expect(await listStepEventsForRun(db, "run_legacy", { projectId: "proj_a" })).toEqual([]);

    // The rebuilt keys include the workspace: two workspaces' rollups for the same minute are two rows.
    await upsertHttpRollup(db, { workspaceId: "ws_1", bucketMinute: "2026-10-30T12:00:00.000Z", requestCount: 1 });
    await upsertHttpRollup(db, { workspaceId: "ws_2", bucketMinute: "2026-10-30T12:00:00.000Z", requestCount: 2 });
    await upsertHttpRollup(db, { workspaceId: "ws_1", bucketMinute: "2026-10-30T12:00:00.000Z", requestCount: 5 });
    expect(await count("SELECT COUNT(*) AS c FROM px_http_rollups WHERE bucket_minute = '2026-10-30T12:00:00.000Z'")).toBe(2);
    expect(await count("SELECT request_count AS c FROM px_http_rollups WHERE workspace_id = 'ws_1' AND bucket_minute = '2026-10-30T12:00:00.000Z'")).toBe(5);
  });
});
