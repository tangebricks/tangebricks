import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration1 from "../migrations/0001_multi_workspace.sql?raw";
import migration2 from "../migrations/0002_invite_email_expiry.sql?raw";
import { createWorkspaceRoutes, type WorkspaceEnv } from "../src/index.ts";

// Version 1.1.0: emailed and expiring invites, the member list, renaming, role changes, the invite list and revoke,
// and the caller's own pending invites.
const db = env.DB as D1Like;

beforeEach(async () => {
  expect.hasAssertions();
  for (const table of ["mw_invites", "mw_members", "mw_workspaces"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await applyMigration(db, migration1);
  await applyMigration(db, migration2);
  await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES ('ws_1', 'One', 'usr_owner')").run();
  await db
    .prepare(
      "INSERT INTO mw_members (workspace_id, user_id, role) VALUES ('ws_1', 'usr_owner', 'owner'), ('ws_1', 'usr_admin', 'admin'), ('ws_1', 'usr_member', 'member')",
    )
    .run();
});

/** Identity for the test: `x-test-user` is the user id, `x-test-email` the verified email (default `<id>@test.io`). */
const app = new Hono<WorkspaceEnv>();
app.use("*", async (c, next) => {
  const uid = c.req.header("x-test-user");
  if (uid) c.set("user", { uid, email: c.req.header("x-test-email") ?? `${uid}@test.io` });
  await next();
});
app.route("/", createWorkspaceRoutes());

async function send(method: string, path: string, user?: string, body?: unknown, email?: string) {
  const headers: Record<string, string> = {};
  if (user) headers["x-test-user"] = user;
  if (email) headers["x-test-email"] = email;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(`http://localhost${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, { DB: db });
  return { status: res.status, json: (await res.json()) as any };
}

const roleOf = async (user: string) =>
  (await db.prepare("SELECT role FROM mw_members WHERE workspace_id = 'ws_1' AND user_id = ?").bind(user).first<{ role: string }>())?.role;

describe("emailed and expiring invites", () => {
  it("stores the email lower-cased and the expiry as ISO-8601 UTC; without them the invite is open and endless", async () => {
    const emailed = await send("POST", "/workspaces/ws_1/invites", "usr_owner", { role: "member", email: "  New.Person@X.io ", expiresInSeconds: 3600 });
    expect(emailed.status).toBe(201);
    expect(emailed.json.email).toBe("new.person@x.io");
    expect(emailed.json.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(emailed.json.expiresAt) - Date.now()).toBeGreaterThan(3500_000);
    const row = await db.prepare("SELECT email, expires_at FROM mw_invites WHERE token = ?").bind(emailed.json.token).first();
    expect(row).toEqual({ email: "new.person@x.io", expires_at: emailed.json.expiresAt });

    const open = await send("POST", "/workspaces/ws_1/invites", "usr_owner", { role: "member" });
    expect(open.status).toBe(201);
    expect(open.json).toMatchObject({ email: null, expiresAt: null });
  });

  it("refuses a bad email and an expiry outside its bounds", async () => {
    expect((await send("POST", "/workspaces/ws_1/invites", "usr_owner", { email: "not-an-email" })).status).toBe(400);
    expect((await send("POST", "/workspaces/ws_1/invites", "usr_owner", { expiresInSeconds: 10 })).status).toBe(400);
    expect((await send("POST", "/workspaces/ws_1/invites", "usr_owner", { expiresInSeconds: 91 * 86400 })).status).toBe(400);
    expect((await send("POST", "/workspaces/ws_1/invites", "usr_owner", { expiresInSeconds: 1.5 })).status).toBe(400);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM mw_invites").first()).toEqual({ n: 0 });
  });

  it("an emailed invite is accepted by the matching email whatever its case, with the invite's role", async () => {
    const { json } = await send("POST", "/workspaces/ws_1/invites", "usr_owner", { role: "admin", email: "a@x.io" });
    const accepted = await send("POST", `/workspaces/invites/${json.token}/accept`, "usr_a", undefined, "A@X.io");
    expect(accepted.status).toBe(200);
    expect(accepted.json).toEqual({ workspaceId: "ws_1", role: "admin" });
    expect(await roleOf("usr_a")).toBe("admin");
  });

  it("an emailed invite is refused to another email (403 INVITE_EMAIL_MISMATCH) and to a caller with no email; nothing is written", async () => {
    const { json } = await send("POST", "/workspaces/ws_1/invites", "usr_owner", { role: "member", email: "a@x.io" });
    const wrong = await send("POST", `/workspaces/invites/${json.token}/accept`, "usr_b", undefined, "b@x.io");
    expect(wrong.status).toBe(403);
    expect(wrong.json.error.code).toBe("INVITE_EMAIL_MISMATCH");
    const noEmail = new Hono<WorkspaceEnv>();
    noEmail.use("*", async (c, next) => {
      c.set("user", { uid: "usr_c" });
      await next();
    });
    noEmail.route("/", createWorkspaceRoutes());
    const res = await noEmail.request(`http://localhost/workspaces/invites/${json.token}/accept`, { method: "POST" }, { DB: db });
    expect(res.status).toBe(403);
    expect(await db.prepare("SELECT used, used_by FROM mw_invites WHERE token = ?").bind(json.token).first()).toEqual({ used: 0, used_by: null });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM mw_members WHERE user_id IN ('usr_b', 'usr_c')").first()).toEqual({ n: 0 });
  });

  it("an expired invite is refused with 410 INVITE_EXPIRED and stays unused", async () => {
    const { json } = await send("POST", "/workspaces/ws_1/invites", "usr_owner", { role: "member", expiresInSeconds: 60 });
    await db
      .prepare("UPDATE mw_invites SET expires_at = ? WHERE token = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), json.token)
      .run();
    const res = await send("POST", `/workspaces/invites/${json.token}/accept`, "usr_late");
    expect(res.status).toBe(410);
    expect(res.json.error.code).toBe("INVITE_EXPIRED");
    expect(await db.prepare("SELECT used FROM mw_invites WHERE token = ?").bind(json.token).first()).toEqual({ used: 0 });
    expect(await roleOf("usr_late")).toBeUndefined();
  });

  it("accept never changes an existing member's role, owner included", async () => {
    const { json } = await send("POST", "/workspaces/ws_1/invites", "usr_owner", { role: "member" });
    const owner = await send("POST", `/workspaces/invites/${json.token}/accept`, "usr_owner");
    expect(owner.status).toBe(409);
    expect(owner.json.error.code).toBe("ALREADY_MEMBER");
    expect(await roleOf("usr_owner")).toBe("owner");
    const admin = await send("POST", `/workspaces/invites/${json.token}/accept`, "usr_admin");
    expect(admin.status).toBe(409);
    expect(await roleOf("usr_admin")).toBe("admin");
  });
});

describe("the caller's own pending invites (GET /workspaces/invites/mine)", () => {
  it("lists pending, unexpired invites addressed to the caller's email, with the workspace name", async () => {
    await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES ('ws_2', 'Two', 'usr_owner')").run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES ('ws_2', 'usr_owner', 'owner')").run();
    const live = await send("POST", "/workspaces/ws_1/invites", "usr_owner", { role: "admin", email: "me@x.io", expiresInSeconds: 3600 });
    const endless = await send("POST", "/workspaces/ws_2/invites", "usr_owner", { email: "ME@x.io" });
    const expired = await send("POST", "/workspaces/ws_1/invites", "usr_owner", { email: "me@x.io", expiresInSeconds: 60 });
    await db.prepare("UPDATE mw_invites SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token = ?").bind(expired.json.token).run();
    await send("POST", "/workspaces/ws_1/invites", "usr_owner", { email: "other@x.io" });
    await send("POST", "/workspaces/ws_1/invites", "usr_owner", {});
    const used = await send("POST", "/workspaces/ws_2/invites", "usr_owner", { email: "me@x.io" });
    await db.prepare("UPDATE mw_invites SET used = 1, used_by = 'someone' WHERE token = ?").bind(used.json.token).run();

    const mine = await send("GET", "/workspaces/invites/mine", "usr_me", undefined, "Me@X.io");
    expect(mine.status).toBe(200);
    expect(mine.json.invites.map((i: { token: string }) => i.token).sort()).toEqual([live.json.token, endless.json.token].sort());
    expect(mine.json.invites.find((i: { token: string }) => i.token === live.json.token)).toMatchObject({
      role: "admin",
      email: "me@x.io",
      expiresAt: live.json.expiresAt,
      workspace: { id: "ws_1", name: "One" },
    });
    expect((await send("GET", "/workspaces/invites/mine")).status).toBe(401);
  });
});

