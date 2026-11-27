import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration1 from "../migrations/0001_identity_federation.sql?raw";
import migration2 from "../migrations/0002_auth_requests.sql?raw";
import workspaceMigration from "../../multi-workspace/migrations/0001_multi_workspace.sql?raw";
import { IdentityFederationService, createSsoRoutes } from "../src/index.ts";
import type { SsoEnv } from "../src/middleware.ts";
import { stubWorkspaceContext } from "../../multi-workspace/test/support/stub-workspace-context.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_sso_alpha";
const WS_BETA = "ws_sso_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS sso_auth_requests").run();
  await db.prepare("DROP TABLE IF EXISTS sso_federated_identities").run();
  await db.prepare("DROP TABLE IF EXISTS sso_connections").run();
  await applyMigration(db, migration1);
  await applyMigration(db, migration2);
  // SCIM checks the connection's workspace (story 1.10), so the workspaces exist here.
  await db.prepare("DROP TABLE IF EXISTS mw_invites").run();
  await db.prepare("DROP TABLE IF EXISTS mw_members").run();
  await db.prepare("DROP TABLE IF EXISTS mw_workspaces").run();
  await applyMigration(db, workspaceMigration);
  await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES (?, 'Alpha', 'o'), (?, 'Beta', 'o')").bind(WS_ALPHA, WS_BETA).run();
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Identity Federation Core Logic", () => {
  it("registers SSO connection and resolves by email domain", async () => {
    const service = new IdentityFederationService(db);
    const conn = await service.createConnection({
      workspaceId: WS_ALPHA,
      domain: "acme.corp",
      providerType: "oidc",
      displayName: "Acme Okta SSO",
      clientId: "client_okta_123",
      issuerUrl: "https://acme.okta.com",
    });

    expect(conn.id).toMatch(/^sso_[a-f0-9]{32}$/);
    expect(conn.domain).toBe("acme.corp");

    // Discover by user email
    const discovered = await service.getConnectionByDomain("ceo@acme.corp");
    expect(discovered).not.toBeNull();
    expect(discovered?.id).toBe(conn.id);
    expect(discovered?.display_name).toBe("Acme Okta SSO");

    // Non-existent domain
    expect(await service.getConnectionByDomain("user@unknown.com")).toBeNull();
  });

  it("builds standard OIDC authorize redirect URL", async () => {
    const service = new IdentityFederationService(db);
    const conn = await service.createConnection({
      workspaceId: WS_ALPHA,
      domain: "initech.com",
      providerType: "oidc",
      displayName: "Initech Azure AD",
      clientId: "azure_client_999",
      issuerUrl: "https://login.microsoftonline.com/common/v2.0",
      authorizationEndpoint: "https://login.microsoftonline.com/oauth2/v2.0/authorize",
    });

    const url = service.buildAuthorizeUrl(conn, "https://app.projectx.dev/callback", "random_state_xyz");
    const parsed = new URL(url);

    expect(parsed.origin + parsed.pathname).toBe("https://login.microsoftonline.com/oauth2/v2.0/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("azure_client_999");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://app.projectx.dev/callback");
    expect(parsed.searchParams.get("state")).toBe("random_state_xyz");
    expect(parsed.searchParams.get("response_type")).toBe("code");
  });

  it("links federated identity and updates login timestamp idempotently", async () => {
    const service = new IdentityFederationService(db);
    const conn = await service.createConnection({
      workspaceId: WS_ALPHA,
      domain: "globex.com",
      providerType: "google",
      displayName: "Globex Google Workspace",
      clientId: "google_client_111",
      issuerUrl: "https://accounts.google.com",
    });

    const fid1 = await service.linkFederatedIdentity(conn.id, WS_ALPHA, "google_sub_888999", "homer@globex.com", "Homer Simpson");

    expect(fid1.id).toMatch(/^fid_[a-f0-9]{32}$/);
    expect(fid1.email).toBe("homer@globex.com");
    expect(fid1.external_subject_id).toBe("google_sub_888999");

    // Subsequent login with updated display name
    const fid2 = await service.linkFederatedIdentity(conn.id, WS_ALPHA, "google_sub_888999", "homer@globex.com", "Homer J. Simpson");

    expect(fid2.display_name).toBe("Homer J. Simpson");
    expect(fid2.id).toBe(fid1.id); // Same record updated
  });

  it("provisions users via SCIM directory synchronization", async () => {
    const service = new IdentityFederationService(db);
    const conn = await service.createConnection({
      workspaceId: WS_ALPHA,
      domain: "wayne.com",
      providerType: "oidc",
      displayName: "Wayne Enterprises",
      clientId: "wayne_client",
      issuerUrl: "https://sso.wayne.com",
      scimToken: "scim_secret_token_12345",
    });

    // SCIM call with invalid token fails
    const failRes = await service.scimSyncUser(conn.id, "bad_token", {
      id: "scim_usr_1",
      userName: "bruce@wayne.com",
    });
    expect(failRes.ok).toBe(false);

    // SCIM call with valid token succeeds
    const okRes = await service.scimSyncUser(conn.id, "scim_secret_token_12345", {
      id: "scim_usr_1",
      userName: "bruce@wayne.com",
      displayName: "Bruce Wayne",
    });
    expect(okRes.ok).toBe(true);
    expect(okRes.identity?.email).toBe("bruce@wayne.com");
  });

  it("strictly isolates SSO connections between workspaces", async () => {
    const service = new IdentityFederationService(db);
    const connA = await service.createConnection({
      workspaceId: WS_ALPHA,
      domain: "acme.corp",
      providerType: "oidc",
      displayName: "Acme Alpha",
      clientId: "client_a",
      issuerUrl: "https://idp.a.com",
    });

    const connB = await service.createConnection({
      workspaceId: WS_BETA,
      domain: "beta.corp",
      providerType: "oidc",
      displayName: "Beta Corp",
      clientId: "client_b",
      issuerUrl: "https://idp.b.com",
    });

    expect(connA.workspace_id).toBe(WS_ALPHA);
    expect(connB.workspace_id).toBe(WS_BETA);
  });
});

