import { Hono } from "hono";
import { z } from "zod";
import { RealtimePresenceService, type PresenceStatus } from "./presence.ts";
import { presenceMiddleware, type PresenceEnv } from "./middleware.ts";

const HeartbeatSchema = z.object({
  roomName: z.string().min(1).max(100),
  userId: z.string().min(1).max(128).optional(),
  userName: z.string().min(1).max(100).optional(),
  status: z.enum(["online", "idle", "away", "offline"]).optional(),
  cursor: z.object({
    x: z.number(),
    y: z.number(),
    page: z.number().optional(),
    target: z.string().optional(),
  }).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export function createPresenceRoutes(): Hono<PresenceEnv> {
  const app = new Hono<PresenceEnv>();

  app.use("*", presenceMiddleware);

  // POST /presence/heartbeat
  app.post("/presence/heartbeat", async (c) => {
    const user = c.get("user");
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = HeartbeatSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const userId = parsed.data.userId || user?.uid;
    const userName = parsed.data.userName || user?.name || "Anonymous";

    if (!userId) {
      return c.json({ error: "userId must be provided in body or auth context" }, 400);
    }

    const service = c.get("presenceService") || new RealtimePresenceService(c.env.DB);
    const participant = await service.heartbeat(
      workspaceId,
      parsed.data.roomName,
      { userId, userName },
      {
        cursor: parsed.data.cursor,
        status: parsed.data.status as PresenceStatus | undefined,
        metadata: parsed.data.metadata,
      }
    );

    return c.json({ participant }, 200);
  });

  // GET /presence/rooms/:name
  app.get("/presence/rooms/:name", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;
    const roomName = c.req.param("name");
    const ttl = c.req.query("ttl") ? parseInt(c.req.query("ttl")!, 10) : undefined;

    const service = c.get("presenceService") || new RealtimePresenceService(c.env.DB);
    const presence = await service.getRoomPresence(workspaceId, roomName, ttl);

    return c.json({ presence }, 200);
  });

  // POST /presence/rooms/:name/leave
  app.post("/presence/rooms/:name/leave", async (c) => {
    const user = c.get("user");
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const roomName = c.req.param("name");

    let body: { userId?: string } = {};
    try {
      body = (await c.req.json()) as { userId?: string };
    } catch {
      body = {};
    }

    const workspaceId = ctx.workspaceId;
    const userId = body.userId || user?.uid;

    if (!userId) {
      return c.json({ error: "userId is required" }, 400);
    }

    const service = c.get("presenceService") || new RealtimePresenceService(c.env.DB);
    const ok = await service.leaveRoom(workspaceId, roomName, userId);

    return c.json({ ok }, 200);
  });

  // GET /presence/users/:userId
  app.get("/presence/users/:userId", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;
    const userId = c.req.param("userId");

    const service = c.get("presenceService") || new RealtimePresenceService(c.env.DB);
    const status = await service.getUserStatus(workspaceId, userId);

    return c.json(status, 200);
  });

  return app;
}
