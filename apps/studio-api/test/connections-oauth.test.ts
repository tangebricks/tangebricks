import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { ensurePxConnectionsTable, unsealConnectionCredentials } from "@poc/runtime";
import studioAuthOrgsSql from "../migrations/0001_studio_auth_orgs.sql?raw";
import studioSecretVaultSql from "../migrations/0002_studio_secret_vault.sql?raw";
import { app as studioApp } from "../src/index.ts";
import type { StudioApiEnv } from "../src/index.ts";

const rawEnv = env as unknown as StudioApiEnv;
const studioDb = rawEnv.STUDIO_DB as D1Like;
const envDb = ((rawEnv as unknown as { DB?: D1Like }).DB ?? studioDb) as D1Like;
const PX_CONN_KEY = "studio-api-oauth-test-conn-key-2026";

const BASE_TEST_ENV: StudioApiEnv = {
  ...rawEnv,
  BETTER_AUTH_SECRET: "studio-test-better-auth-secret-0123456789abcdef",
  PX_VAULT_KEY: "studio-test-aes-gcm-256-vault-master-key-99887766",
  PX_CONN_KEY,
  GITHUB_CLIENT_ID: "studio-gh-test-client-id",
  GITHUB_CLIENT_SECRET: "studio-gh-test-client-secret",
};

interface CallOptions {
  method?: string;
  token?: string;
  cookie?: string;
  orgId?: string;
  headers?: Record<string, string>;
  body?: unknown;
  env?: StudioApiEnv;
}

async function callStudio(path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.cookie) headers.set("cookie", options.cookie);
  // Story 0.14: a cookie-authenticated write must come from an allowed Origin (CSRF guard); this is the same origin.
  if (options.cookie && !headers.has("origin")) headers.set("origin", "https://example.test");
  if (options.orgId) headers.set("x-org-id", options.orgId);

  let rawBody: string | undefined;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    rawBody = JSON.stringify(options.body);
  }

  return studioApp.fetch(
    new Request(`https://example.test${path}`, {
      method: options.method ?? (rawBody !== undefined ? "POST" : "GET"),
      headers,
      body: rawBody,
    }),
    options.env ?? BASE_TEST_ENV,
  );
}

async function seedHumanOwnerAndAgentToken(): Promise<{
  aliceCookie: string;
  orgId: string;
  mcpToken: string;
}> {
  await callStudio("/api/auth/sign-up/email", {
    body: {
      email: "alice@connections-oauth.test",
      password: "alice-strong-password-123",
      name: "Alice Owner",
    },
  });
  const signInRes = await callStudio("/api/auth/sign-in/email", {
    body: {
      email: "alice@connections-oauth.test",
      password: "alice-strong-password-123",
    },
  });
  const aliceCookie = (signInRes.headers.get("set-cookie") ?? "").split(";")[0]!;

  const orgRes = await callStudio("/api/orgs", {
    cookie: aliceCookie,
    body: { name: "OAuth Connections Org", slug: "oauth-conn-org" },
  });
  const orgId = ((await orgRes.json()) as { org: { id: string } }).org.id;

  // Story 0.15: an MCP token is bound to one project of the org.
  const projRes = await callStudio(`/api/orgs/${orgId}/projects`, {
    cookie: aliceCookie,
    body: { project: "oauth-proj" },
  });
  expect(projRes.status).toBe(201);
  const tokRes = await callStudio(`/api/orgs/${orgId}/mcp-tokens`, {
    cookie: aliceCookie,
    body: {
      clientName: "claude-code",
      projectId: "oauth-proj",
      scopes: ["read", "edit"],
    },
  });
  expect(tokRes.status).toBe(201);
  const mcpToken = ((await tokRes.json()) as { token: string }).token;

  return { aliceCookie, orgId, mcpToken };
}

