import { describe, expect, test } from "vitest";
import { entityDdl, parseEntities } from "@poc/sdk";
import { assemble } from "../src/index.ts";
import type { Catalog } from "../src/index.ts";
import { catalog } from "../catalog.generated.ts";
import { INVOICE_FLOW_BLUEPRINT } from "../../../test/support/blueprints.ts";

const ok = (input: unknown, c: Catalog = catalog) => {
  const result = assemble(input, c);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result;
};
const refused = (input: unknown, c: Catalog = catalog) => {
  const result = assemble(input, c);
  if (result.ok) throw new Error("expected the assembly to be refused");
  return result.errors.join(" | ");
};
const bricks = ["multi-workspace", "credit-wallet", "dynamic-entities"];
const widgets = { name: "widgets", fields: [{ name: "label", type: "text", required: true }, { name: "done", type: "boolean" }] };

describe("a blueprint that declares entities", () => {
  const result = ok(INVOICE_FLOW_BLUEPRINT);

  test("produces the bricks' files plus the declaration and one table", () => {
    expect(Object.keys(result.files)).toEqual([
      "migrations/0001_multi-workspace__0001_multi_workspace.sql",
      "migrations/0002_credit-wallet__0001_credit_wallet.sql",
      "migrations/0003_credit-wallet__0002_workspace_scoped_idempotency.sql",
      // Story 2.3: credit-wallet's order currency column.
      "migrations/0004_credit-wallet__0003_order_currency.sql",
      "migrations/0005_credit-wallet__0004_milli_credits.sql",
      "migrations/0006_entity__invoices.sql",
      // Story 0.21: credit-wallet's rate limits bring the shared limiter's table, after every brick and entity table.
      "migrations/0007_shell__px_rate_limits.sql",
      "openapi.json",
      "package.json",
      "project.json",
      "src/entities.json",
      "src/identity.stub.ts",
      "src/index.ts",
      "src/privacy.generated.ts",
      "wrangler.jsonc",
    ]);
    expect(result.order).toEqual(["multi-workspace", "credit-wallet", "dynamic-entities"]);
  });

  test("entities.json is the checked declaration, with defaults filled in", () => {
    const written = JSON.parse(result.files["src/entities.json"]!);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ name: "invoices", workspaceScoped: true });
    expect(written[0].fields[0]).toEqual({ name: "client_name", type: "text", required: true, maxLength: 500 });
    expect(written[0].fields[2]).toEqual({ name: "status", type: "enum", required: false, values: ["draft", "paid", "overdue"] });
  });

  test("the table's migration is exactly what the shared contract generates, and comes after every brick's", () => {
    const parsed = parseEntities(INVOICE_FLOW_BLUEPRINT.entities);
    if (!parsed.ok) throw new Error("declaration should parse");
    expect(result.files["migrations/0006_entity__invoices.sql"]).toBe(entityDdl(parsed.entities[0]!));
  });

  test("the entry reads the declaration as data and mounts the guard in front of the entity's routes", () => {
    const entry = result.files["src/index.ts"]!;
    expect(entry).toContain('import entities from "./entities.json";');
    expect(entry).toContain('import { createEntityRoutes } from "@poc/dynamic-entities";');
    expect(entry).toContain("createEntityRoutes({ entities: entities })");
    const first = entry.indexOf('app.use("/api/invoices", workspaceMiddleware);');
    expect(first).toBeGreaterThan(-1);
    expect(entry).toContain('app.use("/api/invoices/*", workspaceMiddleware);');
    expect(first).toBeLessThan(entry.indexOf("createEntityRoutes({ entities: entities })"));
    // no entity or field name is in the code that runs; the declaration is data
    for (const word of ["client_name", "pdf_r2_url", "overdue"]) expect(entry).not.toContain(word);
  });

  test("project.json lists the entity, and the package depends on the router", () => {
    expect(JSON.parse(result.files["project.json"]!).entities).toEqual(["invoices"]);
    expect(JSON.parse(result.files["package.json"]!).dependencies).toMatchObject({ "@poc/dynamic-entities": "workspace:*" });
  });

  test("two runs give identical files, and the order of bricks or entities written does not change them", () => {
    const again = ok(INVOICE_FLOW_BLUEPRINT);
    expect(JSON.stringify(again.files)).toBe(JSON.stringify(result.files));
    const shuffled = { ...INVOICE_FLOW_BLUEPRINT, bricks: ["dynamic-entities", "credit-wallet", "multi-workspace"] };
    expect(JSON.stringify(ok(shuffled).files)).toBe(JSON.stringify(result.files));
    const two = { project: "p", bricks, entities: [INVOICE_FLOW_BLUEPRINT.entities[0], widgets] };
    const flipped = { project: "p", bricks, entities: [widgets, INVOICE_FLOW_BLUEPRINT.entities[0]] };
    expect(JSON.stringify(ok(two).files)).toBe(JSON.stringify(ok(flipped).files));
  });

  test("two entities get two tables and guards for both, in name order", () => {
    const both = ok({ project: "p", bricks, entities: [widgets, INVOICE_FLOW_BLUEPRINT.entities[0]] });
    expect(Object.keys(both.files).filter((f) => f.startsWith("migrations/")).slice(5)).toEqual(["migrations/0006_entity__invoices.sql", "migrations/0007_entity__widgets.sql", "migrations/0008_shell__px_rate_limits.sql"]);
    const entry = both.files["src/index.ts"]!;
    expect(entry.indexOf('"/api/invoices"')).toBeLessThan(entry.indexOf('"/api/widgets"'));
    expect(both.files["migrations/0007_entity__widgets.sql"]).toContain('"done" INTEGER CHECK ("done" IN (0, 1))');
  });
});

