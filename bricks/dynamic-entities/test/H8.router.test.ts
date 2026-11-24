import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration, entityDdl, parseEntities } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { workspaceMiddleware } from "@poc/multi-workspace";
import type { WorkspaceEnv } from "@poc/multi-workspace";
import mwMigration from "../../multi-workspace/migrations/0001_multi_workspace.sql?raw";
import { stubIdentity } from "../../multi-workspace/test/support/stub-identity.ts";
import { createEntityRoutes } from "../src/index.ts";

// The router on its own: the real workspace guard, the DDL the shared contract generates, and a real local D1. The
// assembled project is tested separately (H8.entities.test.ts in the assembler package); this file points at the router.
const db = env.DB as D1Like;

const declarations = [
  {
    name: "invoices",
    fields: [
      { name: "client_name", type: "text", required: true },
      { name: "amount", type: "number" },
      { name: "status", type: "enum", values: ["draft", "paid", "overdue"] },
    ],
  },
  {
    name: "tasks",
    fields: [
      { name: "title", type: "text", required: true, maxLength: 20 },
      { name: "done", type: "boolean", required: true },
      { name: "points", type: "number", min: 1, max: 5 },
    ],
  },
];
const parsed = parseEntities(declarations);
if (!parsed.ok) throw new Error(parsed.errors.join("; "));

const app = new Hono<WorkspaceEnv>();
app.use("/api/*", stubIdentity);
for (const e of parsed.entities) {
  app.use(`/api/${e.name}`, workspaceMiddleware);
  app.use(`/api/${e.name}/*`, workspaceMiddleware);
}
app.route("/api", createEntityRoutes({ entities: declarations }));

type Reply = { status: number; body: Record<string, any> | null };
async function call(method: string, path: string, user: string | null, workspace: string | null, body?: unknown): Promise<Reply> {
  const headers: Record<string, string> = { ...(user ? { "x-test-user": user } : {}), ...(workspace ? { "x-workspace-id": workspace } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) };
  const response = await app.fetch(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body) }), { DB: db });
  return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, any> | null };
}
const create = (path: string, user: string, ws: string, body: unknown) => call("POST", path, user, ws, body);

beforeEach(async () => {
  expect.hasAssertions();
  for (const table of ["ent_invoices", "ent_tasks", "mw_members", "mw_workspaces"]) await db.prepare(`DROP TABLE IF EXISTS "${table}"`).run();
  await applyMigration(db, mwMigration);
  for (const e of parsed.entities) await applyMigration(db, entityDdl(e));
  for (const [ws, owner] of [["ws-a", "alice"], ["ws-b", "bob"]] as const) {
    await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES (?, ?, ?)").bind(ws, ws, owner).run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").bind(ws, owner).run();
  }
});

