import { scoped, type D1Like } from "@poc/sdk";

export type ConsentCategory = "necessary" | "analytics" | "marketing" | "preferences";
export type ErasureStatus = "pending" | "processing" | "completed" | "rejected";
export type ExportStatus = "pending" | "completed" | "failed";

export interface ConsentRecord {
  id: string;
  user_id: string;
  workspace_id: string;
  category: ConsentCategory;
  granted: boolean;
  ip_address: string | null;
  user_agent: string | null;
  updated_at: string;
}

export interface ErasureRequestRecord {
  id: string;
  user_id: string;
  workspace_id: string;
  status: ErasureStatus;
  reason: string | null;
  deleted_records_count: number;
  requested_at: string;
  completed_at: string | null;
}

export interface ExportRequestRecord {
  id: string;
  user_id: string;
  workspace_id: string;
  status: ExportStatus;
  export_data: Record<string, unknown> | null;
  download_url: string | null;
  requested_at: string;
  completed_at: string | null;
}

export interface PrivacyServiceHooks {
  /** `requesterId` (story 2.6): who asked for the export; platform-wide records are included only for a self-export. */
  exportTenant?: (db: D1Like, subject: { workspaceId: string; userId?: string; requesterId?: string }) => Promise<Record<string, unknown>>;
  eraseTenant?: (db: D1Like, subject: { workspaceId: string; userId?: string }) => Promise<{ deletedCount: number; retain: Array<{ table: string; reason?: string }> }>;
}

export class DataPrivacyService {
  private readonly db: D1Like;
  private readonly hooks: PrivacyServiceHooks | undefined;

  constructor(db: D1Like, hooks?: PrivacyServiceHooks) {
    this.db = db;
    this.hooks = hooks;
  }

  /**
   * Sets or updates user consent preferences (e.g. from cookie banner).
   */
  async setConsents(
    workspaceId: string,
    userId: string,
    consents: Partial<Record<ConsentCategory, boolean>>,
    clientInfo: { ip?: string; userAgent?: string } = {}
  ): Promise<Record<ConsentCategory, boolean>> {
    const now = new Date().toISOString();
    const categories: ConsentCategory[] = ["necessary", "analytics", "marketing", "preferences"];

    for (const cat of categories) {
      if (consents[cat] !== undefined) {
        const id = `cns_${crypto.randomUUID().replace(/-/g, "")}`;
        const granted = cat === "necessary" ? 1 : consents[cat] ? 1 : 0;

        const existing = await scoped(this.db, workspaceId).first<{ id: string }>(
          "dpr_consents",
          "user_id = ? AND category = ?",
          [userId.trim(), cat]
        );

        if (existing) {
          await scoped(this.db, workspaceId).update(
            "dpr_consents",
            {
              granted,
              ip_address: clientInfo.ip || null,
              user_agent: clientInfo.userAgent || null,
              updated_at: now,
            },
            "user_id = ? AND category = ?",
            [userId.trim(), cat]
          );
        } else {
          await scoped(this.db, workspaceId).insert("dpr_consents", {
            id,
            user_id: userId.trim(),
            category: cat,
            granted,
            ip_address: clientInfo.ip || null,
            user_agent: clientInfo.userAgent || null,
            updated_at: now,
          });
        }
      }
    }

    return this.getConsents(workspaceId, userId);
  }

  /**
   * Retrieves current consent status for a user.
   */
  async getConsents(workspaceId: string, userId: string): Promise<Record<ConsentCategory, boolean>> {
    const rows = await scoped(this.db, workspaceId).select<{ category: ConsentCategory; granted: number }>(
      "dpr_consents",
      "user_id = ?",
      [userId.trim()]
    );

    const result: Record<ConsentCategory, boolean> = {
      necessary: true, // Always required
      analytics: false,
      marketing: false,
      preferences: false,
    };

    for (const r of rows) {
      result[r.category] = r.granted === 1;
    }

    return result;
  }

