import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import type { D1Like } from "@poc/sdk";
import {
  MAX_TOTAL_PREVIEW_BYTES,
  PX_TELEMETRY_MIGRATION_SQL,
  REDACTED_PLACEHOLDER,
  RunRecordSchema,
  StepEventSchema,
  TELEMETRY_SIGNATURE_HEADER,
  canonicalEventsCursorPayload,
  ensureTelemetryTables,
  getRunRecord,
  handleTelemetryEventsPullRequest,
  insertStepEvent,
  listRunRecords,
  listStepEventsAfterCursor,
  listStepEventsForRun,
  redactTelemetryPayload,
  signTelemetryPayload,
  truncateTelemetryPreview,
  upsertRunRecord,
  utf8ByteLength,
  verifyTelemetrySignature,
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

    const fetchedRun = await getRunRecord(db, "run_test_1");
    expect(fetchedRun?.workflowId).toBe("wf_orders");
    expect(fetchedRun?.revision).toBe(3);

    const runs = await listRunRecords(db, { workflowId: "wf_orders" });
    expect(runs).toHaveLength(1);

    const stepEvents = await listStepEventsForRun(db, "run_test_1");
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

  test("GET /__px/events?after=<cursor>&limit=<n> verifies HMAC-SHA256 signature and paginates missed events", async () => {
    const secret = "px-worker-telemetry-secret-key-2026";
    for (let i = 1; i <= 3; i += 1) {
      await insertStepEvent(db, {
        eventId: `run_cursor:node_${i}:succeeded:${i}`,
        runId: "run_cursor",
        workflowId: "wf_cursor",
        revision: 1,
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

    // Missing signature -> 401
    const unauthRes = await handleTelemetryEventsPullRequest(
      new Request("http://worker.local/__px/events?after=0&limit=2"),
      { db, telemetrySecret: secret },
    );
    expect(unauthRes?.status).toBe(401);

    // Forged signature -> 401
    const forgedRes = await handleTelemetryEventsPullRequest(
      new Request("http://worker.local/__px/events?after=0&limit=2", {
        headers: { [TELEMETRY_SIGNATURE_HEADER]: "deadbeef0123456789" },
      }),
      { db, telemetrySecret: secret },
    );
    expect(forgedRes?.status).toBe(401);

    // Valid signature -> 200 with page 1 (2 events)
    const sigPage1 = await signTelemetryPayload(
      canonicalEventsCursorPayload(0, 2),
      secret,
    );
    const validRes1 = await handleTelemetryEventsPullRequest(
      new Request("http://worker.local/__px/events?after=0&limit=2", {
        headers: { [TELEMETRY_SIGNATURE_HEADER]: sigPage1 },
      }),
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

    // Page 2 after nextCursor -> remaining 1 event
    const sigPage2 = await signTelemetryPayload(
      canonicalEventsCursorPayload(body1.nextCursor, 2),
      secret,
    );
    const validRes2 = await handleTelemetryEventsPullRequest(
      new Request(
        `http://worker.local/__px/events?after=${body1.nextCursor}&limit=2`,
        {
          headers: { [TELEMETRY_SIGNATURE_HEADER]: sigPage2 },
        },
      ),
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
});