describe("Story 10.2 — OAuth2 PKCE S256 Start/Callback, Case A Connections Vault & Agent Access Enforcement", () => {
  beforeEach(async () => {
    for (const table of [
      "studio_connections_metadata",
      "studio_oauth_states",
      "studio_connection_requests",
      "studio_secret_vault",
      "studio_audit_log",
      "studio_mcp_tokens",
      "studio_org_members",
      "studio_orgs",
      "studio_builds",
      "projects",
      "session",
      "account",
      "verification",
      "user",
    ]) {
      await studioDb
        .prepare(`DROP TABLE IF EXISTS "${table}"`)
        .run()
        .catch(() => {});
    }
    await applyMigration(studioDb, studioAuthOrgsSql);
    await applyMigration(studioDb, studioSecretVaultSql);
    await ensurePxConnectionsTable(envDb);
    await envDb.prepare("DELETE FROM px_connections").run();
  });

  test("1. OAuth2 PKCE S256 start + callback exchanges code with code_verifier, seals tokens into px_connections, and stores only metadata in STUDIO_DB", async () => {
    const { aliceCookie, orgId } = await seedHumanOwnerAndAgentToken();

    let capturedTokenRequestBody = "";
    let capturedTokenUrl = "";

    const mockOAuthFetcher: typeof fetch = async (input, init) => {
      capturedTokenUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      capturedTokenRequestBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          access_token: "xoxb_pkce_oauth_access_token_7788",
          refresh_token: "xoxr_pkce_oauth_refresh_token_6655",
          expires_in: 3600,
          scope: "chat:write,channels:read",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const testEnv: StudioApiEnv = {
      ...BASE_TEST_ENV,
      __OAUTH_FETCHER: mockOAuthFetcher,
    };

    // 1. Start OAuth2 PKCE flow
    const startRes = await callStudio(
      "/api/projects/oauth-proj/connections/oauth/slack/start",
      {
        cookie: aliceCookie,
        orgId,
        env: testEnv,
        body: {
          ref: "sec_slack_pkce",
          scopes: ["chat:write", "channels:read"],
        },
      },
    );
    expect(startRes.status).toBe(200);
    const startJson = (await startRes.json()) as {
      ok: boolean;
      state: string;
      codeChallenge: string;
      codeChallengeMethod: string;
      authorizeUrl: string;
    };
    expect(startJson.ok).toBe(true);
    expect(startJson.codeChallengeMethod).toBe("S256");
    expect(startJson.codeChallenge.length).toBeGreaterThan(20);
    expect(startJson.authorizeUrl).toContain("code_challenge_method=S256");
    expect(startJson.authorizeUrl).toContain(`state=${encodeURIComponent(startJson.state)}`);

    // 2. Complete OAuth2 callback with valid state
    const cbRes = await callStudio(
      `/api/connections/oauth/slack/callback?state=${encodeURIComponent(startJson.state)}&code=auth_code_12345`,
      {
        method: "GET",
        cookie: aliceCookie,
        env: testEnv,
      },
    );
    expect(cbRes.status).toBe(200);
    const cbJson = (await cbRes.json()) as {
      ok: boolean;
      connection: {
        ref: string;
        app: string;
        authType: string;
        keyHint: string;
        status: string;
      };
    };
    expect(cbJson.ok).toBe(true);
    expect(cbJson.connection.ref).toBe("sec_slack_pkce");
    expect(cbJson.connection.keyHint).toBe("••••7788");
    expect(cbJson.connection.status).toBe("connected");
    expect(JSON.stringify(cbJson)).not.toContain("xoxb_pkce_oauth_access_token_7788");
    expect(JSON.stringify(cbJson)).not.toContain("xoxr_pkce_oauth_refresh_token_6655");

    // Verify token exchange included PKCE code_verifier
    expect(capturedTokenUrl).toContain("slack");
    expect(capturedTokenRequestBody).toContain("grant_type=authorization_code");
    expect(capturedTokenRequestBody).toContain("code=auth_code_12345");
    expect(capturedTokenRequestBody).toContain("code_verifier=");

    // Verify px_connections row is AES-GCM sealed and decrypts with PX_CONN_KEY
    const pxRow = await envDb
      .prepare("SELECT ciphertext_b64, iv_b64, key_hint, status FROM px_connections WHERE ref = ?")
      .bind("sec_slack_pkce")
      .first<{ ciphertext_b64: string; iv_b64: string; key_hint: string; status: string }>();
    expect(pxRow).toBeTruthy();
    expect(pxRow?.ciphertext_b64).not.toContain("xoxb_pkce_oauth_access_token_7788");
    const unsealed = await unsealConnectionCredentials(
      pxRow!.ciphertext_b64,
      pxRow!.iv_b64,
      PX_CONN_KEY,
    );
    expect(unsealed.accessToken).toBe("xoxb_pkce_oauth_access_token_7788");
    expect(unsealed.refreshToken).toBe("xoxr_pkce_oauth_refresh_token_6655");

    // Verify studio_connections_metadata contains ONLY non-secret metadata
    const metaRows = await studioDb
      .prepare("SELECT * FROM studio_connections_metadata WHERE ref = ?")
      .bind("sec_slack_pkce")
      .all<Record<string, unknown>>();
    expect((metaRows.results ?? []).length).toBe(1);
    const metaJson = JSON.stringify(metaRows.results);
    expect(metaJson).not.toContain("xoxb_pkce_oauth_access_token_7788");
    expect(metaJson).not.toContain("xoxr_pkce_oauth_refresh_token_6655");
    expect(metaJson).not.toContain(pxRow!.ciphertext_b64);
  });

  test("2. Tampered OAuth2 state on /api/connections/oauth/:app/callback returns 400 OAUTH_STATE_MISMATCH and writes zero connection rows", async () => {
    const { aliceCookie } = await seedHumanOwnerAndAgentToken();
    const cbRes = await callStudio(
      "/api/connections/oauth/slack/callback?state=st_tampered_csrf_99999&code=evil_code",
      { method: "GET", cookie: aliceCookie },
    );
    expect(cbRes.status).toBe(400);
    const body = (await cbRes.json()) as { error: { code: string } };
    expect(body.error.code).toBe("OAUTH_STATE_MISMATCH");

    const rows = await envDb
      .prepare("SELECT COUNT(*) as cnt FROM px_connections")
      .first<{ cnt: number }>();
    expect(Number(rows?.cnt ?? 0)).toBe(0);
  });

  test("3. Supports sealing API key connections, testing, re-authorizing, listing pending requests, and deleting connections", async () => {
    const { aliceCookie, orgId } = await seedHumanOwnerAndAgentToken();

    // Seal API key connection
    const createRes = await callStudio("/api/projects/oauth-proj/connections", {
      cookie: aliceCookie,
      orgId,
      body: {
        ref: "sec_resend_live",
        app: "resend",
        authType: "apiKey",
        label: "Resend Production Key",
        value: "re_live_api_key_secret_3344",
      },
    });
    expect(createRes.status).toBe(200);

    // Create a pending connection request
    const reqRes = await callStudio("/api/projects/oauth-proj/connections/requests", {
      cookie: aliceCookie,
      orgId,
      body: {
        app: "github",
        reason: "Create issues on failure",
        scopes: ["repo"],
        suggestedRef: "sec_github",
      },
    });
    expect(reqRes.status).toBe(200);

    // List connections & requests
    const listRes = await callStudio("/api/projects/oauth-proj/connections", {
      method: "GET",
      cookie: aliceCookie,
      orgId,
    });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      connections: Array<{ ref: string; keyHint: string; status: string }>;
      connectionRequests: Array<{ app: string; status: string }>;
    };
    expect(
      listJson.connections.some(
        (c) => c.ref === "sec_resend_live" && c.keyHint === "••••3344",
      ),
    ).toBe(true);
    expect(
      listJson.connectionRequests.some(
        (r) => r.app === "github" && r.status === "pending",
      ),
    ).toBe(true);
    expect(JSON.stringify(listJson)).not.toContain("re_live_api_key_secret_3344");

    // Test connection
    const testRes = await callStudio(
      "/api/projects/oauth-proj/connections/sec_resend_live/test",
      { method: "POST", cookie: aliceCookie, orgId },
    );
    expect(testRes.status).toBe(200);
    const testJson = (await testRes.json()) as { ok: boolean; status: string };
    expect(testJson.ok).toBe(true);
    expect(testJson.status).toBe("connected");

    // Re-authorize connection with rotated key
    const reauthRes = await callStudio(
      "/api/projects/oauth-proj/connections/sec_resend_live/reauthorize",
      {
        cookie: aliceCookie,
        orgId,
        body: { value: "re_live_rotated_key_5566" },
      },
    );
    expect(reauthRes.status).toBe(200);

    // Delete connection
    const delRes = await callStudio(
      "/api/projects/oauth-proj/connections/sec_resend_live",
      { method: "DELETE", cookie: aliceCookie, orgId },
    );
    expect(delRes.status).toBe(200);
    const afterDel = await envDb
      .prepare("SELECT * FROM px_connections WHERE ref = ?")
      .bind("sec_resend_live")
      .first();
    expect(afterDel).toBeNull();
  });

  test("4. Enforces 403 FORBIDDEN_AGENT_SECRET_ACCESS when an MCP agent attempts to create or authorize connections", async () => {
    const { orgId, mcpToken } = await seedHumanOwnerAndAgentToken();

    const resCreate = await callStudio("/api/projects/oauth-proj/connections", {
      token: mcpToken,
      orgId,
      body: {
        ref: "sec_agent_attempt",
        app: "slack",
        value: "xox" + "b-agent-should-be-blocked",
      },
    });
    expect(resCreate.status).toBe(403);
    const errCreate = (await resCreate.json()) as { error: { code: string } };
    expect(errCreate.error.code).toBe("FORBIDDEN_AGENT_SECRET_ACCESS");

    const resStart = await callStudio(
      "/api/projects/oauth-proj/connections/oauth/slack/start",
      {
        token: mcpToken,
        orgId,
        body: {},
      },
    );
    expect(resStart.status).toBe(403);
  });

  test("5. Story 1.17: a connection's workspace is trimmed and must be `default` or one of the project's own workspaces", async () => {
    const { aliceCookie, orgId } = await seedHumanOwnerAndAgentToken();
    const create = (ref: string, workspaceId: string) =>
      callStudio("/api/projects/oauth-proj/connections", {
        cookie: aliceCookie,
        orgId,
        body: { ref, app: "resend", authType: "apiKey", value: "re_test_api_key_s117_0001", workspaceId },
      });
    const shared = await create("sec_s117_default", " default ");
    expect(shared.status).toBe(200);
    const stored = await envDb
      .prepare("SELECT workspace_id FROM px_connections WHERE ref = ?")
      .bind("sec_s117_default")
      .first<{ workspace_id: string }>();
    expect(stored?.workspace_id).toBe("default");

    // Studio's preview workspace is the project's own; a foreign workspace is 403; a malformed one is 400.
    expect((await create("sec_s117_preview", " ws_default ")).status).toBe(200);
    const trimmed = await envDb
      .prepare("SELECT workspace_id FROM px_connections WHERE ref = ?")
      .bind("sec_s117_preview")
      .first<{ workspace_id: string }>();
    expect(trimmed?.workspace_id).toBe("ws_default");
    const foreign = await create("sec_s117_foreign", "ws_someone_else");
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as { error: { code: string } }).error.code).toBe("WORKSPACE_NOT_IN_PROJECT");
    expect((await create("sec_s117_bad", "ws bad")).status).toBe(400);
    const rows = await envDb
      .prepare("SELECT COUNT(*) AS c FROM px_connections WHERE ref IN ('sec_s117_foreign', 'sec_s117_bad')")
      .first<{ c: number }>();
    expect(Number(rows?.c ?? 0)).toBe(0);

    // The OAuth start refuses a foreign workspace the same way, before any state is stored.
    const start = await callStudio("/api/projects/oauth-proj/connections/oauth/slack/start", {
      cookie: aliceCookie,
      orgId,
      body: { workspaceId: "ws_someone_else" },
    });
    expect(start.status).toBe(403);
  });
});
