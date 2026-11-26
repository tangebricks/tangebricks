import { Hono } from "hono";
import { z } from "zod";
import { AuditTrailService } from "./audit.ts";
import { auditContextMiddleware, type AuditEnv } from "./middleware.ts";
import { RESERVED_AUDIT_ACTION } from "./recorder.ts";

const RecordEventSchema = z.object({
  actorId: z.string().min(1).max(128).optional(),
  actorType: z.enum(["user", "api_key", "system", "support_impersonator"]).optional(),
  actorEmail: z.string().email().optional(),
  action: z.string().min(1).max(100),
  targetType: z.string().min(1).max(64),
  targetId: z.string().min(1).max(128),
  ipAddress: z.string().max(45).optional(),
  userAgent: z.string().max(512).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export function createAuditRoutes(): Hono<AuditEnv> {
  const app = new Hono<AuditEnv>();

  app.use("*", auditContextMiddleware);

  // POST /audit/events - record event
  app.post("/audit/events", async (c) => {
    const user = c.get("user");
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: { code: "MISSING_WORKSPACE_CONTEXT", message: "Missing workspace context" } }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_JSON", message: "Invalid JSON body" } }, 400);
    }

    const parsed = RecordEventSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: parsed.error.issues.map((i) => i.message).join(", ") } }, 400);
    }
    // Story 2.6: the action namespaces other bricks write through the auditRecorder capability are not for anyone to
    // post here, so nobody can plant a row that looks like an operator action or an outcome.
    if (RESERVED_AUDIT_ACTION.test(parsed.data.action.trim())) {
      return c.json({ error: { code: "RESERVED_ACTION", message: "platform.* and audit.* actions are reserved" } }, 400);
    }

    // The workspace is the verified one; a workspaceId in the body is stripped by the schema and never read.
    const workspaceId = ctx.workspaceId;
    const sessionUserId = ctx.userId || user?.uid;

    const ip = parsed.data.ipAddress || c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || undefined;
    const ua = parsed.data.userAgent || c.req.header("user-agent") || undefined;

    const service = c.get("auditService") || new AuditTrailService(c.env.DB);
    const event = await service.record({
      workspaceId,
      // The actor is the signed-in caller only (audit risk 21): body actorId/actorType/actorEmail are ignored, so a
      // caller cannot record an event in someone else's name.
      actorId: sessionUserId || "system",
      actorType: sessionUserId ? "user" : "system",
      actorEmail: user?.email ?? undefined,
      action: parsed.data.action,
      targetType: parsed.data.targetType,
      targetId: parsed.data.targetId,
      ipAddress: ip,
      userAgent: ua,
      metadata: parsed.data.metadata,
    });

    return c.json({ event }, 201);
  });

  // GET /audit/events - query events
  app.get("/audit/events", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: { code: "MISSING_WORKSPACE_CONTEXT", message: "Missing workspace context" } }, 400);
    const workspaceId = ctx.workspaceId;

    const action = c.req.query("action");
    const actorId = c.req.query("actorId");
    const targetType = c.req.query("targetType");
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : 50;
    const offset = c.req.query("offset") ? parseInt(c.req.query("offset")!, 10) : 0;

    const service = c.get("auditService") || new AuditTrailService(c.env.DB);
    const events = await service.list(workspaceId, {
      action: action || undefined,
      actorId: actorId || undefined,
      targetType: targetType || undefined,
      limit,
      offset,
    });

    return c.json({ events }, 200);
  });

  // GET /audit/export - export CSV
  app.get("/audit/export", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: { code: "MISSING_WORKSPACE_CONTEXT", message: "Missing workspace context" } }, 400);
    const workspaceId = ctx.workspaceId;

    const service = c.get("auditService") || new AuditTrailService(c.env.DB);
    const csv = await service.exportCsv(workspaceId);

    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="audit-${workspaceId}-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  });

  return app;
}
