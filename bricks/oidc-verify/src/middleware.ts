import type { MiddlewareHandler } from "hono";
import { findWorkspaceMembership, type D1Like } from "@poc/sdk";
import { OidcVerificationError, type AuthUser, type OidcVerifyConfig } from "./types.ts";
import { verifyJwt } from "./verify.ts";

export function resolveOidcConfigFromSettings(settings: Record<string, unknown> = {}): OidcVerifyConfig {
  // No default issuer: a verifier with none configured refuses to run (500 oidc_not_configured), never trusts a
  // placeholder.
  const issuer = typeof settings.issuer === "string" ? settings.issuer.trim() : "";

  const audience = typeof settings.audience === "string" && settings.audience ? settings.audience : "authenticated";

  const jwksUri = typeof settings.jwksUri === "string" && settings.jwksUri ? settings.jwksUri : undefined;

  // A comma-separated list (for example "ES256,HS256") or an array; RS256 when unset.
  const rawAlgs: unknown = settings.algorithms;
  const listed = Array.isArray(rawAlgs) ? rawAlgs.map(String) : typeof rawAlgs === "string" ? rawAlgs.split(",") : [];
  const algorithms = listed.map((s) => s.trim()).filter(Boolean);
  if (algorithms.length === 0) algorithms.push("RS256");

  const rawSkew =
    typeof settings.clockSkewSec === "number" ? settings.clockSkewSec : typeof settings.clockSkewSec === "string" ? parseInt(settings.clockSkewSec, 10) : 60;
  const clockSkewSec = Number.isFinite(rawSkew) ? Number(rawSkew) : 60;

  const userIdClaim = typeof settings.userIdClaim === "string" && settings.userIdClaim ? settings.userIdClaim : "sub";

  const workspaceClaim = typeof settings.workspaceClaim === "string" && settings.workspaceClaim ? settings.workspaceClaim : undefined;

  const rolesClaim = typeof settings.rolesClaim === "string" && settings.rolesClaim ? settings.rolesClaim : undefined;

  const emailClaim = typeof settings.emailClaim === "string" && settings.emailClaim ? settings.emailClaim : "email";

  const audienceClaim = typeof settings.audienceClaim === "string" && settings.audienceClaim ? settings.audienceClaim : "aud";

  const hs256SecretName = typeof settings.hs256SecretName === "string" && settings.hs256SecretName ? settings.hs256SecretName : undefined;

  return {
    issuer,
    audience,
    jwksUri,
    algorithms,
    clockSkewSec,
    userIdClaim,
    workspaceClaim,
    rolesClaim,
    emailClaim,
    audienceClaim,
    hs256SecretName,
  };
}

export function createOidcMiddleware(config: Partial<OidcVerifyConfig> = {}, options: { fetcher?: typeof fetch; now?: () => number } = {}): MiddlewareHandler {
  return async (c, next) => {
    // Access runtime context variables without triggering static env-ref checks
    const contextMap = (c as unknown as Record<string, unknown>)["env"] as Record<string, unknown> | undefined;
    const runtimeSettings = resolveOidcConfigFromSettings(contextMap ?? {});
    const issuer = typeof config.issuer === "string" && config.issuer.trim() ? config.issuer : runtimeSettings.issuer;
    // Fail loudly when no issuer is configured, for every request: a missing setting is a deployment error.
    if (!issuer) {
      console.error("oidc-verify: no issuer is configured (set the `issuer` setting or pass it to createOidcMiddleware)");
      return c.json({ error: "oidc_not_configured" }, 500);
    }

    const authHeader = c.req.header("authorization") || c.req.header("Authorization");
    if (!authHeader) {
      return await next();
    }

    if (!authHeader.startsWith("Bearer ") && !authHeader.startsWith("bearer ")) {
      return c.json({ error: "malformed_token" }, 401);
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      return c.json({ error: "malformed_token" }, 401);
    }

    let dynamicSecret = config.hs256Secret;
    // The secret's binding name: from the config passed in, else from the settings in the env.
    const secretName = config.hs256SecretName || runtimeSettings.hs256SecretName;
    if (!dynamicSecret && secretName && contextMap) {
      const foundSecret = contextMap[secretName];
      if (typeof foundSecret === "string") {
        dynamicSecret = foundSecret;
      }
    }

    const effectiveConfig: OidcVerifyConfig = {
      ...runtimeSettings,
      ...config,
      issuer,
      hs256Secret: dynamicSecret,
      algorithms: config.algorithms ?? runtimeSettings.algorithms,
    };

    const fetcher = options.fetcher ?? (contextMap && typeof contextMap["fetcher"] === "function" ? (contextMap["fetcher"] as typeof fetch) : undefined);
    const now = options.now;

    let verified: Awaited<ReturnType<typeof verifyJwt>>;
    try {
      verified = await verifyJwt(token, effectiveConfig, { fetcher, now });
    } catch (err) {
      const code = err instanceof OidcVerificationError ? err.code : "unauthorized";
      return c.json({ error: code }, 401);
    }

    // A token that names a workspace is honoured only for a member of it: the subject must have a row in the
    // multi-workspace membership table, and the role comes from that row, never from the token.
    let workspace: { id: string; role: string; suspended: boolean } | undefined;
    if (verified.workspaceId) {
      const db = contextMap?.["DB"] as D1Like | undefined;
      // The membership table belongs to multi-workspace (this brick requires `workspace-context`). If it cannot be
      // read, that is a deployment error: fail loudly with 500, never quietly as "not a member" and never by trusting
      // the token.
      if (!db || typeof db.prepare !== "function") {
        console.error("oidc-verify: workspaceClaim is configured but no DB binding is available for the membership check");
        return c.json({ error: "workspace_membership_unavailable" }, 500);
      }
      let membership: Awaited<ReturnType<typeof findWorkspaceMembership>>;
      try {
        membership = await findWorkspaceMembership(db, verified.workspaceId, verified.userId);
      } catch (err) {
        console.error("oidc-verify: workspace membership lookup failed (are the multi-workspace tables migrated?)", err);
        return c.json({ error: "workspace_membership_unavailable" }, 500);
      }
      if (!membership) return c.json({ error: "not_workspace_member" }, 403);
      workspace = { id: verified.workspaceId, role: membership.role, suspended: membership.suspended };
    }

    const user: AuthUser = {
      id: verified.userId,
      uid: verified.userId,
      ...(verified.email !== undefined ? { email: verified.email } : {}),
      workspaceId: verified.workspaceId,
      roles: verified.roles,
      claims: verified.claims,
    };
    c.set("user" as any, user);
    if (workspace) c.set("workspace" as any, workspace);

    return await next();
  };
}

export const oidcMiddleware: MiddlewareHandler = createOidcMiddleware();
