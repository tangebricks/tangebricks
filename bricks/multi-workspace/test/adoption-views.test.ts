import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMigration, findWorkspaceMembership, findWorkspaceState, hasWorkspaceRegistry } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import appTables from "../../../fixtures/adopt-existing-tables/app-tables.sql?raw";
import mwViews from "../../../fixtures/adopt-existing-tables/mw-views.sql?raw";
import { createWorkspaceRoutes, requireNotSuspended, workspaceMiddleware, type WorkspaceEnv } from "../src/index.ts";

// Story 2.8: an app that already has its own workspace tables (teams, team_users, team_invites) adopts the brick by
// exposing mw_workspaces, mw_members and mw_invites as views with INSTEAD OF triggers (fixtures/adopt-existing-tables,
// docs/adopting-existing-tables.md). Every route then reads and writes the app's own rows; nothing is copied.
//
// The tests share one database and run in order, like one app's life: create, invite, accept, list, set role,
// rename, remove, revoke, delete.
const db = env.DB as D1Like;

const app = new Hono<WorkspaceEnv>();
app.use("*", async (c, next) => {
  const uid = c.req.header("x-test-user");
  if (uid) c.set("user", { uid, email: c.req.header("x-test-email") ?? `${uid}@app.test` });
  await next();
});
app.use("/guarded/*", workspaceMiddleware);
app.use("/guarded/*", requireNotSuspended);
app.get("/guarded/ping", (c) => c.json({ workspace: c.get("workspace") }));
app.route("/", createWorkspaceRoutes());

