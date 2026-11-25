import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_multi_workspace.sql?raw";
import {
  createWorkspaceRoutes,
  workspaceMiddleware,
  type WorkspaceEnv,
} from "../src/index.ts";

const db = env.DB as D1Like;

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS mw_invites").run();
  await db.prepare("DROP TABLE IF EXISTS mw_members").run();
  await db.prepare("DROP TABLE IF EXISTS mw_workspaces").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

function createTestApp() {
  const app = new Hono<WorkspaceEnv>();
  app.use("*", async (c, next) => {
    const authHeader = c.req.header("x-test-user");
    if (authHeader) {
      c.set("user", { uid: authHeader, email: `${authHeader}@test.com` });
    }
    await next();
  });
  app.route("/", createWorkspaceRoutes());
  return app;
}

describe("Multi-Workspace Brick Behaviour Suite", () => {
  it("creates workspace and assigns owner role", async () => {
    await db.prepare(`
      INSERT INTO mw_workspaces (id, name, owner_id) VALUES ('ws_alpha', 'Alpha Inc', 'usr_alice')
    `).run();

    await db.prepare(`
      INSERT INTO mw_members (workspace_id, user_id, role) VALUES ('ws_alpha', 'usr_alice', 'owner')
    `).run();

    const ws = await db.prepare("SELECT * FROM mw_workspaces WHERE id = 'ws_alpha'").first<any>();
    expect(ws.name).toBe("Alpha Inc");

    const member = await db.prepare(
      "SELECT * FROM mw_members WHERE workspace_id = 'ws_alpha' AND user_id = 'usr_alice'"
    ).first<any>();
    expect(member.role).toBe("owner");
  });

  it("exposes standard Hono workspace collection routes (GET /workspaces, POST /workspaces)", async () => {
    const app = createTestApp();

    // 1. POST /workspaces creates workspace and owner member
    const createRes = await app.request(
      "http://localhost/workspaces",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-test-user": "usr_bob",
        },
        body: JSON.stringify({ name: "Bob Enterprises" }),
      },
      { DB: db }
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as any;
    expect(createBody.workspace).toBeDefined();
    expect(createBody.workspace.name).toBe("Bob Enterprises");
    expect(createBody.workspace.role).toBe("owner");
    const wsId = createBody.workspace.id;

    // 2. GET /workspaces lists the newly created workspace
    const listRes = await app.request(
      "http://localhost/workspaces",
      {
        method: "GET",
        headers: { "x-test-user": "usr_bob" },
      },
      { DB: db }
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as any;
    expect(listBody.workspaces).toHaveLength(1);
    expect(listBody.workspaces[0].id).toBe(wsId);
    expect(listBody.workspaces[0].name).toBe("Bob Enterprises");

    // 3. Negative check: unauthenticated caller cannot list or create
    const unauthGet = await app.request("http://localhost/workspaces", { method: "GET" }, { DB: db });
    expect(unauthGet.status).toBe(401);

    const unauthPost = await app.request(
      "http://localhost/workspaces",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Rogue Corp" }),
      },
      { DB: db }
    );
    expect(unauthPost.status).toBe(401);
  });

  it("returns 404 (not 403) for non-members on workspace-scoped routes to prevent existence leakage", async () => {
    const app = createTestApp();

    // Seed workspace owned by Alice
    await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES ('ws_secret', 'Secret Vault', 'usr_alice')").run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES ('ws_secret', 'usr_alice', 'owner')").run();

    // 1. Alice (member/owner) accesses workspace-scoped route -> 200
    const ownerRes = await app.request(
      "http://localhost/workspaces/ws_secret",
      {
        method: "GET",
        headers: { "x-test-user": "usr_alice" },
      },
      { DB: db }
    );
    expect(ownerRes.status).toBe(200);
    const ownerBody = (await ownerRes.json()) as any;
    expect(ownerBody.workspace.name).toBe("Secret Vault");

    // 2. Bob (non-member) accesses workspace-scoped route -> MUST be 404, NOT 403
    const nonMemberRes = await app.request(
      "http://localhost/workspaces/ws_secret",
      {
        method: "GET",
        headers: { "x-test-user": "usr_bob" },
      },
      { DB: db }
    );
    expect(nonMemberRes.status).toBe(404);
    const nonMemberBody = (await nonMemberRes.json()) as any;
    expect(nonMemberBody.error).toBeDefined();

    // 3. Accessing a non-existent workspace -> also 404 (indistinguishable)
    const missingRes = await app.request(
      "http://localhost/workspaces/ws_does_not_exist",
      {
        method: "GET",
        headers: { "x-test-user": "usr_bob" },
      },
      { DB: db }
    );
    expect(missingRes.status).toBe(404);
  });

  it("membership removal revokes access immediately with no stale permission cache", async () => {
    const app = createTestApp();

    // Seed workspace with Alice as owner and Bob as member
    await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES ('ws_team', 'Team Workspace', 'usr_alice')").run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES ('ws_team', 'usr_alice', 'owner')").run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES ('ws_team', 'usr_bob', 'member')").run();

    // 1. Bob has access initially
    const beforeRes = await app.request(
      "http://localhost/workspaces/ws_team",
      {
        method: "GET",
        headers: { "x-test-user": "usr_bob" },
      },
      { DB: db }
    );
    expect(beforeRes.status).toBe(200);

    // 2. Alice removes Bob from workspace via DELETE /workspaces/:id/members/:userId
    const removeRes = await app.request(
      "http://localhost/workspaces/ws_team/members/usr_bob",
      {
        method: "DELETE",
        headers: { "x-test-user": "usr_alice" },
      },
      { DB: db }
    );
    expect(removeRes.status).toBe(200);

    // Verify DB row was removed
    const memberRow = await db
      .prepare("SELECT * FROM mw_members WHERE workspace_id = 'ws_team' AND user_id = 'usr_bob'")
      .first();
    expect(memberRow).toBeNull();

    // 3. Bob's access is immediately revoked on subsequent request -> 404
    const afterRes = await app.request(
      "http://localhost/workspaces/ws_team",
      {
        method: "GET",
        headers: { "x-test-user": "usr_bob" },
      },
      { DB: db }
    );
    expect(afterRes.status).toBe(404);

    // 4. Bob also cannot see ws_team in GET /workspaces list
    const listRes = await app.request(
      "http://localhost/workspaces",
      {
        method: "GET",
        headers: { "x-test-user": "usr_bob" },
      },
      { DB: db }
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as any;
    expect(listBody.workspaces.find((w: any) => w.id === "ws_team")).toBeUndefined();
  });

  it("story 0.6: DELETE /workspaces/:id is owner-only (no user 401, member 403, admin 403)", async () => {
    const app = createTestApp();
    await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES ('ws_del6', 'Keep', 'usr_alice')").run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES ('ws_del6', 'usr_alice', 'owner')").run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES ('ws_del6', 'usr_bob', 'member')").run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES ('ws_del6', 'usr_dan', 'admin')").run();
    const del = (user?: string) =>
      app.request("http://localhost/workspaces/ws_del6", { method: "DELETE", headers: user ? { "x-test-user": user } : {} }, { DB: db });
    expect((await del()).status).toBe(401);
    expect((await del("usr_bob")).status).toBe(403);
    expect((await del("usr_dan")).status).toBe(403);
    expect(await db.prepare("SELECT id FROM mw_workspaces WHERE id = 'ws_del6'").first()).not.toBeNull();
    expect((await del("usr_alice")).status).toBe(200);
  });

  it("cascades workspace deletion to members and refuses non-owner deletion", async () => {
    const app = createTestApp();

    await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES ('ws_del', 'To Delete', 'usr_alice')").run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES ('ws_del', 'usr_alice', 'owner')").run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES ('ws_del', 'usr_bob', 'member')").run();

    // 1. Negative path: Bob (non-owner) cannot delete workspace -> 404/403
    const bobDelRes = await app.request(
      "http://localhost/workspaces/ws_del",
      {
        method: "DELETE",
        headers: { "x-test-user": "usr_bob" },
      },
      { DB: db }
    );
    expect([403, 404]).toContain(bobDelRes.status);

    // Workspace and members still intact
    const wsStillExists = await db.prepare("SELECT * FROM mw_workspaces WHERE id = 'ws_del'").first();
    expect(wsStillExists).not.toBeNull();

    // 2. Owner (Alice) deletes workspace -> 200
    const aliceDelRes = await app.request(
      "http://localhost/workspaces/ws_del",
      {
        method: "DELETE",
        headers: { "x-test-user": "usr_alice" },
      },
      { DB: db }
    );
    expect(aliceDelRes.status).toBe(200);

    // 3. Workspace is gone
    const wsGone = await db.prepare("SELECT * FROM mw_workspaces WHERE id = 'ws_del'").first();
    expect(wsGone).toBeNull();

    // 4. Members are cleanly cascaded (no orphaned membership records)
    const membersGone = await db
      .prepare("SELECT count(*) as cnt FROM mw_members WHERE workspace_id = 'ws_del'")
      .first<{ cnt: number }>();
    expect(membersGone?.cnt).toBe(0);

    // 5. Subsequent access returns 404 for everyone
    const aliceGetRes = await app.request(
      "http://localhost/workspaces/ws_del",
      {
        method: "GET",
        headers: { "x-test-user": "usr_alice" },
      },
      { DB: db }
    );
    expect(aliceGetRes.status).toBe(404);
  });

  it("issues single-use invite tokens and refuses replay after first redemption", async () => {
    const app = createTestApp();

    await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES ('ws_inv', 'Invite Hub', 'usr_alice')").run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES ('ws_inv', 'usr_alice', 'owner')").run();

    // 1. Alice creates an invite
    const inviteRes = await app.request(
      "http://localhost/workspaces/ws_inv/invites",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-test-user": "usr_alice",
        },
        body: JSON.stringify({ role: "member" }),
      },
      { DB: db }
    );
    expect(inviteRes.status).toBe(201);
    const inviteBody = (await inviteRes.json()) as any;
    expect(inviteBody.token).toBeDefined();
    const token = inviteBody.token;

    // 2. Charlie redeems invite token for the first time -> 200
    const acceptRes1 = await app.request(
      `http://localhost/workspaces/invites/${token}/accept`,
      {
        method: "POST",
        headers: { "x-test-user": "usr_charlie" },
      },
      { DB: db }
    );
    expect(acceptRes1.status).toBe(200);
    const acceptBody1 = (await acceptRes1.json()) as any;
    expect(acceptBody1.workspaceId).toBe("ws_inv");

    // Charlie is now recorded as a member
    const charlieMember = await db
      .prepare("SELECT * FROM mw_members WHERE workspace_id = 'ws_inv' AND user_id = 'usr_charlie'")
      .first<any>();
    expect(charlieMember).not.toBeNull();
    expect(charlieMember.role).toBe("member");

    // 3. Replay attack: Eve attempts to use the same invite token -> Refused (400 or 409 or 404)
    const acceptRes2 = await app.request(
      `http://localhost/workspaces/invites/${token}/accept`,
      {
        method: "POST",
        headers: { "x-test-user": "usr_eve" },
      },
      { DB: db }
    );
    expect([400, 404, 409]).toContain(acceptRes2.status);

    // Eve was NOT added to workspace
    const eveMember = await db
      .prepare("SELECT * FROM mw_members WHERE workspace_id = 'ws_inv' AND user_id = 'usr_eve'")
      .first();
    expect(eveMember).toBeNull();
  });
});

