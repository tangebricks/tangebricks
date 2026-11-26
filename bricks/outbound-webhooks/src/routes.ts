import { Hono } from "hono";
import { z } from "zod";
import { OutboundWebhookService } from "./outbound.ts";
import { outboundWebhookMiddleware, type OutboundWebhookEnv } from "./middleware.ts";

const CreateEndpointSchema = z.object({
  targetUrl: z.string().url().min(8).max(512),
  description: z.string().max(255).optional(),
  events: z.array(z.string().min(1).max(64)).optional(),
});

const DispatchEventSchema = z.object({
  eventType: z.string().min(1).max(64),
  payload: z.record(z.string(), z.unknown()),
});

export function createOutboundWebhookRoutes(): Hono<OutboundWebhookEnv> {
  const app = new Hono<OutboundWebhookEnv>();

  app.use("*", outboundWebhookMiddleware);

  // POST /subscriptions/webhooks - register endpoint
  app.post("/subscriptions/webhooks", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateEndpointSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("outboundWebhooks") || new OutboundWebhookService(c.env.DB);
    const endpoint = await service.createEndpoint({
      workspaceId,
      targetUrl: parsed.data.targetUrl,
      description: parsed.data.description,
      events: parsed.data.events,
    });

    return c.json({ endpoint }, 201);
  });

  // GET /subscriptions/webhooks - list endpoints
  app.get("/subscriptions/webhooks", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const service = c.get("outboundWebhooks") || new OutboundWebhookService(c.env.DB);
    const endpoints = await service.listEndpoints(workspaceId);

    return c.json({ endpoints }, 200);
  });

  // DELETE /subscriptions/webhooks/:id
  app.delete("/subscriptions/webhooks/:id", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;
    const endpointId = c.req.param("id");

    const service = c.get("outboundWebhooks") || new OutboundWebhookService(c.env.DB);
    const ok = await service.deleteEndpoint(endpointId, workspaceId);

    if (!ok) {
      return c.json({ error: "Endpoint not found" }, 404);
    }

    return c.json({ ok: true }, 200);
  });

  // POST /subscriptions/webhooks/dispatch - trigger event dispatch
  app.post("/subscriptions/webhooks/dispatch", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = DispatchEventSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("outboundWebhooks") || new OutboundWebhookService(c.env.DB);
    const deliveries = await service.dispatchEvent(
      workspaceId,
      parsed.data.eventType,
      parsed.data.payload
    );

    return c.json({ deliveries }, 200);
  });

  // GET /subscriptions/webhooks/deliveries - list deliveries
  app.get("/subscriptions/webhooks/deliveries", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;
    const endpointId = c.req.query("endpointId");

    const service = c.get("outboundWebhooks") || new OutboundWebhookService(c.env.DB);
    const deliveries = await service.listDeliveries(workspaceId, endpointId || undefined);

    return c.json({ deliveries }, 200);
  });

  // POST /subscriptions/webhooks/deliveries/:id/replay
  app.post("/subscriptions/webhooks/deliveries/:id/replay", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;
    const deliveryId = c.req.param("id");

    const service = c.get("outboundWebhooks") || new OutboundWebhookService(c.env.DB);
    const delivery = await service.replayDelivery(deliveryId, workspaceId);

    if (!delivery) {
      return c.json({ error: "Delivery or parent endpoint not found" }, 404);
    }

    return c.json({ delivery }, 200);
  });

  return app;
}
