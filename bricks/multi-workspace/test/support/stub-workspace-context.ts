import type { MiddlewareHandler } from "hono";

/**
 * STUB WORKSPACE CONTEXT, for tests only. Stands in for `workspaceMiddleware` (whose membership check is proved in
 * H5.workspace-middleware.test.ts) so a brick's route tests do not need the multi-workspace tables. Like the real
 * middleware it reads the `x-workspace-id` header only, never a `workspaceId` query or body field, and sets a frozen
 * `ctx` plus the older `workspace` variable. It trusts the header without a membership check, which a real project
 * must never do. Nothing in bricks/*\/src imports this file.
 *
 * `x-test-user` names the user (default `test-user`); `x-test-role` the role (default `owner`).
 */
export const stubWorkspaceContext: MiddlewareHandler = async (c, next) => {
  const workspaceId = c.req.header("x-workspace-id");
  if (workspaceId) {
    const userId = c.req.header("x-test-user") ?? "test-user";
    const role = c.req.header("x-test-role") ?? "owner";
    c.set("workspace", { id: workspaceId, role, suspended: false });
    c.set("ctx", Object.freeze({ userId, workspaceId, role }));
  }
  return await next();
};
