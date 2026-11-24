import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_oauth_server.sql?raw";
import {
  OAuthServerService,
  computeCodeChallenge,
  createOAuthRoutes,
} from "../src/index.ts";
import type { OAuthEnv } from "../src/middleware.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_oauth_alpha";
const WS_BETA = "ws_oauth_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS oauth_tokens").run();
  await db.prepare("DROP TABLE IF EXISTS oauth_auth_codes").run();
  await db.prepare("DROP TABLE IF EXISTS oauth_clients").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("OAuth 2.0 PKCE & Service Core", () => {
  it("computes RFC 7636 PKCE S256 code challenge correctly", async () => {
    // Standard RFC 7636 Appendix B test vector:
    // verifier: dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
    // challenge: E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await computeCodeChallenge(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("completes full Authorization Code grant with PKCE S256 and token refresh", async () => {
    const service = new OAuthServerService(db);

    // 1. Register public client (e.g. SPA / Mobile)
    const reg = await service.registerClient({
      workspaceId: WS_ALPHA,
      clientName: "Mobile App",
      redirectUris: ["https://app.example.com/callback"],
      allowedScopes: ["read", "write"],
      isConfidential: false,
    });
    expect(reg.client.is_confidential).toBe(false);
    expect(reg.clientSecret).toBeNull();

    // 2. Prepare PKCE verifier & challenge
    const verifier = "secret_verifier_string_with_enough_entropy_123456789";
    const challenge = await computeCodeChallenge(verifier);

    // 3. Issue Authorization Code
    const authRes = await service.createAuthorizationCode({
      clientId: reg.client.client_id,
      userId: "usr_alice",
      workspaceId: WS_ALPHA,
      redirectUri: "https://app.example.com/callback",
      scopes: ["read"],
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    expect(authRes.code).toMatch(/^code_[a-f0-9]{32}$/);

    // 4. Exchange Code with Wrong Verifier -> should fail
    await expect(
      service.exchangeAuthorizationCode({
        clientId: reg.client.client_id,
        code: authRes.code,
        redirectUri: "https://app.example.com/callback",
        codeVerifier: "wrong_verifier",
      })
    ).rejects.toThrow("PKCE verification failed");

    // 5. Exchange Code with Valid Verifier
    const tokens = await service.exchangeAuthorizationCode({
      clientId: reg.client.client_id,
      code: authRes.code,
      redirectUri: "https://app.example.com/callback",
      codeVerifier: verifier,
    });

    expect(tokens.access_token).toMatch(/^at_[a-f0-9]{32}$/);
    expect(tokens.refresh_token).toMatch(/^rt_[a-f0-9]{32}$/);
    expect(tokens.scope).toBe("read");
    expect(tokens.expires_in).toBe(3600);

    // 6. Reuse of same code must be rejected
    await expect(
      service.exchangeAuthorizationCode({
        clientId: reg.client.client_id,
        code: authRes.code,
        redirectUri: "https://app.example.com/callback",
        codeVerifier: verifier,
      })
    ).rejects.toThrow("already used");

    // 7. Introspect access token
    const introspect = await service.introspectToken(tokens.access_token);
    expect(introspect.active).toBe(true);
    expect(introspect.client_id).toBe(reg.client.client_id);
    expect(introspect.user_id).toBe("usr_alice");

    // 8. Refresh Token Rotation
    const newTokens = await service.refreshAccessToken({
      clientId: reg.client.client_id,
      refreshToken: tokens.refresh_token!,
    });
    expect(newTokens.access_token).not.toBe(tokens.access_token);
    expect(newTokens.refresh_token).not.toBe(tokens.refresh_token);

    // 9. Old refresh token cannot be reused
    await expect(
      service.refreshAccessToken({
        clientId: reg.client.client_id,
        refreshToken: tokens.refresh_token!,
      })
    ).rejects.toThrow("revoked");
  });

  it("handles Client Credentials grant and Token Revocation", async () => {
    const service = new OAuthServerService(db);

    // 1. Confidential client (M2M backend service)
    const reg = await service.registerClient({
      workspaceId: WS_ALPHA,
      clientName: "Backend Sync Service",
      redirectUris: ["https://backend.example.com/oauth/cb"],
      allowedScopes: ["sync", "reports"],
      isConfidential: true,
    });

    expect(reg.clientSecret).toBeDefined();

    // 2. Exchange client credentials
    const tokens = await service.exchangeClientCredentials({
      clientId: reg.client.client_id,
      clientSecret: reg.clientSecret!,
      scopes: ["sync"],
    });

    expect(tokens.access_token).toBeDefined();
    expect(tokens.scope).toBe("sync");

    // 3. Introspect active token
    let info = await service.introspectToken(tokens.access_token);
    expect(info.active).toBe(true);

    // 4. Revoke token
    const revoked = await service.revokeToken(tokens.access_token);
    expect(revoked).toBe(true);

    // 5. Introspect again -> active should be false
    info = await service.introspectToken(tokens.access_token);
    expect(info.active).toBe(false);
  });

  it("enforces multi-tenant workspace isolation for client apps", async () => {
    const service = new OAuthServerService(db);

    await service.registerClient({
      workspaceId: WS_ALPHA,
      clientName: "Alpha Portal",
      redirectUris: ["https://alpha.example.com/oauth"],
      allowedScopes: ["read"],
    });

    const betaClients = await service.listClients(WS_BETA);
    expect(betaClients).toHaveLength(0);
  });
});

describe("OAuth 2.0 REST Endpoints", () => {
  function createApp(workspaceId: string = WS_ALPHA, role: string | null = "admin", uid = "usr_developer_1") {
    const app = new Hono<OAuthEnv>();
    app.use("*", async (c, next) => {
      if (role) {
        c.set("workspace", { id: workspaceId, role });
        c.set("ctx", Object.freeze({ userId: uid, workspaceId, role }));
        c.set("user", { uid, name: "OAuth Dev" });
      }
      await next();
    });
    app.route("/", createOAuthRoutes());
    return app;
  }

  it("registers clients, exchanges code, introspects and revokes via HTTP", async () => {
    const app = createApp();

    // 1. Register Client
    const regRes = await app.request(
      "http://localhost/oauth/clients",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName: "Customer Portal",
          redirectUris: ["https://portal.example.com/cb"],
          allowedScopes: ["read", "write"],
          isConfidential: true,
        }),
      },
      { DB: db }
    );
    expect(regRes.status).toBe(201);
    const regJson = (await regRes.json()) as any;
    const clientId = regJson.client.client_id;
    const clientSecret = regJson.clientSecret;

    // 2. Authorize
    const authRes = await app.request(
      "http://localhost/oauth/authorize",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          redirectUri: "https://portal.example.com/cb",
          scopes: ["read"],
        }),
      },
      { DB: db }
    );
    expect(authRes.status).toBe(201);
    const authJson = (await authRes.json()) as any;
    const code = authJson.code;

    // 3. Token Exchange
    const tokenRes = await app.request(
      "http://localhost/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: "https://portal.example.com/cb",
        }),
      },
      { DB: db }
    );
    expect(tokenRes.status).toBe(200);
    const tokenJson = (await tokenRes.json()) as any;
    expect(tokenJson.access_token).toBeDefined();

    // 4. Introspect
    const introRes = await app.request(
      "http://localhost/oauth/introspect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tokenJson.access_token }),
      },
      { DB: db }
    );
    expect(introRes.status).toBe(200);
    const introJson = (await introRes.json()) as any;
    expect(introJson.active).toBe(true);

    // 5. Revoke
    const revokeRes = await app.request(
      "http://localhost/oauth/revoke",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tokenJson.access_token }),
      },
      { DB: db }
    );
    expect(revokeRes.status).toBe(200);
  });

  it("story 0.6: POST /oauth/clients needs owner/admin (UNAUTH 401, MEMBER 403, ADMIN 201)", async () => {
    const reg = (role: string | null, body = JSON.stringify({ clientName: "App", redirectUris: ["https://a.example.com/cb"], allowedScopes: ["read"] })) =>
      createApp(WS_ALPHA, role).request("http://localhost/oauth/clients", { method: "POST", headers: { "Content-Type": "application/json" }, body }, { DB: db });
    expect((await reg(null)).status).toBe(401);
    expect((await reg("member")).status).toBe(403);
    expect((await reg("member", "{bad")).status).toBe(403);
    expect(await new OAuthServerService(db).listClients(WS_ALPHA)).toHaveLength(0);
    expect((await reg("admin")).status).toBe(201);
  });

  describe("POST /oauth/authorize authorisation (story 0.6, audit risk 13)", () => {
    async function registerClient(): Promise<string> {
      const service = new OAuthServerService(db);
      const res = await service.registerClient({
        workspaceId: WS_ALPHA,
        clientName: "Portal",
        redirectUris: ["https://portal.example.com/cb"],
        allowedScopes: ["read"],
        isConfidential: false,
      });
      return res.client.client_id;
    }
    const authorize = (app: Hono<OAuthEnv>, body: Record<string, unknown> | string) =>
      app.request("http://localhost/oauth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }, { DB: db });
    async function codes(): Promise<Array<{ user_id: string }>> {
      return (await db.prepare("SELECT user_id FROM oauth_auth_codes").all<{ user_id: string }>()).results;
    }

    it("UNAUTH_ADMIN 401 and MEMBER_ADMIN 403 (before validation); no code issued", async () => {
      const clientId = await registerClient();
      const body = { clientId, redirectUri: "https://portal.example.com/cb", scopes: ["read"] };
      expect((await authorize(createApp(WS_ALPHA, null), body)).status).toBe(401);
      expect((await authorize(createApp(WS_ALPHA, "member", "usr_carol"), body)).status).toBe(403);
      expect((await authorize(createApp(WS_ALPHA, "member", "usr_carol"), "{bad")).status).toBe(403);
      expect(await codes()).toHaveLength(0);
    });

    it("OAUTH_BODY_USER: a body userId other than the session user is refused (403); none or the same issues for the session user", async () => {
      const clientId = await registerClient();
      const base = { clientId, redirectUri: "https://portal.example.com/cb", scopes: ["read"] };
      const app = createApp(WS_ALPHA, "admin", "usr_admin");
      expect((await authorize(app, { ...base, userId: "usr_victim" })).status).toBe(403);
      expect(await codes()).toHaveLength(0);
      expect((await authorize(app, base)).status).toBe(201);
      expect((await authorize(app, { ...base, userId: "usr_admin" })).status).toBe(201);
      expect((await codes()).map((r) => r.user_id)).toEqual(["usr_admin", "usr_admin"]);
    });
  });
});
