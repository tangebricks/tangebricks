// Story 1.10 (threat model audit 22; A1, suspension part; PROPOSED-3), against the assembled max-compatible app in
// workerd:
//
//   DELETE   Workspaces A and B both hold rows in every table an enabled brick declares in `workspaceData` (and in the
//            declared entity's table and the shell's px_schedules), and objects under binary-assets' declared prefix.
//            A member or an admin of A cannot delete it. When the owner deletes A, every A row goes from those tables
//            (a tombstone table without a deleted_at column, such as the audit and money records, keeps its rows),
//            A's objects go, every B row and object stays as it was, and no other table changes apart from the
//            multi-workspace brick's own rows for A.
//   SUSPEND  With A suspended, every route behind the workspace guard answers A with 403 WORKSPACE_SUSPENDED, including
//            llm-gateway's /api/ai/generate and the wallet, apart from the assembler's allowlist (the data-subject
//            privacy routes); B is not affected; and no header or query lifts the suspension.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { Hono } from "hono";
import type { D1Like } from "@poc/sdk";
import { catalog } from "../catalog.generated.ts";
import { SUSPENSION_EXEMPT, exemptPathPattern } from "../src/assemble.ts";
import { computeMaxCompatible } from "../../../scripts/max-compatible.ts";
import { call, joinAsMember, resetAndMigrate } from "./support/assembled-app.ts";
import type { App } from "./support/assembled-app.ts";

interface HonoRoute {
  method: string;
  path: string;
  handler: { name?: string; length?: number };
}
interface HonoLike {
  routes: HonoRoute[];
}

