import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AuthUser, D1Like, RequestContext } from "@poc/sdk";
import { WORKSPACE_ADMIN_ROLES, isApiKeyRequest, systemScope } from "@poc/sdk";

export type { AuthUser, RequestContext };

export type WorkspaceRole = "owner" | "admin" | "member";

/** The workspace a request was resolved to, set by `workspaceMiddleware` for the handlers after it. */
export interface WorkspaceContext {
  id: string;
  role: WorkspaceRole;
  suspended: boolean;
}

/** The Hono environment the brick's middleware and routes expect. */
export interface WorkspaceEnv {
  Bindings: { DB: D1Like };
  Variables: { user?: AuthUser; workspace?: WorkspaceContext; ctx?: RequestContext };
}

/** Owner or admin. Uses the SDK's `WORKSPACE_ADMIN_ROLES`, the one definition every brick's role checks share. */
export function isAdminOrOwner(role: WorkspaceRole): boolean {
  return WORKSPACE_ADMIN_ROLES.includes(role);
}

// A workspace id arrives from the caller, so it is checked before it reaches a query. It is still only ever bound
// as a parameter, never joined into SQL text.
const WorkspaceIdSchema = z.string().min(1).max(200);

/** What a caller is told when something goes wrong inside; the cause goes to the log, never to the caller. */
const INTERNAL = { error: "Internal error" } as const;

/**
 * Resolves the caller's workspace from the `x-workspace-id` header only and refuses anyone who is not a member. A
 * `workspaceId` in the query or body is never read here, so it cannot override the header. The caller's role comes
 * from the database row, never from anything the caller sent. Sets a frozen `ctx` (and the older `workspace`
 * variable) for the handlers after it. Needs `user` to be set by an earlier middleware.
 */
export const workspaceMiddleware: MiddlewareHandler<WorkspaceEnv> = async (c, next) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  // Story 1.11: an API-key identity step (and only it sets the `authenticatedBy` marker) already set a verified,
  // workspace-bound ctx: the key's own workspace and role, so there is no membership to look up. The header is optional;
  // naming any other workspace is refused. The suspension state is still read here, so `requireNotSuspended` applies to
  // keys as to people. Any other caller, whatever its user id looks like, goes through the membership check below.
  const bound = c.get("ctx");
  if (isApiKeyRequest(c) && bound && bound.userId === user.uid) {
    const named = c.req.header("x-workspace-id");
    if (named !== undefined && named !== bound.workspaceId) {
      return c.json({ error: "This API key belongs to another workspace", code: "WORKSPACE_MISMATCH" }, 403);
    }
    try {
      const row = await systemScope(c.env.DB, "workspace middleware api-key workspace check")
        .raw("SELECT suspended FROM mw_workspaces WHERE id = ?", [bound.workspaceId])
        .first<{ suspended: number }>();
      if (!row) return c.json({ error: "Not a member of this workspace" }, 403);
      c.set("workspace", { id: bound.workspaceId, role: bound.role as WorkspaceRole, suspended: Boolean(row.suspended) });
      return await next();
    } catch (error) {
      console.error("workspaceMiddleware:", error);
      return c.json(INTERNAL, 500);
    }
  }

  const requested = WorkspaceIdSchema.safeParse(c.req.header("x-workspace-id"));
  if (!requested.success) return c.json({ error: "Missing workspace context" }, 400);
  const workspaceId = requested.data;

  try {
    const member = await systemScope(c.env.DB, "workspace middleware membership check")
      .raw(
        "SELECT m.role AS role, w.suspended AS suspended FROM mw_members m JOIN mw_workspaces w ON m.workspace_id = w.id WHERE m.workspace_id = ? AND m.user_id = ?",
        [workspaceId, user.uid],
      )
      .first<{ role: WorkspaceRole; suspended: number }>();
    if (!member) return c.json({ error: "Not a member of this workspace" }, 403);

    c.set("workspace", { id: workspaceId, role: member.role, suspended: Boolean(member.suspended) });
    // A membership row matched `user.uid`, so it is a string here.
    c.set("ctx", Object.freeze<RequestContext>({ userId: user.uid as string, workspaceId, role: member.role }));
    return await next();
  } catch (error) {
    console.error("workspaceMiddleware:", error);
    return c.json(INTERNAL, 500);
  }
};

/**
 * Blocks paid features on a suspended workspace. Kept separate from `workspaceMiddleware` on purpose (as in cephlow):
 * payment routes must still work for a suspended workspace, otherwise money already charged could get stuck uncredited.
 */
export const requireNotSuspended: MiddlewareHandler<WorkspaceEnv> = async (c, next) => {
  const workspace = c.get("workspace");
  if (!workspace) return c.json({ error: "Missing workspace context" }, 400);
  if (workspace.suspended) return c.json({ error: "Workspace suspended", code: "WORKSPACE_SUSPENDED" }, 403);
  return await next();
};

/** The verified request context set by `workspaceMiddleware`, or undefined when it did not run for this route. */
export function getRequestContext(c: Context<WorkspaceEnv>): RequestContext | undefined {
  return c.get("ctx");
}

/**
 * The verified workspace id for a handler. Returns a 400 `Missing workspace context` response instead when the
 * middleware did not run, so a handler can never fall back to a workspace named by the caller.
 */
export function requireWorkspaceId(c: Context<WorkspaceEnv>): { workspaceId: string } | { failure: Response } {
  const ctx = c.get("ctx");
  if (!ctx) return { failure: c.json({ error: "Missing workspace context" }, 400) };
  return { workspaceId: ctx.workspaceId };
}
