import { Hono } from "hono";
import { z } from "zod";
import { ProductAnalyticsService } from "./analytics.ts";
import { analyticsMiddleware, type AnalyticsEnv } from "./middleware.ts";

const TrackSchema = z.object({
  userId: z.string().max(128).optional(),
  anonymousId: z.string().min(1).max(128),
  eventName: z.string().min(1).max(64),
  sessionId: z.string().max(128).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.string().datetime().optional(),
});

const IdentifySchema = z.object({
  anonymousId: z.string().min(1).max(128),
  userId: z.string().min(1).max(128),
});

const CreateFunnelSchema = z.object({
  name: z.string().min(1).max(100),
  steps: z.array(z.string().min(1).max(64)).min(2),
});

export function createProductAnalyticsRoutes(): Hono<AnalyticsEnv> {
  const app = new Hono<AnalyticsEnv>();

  app.use("*", analyticsMiddleware);

  // POST /analytics/track
  app.post("/analytics/track", async (c) => {
    const user = c.get("user");
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = TrackSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("analyticsService") || new ProductAnalyticsService(c.env.DB);
    const event = await service.track({
      workspaceId,
      userId: parsed.data.userId || user?.uid,
      anonymousId: parsed.data.anonymousId,
      eventName: parsed.data.eventName,
      sessionId: parsed.data.sessionId,
      properties: parsed.data.properties,
      context: parsed.data.context,
      timestamp: parsed.data.timestamp,
    });

    return c.json({ event }, 201);
  });

  // POST /analytics/identify
  app.post("/analytics/identify", async (c) => {
    const user = c.get("user");
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = IdentifySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const targetUserId = parsed.data.userId || user?.uid;
    if (!targetUserId) {
      return c.json({ error: "userId is required" }, 400);
    }

    const service = c.get("analyticsService") || new ProductAnalyticsService(c.env.DB);
    const result = await service.identify(workspaceId, parsed.data.anonymousId, targetUserId);

    return c.json(result, 200);
  });

  // GET /analytics/counts
  app.get("/analytics/counts", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const eventsParam = c.req.query("events");
    const eventNames = eventsParam ? eventsParam.split(",").map((s) => s.trim()) : undefined;

    const service = c.get("analyticsService") || new ProductAnalyticsService(c.env.DB);
    const counts = await service.getEventCounts(workspaceId, { eventNames });

    return c.json({ counts }, 200);
  });

  // POST /analytics/funnels
  app.post("/analytics/funnels", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateFunnelSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("analyticsService") || new ProductAnalyticsService(c.env.DB);
    const funnel = await service.createFunnel(
      workspaceId,
      parsed.data.name,
      parsed.data.steps
    );

    return c.json({ funnel }, 201);
  });

  // GET /analytics/funnels/:id/report
  app.get("/analytics/funnels/:id/report", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;
    const funnelId = c.req.param("id");

    const service = c.get("analyticsService") || new ProductAnalyticsService(c.env.DB);
    const report = await service.calculateFunnel(workspaceId, funnelId);

    if (!report) {
      return c.json({ error: "Funnel not found" }, 404);
    }

    return c.json({ report }, 200);
  });

  return app;
}
