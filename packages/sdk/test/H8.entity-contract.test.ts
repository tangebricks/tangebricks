import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { applyMigration, entityDdl, parseEntities, tableName } from "../src/index.ts";
import type { D1Like, Entity } from "../src/index.ts";

const db = env.DB as D1Like;

const invoices = {
  name: "invoices",
  workspaceScoped: true,
  fields: [
    { name: "client_name", type: "text", required: true },
    { name: "amount", type: "number" },
    { name: "status", type: "enum", values: ["draft", "paid", "overdue"] },
    { name: "pdf_r2_url", type: "text" },
  ],
};
const parse = (input: unknown, reserved: string[] = []) => parseEntities(input, new Set(reserved));
const good = (input: unknown, reserved: string[] = []) => {
  const result = parse(input, reserved);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.entities;
};
const refused = (input: unknown, reserved: string[] = []) => {
  const result = parse(input, reserved);
  if (result.ok) throw new Error("expected the declaration to be refused");
  return result.errors.join(" | ");
};

describe("a valid declaration", () => {
  test("is accepted, with defaults filled in", () => {
    const [entity] = good([invoices]);
    expect(entity!.name).toBe("invoices");
    expect(entity!.workspaceScoped).toBe(true);
    expect(entity!.fields[0]).toMatchObject({ name: "client_name", type: "text", required: true, maxLength: 500 });
    expect(entity!.fields[1]).toMatchObject({ name: "amount", type: "number", required: false });
  });

  test("an empty list of entities is fine", () => {
    expect(good([])).toEqual([]);
  });

  test("entities come back sorted by name, whatever order they were written in", () => {
    const e = (name: string) => ({ name, fields: [{ name: "label", type: "text" }] });
    expect(good([e("zebras"), e("apples"), e("mangos")]).map((x) => x.name)).toEqual(["apples", "mangos", "zebras"]);
  });

  test("the table is the entity name with a prefix that keeps it clear of every brick's tables", () => {
    expect(tableName({ name: "invoices" })).toBe("ent_invoices");
  });
});