describe("Identity Federation HTTP API", () => {
  it("provides full HTTP workflow for connection registration, discovery, and SCIM", async () => {
    const app = new Hono<SsoEnv>();
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createSsoRoutes());

    // 1. POST /sso/connections
    const createRes = await app.request(
      "/api/sso/connections",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
        body: JSON.stringify({
          domain: "cyberdyne.com",
          providerType: "oidc",
          displayName: "Cyberdyne SSO",
          clientId: "client_t800",
          issuerUrl: "https://auth.cyberdyne.com",
          scimToken: "scim_bearer_t800",
        }),
      },
      { DB: db },
    );
    expect(createRes.status).toBe(201);
    const createJson = (await createRes.json()) as { connection: { id: string } };
    const connId = createJson.connection.id;

    // 2. GET /sso/discover
    const discRes = await app.request("/api/sso/discover?email=sarah@cyberdyne.com", {}, { DB: db });
    expect(discRes.status).toBe(200);
    const discJson = (await discRes.json()) as { sso_enabled: boolean; provider: string };
    expect(discJson.sso_enabled).toBe(true);
    expect(discJson.provider).toBe("oidc");

    // 3. POST /sso/authorize
    const authRes = await app.request(
      "/api/sso/authorize",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: "cyberdyne.com",
          redirectUri: "https://app.projectx.dev/auth/callback",
          state: "state_12345",
        }),
      },
      { DB: db },
    );
    expect(authRes.status).toBe(200);
    const authJson = (await authRes.json()) as { authorize_url: string };
    expect(authJson.authorize_url).toContain("auth.cyberdyne.com");

    // 4. POST /sso/scim/v2/Users
    const scimRes = await app.request(
      "/api/sso/scim/v2/Users",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer scim_bearer_t800",
          "x-connection-id": connId,
        },
        body: JSON.stringify({
          id: "scim_usr_99",
          userName: "john@cyberdyne.com",
          displayName: "John Connor",
        }),
      },
      { DB: db },
    );
    expect(scimRes.status).toBe(201);
    const scimJson = (await scimRes.json()) as { user: { email: string } };
    expect(scimJson.user.email).toBe("john@cyberdyne.com");
  });
});

