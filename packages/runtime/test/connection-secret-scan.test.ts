import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  IntegrationManifestSchema,
  assemble,
  projectIntegrationToNodes,
} from "@poc/assembler";
import type { Catalog, IntegrationManifestFile } from "@poc/assembler";
import { catalog as baseCatalog } from "@poc/assembler/catalog";
import { applyOps, createEmptyBlueprint, toAssemblerBlueprint } from "@poc/blueprint";
import { createMcpApp, createStaticTokenVerifier } from "@poc/mcp-server";
import type { D1Like } from "@poc/sdk";
import { ensureTelemetryTables, insertStructuredLog } from "@poc/telemetry";
import {
  buildExecutorsFromCatalog,
  buildRegistryFromCatalog,
  ensurePxConnectionsTable,
  rehearseStep,
  resetConnectionRefreshLocksForTest,
  runGraph,
  sealConnectionCredentials,
} from "../src/index.ts";

const CANARIES = {
  oauthAccess: "CANARY_OAUTH_ACCESS_9941_SECRET",
  oauthRefresh: "CANARY_OAUTH_REFRESH_8821_SECRET",
  apiKey: "CANARY_API_KEY_7731_SECRET",
  webhookSecret: "CANARY_WEBHOOK_SEC_6611_SECRET",
  cfClientId: "CANARY_CF_CLIENT_ID_5511_SECRET",
  cfClientSecret: "CANARY_CF_CLIENT_SEC_4401_SECRET",
} as const;

const ALL_CANARY_VALUES = Object.values(CANARIES);

function assertZeroCanaries(haystack: string, contextLabel: string): void {
  for (const canary of ALL_CANARY_VALUES) {
    expect(
      haystack.includes(canary),
      `Expected 0 occurrences of canary "${canary}" in ${contextLabel}`,
    ).toBe(false);
  }
}

const slackManifest: IntegrationManifestFile = IntegrationManifestSchema.parse({
  manifestVersion: 2,
  kind: "integration",
  app: "slack",
  version: "1.0.0",
  ui: {
    displayName: "Slack",
    category: "communication",
    summary: "Slack messaging integration",
    maturity: "production",
    behaviourTest: "test/slack.test.ts",
  },
  auth: {
    type: "oauth2",
    scopes: ["chat:write"],
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    headerName: "Authorization",
    prefix: "Bearer",
  },
  baseUrl: "https://slack.com/api",
  allowedHosts: ["slack.com", "api.slack.com"],
  operations: [
    {
      operationId: "post_message",
      label: "Post Message",
      summary: "Post a message to a Slack channel",
      method: "POST",
      path: "/chat.postMessage",
      params: [],
      body: {
        contentType: "application/json",
        fields: [
          { name: "channel", dataType: "string", required: true },
          { name: "text", dataType: "string", required: true },
        ],
      },
      response: {
        dataPath: "message",
        outputs: [
          { id: "ts", label: "Timestamp", dataType: "string" },
          { id: "channel", label: "Channel", dataType: "string" },
        ],
      },
      sideEffects: "write",
    },
  ],
  fidelity: {
    specHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    importerVersion: "2.0.0",
    level: "exact",
    unsupported: [],
  },
});

const resendManifest: IntegrationManifestFile = IntegrationManifestSchema.parse({
  manifestVersion: 2,
  kind: "integration",
  app: "resend",
  version: "1.0.0",
  ui: {
    displayName: "Resend",
    category: "communication",
    summary: "Resend transactional email integration",
    maturity: "production",
    behaviourTest: "test/resend.test.ts",
  },
  auth: {
    type: "apiKey",
    headerName: "X-Resend-Key",
  },
  baseUrl: "https://api.resend.com",
  allowedHosts: ["api.resend.com"],
  operations: [
    {
      operationId: "send_email",
      label: "Send Email",
      summary: "Send email via Resend",
      method: "POST",
      path: "/emails",
      params: [],
      body: {
        contentType: "application/json",
        fields: [
          { name: "to", dataType: "string", required: true },
          { name: "subject", dataType: "string", required: true },
        ],
      },
      response: {
        outputs: [{ id: "id", label: "Email ID", dataType: "string" }],
      },
      sideEffects: "write",
    },
  ],
  fidelity: {
    specHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    importerVersion: "2.0.0",
    level: "exact",
    unsupported: [],
  },
});