describe("members, rename and roles", () => {
  it("any member lists the members; a non-member gets 404", async () => {
    const res = await send("GET", "/workspaces/ws_1/members", "usr_member");
    expect(res.status).toBe(200);
    expect(res.json.members.map((m: { userId: string; role: string }) => [m.userId, m.role]).sort()).toEqual([
      ["usr_admin", "admin"],
      ["usr_member", "member"],
      ["usr_owner", "owner"],
    ]);
    expect(res.json.members[0].joinedAt).toBeTypeOf("string");
    expect((await send("GET", "/workspaces/ws_1/members", "usr_stranger")).status).toBe(404);
    expect((await send("GET", "/workspaces/ws_1/members")).status).toBe(401);
  });

  it("an admin or owner renames; a member cannot; a bad name is 400; a suspended workspace is refused", async () => {
    const renamed = await send("PATCH", "/workspaces/ws_1", "usr_admin", { name: "  Renamed  " });
    expect(renamed.status).toBe(200);
    expect(renamed.json.workspace).toMatchObject({ id: "ws_1", name: "Renamed", ownerId: "usr_owner", suspended: false, role: "admin" });
    expect((await send("PATCH", "/workspaces/ws_1", "usr_member", { name: "No" })).status).toBe(403);
    expect((await send("PATCH", "/workspaces/ws_1", "usr_owner", { name: "" })).status).toBe(400);
    expect((await send("PATCH", "/workspaces/ws_1", "usr_stranger", { name: "No" })).status).toBe(404);
    await db.prepare("UPDATE mw_workspaces SET suspended = 1 WHERE id = 'ws_1'").run();
    const suspended = await send("PATCH", "/workspaces/ws_1", "usr_owner", { name: "No" });
    expect(suspended.status).toBe(403);
    expect(suspended.json.code).toBe("WORKSPACE_SUSPENDED");
    expect(await db.prepare("SELECT name FROM mw_workspaces WHERE id = 'ws_1'").first()).toEqual({ name: "Renamed" });
  });

  it("a role is set only by a caller strictly above both the old and the new role; no owner is ever made or unmade", async () => {
    // An admin cannot promote a member to admin (not strictly above the new role); the owner can.
    expect((await send("PATCH", "/workspaces/ws_1/members/usr_member", "usr_admin", { role: "admin" })).status).toBe(403);
    expect(await roleOf("usr_member")).toBe("member");
    const promoted = await send("PATCH", "/workspaces/ws_1/members/usr_member", "usr_owner", { role: "admin" });
    expect(promoted.status).toBe(200);
    expect(promoted.json).toEqual({ userId: "usr_member", role: "admin" });
    expect(await roleOf("usr_member")).toBe("admin");
    // An admin cannot demote another admin; the owner can.
    expect((await send("PATCH", "/workspaces/ws_1/members/usr_member", "usr_admin", { role: "member" })).status).toBe(403);
    expect((await send("PATCH", "/workspaces/ws_1/members/usr_member", "usr_owner", { role: "member" })).status).toBe(200);
    expect(await roleOf("usr_member")).toBe("member");
    // Nobody makes an owner, nobody changes the (last) owner, nobody changes their own role.
    expect((await send("PATCH", "/workspaces/ws_1/members/usr_admin", "usr_owner", { role: "owner" })).status).toBe(403);
    expect((await send("PATCH", "/workspaces/ws_1/members/usr_owner", "usr_owner", { role: "admin" })).status).toBe(403);
    expect((await send("PATCH", "/workspaces/ws_1/members/usr_admin", "usr_admin", { role: "member" })).status).toBe(403);
    expect(await roleOf("usr_owner")).toBe("owner");
    expect(await roleOf("usr_admin")).toBe("admin");
    // Unknown member, non-member caller, bad body.
    expect((await send("PATCH", "/workspaces/ws_1/members/usr_ghost", "usr_owner", { role: "member" })).status).toBe(404);
    expect((await send("PATCH", "/workspaces/ws_1/members/usr_member", "usr_stranger", { role: "member" })).status).toBe(404);
    expect((await send("PATCH", "/workspaces/ws_1/members/usr_member", "usr_owner", { role: "boss" })).status).toBe(400);
    // Suspended: refused.
    await db.prepare("UPDATE mw_workspaces SET suspended = 1 WHERE id = 'ws_1'").run();
    expect((await send("PATCH", "/workspaces/ws_1/members/usr_member", "usr_owner", { role: "admin" })).status).toBe(403);
    expect(await roleOf("usr_member")).toBe("member");
  });
});

