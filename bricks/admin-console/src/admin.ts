import type { D1Like } from "@poc/sdk";

export type SuperAdminRole = "super_admin" | "support_agent" | "auditor";
export type TenantStatus = "active" | "suspended" | "read_only";

export interface SuperAdminRecord {
  user_id: string;
  email: string;
  role: SuperAdminRole;
  is_active: boolean;
  created_at: string;
}

export interface TenantOverrideRecord {
  workspace_id: string;
  status: TenantStatus;
  reason: string | null;
  custom_limits: Record<string, unknown>;
  updated_by: string;
  updated_at: string;
}

export interface ImpersonationSessionRecord {
  id: string;
  admin_user_id: string;
  impersonated_user_id: string;
  workspace_id: string;
  session_token: string;
  reason: string;
  expires_at: number;
  ended_at: number | null;
  created_at: string;
}

export interface StartImpersonationInput {
  adminUserId: string;
  impersonatedUserId: string;
  workspaceId: string;
  reason: string;
  durationMinutes?: number;
}

export interface ImpersonationVerificationResult {
  valid: boolean;
  adminUserId?: string;
  impersonatedUserId?: string;
  workspaceId?: string;
  reason?: string;
  expiresAt?: number;
  error?: string;
}

const ROLE_HIERARCHY: Record<SuperAdminRole, number> = {
  super_admin: 3,
  support_agent: 2,
  auditor: 1,
};

export class AdminConsoleService {
  private readonly db: D1Like;

  constructor(db: D1Like) {
    this.db = db;
  }

  /**
   * Registers a super admin or support agent.
   */
  async addSuperAdmin(userId: string, email: string, role: SuperAdminRole = "support_agent"): Promise<SuperAdminRecord> {
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `
      INSERT INTO adm_super_admins (user_id, email, role, is_active, created_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        email = excluded.email,
        role = excluded.role,
        is_active = 1
    `,
      )
      .bind(userId.trim(), email.trim().toLowerCase(), role, now)
      .run();