const cashfreeManifest: IntegrationManifestFile = IntegrationManifestSchema.parse({
  manifestVersion: 2,
  kind: "integration",
  app: "cashfree",
  version: "1.0.0",
  ui: {
    displayName: "Cashfree",
    category: "billing",
    summary: "Cashfree payment gateway integration",
    maturity: "production",
    behaviourTest: "test/cashfree.test.ts",
  },
  auth: {
    type: "headers",
    headers: {
      "x-client-id": "{{conn.clientId}}",
      "x-client-secret": "{{conn.clientSecret}}",
      "x-api-version": "2023-08-01",
    },
  },
  baseUrl: "https://sandbox.cashfree.com/pg",
  allowedHosts: ["sandbox.cashfree.com"],
  operations: [
    {
      operationId: "create_order",
      label: "Create Order",
      summary: "Create Cashfree order",
      method: "POST",
      path: "/orders",
      params: [],
      body: {
        contentType: "application/json",
        fields: [{ name: "order_id", dataType: "string", required: true }],
      },
      response: {
        outputs: [{ id: "order_id", label: "Order ID", dataType: "string" }],
      },
      sideEffects: "write",
    },
  ],
  fidelity: {
    specHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    importerVersion: "2.0.0",
    level: "exact",
    unsupported: [],
  },
});

