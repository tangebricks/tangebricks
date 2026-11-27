import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { IntegrationManifestSchema, projectIntegrationToNodes } from "@poc/assembler";
import type { Catalog, IntegrationManifestFile } from "@poc/assembler";
import { catalog as baseCatalog } from "@poc/assembler/catalog";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { ensureTelemetryTables } from "@poc/telemetry";
import { WebhookService, createWebhookRoutes, signStripeWebhookPayload } from "../../../bricks/webhook-gateway/src/index.ts";
import type { WebhookGatewayAdapter } from "../../../bricks/webhook-gateway/src/gateway.ts";
import type { WebhookEnv } from "../../../bricks/webhook-gateway/src/routes.ts";
import webhookGatewayMigration from "../../../bricks/webhook-gateway/migrations/0001_webhook_gateway.sql?raw";
import {
  buildExecutorsFromCatalog,
  buildRegistryFromCatalog,
  ensurePxConnectionsTable,
  resetConnectionRefreshLocksForTest,
  runGraph,
  sealConnectionCredentials,
  unsealConnectionCredentials,
} from "../src/index.ts";

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
          { id: "text", label: "Text", dataType: "string" },
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

function withIntegrations(integrations: Record<string, IntegrationManifestFile>): Catalog {
  return {
    ...baseCatalog,
    integrations: Object.fromEntries(Object.entries(integrations).map(([app, manifest]) => [app, { manifest, nodes: projectIntegrationToNodes(manifest) }])),
  };
}