describe("create, read, update, delete and list", () => {
  it("creates a row in the caller's workspace and returns it with an id and timestamps", async () => {
    const res = await create("/api/invoices", "alice", "ws-a", { client_name: "Acme", amount: 120, status: "draft" });
    expect(res.status).toBe(201);
    expect(res.body!.item).toMatchObject({ client_name: "Acme", amount: 120, status: "draft" });
    expect(res.body!.item.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body!.item.created_at).toBeTruthy();
    const row = await db.prepare('SELECT workspace_id FROM "ent_invoices" WHERE id = ?').bind(res.body!.item.id).first<{ workspace_id: string }>();
    expect(row?.workspace_id).toBe("ws-a");
  });

  it("reads it back by id", async () => {
    const id = (await create("/api/invoices", "alice", "ws-a", { client_name: "Acme" })).body!.item.id;
    const res = await call("GET", `/api/invoices/${id}`, "alice", "ws-a");
    expect(res.status).toBe(200);
    expect(res.body!.item).toMatchObject({ id, client_name: "Acme", amount: null, status: null });
  });

  it("updates only the fields sent, and touches updated_at", async () => {
    const id = (await create("/api/invoices", "alice", "ws-a", { client_name: "Acme", amount: 1, status: "draft" })).body!.item.id;
    await db.prepare('UPDATE "ent_invoices" SET updated_at = ? WHERE id = ?').bind("2000-01-01 00:00:00", id).run();
    const res = await call("PATCH", `/api/invoices/${id}`, "alice", "ws-a", { status: "paid" });
    expect(res.status).toBe(200);
    expect(res.body!.item).toMatchObject({ client_name: "Acme", amount: 1, status: "paid" });
    expect(res.body!.item.updated_at).not.toBe("2000-01-01 00:00:00");
  });

  it("an optional field can be set back to empty, a required one cannot", async () => {
    const id = (await create("/api/invoices", "alice", "ws-a", { client_name: "Acme", amount: 5 })).body!.item.id;
    expect((await call("PATCH", `/api/invoices/${id}`, "alice", "ws-a", { amount: null })).body!.item.amount).toBeNull();
    expect((await call("PATCH", `/api/invoices/${id}`, "alice", "ws-a", { client_name: null })).status).toBe(400);
  });

  it("deletes, and the row is gone", async () => {
    const id = (await create("/api/invoices", "alice", "ws-a", { client_name: "Acme" })).body!.item.id;
    expect(await call("DELETE", `/api/invoices/${id}`, "alice", "ws-a")).toMatchObject({ status: 200, body: { deleted: true } });
    expect((await call("GET", `/api/invoices/${id}`, "alice", "ws-a")).status).toBe(404);
    expect((await call("DELETE", `/api/invoices/${id}`, "alice", "ws-a")).status).toBe(404);
  });

  it("lists newest first with a total, and pages", async () => {
    for (let i = 1; i <= 5; i += 1) {
      const id = (await create("/api/invoices", "alice", "ws-a", { client_name: `c${i}` })).body!.item.id;
      await db.prepare('UPDATE "ent_invoices" SET created_at = ? WHERE id = ?').bind(`2026-01-0${i} 00:00:00`, id).run();
    }
    const first = await call("GET", "/api/invoices?limit=2", "alice", "ws-a");
    expect(first.body!.items.map((i: { client_name: string }) => i.client_name)).toEqual(["c5", "c4"]);
    expect(first.body).toMatchObject({ total: 5, limit: 2, offset: 0 });
    const next = await call("GET", "/api/invoices?limit=2&offset=4", "alice", "ws-a");
    expect(next.body!.items.map((i: { client_name: string }) => i.client_name)).toEqual(["c1"]);
  });

  it("an empty list is an empty list", async () => {
    expect((await call("GET", "/api/invoices", "alice", "ws-a")).body).toEqual({ items: [], total: 0, limit: 50, offset: 0 });
  });
});

describe("every field type", () => {
  it("booleans go in as true and false and come out as true and false", async () => {
    const made = await create("/api/tasks", "alice", "ws-a", { title: "t", done: false });
    expect(made.body!.item).toMatchObject({ done: false, points: null });
    const id = made.body!.item.id;
    expect((await call("PATCH", `/api/tasks/${id}`, "alice", "ws-a", { done: true })).body!.item.done).toBe(true);
    const stored = await db.prepare('SELECT done FROM "ent_tasks" WHERE id = ?').bind(id).first<{ done: number }>();
    expect(stored?.done).toBe(1);
  });

  it.each([
    ["a missing required field", "/api/invoices", {}],
    ["a null required field", "/api/invoices", { client_name: null }],
    ["a number as text", "/api/invoices", { client_name: 5 }],
    ["text as a number", "/api/invoices", { client_name: "a", amount: "12" }],
    ["a fractional number", "/api/invoices", { client_name: "a", amount: 1.5 }],
    ["an enormous number", "/api/invoices", { client_name: "a", amount: 1e300 }],
    ["not-a-number", "/api/invoices", { client_name: "a", amount: null, status: 5 }],
    ["an enum value outside the list", "/api/invoices", { client_name: "a", status: "refunded" }],
    ["an enum value in the wrong case", "/api/invoices", { client_name: "a", status: "Paid" }],
    ["text longer than its limit", "/api/tasks", { title: "x".repeat(21), done: true }],
    ["a number above its maximum", "/api/tasks", { title: "t", done: true, points: 6 }],
    ["a number below its minimum", "/api/tasks", { title: "t", done: true, points: 0 }],
    ["a boolean as text", "/api/tasks", { title: "t", done: "true" }],
    ["a boolean as a number", "/api/tasks", { title: "t", done: 1 }],
    ["an array as the body", "/api/invoices", [{ client_name: "a" }]],
    ["a string as the body", "/api/invoices", '"hello"'],
    ["a body that is not JSON", "/api/invoices", "{not json"],
    ["an object where text belongs", "/api/invoices", { client_name: { $ne: "" } }],
  ])("%s is rejected with 400 and stores nothing", async (_label, path, body) => {
    const res = await create(path, "alice", "ws-a", body);
    expect(res.status).toBe(400);
    expect((await db.prepare(`SELECT COUNT(*) AS n FROM "ent_${path.slice(5)}"`).first<{ n: number }>())!.n).toBe(0);
  });

  it("an update with nothing declared in it is rejected, and an update of a bad value leaves the row alone", async () => {
    const id = (await create("/api/invoices", "alice", "ws-a", { client_name: "Acme", amount: 5 })).body!.item.id;
    expect((await call("PATCH", `/api/invoices/${id}`, "alice", "ws-a", {})).status).toBe(400);
    expect((await call("PATCH", `/api/invoices/${id}`, "alice", "ws-a", { workspace_id: "ws-b", made_up: 1 })).status).toBe(400);
    expect((await call("PATCH", `/api/invoices/${id}`, "alice", "ws-a", { amount: "lots" })).status).toBe(400);
    expect((await call("GET", `/api/invoices/${id}`, "alice", "ws-a")).body!.item).toMatchObject({ client_name: "Acme", amount: 5 });
  });
});

