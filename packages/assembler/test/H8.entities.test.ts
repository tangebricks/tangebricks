import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, test } from "vitest";
import { record } from "@poc/harness";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";

// H8: a declared entity becomes tenant-safe CRUD in the assembled project.
//
// Written and owned by this repository; the assembler does not produce it. It drives the project the setup step wrote
// to out/invoice-flow/ (bricks: workspaces, wallet, dynamic entities; one declared entity: invoices) through its public
// routes, as members of two workspaces and as strangers. Titles are fixed in h8-entity-tests.json: renaming, skipping or
// removing one makes H8 fail.
interface App {
  fetch(request: Request, env: unknown): Response | Promise<Response>;
}
const entry = import.meta.glob("../../../out/invoice-flow/src/index.ts", { eager: true }) as Record<string, { default: App }>;
const sql = import.meta.glob("../../../out/invoice-flow/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const app = Object.values(entry)[0]?.default;
const db = env.DB as D1Like;

type Reply = { status: number; body: Record<string, any> | null; text: string };
interface Options {
  query?: string;
  headers?: Record<string, string>;
}
async function call(method: string, path: string, user: string | null, workspace: string | null, body?: unknown, options: Options = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...(user ? { "x-test-user": user } : {}), ...(workspace ? { "x-workspace-id": workspace } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...options.headers };
  const response = await app!.fetch(new Request(`http://localhost${path}${options.query ?? ""}`, { method, headers, body: body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body) }), { DB: db });
  const text = await response.text();
  let parsed: Record<string, any> | null = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, body: parsed, text };
}

interface World {
  a: string;
  b: string;
  aIds: string[];
  bIds: string[];
}
const ALL_TABLES = ["credit_ledger", "credit_orders", "credit_wallets", "mw_members", "mw_workspaces", "ent_invoices"];
const snapshot = async (workspace: string) => JSON.stringify((await db.prepare('SELECT * FROM "ent_invoices" WHERE workspace_id = ? ORDER BY id').bind(workspace).all()).results);
const countRows = async (workspace: string) => (await db.prepare('SELECT COUNT(*) AS n FROM "ent_invoices" WHERE workspace_id = ?').bind(workspace).first<{ n: number }>())!.n;
// In whole credits: the wallet holds thousandths since credit-wallet's migration 0004 (story 2.5).
const balanceOf = async (workspace: string) => {
  const milli = (await db.prepare("SELECT balance_milli FROM credit_wallets WHERE workspace_id = ?").bind(workspace).first<{ balance_milli: number }>())?.balance_milli;
  return milli === undefined ? undefined : milli / 1000;
};

/** An empty database with the project's own migrations; two tenants made through the project's API; three invoices for A, two for B. */
async function world(): Promise<World> {
  for (const table of ALL_TABLES) await db.prepare(`DROP TABLE IF EXISTS "${table}"`).run();
  for (const path of Object.keys(sql).sort()) await applyMigration(db, sql[path]!);
  const workspace = async (user: string, name: string) => (await call("POST", "/api/workspaces", user, null, { name })).body!.workspace.id as string;
  const a = await workspace("alice", "A");
  const b = await workspace("bob", "B");
  for (const [user, ws, balance] of [["alice", a, 100], ["bob", b, 50]] as const) {
    await call("GET", "/api/wallet", user, ws);
    await db.prepare("UPDATE credit_wallets SET balance_milli = ? WHERE workspace_id = ?").bind(balance * 1000, ws).run();
  }
  await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, 'carol', 'member')").bind(a).run();
  const seed = async (user: string, ws: string, names: string[]) => {
    const ids: string[] = [];
    for (const [i, name] of names.entries()) {
      const id = (await call("POST", "/api/invoices", user, ws, { client_name: name, amount: 100 + i, status: "draft" })).body!.item.id as string;
      await db.prepare('UPDATE "ent_invoices" SET created_at = ? WHERE id = ?').bind(`2026-01-0${i + 1} 00:00:00`, id).run();
      ids.push(id);
    }
    return ids;
  };
  return { a, b, aIds: await seed("alice", a, ["A-Acme", "A-Globex", "A-Initech"]), bIds: await seed("bob", b, ["B-Umbrella", "B-Hooli"]) };
}

