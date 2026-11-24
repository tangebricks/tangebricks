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
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Failed to create role: ${msg}`, code: 500 };
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

    if (permissions.has("*:*")) return true;
    if (permissions.has(`${resource}:*`)) return true;
    if (permissions.has(`*:${action}`)) return true;
    if (permissions.has(`${resource}:${action}`)) return true;

    return false;
  }
}
