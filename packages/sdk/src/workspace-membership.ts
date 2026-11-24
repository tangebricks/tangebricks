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