  /**
   * Generates a GDPR Article 20 personal data export archive.
   */
  async requestDataExport(workspaceId: string, userId: string, requesterId?: string): Promise<ExportRequestRecord> {
    const expId = `exp_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();

    // 1. Collect consents
    const consents = await this.getConsents(workspaceId, userId);

    const collectedData: Record<string, unknown> = {
      user_id: userId,
      workspace_id: workspaceId,
      exported_at: now,
      privacy_consents: consents,
    };

    // 2. Gather data from generated exportTenant hook if provided
    if (this.hooks?.exportTenant) {
      try {
        const tenantData = await this.hooks.exportTenant(this.db, { workspaceId, userId, ...(requesterId ? { requesterId } : {}) });
        Object.assign(collectedData, tenantData);
      } catch (err) {
        console.error("DataPrivacyService.requestDataExport hook error:", err);
      }
    }

    const jsonString = JSON.stringify(collectedData);

    await scoped(this.db, workspaceId).insert("dpr_export_requests", {
      id: expId,
      user_id: userId.trim(),
      status: "completed",
      export_data_json: jsonString,
      download_url: null,
      requested_at: now,
      completed_at: now,
    });

    return {
      id: expId,
      user_id: userId.trim(),
      workspace_id: workspaceId,
      status: "completed",
      export_data: collectedData,
      download_url: null,
      requested_at: now,
      completed_at: now,
    };
  }

  /**
   * Retrieves an export request by ID.
   */
  async getExportRequest(workspaceId: string, exportId: string): Promise<ExportRequestRecord | null> {
    const row = await scoped(this.db, workspaceId).first<{
      id: string;
      user_id: string;
      workspace_id: string;
      status: ExportStatus;
      export_data_json: string | null;
      download_url: string | null;
      requested_at: string;
      completed_at: string | null;
    }>("dpr_export_requests", "id = ?", [exportId]);

    if (!row) return null;

    return {
      id: row.id,
      user_id: row.user_id,
      workspace_id: row.workspace_id,
      status: row.status,
      export_data: row.export_data_json ? JSON.parse(row.export_data_json) : null,
      download_url: row.download_url,
      requested_at: row.requested_at,
      completed_at: row.completed_at,
    };
  }

  /**
   * Executes a GDPR Article 17 "Right to Erasure" cascade deletion.
   */
  async requestErasure(
    workspaceId: string,
    userId: string,
    reason?: string
  ): Promise<ErasureRequestRecord> {
    const reqId = `ers_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    let totalDeleted = 0;

    // 1. Delete consents
    const delConsents = await scoped(this.db, workspaceId).delete(
      "dpr_consents",
      "user_id = ?",
      [userId.trim()]
    );
    totalDeleted += delConsents.meta.changes;

    // 2. Clear exports
    const delExports = await scoped(this.db, workspaceId).delete(
      "dpr_export_requests",
      "user_id = ?",
      [userId.trim()]
    );
    totalDeleted += delExports.meta.changes;

    // 3. Delegate erasure across all tenant tables via eraseTenant hook
    if (this.hooks?.eraseTenant) {
      const res = await this.hooks.eraseTenant(this.db, { workspaceId, userId });
      totalDeleted += res.deletedCount;
    }

    // 4. Record completed erasure request
    await scoped(this.db, workspaceId).insert("dpr_erasure_requests", {
      id: reqId,
      user_id: userId.trim(),
      status: "completed",
      reason: reason?.trim() || "User requested account deletion",
      deleted_records_count: totalDeleted,
      requested_at: now,
      completed_at: now,
    });

    return {
      id: reqId,
      user_id: userId.trim(),
      workspace_id: workspaceId,
      status: "completed",
      reason: reason?.trim() || "User requested account deletion",
      deleted_records_count: totalDeleted,
      requested_at: now,
      completed_at: now,
    };
  }

  /**
   * Executes workspace-level erasure (tenant offboarding).
   */
  async eraseWorkspace(
    workspaceId: string
  ): Promise<{ deletedCount: number; retain: Array<{ table: string; reason?: string }> }> {
    let deletedCount = 0;
    let retain: Array<{ table: string; reason?: string }> = [];

    if (this.hooks?.eraseTenant) {
      const res = await this.hooks.eraseTenant(this.db, { workspaceId });
      deletedCount += res.deletedCount;
      retain = res.retain;
    }

    const delConsents = await scoped(this.db, workspaceId).delete("dpr_consents");
    const delExports = await scoped(this.db, workspaceId).delete("dpr_export_requests");
    const delErasures = await scoped(this.db, workspaceId).delete("dpr_erasure_requests");
    deletedCount += delConsents.meta.changes + delExports.meta.changes + delErasures.meta.changes;

    return { deletedCount, retain };
  }

  /**
   * Retrieves an erasure request record.
   */
  async getErasureRequest(workspaceId: string, erasureId: string): Promise<ErasureRequestRecord | null> {
    const row = await scoped(this.db, workspaceId).first<ErasureRequestRecord>(
      "dpr_erasure_requests",
      "id = ?",
      [erasureId]
    );

    return row || null;
  }
}