// Story 1.10: invite ceilings, suspension on the workspace brick's own routes, and the delete hook.
describe("story 1.10: invites, suspension and the workspace delete hook", () => {
  function appWith(options: Parameters<typeof createWorkspaceRoutes>[0] = {}) {
    const app = new Hono<WorkspaceEnv>();
    app.use("*", async (c, next) => {
      const uid = c.req.header("x-test-user");
      if (uid) c.set("user", { uid, email: `${uid}@test.com` });
      await next();
    });
    app.route("/", createWorkspaceRoutes(options));
    return app;
  }
  const send = (app: Hono<WorkspaceEnv>, method: string, path: string, user: string, body?: unknown) =>
    app.request(
      `http://localhost${path}`,
      { method, headers: { "x-test-user": user, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) },
      { DB: db },
    );
  async function seedWorkspace(id: string, suspended = false): Promise<void> {
    await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id, suspended) VALUES (?, ?, 'usr_owner', ?)").bind(id, id, suspended ? 1 : 0).run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, 'usr_owner', 'owner'), (?, 'usr_admin', 'admin'), (?, 'usr_member', 'member')").bind(id, id, id).run();
  }

  it("an inviter may only invite at or below their own role", async () => {
    const app = appWith();
    await seedWorkspace("ws_roles");
    const adminOwner = await send(app, "POST", "/workspaces/ws_roles/invites", "usr_admin", { role: "owner" });
    expect(adminOwner.status).toBe(403);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM mw_invites").first<{ n: number }>()).toEqual({ n: 0 });
    expect((await send(app, "POST", "/workspaces/ws_roles/invites", "usr_admin", { role: "admin" })).status).toBe(201);
    expect((await send(app, "POST", "/workspaces/ws_roles/invites", "usr_admin", { role: "member" })).status).toBe(201);
    expect((await send(app, "POST", "/workspaces/ws_roles/invites", "usr_owner", { role: "owner" })).status).toBe(201);
    expect((await send(app, "POST", "/workspaces/ws_roles/invites", "usr_member", { role: "member" })).status).toBe(403);
  });

  it("a suspended workspace is refused with 403 WORKSPACE_SUSPENDED on invite, accept, member removal and delete; its GETs still answer", async () => {
    const app = appWith();
    await seedWorkspace("ws_susp");
    const invite = (await (await send(app, "POST", "/workspaces/ws_susp/invites", "usr_owner", { role: "member" })).json()) as { token: string };
    await db.prepare("UPDATE mw_workspaces SET suspended = 1 WHERE id = 'ws_susp'").run();

    const expectSuspended = async (res: Response, label: string) => {
      expect(res.status, label).toBe(403);
      expect(((await res.json()) as { code?: string }).code, label).toBe("WORKSPACE_SUSPENDED");
    };
    await expectSuspended(await send(app, "POST", "/workspaces/ws_susp/invites", "usr_owner", { role: "member" }), "invite");
    await expectSuspended(await send(app, "POST", `/workspaces/invites/${invite.token}/accept`, "usr_new"), "accept");
    await expectSuspended(await send(app, "DELETE", "/workspaces/ws_susp/members/usr_member", "usr_owner"), "member removal");
    await expectSuspended(await send(app, "DELETE", "/workspaces/ws_susp", "usr_owner"), "delete");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM mw_members WHERE workspace_id = 'ws_susp'").first<{ n: number }>()).toEqual({ n: 3 });
    expect(await db.prepare("SELECT used FROM mw_invites WHERE token = ?").bind(invite.token).first<{ used: number }>()).toEqual({ used: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM mw_workspaces WHERE id = 'ws_susp'").first<{ n: number }>()).toEqual({ n: 1 });

    const list = await send(app, "GET", "/workspaces", "usr_member");
    expect(list.status).toBe(200);
    const detail = await send(app, "GET", "/workspaces/ws_susp", "usr_member");
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { workspace: { suspended: boolean } }).workspace.suspended).toBe(true);
  });

  it("the delete hook runs before the workspace rows go; when it fails the workspace and its rows stay, and a retry completes", async () => {
    await db.prepare("DROP TABLE IF EXISTS hook_items").run();
    await db.prepare("CREATE TABLE hook_items (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL)").run();
    await seedWorkspace("ws_a");
    await seedWorkspace("ws_b");
    await db.prepare("INSERT INTO hook_items (id, workspace_id) VALUES ('a1', 'ws_a'), ('b1', 'ws_b')").run();

    let fail = true;
    const app = appWith({
      workspaceDataPurge: async (env, workspaceId) => {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM hook_items WHERE workspace_id = ?").bind(workspaceId),
          ...(fail ? [env.DB.prepare("DELETE FROM no_such_table WHERE workspace_id = ?").bind(workspaceId)] : []),
        ]);
      },
    });
    // A member or an admin cannot delete; the hook does not run.
    expect((await send(app, "DELETE", "/workspaces/ws_a", "usr_member")).status).toBe(403);
    expect((await send(app, "DELETE", "/workspaces/ws_a", "usr_admin")).status).toBe(403);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM hook_items").first<{ n: number }>()).toEqual({ n: 2 });

    // A purge statement fails: its batch rolls back, A's rows and the workspace stay.
    expect((await send(app, "DELETE", "/workspaces/ws_a", "usr_owner")).status).toBe(500);
    expect(await db.prepare("SELECT id FROM hook_items WHERE workspace_id = 'ws_a'").all()).toMatchObject({ results: [{ id: "a1" }] });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM mw_members WHERE workspace_id = 'ws_a'").first<{ n: number }>()).toEqual({ n: 3 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM mw_workspaces WHERE id = 'ws_a'").first<{ n: number }>()).toEqual({ n: 1 });
    // The fence stays up: the workspace is suspended for the delete, so other writes are refused meanwhile.
    expect(await db.prepare("SELECT suspended, suspended_reason FROM mw_workspaces WHERE id = 'ws_a'").first()).toEqual({ suspended: 1, suspended_reason: "deleting" });
    expect((await send(app, "POST", "/workspaces/ws_a/invites", "usr_owner", { role: "member" })).status).toBe(403);

    // The retry runs the hook statements and then removes the workspace; B is untouched.
    fail = false;
    expect((await send(app, "DELETE", "/workspaces/ws_a", "usr_owner")).status).toBe(200);
    expect(await db.prepare("SELECT id FROM hook_items ORDER BY id").all()).toMatchObject({ results: [{ id: "b1" }] });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM mw_workspaces WHERE id = 'ws_a'").first<{ n: number }>()).toEqual({ n: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM mw_members WHERE workspace_id = 'ws_b'").first<{ n: number }>()).toEqual({ n: 3 });
  });

  it("story 2.6: a suspension that lands between the delete's check and its fence is kept, and the delete is refused", async () => {
    await seedWorkspace("ws_race");
    let ran = false;
    const app = appWith({ workspaceDataPurge: async () => { ran = true; } });
    // A database whose fence statement first lets an operator suspension land (the race), then runs as usual.
    const racing = {
      prepare(sql: string) {
        if (sql.startsWith("UPDATE mw_workspaces SET suspended = 1, suspended_reason = ?")) {
          const real = db.prepare(sql);
          return {
            bind: (...values: unknown[]) => ({
              run: async () => {
                await db.prepare("UPDATE mw_workspaces SET suspended = 1, suspended_reason = 'operator' WHERE id = 'ws_race'").run();
                return real.bind(...values).run();
              },
            }),
          };
        }
        return db.prepare(sql);
      },
      batch: (s: never) => db.batch(s),
      exec: (q: string) => db.exec(q),
    };
    const res = await app.request("http://localhost/workspaces/ws_race", { method: "DELETE", headers: { "x-test-user": "usr_owner" } }, { DB: racing as never });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("WORKSPACE_SUSPENDED");
    expect(ran).toBe(false);
    expect(await db.prepare("SELECT suspended, suspended_reason FROM mw_workspaces WHERE id = 'ws_race'").first()).toEqual({ suspended: 1, suspended_reason: "operator" });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM mw_members WHERE workspace_id = 'ws_race'").first<{ n: number }>()).toEqual({ n: 3 });
    // An unsuspended workspace is still deleted as before.
    await seedWorkspace("ws_plain");
    expect((await send(appWith(), "DELETE", "/workspaces/ws_plain", "usr_owner")).status).toBe(200);
  });

  it("an id that is not one plain segment is refused with 400 before anything runs", async () => {
    let ran = false;
    const app = appWith({ workspaceDataPurge: async () => { ran = true; } });
    for (const id of ["a%2Fb", "a..b%2F", "x".repeat(65)]) {
      expect((await send(app, "DELETE", `/workspaces/${id}`, "usr_owner")).status, id).toBe(400);
    }
    expect(ran).toBe(false);
  });

  it("two concurrent accepts of one invite give exactly one member", async () => {
    const app = appWith();
    await seedWorkspace("ws_race");
    const { token } = (await (await send(app, "POST", "/workspaces/ws_race/invites", "usr_owner", { role: "owner" })).json()) as { token: string };
    const results = await Promise.all([
      send(app, "POST", `/workspaces/invites/${token}/accept`, "usr_x"),
      send(app, "POST", `/workspaces/invites/${token}/accept`, "usr_y"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM mw_members WHERE workspace_id = 'ws_race' AND user_id IN ('usr_x', 'usr_y')").first<{ n: number }>()).toEqual({ n: 1 });
  });

  it("an existing member cannot accept an invite: 409 ALREADY_MEMBER, role unchanged, invite still open", async () => {
    const app = appWith();
    await seedWorkspace("ws_exist");
    const { token } = (await (await send(app, "POST", "/workspaces/ws_exist/invites", "usr_owner", { role: "member" })).json()) as { token: string };
    const res = await send(app, "POST", `/workspaces/invites/${token}/accept`, "usr_admin");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("ALREADY_MEMBER");
    expect(await db.prepare("SELECT role FROM mw_members WHERE workspace_id = 'ws_exist' AND user_id = 'usr_admin'").first()).toEqual({ role: "admin" });
    expect(await db.prepare("SELECT used FROM mw_invites WHERE token = ?").bind(token).first()).toEqual({ used: 0 });
  });

  it("an invite whose inviter was removed is revoked: 403 INVITE_REVOKED and not consumed", async () => {
    const app = appWith();
    await seedWorkspace("ws_revoke");
    const { token } = (await (await send(app, "POST", "/workspaces/ws_revoke/invites", "usr_admin", { role: "admin" })).json()) as { token: string };
    expect((await send(app, "DELETE", "/workspaces/ws_revoke/members/usr_admin", "usr_owner")).status).toBe(200);
    const res = await send(app, "POST", `/workspaces/invites/${token}/accept`, "usr_new");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVITE_REVOKED");
    expect(await db.prepare("SELECT used FROM mw_invites WHERE token = ?").bind(token).first()).toEqual({ used: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM mw_members WHERE user_id = 'usr_new'").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("members are removed only by a caller of strictly higher rank or by themselves, and never the last owner", async () => {
    const app = appWith();
    await seedWorkspace("ws_rm");
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES ('ws_rm', 'usr_admin2', 'admin'), ('ws_rm', 'usr_member2', 'member')").run();
    const remove = (caller: string, target: string) => send(app, "DELETE", `/workspaces/ws_rm/members/${target}`, caller);
    const role = async (user: string) => (await db.prepare("SELECT role FROM mw_members WHERE workspace_id = 'ws_rm' AND user_id = ?").bind(user).first<{ role: string }>())?.role;

    expect((await remove("usr_admin", "usr_owner")).status).toBe(403);
    expect((await remove("usr_admin", "usr_admin2")).status).toBe(403);
    expect((await remove("usr_member", "usr_member2")).status).toBe(403);
    expect(await role("usr_owner")).toBe("owner");
    expect(await role("usr_admin2")).toBe("admin");
    expect(await role("usr_member2")).toBe("member");

    expect((await remove("usr_admin", "usr_member2")).status).toBe(200);
    expect((await remove("usr_owner", "usr_admin2")).status).toBe(200);
    expect((await remove("usr_member", "usr_member")).status).toBe(200);

    const last = await remove("usr_owner", "usr_owner");
    expect(last.status).toBe(409);
    expect(((await last.json()) as { error: { code: string } }).error.code).toBe("LAST_OWNER");
    expect(await role("usr_owner")).toBe("owner");

    // With a second owner, an owner may leave, but still not remove the other owner.
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES ('ws_rm', 'usr_owner2', 'owner')").run();
    expect((await remove("usr_owner", "usr_owner2")).status).toBe(403);
    expect((await remove("usr_owner", "usr_owner")).status).toBe(200);
    expect(await role("usr_owner2")).toBe("owner");
  });
});
