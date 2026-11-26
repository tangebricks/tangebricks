import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration, entityDdl, parseEntities } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { createEntityRoutes } from "../src/index.ts";

const db = env.DB as D1Like;

const initialDeclarations = [
  {
    name: "items",
    fields: [
      { name: "title", type: "text", required: true },
      { name: "price", type: "number" },
    ],
  },
];

const parsedInitial = parseEntities(initialDeclarations);
if (!parsedInitial.ok) throw new Error(parsedInitial.errors.join("; "));
const firstEntity = parsedInitial.entities[0]!;

function createDynamicApp(userWorkspaceId = "ws_dyn_alpha", userId = "usr_alice", declarations: any = initialDeclarations) {
  const app = new Hono<{
    Variables: {
      workspace: { id: string; role: string; suspended: boolean };
      user: { uid: string; name: string };
    };
  }>();

  app.use("*", async (c, next) => {
    const wsHeader = c.req.header("x-workspace-id") ?? userWorkspaceId;
    const userHeader = c.req.header("x-user-id") ?? userId;
    if (userHeader !== "anonymous") {
      c.set("workspace", { id: wsHeader, role: "owner", suspended: false });
      c.set("user", { uid: userHeader, name: userHeader });
    }
    await next();
  });

  app.route("/api", createEntityRoutes({ entities: declarations }));
  return app;
}

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS ent_items").run();
  await db.prepare("DROP TABLE IF EXISTS items").run();
  const ddl = entityDdl(firstEntity);
  await applyMigration(db, ddl);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Dynamic Entities Brick Behaviour Suite", () => {
  it("creates and lists dynamic entity records", async () => {
    const app = createDynamicApp("ws_dyn_alpha", "usr_alice");

    // 1. Create item
    const postRes = await app.request(
      "http://localhost/api/items",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Mechanical Keyboard", price: 120 }),
      },
      { DB: db }
    );
    expect(postRes.status).toBe(201);
    const postBody = (await postRes.json()) as any;
    expect(postBody.item).toBeDefined();
    expect(postBody.item.id).toBeDefined();
    expect(postBody.item.title).toBe("Mechanical Keyboard");
    expect(postBody.item.price).toBe(120);

    // 2. List items
    const listRes = await app.request(
      "http://localhost/api/items",
      { method: "GET" },
      { DB: db }
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as any;
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0].title).toBe("Mechanical Keyboard");
    expect(listBody.total).toBe(1);
  });

  it("rejects field-type mismatch and schema violations with a code", async () => {
    const app = createDynamicApp("ws_dyn_alpha", "usr_alice");

    // 1. Send string for number field price
    const typeMismatchRes = await app.request(
      "http://localhost/api/items",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Valid Title", price: "not-a-number" }),
      },
      { DB: db }
    );
    expect(typeMismatchRes.status).toBe(400);
    const typeMismatchBody = (await typeMismatchRes.json()) as any;
    expect(typeMismatchBody.error).toBeDefined();
    // Must contain a structured code property
    expect(typeof typeMismatchBody.error).toBe("object");
    expect(typeMismatchBody.error.code).toBeDefined();
    expect(typeof typeMismatchBody.error.code).toBe("string");
    expect(typeof typeMismatchBody.error.message).toBe("string");

    // 2. Missing required field 'title'
    const missingFieldRes = await app.request(
      "http://localhost/api/items",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ price: 50 }),
      },
      { DB: db }
    );
    expect(missingFieldRes.status).toBe(400);
    const missingBody = (await missingFieldRes.json()) as any;
    expect(typeof missingBody.error).toBe("object");
    expect(missingBody.error.code).toBeDefined();

    // 3. Unauthenticated request rejected with code
    const unauthRes = await app.request(
      "http://localhost/api/items",
      {
        method: "GET",
        headers: { "x-user-id": "anonymous" },
      },
      { DB: db }
    );
    expect(unauthRes.status).toBe(401);
    const unauthBody = (await unauthRes.json()) as any;
    expect(typeof unauthBody.error).toBe("object");
    expect(unauthBody.error.code).toBeDefined();
  });

  it("enforces cross-tenant id guessing refusal on every generated route (GET, PATCH, DELETE)", async () => {
    const appAlpha = createDynamicApp("ws_tenant_alpha", "usr_alice");
    const appBeta = createDynamicApp("ws_tenant_beta", "usr_bob");

    // Seed item in Tenant Alpha
    const createRes = await appAlpha.request(
      "http://localhost/api/items",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Confidential Alpha Document", price: 999 }),
      },
      { DB: db }
    );
    expect(createRes.status).toBe(201);
    const itemAlpha = ((await createRes.json()) as any).item;
    expect(itemAlpha.id).toBeDefined();
    const alphaId = itemAlpha.id;

    // 1. Tenant Beta attempts GET on Tenant Alpha's item -> 404 Not Found
    const getRes = await appBeta.request(
      `http://localhost/api/items/${alphaId}`,
      { method: "GET" },
      { DB: db }
    );
    expect(getRes.status).toBe(404);
    const getBody = (await getRes.json()) as any;
    expect(JSON.stringify(getBody)).not.toContain("Confidential Alpha Document");

    // 2. Tenant Beta attempts PATCH on Tenant Alpha's item -> 404 Not Found
    const patchRes = await appBeta.request(
      `http://localhost/api/items/${alphaId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Tampered by Beta" }),
      },
      { DB: db }
    );
    expect(patchRes.status).toBe(404);

    // 3. Tenant Beta attempts DELETE on Tenant Alpha's item -> 404 Not Found
    const deleteRes = await appBeta.request(
      `http://localhost/api/items/${alphaId}`,
      { method: "DELETE" },
      { DB: db }
    );
    expect(deleteRes.status).toBe(404);

    // 4. Verify Alpha's item remains unmodified in database
    const verifyRes = await appAlpha.request(
      `http://localhost/api/items/${alphaId}`,
      { method: "GET" },
      { DB: db }
    );
    expect(verifyRes.status).toBe(200);
    const verifyBody = (await verifyRes.json()) as any;
    expect(verifyBody.item.title).toBe("Confidential Alpha Document");
    expect(verifyBody.item.price).toBe(999);
  });

  it("maintains pagination stability (deterministic order, disjoint pages, total count)", async () => {
    const app = createDynamicApp("ws_page_test", "usr_alice");

    // Seed 12 items
    for (let i = 1; i <= 12; i++) {
      const res = await app.request(
        "http://localhost/api/items",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: `Item ${String(i).padStart(2, "0")}`, price: i * 10 }),
        },
        { DB: db }
      );
      expect(res.status).toBe(201);
    }

    // Page 1: limit 5, offset 0
    const p1Res = await app.request("http://localhost/api/items?limit=5&offset=0", { method: "GET" }, { DB: db });
    expect(p1Res.status).toBe(200);
    const p1Body = (await p1Res.json()) as any;
    expect(p1Body.items).toHaveLength(5);
    expect(p1Body.total).toBe(12);

    // Page 2: limit 5, offset 5
    const p2Res = await app.request("http://localhost/api/items?limit=5&offset=5", { method: "GET" }, { DB: db });
    expect(p2Res.status).toBe(200);
    const p2Body = (await p2Res.json()) as any;
    expect(p2Body.items).toHaveLength(5);
    expect(p2Body.total).toBe(12);

    // Page 3: limit 5, offset 10 (remaining 2)
    const p3Res = await app.request("http://localhost/api/items?limit=5&offset=10", { method: "GET" }, { DB: db });
    expect(p3Res.status).toBe(200);
    const p3Body = (await p3Res.json()) as any;
    expect(p3Body.items).toHaveLength(2);
    expect(p3Body.total).toBe(12);

    // Verify disjointness across pages
    const idsP1 = new Set(p1Body.items.map((it: any) => it.id));
    const idsP2 = new Set(p2Body.items.map((it: any) => it.id));
    const idsP3 = new Set(p3Body.items.map((it: any) => it.id));

    for (const id of idsP2) expect(idsP1.has(id)).toBe(false);
    for (const id of idsP3) expect(idsP1.has(id)).toBe(false);
    for (const id of idsP3) expect(idsP2.has(id)).toBe(false);

    // Out-of-bounds offset returns empty array with correct total
    const pEmptyRes = await app.request("http://localhost/api/items?limit=5&offset=100", { method: "GET" }, { DB: db });
    expect(pEmptyRes.status).toBe(200);
    const pEmptyBody = (await pEmptyRes.json()) as any;
    expect(pEmptyBody.items).toHaveLength(0);
    expect(pEmptyBody.total).toBe(12);
  });

  it("thwarts filter injection attempts and validates query parameters safely", async () => {
    const app = createDynamicApp("ws_inject_test", "usr_alice");

    // 1. SQL Injection in limit query parameter
    const injectLimitRes = await app.request(
      "http://localhost/api/items?limit=5;%20DROP%20TABLE%20items;%20--",
      { method: "GET" },
      { DB: db }
    );
    expect(injectLimitRes.status).toBe(400);
    const injectLimitBody = (await injectLimitRes.json()) as any;
    expect(injectLimitBody.error).toBeDefined();

    // 2. Negative offset rejected
    const negativeOffsetRes = await app.request(
      "http://localhost/api/items?offset=-1",
      { method: "GET" },
      { DB: db }
    );
    expect(negativeOffsetRes.status).toBe(400);

    // 3. SQL Injection in path id parameter (' OR '1'='1)
    const injectIdRes = await app.request(
      "http://localhost/api/items/'%20OR%20'1'='1",
      { method: "GET" },
      { DB: db }
    );
    expect(injectIdRes.status).toBe(404);

    // 4. Injected tenant id in POST payload is ignored (workspace is bound from context)
    const spoofPostRes = await app.request(
      "http://localhost/api/items",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Legit Title",
          price: 50,
          workspace_id: "ws_injected_target",
          id: "custom-id-injection",
        }),
      },
      { DB: db }
    );
    expect(spoofPostRes.status).toBe(201);
    const spoofPostItem = ((await spoofPostRes.json()) as any).item;
    expect(spoofPostItem.id).not.toBe("custom-id-injection");

    // Verify row in DB belongs to caller workspace ws_inject_test
    const rowInDb = await db
      .prepare("SELECT workspace_id FROM ent_items WHERE id = ?")
      .bind(spoofPostItem.id)
      .first<{ workspace_id: string }>();
    expect(rowInDb?.workspace_id).toBe("ws_inject_test");
  });

  it("handles schema changes with existing rows gracefully", async () => {
    const app1 = createDynamicApp("ws_schema_test", "usr_alice", initialDeclarations);

    // 1. Insert row under v1 schema
    const insertRes = await app1.request(
      "http://localhost/api/items",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Legacy Item", price: 45 }),
      },
      { DB: db }
    );
    expect(insertRes.status).toBe(201);
    const legacyItem = ((await insertRes.json()) as any).item;
    const legacyId = legacyItem.id;

    // 2. Schema evolves: add optional 'sku' text column to table
    await db.prepare("ALTER TABLE ent_items ADD COLUMN sku TEXT").run();

    // 3. New declarations including 'sku'
    const evolvedDeclarations = [
      {
        name: "items",
        fields: [
          { name: "title", type: "text", required: true },
          { name: "price", type: "number" },
          { name: "sku", type: "text" },
        ],
      },
    ];
    const app2 = createDynamicApp("ws_schema_test", "usr_alice", evolvedDeclarations);

    // 4. Fetch legacy row under evolved schema (sku should be null)
    const readLegacyRes = await app2.request(
      `http://localhost/api/items/${legacyId}`,
      { method: "GET" },
      { DB: db }
    );
    expect(readLegacyRes.status).toBe(200);
    const readLegacyBody = (await readLegacyRes.json()) as any;
    expect(readLegacyBody.item.title).toBe("Legacy Item");
    expect(readLegacyBody.item.sku).toBeNull();

    // 5. Update legacy row with newly added field
    const patchRes = await app2.request(
      `http://localhost/api/items/${legacyId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku: "SKU-LEGACY-001" }),
      },
      { DB: db }
    );
    expect(patchRes.status).toBe(200);
    const patchedBody = (await patchRes.json()) as any;
    expect(patchedBody.item.sku).toBe("SKU-LEGACY-001");

    // 6. Insert new row with evolved field
    const newRowRes = await app2.request(
      "http://localhost/api/items",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Modern Item", price: 90, sku: "SKU-MODERN-999" }),
      },
      { DB: db }
    );
    expect(newRowRes.status).toBe(201);
    const newRowBody = (await newRowRes.json()) as any;
    expect(newRowBody.item.sku).toBe("SKU-MODERN-999");
  });
});

describe("relations, dates, money and long text (story 1.18)", () => {
  const declarations = [
    { name: "customer", fields: [{ name: "label", type: "text", required: true }] },
    {
      name: "invoice",
      fields: [
        { name: "customer_id", type: "relation", relation: "customer", required: true },
        { name: "due_on", type: "date" },
        { name: "total", type: "money", currencies: ["INR"] },
        { name: "notes", type: "longtext", maxLength: 60_000 },
        { name: "body", type: "longtext" },
      ],
    },
  ];
  const parsed = parseEntities(declarations);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));

  beforeEach(async () => {
    for (const entity of parsed.entities) {
      await db.prepare(`DROP TABLE IF EXISTS "ent_${entity.name}"`).run();
      await applyMigration(db, entityDdl(entity));
    }
  });

  const send = async (workspace: string, method: string, path: string, body?: unknown) => {
    const app = createDynamicApp(workspace, "usr_rel", declarations);
    const res = await app.request(
      `http://localhost/api${path}`,
      { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      { DB: db },
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  const newCustomer = async (workspace: string) => (await send(workspace, "POST", "/customer", { label: "Acme" })).body.item.id as string;

  it("creates an invoice that points at a customer of the same workspace, and shows money as {amount, currency}", async () => {
    const customerId = await newCustomer("ws_rel_a");
    const created = await send("ws_rel_a", "POST", "/invoice", { customer_id: customerId, due_on: "2026-11-26", total: { amount: 1999, currency: "INR" } });
    expect(created.status).toBe(201);
    expect(created.body.item).toMatchObject({ customer_id: customerId, due_on: "2026-11-26", total: { amount: 1999, currency: "INR" }, notes: null });
    const read = await send("ws_rel_a", "GET", `/invoice/${created.body.item.id}`);
    expect(read.body.item.total).toEqual({ amount: 1999, currency: "INR" });
    // stored as two columns
    const row = await db.prepare('SELECT "total", "total__currency" FROM "ent_invoice" WHERE "id" = ?').bind(created.body.item.id).first<any>();
    expect(row).toEqual({ total: 1999, total__currency: "INR" });
  });

  it("refuses a customer id from another workspace, or the id of a row of another entity, naming the field", async () => {
    const foreignCustomer = await newCustomer("ws_rel_b");
    const foreign = await send("ws_rel_a", "POST", "/invoice", { customer_id: foreignCustomer });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.code).toBe("VALIDATION_ERROR");
    expect(foreign.body.error.message).toMatch(/customer_id: no customer with this id in this workspace/);

    const ownCustomer = await newCustomer("ws_rel_a");
    const invoice = (await send("ws_rel_a", "POST", "/invoice", { customer_id: ownCustomer })).body.item.id as string;
    const wrongEntity = await send("ws_rel_a", "POST", "/invoice", { customer_id: invoice });
    expect(wrongEntity.status).toBe(400);
    expect(wrongEntity.body.error.message).toMatch(/customer_id/);

    const notUuid = await send("ws_rel_a", "POST", "/invoice", { customer_id: "1 OR 1=1" });
    expect(notUuid.status).toBe(400);
    expect(notUuid.body.error.code).toBe("VALIDATION_ERROR");

    // the same check guards an update
    const patched = await send("ws_rel_a", "PATCH", `/invoice/${invoice}`, { customer_id: foreignCustomer });
    expect(patched.status).toBe(400);
    expect(patched.body.error.message).toMatch(/customer_id/);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM "ent_invoice"').first<{ n: number }>())!.n).toBe(1);
  });

  it("deleting a referenced customer stays allowed (no foreign key)", async () => {
    const customerId = await newCustomer("ws_rel_a");
    expect((await send("ws_rel_a", "POST", "/invoice", { customer_id: customerId })).status).toBe(201);
    expect((await send("ws_rel_a", "DELETE", `/customer/${customerId}`)).status).toBe(200);
  });

  it.each([
    ["a date", { due_on: "2026-11-26" }, 201],
    ["a month 13", { due_on: "2026-13-01" }, 400],
    ["a day-first date", { due_on: "26/11/2026" }, 400],
    ["a 30 February", { due_on: "2026-02-30" }, 400],
    ["a date in the year 50 (the table accepts it too)", { due_on: "0050-01-01" }, 201],
    ["money in minor units", { total: { amount: 1999, currency: "INR" } }, 201],
    ["a fractional amount", { total: { amount: 19.99, currency: "INR" } }, 400],
    ["an undeclared currency", { total: { amount: 1999, currency: "USD" } }, 400],
    ["a bare number for money", { total: 1999 }, 400],
    ["money with no currency", { total: { amount: 1999 } }, 400],
    ["50000 characters of long text", { notes: "x".repeat(50_000) }, 201],
    ["long text over its declared maxLength", { notes: "x".repeat(60_001) }, 400],
    ["long text over the default 20000", { body: "x".repeat(20_001) }, 400],
  ])("%s gives HTTP %i", async (_label, values, status) => {
    const customerId = await newCustomer("ws_rel_a");
    const res = await send("ws_rel_a", "POST", "/invoice", { customer_id: customerId, ...values });
    expect(res.status).toBe(status);
    if (status === 400) expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("money can be changed and cleared; clearing empties both columns", async () => {
    const customerId = await newCustomer("ws_rel_a");
    const id = (await send("ws_rel_a", "POST", "/invoice", { customer_id: customerId, total: { amount: 100, currency: "INR" } })).body.item.id as string;
    expect((await send("ws_rel_a", "PATCH", `/invoice/${id}`, { total: { amount: 250, currency: "INR" } })).body.item.total).toEqual({ amount: 250, currency: "INR" });
    expect((await send("ws_rel_a", "PATCH", `/invoice/${id}`, { total: null })).body.item.total).toBeNull();
    const row = await db.prepare('SELECT "total", "total__currency" FROM "ent_invoice" WHERE "id" = ?').bind(id).first<any>();
    expect(row).toEqual({ total: null, total__currency: null });
  });
});