describe("Story 10.2 — Case A Connections, OAuth2 Auto-Refresh & Webhook Gateway E2E (workerd)", () => {
  const db = (env as unknown as { DB: D1Like }).DB;
  const pxConnKey = "case-a-workerd-master-conn-key-2026";

  beforeEach(async () => {
    resetConnectionRefreshLocksForTest();
    for (const table of ["px_webhook_deliveries", "wh_subscriptions", "px_connections", "wh_deliveries", "wh_endpoints"]) {
      await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
    }
    await applyMigration(db, webhookGatewayMigration);
    await ensurePxConnectionsTable(db);
    await ensureTelemetryTables(db);
    await db.prepare("DELETE FROM px_logs").run();
    await db.prepare("DELETE FROM px_runs").run();
    await db.prepare("DELETE FROM px_step_events").run();
  });

  it("verifies signed Stripe webhook, triggers GraphWorkflow that auto-refreshes expiring OAuth2 Slack token in px_connections, and deduplicates webhook retries", async () => {
    const testCatalog = withIntegrations({ slack: slackManifest });
    const registry = buildRegistryFromCatalog(testCatalog);

    // 1. Seal Stripe webhook secret into px_connections
    const stripeSealed = await sealConnectionCredentials(
      {
        app: "stripe",
        authType: "hmac_webhook_only",
        webhookSecret: "whsec_case_a_stripe_live_9900",
      },
      pxConnKey,
    );
    await db
      .prepare(
        `INSERT INTO px_connections (
          ref, project_id, env_name, workspace_id, app, auth_type, scopes_json,
          ciphertext_b64, iv_b64, key_hint, status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', datetime('now'))`,
      )
      .bind(
        "sec_stripe_wh",
        "proj-case-a",
        "preview",
        "ws_case_a",
        "stripe",
        "hmac_webhook_only",
        "[]",
        stripeSealed.ciphertextB64,
        stripeSealed.ivB64,
        stripeSealed.keyHint,
      )
      .run();

    // 2. Seal expiring Slack OAuth2 connection (expires in 25 seconds, within 60s window)
    const expiringMs = Date.now() + 25_000;
    const slackSealed = await sealConnectionCredentials(
      {
        app: "slack",
        authType: "oauth2",
        accessToken: "xox" + "b-expiring-token-old-1111",
        refreshToken: "xox" + "r-valid-refresh-token-2222",
        expiresAt: expiringMs,
        tokenUrl: "https://slack.com/api/oauth.v2.access",
        clientId: "slack_client_id",
        clientSecret: "slack_client_secret",
      },
      pxConnKey,
    );
    await db
      .prepare(
        `INSERT INTO px_connections (
          ref, project_id, env_name, workspace_id, app, auth_type, scopes_json,
          ciphertext_b64, iv_b64, key_hint, status, expires_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?, datetime('now'))`,
      )
      .bind(
        "sec_slack_oauth",
        "proj-case-a",
        "preview",
        "ws_case_a",
        "slack",
        "oauth2",
        JSON.stringify(["chat:write"]),
        slackSealed.ciphertextB64,
        slackSealed.ivB64,
        slackSealed.keyHint,
        expiringMs,
      )
      .run();

    let refreshCallCount = 0;
    const slackApiHeaders: Array<Record<string, string>> = [];
    const workflowRuns: Array<{ runId: string; outputs: Record<string, unknown> }> = [];

    const mockOAuthFetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://slack.com/api/oauth.v2.access") {
        refreshCallCount += 1;
        const bodyText = String(init?.body ?? "");
        expect(bodyText).toContain("grant_type=refresh_token");
        expect(bodyText).toContain("refresh_token=xox" + "r-valid-refresh-token-2222");
        return new Response(
          JSON.stringify({
            access_token: "xox" + "b-refreshed-fresh-token-9999",
            refresh_token: "xox" + "r-rotated-refresh-token-8888",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    const mockUpstreamFetch: typeof fetch = async (_input, init) => {
      const headersObj: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headersObj[k.toLowerCase()] = v;
      });
      slackApiHeaders.push(headersObj);
      return new Response(
        JSON.stringify({
          ok: true,
          message: {
            ts: "1710000999.000100",
            channel: "#billing",
            text: "Invoice Paid: evt_inv_paid_102",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    // 3. Configure Webhook Gateway whose adapter runs the GraphWorkflow
    const runExecutors = buildExecutorsFromCatalog(testCatalog, {
      integration: { fetcher: mockUpstreamFetch },
    });
    const adapter: WebhookGatewayAdapter = {
      onTriggerWorkflow: async (input) => {
        const runId = `run_wh_${workflowRuns.length + 1}`;
        const graph = {
          nodes: [
            { id: "trig", type: "trigger.manual", data: {} },
            {
              id: "post_slack",
              type: "int:slack.post_message",
              data: {
                connectionRef: "sec_slack_oauth",
              },
            },
          ],
          edges: [{ id: "e1", source: "trig", target: "post_slack" }],
        };
        const result = await runGraph(graph, registry, runExecutors, {
          workspaceId: "ws_case_a", // the connection's own workspace (story 1.17)
          payload: {
            channel: "#billing",
            text: `Invoice Paid: ${input.providerEventId}`,
          },
          env: {
            DB: db,
            PX_CONN_KEY: pxConnKey,
            PX_PROJECT_ID: "proj-case-a",
            PX_ENV: "preview",
            __OAUTH_FETCHER: mockOAuthFetcher,
          },
        });
        expect(result.failed).toEqual({});
        workflowRuns.push({ runId, outputs: result.outputs });
        return { runId };
      },
    };

    const app = new Hono<WebhookEnv>();
    app.route("/api", createWebhookRoutes({ adapter }));

    const service = new WebhookService(db);
    await service.registerSubscription({
      id: "sub_stripe_case_a",
      workspaceId: "ws_case_a",
      app: "stripe",
      triggerId: "invoice.paid",
      workflowId: "wf_stripe_to_slack",
      connectionRef: "sec_stripe_wh",
      verificationScheme: "stripe-signature",
      signatureHeader: "Stripe-Signature",
      eventIdPath: "$.id",
    });

    const rawBody = JSON.stringify({
      id: "evt_inv_paid_102",
      type: "invoice.paid",
      amount: 4900,
    });
    const nowSec = Math.floor(Date.now() / 1000);
    const stripeSigHeader = await signStripeWebhookPayload(rawBody, "whsec_case_a_stripe_live_9900", nowSec);

    // First delivery -> verifies signature, runs workflow, refreshes Slack OAuth2 token, calls Slack API
    const firstRes = await app.fetch(
      new Request("http://localhost/api/webhooks/in/sub_stripe_case_a", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": stripeSigHeader,
        },
        body: rawBody,
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    expect(firstRes.status).toBe(200);
    const firstJson = (await firstRes.json()) as {
      received: boolean;
      deduplicated: boolean;
      runId: string;
    };
    expect(firstJson.received).toBe(true);
    expect(firstJson.deduplicated).toBe(false);
    expect(workflowRuns).toHaveLength(1);
    expect(refreshCallCount).toBe(1);
    expect(slackApiHeaders).toHaveLength(1);
    expect(slackApiHeaders[0]?.authorization).toBe("Bearer xox" + "b-refreshed-fresh-token-9999");

    // Verify re-sealed credentials in px_connections have the new token and updated status
    const updatedRow = await db
      .prepare("SELECT ciphertext_b64, iv_b64, status FROM px_connections WHERE ref = ?")
      .bind("sec_slack_oauth")
      .first<{ ciphertext_b64: string; iv_b64: string; status: string }>();
    expect(updatedRow?.status).toBe("connected");
    const unsealedAfter = await unsealConnectionCredentials(updatedRow!.ciphertext_b64, updatedRow!.iv_b64, pxConnKey);
    expect(unsealedAfter.accessToken).toBe("xox" + "b-refreshed-fresh-token-9999");
    expect(unsealedAfter.refreshToken).toBe("xox" + "r-rotated-refresh-token-8888");

    // Second delivery with identical event id -> deduplicated, no duplicate workflow run!
    const retryRes = await app.fetch(
      new Request("http://localhost/api/webhooks/in/sub_stripe_case_a", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": stripeSigHeader,
        },
        body: rawBody,
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    expect(retryRes.status).toBe(200);
    const retryJson = (await retryRes.json()) as {
      received: boolean;
      deduplicated: boolean;
    };
    expect(retryJson).toMatchObject({
      received: true,
      deduplicated: true,
    });
    expect(workflowRuns).toHaveLength(1);
  });

  it("marks connection status = 'expired', emits connection.expired telemetry, and fails step with CONNECTION_EXPIRED when OAuth2 refresh returns 400 invalid_grant", async () => {
    const testCatalog = withIntegrations({ slack: slackManifest });
    const registry = buildRegistryFromCatalog(testCatalog);
    const executors = buildExecutorsFromCatalog(testCatalog);

    const expiringMs = Date.now() + 10_000;
    const sealed = await sealConnectionCredentials(
      {
        app: "slack",
        authType: "oauth2",
        accessToken: "xox" + "b-expired-token-0000",
        refreshToken: "xox" + "r-revoked-refresh-token-0000",
        expiresAt: expiringMs,
        tokenUrl: "https://slack.com/api/oauth.v2.access",
      },
      pxConnKey,
    );
    await db
      .prepare(
        `INSERT INTO px_connections (
          ref, project_id, env_name, workspace_id, app, auth_type, scopes_json,
          ciphertext_b64, iv_b64, key_hint, status, expires_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?, datetime('now'))`,
      )
      .bind("sec_slack_revoked", "proj-case-a", "preview", "ws_case_a", "slack", "oauth2", "[]", sealed.ciphertextB64, sealed.ivB64, sealed.keyHint, expiringMs)
      .run();

    const failingOAuthFetcher: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Token has been expired or revoked",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );

    const graph = {
      nodes: [
        { id: "trig", type: "trigger.manual", data: {} },
        {
          id: "post_slack_fail",
          type: "int:slack.post_message",
          data: {
            connectionRef: "sec_slack_revoked",
          },
        },
      ],
      edges: [{ id: "e1", source: "trig", target: "post_slack_fail" }],
    };

    const result = await runGraph(graph, registry, executors, {
      workspaceId: "ws_case_a", // the connection's own workspace (story 1.17)
      payload: {
        channel: "#general",
        text: "Should fail with CONNECTION_EXPIRED",
      },
      env: {
        DB: db,
        PX_CONN_KEY: pxConnKey,
        PX_PROJECT_ID: "proj-case-a",
        PX_ENV: "preview",
        __OAUTH_FETCHER: failingOAuthFetcher,
      },
    });

    expect(result.failed.post_slack_fail).toContain("CONNECTION_EXPIRED");

    // Verify px_connections row was marked status = 'expired'
    const connRow = await db.prepare("SELECT status FROM px_connections WHERE ref = ?").bind("sec_slack_revoked").first<{ status: string }>();
    expect(connRow?.status).toBe("expired");

    // Verify connection.expired telemetry event was emitted into px_logs
    const logRows = await db.prepare("SELECT message FROM px_logs WHERE message LIKE '%connection.expired%'").all<{ message: string }>();
    expect((logRows.results ?? []).length).toBeGreaterThanOrEqual(1);
  });
});
