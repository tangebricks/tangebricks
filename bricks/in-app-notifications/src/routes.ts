import { Hono } from "hono";
import { z } from "zod";
import { WORKSPACE_ADMIN_ROLES, scoped, workspaceRoleRefusal } from "@poc/sdk";
import { NotificationService, type NotificationType } from "./notifications.ts";
import { notificationMiddleware, type NotificationEnv } from "./middleware.ts";

const CreateNotificationSchema = z.object({
  userId: z.string().min(1).max(128).optional(),
  title: z.string().min(1).max(255),
  body: z.string().min(1).max(1024),
  type: z.enum(["info", "success", "warning", "error", "action_required"]).optional(),
  actionUrl: z.string().max(512).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export function createNotificationRoutes(): Hono<NotificationEnv> {
  const app = new Hono<NotificationEnv>();

  app.use("*", notificationMiddleware);

  // GET /notifications - list notifications for authenticated caller
  app.get("/notifications", async (c) => {
    const user = c.get("user");
    if (!user?.uid) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);

    const unreadOnly = c.req.query("unreadOnly") === "true";
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : 20;
    const offset = c.req.query("offset") ? parseInt(c.req.query("offset")!, 10) : 0;

    const service = c.get("notificationService") || new NotificationService(c.env.DB);
    const notifications = await service.list(user.uid, {
      workspaceId: ctx.workspaceId,
      unreadOnly,
      limit,
      offset,
    });

    return c.json({ notifications }, 200);
  });

  // GET /notifications/unread-count - badge counter
  app.get("/notifications/unread-count", async (c) => {
    const user = c.get("user");
    if (!user?.uid) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);

    const service = c.get("notificationService") || new NotificationService(c.env.DB);
    const count = await service.getUnreadCount(user.uid, ctx.workspaceId);

    return c.json({ unread_count: count }, 200);
  });

  // POST /notifications - dispatch notification. Owner/admin only, checked before the body is read, and the target user
  // must be a member of the caller's workspace (audit risk 21).
  app.post("/notifications", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const callerUser = c.get("user");
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateNotificationSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const targetUserId = parsed.data.userId || ctx.userId || callerUser?.uid;
    if (!targetUserId) {
      return c.json({ error: "userId must be provided in body or auth context" }, 400);
    }

    // Membership lives in the workspace-context brick's table. If it cannot be read the target is not proven to be a
    // member, so the call is refused (fail closed).
    let isMember = false;
    try {
      const member = await scoped(c.env.DB, ctx.workspaceId).first<{ user_id: string }>("mw_members", "user_id = ?", [targetUserId]);
      isMember = Boolean(member);
    } catch {
      isMember = false;
    }
    if (!isMember) {
      return c.json({ error: "Target user is not a member of this workspace" }, 404);
    }

    const service = c.get("notificationService") || new NotificationService(c.env.DB);
    const notification = await service.create({
      userId: targetUserId,
      workspaceId: ctx.workspaceId,
      title: parsed.data.title,
      body: parsed.data.body,
      type: parsed.data.type as NotificationType | undefined,
      actionUrl: parsed.data.actionUrl,
      metadata: parsed.data.metadata,
    });

    return c.json({ notification }, 201);
  });

  // PATCH /notifications/:id/read - mark single as read
  app.patch("/notifications/:id/read", async (c) => {
    const user = c.get("user");
    if (!user?.uid) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const notifId = c.req.param("id");
    const service = c.get("notificationService") || new NotificationService(c.env.DB);
    const changed = await service.markAsRead(notifId, user.uid);
    // Not changed: either already read, or not the caller's notification. The latter is a 404, never a fake success.
    if (!changed && !(await service.existsForUser(notifId, user.uid))) {
      return c.json({ error: "Notification not found" }, 404);
    }

    return c.json({ ok: true, changed }, 200);
  });

  // POST /notifications/mark-all-read - mark all as read
  app.post("/notifications/mark-all-read", async (c) => {
    const user = c.get("user");
    if (!user?.uid) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);

    const service = c.get("notificationService") || new NotificationService(c.env.DB);
    const updatedCount = await service.markAllAsRead(user.uid, ctx.workspaceId);

    return c.json({ ok: true, count: updatedCount }, 200);
  });

  // DELETE /notifications/:id - delete notification
  app.delete("/notifications/:id", async (c) => {
    const user = c.get("user");
    if (!user?.uid) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const notifId = c.req.param("id");
    const service = c.get("notificationService") || new NotificationService(c.env.DB);
    const deleted = await service.delete(notifId, user.uid);
    if (!deleted) return c.json({ error: "Notification not found" }, 404);

    return c.json({ ok: true, deleted }, 200);
  });

  return app;
}