async function send(method: string, path: string, user?: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (user) headers["x-test-user"] = user;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(`http://localhost${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, { DB: db });
  return { status: res.status, json: (await res.json()) as any };
}

beforeAll(async () => {
  for (const view of ["mw_invites", "mw_members", "mw_workspaces"]) {
    await db.prepare(`DROP VIEW IF EXISTS ${view}`).run();
    await db.prepare(`DROP TABLE IF EXISTS ${view}`).run();
  }
  for (const table of ["team_invites", "team_users", "teams"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await applyMigration(db, appTables);
  // The app's existing data, from before the adoption: one team with a lead and a staff member.
  await db.prepare("INSERT INTO teams (id, title, owner_user, plan) VALUES ('team_old', 'Old Team', 'usr_lead', 'pro')").run();
  await db.prepare("INSERT INTO team_users (team_id, user_ref, access) VALUES ('team_old', 'usr_lead', 'lead'), ('team_old', 'usr_staff', 'staff')").run();
  await applyMigration(db, mwViews);
});

describe("story 2.8: the multi-workspace routes through views over an app's own tables", () => {
  let ws: string;
  let token: string;

  it("the views are views (not tables), and the sdk finds the registry and memberships through them", async () => {
    const { results } = await db.prepare("SELECT name, type FROM sqlite_master WHERE name LIKE 'mw_%' AND type IN ('table', 'view') ORDER BY name").all();
    expect(results).toEqual([
      { name: "mw_invites", type: "view" },
      { name: "mw_members", type: "view" },
      { name: "mw_workspaces", type: "view" },
    ]);
    expect(await hasWorkspaceRegistry(db)).toBe(true);
    expect(await findWorkspaceMembership(db, "team_old", "usr_staff")).toMatchObject({ role: "member", suspended: false });
    expect(await findWorkspaceState(db, "team_old")).toMatchObject({ suspended: false, checked: true });
  });

  it("the app's existing rows are visible to the brick, and the guard admits their members", async () => {
    const list = await send("GET", "/workspaces", "usr_lead");
    expect(list.status).toBe(200);
    expect(list.json.workspaces).toEqual([expect.objectContaining({ id: "team_old", name: "Old Team", ownerId: "usr_lead", role: "owner", suspended: false })]);
    const ping = await send("GET", "/guarded/ping", "usr_staff", undefined, { "x-workspace-id": "team_old" });
    expect(ping.status).toBe(200);
    expect(ping.json.workspace).toEqual({ id: "team_old", role: "member", suspended: false });
    expect((await send("GET", "/guarded/ping", "usr_nobody", undefined, { "x-workspace-id": "team_old" })).status).toBe(403);
  });

  it("create: the workspace and its owner land in teams and team_users", async () => {
    const created = await send("POST", "/workspaces", "usr_alice", { name: "Alice Co" });
    expect(created.status).toBe(201);
    ws = created.json.workspace.id;
    expect(await db.prepare("SELECT title, owner_user, is_suspended, plan FROM teams WHERE id = ?").bind(ws).first()).toEqual({
      title: "Alice Co",
      owner_user: "usr_alice",
      is_suspended: 0,
      plan: "free",
    });
    expect(await db.prepare("SELECT access FROM team_users WHERE team_id = ? AND user_ref = 'usr_alice'").bind(ws).first()).toEqual({ access: "lead" });
  });

  it("invite: an emailed, expiring invite lands in team_invites, with the expiry in epoch milliseconds", async () => {
    const before = Date.now();
    const invite = await send("POST", `/workspaces/${ws}/invites`, "usr_alice", { role: "admin", email: "Bob@App.test", expiresInSeconds: 7 * 86400 });
    expect(invite.status).toBe(201);
    token = invite.json.token;
    const row = await db
      .prepare("SELECT team_id, access, sent_to, inviter, expires_ms, accepted_at FROM team_invites WHERE invite_code = ?")
      .bind(token)
      .first<{ team_id: string; access: string; sent_to: string; inviter: string; expires_ms: number; accepted_at: string | null }>();
    expect(row).toMatchObject({ team_id: ws, access: "manager", sent_to: "bob@app.test", inviter: "usr_alice", accepted_at: null });
    expect(row!.expires_ms).toBe(Date.parse(invite.json.expiresAt));
    expect(row!.expires_ms).toBeGreaterThanOrEqual(before + 7 * 86400_000 - 1000);
    // Read back through the view: the same ISO-8601 value the route answered.
    const listed = await send("GET", `/workspaces/${ws}/invites`, "usr_alice");
    expect(listed.json.invites).toEqual([
      expect.objectContaining({ token, role: "admin", email: "bob@app.test", expiresAt: invite.json.expiresAt, expired: false }),
    ]);
    const mine = await send("GET", "/workspaces/invites/mine", "usr_bob", undefined, { "x-test-email": "bob@app.test" });
    expect(mine.json.invites).toEqual([expect.objectContaining({ token, workspace: { id: ws, name: "Alice Co" } })]);
  });

  it("accept: refused to another email and when expired; then accepted, landing in team_users and marking team_invites", async () => {
    const wrong = await send("POST", `/workspaces/invites/${token}/accept`, "usr_eve", undefined, { "x-test-email": "eve@app.test" });
    expect(wrong.status).toBe(403);
    expect(wrong.json.error.code).toBe("INVITE_EMAIL_MISMATCH");

    const expiring = await send("POST", `/workspaces/${ws}/invites`, "usr_alice", { role: "member", expiresInSeconds: 60 });
    await db
      .prepare("UPDATE team_invites SET expires_ms = ? WHERE invite_code = ?")
      .bind(Date.now() - 5000, expiring.json.token)
      .run();
    const expired = await send("POST", `/workspaces/invites/${expiring.json.token}/accept`, "usr_late");
    expect(expired.status).toBe(410);

    const accepted = await send("POST", `/workspaces/invites/${token}/accept`, "usr_bob", undefined, { "x-test-email": "BOB@app.test" });
    expect(accepted.status).toBe(200);
    expect(accepted.json).toEqual({ workspaceId: ws, role: "admin" });
    expect(await db.prepare("SELECT access FROM team_users WHERE team_id = ? AND user_ref = 'usr_bob'").bind(ws).first()).toEqual({ access: "manager" });
    const invite = await db
      .prepare("SELECT accepted_by, accepted_at FROM team_invites WHERE invite_code = ?")
      .bind(token)
      .first<{ accepted_by: string; accepted_at: string }>();
    expect(invite?.accepted_by).toBe("usr_bob");
    expect(invite?.accepted_at).toBeTypeOf("string");

    // Single use through the views too.
    const replay = await send("POST", `/workspaces/invites/${token}/accept`, "usr_eve", undefined, { "x-test-email": "bob@app.test" });
    expect(replay.status).toBe(409);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM team_users WHERE user_ref = 'usr_eve'").first()).toEqual({ n: 0 });
  });

  it("two concurrent accepts of one invite give exactly one member through the views", async () => {
    const inv = await send("POST", `/workspaces/${ws}/invites`, "usr_alice", { role: "member" });
    const results = await Promise.all([
      send("POST", `/workspaces/invites/${inv.json.token}/accept`, "usr_x"),
      send("POST", `/workspaces/invites/${inv.json.token}/accept`, "usr_y"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM team_users WHERE team_id = ? AND user_ref IN ('usr_x', 'usr_y')").bind(ws).first()).toEqual({ n: 1 });
  });

  it("an existing member's accept changes nothing", async () => {
    const inv = await send("POST", `/workspaces/${ws}/invites`, "usr_alice", { role: "member" });
    const res = await send("POST", `/workspaces/invites/${inv.json.token}/accept`, "usr_bob");
    expect(res.status).toBe(409);
    expect(await db.prepare("SELECT access FROM team_users WHERE team_id = ? AND user_ref = 'usr_bob'").bind(ws).first()).toEqual({ access: "manager" });
  });

  it("list members, set a role and rename: all read from and written to the app's tables", async () => {
    const members = await send("GET", `/workspaces/${ws}/members`, "usr_bob");
    expect(members.status).toBe(200);
    const listed = members.json.members.map((m: { userId: string; role: string }) => `${m.userId}:${m.role}`).sort();
    expect(listed).toHaveLength(3);
    expect(listed.slice(0, 2)).toEqual(["usr_alice:owner", "usr_bob:admin"]);
    expect(listed[2]).toMatch(/^usr_[xy]:member$/);

    const joiner = members.json.members.find((m: { role: string }) => m.role === "member").userId as string;
    expect((await send("PATCH", `/workspaces/${ws}/members/${joiner}`, "usr_bob", { role: "admin" })).status).toBe(403);
    expect((await send("PATCH", `/workspaces/${ws}/members/${joiner}`, "usr_alice", { role: "admin" })).status).toBe(200);
    expect(await db.prepare("SELECT access FROM team_users WHERE team_id = ? AND user_ref = ?").bind(ws, joiner).first()).toEqual({ access: "manager" });
    expect((await send("PATCH", `/workspaces/${ws}/members/usr_alice`, "usr_alice", { role: "admin" })).status).toBe(403);

    const renamed = await send("PATCH", `/workspaces/${ws}`, "usr_bob", { name: "Alice and Bob" });
    expect(renamed.status).toBe(200);
    expect(renamed.json.workspace.name).toBe("Alice and Bob");
    expect(await db.prepare("SELECT title, plan FROM teams WHERE id = ?").bind(ws).first()).toEqual({ title: "Alice and Bob", plan: "free" });
  });

  it("remove: a member is deleted from team_users; the last owner is kept", async () => {
    const joiner = (await db
      .prepare("SELECT user_ref FROM team_users WHERE team_id = ? AND user_ref IN ('usr_x', 'usr_y')")
      .bind(ws)
      .first<{ user_ref: string }>())!.user_ref;
    const removed = await send("DELETE", `/workspaces/${ws}/members/${joiner}`, "usr_alice");
    expect(removed.status).toBe(200);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM team_users WHERE team_id = ? AND user_ref = ?").bind(ws, joiner).first()).toEqual({ n: 0 });

    const last = await send("DELETE", `/workspaces/${ws}/members/usr_alice`, "usr_alice");
    expect(last.status).toBe(409);
    expect(last.json.error.code).toBe("LAST_OWNER");
    expect(await db.prepare("SELECT access FROM team_users WHERE team_id = ? AND user_ref = 'usr_alice'").bind(ws).first()).toEqual({ access: "lead" });
  });

  it("revoke: the invite row is deleted from team_invites", async () => {
    const inv = await send("POST", `/workspaces/${ws}/invites`, "usr_alice", { role: "member", email: "carol@app.test" });
    expect((await send("DELETE", `/workspaces/${ws}/invites/${inv.json.token}`, "usr_bob")).status).toBe(200);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM team_invites WHERE invite_code = ?").bind(inv.json.token).first()).toEqual({ n: 0 });
  });

  it("suspension set on the app's own column is honoured by the brick's routes and guard", async () => {
    await db.prepare("UPDATE teams SET is_suspended = 1, suspend_note = 'billing' WHERE id = ?").bind(ws).run();
    const rename = await send("PATCH", `/workspaces/${ws}`, "usr_alice", { name: "No" });
    expect(rename.status).toBe(403);
    expect(rename.json.code).toBe("WORKSPACE_SUSPENDED");
    const guarded = await send("GET", "/guarded/ping", "usr_alice", undefined, { "x-workspace-id": ws });
    expect(guarded.status).toBe(403);
    expect(await findWorkspaceState(db, ws)).toMatchObject({ suspended: true, reason: "billing" });
    await db.prepare("UPDATE teams SET is_suspended = 0, suspend_note = NULL WHERE id = ?").bind(ws).run();
  });

  it("delete: the fence is written to teams, then the team, its users and its invites are removed; other teams stay", async () => {
    await send("POST", `/workspaces/${ws}/invites`, "usr_alice", { role: "member" });
    const del = await send("DELETE", `/workspaces/${ws}`, "usr_alice");
    expect(del.status).toBe(200);
    for (const [table, column] of [
      ["teams", "id"],
      ["team_users", "team_id"],
      ["team_invites", "team_id"],
    ] as const) {
      expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).bind(ws).first(), table).toEqual({ n: 0 });
    }
    expect(await db.prepare("SELECT COUNT(*) AS n FROM team_users WHERE team_id = 'team_old'").first()).toEqual({ n: 2 });
    expect(await db.prepare("SELECT title FROM teams WHERE id = 'team_old'").first()).toEqual({ title: "Old Team" });
  });
});