describe("SSO connection authorisation and secret masking (story 0.6, audit risk 9)", () => {
  function app(): Hono<SsoEnv> {
    const a = new Hono<SsoEnv>();
    a.use("/api/*", stubWorkspaceContext);
    a.route("/api", createSsoRoutes());
    return a;
  }
  const connBody = (clientId: string) =>
    JSON.stringify({
      domain: "acme.test",
      providerType: "oidc",
      displayName: "Acme",
      clientId,
      clientSecret: "client-secret-value-123",
      issuerUrl: "https://idp.acme.test",
      scimToken: "scim-secret-token-456",
    });
  const post = (headers: Record<string, string>, body: string) =>
    app().request("/api/sso/connections", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body }, { DB: db });
  async function connCount(): Promise<number> {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM sso_connections").first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  it("UNAUTH_ADMIN: no user gets 401 and nothing is written", async () => {
    expect((await post({}, connBody("c1"))).status).toBe(401);
    expect(await connCount()).toBe(0);
  });

  it("MEMBER_ADMIN: a plain member gets 403 (also for an invalid body) on create and on overwrite", async () => {
    const owner = { "x-workspace-id": WS_ALPHA, "x-test-user": "usr_owner", "x-test-role": "owner" };
    expect((await post(owner, connBody("original"))).status).toBe(201);
    const member = { "x-workspace-id": WS_ALPHA, "x-test-user": "usr_member", "x-test-role": "member" };
    expect((await post(member, connBody("hijacked"))).status).toBe(403);
    expect((await post(member, "{bad")).status).toBe(403);
    const row = await db.prepare("SELECT client_id FROM sso_connections WHERE domain = ?").bind("acme.test").first<{ client_id: string }>();
    expect(row?.client_id).toBe("original");
  });

  it("ADMIN_OK + SSO_SECRET: admin creates and updates; no response carries the client secret or SCIM token", async () => {
    const admin = { "x-workspace-id": WS_ALPHA, "x-test-user": "usr_admin", "x-test-role": "admin" };
    for (const clientId of ["first", "second"]) {
      const res = await post(admin, connBody(clientId));
      expect(res.status).toBe(201);
      const text = await res.text();
      expect(text).not.toContain("client-secret-value-123");
      expect(text).not.toContain("scim-secret-token-456");
      const json = JSON.parse(text) as { connection: Record<string, unknown> };
      expect(json.connection.client_id).toBe(clientId);
      expect(json.connection).not.toHaveProperty("client_secret");
      expect(json.connection).not.toHaveProperty("scim_token");
      expect(json.connection.has_client_secret).toBe(true);
      expect(json.connection.has_scim_token).toBe(true);
    }
    expect(await connCount()).toBe(1);
    // Discovery (the only other response about a connection) carries no secret either.
    const disc = await app().request("/api/sso/discover?email=x@acme.test", {}, { DB: db });
    const discText = await disc.text();
    expect(discText).not.toContain("client-secret-value-123");
    expect(discText).not.toContain("scim-secret-token-456");
  });
});

describe("SCIM refuses a suspended workspace (story 1.10)", () => {
  async function scim(connId: string) {
    const app = new Hono<SsoEnv>();
    app.route("/api", createSsoRoutes());
    return app.request(
      "/api/sso/scim/v2/Users",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer scim_tok_suspend", "x-connection-id": connId },
        body: JSON.stringify({ id: "scim_usr_s", userName: "s@susp.example" }),
      },
      { DB: db },
    );
  }
  async function connection(): Promise<string> {
    const conn = await new IdentityFederationService(db).createConnection({
      workspaceId: WS_ALPHA,
      domain: "susp.example",
      providerType: "oidc",
      displayName: "Suspend Test",
      clientId: "client_s",
      issuerUrl: "https://idp.susp.example",
      scimToken: "scim_tok_suspend",
    });
    return conn.id;
  }

  it("answers 403 WORKSPACE_SUSPENDED and writes nothing while the workspace is suspended", async () => {
    const connId = await connection();
    await db.prepare("UPDATE mw_workspaces SET suspended = 1 WHERE id = ?").bind(WS_ALPHA).run();
    const res = await scim(connId);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("WORKSPACE_SUSPENDED");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM sso_federated_identities").first<{ n: number }>()).toEqual({ n: 0 });

    await db.prepare("UPDATE mw_workspaces SET suspended = 0 WHERE id = ?").bind(WS_ALPHA).run();
    expect((await scim(connId)).status).toBe(201);
  });

  it("fails closed with 503 when the workspace table cannot be read", async () => {
    const connId = await connection();
    await db.prepare("DROP TABLE IF EXISTS mw_invites").run();
    await db.prepare("DROP TABLE IF EXISTS mw_members").run();
    await db.prepare("DROP TABLE mw_workspaces").run();
    const res = await scim(connId);
    expect(res.status).toBe(503);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM sso_federated_identities").first<{ n: number }>()).toEqual({ n: 0 });
  });
});