describe("hostile or malformed declarations are refused with a reason", () => {
  const entity = (overrides: Record<string, unknown>) => [{ ...invoices, ...overrides }];
  const withField = (field: Record<string, unknown>) => entity({ fields: [field] });

  test.each([
    ["an entity name that ends a statement", "invoices; DROP TABLE x"],
    ["an entity name with a quote", 'inv"oices'],
    ["an entity name with a space", "my invoices"],
    ["an entity name in capitals", "Invoices"],
    ["an entity name starting with a digit", "1invoices"],
    ["an entity name starting with an underscore", "_invoices"],
    ["an entity name with a dash", "my-invoices"],
    ["an entity name with a path", "../invoices"],
    ["an entity name with a comment marker", "inv--oices"],
    ["an entity name with unicode lookalikes", "invоices"],
    ["an empty entity name", ""],
    ["an entity name over 40 characters", "a".repeat(41)],
    ["an entity name with a newline", "invoices\nx"],
  ])("%s", (_label, name) => {
    expect(parse(entity({ name })).ok).toBe(false);
  });

  test.each([
    ["a field name that ends a statement", "a; DROP TABLE x"],
    ["a field name with a quote", 'a"b'],
    ["a field name with a comment marker", "a--b"],
    ["a field name in capitals", "Amount"],
    ["a field name over 40 characters", "a".repeat(41)],
    ["a field named id", "id"],
    ["a field named workspace_id", "workspace_id"],
    ["a field named created_at", "created_at"],
    ["a field named updated_at", "updated_at"],
    ["a field named rowid (a name SQLite treats as the row id)", "rowid"],
    ["a field named oid", "oid"],
    ["a field named _rowid_", "_rowid_"],
  ])("%s", (_label, name) => {
    expect(parse(withField({ name, type: "text" })).ok).toBe(false);
  });

  test.each([
    ["an enum value with a quote", ["draft", "it's"]],
    ["an enum value that ends a statement", ["draft", "x'); DROP TABLE t; --"]],
    ["an enum value with a semicolon", ["a;b"]],
    ["an enum value with a comment marker", ["a--b"]],
    ["an enum value in capitals", ["Draft"]],
    ["an enum value with a space", ["not paid"]],
    ["an enum value that is empty", [""]],
    ["an enum with no values", []],
    ["an enum with 21 values", Array.from({ length: 21 }, (_, i) => `v${i}`)],
    ["an enum that lists a value twice", ["a", "a"]],
  ])("%s", (_label, values) => {
    expect(parse(withField({ name: "status", type: "enum", values })).ok).toBe(false);
  });

  test.each([
    ["a field type that does not exist", { name: "a", type: "blob" }],
    ["a decimal type", { name: "a", type: "decimal" }],
    ["a number with min above max", { name: "a", type: "number", min: 10, max: 1 }],
    ["a fractional minimum", { name: "a", type: "number", min: 0.5 }],
    ["a text longer than 10000", { name: "a", type: "text", maxLength: 10001 }],
    ["a text with a zero length", { name: "a", type: "text", maxLength: 0 }],
    ["a key the field does not define", { name: "a", type: "text", default: "x" }],
    ["an enum written with the values missing", { name: "a", type: "enum" }],
  ])("%s", (_label, field) => {
    expect(parse(withField(field)).ok).toBe(false);
  });

  test.each([
    ["no fields", { fields: [] }],
    ["97 fields", { fields: Array.from({ length: 97 }, (_, i) => ({ name: `f${i}`, type: "text" })) }],
    ["a field declared twice", { fields: [{ name: "a", type: "text" }, { name: "a", type: "number" }] }],
    ["an entity that is not workspace-scoped", { workspaceScoped: false }],
    ["a key the entity does not define", { owner: "bob" }],
  ])("%s", (_label, overrides) => {
    expect(parse(entity(overrides)).ok).toBe(false);
  });

  test("an entity declared twice, and a name a brick's routes already use", () => {
    expect(refused([invoices, invoices])).toMatch(/entity "invoices" is declared twice/);
    expect(refused([{ ...invoices, name: "wallet" }], ["wallet", "payments"])).toMatch(/entity "wallet" uses a name that a brick's routes already use/);
  });

  test("more than 20 entities, and input that is not a list", () => {
    expect(parse(Array.from({ length: 21 }, (_, i) => ({ ...invoices, name: `e${i}` }))).ok).toBe(false);
    for (const input of [null, "invoices", { name: "invoices" }, 7]) expect(parse(input).ok).toBe(false);
  });
});

describe("the migration it generates", () => {
  test("is the expected text for the invoices declaration", () => {
    expect(entityDdl(good([invoices])[0]!)).toBe(`-- Generated from the blueprint's declaration of invoices. Do not edit.
CREATE TABLE IF NOT EXISTS "ent_invoices" (
  "id" TEXT PRIMARY KEY,
  "workspace_id" TEXT NOT NULL,
  "client_name" TEXT NOT NULL CHECK (length("client_name") <= 500),
  "amount" INTEGER,
  "status" TEXT CHECK ("status" IN ('draft', 'paid', 'overdue')),
  "pdf_r2_url" TEXT CHECK (length("pdf_r2_url") <= 500),
  "created_at" TEXT NOT NULL DEFAULT (datetime('now')),
  "updated_at" TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS "ent_invoices_workspace_idx" ON "ent_invoices"("workspace_id", "created_at");
`);
  });

  test("contains no semicolon except at the end of a statement (the migration splitter splits on every one)", () => {
    const sql = entityDdl(good([invoices])[0]!).replace(/--.*$/gm, "");
    expect(sql.split(";").filter((s) => s.trim()).length).toBe(2);
  });

  test("runs in D1 for every field type, and the constraints it generates bite", async () => {
    const all = good([
      {
        name: "everything",
        fields: [
          { name: "label", type: "text", required: true, maxLength: 5 },
          { name: "count", type: "number", min: 1, max: 9 },
          { name: "done", type: "boolean", required: true },
          { name: "kind", type: "enum", values: ["a", "b"] },
        ],
      },
    ])[0]!;
    await db.prepare('DROP TABLE IF EXISTS "ent_everything"').run();
    await applyMigration(db, entityDdl(all));
    const insert = (label: unknown, count: unknown, done: unknown, kind: unknown) =>
      db.prepare('INSERT INTO "ent_everything" ("id","workspace_id","label","count","done","kind") VALUES (?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), "w", label, count, done, kind).run();
    await insert("ok", 5, 1, "a"); // a valid row
    await expect(insert("toolong", 5, 1, "a")).rejects.toThrow(/CHECK constraint failed/);
    await expect(insert("ok", 0, 1, "a")).rejects.toThrow(/CHECK constraint failed/);
    await expect(insert("ok", 10, 1, "a")).rejects.toThrow(/CHECK constraint failed/);
    await expect(insert("ok", 5, 2, "a")).rejects.toThrow(/CHECK constraint failed/);
    await expect(insert("ok", 5, 1, "c")).rejects.toThrow(/CHECK constraint failed/);
    await expect(insert(null, 5, 1, "a")).rejects.toThrow(/NOT NULL constraint failed/);
    await expect(insert("ok", 5, null, "a")).rejects.toThrow(/NOT NULL constraint failed/);
    await insert("ok", null, 0, null); // optional fields may be empty
  });

  test.each(["select", "order", "group", "table", "index", "values", "default", "check"])("a field named after the SQL word %s is quoted, and works", async (word) => {
    const entity = good([{ name: "words", fields: [{ name: word, type: "text" }] }])[0]!;
    await db.prepare('DROP TABLE IF EXISTS "ent_words"').run();
    await applyMigration(db, entityDdl(entity));
    await db.prepare(`INSERT INTO "ent_words" ("id","workspace_id","${word}") VALUES ('1','w','x')`).run();
    expect((await db.prepare(`SELECT "${word}" AS v FROM "ent_words"`).first<{ v: string }>())?.v).toBe("x");
  });

  test("two runs of the generator give the same text", () => {
    const entity: Entity = good([invoices])[0]!;
    expect(entityDdl(entity)).toBe(entityDdl(structuredClone(entity)));
  });
});
