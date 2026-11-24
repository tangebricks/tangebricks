import type { MiddlewareHandler } from "hono";
import type { D1Like } from "@poc/sdk";
import { ApiKeyService } from "./keys.ts";
import type { ApiKeyRecord } from "./keys.ts";

export interface ApiKeyEnv {
  Bindings: { DB: D1Like };
  Variables: {
    user?: { uid: string; email?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    apiKey?: ApiKeyRecord;
  };
}

/**
 * Middleware that authenticates incoming requests using public API keys (sk_live_...).
 */
export const apiKeyMiddleware: MiddlewareHandler<ApiKeyEnv> = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const rawHeader = c.req.header("X-API-Key");

  let keyStr: string | null = null;
  if (authHeader && authHeader.startsWith("Bearer sk_live_")) {
    keyStr = authHeader.replace(/^Bearer\s+/i, "");
  } else if (rawHeader && rawHeader.startsWith("sk_live_")) {
    keyStr = rawHeader;
  }

  if (!keyStr) {
    return c.json({ error: "Missing or invalid API key" }, 401);
  }

  const service = new ApiKeyService(c.env.DB);
  const key = await service.validateKey(keyStr);
  if (!key) {
    return c.json({ error: "Invalid, expired, or revoked API key" }, 401);
  }

  // Set workspace & key context for downstream handlers
  c.set("workspace", { id: key.workspace_id, role: "api_key" });
  c.set("apiKey", key);

  await next();
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
      return c.json({
        error: "Insufficient API key permissions",
        requiredScope: scope,
      }, 403);
    }

    await next();
  };
}
