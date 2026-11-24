import { Hono } from "hono";
import { z } from "zod";
import { WORKSPACE_ADMIN_ROLES, platformOperatorRefusal, workspaceRoleRefusal } from "@poc/sdk";
import { FeatureFlagService } from "./flags.ts";
import { featureFlagMiddleware } from "./middleware.ts";
import type { FlagEnv } from "./middleware.ts";

export interface FlagRouteOptions {
  allowOverrides?: boolean;
}

const DefineFlagSchema = z.object({
  key: z.string().min(1).max(64),
  description: z.string().max(255).optional(),
  enabledDefault: z.boolean().default(false),
  percentageRollout: z.number().int().min(0).max(100).default(100),
});

const OverrideSchema = z.object({
  enabled: z.boolean(),
});

export function createFlagRoutes(options: FlagRouteOptions = {}): Hono<FlagEnv> {
  const app = new Hono<FlagEnv>();

  app.use("*", featureFlagMiddleware);

  // List all flags with current workspace evaluation
  app.get("/flags", async (c) => {
    const user = c.get("user");
    const workspace = c.get("workspace");
    const service = new FeatureFlagService(c.env.DB, options.allowOverrides);

    const flags = await service.listFlags();
    const evaluated = await Promise.all(
      flags.map(async (f) => ({
        ...f,
        enabled_for_caller: await service.isEnabled(f.key, {
          workspaceId: workspace?.id,
          userId: user?.uid,
        }),
      }))
    );

    return c.json({ flags: evaluated }, 200);
  });

  // Define or update flag. Flag definitions are global (every tenant reads them), so only a platform operator may write
  // them; no workspace role is enough (sweep B1).
  app.post("/flags", async (c) => {
    const denied = await platformOperatorRefusal(c.env, c.get("user"), c.get("ctx"));
    if (denied) return c.json(denied.body, denied.status);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = DefineFlagSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const service = new FeatureFlagService(c.env.DB, options.allowOverrides);
    const flag = await service.defineFlag(
      parsed.data.key,
      parsed.data.description,
      parsed.data.enabledDefault,
      parsed.data.percentageRollout
    );

    return c.json({ flag }, 201);
  });

  // Evaluate single flag
  app.get("/flags/:key/evaluate", async (c) => {
    const user = c.get("user");
    const workspace = c.get("workspace");
    const service = new FeatureFlagService(c.env.DB, options.allowOverrides);

    const flagKey = c.req.param("key");
    const enabled = await service.isEnabled(flagKey, {
      workspaceId: workspace?.id,
      userId: user?.uid,
    });

    return c.json({ key: flagKey, enabled }, 200);
  });

  // Set workspace override
  app.post("/flags/:key/override", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = OverrideSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid enabled boolean" }, 400);
    }

    const service = new FeatureFlagService(c.env.DB, options.allowOverrides);
    // An override can only point at a defined flag (the table has a foreign key), so an unknown key is a 404, not a 500.
    if (!(await service.getFlag(c.req.param("key").toLowerCase().trim()))) {
      return c.json({ error: "Flag not found" }, 404);
    }
    const success = await service.setOverride(workspace.id, c.req.param("key"), parsed.data.enabled);

    return c.json({ success }, 200);
  });

  // Clear workspace override
  app.delete("/flags/:key/override", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const service = new FeatureFlagService(c.env.DB, options.allowOverrides);
    const success = await service.clearOverride(workspace.id, c.req.param("key"));

    return c.json({ success }, 200);
  });

  return app;
}
