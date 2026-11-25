import type { AuditActorType, AuditStatement, D1Like } from "@poc/sdk";
import { auditStatement } from "@poc/sdk";

/**
 * Story 2.6: the audit surface other bricks are handed through the assembler's `$capability` route option
 * (`audit-logging.auditRecorder`), so they can write audit rows without importing this brick or writing its table.
 *
 * Every row written here carries the capability marker (`via_capability = 1`, migration 0002), which the public
 * `POST /audit/events` route never sets; and every read here looks only at marked rows, so nothing a workspace member
 * posts can pose as a pending operation or an outcome. The log stays append-only: nothing here changes or removes a row.
 *
 * - `statement` builds an insert (`auditStatement` from @poc/sdk) for the caller to hand to a write that runs it right
 *   after its change in one D1 batch; with `afterChange` it is written only if that change changed a row.
 * - `record` writes a row now, typically with `status: "pending"` before an action that cannot share a batch. With a
 *   `dedupeKey` it is written at most once per workspace and key (concurrent first attempts share one row), and the
 *   row under that key is returned, with `created: false` when it already existed.
 * - `outcome` appends a row (action `audit.outcome`) naming the pending row's id; `latestOutcome` reads the newest one.
 * - `pendingWithoutOutcome` and `pendingAcrossWorkspaces` list pending rows no outcome names yet.
 *
 * Only the actor types "user" and "system" are accepted: nobody can record an action as anyone else's.
 */
export interface AuditEntry {
  actorId: string;
  actorType?: AuditActorType;
  actorEmail?: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}

