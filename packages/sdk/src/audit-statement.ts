import type { D1Like, D1Statement } from "./d1.ts";

// Story 2.6: audit rows written on behalf of another brick (audit-trail's declared `auditRecorder` capability), and the
// only statements a write that takes `alongside` statements accepts.
//
// `auditStatement` builds the insert itself from structured fields: the SQL is fixed here and no caller SQL is ever
// accepted. Every row it writes carries the capability marker (`audit_events.via_capability = 1`, a column the public
// audit route never writes, audit-trail migration 0002), so readers that must trust a row (an operator's pending grant,
// an outcome) can ignore rows a workspace member posted. The result is branded (a WeakMap here), and consumers check the
// brand and the target workspace at run time.

const issued = new WeakMap<object, { workspaceId: string; afterChange: boolean; deduplicated: boolean }>();
const guards = new WeakSet<object>();

/** The actor types a capability-written audit row may name. Never anyone acting as someone else. */
export const AUDIT_ACTOR_TYPES = ["user", "system"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/** The longest metadata the audit table accepts (`audit_events.metadata_json`). */
export const MAX_AUDIT_METADATA_CHARS = 4096;

export interface AuditStatementInput {
  workspaceId: string;
  actorType: AuditActorType;
  actorId: string;
  actorEmail?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditStatementOptions {
  /**
   * Write the row only if the statement just before it in the batch changed a row (`changes() > 0`). Required for
   * statements handed to another write's `alongside`, so a change that did nothing never commits an audit row.
   */
  afterChange?: boolean;
  /** At most one capability row per (workspace, key): a second insert with the same key writes nothing (OR IGNORE). */
  dedupeKey?: string;
}

/** An insert into the audit table, made by `auditStatement`. */
export interface AuditStatement {
  /** The id of the row this statement writes. */
  readonly id: string;
  readonly workspaceId: string;
  readonly statement: D1Statement;
}

function text(value: unknown, name: string, max: number, required = true): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    if (!required) return "";
    throw new RangeError(`${name} is required`);
  }
  return value.trim().slice(0, max);
}

/** Builds one capability-marked audit insert from structured fields. Throws RangeError on a bad field. */
export function auditStatement(db: D1Like, input: AuditStatementInput, options: AuditStatementOptions = {}): AuditStatement {
  const workspaceId = input.workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.trim().length === 0 || workspaceId.length > 128)
    throw new RangeError("workspaceId must be 1 to 128 characters");
  if (!(AUDIT_ACTOR_TYPES as readonly string[]).includes(input.actorType)) throw new RangeError(`actor type ${String(input.actorType)} is not accepted`);
  const metadata = input.metadata === undefined ? null : JSON.stringify(input.metadata);
  if (metadata !== null && metadata.length > MAX_AUDIT_METADATA_CHARS)
    throw new RangeError(`audit metadata is longer than ${MAX_AUDIT_METADATA_CHARS} characters`);
  if (options.dedupeKey !== undefined && (typeof options.dedupeKey !== "string" || options.dedupeKey.length === 0 || options.dedupeKey.length > 200)) {
    throw new RangeError("dedupeKey must be 1 to 200 characters");
  }
  const id = `aud_${crypto.randomUUID().replace(/-/g, "")}`;
  const params = [
    id,
    workspaceId,
    text(input.actorId, "actorId", 128),
    input.actorType,
    input.actorEmail?.trim().slice(0, 255) || null,
    text(input.action, "action", 100).toLowerCase(),
    text(input.targetType, "targetType", 64, false),
    text(input.targetId, "targetId", 128, false),
    metadata,
    new Date().toISOString(),
    options.dedupeKey ?? null,
  ];
  const head = options.dedupeKey !== undefined ? "INSERT OR IGNORE INTO" : "INSERT INTO";
  const sql =
    `${head} audit_events (id, workspace_id, actor_id, actor_type, actor_email, action, target_type, target_id, metadata_json, created_at, dedupe_key, via_capability) ` +
    (options.afterChange ? "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1 WHERE changes() > 0" : "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)");
  const made: AuditStatement = Object.freeze({ id, workspaceId, statement: db.prepare(sql).bind(...params) });
  issued.set(made, { workspaceId, afterChange: options.afterChange === true, deduplicated: options.dedupeKey !== undefined });
  return made;
}

/** True only for objects made by `auditStatement`. */
export function isAuditStatement(value: unknown): value is AuditStatement {
  return typeof value === "object" && value !== null && issued.has(value);
}

/**
 * The D1 statements of `alongside`, after checking that every entry was made by `auditStatement` with `afterChange` and
 * without `dedupeKey` (an `INSERT OR IGNORE` could let a change commit without its row), for `workspaceId`. Throws
 * TypeError otherwise, before anything runs.
 */
export function auditStatementsOnly(alongside: readonly unknown[] | undefined, workspaceId: string): D1Statement[] {
  if (alongside === undefined) return [];
  if (!Array.isArray(alongside)) throw new TypeError("alongside must be a list of audit statements");
  return alongside.map((entry) => {
    const brand = typeof entry === "object" && entry !== null ? issued.get(entry) : undefined;
    if (!brand) throw new TypeError("alongside accepts only audit statements made by auditStatement");
    if (brand.workspaceId !== workspaceId) throw new TypeError("an alongside audit statement must be for the workspace being changed");
    if (!brand.afterChange) throw new TypeError("an alongside audit statement must be made with afterChange");
    if (brand.deduplicated) throw new TypeError("an alongside audit statement must not carry a dedupeKey");
    return (entry as AuditStatement).statement;
  });
}

/** A condition, made only here, that a guarded write appends to its own WHERE. */
export interface WorkspaceGuard {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Story 2.6: the workspace is not fenced for deletion (story 1.10's `suspended_reason = "deleting"`). */
export function workspaceNotDeletingGuard(workspaceId: string): WorkspaceGuard {
  const made: WorkspaceGuard = Object.freeze({
    sql: "NOT EXISTS (SELECT 1 FROM mw_workspaces WHERE id = ? AND suspended_reason = ?)",
    params: Object.freeze([workspaceId, "deleting"]),
  });
  guards.add(made);
  return made;
}

/** The guard's SQL and params, after checking it was made here. Throws TypeError otherwise. */
export function workspaceGuardParts(guard: unknown): { sql: string; params: unknown[] } {
  if (typeof guard !== "object" || guard === null || !guards.has(guard)) throw new TypeError("workspace guards are made by @poc/sdk only");
  const g = guard as WorkspaceGuard;
  return { sql: g.sql, params: [...g.params] };
}