describe("the declaration is the only source of names", () => {
  it("a column the declaration does not contain is dropped from a create, not stored and not an error", async () => {
    const res = await create("/api/invoices", "alice", "ws-a", { client_name: "Acme", secret_column: "x", "status\" = 'x', \"workspace_id": "ws-b" });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body!.item).sort()).toEqual(["amount", "client_name", "created_at", "id", "status", "updated_at"]);
    expect((await db.prepare('SELECT workspace_id FROM "ent_invoices"').first<{ workspace_id: string }>())?.workspace_id).toBe("ws-a");
  });

  it("an entity the declaration does not contain has no route", async () => {
    expect((await call("GET", "/api/anything_else", "alice", "ws-a")).status).toBe(404);
    expect((await call("POST", "/api/ent_invoices", "alice", "ws-a", { client_name: "a" })).status).toBe(404);
  });

  it("a bad declaration stops the router from being built, instead of being served", () => {
    expect(() => createEntityRoutes({ entities: [{ name: "x; DROP TABLE y", fields: [{ name: "a", type: "text" }] }] })).toThrow(/invalid entity declaration/);
    expect(() => createEntityRoutes({ entities: "invoices" })).toThrow(/invalid entity declaration/);
    expect(() => createEntityRoutes({ entities: [{ name: "x", fields: [{ name: "id", type: "text" }] }] })).toThrow(/invalid entity declaration/);
  });

  it("no entities means no routes, and not an error", async () => {
    const bare = new Hono<WorkspaceEnv>();
    bare.route("/api", createEntityRoutes({ entities: [] }));
    expect((await bare.fetch(new Request("http://localhost/api/invoices"), { DB: db })).status).toBe(404);
  });
});

describe("fails closed and says little", () => {
  it("no identity is 401 and no workspace is 400, on every route", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    for (const [method, path, body] of [["POST", "/api/invoices", { client_name: "a" }], ["GET", "/api/invoices", undefined], ["GET", `/api/invoices/${id}`, undefined], ["PATCH", `/api/invoices/${id}`, { amount: 1 }], ["DELETE", `/api/invoices/${id}`, undefined]] as const) {
      expect((await call(method, path, null, "ws-a", body)).status, `${method} ${path} without identity`).toBe(401);
      expect((await call(method, path, "alice", null, body)).status, `${method} ${path} without workspace`).toBe(400);
    }
  });

  it("routes mounted WITHOUT the guard fail closed instead of guessing a workspace", async () => {
    const unguarded = new Hono<WorkspaceEnv>();
    unguarded.use("/api/*", stubIdentity);
    unguarded.route("/api", createEntityRoutes({ entities: declarations }));
    const res = await unguarded.fetch(new Request("http://localhost/api/invoices", { headers: { "x-test-user": "alice", "x-workspace-id": "ws-a" } }), { DB: db });
    expect(res.status).toBe(400);
  });

  it("a database failure is a generic 500 that does not leak the cause", async () => {
    await db.prepare('DROP TABLE "ent_invoices"').run();
    for (const res of [await call("GET", "/api/invoices", "alice", "ws-a"), await create("/api/invoices", "alice", "ws-a", { client_name: "a" })]) {
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).toBe('{"error":"Internal error"}');
    }
  });
});
