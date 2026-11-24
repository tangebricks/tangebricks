import { scoped, type D1Like } from "@poc/sdk";

export interface Permission {
  resource: string;
  action: string;
}

export interface RoleRecord {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  is_system: number;
  permissions?: Permission[];
  created_at: string;
}

export class RbacService {
  constructor(private readonly db: D1Like) {}

  /**
   * Creates a role and its associated permissions within a workspace.
   */
  async createRole(
    workspaceId: string,
    name: string,
    permissions: Permission[] = [],
    description?: string,
    isSystem = false
  ): Promise<{ ok: true; role: RoleRecord } | { ok: false; error: string; code: number }> {
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName.length > 64) {
      return { ok: false, error: "Role name must be between 1 and 64 characters", code: 400 };
    }

    const roleId = `role_${crypto.randomUUID().replace(/-/g, "")}`;

    try {
      await scoped(this.db, workspaceId).insert("rbac_roles", {
        id: roleId,
        name: trimmedName,
        description: description?.trim() || null,
        is_system: isSystem ? 1 : 0,
      });

      if (permissions.length > 0) {
        const permStmts = permissions.map((p) =>
          this.db.prepare(
            "INSERT OR IGNORE INTO rbac_permissions (role_id, resource, action) VALUES (?, ?, ?)"
          ).bind(roleId, p.resource.toLowerCase().trim(), p.action.toLowerCase().trim())
        );
        await this.db.batch(permStmts);
      }
    } catch (err: unknown) {
      // The DB error text stays in the log; the response body never carries it.
      console.error("rbac-policy: createRole failed", err);
      return { ok: false, error: "Failed to create role", code: 500 };
    }

