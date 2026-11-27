import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { refuseApiKeyCaller, systemScope } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import type { AuthUser, WorkspaceEnv, WorkspaceRole } from "./middleware.ts";

const CreateWorkspaceSchema = z.object({ name: z.string().trim().min(1).max(100) });
/** The longest an invite may live: 90 days. */
const MAX_INVITE_TTL_SECONDS = 90 * 24 * 60 * 60;
/** The shortest an invite may live: one minute. */
const MIN_INVITE_TTL_SECONDS = 60;
const InviteSchema = z.object({
  role: z.enum(["owner", "admin", "member"]).default("member"),
  // Optional: an emailed invite can be accepted only by a caller whose verified email matches (case-insensitively).
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()).optional(),
  // Optional: without it the invite never expires (as before).
  expiresInSeconds: z.number().int().min(MIN_INVITE_TTL_SECONDS).max(MAX_INVITE_TTL_SECONDS).optional(),
});
const SetRoleSchema = z.object({ role: z.enum(["owner", "admin", "member"]) });

const err = (code: string, message: string) => ({ error: { code, message } });

/** The same answer `requireNotSuspended` gives (story 1.10). */
const SUSPENDED = { error: "Workspace suspended", code: "WORKSPACE_SUSPENDED" } as const;

/** A workspace id the delete route accepts: one plain path segment, so it can never widen an object-store prefix. */
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `suspended_reason` while a delete is in progress (story 1.10): the fence that lets only the delete itself retry. */
const DELETING = "deleting";

/** Role order for invites and member removal. */
const ROLE_RANK: Record<WorkspaceRole, number> = { member: 1, admin: 2, owner: 3 };

/** One invite row as the routes read it. `email` and `expires_at` (ISO-8601, UTC) are null for an open, endless invite. */
interface InviteRow {
  token: string;
  workspace_id: string;
  role: WorkspaceRole;
  email: string | null;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
}

