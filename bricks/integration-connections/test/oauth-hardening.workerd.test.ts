import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migrationSql from "../migrations/0001_integration_connections.sql?raw";
import { createIntegrationConnectionsRoutes } from "../src/index.ts";
import type { IntegrationConnectionsEnv, OAuthTokenExchangeResult } from "../src/index.ts";

type RouteOptions = NonNullable<Parameters<typeof createIntegrationConnectionsRoutes>[0]>;

/**
 * Story 1.15 (PROPOSED-11, threat model A10-A12): provider account data wins, the caller redirect_uri is allowlisted,
 * a redirecting connect refuses cross-site requests, and OAuth state is bound to the user who started the flow.
 * No real provider is called: every exchange is an injected test function.
 */
describe("story 1.15: integration-connections OAuth hardening (A10, A11, A12)", () => {
  const db = (env as unknown as { DB: D1Like }).DB;
  const pxConnKey = "story-1-15-workerd-conn-key-2026";
  const BASE = "https://app.example.test";
  const alice = { "x-test-user": "user_alice", "x-workspace-id": "ws_A" };
  const bobAdmin = { "x-test-user": "user_bob", "x-workspace-id": "ws_A", "x-test-role": "admin" };

  let exchangeCalls = 0;
  let exchangeResult: Partial<OAuthTokenExchangeResult> = {};

  function createApp(options: Omit<RouteOptions, "adapter"> = {}) {
    const app = new Hono<IntegrationConnectionsEnv>();
    app.use("/api/*", async (c, next) => {
      const uid = c.req.header("x-test-user");
      const wsId = c.req.header("x-workspace-id");
      if (uid) c.set("user", { uid });
      if (wsId) {
        const role = c.req.header("x-test-role") ?? "owner";
        c.set("workspace", { id: wsId, role, suspended: false });
        if (uid) c.set("ctx", Object.freeze({ userId: uid, workspaceId: wsId, role }));
      }
      await next();
    });
    app.route(
      "/api",
      createIntegrationConnectionsRoutes({
        ...options,
        adapter: {
          providers: { google: { clientId: "test-google-client-id" } },
          exchangeCode: async ({ code }) => {
            exchangeCalls += 1;
            return { accessToken: `ya29.test.${code}`, tokenType: "Bearer", expiresIn: 3600, ...exchangeResult };
          },
        },
      }),
    );
    return app;
  }

  const call = (app: Hono<IntegrationConnectionsEnv>, path: string, headers: Record<string, string>, init: RequestInit = {}) =>
    app.fetch(new Request(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } }), {
      DB: db,
      PX_CONN_KEY: pxConnKey,
    });

  const countStates = async () =>
    (await db.prepare("SELECT COUNT(*) AS n FROM int_oauth_states").first<{ n: number }>())?.n ?? 0;
  const connectionRow = () =>
    db
      .prepare("SELECT account_label, external_account_id FROM int_connections WHERE workspace_id = 'ws_A' AND provider = 'google'")
      .first<{ account_label: string; external_account_id: string }>();

  async function startState(app: Hono<IntegrationConnectionsEnv>, headers: Record<string, string> = alice) {
    const res = await call(app, "/api/integrations/google/connect", headers);
    expect(res.status).toBe(200);
    return ((await res.json()) as { state: string }).state;
  }

  beforeEach(async () => {
    exchangeCalls = 0;
    exchangeResult = {};
    await applyMigration(db, migrationSql);
    await db.prepare("DELETE FROM int_connections").run();
    await db.prepare("DELETE FROM int_oauth_states").run();
  });

  // A10
  it("provider account wins: the caller's label and external id (query and body) never override the provider's", async () => {
    exchangeResult = { accountLabel: "alice@provider.example", externalAccountId: "provider_uid_1" };
    const app = createApp();

    const state = await startState(app);
    const res = await call(
      app,
      `/api/integrations/google/callback?code=c1&state=${encodeURIComponent(state)}&account_label=evil%40attacker&external_account_id=victim_uid`,
      alice,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connection: { accountLabel: string; externalAccountId: string } };
    expect(body.connection).toMatchObject({ accountLabel: "alice@provider.example", externalAccountId: "provider_uid_1" });
    expect(await connectionRow()).toEqual({ account_label: "alice@provider.example", external_account_id: "provider_uid_1" });

    const state2 = await startState(app);
    const res2 = await call(app, "/api/integrations/google/callback", alice, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "c2", state: state2, accountLabel: "evil@attacker", externalAccountId: "victim_uid" }),
    });
    expect(res2.status).toBe(200);
    expect(await connectionRow()).toEqual({ account_label: "alice@provider.example", external_account_id: "provider_uid_1" });
  });

  it("caller label fallback: with no provider label the caller's label is trimmed and capped at 128; the external id is the generated fallback", async () => {
    const app = createApp();
    const longLabel = `  ${"x".repeat(200)}  `;
    const state = await startState(app);
    const res = await call(app, "/api/integrations/google/callback", alice, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "c1", state, accountLabel: longLabel, externalAccountId: "victim_uid" }),
    });
    expect(res.status).toBe(200);
    expect(await connectionRow()).toEqual({ account_label: "x".repeat(128), external_account_id: "acct_ws_A_google" });

    const state2 = await startState(app);
    const res2 = await call(
      app,
      `/api/integrations/google/callback?code=c2&state=${encodeURIComponent(state2)}&accountLabel=%20Alice%20Work%20&externalAccountId=victim_uid`,
      alice,
    );
    expect(res2.status).toBe(200);
    expect(await connectionRow()).toEqual({ account_label: "Alice Work", external_account_id: "acct_ws_A_google" });
  });

  it("POST body tolerance: a 500-character label and a numeric externalAccountId complete; the label is capped at 128", async () => {
    const app = createApp();
    const state = await startState(app);
    const res = await call(app, "/api/integrations/google/callback", alice, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "c1", state, accountLabel: "y".repeat(500), externalAccountId: 12345 }),
    });
    expect(res.status).toBe(200);
    expect(await connectionRow()).toEqual({ account_label: "y".repeat(128), external_account_id: "acct_ws_A_google" });
  });

  // A11: redirect allowlist
  it("default redirect: no redirect_uri gives 200 and the authorize URL uses the default callback", async () => {
    const app = createApp({ publicBaseUrl: "https://app.example.com/" });
    const res = await call(app, "/api/integrations/google/connect", alice);
    expect(res.status).toBe(200);
    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    expect(new URL(authorizeUrl).searchParams.get("redirect_uri")).toBe("https://app.example.com/api/integrations/google/callback");

    // Passing the default callback URL explicitly is also accepted.
    const explicit = await call(
      app,
      `/api/integrations/google/connect?redirect_uri=${encodeURIComponent("https://app.example.com/api/integrations/google/callback")}`,
      alice,
    );
    expect(explicit.status).toBe(200);
  });

  it("allowlisted redirect: a redirect_uri listed in allowedRedirectUris gives 200 and is used", async () => {
    const allowed = "https://studio.example.com/oauth/return";
    const app = createApp({ allowedRedirectUris: ` https://other.example.com/cb , ${allowed} ` });
    const res = await call(app, `/api/integrations/google/connect?redirect_uri=${encodeURIComponent(allowed)}`, alice);
    expect(res.status).toBe(200);
    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    expect(new URL(authorizeUrl).searchParams.get("redirect_uri")).toBe(allowed);
    expect(await countStates()).toBe(1);
  });

  it("foreign redirect: a redirect_uri that is neither the default nor allowlisted is 400 REDIRECT_URI_NOT_ALLOWED and stores no state", async () => {
    const app = createApp({ allowedRedirectUris: "https://studio.example.com/oauth/return" });
    for (const uri of [
      "https://evil.example/cb",
      "https://studio.example.com/oauth/return/extra",
      "http://studio.example.com/oauth/return",
      "https://app.projectx.local/api/integrations/other/callback",
    ]) {
      for (const path of ["/api/integrations/google/connect", "/api/connect/google"]) {
        const res = await call(app, `${path}?redirect_uri=${encodeURIComponent(uri)}`, alice);
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe("REDIRECT_URI_NOT_ALLOWED");
      }
    }
    // The redirecting form is refused the same way.
    const redirecting = await call(app, `/api/integrations/google/connect?redirect=1&redirect_uri=${encodeURIComponent("https://evil.example/cb")}`, alice);
    expect(redirecting.status).toBe(400);
    expect(await countStates()).toBe(0);
  });

  // A11: CSRF on the redirecting GET
  it("cross-site redirect GET: Sec-Fetch-Site cross-site or same-site, or a foreign Origin, is 403 CSRF_REJECTED and stores no state", async () => {
    const app = createApp({ publicBaseUrl: "https://studio.example.com" });
    const refusals: Array<Record<string, string>> = [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { origin: "https://evil.example" },
      { origin: "null" },
      { "sec-fetch-site": "same-origin", origin: "https://evil.example" },
    ];
    for (const extra of refusals) {
      for (const path of ["/api/integrations/google/connect?redirect=1", "/api/connect/google?redirect=true"]) {
        const res = await call(app, path, { ...alice, ...extra });
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CSRF_REJECTED");
      }
    }
    expect(await countStates()).toBe(0);

    // The JSON form (no redirect) is unchanged.
    const json = await call(app, "/api/integrations/google/connect", { ...alice, "sec-fetch-site": "cross-site" });
    expect(json.status).toBe(200);
  });

  it("same-origin redirect GET: Sec-Fetch-Site same-origin or none, or absent, or a same-origin / publicBaseUrl Origin, is 302 to the provider", async () => {
    const app = createApp({ publicBaseUrl: "https://studio.example.com" });
    const accepted: Array<Record<string, string>> = [
      {},
      { "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "none" },
      { origin: BASE },
      { origin: "https://studio.example.com" },
    ];
    for (const extra of accepted) {
      const res = await call(app, "/api/integrations/google/connect?redirect=1", { ...alice, ...extra });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toMatch(/^https:\/\/accounts\.google\.com\//);
    }
    expect(await countStates()).toBe(accepted.length);
  });

  // A12
  it("other user's state: admin B completing admin A's state is 400 OAUTH_STATE_MISMATCH, the state is consumed, no exchange, no connection", async () => {
    exchangeResult = { accountLabel: "alice@provider.example", externalAccountId: "provider_uid_1" };
    const app = createApp();
    const state = await startState(app, alice);

    const res = await call(app, `/api/integrations/google/callback?code=stolen&state=${encodeURIComponent(state)}`, bobAdmin);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("OAUTH_STATE_MISMATCH");
    expect(exchangeCalls).toBe(0);
    expect(await countStates()).toBe(0);
    expect(await connectionRow()).toBeNull();

    // The consumed state cannot then be completed by the user who started it.
    const retry = await call(app, `/api/integrations/google/callback?code=late&state=${encodeURIComponent(state)}`, alice);
    expect(retry.status).toBe(400);
    expect(exchangeCalls).toBe(0);
    expect(await connectionRow()).toBeNull();
  });
});