    return {
      ok: true,
      role: {
        id: roleId,
        workspace_id: workspaceId,
        name: trimmedName,
        description: description?.trim() || null,
        is_system: isSystem ? 1 : 0,
        permissions,
        created_at: new Date().toISOString(),
      },
    };
  }

  /**
   * Retrieves all roles in a workspace along with their permissions.
   */
  async getRoles(workspaceId: string): Promise<RoleRecord[]> {
    interface RoleRow {
      id: string;
      workspace_id: string;
      name: string;
      description: string | null;
      is_system: number;
      created_at: string;
    }

    const roles = await scoped(this.db, workspaceId).select<RoleRow>(
      "rbac_roles",
      undefined,
      [],
      { orderBy: "created_at ASC" }
    );

    if (roles.length === 0) {
      return [];
    }

    const placeholders = roles.map(() => "?").join(",");
    const permRows = (await this.db.prepare(`
      SELECT role_id, resource, action
      FROM rbac_permissions
      WHERE role_id IN (${placeholders})
    `).bind(...roles.map((r) => r.id)).all<{ role_id: string; resource: string; action: string }>()).results;

    const permsByRole = new Map<string, Permission[]>();
    for (const p of permRows) {
      if (!permsByRole.has(p.role_id)) {
        permsByRole.set(p.role_id, []);
      }
      permsByRole.get(p.role_id)!.push({ resource: p.resource, action: p.action });
    }

    return roles.map((r) => ({
      ...r,
      permissions: permsByRole.get(r.id) || [],
    }));
  }

  /**
   * Assigns a role to a user within a workspace.
   */
  async assignRole(workspaceId: string, userId: string, roleId: string): Promise<boolean> {
    const role = await scoped(this.db, workspaceId).first("rbac_roles", "id = ?", [roleId]);
    if (!role) return false;

    const existing = await scoped(this.db, workspaceId).first(
      "rbac_role_assignments",
      "user_id = ? AND role_id = ?",
      [userId, roleId]
    );
    if (!existing) {
      await scoped(this.db, workspaceId).insert("rbac_role_assignments", {
        user_id: userId,
        role_id: roleId,
      });
    }

    return true;
  }

  /**
   * Revokes a role from a user within a workspace.
   */
  async revokeRole(workspaceId: string, userId: string, roleId: string): Promise<boolean> {
    const res = await scoped(this.db, workspaceId).delete(
      "rbac_role_assignments",
      "user_id = ? AND role_id = ?",
      [userId, roleId]
    );
    return res.meta.changes > 0;
  }

  /**
   * Computes all permissions a user has within a workspace across all assigned roles.
   */
  async getUserPermissions(workspaceId: string, userId: string): Promise<Set<string>> {
    interface PermRow {
      resource: string;
      action: string;
    }

    const assignments = await scoped(this.db, workspaceId).select<{ role_id: string }>(
      "rbac_role_assignments",
      "user_id = ?",
      [userId]
    );

    if (assignments.length === 0) {
      return new Set();
    }

    const roleIds = assignments.map((a) => a.role_id);
    const placeholders = roleIds.map(() => "?").join(",");
    const rows = (await this.db.prepare(`
      SELECT DISTINCT resource, action
      FROM rbac_permissions
      WHERE role_id IN (${placeholders})
    `).bind(...roleIds).all<PermRow>()).results;

    const set = new Set<string>();
    for (const r of rows) {
      set.add(`${r.resource.toLowerCase()}:${r.action.toLowerCase()}`);
    }
    return set;
  }

  /**
   * The permissions of one role in a workspace, or null when the role does not exist in that workspace.
   */
  async getRolePermissions(workspaceId: string, roleId: string): Promise<Permission[] | null> {
    const role = await scoped(this.db, workspaceId).first("rbac_roles", "id = ?", [roleId]);
    if (!role) return null;
    const rows = (await this.db.prepare(
      "SELECT resource, action FROM rbac_permissions WHERE role_id = ?"
    ).bind(roleId).all<Permission>()).results;
    return rows.map((r) => ({ resource: r.resource.toLowerCase(), action: r.action.toLowerCase() }));
  }

  /**
   * The permissions in `permissions` the user does not hold in the workspace, as "resource:action" strings (empty when
   * the user holds them all). "Holds" means `can` is true for that literal pair, so a wildcard such as `*:read` is
   * held only through `*:read` or `*:*`, and `docs:*` only through `docs:*` or `*:*`. The workspace-owner shortcut is
   * the caller's concern, as in `requirePermission`.
   */
  async missingGrants(workspaceId: string, userId: string, permissions: Permission[]): Promise<string[]> {
    if (permissions.length === 0) return [];
    const held = await this.getUserPermissions(workspaceId, userId);
    const missing: string[] = [];
    for (const p of permissions) {
      const resource = p.resource.toLowerCase().trim();
      const action = p.action.toLowerCase().trim();
      const key = `${resource}:${action}`;
      if (!RbacService.covers(held, resource, action) && !missing.includes(key)) missing.push(key);
    }
    return missing;
  }

  /** Whether a set of held "resource:action" permissions covers one (already normalised) resource and action. */
  private static covers(permissions: Set<string>, resource: string, action: string): boolean {
    return (
      permissions.has("*:*") ||
      permissions.has(`${resource}:*`) ||
      permissions.has(`*:${action}`) ||
      permissions.has(`${resource}:${action}`)
    );
  }

  /**
   * Dynamic authorization check: checks whether a user has permission to perform an action on a resource.
   * Supports:
   * - Exact match: "documents:read"
   * - Action wildcard: "documents:*" (allows any action on documents)
   * - Resource wildcard: "*:read" (allows read on any resource)
   * - Superadmin wildcard: "*:*" (allows all actions on all resources)
   */
  async can(workspaceId: string, userId: string, resourceRaw: string, actionRaw: string): Promise<boolean> {
    const resource = resourceRaw.toLowerCase().trim();
    const action = actionRaw.toLowerCase().trim();
    const permissions = await this.getUserPermissions(workspaceId, userId);
    return RbacService.covers(permissions, resource, action);
  }
}
