import { Hono } from "hono";
import { z } from "zod";
import { global, scoped, systemScope } from "@poc/sdk";
import type { WorkspaceEnv, WorkspaceRole } from "./middleware.ts";

const CreateWorkspaceSchema = z.object({ name: z.string().trim().min(1).max(100) });
const InviteSchema = z.object({ role: z.enum(["owner", "admin", "member"]).default("member") });

const err = (code: string, message: string) => ({ error: { code, message } });

/**
 * Workspace routes. They expect `user` to have been set by the host's auth middleware, and answer 401 if it was not.
 * Every query is parameterised and either filters by the caller's own user id or by a workspace the caller was
 * resolved into, so one tenant cannot list or touch another's workspaces.
 */
export function createWorkspaceRoutes(): Hono<WorkspaceEnv> {
  const router = new Hono<WorkspaceEnv>();

  // List the workspaces the caller belongs to.
  router.get("/workspaces", async (c) => {
    const user = c.get("user");
    if (!user) return c.json(err("UNAUTHORIZED", "Unauthorized"), 401);
    try {
      // The caller's own memberships in every workspace they belong to: this route lists workspaces, so it runs before
      // any one workspace is chosen. Bound to the caller's user_id.
      // tenant-lint: allow lists the caller's own memberships across workspaces before one is selected
      const { results } = await systemScope(c.env.DB, "user workspace listing across tenants")
        .raw(
          "SELECT m.role AS role, w.id AS id, w.name AS name, w.owner_id AS owner_id, w.suspended AS suspended, w.created_at AS created_at " +
            "FROM mw_members m JOIN mw_workspaces w ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at, w.id",
          [user.uid],
        )
        .all<{ role: WorkspaceRole; id: string; name: string; owner_id: string; suspended: number; created_at: string }>();
      return c.json({
        workspaces: results.map((row) => ({
          id: row.id,
          name: row.name,
          ownerId: row.owner_id,
          suspended: Boolean(row.suspended),
          createdAt: row.created_at,
          role: row.role,
        })),
      });
    } catch (error) {
      console.error("GET /workspaces:", error);
      return c.json({ error: "Internal error" }, 500);
    }
  });

  // Create a workspace and make the caller its owner, in one batch: both rows or neither.
  router.post("/workspaces", async (c) => {
    const user = c.get("user");
    if (!user) return c.json(err("UNAUTHORIZED", "Unauthorized"), 401);
    const body = CreateWorkspaceSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json(err("VALIDATION_ERROR", "Name required (1 to 100 characters)"), 400);
    const id = crypto.randomUUID();
    try {
      await c.env.DB.batch([
        c.env.DB.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES (?, ?, ?)").bind(id, body.data.name, user.uid),
        c.env.DB.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").bind(id, user.uid),
      ]);
      return c.json({ workspace: { id, name: body.data.name, ownerId: user.uid, suspended: false, role: "owner" as const } }, 201);
    } catch (error) {
      console.error("POST /workspaces:", error);
      return c.json({ error: "Internal error" }, 500);
    }
  });

  // Accept single-use invite token (mounted under /workspaces to comply with routePrefixes)
  router.post("/workspaces/invites/:token/accept", async (c) => {
    const user = c.get("user");
    if (!user) return c.json(err("UNAUTHORIZED", "Unauthorized"), 401);
    const token = c.req.param("token");

    try {
      // tenant-lint: allow the invitee is not yet a member, so the invite is found by its unguessable single-use token
      const invite = await systemScope(c.env.DB, "invite token lookup")
        .raw("SELECT token, workspace_id, role, used FROM mw_invites WHERE token = ?", [token])
        .first<{ token: string; workspace_id: string; role: WorkspaceRole; used: number }>();
      if (!invite) return c.json(err("NOT_FOUND", "Invite not found"), 404);
      if (invite.used) return c.json(err("INVITE_ALREADY_USED", "Invite token has already been used"), 409);

      await c.env.DB.batch([
        // tenant-lint: allow consumes the same single-use token just looked up, before the invitee is a member
        c.env.DB.prepare("UPDATE mw_invites SET used = 1, used_by = ? WHERE token = ? AND used = 0").bind(user.uid, token),
        c.env.DB.prepare("INSERT OR REPLACE INTO mw_members (workspace_id, user_id, role) VALUES (?, ?, ?)").bind(invite.workspace_id, user.uid, invite.role),
      ]);

      return c.json({ workspaceId: invite.workspace_id, role: invite.role });
    } catch (error) {
      console.error("POST /workspaces/invites/:token/accept:", error);
      return c.json({ error: "Internal error" }, 500);
    }
  });

  // Workspace-scoped detail route: returns 404 (not 403) for non-members to prevent workspace existence leakage.
  router.get("/workspaces/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json(err("UNAUTHORIZED", "Unauthorized"), 401);
    const workspaceId = c.req.param("id");
    try {
      const row = await systemScope(c.env.DB, "workspace detail check")
        .raw(
          "SELECT m.role AS role, w.id AS id, w.name AS name, w.owner_id AS owner_id, w.suspended AS suspended, w.created_at AS created_at " +
            "FROM mw_members m JOIN mw_workspaces w ON m.workspace_id = w.id WHERE m.workspace_id = ? AND m.user_id = ?",
          [workspaceId, user.uid],
        )
        .first<{ role: WorkspaceRole; id: string; name: string; owner_id: string; suspended: number; created_at: string }>();
      if (!row) {
        return c.json(err("NOT_FOUND", "Workspace not found"), 404);
      }
      return c.json({
        workspace: {
          id: row.id,
          name: row.name,
          ownerId: row.owner_id,
          suspended: Boolean(row.suspended),
          createdAt: row.created_at,
          role: row.role,
        },
      });
    } catch (error) {
      console.error("GET /workspaces/:id:", error);
      return c.json({ error: "Internal error" }, 500);
    }
  });

  // Delete workspace: cascading deletion to members; refuses non-owners with 403 (or 404 if non-member).
  router.delete("/workspaces/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json(err("UNAUTHORIZED", "Unauthorized"), 401);
    const workspaceId = c.req.param("id");
    try {
      const membership = await systemScope(c.env.DB, "workspace delete role check")
        .raw("SELECT role FROM mw_members WHERE workspace_id = ? AND user_id = ?", [workspaceId, user.uid])
        .first<{ role: WorkspaceRole }>();
      if (!membership) {
        return c.json(err("NOT_FOUND", "Workspace not found"), 404);
      }
      if (membership.role !== "owner") {
        return c.json(err("FORBIDDEN", "Only workspace owner can delete workspace"), 403);
      }

      await c.env.DB.batch([
        c.env.DB.prepare("DELETE FROM mw_invites WHERE workspace_id = ?").bind(workspaceId),
        c.env.DB.prepare("DELETE FROM mw_members WHERE workspace_id = ?").bind(workspaceId),
        c.env.DB.prepare("DELETE FROM mw_workspaces WHERE id = ?").bind(workspaceId),
      ]);

      return c.json({ deleted: true, id: workspaceId });
    } catch (error) {
      console.error("DELETE /workspaces/:id:", error);
      return c.json({ error: "Internal error" }, 500);
    }
  });

  // Create single-use invite token (owner/admin only)
  router.post("/workspaces/:id/invites", async (c) => {
    const user = c.get("user");
    if (!user) return c.json(err("UNAUTHORIZED", "Unauthorized"), 401);
    const workspaceId = c.req.param("id");
    const body = InviteSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json(err("VALIDATION_ERROR", "Invalid invite parameters"), 400);

    try {
      const membership = await systemScope(c.env.DB, "workspace invite permission check")
        .raw("SELECT role FROM mw_members WHERE workspace_id = ? AND user_id = ?", [workspaceId, user.uid])
        .first<{ role: WorkspaceRole }>();
      if (!membership) return c.json(err("NOT_FOUND", "Workspace not found"), 404);
      if (membership.role !== "owner" && membership.role !== "admin") {
        return c.json(err("FORBIDDEN", "Only owner or admin can create invites"), 403);
      }

      const token = `inv_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await c.env.DB.prepare(
        "INSERT INTO mw_invites (token, workspace_id, role, created_by) VALUES (?, ?, ?, ?)"
      ).bind(token, workspaceId, body.data.role, user.uid).run();

      return c.json({ token, workspaceId, role: body.data.role }, 201);
    } catch (error) {
      console.error("POST /workspaces/:id/invites:", error);
      return c.json({ error: "Internal error" }, 500);
    }
  });

  // Remove a member: revokes access immediately
  router.delete("/workspaces/:id/members/:userId", async (c) => {
    const user = c.get("user");
    if (!user) return c.json(err("UNAUTHORIZED", "Unauthorized"), 401);
    const workspaceId = c.req.param("id");
    const targetUserId = c.req.param("userId");

    try {
      const callerMembership = await systemScope(c.env.DB, "member removal permission check")
        .raw("SELECT role FROM mw_members WHERE workspace_id = ? AND user_id = ?", [workspaceId, user.uid])
        .first<{ role: WorkspaceRole }>();
      if (!callerMembership) return c.json(err("NOT_FOUND", "Workspace not found"), 404);
      if (callerMembership.role !== "owner" && callerMembership.role !== "admin" && user.uid !== targetUserId) {
        return c.json(err("FORBIDDEN", "Insufficient permissions to remove member"), 403);
      }

      await c.env.DB.prepare("DELETE FROM mw_members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, targetUserId).run();
      return c.json({ removed: true, userId: targetUserId });
    } catch (error) {
      console.error("DELETE /workspaces/:id/members/:userId:", error);
      return c.json({ error: "Internal error" }, 500);
    }
  });

  return router;
}