// The entry's default export is `{ fetch, ... }`, so its Hono instance is captured while the module is first evaluated
// (as in cross-tenant.fuzz.test.ts) to read the route table.
const routeCalls: HonoLike[] = [];
const honoProto = Hono.prototype as unknown as { route: (this: HonoLike, path: string, sub: HonoLike) => unknown };
const originalRoute = honoProto.route;
honoProto.route = function (this: HonoLike, path: string, sub: HonoLike) {
  routeCalls.push(this);
  return originalRoute.call(this, path, sub);
};
const entryLoaders = import.meta.glob("../../../out/max-compatible/src/index.ts") as Record<string, () => Promise<{ default: App }>>;
let loaded: { default: App } | undefined;
try {
  loaded = await Object.values(entryLoaders)[0]?.();
} finally {
  honoProto.route = originalRoute;
}
const app = loaded?.default;
const honoApp = routeCalls.find((a) => a.routes.some((r) => r.path === "/healthz"));
const sql = import.meta.glob("../../../out/max-compatible/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const db = env.DB as unknown as D1Like;

// The declared per-workspace tables of the bricks in max-compatible, read from the catalog the app was assembled from.
const maxSet = computeMaxCompatible(catalog);
const declared: Array<{ brick: string; table: string; tombstone: boolean }> = [
  ...maxSet.bricks.flatMap((id) =>
    (catalog.bricks[id]!.manifest.workspaceData?.tables ?? []).map((t) => ({ brick: id, table: t.table, tombstone: t.tombstone === true })),
  ),
  // global-setup declares one entity, "records", for max-compatible.
  { brick: "entity", table: "ent_records", tombstone: false },
  // The shell's schedule mirror, purged because each row belongs to one workspace.
  { brick: "shell", table: "px_schedules", tombstone: false },
];
const bucket = (env as unknown as {
  BUCKET: { put(key: string, value: string): Promise<unknown>; list(o: { prefix: string }): Promise<{ objects: Array<{ key: string }> }> };
}).BUCKET;

// What the allowlisted privacy routes and B's AI call answer (the routes' own answers, not the suspension check's).
const EXPORT_STATUS = 201;
const ERASURE_STATUS = 201;
// B reaches the AI route itself: no provider is connected in tests, so it answers 503 NOT_CONFIGURED (not 403).
const B_AI_STATUS = 503;

async function keysUnder(prefix: string): Promise<string[]> {
  return (await bucket.list({ prefix })).objects.map((o) => o.key).sort();
}
/**
 * Routes of max-compatible that are outside the suspension check on purpose, each with its reason. Any other route
 * that is neither behind the check nor on SUSPENSION_EXEMPT fails the coverage assertion.
 */
const NOT_WORKSPACE_SCOPED: ReadonlyArray<{ method: string; path: RegExp; reason: string }> = [
  { method: "GET", path: /^\/(healthz|readyz|openapi\.json)$/, reason: "platform probes and the API description; no workspace" },
  { method: "*", path: /^\/api\/auth\/[a-z-]+(\/[a-z-]+)?$/, reason: "sign-up, sign-in, session and password routes act for a user, not a workspace" },
  { method: "*", path: /^\/api\/(me\/(profile|preferences)|users\/:id\/profile)$/, reason: "user-profile: the caller's own account, not workspace data" },
  { method: "POST", path: /^\/api\/payments\/verify$/, reason: "a payment already charged must still complete and be credited (story 0.21); no workspace guard" },
  { method: "POST", path: /^\/api\/webhooks\/(in\/:subscriptionId|ingress\/:slug)$/, reason: "inbound webhooks are signed by the sender and carry no workspace context" },
  { method: "POST", path: /^\/api\/(payments|checkout)\/webhook$/, reason: "payment provider webhooks (story 2.3) are signed by the provider and carry no workspace context; a payment already charged must still be recorded" },
  { method: "*", path: /^\/api\/workspaces(\/.*)?$/, reason: "multi-workspace's own routes: creating/listing take no workspace; the workspace-scoped writes check suspension in the handler" },
];

const MULTI_WORKSPACE_TABLES =new Set(["mw_workspaces", "mw_members", "mw_invites"]);

interface Column {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

async function columnsOf(table: string): Promise<Column[]> {
  return (await db.prepare(`PRAGMA table_info("${table}")`).all<Column>()).results;
}

let serial = 0;

/** A value for one column of a seeded row: unique per row, of the column's type, and the workspace for workspace_id. */
function valueFor(table: string, column: Column, ws: string): unknown {
  if (column.name === "workspace_id") return ws;
  const type = column.type.toUpperCase();
  if (type.includes("INT")) return column.pk ? 1_000_000 + serial : 1;
  if (type.includes("REAL") || type.includes("NUM") || type.includes("FLOA") || type.includes("DOUB")) return 1;
  if (type.includes("BLOB")) return null;
  return `${table}-${column.name}-${ws}-${serial}`;
}

/** A value of `parent.column` that `ws` may point at: an existing row (of ws when the parent is per-workspace), or a new one. */
async function parentValue(parent: string, column: string | null, ws: string): Promise<unknown> {
  const columns = await columnsOf(parent);
  const target = column ?? columns.find((c) => c.pk)?.name ?? "rowid";
  const perWorkspace = columns.some((c) => c.name === "workspace_id");
  const row = perWorkspace
    ? await db.prepare(`SELECT "${target}" AS v FROM "${parent}" WHERE workspace_id = ? LIMIT 1`).bind(ws).first<{ v: unknown }>()
    : await db.prepare(`SELECT "${target}" AS v FROM "${parent}" LIMIT 1`).first<{ v: unknown }>();
  if (row) return row.v;
  return (await seedRow(parent, ws))[target];
}

/**
 * Writes one row for `ws` into `table` straight through SQL, so every declared table holds data whatever its routes
 * accept. CHECK constraints are ignored while seeding (the values are synthetic); foreign keys stay on, so each one
 * points at a real parent row (seeded first when there is none). Returns the values written.
 */
async function seedRow(table: string, ws: string): Promise<Record<string, unknown>> {
  serial += 1;
  const columns = await columnsOf(table);
  const values: Record<string, unknown> = Object.fromEntries(columns.map((c) => [c.name, valueFor(table, c, ws)]));
  const foreignKeys = (await db.prepare(`PRAGMA foreign_key_list("${table}")`).all<{ table: string; from: string; to: string | null }>()).results;
  for (const fk of foreignKeys) {
    const nullable = !columns.find((c) => c.name === fk.from)?.notnull;
    values[fk.from] = fk.table === table && nullable ? null : await parentValue(fk.table, fk.to, ws);
  }
  const names = columns.map((c) => `"${c.name}"`).join(", ");
  const marks = columns.map(() => "?").join(", ");
  await db.prepare(`INSERT INTO "${table}" (${names}) VALUES (${marks})`).bind(...columns.map((c) => values[c.name])).run();
  return values;
}

async function rowsOf(table: string, ws: string): Promise<Array<Record<string, unknown>>> {
  return (await db.prepare(`SELECT * FROM "${table}" WHERE workspace_id = ? ORDER BY rowid`).bind(ws).all()).results;
}

/** Row count of every table in the database, keyed by table name. */
async function countAll(): Promise<Record<string, number>> {
  const tables = (
    await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '%_fts_%' ORDER BY name")
      .all<{ name: string }>()
  ).results;
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    counts[name] = (await db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).first<{ n: number }>())!.n;
  }
  return counts;
}