describe("invite list and revoke", () => {
  it("admins and owners list pending invites (expired ones flagged); members and strangers cannot", async () => {
    const a = await send("POST", "/workspaces/ws_1/invites", "usr_owner", { role: "admin", email: "a@x.io", expiresInSeconds: 600 });
    const b = await send("POST", "/workspaces/ws_1/invites", "usr_admin", { role: "member" });
    const used = await send("POST", "/workspaces/ws_1/invites", "usr_admin", { role: "member" });
    await send("POST", `/workspaces/invites/${used.json.token}/accept`, "usr_joiner");
    await db.prepare("UPDATE mw_invites SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token = ?").bind(b.json.token).run();

    const list = await send("GET", "/workspaces/ws_1/invites", "usr_admin");
    expect(list.status).toBe(200);
    expect(list.json.invites.map((i: { token: string }) => i.token).sort()).toEqual([a.json.token, b.json.token].sort());
    expect(list.json.invites.find((i: { token: string }) => i.token === a.json.token)).toMatchObject({
      workspaceId: "ws_1",
      role: "admin",
      email: "a@x.io",
      createdBy: "usr_owner",
      expiresAt: a.json.expiresAt,
      expired: false,
    });
    expect(list.json.invites.find((i: { token: string }) => i.token === b.json.token)).toMatchObject({ email: null, expired: true });
    expect((await send("GET", "/workspaces/ws_1/invites", "usr_member")).status).toBe(403);
    expect((await send("GET", "/workspaces/ws_1/invites", "usr_stranger")).status).toBe(404);
  });

  it("admins and owners revoke a pending invite; it can then not be accepted; a used or unknown token is 404", async () => {
    const inv = await send("POST", "/workspaces/ws_1/invites", "usr_owner", { role: "member" });
    expect((await send("DELETE", `/workspaces/ws_1/invites/${inv.json.token}`, "usr_member")).status).toBe(403);
    const revoked = await send("DELETE", `/workspaces/ws_1/invites/${inv.json.token}`, "usr_admin");
    expect(revoked.status).toBe(200);
    expect(revoked.json).toEqual({ revoked: true, token: inv.json.token });
    expect((await send("POST", `/workspaces/invites/${inv.json.token}/accept`, "usr_new")).status).toBe(404);
    expect((await send("DELETE", `/workspaces/ws_1/invites/${inv.json.token}`, "usr_admin")).status).toBe(404);
    const used = await send("POST", "/workspaces/ws_1/invites", "usr_owner", { role: "member" });
    await send("POST", `/workspaces/invites/${used.json.token}/accept`, "usr_new");
    expect((await send("DELETE", `/workspaces/ws_1/invites/${used.json.token}`, "usr_owner")).status).toBe(404);
    // Another workspace's admin cannot revoke this workspace's invite through their own workspace id.
    await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES ('ws_2', 'Two', 'usr_x')").run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES ('ws_2', 'usr_x', 'owner')").run();
    const other = await send("POST", "/workspaces/ws_1/invites", "usr_owner", { role: "member" });
    expect((await send("DELETE", `/workspaces/ws_2/invites/${other.json.token}`, "usr_x")).status).toBe(404);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM mw_invites WHERE token = ?").bind(other.json.token).first()).toEqual({ n: 1 });
  });

  it("revoke is refused on a suspended workspace", async () => {
    const inv = await send("POST", "/workspaces/ws_1/invites", "usr_owner", { role: "member" });
    await db.prepare("UPDATE mw_workspaces SET suspended = 1 WHERE id = 'ws_1'").run();
    const res = await send("DELETE", `/workspaces/ws_1/invites/${inv.json.token}`, "usr_owner");
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("WORKSPACE_SUSPENDED");
  });
});

