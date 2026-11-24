import type { Context } from "hono";
import type { RequestContext } from "@poc/sdk";

/**
 * For the few routes whose callers may still name a workspace (whole-workspace admin routes such as erase/export or
 * impersonation): refuses with 403 when the query string or the body names a workspace other than the verified one.
 * The named id is only ever compared, never used; the route always acts on `ctx.workspaceId`. Returns a 400 when the
 * workspace middleware did not run, and undefined when the request may go on.
 *
 * This is the one place in bricks/*\/src allowed to read a client workspace id (see scripts/lint-workspace-id-source.ts).
 */
export function rejectForeignWorkspace(c: Context<any>, body?: unknown): Response | undefined {
  const ctx = c.get("ctx") as RequestContext | undefined;
  if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
  const fromQuery = c.req.query("workspaceId");
  const fromBody = body !== null && typeof body === "object" ? (body as { workspaceId?: unknown }).workspaceId : undefined;
  for (const named of [fromQuery, fromBody]) {
    if (named !== undefined && named !== ctx.workspaceId) return c.json({ error: "Forbidden: workspace mismatch" }, 403);
  }
  return undefined;
}
