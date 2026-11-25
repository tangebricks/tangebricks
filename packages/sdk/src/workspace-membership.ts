import { auditStatementsOnly } from "./audit-statement.ts";
import type { AuditStatement } from "./audit-statement.ts";
import type { D1Like } from "./d1.ts";
import { systemScope } from "./scoped.ts";

/** A user's membership row in a workspace, as the multi-workspace brick stores it. */
export interface WorkspaceMembership {
  role: string;
  suspended: boolean;
}

/**
 * The multi-workspace membership lookup (the same query `workspaceMiddleware` runs): the caller's role in `workspaceId`,
 * or null when they are not a member. Used by identity bricks that map a token to a workspace (oidc-verify).
 */
export async function findWorkspaceMembership(
  db: D1Like,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMembership | null> {
  const row = await systemScope(db, "workspace membership check")
    .raw(
      "SELECT m.role AS role, w.suspended AS suspended FROM mw_members m JOIN mw_workspaces w ON m.workspace_id = w.id WHERE m.workspace_id = ? AND m.user_id = ?",
      [workspaceId, userId],
    )
    .first<{ role: string; suspended: number }>();
  if (!row) return null;
  return { role: row.role, suspended: Boolean(row.suspended) };
}

/** A workspace's own state, as the multi-workspace brick stores it. */
export interface WorkspaceState {
  suspended: boolean;
  /**
   * Story 2.6: why it is suspended (`mw_workspaces.suspended_reason`): `"deleting"` while the workspace delete (story
   * 1.10) is fenced in, `"operator"` for an operator suspension, null when not suspended or unknown.
   */
  reason: string | null;
  /** Story 2.6: true while a delete is in progress (`suspended_reason = "deleting"`); nothing may change it then. */
  deleting: boolean;
  /**
   * False when the database has no workspace registry (`mw_workspaces`): a host that runs its own workspace guard
   * instead of the multi-workspace brick. Nothing was checked then, and `suspended` is false.
   */
  checked: boolean;
}

/** The workspace registry table the multi-workspace brick creates. */
export const WORKSPACE_REGISTRY_TABLE = "mw_workspaces";

// Only a positive answer is cached: a registry created later (a migration) is still found.
const registryKnown = new WeakSet<object>();

/**
 * Story 2.5: whether this database has the workspace registry (`mw_workspaces`), read from `sqlite_master` once per
 * database object and cached once found.
 */
export async function hasWorkspaceRegistry(db: D1Like): Promise<boolean> {
  if (registryKnown.has(db)) return true;
  const row = await db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(WORKSPACE_REGISTRY_TABLE)
    .first<{ present: number }>();
  if (row) registryKnown.add(db);
  return Boolean(row);
}

/**
 * Story 2.5: whether a workspace exists, and whether it is suspended, read from the same row `workspaceMiddleware` and
 * `requireNotSuspended` use (`mw_workspaces`). Null when there is no such workspace (never created, or deleted). For a
 * brick that acts on a workspace named in a request rather than the caller's own (a transfer's destination, an import),
 * without depending on the multi-workspace brick.
 *
 * The registry is an optional dependency: a host without the multi-workspace brick (its own workspace guard, no
 * `mw_workspaces` table) gets `{ suspended: false, checked: false }` for every id, and the caller falls back to its own
 * evidence (credit-wallet: whether the workspace has a wallet).
 */
export async function findWorkspaceState(db: D1Like, workspaceId: string): Promise<WorkspaceState | null> {
  if (!(await hasWorkspaceRegistry(db))) return { suspended: false, reason: null, deleting: false, checked: false };
  const row = await systemScope(db, "workspace state check")
    .raw("SELECT suspended, suspended_reason FROM mw_workspaces WHERE id = ?", [workspaceId])
    .first<{ suspended: number; suspended_reason: string | null }>();
  if (!row) return null;
  return { suspended: Boolean(row.suspended), reason: row.suspended ? row.suspended_reason : null, deleting: row.suspended_reason === DELETING_REASON, checked: true };
}

/** `suspended_reason` while the workspace delete (story 1.10) is fenced in. */
export const DELETING_REASON = "deleting";
/** Story 2.6: `suspended_reason` of an operator suspension. */
export const OPERATOR_SUSPENSION_REASON = "operator";

/** Story 2.6: the outcome of `setWorkspaceSuspended`. */
export type SetWorkspaceSuspendedResult =
  /** `changed: false`: already in the asked state by an operator (a no-op; the alongside statements wrote nothing). */
  | { ok: true; changed: boolean; before: { suspended: boolean; reason: string | null } }
  /**
   * `no_registry`: the database has no `mw_workspaces` (a host with its own guard). `not_found`: no such workspace (or
   * it went before the batch ran). `deleting`: a workspace delete is in progress. `other_suspension`: suspended for a
   * reason other than an operator's (any other reason, or none), which an operator neither overwrites nor lifts.
   * Nothing was written.
   */
  | { ok: false; reason: "no_registry" | "not_found" | "deleting" | "other_suspension" };

/**
 * Story 2.6: an operator suspension of a workspace, on `mw_workspaces.suspended`, the flag the assembled app's
 * suspension check (`requireNotSuspended`, story 1.10) enforces. It is the only write any brick other than
 * multi-workspace makes to the registry.
 *
 * - Suspend: a workspace that is not suspended gets `suspended = 1, suspended_reason = "operator"`. One already
 *   suspended by an operator is a no-op. One suspended for any other reason (or none) is `other_suspension`, so an
 *   operator never takes over (and later lifts) someone else's suspension. The workspace delete route (story 1.10) only
 *   retries its own `"deleting"` fence, so an operator suspension also stops the owner from deleting the workspace.
 * - Unsuspend: clears only an operator suspension. Not suspended is a no-op; any other reason is `other_suspension`.
 * - A workspace being deleted (`"deleting"`) is refused both ways.
 *
 * `alongside` takes audit statements made by `auditStatement` with `afterChange`, for this workspace (checked at run
 * time; anything else throws), or a function that builds them from the state this call read (pass one, so the audit
 * row's "before" is the state the update acted on). They run in the same D1 batch right after the update, which repeats the rule in its
 * WHERE, so an audit row commits only if the update changed the row.
 */
export async function setWorkspaceSuspended(
  db: D1Like,
  workspaceId: string,
  suspended: boolean,
  alongside: readonly AuditStatement[] | ((before: { suspended: boolean; reason: string | null }) => readonly AuditStatement[]) = [],
): Promise<SetWorkspaceSuspendedResult> {
  if (typeof suspended !== "boolean") throw new TypeError("suspended must be a boolean");
  if (typeof workspaceId !== "string" || workspaceId.length === 0 || workspaceId.length > 200) {
    throw new RangeError("workspaceId must be 1 to 200 characters");
  }
  if (typeof alongside !== "function") auditStatementsOnly(alongside, workspaceId); // a bad list throws before any read
  if (!(await hasWorkspaceRegistry(db))) return { ok: false, reason: "no_registry" };
  const state = await findWorkspaceState(db, workspaceId);
  if (!state) return { ok: false, reason: "not_found" };
  const before = { suspended: state.suspended, reason: state.reason };
  if (state.deleting) return { ok: false, reason: "deleting" };
  if (state.suspended && state.reason !== OPERATOR_SUSPENSION_REASON) return { ok: false, reason: "other_suspension" };
  if (state.suspended === suspended) return { ok: true, changed: false, before };
  // Built from the state read here, the one the guarded update below acts on, so the audit "before" matches it.
  const extra = auditStatementsOnly(typeof alongside === "function" ? alongside(before) : alongside, workspaceId);
  // The registry is a global table (its id is the workspace id), so the statements are written out here, bound by id.
  const update = suspended
    ? db.prepare("UPDATE mw_workspaces SET suspended = 1, suspended_reason = ? WHERE id = ? AND suspended = 0").bind(OPERATOR_SUSPENSION_REASON, workspaceId)
    : db
        .prepare("UPDATE mw_workspaces SET suspended = 0, suspended_reason = NULL WHERE id = ? AND suspended = 1 AND suspended_reason = ?")
        .bind(workspaceId, OPERATOR_SUSPENSION_REASON);
  const [result] = await db.batch([update, ...extra]);
  if (!result || result.meta.changes === 0) {
    // Changed by someone else between the read and the batch; nothing of ours (no audit row either) was written.
    const now = await findWorkspaceState(db, workspaceId);
    if (!now) return { ok: false, reason: "not_found" };
    if (now.deleting) return { ok: false, reason: "deleting" };
    if (now.suspended === suspended && (!now.suspended || now.reason === OPERATOR_SUSPENSION_REASON)) return { ok: true, changed: false, before };
    return { ok: false, reason: "other_suspension" };
  }
  return { ok: true, changed: true, before };
}

/** Story 2.6: one workspace as the registry stores it, for operator tools. Never any of the workspace's own data. */
export interface WorkspaceRecord {
  id: string;
  name: string;
  ownerId: string;
  suspended: boolean;
  createdAt: string;
}

/** The most workspaces `listWorkspaces` returns in one page. */
export const MAX_WORKSPACE_PAGE = 100;

interface WorkspaceRow {
  id: string;
  name: string;
  owner_id: string;
  suspended: number;
  created_at: string;
}

const toRecord = (row: WorkspaceRow): WorkspaceRecord => ({
  id: row.id,
  name: row.name,
  ownerId: row.owner_id,
  suspended: Boolean(row.suspended),
  createdAt: row.created_at,
});

/**
 * Story 2.6: one page of the workspace registry in id order, after `after` (exclusive), at most `limit` rows (1 to
 * MAX_WORKSPACE_PAGE, default 50). Null when the database has no registry.
 */
export async function listWorkspaces(
  db: D1Like,
  options: { limit?: number; after?: string } = {},
): Promise<{ workspaces: WorkspaceRecord[]; next: string | null } | null> {
  if (!(await hasWorkspaceRegistry(db))) return null;
  const limit = Math.min(MAX_WORKSPACE_PAGE, Math.max(1, Math.floor(options.limit ?? 50)));
  const rows = (
    await systemScope(db, "operator workspace listing")
      .raw("SELECT id, name, owner_id, suspended, created_at FROM mw_workspaces WHERE id > ? ORDER BY id LIMIT ?", [options.after ?? "", limit + 1])
      .all<WorkspaceRow>()
  ).results;
  const page = rows.slice(0, limit).map(toRecord);
  return { workspaces: page, next: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null };
}

/** Story 2.6: one workspace's registry row, or null when it does not exist or there is no registry. */
export async function findWorkspaceRecord(db: D1Like, workspaceId: string): Promise<WorkspaceRecord | null> {
  if (!(await hasWorkspaceRegistry(db))) return null;
  const row = await systemScope(db, "operator workspace lookup")
    .raw("SELECT id, name, owner_id, suspended, created_at FROM mw_workspaces WHERE id = ?", [workspaceId])
    .first<WorkspaceRow>();
  return row ? toRecord(row) : null;
}
