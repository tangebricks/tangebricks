import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { AuditTrailService } from "./audit.ts";

export interface AuditEnv {
  Bindings: { DB: D1Like };
  Variables: {
    user?: { uid: string; email?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    auditService?: AuditTrailService;
    auditLog?: (
      action: string,
      targetType: string,
      targetId: string,
      metadata?: Record<string, unknown>
    ) => Promise<void>;
  };
}

export const auditContextMiddleware: MiddlewareHandler<AuditEnv> = async (c, next) => {
  const service = new AuditTrailService(c.env.DB);
  c.set("auditService", service);

  const user = c.get("user");
  const workspace = c.get("workspace");
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || null;
  const userAgent = c.req.header("user-agent") || null;

  c.set("auditLog", async (action, targetType, targetId, metadata) => {
    if (!workspace?.id) return;
    await service.record({
      workspaceId: workspace.id,
      actorId: user?.uid || "system",
      actorType: user?.uid ? "user" : "system",
      actorEmail: user?.email,
      action,
      targetType,
      targetId,
      ipAddress: ip || undefined,
      userAgent: userAgent || undefined,
      metadata,
    });
  });

  await next();
};
