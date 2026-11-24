import { Hono } from "hono";
import { z } from "zod";
import { TrafficArmorService, type IpAction } from "./armor.ts";
import { trafficArmorMiddleware, type ArmorEnv } from "./middleware.ts";

const AddRuleSchema = z.object({
  ipOrCidr: z.string().min(3).max(45),
  action: z.enum(["allow", "block", "challenge"]),
  reason: z.string().max(255).optional(),
});

const RemoveRuleSchema = z.object({
  ipOrCidr: z.string().min(3).max(45),
});

export function createTrafficArmorRoutes(): Hono<ArmorEnv> {
  const app = new Hono<ArmorEnv>();

  app.use("*", trafficArmorMiddleware({ enforceIpRules: false }));

  // GET /armor/rules
  app.get("/armor/rules", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const service = c.get("armorService") || new TrafficArmorService(c.env.DB);
    const rules = await service.listIpRules(workspaceId);

    return c.json({ rules }, 200);
  });

  // POST /armor/rules
  app.post("/armor/rules", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = AddRuleSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("armorService") || new TrafficArmorService(c.env.DB);
    const rule = await service.addIpRule(
      workspaceId,
      parsed.data.ipOrCidr,
      parsed.data.action as IpAction,
      parsed.data.reason
    );

    return c.json({ rule }, 201);
  });

  // DELETE /armor/rules
  app.delete("/armor/rules", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = RemoveRuleSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("armorService") || new TrafficArmorService(c.env.DB);
    const ok = await service.removeIpRule(workspaceId, parsed.data.ipOrCidr);

    if (!ok) {
      return c.json({ error: "Rule not found" }, 404);
    }

    return c.json({ ok: true }, 200);
  });

  // GET /armor/incidents
  app.get("/armor/incidents", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const service = c.get("armorService") || new TrafficArmorService(c.env.DB);
    const incidents = await service.listIncidents(workspaceId);

    return c.json({ incidents }, 200);
  });

  return app;
}