    return {
      user_id: userId.trim(),
      email: email.trim().toLowerCase(),
      role,
      is_active: true,
      created_at: now,
    };
  }

  /**
   * Retrieves super admin details.
   */
  async getSuperAdmin(userId: string): Promise<SuperAdminRecord | null> {
    const row = await this.db.prepare("SELECT user_id, email, role, is_active, created_at FROM adm_super_admins WHERE user_id = ?").bind(userId.trim()).first<{
      user_id: string;
      email: string;
      role: SuperAdminRole;
      is_active: number;
      created_at: string;
    }>();

    if (!row) return null;

    return {
      ...row,
      is_active: row.is_active === 1,
    };
  }

  /**
   * Verifies if caller possesses required super admin privileges.
   */
  async verifyAdminAccess(userId: string, minRole: SuperAdminRole = "support_agent"): Promise<boolean> {
    const admin = await this.getSuperAdmin(userId);
    if (!admin || !admin.is_active) return false;

    const callerLevel = ROLE_HIERARCHY[admin.role] || 0;
    const requiredLevel = ROLE_HIERARCHY[minRole] || 0;

    return callerLevel >= requiredLevel;
  }

  /**
   * Overrides tenant status (active, suspended, read_only).
   */
  async setTenantStatus(adminUserId: string, workspaceId: string, status: TenantStatus, reason?: string): Promise<TenantOverrideRecord> {
    const isAuthorized = await this.verifyAdminAccess(adminUserId, "support_agent");
    if (!isAuthorized) {
      throw new Error("Unauthorized: Super-admin or support privilege required");
    }

    const now = new Date().toISOString();
    const reasonText = reason?.trim() || null;

    await this.db
      .prepare(
        `
      INSERT INTO adm_tenant_overrides (
        workspace_id, status, reason, custom_limits_json, updated_by, updated_at
      ) VALUES (?, ?, ?, '{}', ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        status = excluded.status,
        reason = excluded.reason,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `,
      )
      .bind(workspaceId, status, reasonText, adminUserId, now)
      .run();

    const override = await this.getTenantOverride(workspaceId);
    return override!;
  }

  /**
   * Retrieves tenant override status.
   */
  async getTenantOverride(workspaceId: string): Promise<TenantOverrideRecord | null> {
    const row = await this.db.prepare("SELECT * FROM adm_tenant_overrides WHERE workspace_id = ?").bind(workspaceId).first<{
      workspace_id: string;
      status: TenantStatus;
      reason: string | null;
      custom_limits_json: string;
      updated_by: string;
      updated_at: string;
    }>();

    if (!row) return null;

    return {
      workspace_id: row.workspace_id,
      status: row.status,
      reason: row.reason,
      custom_limits: JSON.parse(row.custom_limits_json || "{}"),
      updated_by: row.updated_by,
      updated_at: row.updated_at,
    };
  }

  /**
   * Sets custom enterprise limits for a tenant.
   */
  async setTenantCustomLimits(adminUserId: string, workspaceId: string, limits: Record<string, unknown>): Promise<TenantOverrideRecord> {
    const isAuthorized = await this.verifyAdminAccess(adminUserId, "super_admin");
    if (!isAuthorized) {
      throw new Error("Unauthorized: Super-admin privilege required to modify tenant limits");
    }

    const now = new Date().toISOString();
    const limitsJson = JSON.stringify(limits);

    await this.db
      .prepare(
        `
      INSERT INTO adm_tenant_overrides (
        workspace_id, status, reason, custom_limits_json, updated_by, updated_at
      ) VALUES (?, 'active', NULL, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        custom_limits_json = excluded.custom_limits_json,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `,
      )
      .bind(workspaceId, limitsJson, adminUserId, now)
      .run();

    const override = await this.getTenantOverride(workspaceId);
    return override!;
  }

  /**
   * Starts an impersonation session ("Login as User").
   */
  async startImpersonationSession(input: StartImpersonationInput): Promise<ImpersonationSessionRecord> {
    const isAuthorized = await this.verifyAdminAccess(input.adminUserId, "support_agent");
    if (!isAuthorized) {
      throw new Error("Unauthorized: Support agent or super-admin role required to impersonate");
    }

    if (!input.reason || input.reason.trim().length < 5) {
      throw new Error("An audit reason of at least 5 characters is strictly required for impersonation");
    }

    const sessionId = `imp_${crypto.randomUUID().replace(/-/g, "")}`;
    const sessionToken = `imp_tok_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
    const duration = Math.min(120, Math.max(5, input.durationMinutes ?? 30));
    const expiresAt = Date.now() + duration * 60 * 1000;
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `
      INSERT INTO adm_impersonation_sessions (
        id, admin_user_id, impersonated_user_id, workspace_id,
        session_token, reason, expires_at, ended_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `,
      )
      .bind(sessionId, input.adminUserId, input.impersonatedUserId.trim(), input.workspaceId.trim(), sessionToken, input.reason.trim(), expiresAt, now)
      .run();

    return {
      id: sessionId,
      admin_user_id: input.adminUserId,
      impersonated_user_id: input.impersonatedUserId.trim(),
      workspace_id: input.workspaceId.trim(),
      session_token: sessionToken,
      reason: input.reason.trim(),
      expires_at: expiresAt,
      ended_at: null,
      created_at: now,
    };
  }

  /**
   * Verifies an active impersonation token.
   */
  async verifyImpersonationToken(sessionToken: string): Promise<ImpersonationVerificationResult> {
    const row = await this.db.prepare("SELECT * FROM adm_impersonation_sessions WHERE session_token = ?").bind(sessionToken.trim()).first<{
      id: string;
      admin_user_id: string;
      impersonated_user_id: string;
      workspace_id: string;
      session_token: string;
      reason: string;
      expires_at: number;
      ended_at: number | null;
      created_at: string;
    }>();

    if (!row) {
      return { valid: false, error: "Invalid impersonation token" };
    }

    if (row.ended_at !== null) {
      return { valid: false, error: "Impersonation session has already been ended" };
    }

    if (Date.now() > row.expires_at) {
      return { valid: false, error: "Impersonation session has expired" };
    }

    return {
      valid: true,
      adminUserId: row.admin_user_id,
      impersonatedUserId: row.impersonated_user_id,
      workspaceId: row.workspace_id,
      reason: row.reason,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Ends an active impersonation session immediately.
   */
  async endImpersonationSession(sessionToken: string): Promise<boolean> {
    const now = Date.now();
    const res = await this.db
      .prepare(
        `
      UPDATE adm_impersonation_sessions
      SET ended_at = ?
      WHERE session_token = ? AND ended_at IS NULL
    `,
      )
      .bind(now, sessionToken.trim())
      .run();

    return res.meta.changes > 0;
  }

  /**
   * Lists recent impersonation sessions for security auditing.
   */
  async listImpersonationSessions(adminUserId: string, options: { workspaceId?: string; limit?: number } = {}): Promise<ImpersonationSessionRecord[]> {
    const isAuthorized = await this.verifyAdminAccess(adminUserId, "auditor");
    if (!isAuthorized) {
      throw new Error("Unauthorized: Auditor or super-admin role required to view sessions");
    }

    let query = "SELECT * FROM adm_impersonation_sessions";
    const params: unknown[] = [];

    if (options.workspaceId) {
      query += " WHERE workspace_id = ?";
      params.push(options.workspaceId);
    }

    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(options.limit || 50);

    const rows = (
      await this.db
        .prepare(query)
        .bind(...params)
        .all<{
          id: string;
          admin_user_id: string;
          impersonated_user_id: string;
          workspace_id: string;
          session_token: string;
          reason: string;
          expires_at: number;
          ended_at: number | null;
          created_at: string;
        }>()
    ).results;

    return rows;
  }
}