async function newWorkspace(owner: string, name: string): Promise<string> {
  const created = await call(app!, "POST", "/api/workspaces", { user: owner, body: { name } });
  expect(created.status).toBe(201);
  return (JSON.parse(created.text) as { workspace: { id: string } }).workspace.id;
}

describe("workspace delete cascade in the assembled max-compatible app (story 1.10)", () => {
  test("deleting A removes A's rows from every declared table and keeps B's rows and every other table as they were", async () => {
    expect(app, "out/max-compatible/src/index.ts was not assembled").toBeDefined();
    await resetAndMigrate(db, sql);
    expect(declared.length).toBeGreaterThan(30);

    const wsA = await newWorkspace("alice", "Workspace A");
    const wsB = await newWorkspace("bob", "Workspace B");
    // A real member, a real admin and an open invite in A, so the multi-workspace brick's own rows are covered too.
    await joinAsMember(app!, wsA, "alice", "carol");
    const adminInvite = await call(app!, "POST", `/api/workspaces/${wsA}/invites`, { user: "alice", body: { role: "admin" } });
    expect(adminInvite.status).toBe(201);
    const accepted = await call(app!, "POST", `/api/workspaces/invites/${(JSON.parse(adminInvite.text) as { token: string }).token}/accept`, { user: "dave" });
    expect(accepted.status).toBe(200);
    const invite = await call(app!, "POST", `/api/workspaces/${wsA}/invites`, { user: "alice", body: { role: "member" } });
    expect(invite.status).toBe(201);

    // Objects under binary-assets' declared prefix, for both workspaces, and one key outside any workspace prefix.
    for (const ws of [wsA, wsB]) {
      for (const n of [1, 2, 3]) await bucket.put(`workspaces/${ws}/assets/asset-${n}/file.txt`, `data ${ws} ${n}`);
    }
    await bucket.put(`unrelated/${wsA}/keep.txt`, "keep");
    const bObjects = await keysUnder(`workspaces/${wsB}/`);
    expect(bObjects).toHaveLength(3);

    await db.prepare("PRAGMA ignore_check_constraints = ON").run();
    try {
      for (const { table } of declared) {
        await seedRow(table, wsA);
        await seedRow(table, wsB);
      }
    } finally {
      await db.prepare("PRAGMA ignore_check_constraints = OFF").run();
    }
    for (const { table } of declared) {
      expect((await rowsOf(table, wsA)).length, `${table} seeded for A`).toBeGreaterThan(0);
      expect((await rowsOf(table, wsB)).length, `${table} seeded for B`).toBeGreaterThan(0);
    }

    const bBefore = new Map<string, Array<Record<string, unknown>>>();
    for (const { table } of declared) bBefore.set(table, await rowsOf(table, wsB));
    const countsBefore = await countAll();

    // Only the owner may delete: a stranger, a member and an admin are refused, and nothing moves.
    expect((await call(app!, "DELETE", `/api/workspaces/${wsA}`, { user: "mallory" })).status).toBe(404);
    expect((await call(app!, "DELETE", `/api/workspaces/${wsA}`, { user: "carol" })).status).toBe(403);
    expect((await call(app!, "DELETE", `/api/workspaces/${wsA}`, { user: "dave" })).status).toBe(403);
    // An admin cannot mint an owner invite to get there.
    expect((await call(app!, "POST", `/api/workspaces/${wsA}/invites`, { user: "dave", body: { role: "owner" } })).status).toBe(403);
    expect(await countAll()).toEqual(countsBefore);
    expect(await keysUnder(`workspaces/${wsA}/`)).toHaveLength(3);

    const deleted = await call(app!, "DELETE", `/api/workspaces/${wsA}`, { user: "alice" });
    expect(deleted.status, deleted.text).toBe(200);

    for (const { brick, table, tombstone } of declared) {
      const aRows = await rowsOf(table, wsA);
      const hasDeletedAt = (await columnsOf(table)).some((c) => c.name === "deleted_at");
      if (tombstone && !hasDeletedAt) {
        // Declared tombstone (kept for audit) without a deleted_at column: kept as it was.
        expect(aRows.length, `${brick} ${table} keeps A's audit rows`).toBeGreaterThan(0);
      } else if (tombstone) {
        expect(aRows.every((r) => r.deleted_at !== null), `${brick} ${table} marks A's rows deleted`).toBe(true);
      } else {
        expect(aRows, `${brick} ${table} still holds rows of the deleted workspace`).toEqual([]);
      }
      expect(await rowsOf(table, wsB), `${brick} ${table}: B's rows changed`).toEqual(bBefore.get(table));
    }

    // Every table that is neither declared nor the multi-workspace brick's own is untouched (global and platform tables
    // included); the multi-workspace rows of A are gone and B's remain.
    const countsAfter = await countAll();
    const declaredNames = new Set(declared.map((d) => d.table));
    for (const [table, count] of Object.entries(countsBefore)) {
      if (declaredNames.has(table) || MULTI_WORKSPACE_TABLES.has(table)) continue;
      expect(countsAfter[table], `${table} is not declared and must not change`).toBe(count);
    }
    expect(await db.prepare("SELECT COUNT(*) AS n FROM mw_workspaces WHERE id = ?").bind(wsA).first<{ n: number }>()).toEqual({ n: 0 });
    expect(await rowsOf("mw_members", wsA)).toEqual([]);
    expect(await rowsOf("mw_invites", wsA)).toEqual([]);
    expect((await rowsOf("mw_members", wsB)).length).toBe(1);
    expect((await call(app!, "GET", "/api/wallet", { user: "bob", ws: wsB })).status).toBe(200);

    // A's objects are gone, B's and the key outside every workspace prefix remain.
    expect(await keysUnder(`workspaces/${wsA}/`)).toEqual([]);
    expect(await keysUnder(`workspaces/${wsB}/`)).toEqual(bObjects);
    expect(await keysUnder(`unrelated/${wsA}/`)).toEqual([`unrelated/${wsA}/keep.txt`]);
  });
});

