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
  if (!(await hasWorkspaceRegistry(db))) return { suspended: false, checked: false };
  const row = await systemScope(db, "workspace state check")
    .raw("SELECT suspended FROM mw_workspaces WHERE id = ?", [workspaceId])
    .first<{ suspended: number }>();
  return row ? { suspended: Boolean(row.suspended), checked: true } : null;
}
