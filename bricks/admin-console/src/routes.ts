import { Hono } from "hono";
import { z } from "zod";
import { rejectForeignWorkspace } from "@poc/multi-workspace";
import { platformOperatorRefusal } from "@poc/sdk";
import { AdminConsoleService, type SuperAdminRole, type TenantStatus } from "./admin.ts";
import { adminMiddleware, requireAdminRole, type AdminEnv } from "./middleware.ts";

const AddSuperAdminSchema = z.object({
  userId: z.string().min(1).max(128),
  email: z.string().email(),
  role: z.enum(["super_admin", "support_agent", "auditor"]).optional(),
});

const SetTenantStatusSchema = z.object({
  status: z.enum(["active", "suspended", "read_only"]),
  reason: z.string().max(500).optional(),
});

const SetTenantLimitsSchema = z.object({
  limits: z.record(z.string(), z.unknown()),
});

const StartImpersonationSchema = z.object({
  impersonatedUserId: z.string().min(1).max(128),
  reason: z.string().min(5).max(500),
  durationMinutes: z.number().int().min(5).max(120).optional(),
});

const VerifyImpersonationSchema = z.object({
  sessionToken: z.string().min(1),
});

const EndImpersonationSchema = z.object({
  sessionToken: z.string().min(1),
});

export function createAdminRoutes(): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  app.use("*", adminMiddleware);

  // POST /admin/super-admins - Register new super admin. Platform operators only: a user listed in
  // PX_PLATFORM_OPERATORS (the bootstrap path) or an existing active super_admin. No workspace role is enough, and the
  // check runs before the body is read, so nobody can register themselves (audit risk 4).
  app.post("/admin/super-admins", async (c) => {
    const service = c.get("adminService") || new AdminConsoleService(c.env.DB);
    const denied = await platformOperatorRefusal(c.env, c.get("user"), c.get("ctx"), (userId) =>
      service.verifyAdminAccess(userId, "super_admin"),
    );
    if (denied) return c.json(denied.body, denied.status);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = AddSuperAdminSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const admin = await service.addSuperAdmin(
      parsed.data.userId,
      parsed.data.email,
      (parsed.data.role as SuperAdminRole) || "support_agent"
    );

    return c.json(admin, 201);
  });

  // POST /admin/tenants/:id/status - Override tenant status (suspend, read_only, active)
  app.post("/admin/tenants/:id/status", requireAdminRole("support_agent"), async (c) => {
    const user = c.get("user")!;
    const workspaceId = c.req.param("id");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = SetTenantStatusSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const service = c.get("adminService") || new AdminConsoleService(c.env.DB);
    try {
      const updated = await service.setTenantStatus(
        user.uid,
        workspaceId,
        parsed.data.status as TenantStatus,
        parsed.data.reason
      );
      return c.json(updated);
    } catch (e: any) {
      return c.json({ error: e.message || "Failed to update tenant status" }, 400);
    }
  });

  // GET /admin/tenants/:id/status - Get tenant status override
  app.get("/admin/tenants/:id/status", requireAdminRole("support_agent"), async (c) => {
    const workspaceId = c.req.param("id");
    const service = c.get("adminService") || new AdminConsoleService(c.env.DB);
    const override = await service.getTenantOverride(workspaceId);
    if (!override) {
      return c.json({ status: "active", reason: null, custom_limits: {} });
    }

    return c.json(override);
  });

  // POST /admin/tenants/:id/limits - Set custom enterprise limits
  app.post("/admin/tenants/:id/limits", requireAdminRole("super_admin"), async (c) => {
    const user = c.get("user")!;
    const workspaceId = c.req.param("id");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = SetTenantLimitsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const service = c.get("adminService") || new AdminConsoleService(c.env.DB);
    try {
      const updated = await service.setTenantCustomLimits(user.uid, workspaceId, parsed.data.limits);
      return c.json(updated);
    } catch (e: any) {
      return c.json({ error: e.message || "Failed to update tenant limits" }, 400);
    }
  });

  // POST /admin/impersonate - Start user impersonation session
  app.post("/admin/impersonate", requireAdminRole("support_agent"), async (c) => {
    const user = c.get("user")!;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // The session is for the verified workspace only; a body naming another workspace is refused.
    const foreign = rejectForeignWorkspace(c, body);
    if (foreign) return foreign;

    const parsed = StartImpersonationSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const service = c.get("adminService") || new AdminConsoleService(c.env.DB);
    try {
      const session = await service.startImpersonationSession({
        adminUserId: user.uid,
        impersonatedUserId: parsed.data.impersonatedUserId,
        workspaceId: c.get("ctx")!.workspaceId,
        reason: parsed.data.reason,
        durationMinutes: parsed.data.durationMinutes,
      });

      return c.json(session, 201);
    } catch (e: any) {
      return c.json({ error: e.message || "Failed to start impersonation" }, 400);
    }
  });

  // px-stub: quarantined: impersonate/verify and impersonate/end have no workspace-role check
  // POST /admin/impersonate/verify - Verify session token
  app.post("/admin/impersonate/verify", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = VerifyImpersonationSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const service = c.get("adminService") || new AdminConsoleService(c.env.DB);
    const result = await service.verifyImpersonationToken(parsed.data.sessionToken);
    if (!result.valid) {
      return c.json(result, 401);
    }

    return c.json(result);
  });

  // POST /admin/impersonate/end - End session immediately
  app.post("/admin/impersonate/end", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = EndImpersonationSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const service = c.get("adminService") || new AdminConsoleService(c.env.DB);
    const ended = await service.endImpersonationSession(parsed.data.sessionToken);
    if (!ended) {
      return c.json({ error: "Session token not found or already ended" }, 404);
    }

    return c.json({ success: true, ended: true });
  });

  // GET /admin/impersonations - List impersonation logs
  app.get("/admin/impersonations", requireAdminRole("auditor"), async (c) => {
    const user = c.get("user")!;
    // Lists the verified workspace's sessions only; a query naming another workspace is refused.
    const foreign = rejectForeignWorkspace(c);
    if (foreign) return foreign;
    const workspaceId = c.get("ctx")!.workspaceId;
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 50;

    const service = c.get("adminService") || new AdminConsoleService(c.env.DB);
    const logs = await service.listImpersonationSessions(user.uid, { workspaceId, limit });
    return c.json({ sessions: logs });
  });

  return app;
}