const HOSTILE_TEXT = [
  "'); DROP TABLE ent_invoices; --",
  "\" OR 1=1 --",
  "Robert'); DROP TABLE mw_members;--",
  "x'; UPDATE credit_wallets SET balance = 999999; --",
  "<script>alert(1)</script>",
  "%' OR '1'='1",
  "back\\slash and \"quotes\" and 'apostrophes'",
  "ünïcödé 日本語 🧾",
  "line one\nline two\ttabbed",
  "{{$env.SECRET}} ${process.env.SECRET}",
];

describe("the assembled project is there", () => {
  it("the setup step wrote it and it answers", async () => {
    expect(app, "the setup step should have written out/invoice-flow/src/index.ts").toBeDefined();
    expect((await call("GET", "/api/invoices", null, null)).status).toBe(401);
  });
});

describe("workspace A uses its own invoices", () => {
  let w: World;
  beforeEach(async () => {
    expect.hasAssertions();
    w = await world();
  });

  it("creates an invoice", async () => {
    const res = await call("POST", "/api/invoices", "alice", w.a, { client_name: "Newco", amount: 250, status: "paid", pdf_r2_url: "https://files.example/1.pdf" });
    expect(res.status).toBe(201);
    expect(res.body!.item).toMatchObject({ client_name: "Newco", amount: 250, status: "paid", pdf_r2_url: "https://files.example/1.pdf" });
    expect((await db.prepare('SELECT workspace_id FROM "ent_invoices" WHERE id = ?').bind(res.body!.item.id).first<{ workspace_id: string }>())?.workspace_id).toBe(w.a);
    expect(await countRows(w.a)).toBe(4);
  });

  it("lists its invoices, newest first, with a total", async () => {
    const res = await call("GET", "/api/invoices", "alice", w.a);
    expect(res.status).toBe(200);
    expect(res.body!.items.map((i: { client_name: string }) => i.client_name)).toEqual(["A-Initech", "A-Globex", "A-Acme"]);
    expect(res.body).toMatchObject({ total: 3, limit: 50, offset: 0 });
  });

  it("reads an invoice by id", async () => {
    const res = await call("GET", `/api/invoices/${w.aIds[0]}`, "alice", w.a);
    expect(res.status).toBe(200);
    expect(res.body!.item).toMatchObject({ id: w.aIds[0], client_name: "A-Acme", amount: 100, status: "draft" });
  });

  it("updates an invoice, only the fields sent", async () => {
    const res = await call("PATCH", `/api/invoices/${w.aIds[1]}`, "alice", w.a, { status: "overdue" });
    expect(res.status).toBe(200);
    expect(res.body!.item).toMatchObject({ client_name: "A-Globex", amount: 101, status: "overdue" });
  });

  it("deletes an invoice", async () => {
    expect((await call("DELETE", `/api/invoices/${w.aIds[2]}`, "alice", w.a)).status).toBe(200);
    expect((await call("GET", `/api/invoices/${w.aIds[2]}`, "alice", w.a)).status).toBe(404);
    expect(await countRows(w.a)).toBe(2);
  });

  it("pages through a long list", async () => {
    for (let i = 0; i < 4; i += 1) await call("POST", "/api/invoices", "alice", w.a, { client_name: `Extra-${i}` });
    const seen = new Set<string>();
    const sizes: number[] = [];
    for (const offset of [0, 3, 6]) {
      const page = await call("GET", "/api/invoices", "alice", w.a, undefined, { query: `?limit=3&offset=${offset}` });
      sizes.push(page.body!.items.length);
      for (const item of page.body!.items) seen.add(item.id);
      expect(page.body!.total).toBe(7);
    }
    expect(sizes).toEqual([3, 3, 1]);
    expect(seen.size).toBe(7);
  });

  it("a plain member of A can use A's invoices too", async () => {
    const made = await call("POST", "/api/invoices", "carol", w.a, { client_name: "By-Carol" });
    expect(made.status).toBe(201);
    expect((await call("GET", "/api/invoices", "carol", w.a)).body!.total).toBe(4);
    expect((await call("PATCH", `/api/invoices/${made.body!.item.id}`, "carol", w.a, { amount: 7 })).status).toBe(200);
    expect((await call("DELETE", `/api/invoices/${made.body!.item.id}`, "carol", w.a)).status).toBe(200);
  });
});

