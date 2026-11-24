import { Hono } from "hono";
import { z } from "zod";
import { CustomDomainService } from "./domains.ts";
import { customDomainMiddleware, type CustomDomainEnv } from "./middleware.ts";

const AddDomainSchema = z.object({
  hostname: z.string().min(3).max(253),
  verificationType: z.enum(["cname", "txt"]).optional(),
  targetCname: z.string().min(3).max(253).optional(),
  isPrimary: z.boolean().optional(),
});

export function createCustomDomainRoutes(): Hono<CustomDomainEnv> {
  const app = new Hono<CustomDomainEnv>();

  app.use("*", customDomainMiddleware);

  // POST /domains - Add custom domain
  app.post("/domains", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = AddDomainSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("domainService") || new CustomDomainService(c.env.DB);
    try {
      const result = await service.addDomain({
        workspaceId,
        hostname: parsed.data.hostname,
        verificationType: parsed.data.verificationType,
        targetCname: parsed.data.targetCname,
        isPrimary: parsed.data.isPrimary,
      });

      return c.json(result, 201);
    } catch (e: any) {
      return c.json({ error: e.message || "Failed to add domain" }, 400);
    }
  });

  // GET /domains - List domains
  app.get("/domains", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const service = c.get("domainService") || new CustomDomainService(c.env.DB);
    const domains = await service.listDomains(workspaceId);
    return c.json({ domains });
  });

  // GET /domains/resolve/:hostname - Resolve hostname for edge routing
  app.get("/domains/resolve/:hostname", async (c) => {
    const hostname = c.req.param("hostname");
    const service = c.get("domainService") || new CustomDomainService(c.env.DB);
    const resolved = await service.resolveHostname(hostname);
    if (!resolved) {
      return c.json({ error: "Hostname not recognized" }, 404);
    }

    return c.json(resolved);
  });

  // GET /domains/:id - Get domain details
  app.get("/domains/:id", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const domainId = c.req.param("id");
    const service = c.get("domainService") || new CustomDomainService(c.env.DB);
    const domain = await service.getDomain(workspaceId, domainId);
    if (!domain) {
      return c.json({ error: "Domain not found" }, 404);
    }

    return c.json(domain);
  });

  // POST /domains/:id/verify - Verify DNS and SSL
  app.post("/domains/:id/verify", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    // No body is read: the workspace is the verified one, and nothing else is needed.
    const workspaceId = ctx.workspaceId;

    const domainId = c.req.param("id");
    const service = c.get("domainService") || new CustomDomainService(c.env.DB);
    try {
      const updated = await service.verifyDomain(workspaceId, domainId);
      return c.json(updated);
    } catch (e: any) {
      return c.json({ error: e.message || "Domain not found" }, 404);
    }
  });

  // POST /domains/:id/primary - Set primary domain
  app.post("/domains/:id/primary", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    // No body is read: the workspace is the verified one, and nothing else is needed.
    const workspaceId = ctx.workspaceId;

    const domainId = c.req.param("id");
    const service = c.get("domainService") || new CustomDomainService(c.env.DB);
    const ok = await service.setPrimaryDomain(workspaceId, domainId);
    if (!ok) {
      return c.json({ error: "Domain not found" }, 404);
    }

    return c.json({ success: true, isPrimary: true });
  });

  // DELETE /domains/:id - Remove custom domain
  app.delete("/domains/:id", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const domainId = c.req.param("id");
    const service = c.get("domainService") || new CustomDomainService(c.env.DB);
    const ok = await service.deleteDomain(workspaceId, domainId);
    if (!ok) {
      return c.json({ error: "Domain not found" }, 404);
    }

    return c.json({ success: true });
  });

  return app;
}