describe("payment webhooks in the assembled max-compatible app are unguarded (story 2.3)", () => {
  test.each(["/api/payments/webhook", "/api/checkout/webhook"])("POST %s with no user and no workspace reaches the brick: 503 NOT_CONFIGURED", async (path) => {
    expect(app, "out/max-compatible/src/index.ts was not assembled").toBeDefined();
    await resetAndMigrate(db, sql);
    const res = await call(app!, "POST", path, { body: { data: {} } });
    expect(res.status, res.text.slice(0, 300)).toBe(503);
    expect((JSON.parse(res.text) as { code?: string }).code).toBe("NOT_CONFIGURED");
  });
});

describe("suspension enforcement in the assembled max-compatible app (story 1.10)", () => {
  /** The paths `notSuspended` is mounted at, as Hono matches them ("/x/*" also matches "/x"). */
  function suspensionGuards(): RegExp[] {
    return honoApp!.routes
      .filter((r) => r.method === "ALL" && (r.handler?.name ?? "").startsWith("notSuspended"))
      .map((r) => {
        const base = r.path.replace(/\/\*$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(r.path.endsWith("/*") ? `^${base}(?:/.*)?$` : `^${base}$`);
      });
  }

  function expectSuspended(res: { status: number; text: string }, label: string): void {
    expect(res.status, `${label}: ${res.text.slice(0, 300)}`).toBe(403);
  if (!res.text.includes("WORKSPACE_SUSPENDED")) throw new Error(`${label}: ${res.status} ${res.text.slice(0, 300)}`);
    expect((JSON.parse(res.text) as { code?: string }).code, label).toBe("WORKSPACE_SUSPENDED");
  }

  test("a suspended workspace gets 403 WORKSPACE_SUSPENDED on every guarded route; B and the allowlist are not affected", async () => {
    expect(app, "out/max-compatible/src/index.ts was not assembled").toBeDefined();
    expect(honoApp, "the assembled app's route table").toBeDefined();
    await resetAndMigrate(db, sql);
    const wsA = await newWorkspace("alice", "Workspace A");
    const wsB = await newWorkspace("bob", "Workspace B");

    // Before suspension A works as before.
    expect((await call(app!, "GET", "/api/wallet", { user: "alice", ws: wsA })).status).toBe(200);
    await db.prepare("UPDATE mw_workspaces SET suspended = 1 WHERE id = ?").bind(wsA).run();

    // The named sample: AI generation (threat model A1), the wallet, notifications, the declared entity.
    expectSuspended(await call(app!, "POST", "/api/ai/generate", { user: "alice", ws: wsA, body: { prompt: "hello" } }), "POST /api/ai/generate");
    expectSuspended(await call(app!, "GET", "/api/ai/usage", { user: "alice", ws: wsA }), "GET /api/ai/usage");
    expectSuspended(await call(app!, "GET", "/api/wallet", { user: "alice", ws: wsA }), "GET /api/wallet");
    expectSuspended(await call(app!, "POST", "/api/wallet/deduct", { user: "alice", ws: wsA, body: { amount: 1, reason: "x" } }), "POST /api/wallet/deduct");
    expectSuspended(await call(app!, "POST", "/api/payments/create-order", { user: "alice", ws: wsA, body: { amount: 100 } }), "POST /api/payments/create-order");
    expectSuspended(await call(app!, "GET", "/api/notifications", { user: "alice", ws: wsA }), "GET /api/notifications");
    expectSuspended(await call(app!, "POST", "/api/records", { user: "alice", ws: wsA, body: { title: "t" } }), "POST /api/records");

    // Nothing the caller sends lifts it: a query, extra headers or a body naming another workspace or state.
    expectSuspended(await call(app!, "GET", "/api/wallet?suspended=0&workspaceId=" + wsB, { user: "alice", ws: wsA }), "query");
    expectSuspended(
      await call(app!, "POST", "/api/ai/generate", {
        user: "alice",
        ws: wsA,
        body: { prompt: "hello", suspended: false, workspaceId: wsB },
        headers: { "x-workspace-suspended": "0", "x-http-method-override": "GET" },
      }),
      "headers and body",
    );

    // The workspace brick's own GETs (no workspace guard) still answer for A and show that it is suspended.
    const own = await call(app!, "GET", "/api/workspaces", { user: "alice", ws: wsA });
    expect(own.status).toBe(200);
    expect((JSON.parse(own.text) as { workspaces: Array<{ id: string; suspended: boolean }> }).workspaces).toEqual([
      expect.objectContaining({ id: wsA, suspended: true }),
    ]);
    const detail = await call(app!, "GET", `/api/workspaces/${wsA}`, { user: "alice", ws: wsA });
    expect(detail.status).toBe(200);
    expect((JSON.parse(detail.text) as { workspace: { suspended: boolean } }).workspace.suspended).toBe(true);
    // Its writes are refused there too.
    expectSuspended(await call(app!, "POST", `/api/workspaces/${wsA}/invites`, { user: "alice", body: { role: "member" } }), "invite");
    expectSuspended(await call(app!, "DELETE", `/api/workspaces/${wsA}`, { user: "alice" }), "delete");

    // Every route behind the suspension check, swept from the route table. An allowlisted route answers; every other
    // one is refused.
    const guards = suspensionGuards();
    expect(guards.length).toBeGreaterThan(20);
    const isExempt = (method: string, path: string) => SUSPENSION_EXEMPT.some((e) => e.method === method && new RegExp(exemptPathPattern(e.path)).test(path));
    const swept: string[] = [];
    const exemptAnswers: Record<string, number> = {};
    const exempted: Array<{ method: string; path: string; concrete: string }> = [];
    for (const r of honoApp!.routes) {
      if (r.method === "ALL") continue;
      const path = r.path.replace(/(:[A-Za-z0-9_]+)\{[^}]*\}/g, "$1").replace(/(:[A-Za-z0-9_]+)\?/g, "$1");
      const concrete = path.replace(/:[A-Za-z0-9_]+/g, "p1");
      if (!guards.some((g) => g.test(concrete))) continue;
      swept.push(`${r.method} ${path}`);
      if (isExempt(r.method, concrete)) {
        exempted.push({ method: r.method, path, concrete });
        continue;
      }
      expectSuspended(await call(app!, r.method, concrete, { user: "alice", ws: wsA, body: {} }), `${r.method} ${path}`);
    }
    // The allowlisted routes are called last, the erasure request last of all: it removes the caller's own membership.
    const rank = (e: { method: string; path: string }) => (e.method === "GET" ? 0 : e.path.includes("erasure") ? 2 : 1);
    for (const e of exempted.sort((x, y) => rank(x) - rank(y))) {
      exemptAnswers[`${e.method} ${e.path}`] = (await call(app!, e.method, e.concrete, { user: "alice", ws: wsA, body: {} })).status;
    }
    for (const sample of ["POST /api/ai/generate", "GET /api/wallet", "POST /api/wallet/deduct", "POST /api/privacy/consents", "DELETE /api/privacy/workspace"]) {
      expect(swept).toContain(sample);
    }
    // Coverage: every route of the app is behind the suspension check, or on the allowlist, or on NOT_WORKSPACE_SCOPED.
    const uncovered: string[] = [];
    for (const r of honoApp!.routes) {
      if (r.method === "ALL") continue;
      const path = r.path.replace(/(:[A-Za-z0-9_]+)\{[^}]*\}/g, "$1").replace(/(:[A-Za-z0-9_]+)\?/g, "$1");
      const concrete = path.replace(/:[A-Za-z0-9_]+/g, "p1");
      if (guards.some((g) => g.test(concrete)) || isExempt(r.method, concrete)) continue;
      if (NOT_WORKSPACE_SCOPED.some((n) => (n.method === "*" || n.method === r.method) && n.path.test(path))) continue;
      uncovered.push(`${r.method} ${path}`);
    }
    expect([...new Set(uncovered)].sort(), "routes outside the suspension check with no reason").toEqual([]);
    // The allowlist is not dead: every entry is a route that really sits behind the check, and each one answers A.
    for (const e of SUSPENSION_EXEMPT) {
      expect(Object.keys(exemptAnswers), `${e.method} ${e.path} sits behind the suspension check`).toContain(`${e.method} ${e.path}`);
    }
    expect(exemptAnswers).toEqual({
      "POST /api/privacy/export": EXPORT_STATUS,
      "GET /api/privacy/export/:id": 404,
      "POST /api/privacy/erasure": ERASURE_STATUS,
      "GET /api/privacy/erasure/:id": 404,
    });

    // B is not affected.
    expect((await call(app!, "GET", "/api/wallet", { user: "bob", ws: wsB })).status).toBe(200);
    expect((await call(app!, "GET", "/api/notifications", { user: "bob", ws: wsB })).status).toBe(200);
    const bAi = await call(app!, "POST", "/api/ai/generate", { user: "bob", ws: wsB, body: { prompt: "hello" } });
    expect(bAi.status, bAi.text).toBe(B_AI_STATUS);

  });
});