export interface AuditRowSummary {
  id: string;
  workspaceId: string;
  action: string;
  targetId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AuditRecorder {
  statement(db: D1Like, workspaceId: string, entry: AuditEntry, options?: { afterChange?: boolean }): AuditStatement;
  record(
    db: D1Like,
    workspaceId: string,
    entry: AuditEntry,
    options?: { dedupeKey?: string },
  ): Promise<{ id: string; created: boolean; metadata: Record<string, unknown> }>;
  outcome(db: D1Like, workspaceId: string, pendingId: string, actorId: string, outcome: Record<string, unknown>): Promise<{ id: string }>;
  latestOutcome(db: D1Like, workspaceId: string, pendingId: string): Promise<Record<string, unknown> | null>;
  pendingWithoutOutcome(db: D1Like, workspaceId: string, limit?: number): Promise<AuditRowSummary[]>;
  /** Every workspace's pending rows without an outcome, in id order after `after`, at most `limit` (1 to 100). */
  pendingAcrossWorkspaces(db: D1Like, options?: { limit?: number; after?: string }): Promise<{ rows: AuditRowSummary[]; next: string | null }>;
}

/** The action of an outcome row. */
export const AUDIT_OUTCOME_ACTION = "audit.outcome";

/** Action namespaces only the capability writes; the public route refuses them. */
export const RESERVED_AUDIT_ACTION = /^(platform|audit)\./i;

function parseMetadata(text: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface Row {
  id: string;
  workspace_id: string;
  action: string;
  target_id: string;
  metadata_json: string | null;
  created_at: string;
}

const summary = (r: Row): AuditRowSummary => ({
  id: r.id,
  workspaceId: r.workspace_id,
  action: r.action,
  targetId: r.target_id,
  metadata: parseMetadata(r.metadata_json),
  createdAt: r.created_at,
});

const input = (workspaceId: string, entry: AuditEntry) => ({ workspaceId, ...entry, actorType: entry.actorType ?? "user" });
const bound = (limit: number | undefined, max: number) => Math.min(max, Math.max(1, Math.floor(limit ?? 100)));

export const auditRecorder: AuditRecorder = Object.freeze({
  statement(db: D1Like, workspaceId: string, entry: AuditEntry, options: { afterChange?: boolean } = {}): AuditStatement {
    return auditStatement(db, input(workspaceId, entry), { afterChange: options.afterChange === true });
  },

  async record(db: D1Like, workspaceId: string, entry: AuditEntry, options: { dedupeKey?: string } = {}) {
    const made = auditStatement(db, input(workspaceId, entry), options.dedupeKey !== undefined ? { dedupeKey: options.dedupeKey } : {});
    const res = await made.statement.run();
    if (options.dedupeKey === undefined || res.meta.changes > 0) return { id: made.id, created: true, metadata: entry.metadata ?? {} };
    const row = await db
      .prepare("SELECT id, metadata_json FROM audit_events WHERE workspace_id = ? AND dedupe_key = ? AND via_capability = 1")
      .bind(workspaceId, options.dedupeKey)
      .first<{ id: string; metadata_json: string | null }>();
    if (!row) throw new Error("audit row for the dedupe key could not be read back");
    return { id: row.id, created: false, metadata: parseMetadata(row.metadata_json) };
  },

  async outcome(db: D1Like, workspaceId: string, pendingId: string, actorId: string, outcome: Record<string, unknown>): Promise<{ id: string }> {
    const made = auditStatement(db, { workspaceId, actorType: "user", actorId, action: AUDIT_OUTCOME_ACTION, targetType: "audit_event", targetId: pendingId, metadata: outcome });
    await made.statement.run();
    return { id: made.id };
  },

  async latestOutcome(db: D1Like, workspaceId: string, pendingId: string) {
    const row = await db
      .prepare(
        "SELECT metadata_json FROM audit_events WHERE workspace_id = ? AND via_capability = 1 AND action = ? AND target_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .bind(workspaceId, AUDIT_OUTCOME_ACTION, pendingId)
      .first<{ metadata_json: string | null }>();
    return row ? parseMetadata(row.metadata_json) : null;
  },

  async pendingWithoutOutcome(db: D1Like, workspaceId: string, limit?: number): Promise<AuditRowSummary[]> {
    const rows = await db
      .prepare(
        "SELECT a.id AS id, a.workspace_id AS workspace_id, a.action AS action, a.target_id AS target_id, a.metadata_json AS metadata_json, a.created_at AS created_at " +
          "FROM audit_events a WHERE a.workspace_id = ? AND a.via_capability = 1 AND json_extract(a.metadata_json, '$.status') = 'pending' AND NOT EXISTS " +
          "(SELECT 1 FROM audit_events o WHERE o.workspace_id = ? AND o.via_capability = 1 AND o.action = ? AND o.target_id = a.id) ORDER BY a.created_at ASC LIMIT ?",
      )
      .bind(workspaceId, workspaceId, AUDIT_OUTCOME_ACTION, bound(limit, 500))
      .all<Row>();
    return rows.results.map(summary);
  },

  async pendingAcrossWorkspaces(db: D1Like, options: { limit?: number; after?: string } = {}) {
    const limit = bound(options.limit ?? 50, 100);
    // tenant-lint: allow operator-only listing of capability-marked pending rows across every workspace; each outcome is matched within its own row's workspace
    const rows = await db
      .prepare(
        "SELECT a.id AS id, a.workspace_id AS workspace_id, a.action AS action, a.target_id AS target_id, a.metadata_json AS metadata_json, a.created_at AS created_at " +
          "FROM audit_events a WHERE a.via_capability = 1 AND a.id > ? AND json_extract(a.metadata_json, '$.status') = 'pending' AND NOT EXISTS " +
          "(SELECT 1 FROM audit_events o WHERE o.workspace_id = a.workspace_id AND o.via_capability = 1 AND o.action = ? AND o.target_id = a.id) ORDER BY a.id LIMIT ?",
      )
      .bind(options.after ?? "", AUDIT_OUTCOME_ACTION, limit + 1)
      .all<Row>();
    const page = rows.results.slice(0, limit).map(summary);
    return { rows: page, next: rows.results.length > limit ? (page[page.length - 1]?.id ?? null) : null };
  },
});