/** The caller's user id: `uid`, or `id` for identity middleware that sets only that. */
function callerId(user: AuthUser | undefined): string | undefined {
  const id = user?.uid ?? user?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** The caller's verified email, lower-cased, or "" when the identity step set none. */
function callerEmail(user: AuthUser): string {
  return typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
}

/** Whether an invite's `expires_at` has passed. Null never expires; a value that does not parse counts as expired. */
function isExpired(expiresAt: string | null | undefined, now = Date.now()): boolean {
  if (expiresAt === null || expiresAt === undefined || expiresAt === "") return false;
  const at = Date.parse(expiresAt);
  return !Number.isFinite(at) || at <= now;
}

/** The caller's role in a workspace and whether it is suspended, or null for a non-member (or no such workspace). */
async function membershipOf(db: D1Like, workspaceId: string, userId: string | undefined, reason: string) {
  if (!userId) return null;
  return systemScope(db, reason)
    .raw(
      "SELECT m.role AS role, w.suspended AS suspended FROM mw_members m JOIN mw_workspaces w ON m.workspace_id = w.id WHERE m.workspace_id = ? AND m.user_id = ?",
      [workspaceId, userId],
    )
    .first<{ role: WorkspaceRole; suspended: number }>();
}

export interface WorkspaceRoutesOptions {
  /**
   * Story 1.10: removes a workspace's data from every other brick (rows, and objects under declared prefixes). The
   * assembled app wires its generated `purgeWorkspaceData` here. The delete route awaits it before deleting its own
   * rows. Without it (this brick used standalone) a delete removes only this brick's rows, as before.
   */
  workspaceDataPurge?: (env: { DB: D1Like }, workspaceId: string) => Promise<void>;
}

/**
 * Workspace routes. They expect `user` to have been set by the host's auth middleware, and answer 401 if it was not.
 * Every query is parameterised and either filters by the caller's own user id or by a workspace the caller was
 * resolved into, so one tenant cannot list or touch another's workspaces.
 */
export function createWorkspaceRoutes(options: WorkspaceRoutesOptions = {}): Hono<WorkspaceEnv> {
  const router = new Hono<WorkspaceEnv>();

  // Story 1.11: an API key is bound to the one workspace it was made in, and acts only through workspace routes. It can
  // never create, join, list, manage or delete workspaces.
  const refuseApiKey: MiddlewareHandler<WorkspaceEnv> = async (c, next) => refuseApiKeyCaller(c) ?? (await next());
  router.use("/workspaces", refuseApiKey);
  router.use("/workspaces/*", refuseApiKey);

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
    const uid = callerId(user);
    if (!user || !uid) return c.json(err("UNAUTHORIZED", "Unauthorized"), 401);
    const token = c.req.param("token");

    try {
      // tenant-lint: allow the invitee is not yet a member, so the invite is found by its unguessable single-use token
      const invite = await systemScope(c.env.DB, "invite token lookup")
        .raw(
          "SELECT i.token AS token, i.workspace_id AS workspace_id, i.role AS role, i.used AS used, i.created_by AS created_by, " +
            "i.email AS email, i.expires_at AS expires_at, w.suspended AS suspended FROM mw_invites i JOIN mw_workspaces w ON i.workspace_id = w.id WHERE i.token = ?",
          [token],
        )
        .first<InviteRow & { used: number; suspended: number }>();
      if (!invite) return c.json(err("NOT_FOUND", "Invite not found"), 404);
      if (invite.used) return c.json(err("INVITE_ALREADY_USED", "Invite token has already been used"), 409);
      if (invite.suspended) return c.json(SUSPENDED, 403);
      if (isExpired(invite.expires_at)) return c.json(err("INVITE_EXPIRED", "Invite has expired"), 410);
      // An emailed invite is for that address only: the caller's verified email must match, ignoring case.
      if (invite.email && invite.email.toLowerCase() !== callerEmail(user)) {
        return c.json(err("INVITE_EMAIL_MISMATCH", "This invite was sent to another email address"), 403);
      }

      // An existing member cannot accept (it would change their own role); the invite stays open.
      const existing = await systemScope(c.env.DB, "invite accept existing membership")
        .raw("SELECT role FROM mw_members WHERE workspace_id = ? AND user_id = ?", [invite.workspace_id, uid])
        .first<{ role: WorkspaceRole }>();
      if (existing) return c.json(err("ALREADY_MEMBER", "Already a member of this workspace"), 409);

      // Story 1.10: the inviter must still be a member at or above the invite's role; otherwise the invite is revoked
      // (and not consumed).
      const inviter = invite.created_by
        ? await systemScope(c.env.DB, "invite accept inviter check")
            .raw("SELECT role FROM mw_members WHERE workspace_id = ? AND user_id = ?", [invite.workspace_id, invite.created_by])
            .first<{ role: WorkspaceRole }>()
        : null;
      if (!inviter || ROLE_RANK[inviter.role] < ROLE_RANK[invite.role]) {
        return c.json(err("INVITE_REVOKED", "The inviter can no longer grant this invite"), 403);
      }

      // One atomic batch: the invite is claimed for this caller only while it is still unused, and the membership is
      // inserted only when the claim is this caller's and they are not a member yet. So two concurrent accepts of one
      // token give exactly one member, and an accept never changes an existing member's role. The outcome is read
      // back afterwards instead of taken from change counts, so the same SQL works when mw_* are views over an app's
      // own tables (a write an INSTEAD OF trigger carries out reports no changes in plain SQLite, and the trigger's own
      // writes in D1).
      await c.env.DB.batch([
        // tenant-lint: allow consumes the same single-use token just looked up, before the invitee is a member
        c.env.DB.prepare("UPDATE mw_invites SET used = 1, used_by = ? WHERE token = ? AND used = 0").bind(uid, token),
        c.env.DB.prepare(
          "INSERT INTO mw_members (workspace_id, user_id, role) SELECT ?, ?, ? " +
            "WHERE EXISTS (SELECT 1 FROM mw_invites WHERE token = ? AND workspace_id = ? AND used = 1 AND used_by = ?) " +
            "AND NOT EXISTS (SELECT 1 FROM mw_members WHERE workspace_id = ? AND user_id = ?)",
        ).bind(invite.workspace_id, uid, invite.role, token, invite.workspace_id, uid, invite.workspace_id, uid),
      ]);
      // tenant-lint: allow reads back the claim on the same single-use token
      const claimed = await systemScope(c.env.DB, "invite accept claim check")
        .raw("SELECT used_by FROM mw_invites WHERE token = ?", [token])
        .first<{ used_by: string | null }>();
      const joined = await systemScope(c.env.DB, "invite accept membership check")
        .raw("SELECT role FROM mw_members WHERE workspace_id = ? AND user_id = ?", [invite.workspace_id, uid])
        .first<{ role: WorkspaceRole }>();
      if (claimed?.used_by !== uid || !joined) return c.json(err("INVITE_ALREADY_USED", "Invite token has already been used"), 409);

      return c.json({ workspaceId: invite.workspace_id, role: joined.role });
    } catch (error) {
      console.error("POST /workspaces/invites/:token/accept:", error);
      return c.json({ error: "Internal error" }, 500);
    }
  });

  // The pending, unexpired invites addressed to the caller's verified email, across workspaces (the caller is not yet
  // a member of them). Mounted under /workspaces to comply with routePrefixes (`/me` belongs to another brick).
  router.get("/workspaces/invites/mine", async (c) => {
    const user = c.get("user");
    if (!user || !callerId(user)) return c.json(err("UNAUTHORIZED", "Unauthorized"), 401);
    const email = callerEmail(user);
    if (!email) return c.json({ invites: [] });
    try {
      // tenant-lint: allow the caller is not yet a member of the inviting workspaces; bound to the caller's own email
      const { results } = await systemScope(c.env.DB, "invites addressed to the caller")
        .raw(
          "SELECT i.token AS token, i.workspace_id AS workspace_id, i.role AS role, i.email AS email, i.created_by AS created_by, " +
            "i.created_at AS created_at, i.expires_at AS expires_at, w.name AS workspace_name " +
            "FROM mw_invites i JOIN mw_workspaces w ON i.workspace_id = w.id WHERE lower(i.email) = ? AND i.used = 0 ORDER BY i.created_at, i.token",
          [email],
        )
        .all<InviteRow & { workspace_name: string }>();
      return c.json({
        invites: results
          .filter((row) => !isExpired(row.expires_at))
          .map((row) => ({
            token: row.token,
            role: row.role,
            email: row.email,
            createdAt: row.created_at,
            expiresAt: row.expires_at ?? null,
            workspace: { id: row.workspace_id, name: row.workspace_name },
          })),
      });
    } catch (error) {
      console.error("GET /workspaces/invites/mine:", error);
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

  // Delete workspace: refuses an id that is not one plain segment with 400, non-owners with 403 (or 404 if non-member),
  // and a suspended workspace with 403 WORKSPACE_SUSPENDED. It first marks the workspace suspended (reason "deleting"),
  // so no new request for it is served while the purge runs. In an assembled app, `options.workspaceDataPurge` then
  // removes every other brick's data for this workspace: declared object prefixes, then the rows in batches of at most
  // 25 statements. This brick's own rows (invites, members, the workspace) go last, in one batch. Every purge statement
  // is an idempotent DELETE or UPDATE, so if any step fails the workspace is still in place, still fenced, and the owner
  // can retry the delete. Background jobs already in flight are not fenced; once the delete completes the workspace has
  // no membership, so nothing can act for it. Standalone (no hook), other bricks' rows are left.
  router.delete("/workspaces/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json(err("UNAUTHORIZED", "Unauthorized"), 401);
    const workspaceId = c.req.param("id");
    // Story 1.10: the id names an object-store prefix in the purge, so it must be one plain segment.
    if (!WORKSPACE_ID.test(workspaceId)) return c.json(err("VALIDATION_ERROR", "Invalid workspace id"), 400);
    try {
      const membership = await systemScope(c.env.DB, "workspace delete role check")
        .raw(
          "SELECT m.role AS role, w.suspended AS suspended, w.suspended_reason AS suspended_reason FROM mw_members m JOIN mw_workspaces w ON m.workspace_id = w.id WHERE m.workspace_id = ? AND m.user_id = ?",
          [workspaceId, user.uid],
        )
        .first<{ role: WorkspaceRole; suspended: number; suspended_reason: string | null }>();
      if (!membership) {
        return c.json(err("NOT_FOUND", "Workspace not found"), 404);
      }
      // A workspace suspended by a delete that failed part-way may be deleted again (the retry); any other suspension
      // refuses.
      if (membership.suspended && membership.suspended_reason !== DELETING) return c.json(SUSPENDED, 403);
      if (membership.role !== "owner") {
        return c.json(err("FORBIDDEN", "Only workspace owner can delete workspace"), 403);
      }

      // The fence: from here on the suspension checks refuse every new request for this workspace. Story 2.6: it applies
      // only while the workspace is still unsuspended (or already fenced by an earlier delete), so a suspension that
      // lands between the check above and here (an operator's) is never overwritten: the delete is refused as above.
      await c.env.DB.prepare("UPDATE mw_workspaces SET suspended = 1, suspended_reason = ? WHERE id = ? AND (suspended = 0 OR suspended_reason = ?)")
        .bind(DELETING, workspaceId, DELETING)
        .run();
      // Read back rather than trusting the change count, so this works through views too (see the accept route).
      const fence = await systemScope(c.env.DB, "workspace delete fence check")
        .raw("SELECT suspended, suspended_reason FROM mw_workspaces WHERE id = ?", [workspaceId])
        .first<{ suspended: number; suspended_reason: string | null }>();
      if (!fence || !fence.suspended || fence.suspended_reason !== DELETING) return c.json(SUSPENDED, 403);
      if (options.workspaceDataPurge) await options.workspaceDataPurge(c.env, workspaceId);
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

  // Create single-use invite token (owner/admin only, at a role at or below the inviter's)
  router.post("/workspaces/:id/invites", async (c) => {
    const user = c.get("user");
    if (!user) return c.json(err("UNAUTHORIZED", "Unauthorized"), 401);
    const workspaceId = c.req.param("id");
    const body = InviteSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json(err("VALIDATION_ERROR", "Invalid invite parameters"), 400);

    try {
      const membership = await systemScope(c.env.DB, "workspace invite permission check")
        .raw(
          "SELECT m.role AS role, w.suspended AS suspended FROM mw_members m JOIN mw_workspaces w ON m.workspace_id = w.id WHERE m.workspace_id = ? AND m.user_id = ?",
          [workspaceId, user.uid],
        )
        .first<{ role: WorkspaceRole; suspended: number }>();
      if (!membership) return c.json(err("NOT_FOUND", "Workspace not found"), 404);
      if (membership.suspended) return c.json(SUSPENDED, 403);
      if (membership.role !== "owner" && membership.role !== "admin") {
        return c.json(err("FORBIDDEN", "Only owner or admin can create invites"), 403);
      }
      // Story 1.10: no invite above the inviter's own role (an admin cannot mint an owner invite).
      if (ROLE_RANK[body.data.role] > ROLE_RANK[membership.role]) {
        return c.json(err("FORBIDDEN", "Cannot invite at a role above your own"), 403);
      }

      const token = `inv_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const email = body.data.email ?? null;
      const expiresAt = body.data.expiresInSeconds === undefined ? null : new Date(Date.now() + body.data.expiresInSeconds * 1000).toISOString();
      await c.env.DB.prepare("INSERT INTO mw_invites (token, workspace_id, role, created_by, email, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(token, workspaceId, body.data.role, user.uid, email, expiresAt)
        .run();

      return c.json({ token, workspaceId, role: body.data.role, email, expiresAt }, 201);
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
        .raw(
          "SELECT m.role AS role, w.suspended AS suspended FROM mw_members m JOIN mw_workspaces w ON m.workspace_id = w.id WHERE m.workspace_id = ? AND m.user_id = ?",
          [workspaceId, user.uid],
        )
        .first<{ role: WorkspaceRole; suspended: number }>();
      if (!callerMembership) return c.json(err("NOT_FOUND", "Workspace not found"), 404);
      if (callerMembership.suspended) return c.json(SUSPENDED, 403);
      const target = await systemScope(c.env.DB, "member removal target check")
        .raw("SELECT role FROM mw_members WHERE workspace_id = ? AND user_id = ?", [workspaceId, targetUserId])
        .first<{ role: WorkspaceRole }>();
      if (!target) return c.json(err("NOT_FOUND", "Member not found"), 404);
      // Story 1.10: a caller removes only themselves or members of strictly lower rank.
      if (user.uid !== targetUserId && ROLE_RANK[callerMembership.role] <= ROLE_RANK[target.role]) {
        return c.json(err("FORBIDDEN", "Insufficient permissions to remove member"), 403);
      }

      // Nobody removes the last owner (the workspace could then never be deleted). The count is part of the delete, so
      // two concurrent removals cannot both pass it.
      await c.env.DB.prepare(
        "DELETE FROM mw_members WHERE workspace_id = ? AND user_id = ? AND (role <> 'owner' OR (SELECT COUNT(*) FROM mw_members WHERE workspace_id = ? AND role = 'owner') > 1)",
      )
        .bind(workspaceId, targetUserId, workspaceId)
        .run();
      // Read back rather than trusting the change count, so this works through views too (see the accept route).
      const still = await systemScope(c.env.DB, "member removal check")
        .raw("SELECT role FROM mw_members WHERE workspace_id = ? AND user_id = ?", [workspaceId, targetUserId])
        .first<{ role: WorkspaceRole }>();
      if (still) return c.json(err("LAST_OWNER", "The last owner cannot be removed"), 409);
      return c.json({ removed: true, userId: targetUserId });
    } catch (error) {
      console.error("DELETE /workspaces/:id/members/:userId:", error);
      return c.json({ error: "Internal error" }, 500);
    }
  });

  // List the members of a workspace: any member may. A non-member gets 404, as on the detail route.
  router.get("/workspaces/:id/members", async (c) => {
    const user = c.get("user");
    if (!user) return c.json(err("UNAUTHORIZED", "Unauthorized"), 401);
    const workspaceId = c.req.param("id");
    try {
      const membership = await membershipOf(c.env.DB, workspaceId, user.uid, "member list permission check");
      if (!membership) return c.json(err("NOT_FOUND", "Workspace not found"), 404);
      const { results } = await systemScope(c.env.DB, "member list")
        .raw("SELECT user_id, role, joined_at FROM mw_members WHERE workspace_id = ? ORDER BY joined_at, user_id", [workspaceId])
        .all<{ user_id: string; role: WorkspaceRole; joined_at: string }>();
      return c.json({ members: results.map((row) => ({ userId: row.user_id, role: row.role, joinedAt: row.joined_at })) });
    } catch (error) {
      console.error("GET /workspaces/:id/members:", error);
      return c.json({ error: "Internal error" }, 500);
    }
  });

  // Rename a workspace: admin or owner, not while suspended.
  router.patch("/workspaces/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json(err("UNAUTHORIZED", "Unauthorized"), 401);
    const workspaceId = c.req.param("id");
    const body = CreateWorkspaceSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json(err("VALIDATION_ERROR", "Name required (1 to 100 characters)"), 400);
    try {
      const membership = await membershipOf(c.env.DB, workspaceId, user.uid, "workspace rename permission check");
      if (!membership) return c.json(err("NOT_FOUND", "Workspace not found"), 404);
      if (membership.suspended) return c.json(SUSPENDED, 403);
      if (ROLE_RANK[membership.role] < ROLE_RANK.admin) return c.json(err("FORBIDDEN", "Only owner or admin can rename the workspace"), 403);
      // Only while unsuspended, so a suspension that lands after the check above is not written past.
      await c.env.DB.prepare("UPDATE mw_workspaces SET name = ? WHERE id = ? AND suspended = 0").bind(body.data.name, workspaceId).run();
      const row = await systemScope(c.env.DB, "workspace rename read back")
        .raw("SELECT id, name, owner_id, suspended, created_at FROM mw_workspaces WHERE id = ?", [workspaceId])
        .first<{ id: string; name: string; owner_id: string; suspended: number; created_at: string }>();
      if (!row) return c.json(err("NOT_FOUND", "Workspace not found"), 404);
      if (row.suspended) return c.json(SUSPENDED, 403);
      return c.json({
        workspace: {
          id: row.id,
          name: row.name,
          ownerId: row.owner_id,
          suspended: false,
          createdAt: row.created_at,
          role: membership.role,
        },
      });
    } catch (error) {
      console.error("PATCH /workspaces/:id:", error);
      return c.json({ error: "Internal error" }, 500);
    }
  });

  // Set a member's role. The caller must rank strictly above both the member's current role and the new one, so an
  // admin can only move members to member, an owner can move admins and members between admin and member, and nobody
  // can make or unmake an owner here (the last owner is therefore always kept). Not while suspended.
  router.patch("/workspaces/:id/members/:userId", async (c) => {
    const user = c.get("user");
    if (!user) return c.json(err("UNAUTHORIZED", "Unauthorized"), 401);
    const workspaceId = c.req.param("id");
    const targetUserId = c.req.param("userId");
    const body = SetRoleSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json(err("VALIDATION_ERROR", "role must be owner, admin or member"), 400);
    try {
      const membership = await membershipOf(c.env.DB, workspaceId, user.uid, "member role permission check");
      if (!membership) return c.json(err("NOT_FOUND", "Workspace not found"), 404);
      if (membership.suspended) return c.json(SUSPENDED, 403);
      const target = await systemScope(c.env.DB, "member role target check")
        .raw("SELECT role FROM mw_members WHERE workspace_id = ? AND user_id = ?", [workspaceId, targetUserId])
        .first<{ role: WorkspaceRole }>();
      if (!target) return c.json(err("NOT_FOUND", "Member not found"), 404);
      const rank = ROLE_RANK[membership.role];
      if (rank <= ROLE_RANK[target.role] || rank <= ROLE_RANK[body.data.role]) {
        return c.json(err("FORBIDDEN", "You can only set roles below your own, for members below your own"), 403);
      }
      if (target.role !== body.data.role) {
        // Guarded by the role just read and by the workspace still being unsuspended, then read back (views report no
        // change counts): a concurrent change wins and this one answers 409.
        await c.env.DB.prepare(
          "UPDATE mw_members SET role = ? WHERE workspace_id = ? AND user_id = ? AND role = ? AND role <> 'owner' " +
            "AND EXISTS (SELECT 1 FROM mw_workspaces WHERE id = ? AND suspended = 0)",
        )
          .bind(body.data.role, workspaceId, targetUserId, target.role, workspaceId)
          .run();
        const now = await systemScope(c.env.DB, "member role read back")
          .raw("SELECT role FROM mw_members WHERE workspace_id = ? AND user_id = ?", [workspaceId, targetUserId])
          .first<{ role: WorkspaceRole }>();
        if (!now) return c.json(err("NOT_FOUND", "Member not found"), 404);
        if (now.role !== body.data.role) return c.json(err("CONFLICT", "The member changed meanwhile; try again"), 409);
      }
      return c.json({ userId: targetUserId, role: body.data.role });
    } catch (error) {
      console.error("PATCH /workspaces/:id/members/:userId:", error);
      return c.json({ error: "Internal error" }, 500);
    }
  });

  // List a workspace's pending (unused) invites, expired ones included with their `expiresAt`: admin or owner only.
  router.get("/workspaces/:id/invites", async (c) => {
    const user = c.get("user");
    if (!user) return c.json(err("UNAUTHORIZED", "Unauthorized"), 401);
    const workspaceId = c.req.param("id");
    try {
      const membership = await membershipOf(c.env.DB, workspaceId, user.uid, "invite list permission check");
      if (!membership) return c.json(err("NOT_FOUND", "Workspace not found"), 404);
      if (ROLE_RANK[membership.role] < ROLE_RANK.admin) return c.json(err("FORBIDDEN", "Only owner or admin can list invites"), 403);
      const { results } = await systemScope(c.env.DB, "invite list")
        .raw(
          "SELECT token, workspace_id, role, email, created_by, created_at, expires_at FROM mw_invites WHERE workspace_id = ? AND used = 0 ORDER BY created_at DESC, token",
          [workspaceId],
        )
        .all<InviteRow>();
      return c.json({
        invites: results.map((row) => ({
          token: row.token,
          workspaceId: row.workspace_id,
          role: row.role,
          email: row.email ?? null,
          createdBy: row.created_by,
          createdAt: row.created_at,
          expiresAt: row.expires_at ?? null,
          expired: isExpired(row.expires_at),
        })),
      });
    } catch (error) {
      console.error("GET /workspaces/:id/invites:", error);
      return c.json({ error: "Internal error" }, 500);
    }
  });

  // Revoke (delete) a pending invite: admin or owner, not while suspended. 404 when the workspace has no such pending
  // invite.
  router.delete("/workspaces/:id/invites/:token", async (c) => {
    const user = c.get("user");
    if (!user) return c.json(err("UNAUTHORIZED", "Unauthorized"), 401);
    const workspaceId = c.req.param("id");
    const token = c.req.param("token");
    try {
      const membership = await membershipOf(c.env.DB, workspaceId, user.uid, "invite revoke permission check");
      if (!membership) return c.json(err("NOT_FOUND", "Workspace not found"), 404);
      if (membership.suspended) return c.json(SUSPENDED, 403);
      if (ROLE_RANK[membership.role] < ROLE_RANK.admin) return c.json(err("FORBIDDEN", "Only owner or admin can revoke invites"), 403);
      const invite = await systemScope(c.env.DB, "invite revoke lookup")
        .raw("SELECT token FROM mw_invites WHERE token = ? AND workspace_id = ? AND used = 0", [token, workspaceId])
        .first<{ token: string }>();
      if (!invite) return c.json(err("NOT_FOUND", "Invite not found"), 404);
      await c.env.DB.prepare("DELETE FROM mw_invites WHERE token = ? AND workspace_id = ? AND used = 0").bind(token, workspaceId).run();
      return c.json({ revoked: true, token });
    } catch (error) {
      console.error("DELETE /workspaces/:id/invites/:token:", error);
      return c.json({ error: "Internal error" }, 500);
    }
  });

  return router;
}