describe("the entity brick on its own, with no entities", () => {
  test("mounts an empty router: an empty declaration, no entity tables, no entity guards", () => {
    const r = ok({ project: "p", bricks });
    expect(JSON.parse(r.files["src/entities.json"]!)).toEqual([]);
    expect(Object.keys(r.files).filter((f) => f.includes("entity__"))).toEqual([]);
    expect(r.files["src/index.ts"]).toContain("createEntityRoutes({ entities: entities })");
    expect(r.files["src/index.ts"]).not.toContain("/api/invoices");
  });

  test("a project without the entity brick has no entities.json and is the same project as before", () => {
    const r = ok({ project: "p", bricks: ["multi-workspace", "credit-wallet"] });
    expect(r.files["src/entities.json"]).toBeUndefined();
    expect(r.files["src/index.ts"]).not.toContain("entities");
  });
});

describe("a blueprint whose entities cannot be assembled is refused with a reason", () => {
  test("entities declared, no brick to serve them", () => {
    expect(refused({ project: "p", bricks: ["multi-workspace", "credit-wallet"], entities: [widgets] })).toMatch(/entities are declared but no enabled brick handles them \(enable one of: dynamic-entities\)/);
  });

  test("the entity brick without a workspace guard to sit behind", () => {
    expect(refused({ project: "p", bricks: ["dynamic-entities"], entities: [widgets] })).toMatch(/dynamic-entities requires "workspace-context", which no enabled brick provides \(enable one of: multi-workspace\)/);
  });

  test.each(["wallet", "payments", "workspaces"])("an entity named %s, which a brick's routes already use, even when that brick is not enabled", (name) => {
    expect(refused({ project: "p", bricks: ["multi-workspace", "dynamic-entities"], entities: [{ ...widgets, name }] })).toMatch(new RegExp(`entity "${name}" uses a name that a brick's routes already use`));
  });

  test("an entity declared twice", () => {
    expect(refused({ project: "p", bricks, entities: [widgets, widgets] })).toMatch(/entity "widgets" is declared twice/);
  });

  test("a bad declaration is reported with where it is wrong", () => {
    const message = refused({ project: "p", bricks, entities: [{ name: "widgets", fields: [{ name: "label", type: "text" }, { name: "Bad Name", type: "text" }] }] });
    expect(message).toMatch(/entities\.0\.fields\.1\.name/);
  });

  test.each([
    ["an entity list that is not a list", { project: "p", bricks, entities: "widgets" }],
    ["too many entities", { project: "p", bricks, entities: Array.from({ length: 21 }, (_, i) => ({ ...widgets, name: `w${i}` })) }],
    ["an entity name that would close the guard path string", { project: "p", bricks, entities: [{ ...widgets, name: 'x"); evil(); ("' }] }],
    ["an entity name that is a path", { project: "p", bricks, entities: [{ ...widgets, name: "../x" }] }],
  ])("%s", (_label, blueprint) => {
    expect(assemble(blueprint, catalog).ok).toBe(false);
  });
});

