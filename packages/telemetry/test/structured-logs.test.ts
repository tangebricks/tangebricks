import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import type { D1Like } from "@poc/sdk";
import {
  PX_TELEMETRY_MIGRATION_SQL,
  REDACTED_PLACEHOLDER,
  TELEMETRY_SIGNATURE_HEADER,
  TelemetryScopeError,
  TelemetryWriteRefusedError,
  createStructuredLogger,
  ensureTelemetryTables,
  handleTelemetryLogsPullRequest,
  insertStructuredLog,
  queryStructuredLogs,
  signControlPlaneRequest,
  signTelemetryPayload,
} from "../src/index.ts";

const db = (env as unknown as { DB: D1Like }).DB;
const TELEMETRY_SECRET = "test_px_logs_hmac_secret_6_3";

describe("@poc/telemetry — Story 6.3 structured logs, redaction, correlation, and /__px/logs pull", () => {
  beforeEach(async () => {
    await ensureTelemetryTables(db);
    await db.batch([
      db.prepare("DELETE FROM px_logs"),
      db.prepare("DELETE FROM px_step_events"),
      db.prepare("DELETE FROM px_runs"),
    ]);
  });

  test("creates px_logs table with required columns and correlation indexes", async () => {
    expect(PX_TELEMETRY_MIGRATION_SQL).toContain("CREATE TABLE IF NOT EXISTS px_logs");
    expect(PX_TELEMETRY_MIGRATION_SQL).toContain("idx_px_logs_run_node");
    expect(PX_TELEMETRY_MIGRATION_SQL).toContain("idx_px_logs_workspace_brick");

    const indexRows = await db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'px_logs'",
      )
      .all<{ name: string; sql: string | null }>();
    const names = (indexRows.results ?? []).map((r) => r.name);
    expect(names).toContain("idx_px_logs_ts");
    expect(names).toContain("idx_px_logs_run_node");
    expect(names).toContain("idx_px_logs_workspace_brick");
    expect(names).toContain("idx_px_logs_level_ts");
  });

  test("ctx.log.{debug, info, warn, error} binds workflow step and brick route context and scrubs canary secrets before writing to px_logs or streaming", async () => {
    const CANARY_API_KEY = "sk_live_canary_secret_99887766";
    const CANARY_BEARER = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.canary_jwt_secret";
    const streamedEntries: unknown[] = [];

    // 1. Workflow step logger (simulating a workflow node executor)
    const stepLogger = createStructuredLogger({
      db,
      context: {
        runId: "run_wf_payment_01",
        workflowId: "wf_checkout",
        revision: 4,
        nodeId: "node_charge_wallet",
        brickId: "credit-wallet",
        workspaceId: "ws_alpha",
        requestId: "req_step_01",
        envName: "preview",
      },
      redactOptions: {
        secretValues: [CANARY_API_KEY],
      },
      onLog: (entry) => {
        streamedEntries.push(entry);
      },
    });

    await stepLogger.info("Starting wallet debit step", {
      amount: 250,
      authorization: `Bearer ${CANARY_BEARER}`,
    });

    await stepLogger.error(
      `Payment gateway timeout using key ${CANARY_API_KEY}`,
      {
        gateway: "razorpay",
        apiKey: CANARY_API_KEY,
        nested: {
          webhookSecret: "whsec_super_secret_value",
          authorization: `Bearer ${CANARY_BEARER}`,
        },
        errorStack: `Error: Gateway timeout (${CANARY_API_KEY}) at Authorization: Bearer ${CANARY_BEARER}\n    at chargeNode (workflow.ts:42:11)`,
      },
    );

    // 2. Brick route logger (simulating bricks/credit-wallet route handler)
    const brickRouteLogger = createStructuredLogger({
      db,
      context: {
        brickId: "credit-wallet",
        workspaceId: "ws_beta",
        requestId: "req_route_99",
        envName: "preview",
      },
      redactOptions: {
        secretValues: [CANARY_API_KEY],
      },
      onLog: (entry) => {
        streamedEntries.push(entry);
      },
    });

    await brickRouteLogger.warn("Insufficient balance on POST /wallet/deduct", {
      route: "POST /wallet/deduct",
      requestedAmount: 500,
      currentBalance: 120,
      cookie: "session_id=secret_cookie_val_12345",
    });

    await stepLogger.flush();
    await brickRouteLogger.flush();

    expect(streamedEntries).toHaveLength(3);
    const streamedJson = JSON.stringify(streamedEntries);
    expect(streamedJson).not.toContain(CANARY_API_KEY);
    expect(streamedJson).not.toContain(CANARY_BEARER);
    expect(streamedJson).not.toContain("whsec_super_secret_value");
    expect(streamedJson).not.toContain("secret_cookie_val_12345");
    expect(streamedJson).toContain(REDACTED_PLACEHOLDER);

    // Verify raw D1 rows in px_logs have exact correlation tags and zero leaked secrets
    const rawRows = await db
      .prepare("SELECT * FROM px_logs ORDER BY seq ASC")
      .all<Record<string, unknown>>();
    const rows = rawRows.results ?? [];
    expect(rows).toHaveLength(3);

    const rawDump = JSON.stringify(rows);
    expect(rawDump).not.toContain(CANARY_API_KEY);
    expect(rawDump).not.toContain(CANARY_BEARER);
    expect(rawDump).not.toContain("whsec_super_secret_value");
    expect(rawDump).toContain(REDACTED_PLACEHOLDER);

    const errRow = rows[1]!;
    expect(errRow.level).toBe("error");
    expect(errRow.run_id).toBe("run_wf_payment_01");
    expect(errRow.workflow_id).toBe("wf_checkout");
    expect(errRow.revision).toBe(4);
    expect(errRow.node_id).toBe("node_charge_wallet");
    expect(errRow.brick_id).toBe("credit-wallet");
    expect(errRow.workspace_id).toBe("ws_alpha");
    expect(errRow.request_id).toBe("req_step_01");
    expect(String(errRow.message)).toContain(REDACTED_PLACEHOLDER);
    expect(String(errRow.error_stack)).toContain(REDACTED_PLACEHOLDER);

    const routeRow = rows[2]!;
    expect(routeRow.level).toBe("warn");
    expect(routeRow.run_id).toBeNull();
    expect(routeRow.node_id).toBeNull();
    expect(routeRow.brick_id).toBe("credit-wallet");
    expect(routeRow.workspace_id).toBe("ws_beta");
    expect(routeRow.request_id).toBe("req_route_99");
  });

  test("supports multi-facet filtering and cursor tailing via queryStructuredLogs and HMAC-signed GET /__px/logs", async () => {
    const first = await insertStructuredLog(db, {
      level: "debug",
      message: "Loaded trigger payload",
      runId: "run_100",
      workflowId: "wf_main",
      revision: 1,
      nodeId: "node_trigger",
      brickId: "webhook-gateway",
      workspaceId: "ws_alpha",
      fields: { step: 1 },
    });
    const second = await insertStructuredLog(db, {
      level: "info",
      message: "Debited 25 credits for order ord_1",
      runId: "run_100",
      workflowId: "wf_main",
      revision: 1,
      nodeId: "node_debit",
      brickId: "credit-wallet",
      workspaceId: "ws_alpha",
      fields: { amount: 25 },
    });
    const third = await insertStructuredLog(db, {
      level: "error",
      message: "Payment gateway timeout on order ord_2",
      runId: "run_101",
      workflowId: "wf_main",
      revision: 2,
      nodeId: "node_debit",
      brickId: "credit-wallet",
      workspaceId: "ws_beta",
      fields: { orderId: "ord_2" },
      errorStack: "Error: ETIMEDOUT at credit-wallet.debit",
    });

    // Filter by level=error, inside ws_beta (every read is scoped, story 1.4)
    const onlyErrors = await queryStructuredLogs(db, { workspaceId: "ws_beta" }, { level: "error" });
    expect(onlyErrors.logs).toHaveLength(1);
    expect(onlyErrors.logs[0]!.logId).toBe(third.logId);
    // ws_alpha has no error line: ws_beta's is not visible from it
    expect((await queryStructuredLogs(db, { workspaceId: "ws_alpha" }, { level: "error" })).logs).toHaveLength(0);

    // Scope ws_alpha & brickId=credit-wallet
    const wsBrickFiltered = await queryStructuredLogs(db, { workspaceId: "ws_alpha" }, {
      brickId: "credit-wallet",
    });
    expect(wsBrickFiltered.logs).toHaveLength(1);
    expect(wsBrickFiltered.logs[0]!.logId).toBe(second.logId);

    // Filter by runId=run_100
    const runFiltered = await queryStructuredLogs(db, { workspaceId: "ws_alpha" }, { runId: "run_100" });
    expect(runFiltered.logs).toHaveLength(2);
    // run_101 is ws_beta's: asking for it from ws_alpha finds nothing
    expect((await queryStructuredLogs(db, { workspaceId: "ws_alpha" }, { runId: "run_101" })).logs).toHaveLength(0);

    // Free-text search q=ETIMEDOUT
    const searchFiltered = await queryStructuredLogs(db, { workspaceId: "ws_beta" }, { q: "ETIMEDOUT" });
    expect(searchFiltered.logs).toHaveLength(1);
    expect(searchFiltered.logs[0]!.logId).toBe(third.logId);

    // A read with no scope is a programming error, not a read of everything (there is no "all" bypass)
    await expect(queryStructuredLogs(db, {}, { level: "error" })).rejects.toBeInstanceOf(TelemetryScopeError);

    // A log line with neither a workspace nor a project stamp is refused
    await expect(insertStructuredLog(db, { level: "info", message: "orphan line" })).rejects.toBeInstanceOf(
      TelemetryWriteRefusedError,
    );

    // Unsigned request to GET /__px/logs is rejected with 401
    const unsignedRes = await handleTelemetryLogsPullRequest(
      new Request("https://worker.example/__px/logs?workspaceId=ws_beta&level=error"),
      { db, telemetrySecret: TELEMETRY_SECRET },
    );
    expect(unsignedRes?.status).toBe(401);

    // Signed request with facet filters and cursor tailing
    const url = new URL(
      `https://worker.example/__px/logs?env=preview&workspaceId=ws_beta&brickId=credit-wallet&level=error&after=${first.seq ?? 0}&limit=10`,
    );
    // The old body-only scheme over GET:<path and query> is refused
    const legacyRes = await handleTelemetryLogsPullRequest(
      new Request(url.toString(), {
        headers: { [TELEMETRY_SIGNATURE_HEADER]: await signTelemetryPayload(`GET:${url.pathname}${url.search}`, TELEMETRY_SECRET) },
      }),
      { db, telemetrySecret: TELEMETRY_SECRET, pxEnv: "preview" },
    );
    expect(legacyRes?.status).toBe(401);
    // A signature for ws_beta replayed with ws_alpha's query is refused
    const signed = await signControlPlaneRequest(TELEMETRY_SECRET, "GET", url);
    const swapped = new URL(url);
    swapped.searchParams.set("workspaceId", "ws_alpha");
    const swappedRes = await handleTelemetryLogsPullRequest(new Request(swapped.toString(), { headers: signed }), {
      db,
      telemetrySecret: TELEMETRY_SECRET,
      pxEnv: "preview",
    });
    expect(swappedRes?.status).toBe(401);

    const signedRes = await handleTelemetryLogsPullRequest(
      new Request(url.toString(), { headers: signed }),
      { db, telemetrySecret: TELEMETRY_SECRET, pxEnv: "preview" },
    );
    expect(signedRes?.status).toBe(200);
    const body = (await signedRes!.json()) as {
      ok: boolean;
      logs: Array<{ logId: string; runId: string; nodeId: string; level: string }>;
      nextCursor: number;
    };
    expect(body.ok).toBe(true);
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]!.logId).toBe(third.logId);
    expect(body.logs[0]!.runId).toBe("run_101");
    expect(body.logs[0]!.nodeId).toBe("node_debit");
    expect(body.nextCursor).toBe(third.seq);
  });
});
