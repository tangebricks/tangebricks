import { describe, expect, it } from "vitest";
import {
  IntegrationManifestSchema,
  projectIntegrationToNodes,
} from "@poc/assembler";
import type { Catalog, IntegrationManifestFile } from "@poc/assembler";
import { catalog as baseCatalog } from "@poc/assembler/catalog";
import {
  buildExecutorsFromCatalog,
  buildRegistryFromCatalog,
  rehearseStep,
  runGraph,
} from "../src/index.ts";

const slackManifest: IntegrationManifestFile = IntegrationManifestSchema.parse({
  manifestVersion: 2,
  kind: "integration",
  app: "slack",
  version: "1.0.0",
  ui: {
    displayName: "Slack",
    category: "communication",
    summary: "Slack messaging and workspace channels integration",
    maturity: "production",
    behaviourTest: "test/slack.test.ts",
  },
  auth: {
    type: "oauth2",
    scopes: ["chat:write", "channels:read"],
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
      idempotency: {
        header: "X-Slack-Req-Id",
      },
      params: [
        {
          name: "traceId",
          in: "header",
          dataType: "string",
          required: false,
        },
      ],
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
          { id: "ts", label: "Message Timestamp", dataType: "string" },
          { id: "channel", label: "Channel", dataType: "string" },
          { id: "text", label: "Text", dataType: "string" },
        ],
      },
      rateLimit: {
        maxRetries: 2,
        initialBackoffMs: 10,
        respectRetryAfter: true,
      },
      sideEffects: "write",
    },
    {
      operationId: "list_channels",
      label: "List Channels",
      summary: "List channels with cursor pagination",
      method: "GET",
      path: "/teams/{teamId}/conversations",
      params: [
        { name: "teamId", in: "path", dataType: "string", required: true },
        { name: "types", in: "query", dataType: "string", required: false },
      ],
      response: {
        outputs: [{ id: "channels", label: "Channels", dataType: "array" }],
      },
      pagination: {
        style: "cursor",
        paramName: "cursor",
        responsePath: "channels",
        nextCursorPath: "response_metadata.next_cursor",
        maxPages: 3,
      },
      sideEffects: "read",
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
    summary: "Transactional email API with custom header key auth",
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
      summary: "Send transactional email via Resend",
      method: "POST",
      path: "/emails/{domainId}",
      params: [
        { name: "domainId", in: "path", dataType: "string", required: true },
      ],
      body: {
        contentType: "application/json",
        fields: [
          { name: "to", dataType: "string", required: true },
          { name: "subject", dataType: "string", required: true },
        ],
      },
      response: {
        outputs: [
          { id: "id", label: "Email ID", dataType: "string" },
          { id: "domain", label: "Domain", dataType: "string" },
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

const twilioManifest: IntegrationManifestFile = IntegrationManifestSchema.parse({
  manifestVersion: 2,
  kind: "integration",
  app: "twilio",
  version: "1.0.0",
  ui: {
    displayName: "Twilio",
    category: "communication",
    summary: "SMS messaging with HTTP Basic auth and form-urlencoded body",
    maturity: "production",
    behaviourTest: "test/twilio.test.ts",
  },
  auth: {
    type: "basic",
    headerName: "Authorization",
  },
  baseUrl: "https://api.twilio.com/2010-04-01",
  allowedHosts: ["api.twilio.com"],
  operations: [
    {
      operationId: "send_sms",
      label: "Send SMS",
      summary: "Send an SMS message via Twilio",
      method: "POST",
      path: "/Accounts/{accountSid}/Messages.json",
      params: [
        { name: "accountSid", in: "path", dataType: "string", required: true },
      ],
      body: {
        contentType: "application/x-www-form-urlencoded",
        fields: [
          { name: "To", dataType: "string", required: true },
          { name: "From", dataType: "string", required: true },
          { name: "Body", dataType: "string", required: true },
        ],
      },
      response: {
        outputs: [
          { id: "sid", label: "Message SID", dataType: "string" },
          { id: "status", label: "Delivery Status", dataType: "number" },
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

function buildTestCatalog(): Catalog {
  const modifiedSlackManifest: IntegrationManifestFile = {
    ...slackManifest,
    operations: [
      ...slackManifest.operations,
      {
        operationId: "metadata_ip_test",
        label: "Metadata IP",
        summary: "Metadata IP injection test",
        method: "POST",
        path: "//169.254.169.254/latest",
        sideEffects: "write",
      } as unknown as (typeof slackManifest.operations)[number],
    ],
  };
  return {
    ...baseCatalog,
    integrations: {
      slack: {
        manifest: modifiedSlackManifest,
        nodes: projectIntegrationToNodes(slackManifest),
      },
      resend: {
        manifest: resendManifest,
        nodes: projectIntegrationToNodes(resendManifest),
      },
      twilio: {
        manifest: twilioManifest,
        nodes: projectIntegrationToNodes(twilioManifest),
      },
    },
  };
}

describe("Story 10.1 — Generic integration.operation executor", () => {
  it("runs operations across oauth2 Bearer, custom-header apiKey, and HTTP basic auth with byte-for-byte parity between rehearseStep and runGraph (step.do)", async () => {
    const catalog = buildTestCatalog();
    const registry = buildRegistryFromCatalog(catalog);

    const capturedRequests: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string | null;
    }> = [];

    const mockFetcher = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      const headersObj = new Headers(init?.headers);
      const headersRecord: Record<string, string> = {};
      headersObj.forEach((v, k) => {
        headersRecord[k.toLowerCase()] = v;
      });
      const bodyStr = typeof init?.body === "string" ? init.body : null;
      capturedRequests.push({
        url,
        method: init?.method ?? "GET",
        headers: headersRecord,
        body: bodyStr,
      });

      if (url.startsWith("https://slack.com/api/chat.postMessage")) {
        const parsed = JSON.parse(bodyStr ?? "{}") as Record<string, string>;
        return Response.json(
          {
            ok: true,
            message: {
              ts: "1730000000.000100",
              channel: parsed.channel,
              text: parsed.text,
            },
          },
          { status: 200 },
        );
      }

      if (url.startsWith("https://api.resend.com/emails/")) {
        const parsed = JSON.parse(bodyStr ?? "{}") as Record<string, string>;
        return Response.json(
          {
            id: "em_98765",
            domain: "dom_acme",
            to: parsed.to,
            subject: parsed.subject,
          },
          { status: 200 },
        );
      }

      if (url.startsWith("https://api.twilio.com/2010-04-01/Accounts/")) {
        const form = new URLSearchParams(bodyStr ?? "");
        return Response.json(
          {
            sid: "SM_112233",
            to: form.get("To"),
            from: form.get("From"),
            body: form.get("Body"),
          },
          { status: 201 },
        );
      }

      return Response.json({ error: "not_found" }, { status: 404 });
    };

    const executors = buildExecutorsFromCatalog(catalog, {
      integration: { fetcher: mockFetcher },
    });

    const connections = {
      conn_slack: {
        app: "slack",
        accessToken: "xox" + "b-slack-oauth-token-12345",
      },
      "workspace:ws_tenant_1:resend": {
        app: "resend",
        apiKey: "re_live_apikey_67890",
      },
      conn_twilio: {
        app: "twilio",
        username: "AC_TWILIO_USER",
        password: "TWILIO_SECRET_PASSWORD",
      },
    };

    // 1. OAuth2 (Slack) — Rehearsal vs GraphWorkflow runStep parity
    const slackConfig = {
      connectionRef: { scope: "project", ref: "conn_slack" },
      traceId: "tr_001",
    };
    const slackInput = {
      channel: "C_GENERAL",
      text: "Hello from ProjectX",
    };

    const slackRehearsal = await rehearseStep(
      { workspaceId: "ws_test",
        nodeId: "n_slack",
        nodeType: "int:slack.post_message",
        config: slackConfig,
        input: slackInput,
      },
      { registry, executors, connections },
    );
    expect(slackRehearsal.ok).toBe(true);

    const stepDoCalls: string[] = [];
    const slackGraphRun = await runGraph(
      {
        nodes: [
          { id: "trig", type: "trigger.manual", data: {} },
          { id: "n_slack", type: "int:slack.post_message", data: slackConfig },
        ],
        edges: [{ id: "e1", source: "trig", target: "n_slack" }],
      },
      registry,
      executors,
      { workspaceId: "ws_test",
        runId: "run_slack_integration",
        payload: slackInput,
        connections,
        runStep: async (nodeId, fn) => {
          stepDoCalls.push(nodeId);
          return fn();
        },
      },
    );
    expect(slackGraphRun.ok).toBe(true);
    expect(stepDoCalls).toContain("n_slack");
    expect(JSON.stringify(slackRehearsal.output)).toBe(
      JSON.stringify(slackGraphRun.outputs.n_slack),
    );
    expect(capturedRequests[0]?.headers.authorization).toBe(
      "Bearer xox" + "b-slack-oauth-token-12345",
    );
    expect(capturedRequests[0]?.headers.traceid).toBe("tr_001");
    // Manifest-declared idempotency header on write operation
    expect(capturedRequests[1]?.headers["x-slack-req-id"]).toBe(
      "run_slack_integration:n_slack",
    );

    // 2. Custom Header API Key (Resend) + Case B workspace connection
    const resendConfig = {
      connectionRef: {
        scope: "workspace",
        app: "resend",
        workspaceId: "ws_tenant_1",
      },
      domainId: "dom_acme",
    };
    const resendInput = {
      to: "user@example.com",
      subject: "Welcome aboard",
    };

    const resendRehearsal = await rehearseStep(
      // the run's workspace is the tenant's; the selector's own workspaceId is never used (story 1.1)
      { workspaceId: "ws_tenant_1",
        nodeId: "n_resend",
        nodeType: "int:resend.send_email",
        config: resendConfig,
        input: resendInput,
      },
      { registry, executors, connections },
    );
    const resendGraphRun = await runGraph(
      {
        nodes: [
          { id: "trig", type: "trigger.manual", data: {} },
          { id: "n_resend", type: "int:resend.send_email", data: resendConfig },
        ],
        edges: [{ id: "e1", source: "trig", target: "n_resend" }],
      },
      registry,
      executors,
      { workspaceId: "ws_tenant_1",
        runId: "run_resend_integration",
        payload: resendInput,
        connections,
        runStep: async (_id, fn) => fn(),
      },
    );
    expect(resendRehearsal.ok).toBe(true);
    expect(resendGraphRun.ok).toBe(true);
    expect(JSON.stringify(resendRehearsal.output)).toBe(
      JSON.stringify(resendGraphRun.outputs.n_resend),
    );
    expect(capturedRequests[2]?.headers["x-resend-key"]).toBe("re_live_apikey_67890");
    // AC2: A write integration node's outbound request carries the Idempotency-Key: <runId>:<nodeId> header
    expect(capturedRequests[3]?.headers["idempotency-key"]).toBe(
      "run_resend_integration:n_resend",
    );

    // 3. HTTP Basic Auth + application/x-www-form-urlencoded (Twilio)
    const twilioConfig = {
      connectionRef: "conn_twilio",
      accountSid: "AC_999",
    };
    const twilioInput = {
      To: "+15550001111",
      From: "+15550002222",
      Body: "Your code is 4242",
    };

    const twilioRehearsal = await rehearseStep(
      { workspaceId: "ws_test",
        nodeId: "n_twilio",
        nodeType: "int:twilio.send_sms",
        config: twilioConfig,
        input: twilioInput,
      },
      { registry, executors, connections },
    );
    const twilioGraphRun = await runGraph(
      {
        nodes: [
          { id: "trig", type: "trigger.manual", data: {} },
          { id: "n_twilio", type: "int:twilio.send_sms", data: twilioConfig },
        ],
        edges: [{ id: "e1", source: "trig", target: "n_twilio" }],
      },
      registry,
      executors,
      { workspaceId: "ws_test",
        runId: "run_twilio_integration",
        payload: twilioInput,
        connections,
        runStep: async (_id, fn) => fn(),
      },
    );
    expect(twilioRehearsal.ok).toBe(true);
    expect(twilioGraphRun.ok).toBe(true);
    expect(JSON.stringify(twilioRehearsal.output)).toBe(
      JSON.stringify(twilioGraphRun.outputs.n_twilio),
    );
    expect(capturedRequests[4]?.headers.authorization).toBe(
      `Basic ${btoa("AC_TWILIO_USER:TWILIO_SECRET_PASSWORD")}`,
    );
    expect(capturedRequests[5]?.headers["idempotency-key"]).toBe(
      "run_twilio_integration:n_twilio",
    );
    expect(capturedRequests[4]?.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(capturedRequests[4]?.body).toContain("To=%2B15550001111");
  });

  it("blocks SSRF host injection, path traversal, and cross-app connection mismatch before network I/O", async () => {
    const catalog = buildTestCatalog();
    const registry = buildRegistryFromCatalog(catalog);

    let networkCalls = 0;
    const forbiddenFetcher = async (): Promise<Response> => {
      networkCalls += 1;
      return Response.json({ shouldNeverHappen: true });
    };

    const executors = buildExecutorsFromCatalog(catalog, {
      integration: { fetcher: forbiddenFetcher },
    });

    const connections = {
      conn_slack: { app: "slack", accessToken: "xox" + "b-valid-token" },
      conn_resend: { app: "resend", apiKey: "re_valid_key" },
    };

    // 1. Protocol-relative metadata IP injection: //169.254.169.254/latest
    const metadataAttempt = await rehearseStep(
      { workspaceId: "ws_test",
        nodeId: "n1",
        nodeType: "int:slack.metadata_ip_test",
        config: {
          connectionRef: "conn_slack",
        },
        input: { channel: "C1", text: "hi" },
      },
      { registry, executors, connections },
    );
    expect(metadataAttempt.ok).toBe(false);
    expect(metadataAttempt.error?.message).toContain("INTEGRATION_HOST_FORBIDDEN");
    expect(networkCalls).toBe(0);

    // 2. Passing url does not override host (UC1.2 / F-SEC-6: normal param handling, goes to manifest baseUrl)
    let urlParamCalledUrl: string | undefined;
    const urlParamFetcher = async (input: string | URL | Request): Promise<Response> => {
      urlParamCalledUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return Response.json({ ok: true, message: { ts: "1.0", channel: "C1", text: "hi" } });
    };
    const urlParamExecutors = buildExecutorsFromCatalog(catalog, {
      integration: { fetcher: urlParamFetcher },
    });
    const evilHostAttempt = await rehearseStep(
      { workspaceId: "ws_test",
        nodeId: "n1",
        nodeType: "int:slack.post_message",
        config: {
          connectionRef: "conn_slack",
          url: "https://evil.example.com/steal",
        },
        input: { channel: "C1", text: "hi" },
      },
      { registry, executors: urlParamExecutors, connections },
    );
    expect(evilHostAttempt.ok).toBe(true);
    expect(urlParamCalledUrl).toBe("https://slack.com/api/chat.postMessage");
    expect(urlParamCalledUrl).not.toContain("evil.example.com");
    expect(networkCalls).toBe(0);

    // 3. Path parameter traversal (../)
    const traversalAttempt = await rehearseStep(
      { workspaceId: "ws_test",
        nodeId: "n2",
        nodeType: "int:resend.send_email",
        config: {
          connectionRef: "conn_resend",
          domainId: "../admin/secrets",
        },
        input: { to: "a@b.com", subject: "test" },
      },
      { registry, executors, connections },
    );
    expect(traversalAttempt.ok).toBe(false);
    expect(traversalAttempt.error?.message).toContain("INTEGRATION_HOST_FORBIDDEN");
    expect(networkCalls).toBe(0);

    // 4. Cross-app connection mismatch (passing Slack connection to Resend node)
    const mismatchAttempt = await rehearseStep(
      { workspaceId: "ws_test",
        nodeId: "n2",
        nodeType: "int:resend.send_email",
        config: {
          connectionRef: "conn_slack",
          domainId: "dom_123",
        },
        input: { to: "a@b.com", subject: "test" },
      },
      { registry, executors, connections },
    );
    expect(mismatchAttempt.ok).toBe(false);
    expect(mismatchAttempt.error?.message).toContain("INTEGRATION_CONNECTION_MISMATCH");
    expect(networkCalls).toBe(0);
  });

  it("retries 429 rate-limit responses with Retry-After, maps 401 to CONNECTION_EXPIRED, paginates cursor responses up to maxPages, and scrubs canary credentials from outputs and logs", async () => {
    const catalog = buildTestCatalog();
    const registry = buildRegistryFromCatalog(catalog);
    const executors = buildExecutorsFromCatalog(catalog);

    const CANARY_TOKEN = "CANARY_SLACK_SECRET_TOKEN_99887766";
    const connections = {
      conn_slack: {
        app: "slack",
        accessToken: CANARY_TOKEN,
      },
    };

    // A) 429 Retry-After -> 200 success + canary scrubbing
    let postAttempt = 0;
    const retryAndCanaryFetcher = async (): Promise<Response> => {
      postAttempt += 1;
      if (postAttempt === 1) {
        return new Response(JSON.stringify({ error: "rate_limited" }), {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      }
      return Response.json(
        {
          ok: true,
          message: {
            ts: "1730000009.000200",
            channel: "C_ALERTS",
            text: `Echoing token ${CANARY_TOKEN} back in body`,
            authorization: `Bearer ${CANARY_TOKEN}`,
          },
        },
        { status: 200 },
      );
    };

    const retryExecutors = buildExecutorsFromCatalog(catalog, {
      integration: { fetcher: retryAndCanaryFetcher },
    });

    const retryRun = await runGraph(
      {
        nodes: [
          { id: "trig", type: "trigger.manual", data: {} },
          {
            id: "n_post",
            type: "int:slack.post_message",
            data: {
              connectionRef: "conn_slack",
              channel: "C_ALERTS",
              text: "Alert",
            },
          },
        ],
        edges: [{ id: "e1", source: "trig", target: "n_post" }],
      },
      registry,
      retryExecutors,
      { workspaceId: "ws_test",
        connections,
        telemetry: {
          runId: "run_int_retry_1",
          workflowId: "wf_int",
        },
      },
    );

    expect(retryRun.ok).toBe(true);
    expect(postAttempt).toBe(2);
    const serializedOutputs = JSON.stringify(retryRun.outputs);
    const serializedEvents = JSON.stringify(retryRun.stepEvents ?? []);
    const serializedLogs = JSON.stringify(retryRun.logs ?? []);
    expect(serializedOutputs).not.toContain(CANARY_TOKEN);
    expect(serializedOutputs).toContain("[REDACTED]");
    expect(serializedEvents).not.toContain(CANARY_TOKEN);
    expect(serializedLogs).not.toContain(CANARY_TOKEN);

    // B) 401 maps to CONNECTION_EXPIRED
    const expiredFetcher = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: "invalid_auth", leaked: CANARY_TOKEN }), {
        status: 401,
      });

    const expiredExecutors = buildExecutorsFromCatalog(catalog, {
      integration: { fetcher: expiredFetcher },
    });

    const expiredRes = await rehearseStep(
      { workspaceId: "ws_test",
        nodeId: "n_post",
        nodeType: "int:slack.post_message",
        config: {
          connectionRef: "conn_slack",
          channel: "C_ALERTS",
          text: "Alert",
        },
        input: {},
      },
      { registry, executors: expiredExecutors, connections },
    );
    expect(expiredRes.ok).toBe(false);
    expect(expiredRes.error?.message).toContain("CONNECTION_EXPIRED");
    expect(JSON.stringify(expiredRes)).not.toContain(CANARY_TOKEN);

    // C) Multi-page cursor pagination collects pages up to maxPages (3)
    const visitedCursors: Array<string | null> = [];
    const paginatedFetcher = async (input: string | URL | Request): Promise<Response> => {
      const u = new URL(String(input));
      const cursor = u.searchParams.get("cursor");
      visitedCursors.push(cursor);
      const pageNum = visitedCursors.length;
      return Response.json({
        ok: true,
        channels: [{ id: `C_PAGE_${pageNum}`, name: `chan-${pageNum}` }],
        response_metadata: {
          next_cursor: `cursor_for_page_${pageNum + 1}`,
        },
      });
    };

    const paginatedExecutors = buildExecutorsFromCatalog(catalog, {
      integration: { fetcher: paginatedFetcher },
    });

    const pageRes = await rehearseStep(
      { workspaceId: "ws_test",
        nodeId: "n_list",
        nodeType: "int:slack.list_channels",
        config: {
          connectionRef: "conn_slack",
          teamId: "T_ACME",
          types: "public_channel",
        },
        input: {},
      },
      { registry, executors: paginatedExecutors, connections },
    );

    expect(pageRes.ok).toBe(true);
    expect(visitedCursors).toEqual([null, "cursor_for_page_2", "cursor_for_page_3"]);
    expect(pageRes.output.channels).toEqual([
      { id: "C_PAGE_1", name: "chan-1" },
      { id: "C_PAGE_2", name: "chan-2" },
      { id: "C_PAGE_3", name: "chan-3" },
    ]);
  });
});