/** An app whose identity step sets exactly this `user` (and nothing else) on every request. */
function appAs(user: Record<string, unknown>) {
  const custom = new Hono<WorkspaceEnv>();
  custom.use("*", async (c, next) => {
    c.set("user", user as never);
    await next();
  });
  custom.route("/", createWorkspaceRoutes());
  return async (method: string, path: string, body?: unknown) => {
    const res = await custom.request(
      `http://localhost${path}`,
      { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) },
      { DB: db },
    );
    return { status: res.status, json: (await res.json()) as any };
  };
}

describe("an email the identity step marked unverified is not trusted", () => {
  it("emailed accept is refused (403 INVITE_EMAIL_MISMATCH) and /mine lists nothing; an open invite still works", async () => {
    const emailed = await send("POST", "/workspaces/ws_1/invites", "usr_owner", { role: "member", email: "u@x.io" });
    const unverified = appAs({ uid: "usr_u", email: "u@x.io", emailVerified: false });
    expect((await unverified("GET", "/workspaces/invites/mine")).json).toEqual({ invites: [] });
    const refused = await unverified("POST", `/workspaces/invites/${emailed.json.token}/accept`);
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe("INVITE_EMAIL_MISMATCH");
    expect(await roleOf("usr_u")).toBeUndefined();

    const verified = appAs({ uid: "usr_u", email: "u@x.io", emailVerified: true });
    expect((await verified("GET", "/workspaces/invites/mine")).json.invites).toHaveLength(1);
    expect((await verified("POST", `/workspaces/invites/${emailed.json.token}/accept`)).status).toBe(200);

    const open = await send("POST", "/workspaces/ws_1/invites", "usr_owner", { role: "member" });
    expect((await appAs({ uid: "usr_v", email: "v@x.io", emailVerified: false })("POST", `/workspaces/invites/${open.json.token}/accept`)).status).toBe(200);
  });
});