describe("workspace B cannot reach workspace A's invoices", () => {
  let w: World;
  let before: string;
  beforeEach(async () => {
    expect.hasAssertions();
    w = await world();
    before = await snapshot(w.a);
  });

  it("B reading A's invoice by id", async () => {
    const res = await call("GET", `/api/invoices/${w.aIds[0]}`, "bob", w.b);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("A-Acme");
    expect(res.text).not.toContain(w.a);
  });

  it("B listing sees only B's invoices", async () => {
    const res = await call("GET", "/api/invoices", "bob", w.b);
    expect(res.body!.items.map((i: { client_name: string }) => i.client_name).sort()).toEqual(["B-Hooli", "B-Umbrella"]);
    expect(res.body!.total).toBe(2);
    expect(res.text).not.toMatch(/A-Acme|A-Globex|A-Initech/);
  });

  it("B updating A's invoice", async () => {
    const res = await call("PATCH", `/api/invoices/${w.aIds[0]}`, "bob", w.b, { client_name: "Hijacked", status: "paid" });
    expect(res.status).toBe(404);
    expect(await snapshot(w.a)).toBe(before);
  });

  it("B deleting A's invoice", async () => {
    const res = await call("DELETE", `/api/invoices/${w.aIds[0]}`, "bob", w.b);
    expect(res.status).toBe(404);
    expect(await snapshot(w.a)).toBe(before);
    expect(await countRows(w.a)).toBe(3);
  });

  it("B naming A's workspace in the header, on all five operations", async () => {
    const id = w.aIds[0];
    const replies = [
      await call("POST", "/api/invoices", "bob", w.a, { client_name: "Planted" }),
      await call("GET", "/api/invoices", "bob", w.a),
      await call("GET", `/api/invoices/${id}`, "bob", w.a),
      await call("PATCH", `/api/invoices/${id}`, "bob", w.a, { status: "paid" }),
      await call("DELETE", `/api/invoices/${id}`, "bob", w.a),
    ];
    expect(replies.map((r) => r.status)).toEqual([403, 403, 403, 403, 403]);
    expect(replies.some((r) => r.text.includes("A-Acme"))).toBe(false);
    expect(await snapshot(w.a)).toBe(before);
  });

  it("B naming A's workspace in the query string", async () => {
    const q = { query: `?workspaceId=${w.a}` };
    expect((await call("GET", "/api/invoices", "bob", null, undefined, q)).status).toBe(400); // header-only: no header is missing context
    expect((await call("POST", "/api/invoices", "bob", null, { client_name: "Planted" }, q)).status).toBe(400);
    expect((await call("DELETE", `/api/invoices/${w.aIds[0]}`, "bob", null, undefined, q)).status).toBe(400);
    expect(await snapshot(w.a)).toBe(before);
  });

  it("B naming both workspaces in one header", async () => {
    for (const value of [`${w.a},${w.b}`, `${w.a}, ${w.b}`, `${w.b} ${w.a}`, `${w.b};${w.a}`]) {
      const res = await call("DELETE", `/api/invoices/${w.aIds[0]}`, "bob", value);
      expect(res.status, value).toBeGreaterThanOrEqual(400);
      expect(await snapshot(w.a)).toBe(before);
    }
  });

  it("a stranger with no workspace of their own", async () => {
    expect((await call("GET", "/api/invoices", "mallory", w.a)).status).toBe(403);
    expect((await call("POST", "/api/invoices", "mallory", w.a, { client_name: "Planted" })).status).toBe(403);
    expect((await call("GET", "/api/invoices", "mallory", null)).status).toBe(400);
    expect((await call("GET", "/api/invoices", null, w.a)).status).toBe(401);
    expect(await snapshot(w.a)).toBe(before);
  });

  it("a hundred attempts at once against A's rows leave them as they were", async () => {
    const id = w.aIds[0];
    const attempts = Array.from({ length: 100 }, (_, i) => {
      switch (i % 5) {
        case 0:
          return call("PATCH", `/api/invoices/${id}`, "bob", w.b, { status: "paid" });
        case 1:
          return call("DELETE", `/api/invoices/${id}`, "bob", w.b);
        case 2:
          return call("GET", `/api/invoices/${id}`, "bob", w.a);
        case 3:
          return call("POST", "/api/invoices", "bob", w.a, { client_name: "Planted" });
        default:
          return call("DELETE", `/api/invoices/${id}`, "mallory", w.a);
      }
    });
    const replies = await Promise.all(attempts);
    expect(replies.every((r) => r.status === 403 || r.status === 404)).toBe(true);
    expect(await snapshot(w.a)).toBe(before);
  });

  it("A cannot reach B either", async () => {
    const beforeB = await snapshot(w.b);
    expect((await call("GET", `/api/invoices/${w.bIds[0]}`, "alice", w.a)).status).toBe(404);
    expect((await call("PATCH", `/api/invoices/${w.bIds[0]}`, "alice", w.a, { status: "paid" })).status).toBe(404);
    expect((await call("DELETE", `/api/invoices/${w.bIds[0]}`, "alice", w.a)).status).toBe(404);
    expect((await call("GET", "/api/invoices", "alice", w.b)).status).toBe(403);
    expect((await call("DELETE", `/api/invoices/${w.bIds[0]}`, "alice", w.b)).status).toBe(403);
    expect(await snapshot(w.b)).toBe(beforeB);
  });
});

