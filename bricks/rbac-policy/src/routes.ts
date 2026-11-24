import { Hono } from "hono";
import { z } from "zod";
import type { D1Like } from "@poc/sdk";
import { RbacService } from "./rbac.ts";
import { requirePermission, rbacMiddleware } from "./middleware.ts";
import type { RbacEnv } from "./middleware.ts";

export interface RbacRouteOptions {
  customRoles?: boolean;
}

const CreateRoleSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(255).optional(),
  permissions: z.array(
    z.object({
      resource: z.string().min(1).max(64),
      action: z.string().min(1).max(64),
    })
  ).default([]),
});

const AssignRoleSchema = z.object({
  userId: z.string().min(1).max(200),
  roleId: z.string().min(1).max(200),
});

export function createRbacRoutes(options: RbacRouteOptions = {}): Hono<RbacEnv> {
  const app = new Hono<RbacEnv>();

  // Attach policy engine to context
  app.use("*", rbacMiddleware);

  // List all roles in the current workspace
  app.get("/roles", requirePermission("roles", "read"), async (c) => {
    const workspace = c.get("workspace")!;
    const rbac = new RbacService(c.env.DB);
    const roles = await rbac.getRoles(workspace.id);
    return c.json({ roles }, 200);
  });

  // Create a new custom role (guarded by roles:write)
  app.post("/roles", requirePermission("roles", "write"), async (c) => {
    if (options.customRoles === false) {
      return c.json({ error: "Custom roles are disabled for this workspace" }, 403);
    }

    const workspace = c.get("workspace")!;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateRoleSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const rbac = new RbacService(c.env.DB);
    const result = await rbac.createRole(
      workspace.id,
      parsed.data.name,
      parsed.data.permissions,
      parsed.data.description
    );

    if (!result.ok) {
      return c.json({ error: result.error }, result.code as 400 | 500);
    }

    return c.json({ role: result.role }, 201);
  });

  // Assign a role to a user
  app.post("/roles/assign", requirePermission("roles", "assign"), async (c) => {
    const workspace = c.get("workspace")!;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = AssignRoleSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid userId or roleId" }, 400);
    }

    const rbac = new RbacService(c.env.DB);
    const assigned = await rbac.assignRole(workspace.id, parsed.data.userId, parsed.data.roleId);
    if (!assigned) {
      return c.json({ error: "Role not found in this workspace" }, 404);
    }

    return c.json({ success: true }, 200);
  });

  // Revoke a role from a user
  app.post("/roles/revoke", requirePermission("roles", "assign"), async (c) => {
    const workspace = c.get("workspace")!;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = AssignRoleSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid userId or roleId" }, 400);
    }

    const rbac = new RbacService(c.env.DB);
    const revoked = await rbac.revokeRole(workspace.id, parsed.data.userId, parsed.data.roleId);
    return c.json({ success: revoked }, 200);
  });

  // Check current user's capability
  app.get("/policies/check", async (c) => {
    const user = c.get("user");
    const workspace = c.get("workspace");
    if (!user || !workspace) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const resource = c.req.query("resource");
    const action = c.req.query("action");
    if (!resource || !action) {
      return c.json({ error: "Missing resource or action query parameter" }, 400);
    }

    if (workspace.role === "owner") {
      return c.json({ allowed: true, reason: "workspace_owner" }, 200);
    }

    const rbac = new RbacService(c.env.DB);
    const allowed = await rbac.can(workspace.id, user.uid, resource, action);
    return c.json({ allowed }, 200);
  });

  return app;
}
