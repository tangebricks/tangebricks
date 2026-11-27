import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { IntegrationManifestSchema, projectIntegrationToNodes } from "@poc/assembler";
import type { Catalog, IntegrationManifestFile } from "@poc/assembler";
import { catalog as baseCatalog } from "@poc/assembler/catalog";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { buildExecutorsFromCatalog, buildRegistryFromCatalog, resetConnectionRefreshLocksForTest, runGraph } from "@poc/runtime";
import migrationSql from "../migrations/0001_integration_connections.sql?raw";
import { createIntegrationConnectionsRoutes, unsealWorkspaceCredentials } from "../src/index.ts";
import type { IntegrationConnectionsEnv } from "../src/index.ts";

const googleManifest: IntegrationManifestFile = IntegrationManifestSchema.parse({
  manifestVersion: 2,
  kind: "integration",
  app: "google",
  version: "1.0.0",
  ui: {
    displayName: "Google Calendar",
    category: "automation",
    summary: "Google Calendar events integration for workspace accounts",
    maturity: "production",
    behaviourTest: "test/isolation.workerd.test.ts",
  },
  auth: {
    type: "oauth2",
    scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar"],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    headerName: "Authorization",
    prefix: "Bearer",
  },
  baseUrl: "https://www.googleapis.com/calendar/v3",
  allowedHosts: ["www.googleapis.com", "oauth2.googleapis.com"],
  operations: [
    {
      operationId: "create_event",
      label: "Create Calendar Event",
      summary: "Creates an event in the user's primary calendar",
      method: "POST",
      path: "/calendars/primary/events",
      params: [],
      body: {
        contentType: "application/json",
        fields: [{ name: "summary", dataType: "string", required: true }],
      },
      response: {
        outputs: [
          { id: "id", label: "Event ID", dataType: "string" },
          { id: "summary", label: "Summary", dataType: "string" },
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
  return {
    ...baseCatalog,
    integrations: {
      google: {
        manifest: googleManifest,
        nodes: projectIntegrationToNodes(googleManifest),
      },
    },
  };
}

type RouteOptions = NonNullable<Parameters<typeof createIntegrationConnectionsRoutes>[0]>;
type TestAdapter = NonNullable<RouteOptions["adapter"]>;

/**
 * Story 0.9 (A7, A13): the brick has no token-exchange fallback and no placeholder client id. These tests
 * inject a test client id and a deterministic test exchange explicitly; a test's own adapter wins.
 */
const TEST_OAUTH_ADAPTER: TestAdapter = {
  providers: { google: { clientId: "test-google-client-id" } },
  exchangeCode: async ({ provider, code, workspaceId }) => ({
    accessToken: `ya29.${provider}.${workspaceId}.${code}`,
    refreshToken: `1//refresh.${provider}.${workspaceId}.${code}`,
    tokenType: "Bearer",
    expiresIn: 3600,
    accountLabel: `${workspaceId}@${provider}.connected`,
    externalAccountId: `acct_${workspaceId}_${provider}`,
  }),
};

function createTestApp(options: RouteOptions = {}) {
  return createBareApp({
    ...options,
    adapter: {
      ...TEST_OAUTH_ADAPTER,
      ...options.adapter,
      providers: { ...TEST_OAUTH_ADAPTER.providers, ...options.adapter?.providers },
    },
  });
}

/** The routes exactly as configured, with no test exchange or client id injected. */
function createBareApp(options: RouteOptions = {}) {
  const app = new Hono<IntegrationConnectionsEnv>();
  app.use("/api/*", async (c, next) => {
    const uid = c.req.header("x-test-user");
    const wsId = c.req.header("x-workspace-id");
    if (uid) {
      c.set("user", { uid });
    }
    if (wsId) {
      const role = c.req.header("x-test-role") ?? "owner";
      c.set("workspace", { id: wsId, role, suspended: false });
      if (uid) c.set("ctx", Object.freeze({ userId: uid, workspaceId: wsId, role }));
    }
    await next();
  });
  app.route("/api", createIntegrationConnectionsRoutes(options));
  return app;
}

describe("Story 10.3 — Case B bricks/integration-connections Multi-Tenant OAuth & Isolation in Workerd (AD-S19, R38)", () => {
  const db = (env as unknown as { DB: D1Like }).DB;
  const pxConnKey = "case-b-workerd-master-conn-key-2026";

  beforeEach(async () => {
    resetConnectionRefreshLocksForTest();
    await applyMigration(db, migrationSql);
    await db.prepare("DELETE FROM int_connections").run();
    await db.prepare("DELETE FROM int_oauth_states").run();
  });

  it("1. End-to-end Case B flow: Workspace A connects Google via /integrations/google/connect + /callback and executes integration.operation with Workspace A's token", async () => {
    let exchangedCodeVerifier: string | null = null;
    const app = createTestApp({
      oauthStateTtlSeconds: 600,
      refreshWindowSeconds: 60,
      adapter: {
        exchangeCode: async ({ code, codeVerifier, workspaceId }) => {
          exchangedCodeVerifier = codeVerifier;
          return {
            accessToken: `ya29.ws_a_live_token_${code}`,
            refreshToken: `1//refresh_ws_a_${code}`,
            tokenType: "Bearer",
            expiresIn: 3600,
            scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar"],
            accountLabel: `alice@${workspaceId}.example.com`,
            externalAccountId: `google_uid_${workspaceId}`,
          };
        },
      },
    });

    // Step 1: Start connect flow for Workspace A (also verify /api/connect/:provider alias)
    const aliasRes = await app.fetch(
      new Request("https://app.example.test/api/connect/google", {
        headers: { "x-test-user": "user_alice", "x-workspace-id": "ws_A" },
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    expect(aliasRes.status).toBe(200);

    const startRes = await app.fetch(
      new Request("https://app.example.test/api/integrations/google/connect", {
        headers: { "x-test-user": "user_alice", "x-workspace-id": "ws_A" },
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    expect(startRes.status).toBe(200);
    const startBody = (await startRes.json()) as {
      ok: boolean;
      authorizeUrl: string;
      state: string;
      provider: string;
    };
    expect(startBody.ok).toBe(true);
    expect(startBody.provider).toBe("google");
    expect(startBody.authorizeUrl).toContain("code_challenge_method=S256");

    // Step 2: Complete OAuth callback for Workspace A
    const callbackRes = await app.fetch(
      new Request(`https://app.example.test/api/integrations/google/callback?code=auth_code_991&state=${encodeURIComponent(startBody.state)}`, {
        headers: { "x-test-user": "user_alice", "x-workspace-id": "ws_A" },
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    expect(callbackRes.status).toBe(200);
    const callbackBody = (await callbackRes.json()) as {
      ok: boolean;
      connection: {
        workspaceId: string;
        provider: string;
        status: string;
        accountLabel: string;
      };
    };
    expect(callbackBody.ok).toBe(true);
    expect(callbackBody.connection.workspaceId).toBe("ws_A");
    expect(callbackBody.connection.status).toBe("connected");
    expect(callbackBody.connection.accountLabel).toBe("alice@ws_A.example.com");
    expect(exchangedCodeVerifier).toBeTruthy();

    // Verify status endpoint returns metadata only and never leaks sealed_credentials or tokens
    const listRes = await app.fetch(
      new Request("https://app.example.test/api/integrations", {
        headers: { "x-test-user": "user_alice", "x-workspace-id": "ws_A" },
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    expect(listRes.status).toBe(200);
    const listText = await listRes.text();
    expect(listText).not.toContain("ya29.ws_a_live_token_auth_code_991");
    expect(listText).not.toContain("sealed_credentials");

    // Step 3: Trigger a workflow for Workspace A and run int:google.create_event
    const catalog = buildTestCatalog();
    const registry = buildRegistryFromCatalog(catalog);

    let capturedAuthHeader: string | null = null;
    const mockGoogleFetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      capturedAuthHeader = headers.get("authorization");
      if (url.includes("/calendars/primary/events")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { summary?: string };
        return Response.json({ id: "evt_ws_a_101", summary: body.summary ?? "Untitled" }, { status: 200 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    };

    const executors = buildExecutorsFromCatalog(catalog, {
      integration: { fetcher: (input, init) => mockGoogleFetcher(input, init) },
    });

    const runResult = await runGraph(
      {
        nodes: [
          { id: "trig", type: "trigger.manual", data: {} },
          {
            id: "create_cal",
            type: "int:google.create_event",
            data: {
              connectionRef: { scope: "workspace", app: "google" },
            },
          },
        ],
        edges: [{ id: "e1", source: "trig", target: "create_cal" }],
      },
      registry,
      executors,
      {
        workspaceId: "ws_A",
        payload: { summary: "Customer Onboarding Call" },
        env: { DB: db, PX_CONN_KEY: pxConnKey },
      },
    );

    expect(runResult.ok).toBe(true);
    expect(capturedAuthHeader).toBe("Bearer ya29.ws_a_live_token_auth_code_991");
    expect(runResult.outputs.create_cal).toMatchObject({
      id: "evt_ws_a_101",
      summary: "Customer Onboarding Call",
    });
  });

  it("2. Cross-workspace HTTP isolation: Workspace B cannot see, hijack OAuth state, or disconnect Workspace A's connection", async () => {
    const app = createTestApp();

    // Workspace A connects Google
    const startA = await app.fetch(
      new Request("https://app.example.test/api/integrations/google/connect", {
        headers: { "x-test-user": "user_alice", "x-workspace-id": "ws_A" },
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    const { state: stateA } = (await startA.json()) as { state: string };

    // Workspace B attempts to complete callback using Workspace A's state -> 400 OAUTH_STATE_MISMATCH
    const hijackRes = await app.fetch(
      new Request(`https://app.example.test/api/integrations/google/callback?code=evil_code&state=${encodeURIComponent(stateA)}`, {
        headers: { "x-test-user": "user_bob", "x-workspace-id": "ws_B" },
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    expect(hijackRes.status).toBe(400);
    const hijackBody = (await hijackRes.json()) as { error: { code: string } };
    expect(hijackBody.error.code).toBe("OAUTH_STATE_MISMATCH");

    // Workspace A starts fresh state and completes connection
    const startA2 = await app.fetch(
      new Request("https://app.example.test/api/integrations/google/connect", {
        headers: { "x-test-user": "user_alice", "x-workspace-id": "ws_A" },
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    const { state: stateA2 } = (await startA2.json()) as { state: string };
    const cbA = await app.fetch(
      new Request(`https://app.example.test/api/integrations/google/callback?code=good_code&state=${encodeURIComponent(stateA2)}`, {
        headers: { "x-test-user": "user_alice", "x-workspace-id": "ws_A" },
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    expect(cbA.status).toBe(200);

    // Workspace B lists integrations -> sees empty list
    const listB = await app.fetch(
      new Request("https://app.example.test/api/integrations", {
        headers: { "x-test-user": "user_bob", "x-workspace-id": "ws_B" },
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    expect(listB.status).toBe(200);
    const listBBody = (await listB.json()) as { integrations: unknown[] };
    expect(listBBody.integrations).toEqual([]);

    // Workspace B attempts to disconnect Google -> does not affect Workspace A
    const discB = await app.fetch(
      new Request("https://app.example.test/api/integrations/google/disconnect", {
        method: "POST",
        headers: { "x-test-user": "user_bob", "x-workspace-id": "ws_B" },
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    expect(discB.status).toBe(200);
    const discBBody = (await discB.json()) as { disconnected: boolean };
    expect(discBBody.disconnected).toBe(false);

    // Verify Workspace A's connection is still intact
    const listA = await app.fetch(
      new Request("https://app.example.test/api/integrations", {
        headers: { "x-test-user": "user_alice", "x-workspace-id": "ws_A" },
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    const listABody = (await listA.json()) as { integrations: Array<{ provider: string; status: string }> };
    expect(listABody.integrations).toHaveLength(1);
    expect(listABody.integrations[0]).toMatchObject({ provider: "google", status: "connected" });
  });

  it("2b. Story 0.6: connect, callback and disconnect need owner/admin (no user 401, plain member 403, connection intact)", async () => {
    const app = createTestApp();
    const req = (path: string, headers: Record<string, string>, method = "GET") =>
      app.fetch(new Request(`https://app.example.test${path}`, { method, headers }), { DB: db, PX_CONN_KEY: pxConnKey });
    const alice = { "x-test-user": "user_alice", "x-workspace-id": "ws_A" };

    const start = await req("/api/integrations/google/connect", alice);
    expect(start.status).toBe(200);
    const { state } = (await start.json()) as { state: string };
    expect((await req(`/api/integrations/google/callback?code=good_code&state=${encodeURIComponent(state)}`, alice)).status).toBe(200);

    const carol = { "x-test-user": "user_carol", "x-workspace-id": "ws_A", "x-test-role": "member" };
    const states = await db.prepare("SELECT COUNT(*) AS n FROM int_oauth_states").first<{ n: number }>();
    for (const [headers, status] of [
      [{ "x-workspace-id": "ws_A" }, 401],
      [carol, 403],
    ] as const) {
      expect((await req("/api/integrations/google/connect", headers)).status).toBe(status);
      expect((await req("/api/connect/google", headers)).status).toBe(status);
      expect((await req("/api/integrations/google/callback?code=evil&state=x", headers)).status).toBe(status);
      expect((await req("/api/integrations/google/callback", headers, "POST")).status).toBe(status);
      expect((await req("/api/integrations/google/disconnect", headers, "POST")).status).toBe(status);
    }
    const statesAfter = await db.prepare("SELECT COUNT(*) AS n FROM int_oauth_states").first<{ n: number }>();
    expect(statesAfter?.n).toBe(states?.n);

    const list = await req("/api/integrations", alice);
    const body = (await list.json()) as { integrations: Array<{ provider: string; status: string }> };
    expect(body.integrations[0]).toMatchObject({ provider: "google", status: "connected" });

    // An admin may disconnect.
    const admin = { "x-test-user": "user_dan", "x-workspace-id": "ws_A", "x-test-role": "admin" };
    const disc = await req("/api/integrations/google/disconnect", admin, "POST");
    expect(disc.status).toBe(200);
    expect(((await disc.json()) as { disconnected: boolean }).disconnected).toBe(true);
  });

  it("3. Cross-workspace workflow runtime isolation: Workspace B workflow with malicious payload { workspaceId: 'ws_A', connectionId: '...' } fails with WORKSPACE_CONNECTION_NOT_FOUND", async () => {
    const app = createTestApp();

    // Connect Google in Workspace A
    const startA = await app.fetch(
      new Request("https://app.example.test/api/integrations/google/connect", {
        headers: { "x-test-user": "user_alice", "x-workspace-id": "ws_A" },
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    const { state: stateA } = (await startA.json()) as { state: string };
    await app.fetch(
      new Request(`https://app.example.test/api/integrations/google/callback?code=ws_a_secret_code&state=${encodeURIComponent(stateA)}`, {
        headers: { "x-test-user": "user_alice", "x-workspace-id": "ws_A" },
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );

    const catalog = buildTestCatalog();
    const registry = buildRegistryFromCatalog(catalog);

    let upstreamCalled = false;
    const spyFetcher: typeof fetch = async () => {
      upstreamCalled = true;
      return Response.json({ id: "should_never_happen" }, { status: 200 });
    };

    const executors = buildExecutorsFromCatalog(catalog, {
      integration: { fetcher: spyFetcher },
    });

    // Trigger workflow in Workspace B while attempting to override workspaceId in payload, node data, and connectionRef
    const runResult = await runGraph(
      {
        nodes: [
          { id: "trig", type: "trigger.manual", data: {} },
          {
            id: "steal_cal",
            type: "int:google.create_event",
            data: {
              workspaceId: "ws_A",
              connectionId: "intc_ws_A_google",
              connectionRef: {
                scope: "workspace",
                app: "google",
                workspaceId: "ws_A",
              },
            },
          },
        ],
        edges: [{ id: "e1", source: "trig", target: "steal_cal" }],
      },
      registry,
      executors,
      {
        workspaceId: "ws_B",
        payload: {
          workspaceId: "ws_A",
          connectionId: "intc_ws_A_google",
          summary: "Attempted Cross-Tenant Event",
        },
        env: { DB: db, PX_CONN_KEY: pxConnKey },
      },
    );

    expect(runResult.ok).toBe(false);
    expect(upstreamCalled).toBe(false);
    expect(runResult.failed.steal_cal).toContain("WORKSPACE_CONNECTION_NOT_FOUND");
  });

  it("4. Ciphertext transplant defence: Copying sealed_credentials from Workspace A's D1 row into Workspace B's D1 row fails AES-GCM decryption due to AAD mismatch", async () => {
    const app = createTestApp();

    // Connect Google in Workspace A
    const startA = await app.fetch(
      new Request("https://app.example.test/api/integrations/google/connect", {
        headers: { "x-test-user": "user_alice", "x-workspace-id": "ws_A" },
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    const { state: stateA } = (await startA.json()) as { state: string };
    await app.fetch(
      new Request(`https://app.example.test/api/integrations/google/callback?code=transplant_test&state=${encodeURIComponent(stateA)}`, {
        headers: { "x-test-user": "user_alice", "x-workspace-id": "ws_A" },
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );

    const rowA = await db
      .prepare("SELECT sealed_credentials FROM int_connections WHERE workspace_id = 'ws_A' AND provider = 'google'")
      .first<{ sealed_credentials: string }>();
    expect(rowA?.sealed_credentials).toBeTruthy();

    // Direct crypto verification: unsealing with ws_A succeeds, unsealing with ws_B throws WORKSPACE_CREDENTIAL_INTEGRITY_ERROR
    const unsealedA = await unsealWorkspaceCredentials(rowA!.sealed_credentials, "ws_A", pxConnKey);
    expect(unsealedA.accessToken).toContain("ws_A");
    await expect(unsealWorkspaceCredentials(rowA!.sealed_credentials, "ws_B", pxConnKey)).rejects.toThrow(/WORKSPACE_CREDENTIAL_INTEGRITY_ERROR/);

    // Transplant sealed_credentials into Workspace B's D1 row
    await db
      .prepare(
        `INSERT INTO int_connections (
          id, workspace_id, provider, external_account_id, account_label,
          sealed_credentials, scopes, status, expires_at
        ) VALUES ('intc_ws_B_google', 'ws_B', 'google', 'acct_b', 'bob@ws_B', ?, '[]', 'connected', ?)`,
      )
      .bind(rowA!.sealed_credentials, Date.now() + 3600_000)
      .run();

    const catalog = buildTestCatalog();
    const registry = buildRegistryFromCatalog(catalog);

    let upstreamCalled = false;
    const testFetcher = async () => {
      upstreamCalled = true;
      return Response.json({ id: "bad" }, { status: 200 });
    };
    const executors = buildExecutorsFromCatalog(catalog, {
      integration: { fetcher: testFetcher },
    });

    const runResult = await runGraph(
      {
        nodes: [
          { id: "trig", type: "trigger.manual", data: {} },
          {
            id: "cal_b",
            type: "int:google.create_event",
            data: {
              connectionRef: { scope: "workspace", app: "google" },
            },
          },
        ],
        edges: [{ id: "e1", source: "trig", target: "cal_b" }],
      },
      registry,
      executors,
      {
        workspaceId: "ws_B",
        payload: { summary: "Transplanted Ciphertext Attempt" },
        env: { DB: db, PX_CONN_KEY: pxConnKey },
      },
    );

    expect(runResult.ok).toBe(false);
    expect(upstreamCalled).toBe(false);
    expect(runResult.failed.cal_b).toContain("WORKSPACE_CREDENTIAL_INTEGRITY_ERROR");
  });

  it("5. Concurrent refresh lock: Two parallel workflow steps for Workspace A hitting an expired token perform exactly 1 upstream OAuth refresh HTTP call", async () => {
    const app = createTestApp({
      adapter: {
        exchangeCode: async () => ({
          accessToken: "ya29.ws_a_expired_token_v1",
          refreshToken: "1//ws_a_refresh_token_v1",
          tokenType: "Bearer",
          // Already expired 10 seconds ago
          expiresAt: Date.now() - 10_000,
          scopes: ["https://www.googleapis.com/auth/calendar"],
          accountLabel: "alice@ws_A.example.com",
        }),
      },
    });

    const startA = await app.fetch(
      new Request("https://app.example.test/api/integrations/google/connect", {
        headers: { "x-test-user": "user_alice", "x-workspace-id": "ws_A" },
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    const { state: stateA } = (await startA.json()) as { state: string };
    await app.fetch(
      new Request(`https://app.example.test/api/integrations/google/callback?code=init_expired&state=${encodeURIComponent(stateA)}`, {
        headers: { "x-test-user": "user_alice", "x-workspace-id": "ws_A" },
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );

    let oauthRefreshCallCount = 0;
    const seenBearerTokens: string[] = [];

    const concurrentFetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        oauthRefreshCallCount += 1;
        await new Promise((r) => setTimeout(r, 25));
        return Response.json(
          {
            access_token: "ya29.ws_a_refreshed_token_v2",
            refresh_token: "1//ws_a_refresh_token_v2",
            expires_in: 3600,
            token_type: "Bearer",
          },
          { status: 200 },
        );
      }

      const headers = new Headers(init?.headers);
      seenBearerTokens.push(headers.get("authorization") ?? "");
      const body = JSON.parse(String(init?.body ?? "{}")) as { summary?: string };
      return Response.json({ id: `evt_${seenBearerTokens.length}`, summary: body.summary ?? "Event" }, { status: 200 });
    };

    const catalog = buildTestCatalog();
    const registry = buildRegistryFromCatalog(catalog);
    const executors = buildExecutorsFromCatalog(catalog, {
      integration: { fetcher: concurrentFetcher },
    });

    // Run workflow with TWO parallel branches (cal_step_1 and cal_step_2) both triggered simultaneously by trig
    const runResult = await runGraph(
      {
        nodes: [
          { id: "trig", type: "trigger.manual", data: {} },
          {
            id: "cal_step_1",
            type: "int:google.create_event",
            data: {
              connectionRef: { scope: "workspace", app: "google" },
            },
          },
          {
            id: "cal_step_2",
            type: "int:google.create_event",
            data: {
              connectionRef: { scope: "workspace", app: "google" },
            },
          },
        ],
        edges: [
          { id: "e1", source: "trig", target: "cal_step_1" },
          { id: "e2", source: "trig", target: "cal_step_2" },
        ],
      },
      registry,
      executors,
      {
        workspaceId: "ws_A",
        payload: { summary: "Parallel Sync Event" },
        env: {
          DB: db,
          PX_CONN_KEY: pxConnKey,
          __OAUTH_FETCHER: concurrentFetcher,
        },
      },
    );

    expect(runResult.ok).toBe(true);
    expect(oauthRefreshCallCount).toBe(1);
    expect(seenBearerTokens).toEqual(["Bearer ya29.ws_a_refreshed_token_v2", "Bearer ya29.ws_a_refreshed_token_v2"]);

    // Verify the re-sealed row in int_connections is bound to ws_A AAD and holds the new token
    const updatedRow = await db
      .prepare("SELECT sealed_credentials, status, refresh_lock_until FROM int_connections WHERE workspace_id = 'ws_A' AND provider = 'google'")
      .first<{ sealed_credentials: string; status: string; refresh_lock_until: number | null }>();
    expect(updatedRow?.status).toBe("connected");
    expect(updatedRow?.refresh_lock_until).toBeNull();
    const unsealedUpdated = await unsealWorkspaceCredentials(updatedRow!.sealed_credentials, "ws_A", pxConnKey);
    expect(unsealedUpdated.accessToken).toBe("ya29.ws_a_refreshed_token_v2");
    expect(unsealedUpdated.refreshToken).toBe("1//ws_a_refresh_token_v2");
  });

  it("6. Operator-configured unmanifested provider (e.g. Notion): connects via adapter.providers config and rejects unconfigured provider", async () => {
    const app = createTestApp({
      adapter: {
        providers: {
          notion: {
            displayName: "Notion",
            authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
            tokenUrl: "https://api.notion.com/v1/oauth/token",
            defaultScopes: ["read_content"],
            clientId: "test-notion-client-id",
          },
        },
      },
    });

    // Configured provider Notion succeeds
    const startNotion = await app.fetch(
      new Request("https://app.example.test/api/integrations/notion/connect", {
        headers: { "x-test-user": "user_alice", "x-workspace-id": "ws_A" },
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    expect(startNotion.status).toBe(200);
    const startBody = (await startNotion.json()) as { ok: boolean; authorizeUrl: string; provider: string };
    expect(startBody.ok).toBe(true);
    expect(startBody.provider).toBe("notion");
    expect(startBody.authorizeUrl).toContain("https://api.notion.com/v1/oauth/authorize");

    // Unconfigured unmanifested provider Linear fails with 404 OAUTH_PROVIDER_UNKNOWN
    const startLinear = await app.fetch(
      new Request("https://app.example.test/api/integrations/linear/connect", {
        headers: { "x-test-user": "user_alice", "x-workspace-id": "ws_A" },
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    expect(startLinear.status).toBe(404);
    const linearBody = (await startLinear.json()) as { error: { code: string } };
    expect(linearBody.error.code).toBe("OAUTH_PROVIDER_UNKNOWN");
  });
});

describe("story 0.9: no fabricated OAuth success (A7, A13)", () => {
  const db = (env as unknown as { DB: D1Like }).DB;
  const pxConnKey = "case-b-workerd-master-conn-key-2026";
  const alice = { "x-test-user": "user_alice", "x-workspace-id": "ws_A" };

  beforeEach(async () => {
    await applyMigration(db, migrationSql);
    await db.prepare("DELETE FROM int_connections").run();
    await db.prepare("DELETE FROM int_oauth_states").run();
  });

  it("A13: with no client id configured, connect answers 503 NOT_CONFIGURED, stores no state and sends no placeholder client id", async () => {
    const app = createBareApp();
    const res = await app.fetch(new Request("https://app.example.test/api/integrations/google/connect", { headers: alice }), {
      DB: db,
      PX_CONN_KEY: pxConnKey,
    });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe("NOT_CONFIGURED");
    expect(text).not.toContain("px_google_client");
    const states = await db.prepare("SELECT COUNT(*) AS n FROM int_oauth_states").first<{ n: number }>();
    expect(states?.n).toBe(0);
  });

  it("OAUTH_NO_EXCHANGE: with no exchange adapter, the callback fails NOT_CONFIGURED and the connection is not marked connected", async () => {
    const app = createBareApp({ adapter: { providers: { google: { clientId: "real-client-id" } } } });
    const start = await app.fetch(new Request("https://app.example.test/api/integrations/google/connect", { headers: alice }), {
      DB: db,
      PX_CONN_KEY: pxConnKey,
    });
    expect(start.status).toBe(200);
    const { state, authorizeUrl } = (await start.json()) as { state: string; authorizeUrl: string };
    expect(new URL(authorizeUrl).searchParams.get("client_id")).toBe("real-client-id");

    const cb = await app.fetch(
      new Request(`https://app.example.test/api/integrations/google/callback?code=caller_code&state=${encodeURIComponent(state)}`, { headers: alice }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    expect(cb.status).toBe(503);
    expect(((await cb.json()) as { error: { code: string } }).error.code).toBe("NOT_CONFIGURED");

    const conns = await db.prepare("SELECT COUNT(*) AS n FROM int_connections").first<{ n: number }>();
    expect(conns?.n).toBe(0);
    const list = await app.fetch(new Request("https://app.example.test/api/integrations", { headers: alice }), { DB: db, PX_CONN_KEY: pxConnKey });
    expect(((await list.json()) as { integrations: unknown[] }).integrations).toEqual([]);
  });
});