describe("a workspace named in a request body or query is not obeyed", () => {
  let w: World;
  beforeEach(async () => {
    expect.hasAssertions();
    w = await world();
  });

  it("a workspace_id in the body of a create is ignored", async () => {
    const res = await call("POST", "/api/invoices", "alice", w.a, { client_name: "Sneaky", workspace_id: w.b, workspaceId: w.b, workspace: w.b, owner: w.b });
    expect(res.status).toBe(201);
    expect(await countRows(w.a)).toBe(4);
    expect(await countRows(w.b)).toBe(2);
    expect((await db.prepare('SELECT workspace_id FROM "ent_invoices" WHERE id = ?').bind(res.body!.item.id).first<{ workspace_id: string }>())?.workspace_id).toBe(w.a);
  });

  it("a workspace_id in the body of an update does not move the row", async () => {
    const res = await call("PATCH", `/api/invoices/${w.aIds[0]}`, "alice", w.a, { status: "paid", workspace_id: w.b, workspaceId: w.b });
    expect(res.status).toBe(200);
    expect((await db.prepare('SELECT workspace_id FROM "ent_invoices" WHERE id = ?').bind(w.aIds[0]).first<{ workspace_id: string }>())?.workspace_id).toBe(w.a);
    expect(await countRows(w.b)).toBe(2);
    // and an update that names only a workspace is "nothing to update", not a transfer
    expect((await call("PATCH", `/api/invoices/${w.aIds[0]}`, "alice", w.a, { workspace_id: w.b })).status).toBe(400);
  });

  it("an id in the body of a create does not choose the row's id", async () => {
    const beforeB = await snapshot(w.b);
    const res = await call("POST", "/api/invoices", "alice", w.a, { id: w.bIds[0], client_name: "Collider" });
    expect(res.status).toBe(201);
    expect(res.body!.item.id).not.toBe(w.bIds[0]);
    expect(await snapshot(w.b)).toBe(beforeB);
  });

  it("a workspace id in the query string of a list is ignored", async () => {
    const res = await call("GET", "/api/invoices", "alice", w.a, undefined, { query: `?workspaceId=${w.b}&workspace_id=${w.b}&workspace=${w.b}` });
    expect(res.status).toBe(200);
    expect(res.body!.items.map((i: { client_name: string }) => i.client_name).sort()).toEqual(["A-Acme", "A-Globex", "A-Initech"]);
    expect(res.text).not.toMatch(/B-Umbrella|B-Hooli/);
  });
});

