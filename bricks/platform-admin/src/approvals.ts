import type { MiddlewareHandler } from "hono";
import type { AuthUser, D1Like, D1Statement } from "@poc/sdk";
import { apiKeyCreatorId, authUserId, isApiKeyRequest, isPlatformOperator } from "@poc/sdk";

// The opt-in user approval gate (story 2.6). `pa_user_approvals` is this brick's own platform-wide table (one row per
// person, no workspace), so every query here is written out and bound by user id.

export type ApprovalStatus = "pending" | "approved" | "rejected";
export const APPROVAL_STATUSES: readonly ApprovalStatus[] = ["pending", "approved", "rejected"];

export interface UserApproval {
  userId: string;
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
  createdAt: string;
}

interface ApprovalRow {
  user_id: string;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
  created_at: string;
}

const toApproval = (row: ApprovalRow): UserApproval => ({
  userId: row.user_id,
  status: row.status,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  reason: row.reason,
  createdAt: row.created_at,
});

/** The most rows `listApprovals` returns in one page. */
export const MAX_APPROVAL_PAGE = 100;

export async function findApproval(db: D1Like, userId: string): Promise<UserApproval | null> {
  const row = await db
    .prepare("SELECT user_id, status, decided_by, decided_at, reason, created_at FROM pa_user_approvals WHERE user_id = ?")
    .bind(userId)
    .first<ApprovalRow>();
  return row ? toApproval(row) : null;
}

/** One page of approvals with `status`, in user id order after `after` (exclusive), at most MAX_APPROVAL_PAGE rows. */
export async function listApprovals(
  db: D1Like,
  status: ApprovalStatus,
  options: { limit?: number; after?: string } = {},
): Promise<{ users: UserApproval[]; next: string | null }> {
  const limit = Math.min(MAX_APPROVAL_PAGE, Math.max(1, Math.floor(options.limit ?? 50)));
  const rows = (
    await db
      .prepare(
        "SELECT user_id, status, decided_by, decided_at, reason, created_at FROM pa_user_approvals WHERE status = ? AND user_id > ? ORDER BY user_id LIMIT ?",
      )
      .bind(status, options.after ?? "", limit + 1)
      .all<ApprovalRow>()
  ).results;
  const users = rows.slice(0, limit).map(toApproval);
  return { users, next: rows.length > limit ? (users[users.length - 1]?.userId ?? null) : null };
}

/**
 * The write recording an operator's decision, to run in one batch with its audit row (made with `afterChange`). It is
 * guarded by the status read before (`before`, null when the user has no row): if the row changed meanwhile it writes
 * nothing, and neither does the audit row after it.
 */
export function decisionStatement(
  db: D1Like,
  userId: string,
  status: "approved" | "rejected",
  operatorId: string,
  reason: string,
  before: ApprovalStatus | null,
): D1Statement {
  const now = new Date().toISOString();
  if (before === null) {
    return db
      .prepare(
        "INSERT INTO pa_user_approvals (user_id, status, decided_by, decided_at, reason) SELECT ?, ?, ?, ?, ? " +
          "WHERE NOT EXISTS (SELECT 1 FROM pa_user_approvals WHERE user_id = ?) ON CONFLICT (user_id) DO NOTHING",
      )
      .bind(userId, status, operatorId, now, reason, userId);
  }
  return db
    .prepare("UPDATE pa_user_approvals SET status = ?, decided_by = ?, decided_at = ?, reason = ? WHERE user_id = ? AND status = ?")
    .bind(status, operatorId, now, reason, userId, before);
}

/**
 * The caller's approval status. A user the gate has never seen gets a pending row now (their first signed-in request
 * after the gate was turned on), so operators find them in the pending list.
 */
export async function approvalStatusFor(db: D1Like, userId: string): Promise<ApprovalStatus> {
  const existing = await findApproval(db, userId);
  if (existing) return existing.status;
  await db.prepare("INSERT INTO pa_user_approvals (user_id, status) VALUES (?, 'pending') ON CONFLICT (user_id) DO NOTHING").bind(userId).run();
  return (await findApproval(db, userId))?.status ?? "pending";
}

interface GateEnv {
  Bindings: { DB: D1Like };
  Variables: { user?: AuthUser };
}

/**
 * The approval gate the assembler mounts on every workspace-guarded path (after the identity steps, before the workspace
 * guard) while the `requireUserApproval` setting is true. A signed-in user who is not approved gets 403
 * USER_NOT_APPROVED. Passed through unchanged:
 * - a request with no signed-in user (the guard after this one answers 401);
 * - a platform operator (`PX_PLATFORM_OPERATORS`): operators exempt themselves, or nobody could approve anyone.
 * A request authenticated by an API key is judged by the key's creator (the person the key acts for): a key whose
 * creator is not approved gets 403 USER_NOT_APPROVED, and so does a key whose creator is not known (fail closed).
 * A database failure refuses the request (500), never lets it through.
 */
export const requireApprovedUser: MiddlewareHandler<GateEnv> = async (c, next) => {
  const viaKey = isApiKeyRequest(c);
  const userId = viaKey ? apiKeyCreatorId(c) : authUserId(c.get("user"));
  if (!userId) {
    if (viaKey) return c.json({ error: "This API key's creator has not been approved", code: "USER_NOT_APPROVED" }, 403);
    return await next();
  }
  if (isPlatformOperator(c.env, userId)) return await next();
  let status: ApprovalStatus;
  try {
    status = await approvalStatusFor(c.env.DB, userId);
  } catch (error) {
    console.error("requireApprovedUser:", error instanceof Error ? error.message : error);
    return c.json({ error: "Internal error" }, 500);
  }
  if (status !== "approved") {
    return c.json({ error: "This account has not been approved yet", code: "USER_NOT_APPROVED", status }, 403);
  }
  return await next();
};
