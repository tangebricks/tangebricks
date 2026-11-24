import { Hono } from "hono";
import { z } from "zod";
import { findWorkspaceMembership } from "@poc/sdk";
import { RbacService } from "./rbac.ts";
import type { Permission } from "./rbac.ts";
import { requirePermission, rbacMiddleware } from "./middleware.ts";
import type { RbacEnv } from "./middleware.ts";

export interface RbacRouteOptions {
  customRoles?: boolean;
  /**
   * The permissions this app knows about, as "resource:action" strings. When set, `POST /roles` refuses any permission
   * not on the list (400 UNKNOWN_PERMISSION); a wildcard such as `docs:*` is accepted only if it is literally listed.
   * When unset (the default), permission strings are only checked for format: `resource` and `action` must each be
   * `*` or match `[a-z][a-z0-9_.-]{0,63}` after lower-casing and trimming.
   */
  knownPermissions?: string[];
}

/** One side of a permission: a literal `*`, or a lower-case name. Checked after lower-casing and trimming. */
const PERMISSION_PART = /^(\*|[a-z][a-z0-9_.-]{0,63})$/;

const CreateRoleSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(255).optional(),
  // The format of each part is checked after normalising (validatePermissions), so a bad one gets INVALID_PERMISSION.
  permissions: z.array(
    z.object({
      resource: z.string().max(256),
      action: z.string().max(256),
    })
  ).max(200).default([]),
});

const AssignRoleSchema = z.object({
  userId: z.string().min(1).max(200),
  roleId: z.string().min(1).max(200),
});

type PermissionCheck =
  | { ok: true; permissions: Permission[] }
  | { ok: false; code: "INVALID_PERMISSION" | "UNKNOWN_PERMISSION"; invalid: string[] };

/** Normalises requested permissions (lower-case, trim, de-duplicate), then checks their format and the known list. */
function validatePermissions(requested: Permission[], known: Set<string> | undefined): PermissionCheck {
  const permissions: Permission[] = [];
  const seen = new Set<string>();
  const malformed: string[] = [];
  const unknown: string[] = [];
  for (const p of requested) {
    const resource = p.resource.toLowerCase().trim();
    const action = p.action.toLowerCase().trim();
    const key = `${resource}:${action}`;
    if (!PERMISSION_PART.test(resource) || !PERMISSION_PART.test(action)) {
      malformed.push(key);
      continue;
    }
    if (known && !known.has(key)) unknown.push(key);
    if (!seen.has(key)) {
      seen.add(key);
      permissions.push({ resource, action });
    }
  }
  if (malformed.length > 0) return { ok: false, code: "INVALID_PERMISSION", invalid: malformed };
  if (unknown.length > 0) return { ok: false, code: "UNKNOWN_PERMISSION", invalid: unknown };
  return { ok: true, permissions };
}

/** The workspace owner holds every permission, matching the owner shortcut in `requirePermission`. */
const isOwner = (workspace: { role?: string }): boolean => workspace.role === "owner";

const grantExceeds = (missing: string[]) => ({ error: "Permission denied", code: "GRANT_EXCEEDS_CALLER", missing });

export function createRbacRoutes(options: RbacRouteOptions = {}): Hono<RbacEnv> {
  const app = new Hono<RbacEnv>();
  const known = options.knownPermissions
    ? new Set(options.knownPermissions.map((p) => p.toLowerCase().trim()))
    : undefined;

  // Attach policy engine to context
  app.use("*", rbacMiddleware);

  // List all roles in the current workspace
  app.get("/roles", requirePermission("roles", "read"), async (c) => {
    const workspace = c.get("workspace")!;
    const rbac = new RbacService(c.env.DB);
    const roles = await rbac.getRoles(workspace.id);
    return c.json({ roles }, 200);
  });

  // Create a new custom role (guarded by roles:write). A non-owner may only put permissions they hold into it.
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

    const checked = validatePermissions(parsed.data.permissions, known);
    if (!checked.ok) {
      const error = checked.code === "INVALID_PERMISSION" ? "Invalid permission" : "Unknown permission";
      return c.json({ error, code: checked.code, invalid: checked.invalid }, 400);
    }

    const rbac = new RbacService(c.env.DB);
    try {
      if (!isOwner(workspace)) {
        const missing = await rbac.missingGrants(workspace.id, c.get("user")!.uid, checked.permissions);
        if (missing.length > 0) return c.json(grantExceeds(missing), 403);
      }

      const result = await rbac.createRole(
        workspace.id,
        parsed.data.name,
        checked.permissions,
        parsed.data.description
      );

      if (!result.ok) {
        return c.json({ error: result.error }, result.code as 400 | 500);
      }

      return c.json({ role: result.role }, 201);
    } catch (err) {
      console.error("rbac-policy: POST /roles failed", err);
      return c.json({ error: "Failed to create role" }, 500);
    }
  });

  // Assign a role to a workspace member. A non-owner may not assign to themselves, nor assign a role carrying
  // permissions they do not hold.
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

    const { userId, roleId } = parsed.data;
    const callerUid = c.get("user")!.uid;
    const owner = isOwner(workspace);
    if (!owner && userId === callerUid) {
      return c.json({ error: "You cannot assign a role to yourself", code: "SELF_ASSIGNMENT_FORBIDDEN" }, 403);
    }

    const rbac = new RbacService(c.env.DB);
    try {
      const rolePermissions = await rbac.getRolePermissions(workspace.id, roleId);
      if (!rolePermissions) {
        return c.json({ error: "Role not found in this workspace" }, 404);
      }

      if (!owner) {
        const missing = await rbac.missingGrants(workspace.id, callerUid, rolePermissions);
        if (missing.length > 0) return c.json(grantExceeds(missing), 403);
      }

      let isMember: boolean;
      try {
        isMember = (await findWorkspaceMembership(c.env.DB, workspace.id, userId)) !== null;
      } catch (err) {
        // Fail closed: without the membership tables nobody can say who belongs to the workspace.
        console.error("rbac-policy: workspace membership lookup failed", err);
        return c.json({ error: "Workspace membership unavailable" }, 500);
      }
      if (!isMember) {
        return c.json({ error: "User is not a member of this workspace", code: "USER_NOT_IN_WORKSPACE" }, 404);
      }

      const assigned = await rbac.assignRole(workspace.id, userId, roleId);
      if (!assigned) {
        return c.json({ error: "Role not found in this workspace" }, 404);
      }

      return c.json({ success: true }, 200);
    } catch (err) {
      console.error("rbac-policy: POST /roles/assign failed", err);
      return c.json({ error: "Failed to assign role" }, 500);
    }
  });

  // Revoke a role from a user. A non-owner may not revoke a role carrying permissions they do not hold.
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
    try {
      if (!isOwner(workspace)) {
        const rolePermissions = await rbac.getRolePermissions(workspace.id, parsed.data.roleId);
        if (rolePermissions) {
          const missing = await rbac.missingGrants(workspace.id, c.get("user")!.uid, rolePermissions);
          if (missing.length > 0) return c.json(grantExceeds(missing), 403);
        }
      }

      const revoked = await rbac.revokeRole(workspace.id, parsed.data.userId, parsed.data.roleId);
      return c.json({ success: revoked }, 200);
    } catch (err) {
      console.error("rbac-policy: POST /roles/revoke failed", err);
      return c.json({ error: "Failed to revoke role" }, 500);
    }
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