describe("hostile names and values are rejected or stay plain data", () => {
  let w: World;
  beforeEach(async () => {
    expect.hasAssertions();
    w = await world();
  });

  it("injection-shaped text is stored and returned as text", async () => {
    const balanceB = await balanceOf(w.b);
    for (const text of HOSTILE_TEXT) {
      const made = await call("POST", "/api/invoices", "alice", w.a, { client_name: text, pdf_r2_url: text });
      expect(made.status, text).toBe(201);
      const back = await call("GET", `/api/invoices/${made.body!.item.id}`, "alice", w.a);
      expect(back.body!.item.client_name, text).toBe(text);
      expect(back.body!.item.pdf_r2_url, text).toBe(text);
    }
    expect(await countRows(w.a)).toBe(3 + HOSTILE_TEXT.length);
    expect(await countRows(w.b)).toBe(2);
    expect(await balanceOf(w.b)).toBe(balanceB);
    expect(JSON.stringify((await call("GET", "/api/invoices", "alice", w.a)).body !== null)).toBe("true");
  });

  it("injection-shaped ids reach nothing", async () => {
    const before = [await snapshot(w.a), await snapshot(w.b)];
    for (const id of ["x' OR '1'='1", "' OR 1=1 --", "%", "*", "../../x", `${w.aIds[0]}'`, `${w.aIds[0]} OR 1=1`, "a".repeat(300), "00000000-0000-4000-8000-000000000000", "null", "undefined"]) {
      const path = `/api/invoices/${encodeURIComponent(id)}`;
      for (const [method, body] of [["GET", undefined], ["PATCH", { status: "paid" }], ["DELETE", undefined]] as const) {
        const res = await call(method, path, "alice", w.a, body);
        expect(res.status, `${method} ${id}`).toBe(404);
      }
    }
    expect([await snapshot(w.a), await snapshot(w.b)]).toEqual(before);
  });

  it("injection-shaped paging values are refused", async () => {
    for (const query of ["?limit=1;DROP TABLE ent_invoices", "?limit=-1", "?limit=0", "?limit=1000", "?limit=abc", "?limit=1e9", "?limit=1%20OR%201=1", "?offset=-5", "?offset=9999999999", "?offset=1;DELETE", "?limit=NaN", "?limit=Infinity"]) {
      expect((await call("GET", "/api/invoices", "alice", w.a, undefined, { query })).status, query).toBe(400);
    }
    // parameters the router does not define are ignored, so they cannot choose a column or an order
    for (const query of ["?orderBy=amount;DROP TABLE x", "?sort=client_name", "?where=1=1", "?fields=workspace_id", "?select=*"]) {
      const res = await call("GET", "/api/invoices", "alice", w.a, undefined, { query });
      expect(res.status, query).toBe(200);
      expect(res.body!.total).toBe(3);
    }
    expect(await countRows(w.a)).toBe(3);
  });

  it("unknown and made-up fields are dropped", async () => {
    const columnsBefore = (await db.prepare('PRAGMA table_info("ent_invoices")').all<{ name: string }>()).results.map((c) => c.name);
    const res = await call("POST", "/api/invoices", "alice", w.a, { client_name: "Odd", secret_column: "x", "status\" = 'x', \"workspace_id": w.b, "client_name\") VALUES (1); --": "y", created_at: "1999-01-01", updated_at: "1999-01-01" });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body!.item).sort()).toEqual(["amount", "client_name", "created_at", "id", "pdf_r2_url", "status", "updated_at"]);
    expect(res.body!.item.created_at).not.toBe("1999-01-01");
    const columnsAfter = (await db.prepare('PRAGMA table_info("ent_invoices")').all<{ name: string }>()).results.map((c) => c.name);
    expect(columnsAfter).toEqual(columnsBefore);
    expect(await countRows(w.b)).toBe(2);
  });

  it("values outside the declaration are refused", async () => {
    const bad: unknown[] = [
      { client_name: "a", status: "refunded" },
      { client_name: "a", status: "PAID" },
      { client_name: "a", status: ["paid"] },
      { client_name: "a", amount: 1.5 },
      { client_name: "a", amount: "12" },
      { client_name: "a", amount: 1e300 },
      { client_name: "a", amount: Number.MAX_SAFE_INTEGER + 2 },
      { client_name: 5 },
      { client_name: { $ne: "" } },
      { client_name: ["a"] },
      { client_name: null },
      { client_name: "x".repeat(501) },
      {},
      [],
      "just text",
    ];
    for (const body of bad) {
      const res = await call("POST", "/api/invoices", "alice", w.a, typeof body === "string" ? JSON.stringify(body) : body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await call("POST", "/api/invoices", "alice", w.a, "{not json")).status).toBe(400);
    expect(await countRows(w.a)).toBe(3);
  });

  it("prototype keys in a body are ignored", async () => {
    const res = await call("POST", "/api/invoices", "alice", w.a, '{"__proto__": {"workspace_id": "' + w.b + '", "polluted": true}, "constructor": {"prototype": {"polluted": true}}, "client_name": "Proto"}');
    expect(res.status).toBe(201);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).workspace_id).toBeUndefined();
    expect((await db.prepare('SELECT workspace_id FROM "ent_invoices" WHERE id = ?').bind(res.body!.item.id).first<{ workspace_id: string }>())?.workspace_id).toBe(w.a);
  });

  it("the tables are all still there after the attacks", async () => {
    // a run of the nastiest requests, then the schema and the data are checked
    for (const text of HOSTILE_TEXT) await call("POST", "/api/invoices", "alice", w.a, { client_name: text });
    await call("GET", "/api/invoices/%27%3B%20DROP%20TABLE%20ent_invoices%3B--", "alice", w.a);
    await call("GET", "/api/invoices", "alice", w.a, undefined, { query: "?limit=1;DROP TABLE ent_invoices" });
    const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%' AND name NOT LIKE '_cf%' ORDER BY name").all<{ name: string }>()).results.map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["credit_ledger", "credit_orders", "credit_wallets", "ent_invoices", "mw_members", "mw_workspaces"]));
    expect(await countRows(w.a)).toBe(3 + HOSTILE_TEXT.length);
    expect(await countRows(w.b)).toBe(2);
    expect(await balanceOf(w.a)).toBe(100);
    expect(await balanceOf(w.b)).toBe(50);
  });
});

