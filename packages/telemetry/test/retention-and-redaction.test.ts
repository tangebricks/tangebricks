import { env } from "cloudflare:workers";
import { runGraph } from "@poc/runtime";
import type { BrickManifest, D1Like, Executors, Registry } from "@poc/sdk";
import { z } from "zod";
import {
  REDACTED_PLACEHOLDER,
  SECRET_VALUE_PATTERNS,
  ensureTelemetryTables,
  insertStepEvent,
  insertStructuredLog,
  pruneExpiredTelemetryRuns,
  redactStructuredLogEntry,
  redactTelemetryPayload,
  redactTelemetryString,
  resolveConfigurableRunRetentionDays,
  resolveTelemetryRetentionDays,
  runScheduledTelemetryRetentionPrune,
  upsertHttpRollup,
  upsertRunRecord,
} from "../src/index.ts";
import { beforeEach, describe, expect, it } from "vitest";

const db = (env as unknown as { DB: D1Like }).DB;

describe("Story 8.2 — Configurable Retention, Step I/O Toggle & Redaction Audit (AC 3, AC 4)", () => {
  beforeEach(async () => {
    await ensureTelemetryTables(db);
    await db.batch([
      db.prepare("DELETE FROM px_step_events"),
      db.prepare("DELETE FROM px_runs"),
      db.prepare("DELETE FROM px_logs"),
      db.prepare("DELETE FROM px_http_rollups"),
    ]);
  });
  it("resolves configurable run retention (1..90d, default 14d) and telemetry retention (1..30d, default 7d)", () => {
    expect(resolveConfigurableRunRetentionDays(undefined)).toBe(14);
    expect(resolveConfigurableRunRetentionDays(1)).toBe(1);
    expect(resolveConfigurableRunRetentionDays(30)).toBe(30);
    expect(resolveConfigurableRunRetentionDays(180)).toBe(90);

    expect(resolveTelemetryRetentionDays(undefined)).toBe(7);
    expect(resolveTelemetryRetentionDays(1)).toBe(1);
    expect(resolveTelemetryRetentionDays(14)).toBe(14);
    expect(resolveTelemetryRetentionDays(60)).toBe(30);
  });

  it("prunes px_runs/px_step_events and px_logs/px_http_rollups using separate configurable windows", async () => {
    await ensureTelemetryTables(db);

    const fixedNow = new Date("2026-06-01T12:00:00.000Z");
    const daysAgoIso = (days: number) =>
      new Date(fixedNow.getTime() - days * 86_400_000).toISOString();

    // Seed runs at 16d, 10d, and 3d ago
    for (const [runId, days] of [
      ["run_16d", 16],
      ["run_10d", 10],
      ["run_3d", 3],
    ] as const) {
      const ts = daysAgoIso(days);
      await upsertRunRecord(db, {
        runId,
        workflowId: "wf_retention",
        revision: 1,
        triggerType: "manual",
        workspaceId: "ws_1",
        status: "succeeded",
        durationMs: 25,
        retries: 0,
        startedAt: ts,
        endedAt: ts,
      });
      await insertStepEvent(db, {
        eventId: `${runId}:step_1`,
        runId,
        workflowId: "wf_retention",
        revision: 1,
        nodeId: "step_1",
        status: "succeeded",
        durationMs: 20,
        retries: 0,
        inputPreview: '{"ok":true}',
        outputPreview: '{"done":true}',
        createdAt: ts,
      });
    }

    // Seed logs and HTTP rollups at 10d, 6d, and 2d ago
    for (const [idSuffix, days] of [
      ["10d", 10],
      ["6d", 6],
      ["2d", 2],
    ] as const) {
      const ts = daysAgoIso(days);
      await insertStructuredLog(db, {
        logId: `log_${idSuffix}`,
        ts,
        level: "info",
        message: `Log entry ${idSuffix}`,
      });
      await upsertHttpRollup(db, {
        bucketMinute: ts,
        routePrefix: "/api",
        brickId: "core",
        requestCount: 10,
      });
    }

    // Default windows: runRetentionDays = 14, telemetryRetentionDays = 7
    const defaultPrune = await pruneExpiredTelemetryRuns(db, {
      now: fixedNow,
    });
    expect(defaultPrune.runRetentionDays).toBe(14);
    expect(defaultPrune.telemetryRetentionDays).toBe(7);
    expect(defaultPrune.deletedRuns).toBe(1); // run_16d deleted, run_10d and run_3d preserved
    expect(defaultPrune.deletedStepEvents).toBe(1);
    expect(defaultPrune.deletedLogs).toBe(1); // log_10d deleted (< 7d cutoff), log_6d and log_2d preserved
    expect(defaultPrune.deletedHttpRollups).toBe(1); // 10d rollup deleted

    // Verify px_steps view mirrors px_step_events
    const stepsViaView = await db
      .prepare("SELECT run_id FROM px_steps ORDER BY run_id ASC")
      .all<{ run_id: string }>();
    expect((stepsViaView.results ?? []).map((r) => r.run_id)).toEqual([
      "run_10d",
      "run_3d",
    ]);

    // Custom windows via scheduled cron: runRetentionDays = 7, telemetryRetentionDays = 4
    const customPrune = await runScheduledTelemetryRetentionPrune(
      { scheduledTime: fixedNow.getTime() },
      { DB: db },
      {
        runRetentionDays: 7,
        telemetryRetentionDays: 4,
      },
    );
    expect(customPrune.deletedRuns).toBe(1); // run_10d deleted, only run_3d remains
    expect(customPrune.deletedStepEvents).toBe(1);
    expect(customPrune.deletedLogs).toBe(1); // log_6d deleted, only log_2d remains
    expect(customPrune.deletedHttpRollups).toBe(1);

    const remainingRuns = await db
      .prepare("SELECT run_id FROM px_runs")
      .all<{ run_id: string }>();
    expect((remainingRuns.results ?? []).map((r) => r.run_id)).toEqual([
      "run_3d",
    ]);

    const remainingLogs = await db
      .prepare("SELECT log_id FROM px_logs")
      .all<{ log_id: string }>();
    expect((remainingLogs.results ?? []).map((r) => r.log_id)).toEqual([
      "log_2d",
    ]);
  });

  it("omits step input_preview and output_preview in production when captureStepIoInProd is false while preserving status, durationMs, retries, and errorStack", async () => {
    await ensureTelemetryTables(db);

    const sensitiveInput = "SENSITIVE_PROD_PAYLOAD_VALUE_999";
    const sensitiveOutput = "SENSITIVE_PROD_OUTPUT_VALUE_888";

    const registry: Registry = new Map<string, BrickManifest>([
      [
        "test.trigger",
        {
          type: "test.trigger",
          label: "Trigger",
          category: "trigger",
          inputs: [],
          outputs: [{ id: "out", dataType: "any" }],
          configSchema: z.object({}).passthrough(),
          secrets: [],
        },
      ],
      [
        "test.worker",
        {
          type: "test.worker",
          label: "Worker",
          category: "action",
          inputs: [{ id: "in", dataType: "any" }],
          outputs: [{ id: "out", dataType: "any" }],
          configSchema: z.object({}).passthrough(),
          secrets: [],
        },
      ],
    ]);

    const executors: Executors = new Map([
      [
        "test.trigger",
        async (ctx) => ({ out: ctx.payload }),
      ],
      [
        "test.worker",
        async () => ({
          out: { customerData: sensitiveOutput },
        }),
      ],
    ]);

    const graph = {
      nodes: [
        { id: "n_trig", type: "test.trigger", data: { note: sensitiveInput } },
        { id: "n_work", type: "test.worker", data: { query: sensitiveInput } },
      ],
      edges: [{ id: "e1", source: "n_trig", target: "n_work" }],
    };

    const prodRun = await runGraph(graph, registry, executors, { workspaceId: "ws_test",
      payload: { rawCustomerPayload: sensitiveInput },
      env: { DB: db, PX_ENV: "production" },
      telemetry: {
        db,
        runId: "run_prod_no_io",
        envName: "production",
        captureStepIoInProd: false,
      },
    });

    expect(prodRun.ok).toBe(true);

    const stepRows = await db
      .prepare("SELECT * FROM px_steps WHERE run_id = ?1 ORDER BY seq ASC")
      .bind("run_prod_no_io")
      .all<{
        node_id: string;
        status: string;
        duration_ms: number;
        retries: number;
        input_preview: string;
        output_preview: string;
      }>();

    expect((stepRows.results ?? []).length).toBeGreaterThan(0);
    for (const row of stepRows.results ?? []) {
      expect(row.input_preview).toBe("{}");
      expect(row.output_preview).toBe("{}");
      expect(row.input_preview).not.toContain(sensitiveInput);
      expect(row.output_preview).not.toContain(sensitiveOutput);
      expect(typeof row.duration_ms).toBe("number");
      expect(typeof row.retries).toBe("number");
    }

    // Preview environment still captures step I/O even when captureStepIoInProd is false
    await runGraph(graph, registry, executors, { workspaceId: "ws_test",
      payload: { rawCustomerPayload: sensitiveInput },
      env: { DB: db, PX_ENV: "preview" },
      telemetry: {
        db,
        runId: "run_preview_with_io",
        envName: "preview",
        captureStepIoInProd: false,
      },
    });

    const previewRows = await db
      .prepare(
        "SELECT * FROM px_steps WHERE run_id = ?1 AND status = 'succeeded'",
      )
      .bind("run_preview_with_io")
      .all<{ input_preview: string; output_preview: string }>();
    expect(
      (previewRows.results ?? []).some((r) =>
        r.output_preview.includes(sensitiveOutput),
      ),
    ).toBe(true);
  });

  it("redacts ctx.secret(), ctx.connection(), widget='secret' fields, default secret keys, and additionalRedactKeys with zero leaks across D1 tables (AC 4)", async () => {
    await ensureTelemetryTables(db);

    const canaryEnvSecret = "sk_live_ENV_SECRET_CANARY_111111";
    const canaryConnAccessToken = "xoxb_CONN_ACCESS_TOKEN_CANARY_222222";
    const canaryConnRefreshToken = "xoxr_CONN_REFRESH_TOKEN_CANARY_333333";
    const canaryWidgetSecret = "whsec_WIDGET_SECRET_CANARY_444444";
    const canaryDefaultKeyHeader = "Bearer eyJ_HEADER_TOKEN_CANARY_555555";
    const canaryCustomSsn = "999-88-7777-CUSTOM-SSN-CANARY";
    const canaryCustomTaxId = "TAX-ID-CANARY-666666";

    const registry: Registry = new Map<string, BrickManifest>([
      [
        "audit.trigger",
        {
          type: "audit.trigger",
          label: "Audit Trigger",
          category: "trigger",
          inputs: [],
          outputs: [{ id: "out", dataType: "any" }],
          configSchema: z.object({}).passthrough(),
          secrets: [],
        },
      ],
      [
        "audit.FailingAction",
        {
          type: "audit.FailingAction",
          label: "Failing Action",
          category: "action",
          inputs: [{ id: "in", dataType: "any" }],
          outputs: [{ id: "out", dataType: "any" }],
          configSchema: z.object({}).passthrough(),
          secrets: ["STRIPE_SECRET_KEY"],
          secretFields: ["webhookSigningSecret"],
        },
      ],
    ]);

    const executors: Executors = new Map([
      [
        "audit.trigger",
        async (ctx) => ({ out: ctx.payload }),
      ],
      [
        "audit.FailingAction",
        async (ctx) => {
          const envSec = ctx.secret("STRIPE_SECRET_KEY");
          const conn = (await ctx.connection?.("slack_conn")) ?? {};
          await ctx.log?.info(
            `Calling upstream with ${envSec} and ${String(conn.access_token)}`,
            {
              authorization: canaryDefaultKeyHeader,
              ssn: canaryCustomSsn,
              nested: {
                customerTaxId: canaryCustomTaxId,
              },
            },
          );
          throw new Error(
            `Upstream failed for secret=${envSec} token=${String(conn.access_token)} refresh=${String(conn.refresh_token)} ssn=${canaryCustomSsn}`,
          );
        },
      ],
    ]);

    const graph = {
      nodes: [
        { id: "t1", type: "audit.trigger", data: {} },
        {
          id: "a1",
          type: "audit.FailingAction",
          data: {
            webhookSigningSecret: canaryWidgetSecret,
            ssn: canaryCustomSsn,
            customerTaxId: canaryCustomTaxId,
          },
        },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };

    const res = await runGraph(graph, registry, executors, { workspaceId: "ws_test",
      payload: {
        authorization: canaryDefaultKeyHeader,
        ssn: canaryCustomSsn,
        customerTaxId: canaryCustomTaxId,
      },
      env: {
        DB: db,
        STRIPE_SECRET_KEY: canaryEnvSecret,
      },
      connections: {
        slack_conn: {
          access_token: canaryConnAccessToken,
          refresh_token: canaryConnRefreshToken,
        },
      },
      telemetry: {
        db,
        runId: "run_redaction_audit",
        additionalRedactKeys: ["ssn", "customerTaxId"],
      },
    });

    expect(res.ok).toBe(false);

    const allRuns = await db.prepare("SELECT * FROM px_runs").all();
    const allSteps = await db.prepare("SELECT * FROM px_steps").all();
    const allLogs = await db.prepare("SELECT * FROM px_logs").all();

    const fullDump = JSON.stringify({
      runs: allRuns.results,
      steps: allSteps.results,
      logs: allLogs.results,
      runRecord: res.runRecord,
      stepEvents: res.stepEvents,
      emittedLogs: res.logs,
      failed: res.failed,
    });

    for (const canary of [
      canaryEnvSecret,
      canaryConnAccessToken,
      canaryConnRefreshToken,
      canaryWidgetSecret,
      "eyJ_HEADER_TOKEN_CANARY_555555",
      canaryCustomSsn,
      canaryCustomTaxId,
    ]) {
      expect(fullDump).not.toContain(canary);
    }
    expect(fullDump).toContain(REDACTED_PLACEHOLDER);

    // Direct unit check on redactTelemetryPayload & redactStructuredLogEntry with additionalRedactKeys
    const redactedObj = redactTelemetryPayload(
      {
        SSN: canaryCustomSsn,
        customerTaxId: canaryCustomTaxId,
        safeField: "visible_value",
      },
      { additionalRedactKeys: ["ssn", "customertaxid"] },
    ) as Record<string, unknown>;
    expect(redactedObj.SSN).toBe(REDACTED_PLACEHOLDER);
    expect(redactedObj.customerTaxId).toBe(REDACTED_PLACEHOLDER);
    expect(redactedObj.safeField).toBe("visible_value");

    const redactedLog = redactStructuredLogEntry(
      {
        level: "warn",
        message: `Leak attempt ${canaryCustomSsn}`,
        fields: { ssn: canaryCustomSsn, ok: 1 },
      },
      { additionalRedactKeys: ["ssn"] },
    );
    expect(redactedLog.message).not.toContain(canaryCustomSsn);
    expect(redactedLog.fields.ssn).toBe(REDACTED_PLACEHOLDER);
  });

  it("scrubs each pattern in SECRET_VALUE_PATTERNS while keeping UUIDs, ISO dates, and 40-hex SHAs (UC1.5 AC2, AC3)", () => {
    const patternsToTest = [
      {
        name: "JWT (eyJ...)",
        secret: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
        text: "User session token is eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c in header",
      },
      {
        name: "sk_live_",
        secret: "sk_" + "live_51Hxxxxxxxxxxxxxxxxxxxxxxx",
        text: "Stripe live key sk_" + "live_51Hxxxxxxxxxxxxxxxxxxxxxxx leaked",
      },
      {
        name: "sk_test_",
        secret: "sk_" + "test_51Hyyyyyyyyyyyyyyyyyyyyyyy",
        text: "Stripe test key sk_" + "test_51Hyyyyyyyyyyyyyyyyyyyyyyy leaked",
      },
      {
        name: "rk_live_",
        secret: "rk_" + "live_51Hzzzzzzzzzzzzzzzzzzzzzzz",
        text: "Stripe restricted live key rk_" + "live_51Hzzzzzzzzzzzzzzzzzzzzzzz leaked",
      },
      {
        name: "rk_test_",
        secret: "rk_" + "test_51Hwwwwwwwwwwwwwwwwwwwwwww",
        text: "Stripe restricted test key rk_" + "test_51Hwwwwwwwwwwwwwwwwwwwwwww leaked",
      },
      {
        name: "whsec_",
        secret: "whs" + "ec_1234567890abcdef1234567890abcdef",
        text: "Webhook signing secret whs" + "ec_1234567890abcdef1234567890abcdef in config",
      },
      {
        name: "xox[abposr]-",
        secret: "xox" + "b-123456789-987654321-abcdef123456",
        text: "Slack bot token xox" + "b-123456789-987654321-abcdef123456 in log",
      },
      {
        name: "gh[pousr]_[A-Za-z0-9]{36,}",
        secret: "ghp" + "_0123456789abcdef0123456789abcdef0123",
        text: "GitHub token ghp" + "_0123456789abcdef0123456789abcdef0123 in url",
      },
      {
        name: "github_pat_",
        secret: "git" + "hub_pat_11AAAAAAA0000000000000_123456789012345678901234567890",
        text: "Fine-grained PAT git" + "hub_pat_11AAAAAAA0000000000000_123456789012345678901234567890 in error",
      },
      {
        name: "AKIA[0-9A-Z]{16}",
        secret: "AKI" + "AIOSFODNN7EXAMPLE",
        text: "AWS access key AKI" + "AIOSFODNN7EXAMPLE reported",
      },
      {
        name: "AIza[0-9A-Za-z_-]{35}",
        secret: "AIz" + "aSyA12345678901234567890123456789012",
        text: "Google API key AIz" + "aSyA12345678901234567890123456789012 found",
      },
      {
        name: "PEM private key",
        secret: "---" + "--BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
        text: "Private key cert: ---" + "--BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY----- attached",
      },
    ];

    expect(SECRET_VALUE_PATTERNS.length).toBeGreaterThanOrEqual(10);

    for (const item of patternsToTest) {
      // Test string scrubbing
      const scrubbedStr = redactTelemetryString(item.text);
      expect(scrubbedStr).not.toContain(item.secret);
      expect(scrubbedStr).toMatch(/\[REDACTED:[a-z_]+\]/);

      // Test payload scrubbing on nested object
      const scrubbedPayload = redactTelemetryPayload({
        info: item.text,
        nested: { key: item.secret },
      }) as { info: string; nested: { key: string } };

      expect(scrubbedPayload.info).not.toContain(item.secret);
      expect(scrubbedPayload.info).toMatch(/\[REDACTED:[a-z_]+\]/);
      expect(scrubbedPayload.nested.key).toMatch(/\[REDACTED:[a-z_]+\]/);
    }

    // False-positive guard: UUIDs, ISO dates, and 40-hex SHAs are preserved (AC3)
    const validUuid = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
    const validIsoDate = "2026-11-04T07:30:00.000Z";
    const valid40HexSha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

    const nonSecretText = `Deployment ${valid40HexSha} succeeded at ${validIsoDate} for instance ${validUuid}`;
    const preserved = redactTelemetryString(nonSecretText);
    expect(preserved).toBe(nonSecretText);
    expect(preserved).toContain(validUuid);
    expect(preserved).toContain(validIsoDate);
    expect(preserved).toContain(valid40HexSha);

    const preservedPayload = redactTelemetryPayload({
      deploymentSha: valid40HexSha,
      timestamp: validIsoDate,
      instanceId: validUuid,
    }) as { deploymentSha: string; timestamp: string; instanceId: string };

    expect(preservedPayload.deploymentSha).toBe(valid40HexSha);
    expect(preservedPayload.timestamp).toBe(validIsoDate);
    expect(preservedPayload.instanceId).toBe(validUuid);
  });
});
