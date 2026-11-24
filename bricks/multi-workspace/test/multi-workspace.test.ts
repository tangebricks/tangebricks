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
