import type { Context, MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { API_KEY_AUTHENTICATION, API_KEY_USER_PREFIX, isApiKeyRequest, rateLimit } from "@poc/sdk";
import { ApiKeyService, scopesAllowMethod } from "./keys.ts";
import type { ApiKeyRecord } from "./keys.ts";

export interface ApiKeyEnv {
  Bindings: { DB: D1Like };
  Variables: {
    user?: { uid: string; email?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    ctx?: RequestContext;
    apiKey?: ApiKeyRecord;
    /** Set to "api-key" by this brick's identity step only (story 1.11). */
    authenticatedBy?: string;
    /** Story 2.6: the user id of the key's creator (`API_KEY_CREATOR_VAR`), for checks about the person behind a key. */
    apiKeyCreator?: string;
  };
}

const INVALID_API_KEY = { error: "Invalid, expired, or revoked API key", code: "INVALID_API_KEY" } as const;

/** The limiter every request carrying a key header passes first, per client IP (bad keys never reach D1 unthrottled). */
export const API_KEY_AUTH_RATE_LIMIT = { bucket: "api-key-auth-ip", limit: 600, windowSeconds: 60, key: "ip" } as const;
const keyAuthLimiter = rateLimit({ ...API_KEY_AUTH_RATE_LIMIT });

type KeyHeader = { kind: "none" } | { kind: "key"; value: string } | { kind: "invalid" };

/**
 * The key a request presents: `Authorization: Bearer sk_live_…` or `X-API-Key: …`. Any `X-API-Key` header is a key
 * attempt. An `Authorization` header that is not a `Bearer sk_live_…` belongs to the session identity and is ignored.
 * Two different keys in one request are refused.
 */
function presentedKey(c: Context<ApiKeyEnv>): KeyHeader {
  const auth = c.req.header("Authorization");
  const fromAuth = auth && /^Bearer\s+sk_live_/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : undefined;
  const fromHeader = c.req.header("X-API-Key");
  if (fromHeader !== undefined) {
    const value = fromHeader.trim();
    if (fromAuth !== undefined && fromAuth !== value) return { kind: "invalid" };
    return value ? { kind: "key", value } : { kind: "invalid" };
  }
  return fromAuth !== undefined ? { kind: "key", value: fromAuth } : { kind: "none" };
}

/**
 * Rate-limits, then authenticates the presented key and sets the caller: the `authenticatedBy` marker, `user`
 * (`apikey:<keyId>`), the verified, frozen `ctx` for the key's workspace and role, `workspace`, and `apiKey` for
 * `requireScope`. Records the use without delaying the request. Returns the response to send instead of going on:
 * 429 when rate-limited, 401 `INVALID_API_KEY` for a bad key, 503 `API_KEY_AUTH_UNAVAILABLE` when the lookup fails, and
 * 403 `API_KEY_SCOPE` when a `read` key makes a request that is not GET, HEAD or OPTIONS.
 */
async function authenticateKey(c: Context<ApiKeyEnv>, presented: KeyHeader & { kind: "key" | "invalid" }): Promise<Response | undefined> {
  let passed = false;
  const limited = await keyAuthLimiter(c as never, async () => {
    passed = true;
  });
  if (!passed) return limited ?? c.json({ error: "Too many requests", code: "RATE_LIMITED" }, 429);
  if (presented.kind === "invalid") return c.json(INVALID_API_KEY, 401);

  const service = new ApiKeyService(c.env.DB);
  let found: Awaited<ReturnType<ApiKeyService["authenticate"]>>;
  try {
    found = await service.authenticate(presented.value);
  } catch (error) {
    console.error("api key authentication unavailable:", error);
    return c.json({ error: "API key authentication unavailable", code: "API_KEY_AUTH_UNAVAILABLE" }, 503);
  }
  if (!found) return c.json(INVALID_API_KEY, 401);
  const { key, workspaceSuspended } = found;

  const userId = `${API_KEY_USER_PREFIX}${key.id}`;
  c.set("authenticatedBy", API_KEY_AUTHENTICATION);
  c.set("user", { uid: userId });
  c.set("ctx", Object.freeze<RequestContext>({ userId, workspaceId: key.workspace_id, role: key.role }));
  c.set("workspace", { id: key.workspace_id, role: key.role, suspended: workspaceSuspended });
  c.set("apiKey", key);
  // authenticate() only answers a key whose creator is still a member, so created_by is set here.
  if (key.created_by) c.set("apiKeyCreator", key.created_by);

  const touched = service.touch(key.workspace_id, key.id).catch((error: unknown) => {
    console.error("api key last_used_at:", error);
    return false;
  });
  try {
    c.executionCtx.waitUntil(touched);
  } catch {
    // No execution context (plain fetch): the update still runs, unawaited.
  }

  if (!scopesAllowMethod(key.scopes, c.req.method)) {
    return c.json({ error: "This API key may only read", code: "API_KEY_SCOPE" }, 403);
  }
  return undefined;
}

/**
 * The API-key identity step for an assembled app, mounted before the session identity on the workspace-guarded paths.
 * A request with no key passes through unchanged to the session identity. A request with a key is either authenticated
 * by it or refused; a bad key never falls through to the session. Runs once per request even when mounted on
 * overlapping paths.
 */
export const apiKeyIdentity: MiddlewareHandler<ApiKeyEnv> = async (c, next) => {
  if (isApiKeyRequest(c)) return await next();
  const presented = presentedKey(c);
  if (presented.kind === "none") return await next();
  const refused = await authenticateKey(c, presented);
  if (refused) return refused;
  return await next();
};

/**
 * Requires an API key on a route (for a standalone app without the identity step): 401 without one, otherwise the
 * same authentication as `apiKeyIdentity`.
 */
export const apiKeyMiddleware: MiddlewareHandler<ApiKeyEnv> = async (c, next) => {
  if (isApiKeyRequest(c)) return await next();
  const presented = presentedKey(c);
  if (presented.kind === "none") return c.json({ error: "Missing or invalid API key", code: "INVALID_API_KEY" }, 401);
  const refused = await authenticateKey(c, presented);
  if (refused) return refused;
  return await next();
};

/**
 * Guards a route: requires that the authenticated API key possesses the requested scope or "*".
 */
export function requireScope(scope: string): MiddlewareHandler<ApiKeyEnv> {
  return async (c, next) => {
    const key = c.get("apiKey");
    if (!key) return c.json({ error: "Unauthorized" }, 401);

    const hasScope = key.scopes.includes("*") || key.scopes.includes(scope);
    if (!hasScope) {
      return c.json(
        {
          error: "Insufficient API key permissions",
          requiredScope: scope,
        },
        403,
      );
    }

    await next();
  };
}
