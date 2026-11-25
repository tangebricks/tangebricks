import { Hono } from "hono";
import { z } from "zod";
import { WORKSPACE_ADMIN_ROLES, authUserId, refuseApiKeyCaller, workspaceRoleRefusal } from "@poc/sdk";
import { OAuthServerService } from "./oauth.ts";
import { oauthMiddleware, type OAuthEnv } from "./middleware.ts";

const RegisterClientSchema = z.object({
  clientName: z.string().min(1).max(100),
  redirectUris: z.array(z.string().url()).min(1),
  allowedScopes: z.array(z.string().min(1)).min(1),
  isConfidential: z.boolean().optional(),
});

const AuthorizeSchema = z.object({
  clientId: z.string().min(1),
  redirectUri: z.string().url(),
  scopes: z.array(z.string().min(1)),
  codeChallenge: z.string().optional(),
  codeChallengeMethod: z.enum(["S256", "plain"]).optional(),
  userId: z.string().optional(),
});

const TokenExchangeSchema = z.object({
  grant_type: z.enum(["authorization_code", "refresh_token", "client_credentials"]),
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
  code: z.string().optional(),
  redirect_uri: z.string().optional(),
  code_verifier: z.string().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});

const IntrospectSchema = z.object({
  token: z.string().min(1),
});

const RevokeSchema = z.object({
  token: z.string().min(1),
});

export function createOAuthRoutes(): Hono<OAuthEnv> {
  const app = new Hono<OAuthEnv>();

  app.use("*", oauthMiddleware);

  // POST /oauth/clients - Register OAuth client. Owner/admin only (story 0.6).
  app.post("/oauth/clients", async (c) => {
    // Story 1.11: an API key never mints credentials that would outlive it.
    const keyRefused = refuseApiKeyCaller(c);
    if (keyRefused) return keyRefused;
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

    const parsed = RegisterClientSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("oauthService") || new OAuthServerService(c.env.DB);
    const result = await service.registerClient({
      workspaceId,
      clientName: parsed.data.clientName,
      redirectUris: parsed.data.redirectUris,
      allowedScopes: parsed.data.allowedScopes,
      isConfidential: parsed.data.isConfidential,
    });

    return c.json(result, 201);
  });

  // GET /oauth/clients - List OAuth clients
  app.get("/oauth/clients", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const service = c.get("oauthService") || new OAuthServerService(c.env.DB);
    const clients = await service.listClients(workspaceId);
    return c.json({ clients });
  });

  // POST /oauth/authorize - Issue Authorization Code. A code grants a client access to the workspace, so the caller
  // must be owner or admin (checked before the body is read), and the code is always for the signed-in user: a body
  // `userId` naming anyone else is refused (audit risk 13).
  app.post("/oauth/authorize", async (c) => {
    // Story 1.11: an API key never mints credentials that would outlive it.
    const keyRefused = refuseApiKeyCaller(c);
    if (keyRefused) return keyRefused;
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const sessionUserId = ctx.userId || authUserId(c.get("user"));
    if (!sessionUserId) return c.json({ error: "Unauthorized" }, 401);

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

    const workspaceId = ctx.workspaceId;
    if (parsed.data.userId !== undefined && parsed.data.userId !== sessionUserId) {
      return c.json({ error: "Forbidden: a code can only be issued for the signed-in user" }, 403);
    }
    const userId = sessionUserId;

    const service = c.get("oauthService") || new OAuthServerService(c.env.DB);
    try {
      const codeRes = await service.createAuthorizationCode({
        clientId: parsed.data.clientId,
        userId,
        workspaceId,
        redirectUri: parsed.data.redirectUri,
        scopes: parsed.data.scopes,
        codeChallenge: parsed.data.codeChallenge,
        codeChallengeMethod: parsed.data.codeChallengeMethod,
      });

      return c.json(codeRes, 201);
    } catch (e: any) {
      return c.json({ error: e.message || "Authorization failed" }, 400);
    }
  });

  // POST /oauth/token - Token Exchange Endpoint
  app.post("/oauth/token", async (c) => {
    // Story 1.11: an API key never mints credentials that would outlive it.
    const keyRefused = refuseApiKeyCaller(c);
    if (keyRefused) return keyRefused;
    let body: unknown;
    try {
      // Handles both JSON and application/x-www-form-urlencoded
      const contentType = c.req.header("content-type") || "";
      if (contentType.includes("application/x-www-form-urlencoded")) {
        body = await c.req.parseBody();
      } else {
        body = await c.req.json();
      }
    } catch {
      return c.json({ error: "invalid_request: Malformed payload" }, 400);
    }

    const parsed = TokenExchangeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: `invalid_request: ${parsed.error.issues.map((i) => i.message).join(", ")}` }, 400);
    }

    const service = c.get("oauthService") || new OAuthServerService(c.env.DB);

    try {
      if (parsed.data.grant_type === "authorization_code") {
        if (!parsed.data.code || !parsed.data.redirect_uri) {
          return c.json({ error: "invalid_request: code and redirect_uri required" }, 400);
        }

        const tokens = await service.exchangeAuthorizationCode({
          clientId: parsed.data.client_id,
          clientSecret: parsed.data.client_secret,
          code: parsed.data.code,
          redirectUri: parsed.data.redirect_uri,
          codeVerifier: parsed.data.code_verifier,
        });

        return c.json(tokens, 200);
      } else if (parsed.data.grant_type === "refresh_token") {
        if (!parsed.data.refresh_token) {
          return c.json({ error: "invalid_request: refresh_token required" }, 400);
        }

        const tokens = await service.refreshAccessToken({
          clientId: parsed.data.client_id,
          clientSecret: parsed.data.client_secret,
          refreshToken: parsed.data.refresh_token,
        });

        return c.json(tokens, 200);
      } else if (parsed.data.grant_type === "client_credentials") {
        const scopes = parsed.data.scope ? parsed.data.scope.split(" ").filter(Boolean) : undefined;
        const tokens = await service.exchangeClientCredentials({
          clientId: parsed.data.client_id,
          clientSecret: parsed.data.client_secret,
          scopes,
        });

        return c.json(tokens, 200);
      }

      return c.json({ error: "unsupported_grant_type" }, 400);
    } catch (e: any) {
      return c.json({ error: e.message || "Token exchange failed" }, 400);
    }
  });

  // POST /oauth/introspect - Token Introspection (RFC 7662)
  app.post("/oauth/introspect", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }

    const parsed = IntrospectSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_request: token required" }, 400);
    }

    const service = c.get("oauthService") || new OAuthServerService(c.env.DB);
    const info = await service.introspectToken(parsed.data.token);
    return c.json(info);
  });

  // POST /oauth/revoke - Token Revocation (RFC 7009)
  app.post("/oauth/revoke", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }

    const parsed = RevokeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_request: token required" }, 400);
    }

    const service = c.get("oauthService") || new OAuthServerService(c.env.DB);
    await service.revokeToken(parsed.data.token);
    // RFC 7009: 200 OK regardless of whether token existed
    return c.json({ success: true });
  });

  return app;
}