describe("the wallet beside the entities still keeps its tenants apart", () => {
  let w: World;
  beforeEach(async () => {
    expect.hasAssertions();
    w = await world();
  });

  it("A cannot read or spend B's wallet", async () => {
    expect((await call("GET", "/api/wallet", "alice", w.b)).status).toBe(403);
    expect((await call("GET", "/api/wallet/history", "alice", w.b)).status).toBe(403);
    expect((await call("POST", "/api/wallet/deduct", "alice", w.b, { amount: 10 })).status).toBe(403);
    expect((await call("POST", "/api/wallet/deduct", "alice", w.a, { amount: 10, workspaceId: w.b })).status).toBe(200);
    expect(await balanceOf(w.b)).toBe(50);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE workspace_id = ?").bind(w.b).first<{ n: number }>())!.n).toBe(0);
  });

  it("A's own wallet still works", async () => {
    expect((await call("GET", "/api/wallet", "alice", w.a)).body).toMatchObject({ currentBalance: 100 });
    expect((await call("POST", "/api/wallet/deduct", "alice", w.a, { amount: 30 })).body).toMatchObject({ balanceAfter: 70 });
    expect(await balanceOf(w.a)).toBe(70);
  });
});

test("H8 report", async ({ task }) => {
  // Each boolean is computed from a fresh world and its own scenario; none is a constant. scripts/verify.ts additionally
  // refuses to believe them unless every test in h8-entity-tests.json ran once and passed.
  const ok: Record<string, boolean[]> = { tenantACrud: [], tenantBDenied: [], bodyWorkspaceIgnored: [], hostileInputsSafe: [], walletStillDenied: [] };

  let w = await world();
  const made = await call("POST", "/api/invoices", "alice", w.a, { client_name: "Report", amount: 5, status: "draft" });
  const id = made.body?.item?.id as string;
  ok.tenantACrud!.push(made.status === 201, (await call("GET", `/api/invoices/${id}`, "alice", w.a)).body?.item?.client_name === "Report");
  ok.tenantACrud!.push((await call("PATCH", `/api/invoices/${id}`, "alice", w.a, { status: "paid" })).body?.item?.status === "paid");
  ok.tenantACrud!.push((await call("GET", "/api/invoices", "alice", w.a)).body?.total === 4);
  ok.tenantACrud!.push((await call("DELETE", `/api/invoices/${id}`, "alice", w.a)).status === 200, (await call("GET", `/api/invoices/${id}`, "alice", w.a)).status === 404);

  w = await world();
  const before = await snapshot(w.a);
  const statuses = [
    (await call("GET", `/api/invoices/${w.aIds[0]}`, "bob", w.b)).status === 404,
    (await call("PATCH", `/api/invoices/${w.aIds[0]}`, "bob", w.b, { status: "paid" })).status === 404,
    (await call("DELETE", `/api/invoices/${w.aIds[0]}`, "bob", w.b)).status === 404,
    (await call("GET", "/api/invoices", "bob", w.a)).status === 403,
    (await call("POST", "/api/invoices", "bob", w.a, { client_name: "Planted" })).status === 403,
    (await call("DELETE", `/api/invoices/${w.aIds[0]}`, "bob", null, undefined, { query: `?workspaceId=${w.a}` })).status === 400,
  ];
  const listB = await call("GET", "/api/invoices", "bob", w.b);
  ok.tenantBDenied!.push(...statuses, listB.body?.total === 2, !listB.text.includes("A-Acme"), (await snapshot(w.a)) === before);

  w = await world();
  const smuggled = await call("POST", "/api/invoices", "alice", w.a, { client_name: "Body", workspace_id: w.b, workspaceId: w.b });
  const moved = await call("PATCH", `/api/invoices/${w.aIds[0]}`, "alice", w.a, { status: "paid", workspace_id: w.b });
  ok.bodyWorkspaceIgnored!.push(smuggled.status === 201, (await countRows(w.b)) === 2, (await countRows(w.a)) === 4, moved.status === 200, (await countRows(w.b)) === 2);

  w = await world();
  for (const text of HOSTILE_TEXT) {
    const stored = await call("POST", "/api/invoices", "alice", w.a, { client_name: text });
    ok.hostileInputsSafe!.push(stored.status === 201, (await call("GET", `/api/invoices/${stored.body?.item?.id}`, "alice", w.a)).body?.item?.client_name === text);
  }
  ok.hostileInputsSafe!.push((await call("GET", `/api/invoices/${encodeURIComponent("x' OR '1'='1")}`, "alice", w.a)).status === 404);
  ok.hostileInputsSafe!.push((await call("GET", "/api/invoices", "alice", w.a, undefined, { query: "?limit=1;DROP TABLE ent_invoices" })).status === 400);
  ok.hostileInputsSafe!.push((await countRows(w.b)) === 2, (await balanceOf(w.b)) === 50);
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ent_invoices','mw_members','credit_wallets')").all()).results.length;
  ok.hostileInputsSafe!.push(tables === 3);

  w = await world();
  ok.walletStillDenied!.push(
    (await call("GET", "/api/wallet", "alice", w.b)).status === 403,
    (await call("POST", "/api/wallet/deduct", "alice", w.b, { amount: 10 })).status === 403,
    (await balanceOf(w.b)) === 50,
    (await call("POST", "/api/wallet/deduct", "alice", w.a, { amount: 30 })).body?.balanceAfter === 70,
  );

  const checks = Object.fromEntries(Object.entries(ok).map(([name, results]) => [name, results.length > 0 && results.every(Boolean)]));
  record(task, { id: "H8", checks });
});
