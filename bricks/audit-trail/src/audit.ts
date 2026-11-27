import type { D1Like } from "@poc/sdk";
import { scoped } from "@poc/sdk";

export type ActorType = "user" | "api_key" | "system" | "support_impersonator";

export interface AuditEvent {
  id: string;
  workspace_id: string;
  actor_id: string;
  actor_type: ActorType;
  actor_email: string | null;
  action: string;
  target_type: string;
  target_id: string;
  ip_address: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CreateAuditEventInput {
  workspaceId: string;
  actorId: string;
  actorType?: ActorType;
  actorEmail?: string;
  action: string;
  targetType: string;
  targetId: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditListFilter {
  action?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  limit?: number;
  offset?: number;
}

interface RawAuditRow {
  id: string;
  workspace_id: string;
  actor_id: string;
  actor_type: ActorType;
  actor_email: string | null;
  action: string;
  target_type: string;
  target_id: string;
  ip_address: string | null;
  user_agent: string | null;
  metadata_json: string | null;
  created_at: string;
}

export class AuditTrailService {
  private readonly db: D1Like;

  constructor(db: D1Like) {
    this.db = db;
  }

  private parseRow(row: RawAuditRow): AuditEvent {
    let meta = {};
    if (row.metadata_json) {
      try {
        meta = JSON.parse(row.metadata_json);
      } catch {
        meta = {};
      }
    }

    return {
      id: row.id,
      workspace_id: row.workspace_id,
      actor_id: row.actor_id,
      actor_type: row.actor_type,
      actor_email: row.actor_email,
      action: row.action,
      target_type: row.target_type,
      target_id: row.target_id,
      ip_address: row.ip_address,
      user_agent: row.user_agent,
      metadata: meta,
      created_at: row.created_at,
    };
  }

  /**
   * Appends an immutable audit event to the ledger.
   */
  async record(input: CreateAuditEventInput): Promise<AuditEvent> {
    const id = `aud_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const actorType = input.actorType || "user";
    const metaJson = input.metadata ? JSON.stringify(input.metadata) : null;

    await scoped(this.db, input.workspaceId).insert("audit_events", {
      id,
      actor_id: input.actorId.trim().slice(0, 128),
      actor_type: actorType,
      actor_email: input.actorEmail?.trim().slice(0, 255) || null,
      action: input.action.trim().toLowerCase().slice(0, 100),
      target_type: input.targetType.trim().slice(0, 64),
      target_id: input.targetId.trim().slice(0, 128),
      ip_address: input.ipAddress?.slice(0, 45) || null,
      user_agent: input.userAgent?.slice(0, 512) || null,
      metadata_json: metaJson,
      created_at: now,
    });

    return {
      id,
      workspace_id: input.workspaceId,
      actor_id: input.actorId.trim(),
      actor_type: actorType,
      actor_email: input.actorEmail?.trim() || null,
      action: input.action.trim().toLowerCase(),
      target_type: input.targetType.trim(),
      target_id: input.targetId.trim(),
      ip_address: input.ipAddress || null,
      user_agent: input.userAgent || null,
      metadata: input.metadata || {},
      created_at: now,
    };
  }

  /**
   * Queries audit events with multi-field filtering and pagination.
   */
  async list(workspaceId: string, filter: AuditListFilter = {}): Promise<AuditEvent[]> {
    const whereClauses: string[] = [];
    const params: unknown[] = [];

    if (filter.action) {
      whereClauses.push("action = ?");
      params.push(filter.action.trim().toLowerCase());
    }
    if (filter.actorId) {
      whereClauses.push("actor_id = ?");
      params.push(filter.actorId.trim());
    }
    if (filter.targetType) {
      whereClauses.push("target_type = ?");
      params.push(filter.targetType.trim());
    }
    if (filter.targetId) {
      whereClauses.push("target_id = ?");
      params.push(filter.targetId.trim());
    }

    const where = whereClauses.length > 0 ? whereClauses.join(" AND ") : undefined;
    const rows = await scoped(this.db, workspaceId).select<RawAuditRow>("audit_events", where, params, {
      orderBy: "created_at DESC",
      limit: filter.limit || 50,
      offset: filter.offset || 0,
    });
    return rows.map((r) => this.parseRow(r));
  }

  /**
   * Generates SOC2 / ISO compliance CSV export.
   */
  async exportCsv(workspaceId: string, filter: AuditListFilter = {}): Promise<string> {
    const events = await this.list(workspaceId, { ...filter, limit: 1000 });
    const headers = ["id", "timestamp", "actor_id", "actor_type", "actor_email", "action", "target_type", "target_id", "ip_address", "metadata"];

    const escapeCsv = (val: string | null | undefined): string => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const lines = [headers.join(",")];

    for (const e of events) {
      lines.push(
        [
          escapeCsv(e.id),
          escapeCsv(e.created_at),
          escapeCsv(e.actor_id),
          escapeCsv(e.actor_type),
          escapeCsv(e.actor_email),
          escapeCsv(e.action),
          escapeCsv(e.target_type),
          escapeCsv(e.target_id),
          escapeCsv(e.ip_address),
          escapeCsv(JSON.stringify(e.metadata)),
        ].join(","),
      );
    }

    return lines.join("\n");
  }
}
