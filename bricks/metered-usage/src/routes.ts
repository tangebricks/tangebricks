import { Hono } from "hono";
import { z } from "zod";
import { platformOperatorRefusal } from "@poc/sdk";
import { MeteringService, type MeterAggregation } from "./metering.ts";
import { meteringMiddleware, type MeterEnv } from "./middleware.ts";

const DefineMeterSchema = z.object({
  key: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  aggregation: z.enum(["sum", "count", "max", "last"]).default("sum"),
});

const IngestEventSchema = z.object({
  meterKey: z.string().min(1).max(64),
  value: z.number().default(1.0),
  idempotencyKey: z.string().max(128).optional(),
  timestamp: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export function createMeteringRoutes(): Hono<MeterEnv> {
  const app = new Hono<MeterEnv>();

  app.use("*", meteringMiddleware);

  // POST /meters - define meter. Meter definitions are a global catalog every tenant reads, so only a platform operator
  // may write them (same class as sweep B1).
  app.post("/meters", async (c) => {
    const denied = await platformOperatorRefusal(c.env, c.get("user"), c.get("ctx"));
    if (denied) return c.json(denied.body, denied.status);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = DefineMeterSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const service = c.get("metering") || new MeteringService(c.env.DB);
    const meter = await service.defineMeter(
      parsed.data.key,
      parsed.data.name,
      parsed.data.aggregation as MeterAggregation
    );

    return c.json({ meter }, 201);
  });

  // GET /meters - list meters
  app.get("/meters", async (c) => {
    const service = c.get("metering") || new MeteringService(c.env.DB);
    const meters = await service.listMeters();
    return c.json({ meters }, 200);
  });

  // POST /events - ingest event
  app.post("/events", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = IngestEventSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("metering") || new MeteringService(c.env.DB);
    const result = await service.ingestEvent({
      workspaceId,
      meterKey: parsed.data.meterKey,
      value: parsed.data.value,
      idempotencyKey: parsed.data.idempotencyKey,
      timestamp: parsed.data.timestamp,
      metadata: parsed.data.metadata,
    });

    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }

    return c.json(result, result.duplicate ? 200 : 201);
  });

  // GET /usage - query usage summary
  app.get("/usage", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;
    const windowPeriod = c.req.query("windowPeriod");

    const service = c.get("metering") || new MeteringService(c.env.DB);
    const usage = await service.getUsageSummary(workspaceId, windowPeriod || undefined);

    return c.json({ workspace_id: workspaceId, usage }, 200);
  });

  return app;
}
