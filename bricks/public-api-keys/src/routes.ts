import { Hono } from "hono";
import { z } from "zod";
import type { D1Like } from "@poc/sdk";
import { ApiKeyService } from "./keys.ts";
import type { ApiKeyEnv } from "./middleware.ts";

export interface ApiKeyRouteOptions {
  rateLimit?: number;
}

const CreateKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string().min(1).max(64)).default(["*"]),
  expiresDays: z.number().int().positive().optional(),
});

export function createApiKeyRoutes(options: ApiKeyRouteOptions = {}): Hono<ApiKeyEnv> {
  const app = new Hono<ApiKeyEnv>();

  // List keys in workspace (masked)
  app.get("/api-keys", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const service = new ApiKeyService(c.env.DB);
    const keys = await service.listKeys(workspace.id);
    return c.json({ keys }, 200);
  });

  // Create key
  app.post("/api-keys", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

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
    const result = await service.createKey(
      workspace.id,
      parsed.data.name,
      parsed.data.scopes,
      parsed.data.expiresDays
    );

    if (!result.ok) {
      return c.json({ error: result.error }, result.code as 400 | 500);
    }

    return c.json({
      rawKey: result.rawKey,
      key: result.key,
      warning: "This secret key will not be shown again. Please store it safely.",
    }, 201);
  });

  // Revoke key
  app.delete("/api-keys/:id", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const service = new ApiKeyService(c.env.DB);
    const revoked = await service.revokeKey(workspace.id, c.req.param("id"));

    if (!revoked) return c.json({ error: "API key not found" }, 404);
    return c.json({ success: true }, 200);
  });

  return app;
}