describe("Story 10.2 — Canary Secret Scan Across Blueprints, Generated Code, D1 Tables, Logs, Traces & MCP (AD-S11, AD-S12, AD-S17)", () => {
  const db = (env as unknown as { DB: D1Like }).DB;
  const pxConnKey = "canary-secret-scan-master-key-2026";

  beforeEach(async () => {
    resetConnectionRefreshLocksForTest();
    await ensurePxConnectionsTable(db);
    await ensureTelemetryTables(db);
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS studio_connections_metadata (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          env_name TEXT NOT NULL DEFAULT 'all',
          ref TEXT NOT NULL,
          app TEXT NOT NULL,
          auth_type TEXT NOT NULL,
          label TEXT NOT NULL,
          scopes_json TEXT NOT NULL DEFAULT '[]',
          key_hint TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'connected',
          expires_at TEXT,
          last_checked_at TEXT,
          created_by TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(project_id, env_name, ref)
        )`,
      )
      .run();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS studio_connection_requests (
          request_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          app TEXT NOT NULL,
          reason TEXT NOT NULL,
          scopes_json TEXT NOT NULL DEFAULT '[]',
          suggested_ref TEXT NOT NULL,
          connect_url TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          requested_by TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
      )
      .run();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS mcp_rate (
          window TEXT PRIMARY KEY,
          calls INTEGER NOT NULL DEFAULT 0
        )`,
      )
      .run();
    await db.prepare("DELETE FROM px_connections").run();
    await db.prepare("DELETE FROM studio_connections_metadata").run();
    await db.prepare("DELETE FROM studio_connection_requests").run();
    await db.prepare("DELETE FROM px_runs").run();
    await db.prepare("DELETE FROM px_step_events").run();
    await db.prepare("DELETE FROM px_logs").run();
    await db.prepare("DELETE FROM px_http_rollups").run();
    await db.prepare("DELETE FROM px_queue_metrics").run();
  });

  it("plants 4 canary secrets, runs succeeding and failing (echoing 500) workflows, and verifies 0 canary leaks everywhere", async () => {
    const testCatalog: Catalog = {
      ...baseCatalog,
      integrations: {
        slack: {
          manifest: slackManifest,
          nodes: projectIntegrationToNodes(slackManifest),
        },
        resend: {
          manifest: resendManifest,
          nodes: projectIntegrationToNodes(resendManifest),
        },
        cashfree: {
          manifest: cashfreeManifest,
          nodes: projectIntegrationToNodes(cashfreeManifest),
        },
      },
    };
    const registry = buildRegistryFromCatalog(testCatalog);
    const executors = buildExecutorsFromCatalog(testCatalog, {
      integration: { fetcher: (input, init) => echoingUpstreamFetch(input, init) },
    });

    // 1. Seal all 4 canary secrets into px_connections and metadata into studio_connections_metadata
    const sealedOAuth = await sealConnectionCredentials(
      {
        app: "slack",
        authType: "oauth2",
        accessToken: CANARIES.oauthAccess,
        refreshToken: CANARIES.oauthRefresh,
        expiresAt: Date.now() + 3600_000,
        tokenUrl: "https://slack.com/api/oauth.v2.access",
      },
      pxConnKey,
    );
    await db
      .prepare(
        `INSERT INTO px_connections (
          ref, project_id, env_name, workspace_id, app, auth_type, scopes_json,
          ciphertext_b64, iv_b64, key_hint, status, updated_at
        ) VALUES (?, ?, ?, 'default', ?, ?, ?, ?, ?, ?, 'connected', datetime('now'))`,
      )
      .bind(
        "sec_slack_canary",
        "proj-canary",
        "preview",
        "slack",
        "oauth2",
        JSON.stringify(["chat:write"]),
        sealedOAuth.ciphertextB64,
        sealedOAuth.ivB64,
        sealedOAuth.keyHint,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO studio_connections_metadata (
          id, project_id, env_name, ref, app, auth_type, label, scopes_json, key_hint, status, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', 'usr_1')`,
      )
      .bind(
        "meta_slack",
        "proj-canary",
        "preview",
        "sec_slack_canary",
        "slack",
        "oauth2",
        "Slack OAuth",
        JSON.stringify(["chat:write"]),
        sealedOAuth.keyHint,
      )
      .run();

    const sealedApiKey = await sealConnectionCredentials(
      {
        app: "resend",
        authType: "api_key",
        apiKey: CANARIES.apiKey,
      },
      pxConnKey,
    );
    await db
      .prepare(
        `INSERT INTO px_connections (
          ref, project_id, env_name, workspace_id, app, auth_type, scopes_json,
          ciphertext_b64, iv_b64, key_hint, status, updated_at
        ) VALUES (?, ?, ?, 'default', ?, ?, '[]', ?, ?, ?, 'connected', datetime('now'))`,
      )
      .bind(
        "sec_resend_canary",
        "proj-canary",
        "preview",
        "resend",
        "api_key",
        sealedApiKey.ciphertextB64,
        sealedApiKey.ivB64,
        sealedApiKey.keyHint,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO studio_connections_metadata (
          id, project_id, env_name, ref, app, auth_type, label, scopes_json, key_hint, status, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, 'connected', 'usr_1')`,
      )
      .bind(
        "meta_resend",
        "proj-canary",
        "preview",
        "sec_resend_canary",
        "resend",
        "api_key",
        "Resend Key",
        sealedApiKey.keyHint,
      )
      .run();

    const sealedWebhook = await sealConnectionCredentials(
      {
        app: "stripe",
        authType: "hmac_webhook_only",
        webhookSecret: CANARIES.webhookSecret,
      },
      pxConnKey,
    );
    await db
      .prepare(
        `INSERT INTO px_connections (
          ref, project_id, env_name, workspace_id, app, auth_type, scopes_json,
          ciphertext_b64, iv_b64, key_hint, status, updated_at
        ) VALUES (?, ?, ?, 'default', ?, ?, '[]', ?, ?, ?, 'connected', datetime('now'))`,
      )
      .bind(
        "sec_stripe_canary",
        "proj-canary",
        "preview",
        "stripe",
        "hmac_webhook_only",
        sealedWebhook.ciphertextB64,
        sealedWebhook.ivB64,
        sealedWebhook.keyHint,
      )
      .run();

    const sealedCashfree = await sealConnectionCredentials(
      {
        app: "cashfree",
        authType: "headers",
        clientId: CANARIES.cfClientId,
        clientSecret: CANARIES.cfClientSecret,
      },
      pxConnKey,
    );
    await db
      .prepare(
        `INSERT INTO px_connections (
          ref, project_id, env_name, workspace_id, app, auth_type, scopes_json,
          ciphertext_b64, iv_b64, key_hint, status, updated_at
        ) VALUES (?, ?, ?, 'default', ?, ?, '[]', ?, ?, ?, 'connected', datetime('now'))`,
      )
      .bind(
        "sec_cashfree_canary",
        "proj-canary",
        "preview",
        "cashfree",
        "headers",
        sealedCashfree.ciphertextB64,
        sealedCashfree.ivB64,
        sealedCashfree.keyHint,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO studio_connections_metadata (
          id, project_id, env_name, ref, app, auth_type, label, scopes_json, key_hint, status, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, 'connected', 'usr_1')`,
      )
      .bind(
        "meta_cashfree",
        "proj-canary",
        "preview",
        "sec_cashfree_canary",
        "cashfree",
        "headers",
        "Cashfree Headers",
        sealedCashfree.keyHint,
      )
      .run();

    // 2. Build blueprint & ops log and assemble worker code
    const ops = [
      {
        opId: "op-0",
        type: "enable_brick",
        brickId: "multi-workspace",
        config: {},
      },
      {
        opId: "op-1",
        type: "enable_brick",
        brickId: "core-auth",
        config: {},
      },
      {
        opId: "op-2",
        type: "enable_brick",
        brickId: "webhook-gateway",
        config: {},
      },
      {
        opId: "op-3",
        type: "add_workflow",
        workflow: {
          id: "wf-canary-flow",
          name: "Canary Flow",
          trigger: { kind: "manual" as const },
          nodes: [
            {
              id: "trig",
              type: "core.webhook",
              label: "Trigger",
              data: { method: "post" },
            },
            {
              id: "slack_ok",
              type: "int:slack.post_message",
              label: "Slack Post",
              data: {
                connectionRef: "sec_slack_canary",
              },
            },
            {
              id: "resend_fail",
              type: "int:resend.send_email",
              label: "Resend Fail",
              data: {
                connectionRef: "sec_resend_canary",
              },
            },
            {
              id: "cashfree_ok",
              type: "int:cashfree.create_order",
              label: "Cashfree Order",
              data: {
                connectionRef: "sec_cashfree_canary",
              },
            },
          ],
          edges: [
            {
              id: "e0",
              source: "trig",
              sourceHandle: "out",
              target: "slack_ok",
              targetHandle: "in",
            },
            {
              id: "e1",
              source: "slack_ok",
              sourceHandle: "ts",
              target: "resend_fail",
              targetHandle: "subject",
            },
            {
              id: "e2",
              source: "trig",
              sourceHandle: "out",
              target: "cashfree_ok",
              targetHandle: "in",
            },
          ],
        },
      },
      {
        opId: "op-4",
        type: "bind_secret_ref",
        targetKind: "connection",
        targetId: "slack_ok",
        secretName: "CONNECTION_REF",
        ref: "sec_slack_canary",
      },
      {
        opId: "op-5",
        type: "bind_secret_ref",
        targetKind: "connection",
        targetId: "resend_fail",
        secretName: "CONNECTION_REF",
        ref: "sec_resend_canary",
      },
      {
        opId: "op-6",
        type: "bind_secret_ref",
        targetKind: "brick",
        targetId: "webhook-gateway",
        secretName: "WEBHOOK_SIGNING_SECRET",
        ref: "sec_stripe_canary",
      },
      {
        opId: "op-7",
        type: "bind_secret_ref",
        targetKind: "connection",
        targetId: "cashfree_ok",
        secretName: "CONNECTION_REF",
        ref: "sec_cashfree_canary",
      },
    ];
    const applied = applyOps(createEmptyBlueprint("proj-canary"), ops, testCatalog);
    if (!applied.ok) {
      throw new Error(`applyOps failed: ${JSON.stringify(applied.errors)}`);
    }
    expect(applied.ok).toBe(true);

    assertZeroCanaries(JSON.stringify(applied.state), "Blueprint JSON");
    assertZeroCanaries(JSON.stringify(ops), "Ops Log");

    const assembled = assemble(toAssemblerBlueprint(applied.state), testCatalog);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    assertZeroCanaries(JSON.stringify(assembled.files), "Generated Worker Source Files");

    // 3. Run workflow where slack_ok succeeds and resend_fail fails with an HTTP 500 echoing ALL canary secrets
    const echoingUpstreamFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const reqHeaders: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        reqHeaders[k.toLowerCase()] = v;
      });
      if (url.includes("slack.com")) {
        return new Response(
          JSON.stringify({
            ok: true,
            message: {
              ts: "1710000111.0001",
              channel: "#alerts",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("cashfree.com")) {
        expect(reqHeaders["x-client-id"]).toBe(CANARIES.cfClientId);
        expect(reqHeaders["x-client-secret"]).toBe(CANARIES.cfClientSecret);
        expect(reqHeaders["x-api-version"]).toBe("2023-08-01");
        return new Response(
          JSON.stringify({
            ok: true,
            order_id: "order_canary_123",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // Failing upstream 500 that maliciously echoes request headers and all 6 canary strings
      return new Response(
        JSON.stringify({
          error: "Upstream fatal crash",
          echoedHeaders: reqHeaders,
          leakedOAuthAccess: CANARIES.oauthAccess,
          leakedOAuthRefresh: CANARIES.oauthRefresh,
          leakedApiKey: CANARIES.apiKey,
          leakedWebhookSecret: CANARIES.webhookSecret,
          leakedCfClientId: CANARIES.cfClientId,
          leakedCfClientSecret: CANARIES.cfClientSecret,
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    };

    const runResult = await runGraph(
      {
        nodes: [
          { id: "trig", type: "trigger.manual", data: {} },
          {
            id: "slack_ok",
            type: "int:slack.post_message",
            data: {
              connectionRef: "sec_slack_canary",
            },
          },
          {
            id: "resend_fail",
            type: "int:resend.send_email",
            data: {
              connectionRef: "sec_resend_canary",
            },
          },
          {
            id: "cashfree_ok",
            type: "int:cashfree.create_order",
            data: {
              connectionRef: "sec_cashfree_canary",
              order_id: "order_canary_123",
            },
          },
        ],
        edges: [
          { id: "e0", source: "trig", target: "slack_ok" },
          { id: "e1", source: "slack_ok", target: "resend_fail" },
          { id: "e2", source: "trig", target: "cashfree_ok" },
        ],
      },
      registry,
      executors,
      {
        payload: {
          channel: "#alerts",
          text: "Hello world",
          to: "dev@example.com",
          subject: "Alert",
        },
        env: {
          DB: db,
          PX_CONN_KEY: pxConnKey,
          PX_PROJECT_ID: "proj-canary",
          PX_ENV: "preview",
        },
        telemetry: {
          db,
          runId: "run_canary_scan_1",
          workflowId: "wf-canary-flow",
          revision: 1,
          triggerType: "manual",
          workspaceId: "ws_canary",
          secretValues: [...ALL_CANARY_VALUES],
        },
      },
    );

    // Ensure runGraph step error & telemetry redacted any echoed canary strings
    const runResultStr = JSON.stringify(runResult);
    for (const canary of ALL_CANARY_VALUES) {
      expect(runResultStr.includes(canary)).toBe(false);
    }

    // Also run rehearseStep on the failing node and record a log event attempting to log canary values
    const rehearseRes = await rehearseStep(
      {
        nodeId: "resend_fail",
        nodeType: "int:resend.send_email",
        config: {
          connectionRef: "sec_resend_canary",
        },
        input: {
          to: "dev@example.com",
          subject: "Rehearse Alert",
        },
      },
      {
        registry,
        executors,
        db,
        runId: "run_canary_rehearse_1",
        secretValues: [...ALL_CANARY_VALUES],
        env: {
          DB: db,
          PX_CONN_KEY: pxConnKey,
          PX_PROJECT_ID: "proj-canary",
          PX_ENV: "preview",
        },
      },
    );
    assertZeroCanaries(JSON.stringify(rehearseRes), "rehearseStep response");

    await insertStructuredLog(
      db,
      {
        level: "error",
        workspaceId: "ws_canary",
        runId: "run_canary_scan_1",
        workflowId: "wf-canary-flow",
        nodeId: "resend_fail",
        message: `Upstream failure with tokens ${CANARIES.oauthAccess} ${CANARIES.oauthRefresh} ${CANARIES.apiKey} ${CANARIES.webhookSecret}`,
      },
      { secretValues: [...ALL_CANARY_VALUES] },
    );

    // 4. Scan every D1 table row-by-row for any occurrence of the 4 canary strings
    const tablesToScan = [
      "px_connections",
      "studio_connections_metadata",
      "studio_connection_requests",
      "px_runs",
      "px_step_events",
      "px_logs",
      "px_http_rollups",
      "px_queue_metrics",
    ];
    for (const table of tablesToScan) {
      const rows = await db.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>();
      const serialized = JSON.stringify(rows.results ?? []);
      assertZeroCanaries(serialized, `D1 table ${table}`);
    }

    // 5. Call MCP tools (list_connections, request_connection, get_run_trace, query_logs) and scan responses
    const mcpToken = "canary-mcp-token";
    const mcpApp = createMcpApp({
      catalog: testCatalog,
      callsPerMinute: 1000,
      verifyToken: createStaticTokenVerifier([
        { token: mcpToken, userId: "user:canary", projectId: "proj-canary", scopes: ["read", "edit", "connect"] },
      ]),
    });
    const callTool = async (name: string, args: Record<string, unknown>) => {
      const res = await mcpApp.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${mcpToken}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        }),
        { DB: db },
      );
      return await res.text();
    };

    const listConnsText = await callTool("list_connections", { project: "proj-canary" });
    assertZeroCanaries(listConnsText, "MCP list_connections transcript");

    const reqConnText = await callTool("request_connection", {
      project: "proj-canary",
      app: "slack",
      reason: "Post canary alerts",
    });
    assertZeroCanaries(reqConnText, "MCP request_connection transcript");

    const traceText = await callTool("get_run_trace", { runId: "run_canary_scan_1" });
    assertZeroCanaries(traceText, "MCP get_run_trace transcript");

    const logsText = await callTool("query_logs", { runId: "run_canary_scan_1" });
    assertZeroCanaries(logsText, "MCP query_logs transcript");
  });
});