describe("with synthetic bricks", () => {
  const brick = (id: string, extra: Record<string, unknown> = {}) =>
    ({ manifest: { manifestVersion: 2, kind: "brick", id, version: "1.0.0", trust: "first-party", isolation: "none", provides: [], requires: [], migrations: [], routePrefixes: [], npmDependencies: {}, settings: {}, worker: { package: `@x/${id}`, routes: [] }, ...extra }, files: {} }) as Catalog["bricks"][string];
  const taker = (id: string) =>
    brick(id, { worker: { package: `@x/${id}`, routes: [{ factory: "serve", mountAt: "/api", options: { things: { $entities: true } }, guardPaths: [], }] } });

  test("two bricks that both take entities are refused", () => {
    const c: Catalog = { bricks: { one: taker("one"), two: taker("two") } };
    expect(refused({ project: "p", bricks: ["one", "two"], entities: [widgets] }, c)).toMatch(/one and two both handle entities; enable only one/);
  });

  test("a brick's reserved route names are taken from every brick in the catalog, enabled or not", () => {
    const c: Catalog = { bricks: { taker: taker("taker"), other: brick("other", { routePrefixes: ["widgets"] }) } };
    expect(refused({ project: "p", bricks: ["taker"], entities: [widgets] }, c)).toMatch(/entity "widgets" uses a name that a brick's routes already use/);
  });

  test("a brick can take the entities without a guard, and the entry then holds no entity guard lines", () => {
    const c: Catalog = { bricks: { taker: taker("taker") } };
    const r = ok({ project: "p", bricks: ["taker"], entities: [widgets] }, c);
    expect(r.files["src/index.ts"]).toContain("serve({ things: entities })");
    expect(r.files["src/index.ts"]).not.toContain("app.use(\"/api/widgets\"");
  });
});

describe("relations, date, money and longtext (story 1.18)", () => {
  const customers = { name: "customers", fields: [{ name: "label", type: "text", required: true }] };
  const orders = {
    name: "orders",
    fields: [
      { name: "customer_id", type: "relation", relation: "customers", required: true },
      { name: "due_on", type: "date" },
      { name: "total", type: "money", currencies: ["INR", "USD"] },
      { name: "notes", type: "longtext", maxLength: 50_000 },
    ],
  };
  const result = ok({ project: "p", bricks: ["multi-workspace", "dynamic-entities"], entities: [orders, customers] });

  test("entities.json and the migration carry the relation and the new types", () => {
    const written = JSON.parse(result.files["src/entities.json"]!);
    expect(written.map((e: { name: string }) => e.name)).toEqual(["customers", "orders"]);
    expect(written[1].fields).toEqual([
      { name: "customer_id", type: "relation", required: true, relation: "customers" },
      { name: "due_on", type: "date", required: false },
      { name: "total", type: "money", required: false, currencies: ["INR", "USD"] },
      { name: "notes", type: "longtext", required: false, maxLength: 50_000 },
    ]);
    const migration = Object.entries(result.files).find(([path]) => path.endsWith("_entity__orders.sql"))![1];
    const parsed = parseEntities([orders, customers]);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    expect(migration).toBe(entityDdl(parsed.entities[1]!));
    expect(migration).toContain('"total__currency" TEXT');
  });

  test("a relation to an entity the blueprint does not declare is refused", () => {
    expect(refused({ project: "p", bricks: ["multi-workspace", "dynamic-entities"], entities: [orders] })).toMatch(/field "customer_id" relates to entity "customers", which is not declared/);
  });

  test("the OpenAPI document describes each new type", () => {
    const schema = JSON.parse(result.files["openapi.json"]!).components.schemas.OrdersCreate.properties;
    expect(schema.customer_id).toMatchObject({ type: "string", format: "uuid" });
    expect(schema.due_on).toEqual({ type: "string", format: "date" });
    expect(schema.notes).toEqual({ type: "string", maxLength: 50_000 });
    expect(schema.total).toMatchObject({
      type: "object",
      properties: { amount: { type: "integer" }, currency: { type: "string", enum: ["INR", "USD"] } },
      required: ["amount", "currency"],
    });
  });
});
