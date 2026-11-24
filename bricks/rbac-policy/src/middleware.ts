import type { MiddlewareHandler } from "hono";
import type { D1Like } from "@poc/sdk";
import { RbacService } from "./rbac.ts";

export interface RbacContext {
  can: (resource: string, action: string) => Promise<boolean>;
}

export interface RbacEnv {
  Bindings: { DB: D1Like };
  Variables: {
    user?: { uid: string; email?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    rbac?: RbacContext;
  };
}

/**
 * Attaches the RBAC context to the Hono request, providing `c.get("rbac").can(...)`.
 */
export const rbacMiddleware: MiddlewareHandler<RbacEnv> = async (c, next) => {
  const user = c.get("user");
  const workspace = c.get("workspace");

  if (user && workspace) {
    const rbac = new RbacService(c.env.DB);
    c.set("rbac", {
      can: (resource: string, action: string) => rbac.can(workspace.id, user.uid, resource, action),
    });
  }

  await next();
};

/**
 * Guards a route: requires that the authenticated caller has the specified permission in the active workspace.
 */
export function requirePermission(resource: string, action: string): MiddlewareHandler<RbacEnv> {
  return async (c, next) => {
    const user = c.get("user");
    const workspace = c.get("workspace");

    if (!user) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (!workspace) {
      return c.json({ error: "Missing workspace context" }, 400);
    }

    // Owner role shortcut: workspace owner always has all permissions
    if (workspace.role === "owner") {
      return next();
    }

    const rbac = new RbacService(c.env.DB);
    const allowed = await rbac.can(workspace.id, user.uid, resource, action);
    if (!allowed) {
      return c.json({
        error: "Permission denied",
        required: `${resource}:${action}`,
      }, 403);
    }

    await next();
  };
}
