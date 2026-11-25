import { Hono } from "hono";
import { z } from "zod";
import { WORKSPACE_ADMIN_ROLES, WORKSPACE_OWNER_ROLES, workspaceRoleRefusal } from "@poc/sdk";
import type { RequestContext } from "@poc/sdk";

/** A caller may act on their own consents; acting on another user's needs owner or admin. */
function otherUserRefused(ctx: RequestContext, sessionUserId: string | undefined, targetUserId: string): boolean {
  return targetUserId !== sessionUserId && !WORKSPACE_ADMIN_ROLES.includes(ctx.role);
}
import { rejectForeignWorkspace } from "@poc/multi-workspace";
import { DataPrivacyService, type PrivacyServiceHooks } from "./privacy.ts";
import { privacyMiddleware, type PrivacyEnv } from "./middleware.ts";

const SetConsentsSchema = z.object({
  userId: z.string().min(1).max(128).optional(),
  consents: z.object({
    necessary: z.boolean().optional(),
    analytics: z.boolean().optional(),
    marketing: z.boolean().optional(),
    preferences: z.boolean().optional(),
  }),
});

const RequestExportSchema = z.object({
  userId: z.string().min(1).max(128).optional(),
});

const RequestErasureSchema = z.object({
  userId: z.string().min(1).max(128).optional(),
  reason: z.string().max(500).optional(),
});

export function createPrivacyRoutes(options?: PrivacyServiceHooks): Hono<PrivacyEnv> {
  const app = new Hono<PrivacyEnv>();

  app.use("*", async (c, next) => {
    c.set("privacyService", new DataPrivacyService(c.env.DB, options));
    await next();
  });

  // POST /privacy/consents - Update user cookie / privacy consents
  app.post("/privacy/consents", async (c) => {
    const user = c.get("user");
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = SetConsentsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;
    const sessionUserId = ctx.userId || user?.uid;
    const userId = parsed.data.userId || sessionUserId;

    if (!userId) {
      return c.json({ error: "userId is required" }, 400);
    }
    if (otherUserRefused(ctx, sessionUserId, userId)) {
      return c.json({ error: "Forbidden: only owner or admin may change another user's consents" }, 403);
    }

    const clientIp = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for");
    const userAgent = c.req.header("user-agent");

    const service = c.get("privacyService") || new DataPrivacyService(c.env.DB);
    const updated = await service.setConsents(workspaceId, userId, parsed.data.consents, {
      ip: clientIp,
      userAgent,
    });

    return c.json({ consents: updated });
  });

  // GET /privacy/consents - Get user privacy consents
  app.get("/privacy/consents", async (c) => {
    const user = c.get("user");
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);

    const workspaceId = ctx.workspaceId;
    const sessionUserId = ctx.userId || user?.uid;
    const userId = c.req.query("userId") || sessionUserId;

    if (!userId) {
      return c.json({ error: "userId is required" }, 400);
    }
    if (otherUserRefused(ctx, sessionUserId, userId)) {
      return c.json({ error: "Forbidden: only owner or admin may read another user's consents" }, 403);
    }

    const service = c.get("privacyService") || new DataPrivacyService(c.env.DB);
    const consents = await service.getConsents(workspaceId, userId);
    return c.json({ consents });
  });

  // POST /privacy/export - GDPR Article 20 personal data export. Owner only, checked before the body is read (audit
  // risk 3).
  app.post("/privacy/export", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_OWNER_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const user = c.get("user");
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);

    let body: unknown = {};
    try {
      body = (await c.req.json()) || {};
    } catch {
      // Body optional
    }

    const foreign = rejectForeignWorkspace(c, body);
    if (foreign) return foreign;

    const parsed = RequestExportSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;
    const userId = parsed.data.userId || c.req.query("userId") || user?.uid;

    if (!userId) {
      return c.json({ error: "userId is required" }, 400);
    }

    const service = c.get("privacyService") || new DataPrivacyService(c.env.DB);
    // Story 2.6: the verified caller, so platform-wide records (such as an approval decision) go only into a self-export.
    const exportRecord = await service.requestDataExport(workspaceId, userId, ctx.userId);
    return c.json(exportRecord, 201);
  });

  // GET /privacy/export/:id - Check status and retrieve exported data
  // Owner only, like starting an export: the record holds the exported personal data (audit risk 3).
  app.get("/privacy/export/:id", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_OWNER_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const expId = c.req.param("id");
    const service = c.get("privacyService") || new DataPrivacyService(c.env.DB);
    const record = await service.getExportRequest(workspaceId, expId);
    if (!record) {
      return c.json({ error: "Export request not found" }, 404);
    }

    return c.json(record);
  });

  // POST /privacy/erasure - GDPR Article 17 Right to Erasure. Owner only, checked before the body is read (audit risk 3).
  app.post("/privacy/erasure", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_OWNER_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const user = c.get("user");
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);

    let body: unknown = {};
    try {
      body = (await c.req.json()) || {};
    } catch {
      // Body optional
    }

    const foreign = rejectForeignWorkspace(c, body);
    if (foreign) return foreign;

    const parsed = RequestErasureSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;
    const userId = parsed.data.userId || c.req.query("userId") || user?.uid;

    if (!userId) {
      return c.json({ error: "userId is required" }, 400);
    }

    const service = c.get("privacyService") || new DataPrivacyService(c.env.DB);
    const erasureRecord = await service.requestErasure(workspaceId, userId, parsed.data.reason);
    return c.json(erasureRecord, 201);
  });

  // GET /privacy/erasure/:id - Check status of erasure request
  app.get("/privacy/erasure/:id", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const ersId = c.req.param("id");
    const service = c.get("privacyService") || new DataPrivacyService(c.env.DB, options);
    const record = await service.getErasureRequest(workspaceId, ersId);
    if (!record) {
      return c.json({ error: "Erasure request not found" }, 404);
    }

    return c.json(record);
  });

  // DELETE /privacy/workspace - Workspace erasure / tenant offboarding (owner only). Erases the verified workspace
  // (`ctx.workspaceId`) and nothing else; naming any other workspace in the query or body is refused with 403.
  // The role comes from the verified context only (never a fallback lookup), checked before the body is read.
  app.delete("/privacy/workspace", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_OWNER_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      // Body optional
    }
    const foreign = rejectForeignWorkspace(c, body);
    if (foreign) return foreign;
    const ctx = c.get("ctx")!;
    const workspaceId = ctx.workspaceId;

    const service = c.get("privacyService") || new DataPrivacyService(c.env.DB, options);
    const result = await service.eraseWorkspace(workspaceId);
    return c.json(
      {
        success: true,
        workspaceId,
        deletedCount: result.deletedCount,
        retain: result.retain,
      },
      200
    );
  });

  return app;
}
