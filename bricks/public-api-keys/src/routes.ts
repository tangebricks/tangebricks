import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { RequestContext } from "@poc/sdk";
import { refuseApiKeyCaller } from "@poc/sdk";
import { ApiKeyService, KEY_MANAGER_ROLES, MAX_KEY_EXPIRES_DAYS, isAllowedScopeSet } from "./keys.ts";
import type { ApiKeyEnv } from "./middleware.ts";

export interface ApiKeyRouteOptions {
  rateLimit?: number;
}

const CreateKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).refine(isAllowedScopeSet, 'Scopes must be ["*"] or ["read"]').default(["*"]),
  expiresDays: z.number().int().positive().max(MAX_KEY_EXPIRES_DAYS).optional(),
  role: z.enum(["member", "admin"]).default("member"),
});

/**
 * Key management is for people only: an API key can never list, create or revoke keys (403 `API_KEY_FORBIDDEN`), and
 * the caller must be an owner or admin of the workspace, read from the verified `ctx`. Returns the refusal, or the ctx.
 */
function keyManager(c: Context<ApiKeyEnv>): { ctx: RequestContext } | { failure: Response } {
  const refused = refuseApiKeyCaller(c);
  if (refused) return { failure: refused };
  const ctx = c.get("ctx");
  if (!ctx) return { failure: c.json({ error: "Missing workspace context" }, 400) };
  if (!KEY_MANAGER_ROLES.includes(ctx.role)) {
    return { failure: c.json({ error: "Only a workspace owner or admin can manage API keys", code: "FORBIDDEN" }, 403) };
  }
  return { ctx };
}

export function createApiKeyRoutes(_options: ApiKeyRouteOptions = {}): Hono<ApiKeyEnv> {
  const app = new Hono<ApiKeyEnv>();

  // List keys in workspace (masked)
  app.get("/api-keys", async (c) => {
    const manager = keyManager(c);
    if ("failure" in manager) return manager.failure;

    const service = new ApiKeyService(c.env.DB);
    const keys = await service.listKeys(manager.ctx.workspaceId);
    return c.json({ keys }, 200);
  });

  // Create key. The raw key is in this response only.
  app.post("/api-keys", async (c) => {
    const manager = keyManager(c);
    if ("failure" in manager) return manager.failure;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateKeySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const service = new ApiKeyService(c.env.DB);
    const result = await service.createKey(manager.ctx.workspaceId, {
      name: parsed.data.name,
      scopes: parsed.data.scopes,
      ...(parsed.data.expiresDays !== undefined ? { expiresDays: parsed.data.expiresDays } : {}),
      role: parsed.data.role,
      creator: { userId: manager.ctx.userId, role: manager.ctx.role },
    });

    if (!result.ok) {
      return c.json({ error: result.error }, result.code as 400 | 403 | 500);
    }

    return c.json({
      rawKey: result.rawKey,
      key: result.key,
      warning: "This secret key will not be shown again. Please store it safely.",
    }, 201);
  });

  // Revoke key
  app.delete("/api-keys/:id", async (c) => {
    const manager = keyManager(c);
    if ("failure" in manager) return manager.failure;

    const service = new ApiKeyService(c.env.DB);
    const revoked = await service.revokeKey(manager.ctx.workspaceId, c.req.param("id"));

    if (!revoked) return c.json({ error: "API key not found" }, 404);
    return c.json({ success: true }, 200);
  });

  return app;
}
