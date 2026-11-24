import { Hono } from "hono";
import { z } from "zod";
import { WORKSPACE_ADMIN_ROLES, workspaceRoleRefusal } from "@poc/sdk";
import { IdentityFederationService, type SsoConnection, type SsoProviderType } from "./federation.ts";
import { ssoMiddleware, type SsoEnv } from "./middleware.ts";

const CreateConnectionSchema = z.object({
  domain: z.string().min(3).max(255),
  providerType: z.enum(["oidc", "saml", "google", "github", "microsoft", "apple"]),
  displayName: z.string().min(1).max(100),
  clientId: z.string().min(1).max(255),
  clientSecret: z.string().max(512).optional(),
  issuerUrl: z.string().url().max(512),
  authorizationEndpoint: z.string().url().max(512).optional(),
  tokenEndpoint: z.string().url().max(512).optional(),
  userinfoEndpoint: z.string().url().max(512).optional(),
  scimToken: z.string().max(255).optional(),
});

const AuthorizeSchema = z.object({
  domain: z.string().min(3).max(255),
  redirectUri: z.string().url(),
  state: z.string().min(1).optional(),
});

const ScimUserSchema = z.object({
  id: z.string().min(1),
  userName: z.string().email(),
  displayName: z.string().optional(),
});

/**
 * What a caller is shown of an SSO connection: never the client secret or the SCIM bearer token, only whether each is
 * set (audit risk 9).
 */
function publicConnection(conn: SsoConnection & { client_secret?: unknown }, secretsSet: { clientSecret: boolean; scimToken: boolean }) {
  const { scim_token: _scimToken, client_secret: _clientSecret, ...rest } = conn;
  return { ...rest, has_client_secret: secretsSet.clientSecret, has_scim_token: secretsSet.scimToken };
}

export interface SsoRouteAdapter {
  service?: IdentityFederationService;
}

export function createSsoRoutes({ adapter }: { adapter?: SsoRouteAdapter } = {}): Hono<SsoEnv> {
  const app = new Hono<SsoEnv>();

  app.use("*", async (c, next) => {
    if (adapter?.service) {
      c.set("ssoService", adapter.service);
    }
    await next();
  });

  app.use("*", ssoMiddleware);

  // POST /sso/connections - create or update (by domain) the workspace's SSO connection. Owner/admin only, checked
  // before the body is read (audit risk 9).
  app.post("/sso/connections", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateConnectionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("ssoService") || new IdentityFederationService(c.env.DB);
    const conn = await service.createConnection({
      workspaceId,
      domain: parsed.data.domain,
      providerType: parsed.data.providerType as SsoProviderType,
      displayName: parsed.data.displayName,
      clientId: parsed.data.clientId,
      clientSecret: parsed.data.clientSecret,
      issuerUrl: parsed.data.issuerUrl,
      authorizationEndpoint: parsed.data.authorizationEndpoint,
      tokenEndpoint: parsed.data.tokenEndpoint,
      userinfoEndpoint: parsed.data.userinfoEndpoint,
      scimToken: parsed.data.scimToken,
    });

    const secretsSet = { clientSecret: Boolean(parsed.data.clientSecret?.trim()), scimToken: Boolean(parsed.data.scimToken?.trim()) };
    return c.json({ connection: publicConnection(conn, secretsSet) }, 201);
  });

  // GET /sso/discover - domain based discovery
  app.get("/sso/discover", async (c) => {
    const email = c.req.query("email");
    if (!email) {
      return c.json({ error: "email query parameter is required" }, 400);
    }

    const service = c.get("ssoService") || new IdentityFederationService(c.env.DB);
    const conn = await service.getConnectionByDomain(email);

    if (!conn) {
      return c.json({ sso_enabled: false }, 200);
    }

    return c.json({
      sso_enabled: true,
      provider: conn.provider_type,
      display_name: conn.display_name,
      domain: conn.domain,
    }, 200);
  });

  // POST /sso/authorize - get authorization URL and store transient PKCE request
  app.post("/sso/authorize", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = AuthorizeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const service = c.get("ssoService") || new IdentityFederationService(c.env.DB);
    let result: Awaited<ReturnType<typeof service.createAuthRequest>>;
    try {
      result = await service.createAuthRequest({
        domain: parsed.data.domain,
        redirectUri: parsed.data.redirectUri,
        state: parsed.data.state,
      });
    } catch (err: any) {
      return c.json({ error: err.message || "Failed to create SSO authorize request" }, 404);
    }

    return c.json({
      authorize_url: result.authorizeUrl,
      state: result.state,
      nonce: result.nonce,
      code_challenge: result.codeChallenge,
    }, 200);
  });

  // GET /sso/callback - handle IdP authorization-code callback
  app.get("/sso/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");

    if (!code || !state) {
      return c.json({ error: "Missing code or state parameter" }, 400);
    }

    const service = c.get("ssoService") || new IdentityFederationService(c.env.DB);
    const sessionProvider = (c.get as any)("sessionProvider") || (c.env as any).sessionProvider;

    const result = await service.completeOidcCallback(code, state, {
      sessionProvider,
    });

    if (!result.ok) {
      return c.json({ error: result.error, code: result.code }, result.status as any);
    }

    return c.json({
      ok: true,
      identity: result.identity,
      session: result.session,
    }, 200);
  });

  // POST /sso/saml/acs - refuse SAML assertions with stable 501
  app.post("/sso/saml/acs", async (c) => {
    return c.json({
      error: "SSO_SAML_UNSUPPORTED",
      code: "SSO_SAML_UNSUPPORTED",
      message: "SAML assertion consumer service is not supported",
    }, 501);
  });

  // POST /sso/scim/v2/Users - SCIM directory sync
  app.post("/sso/scim/v2/Users", async (c) => {
    const authHeader = c.req.header("authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const connId = c.req.header("x-connection-id") || c.req.query("connectionId");

    if (!connId || !token) {
      return c.json({ error: "Missing SCIM authorization token or connection ID" }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = ScimUserSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const service = c.get("ssoService") || new IdentityFederationService(c.env.DB);
    const result = await service.scimSyncUser(connId, token, parsed.data);

    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }

    return c.json({ user: result.identity }, 201);
  });

  return app;
}