describe("a user with only `id` (no `uid`) is the same caller on every route", () => {
  it("creates, lists, renames, invites, lists members and invites, sets a role and removes", async () => {
    const asId = appAs({ id: "usr_idonly", email: "idonly@x.io", emailVerified: true });
    const created = await asId("POST", "/workspaces", { name: "Id Only" });
    expect(created.status).toBe(201);
    const ws = created.json.workspace.id as string;
    expect(created.json.workspace.ownerId).toBe("usr_idonly");
    expect((await asId("GET", "/workspaces")).json.workspaces.map((w: { id: string }) => w.id)).toEqual([ws]);
    expect((await asId("GET", `/workspaces/${ws}`)).status).toBe(200);
    expect((await asId("PATCH", `/workspaces/${ws}`, { name: "Renamed" })).status).toBe(200);
    const inv = await asId("POST", `/workspaces/${ws}/invites`, { role: "member" });
    expect(inv.status).toBe(201);
    expect((await asId("GET", `/workspaces/${ws}/invites`)).json.invites).toHaveLength(1);
    await send("POST", `/workspaces/invites/${inv.json.token}/accept`, "usr_joiner");
    expect((await asId("GET", `/workspaces/${ws}/members`)).json.members).toHaveLength(2);
    expect((await asId("PATCH", `/workspaces/${ws}/members/usr_joiner`, { role: "admin" })).status).toBe(200);
    expect((await asId("DELETE", `/workspaces/${ws}/members/usr_joiner`)).status).toBe(200);
    expect((await asId("DELETE", `/workspaces/${ws}`)).status).toBe(200);
  });
});
