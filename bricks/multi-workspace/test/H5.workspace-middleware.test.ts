import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_multi_workspace.sql?raw";
import {
  createWorkspaceRoutes,
  getRequestContext,
  isAdminOrOwner,
  rejectForeignWorkspace,
  requireNotSuspended,
  requireWorkspaceId,
  workspaceMiddleware,
} from "../src/index.ts";
import type { WorkspaceEnv } from "../src/index.ts";
import { stubIdentity } from "./support/stub-identity.ts";

// Re-homed from cephlow apps/api-worker/src/middleware/workspace.test.ts (see ported-tests.json): the same titles and
// the same behavioural assertions, on stub identity and the real local D1 in place of a JWT and a mocked database.

const db = env.DB as D1Like;

async function reset(): Promise<void> {
  for (const table of ["mw_members", "mw_workspaces"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await applyMigration(db, migration);
}
async function addWorkspace(id: string, opts: { suspended?: boolean; name?: string } = {}): Promise<void> {
  await db
    .prepare("INSERT INTO mw_workspaces (id, name, owner_id, suspended) VALUES (?, ?, 'owner-x', ?)")
    .bind(id, opts.name ?? id, opts.suspended ? 1 : 0)
    .run();
}
async function addMember(workspaceId: string, userId: string, role: "owner" | "admin" | "member"): Promise<void> {
  await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, ?, ?)").bind(workspaceId, userId, role).run();
}

const createApp = () => {
  const app = new Hono<WorkspaceEnv>();
  app.use("/api/*", stubIdentity);
  app.use("/api/workspace-protected/*", workspaceMiddleware);
  app.get("/api/workspace-protected/test", (c) => c.json({ workspace: c.get("workspace") }));
  app.use("/api/suspended-protected/*", workspaceMiddleware, requireNotSuspended);
  app.get("/api/suspended-protected/test", (c) => c.json({ ok: true }));
  app.route("/api", createWorkspaceRoutes());
  return app;
};
const call = (app: Hono<WorkspaceEnv>, path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  app.fetch(new Request(`http://localhost${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } }), { DB: db });

beforeEach(async () => {
  expect.hasAssertions(); // a ported test that asserts nothing would pass whatever the code does; this makes it fail instead
  await reset();
});

describe("workspaceMiddleware & requireNotSuspended - Security Tests", () => {
  it("should reject if user is not authenticated", async () => {
    const app = new Hono<WorkspaceEnv>();
    app.use("*", workspaceMiddleware);
    app.get("*", (c) => c.text("ok"));
    const res = await app.fetch(new Request("http://localhost/"), { DB: db });
    expect(res.status).toBe(401);
  });

  it("should reject if workspace context is missing", async () => {
    const res = await call(createApp(), "/api/workspace-protected/test", { "x-test-user": "user-123" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("Missing workspace context");
  });

  it("should reject if user is not member of workspace", async () => {
    await addWorkspace("workspace-abc");
    const res = await call(createApp(), "/api/workspace-protected/test", { "x-test-user": "user-123", "x-workspace-id": "workspace-abc" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("Not a member of this workspace");
  });

  it("should accept if user is member of workspace", async () => {
    await addWorkspace("workspace-abc");
    await addMember("workspace-abc", "user-123", "admin");
    const res = await call(createApp(), "/api/workspace-protected/test", { "x-test-user": "user-123", "x-workspace-id": "workspace-abc" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { workspace: unknown }).workspace).toEqual({ id: "workspace-abc", role: "admin", suspended: false });
  });

  it("should reject if workspace is suspended", async () => {
    await addWorkspace("workspace-abc", { suspended: true });
    await addMember("workspace-abc", "user-123", "member");
    const res = await call(createApp(), "/api/suspended-protected/test", { "x-test-user": "user-123", "x-workspace-id": "workspace-abc" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("WORKSPACE_SUSPENDED");
  });

  it("should verify roles with isAdminOrOwner helper", () => {
    expect(isAdminOrOwner("owner")).toBe(true);
    expect(isAdminOrOwner("admin")).toBe(true);
    expect(isAdminOrOwner("member")).toBe(false);
  });

  it("should handle DB errors in workspaceMiddleware", async () => {
    await db.prepare("DROP TABLE mw_members").run(); // the membership lookup now fails inside the database
    const res = await call(createApp(), "/api/workspace-protected/test", { "x-test-user": "user-123", "x-workspace-id": "workspace-abc" });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "Internal error" });
    // cephlow returned the database's own message here; the brick must not.
    expect(text).not.toMatch(/mw_members|no such table|SQLITE|D1_ERROR/i);
  });

  it("should reject requireNotSuspended if workspace context is missing", async () => {
    const app = new Hono<WorkspaceEnv>();
    app.use("/api/test", requireNotSuspended);
    app.get("/api/test", (c) => c.text("ok"));
    const res = await app.fetch(new Request("http://localhost/api/test"), { DB: db });
    expect(res.status).toBe(400);
  });

  it("should handle DB errors in requireNotSuspended", async () => {
    await db.prepare("DROP TABLE mw_workspaces").run(); // the lookup that requireNotSuspended depends on fails
    const res = await call(createApp(), "/api/suspended-protected/test", { "x-test-user": "user-123", "x-workspace-id": "workspace-abc" });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "Internal error" });
    expect(text).not.toMatch(/mw_workspaces|no such table|SQLITE|D1_ERROR/i);
  });
});

describe("tenant isolation", () => {
  beforeEach(async () => {
    await addWorkspace("ws-a");
    await addWorkspace("ws-b");
    await addMember("ws-a", "alice", "owner");
    await addMember("ws-b", "bob", "owner");
    await addMember("ws-a", "carol", "member");
    await addMember("ws-b", "carol", "admin");
  });
  const ask = (user: string, workspace: string) => call(createApp(), "/api/workspace-protected/test", { "x-test-user": user, "x-workspace-id": workspace });

  it("a member of workspace A is refused on workspace B, and the reverse", async () => {
    expect((await ask("alice", "ws-b")).status).toBe(403);
    expect((await ask("bob", "ws-a")).status).toBe(403);
    expect((await ask("alice", "ws-a")).status).toBe(200);
    expect((await ask("bob", "ws-b")).status).toBe(200);
  });

  it("a user in two workspaces gets the role they hold in each, from the database", async () => {
    expect(((await (await ask("carol", "ws-a")).json()) as { workspace: { role: string } }).workspace.role).toBe("member");
    expect(((await (await ask("carol", "ws-b")).json()) as { workspace: { role: string } }).workspace.role).toBe("admin");
  });

  it("a role claimed by the caller is ignored", async () => {
    const res = await call(createApp(), "/api/workspace-protected/test", {
      "x-test-user": "carol",
      "x-workspace-id": "ws-a",
      "x-workspace-role": "owner",
      "x-role": "owner",
    });
    expect(((await res.json()) as { workspace: { role: string } }).workspace.role).toBe("member");
  });

  it("a workspace that does not exist is refused the same way as one the caller does not belong to", async () => {
    const res = await ask("alice", "no-such-workspace");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("Not a member of this workspace");
  });

  it.each(["' OR '1'='1", "ws-a' --", 'ws-a"; DROP TABLE mw_members; --', "%", "ws-a OR 1=1"])(
    "a workspace id of %j is only ever data: refused, and nothing is dropped",
    async (id) => {
      expect((await ask("alice", id)).status).toBe(403);
      expect((await db.prepare("SELECT COUNT(*) AS n FROM mw_members").first<{ n: number }>())!.n).toBe(4);
    },
  );

  // Title kept unchanged (evidence keys on test names). Since AD-V1 a query-string workspace is never read: alone it is
  // missing context (400), and alongside the header the header's workspace is the one used.
  it("the workspace can be named in the query string, and the header wins when both are sent", async () => {
    // QUERY_ONLY: naming the workspace in the query string alone is missing context, even for a real member.
    const byQuery = await call(createApp(), "/api/workspace-protected/test?workspaceId=ws-a", { "x-test-user": "alice" });
    expect(byQuery.status).toBe(400);
    expect(((await byQuery.json()) as { error: string }).error).toBe("Missing workspace context");
    // HEADER_A_QUERY_B: the request runs against the header's workspace; the query's workspace is ignored.
    const both = await call(createApp(), "/api/workspace-protected/test?workspaceId=ws-b", { "x-test-user": "alice", "x-workspace-id": "ws-a" });
    expect(both.status).toBe(200);
    expect(((await both.json()) as { workspace: { id: string } }).workspace.id).toBe("ws-a");
  });

  it("sets a frozen request context from the verified membership, which a handler cannot repoint", async () => {
    const app = new Hono<WorkspaceEnv>();
    app.use("/api/*", stubIdentity);
    app.use("/api/*", workspaceMiddleware);
    app.get("/api/ctx", (c) => {
      const ctx = getRequestContext(c)!;
      let threw = false;
      try {
        (ctx as { workspaceId: string }).workspaceId = "ws-b";
      } catch {
        threw = true;
      }
      return c.json({ ctx: c.get("ctx"), frozen: Object.isFrozen(ctx), threw });
    });
    const res = await call(app, "/api/ctx", { "x-test-user": "carol", "x-workspace-id": "ws-a", "x-workspace-role": "owner" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ctx: { userId: string; workspaceId: string; role: string }; frozen: boolean; threw: boolean };
    expect(body.ctx).toEqual({ userId: "carol", workspaceId: "ws-a", role: "member" });
    expect(body.frozen).toBe(true);
    expect(body.threw).toBe(true); // modules run in strict mode, so assigning to a frozen property throws
  });

  it("rejectForeignWorkspace refuses a query or body naming another workspace, and allows the verified one", async () => {
    const app = new Hono<WorkspaceEnv>();
    app.use("/api/*", stubIdentity);
    app.use("/api/*", workspaceMiddleware);
    app.post("/api/admin", async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        // no body
      }
      return rejectForeignWorkspace(c, body) ?? c.json({ acted: c.get("ctx")!.workspaceId });
    });
    const post = (path: string, body?: unknown) =>
      call(
        app,
        path,
        { "x-test-user": "alice", "x-workspace-id": "ws-a", "content-type": "application/json" },
        { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) },
      );
    expect((await post("/api/admin?workspaceId=ws-b")).status).toBe(403);
    expect((await post("/api/admin", { workspaceId: "ws-b" })).status).toBe(403);
    const same = await post("/api/admin?workspaceId=ws-a", { workspaceId: "ws-a" });
    expect(same.status).toBe(200);
    expect(((await same.json()) as { acted: string }).acted).toBe("ws-a");
    expect((await post("/api/admin")).status).toBe(200);
  });

  it("requireWorkspaceId refuses with 400 when the middleware did not run", async () => {
    const app = new Hono<WorkspaceEnv>();
    app.get("/api/x", (c) => {
      const ws = requireWorkspaceId(c);
      if ("failure" in ws) return ws.failure;
      return c.json({ workspaceId: ws.workspaceId });
    });
    const res = await call(app, "/api/x?workspaceId=ws-a", { "x-workspace-id": "ws-a" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Missing workspace context");
  });

  it("an over-long workspace id is rejected as missing context before it reaches the database", async () => {
    expect((await ask("alice", "x".repeat(201))).status).toBe(400);
  });

  it("a suspended workspace still resolves for payment routes: only requireNotSuspended blocks it", async () => {
    await addWorkspace("ws-s", { suspended: true });
    await addMember("ws-s", "alice", "owner");
    const resolved = await ask("alice", "ws-s");
    expect(resolved.status).toBe(200);
    expect(((await resolved.json()) as { workspace: { suspended: boolean } }).workspace.suspended).toBe(true);
    expect((await call(createApp(), "/api/suspended-protected/test", { "x-test-user": "alice", "x-workspace-id": "ws-s" })).status).toBe(403);
  });
});

describe("workspace routes", () => {
  const as = (user: string) => ({ "x-test-user": user });
  const create = (user: string, body: unknown) =>
    call(
      createApp(),
      "/api/workspaces",
      { ...as(user), "content-type": "application/json" },
      { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) },
    );

  it("creating a workspace makes the caller its owner, in one batch", async () => {
    const res = await create("alice", { name: "  Acme  " });
    expect(res.status).toBe(201);
    const { workspace } = (await res.json()) as { workspace: { id: string; name: string; role: string; ownerId: string } };
    expect(workspace).toMatchObject({ name: "Acme", role: "owner", ownerId: "alice" });
    const member = await db.prepare("SELECT role FROM mw_members WHERE workspace_id = ? AND user_id = 'alice'").bind(workspace.id).first<{ role: string }>();
    expect(member?.role).toBe("owner");
  });

  it("a new workspace is immediately usable by its creator and by nobody else", async () => {
    const { workspace } = (await (await create("alice", { name: "Acme" })).json()) as { workspace: { id: string } };
    expect((await call(createApp(), "/api/workspace-protected/test", { ...as("alice"), "x-workspace-id": workspace.id })).status).toBe(200);
    expect((await call(createApp(), "/api/workspace-protected/test", { ...as("bob"), "x-workspace-id": workspace.id })).status).toBe(403);
  });

  it.each([
    ["no body", ""],
    ["a body that is not JSON", "not json"],
    ["a missing name", {}],
    ["a blank name", { name: "   " }],
    ["a name that is not text", { name: 7 }],
    ["a name over 100 characters", { name: "x".repeat(101) }],
  ])("%s is rejected with 400 and creates nothing", async (_label, body) => {
    const res = await create("alice", body);
    expect(res.status).toBe(400);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM mw_workspaces").first<{ n: number }>())!.n).toBe(0);
  });

  it("listing returns only the caller's own workspaces", async () => {
    await create("alice", { name: "Alice's" });
    await create("bob", { name: "Bob's" });
    const list = (await (await call(createApp(), "/api/workspaces", as("alice"))).json()) as { workspaces: Array<{ name: string; role: string }> };
    expect(list.workspaces.map((w) => w.name)).toEqual(["Alice's"]);
    expect(list.workspaces[0]?.role).toBe("owner");
    expect(JSON.stringify(list)).not.toContain("Bob");
  });

  it("both routes answer 401 without an identity", async () => {
    expect((await call(createApp(), "/api/workspaces")).status).toBe(401);
    expect((await call(createApp(), "/api/workspaces", {}, { method: "POST", body: JSON.stringify({ name: "x" }) })).status).toBe(401);
  });

  it("a workspace creation that fails halfway leaves nothing behind", async () => {
    await db.prepare("DROP TABLE mw_members").run();
    await db.prepare("CREATE TABLE mw_members (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role = 'never'))").run();
    const res = await create("alice", { name: "Acme" });
    expect(res.status).toBe(500);
    expect(JSON.parse(await res.text())).toEqual({ error: "Internal error" });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM mw_workspaces").first<{ n: number }>())!.n).toBe(0);
  });
});
