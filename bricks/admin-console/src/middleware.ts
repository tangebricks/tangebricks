import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { AdminConsoleService, type SuperAdminRole } from "./admin.ts";

export interface AdminEnv {
  Bindings: { DB: D1Like; PX_PLATFORM_OPERATORS?: string };
  Variables: {
    user?: { uid: string; email?: string; name?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. */
    ctx?: RequestContext;
    adminService?: AdminConsoleService;
  };
}

export const adminMiddleware: MiddlewareHandler<AdminEnv> = async (c, next) => {
  const service = new AdminConsoleService(c.env.DB);
  c.set("adminService", service);
  await next();
};

export function requireAdminRole(minRole: SuperAdminRole = "support_agent"): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user || !user.uid) {
      return c.json({ error: "Unauthorized: Authentication required" }, 401);
    }

    const service = c.get("adminService") || new AdminConsoleService(c.env.DB);
    const hasAccess = await service.verifyAdminAccess(user.uid, minRole);
    if (!hasAccess) {
      return c.json({ error: "Forbidden: Super-admin privilege required" }, 403);
    }

    await next();
  };
}
