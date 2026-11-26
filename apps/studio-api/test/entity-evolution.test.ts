import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { D1Like } from "@poc/sdk";
import { entityAddColumnStatements } from "../src/entity-evolution.ts";

const db = (env as unknown as { DB: D1Like }).DB;

describe("entity evolution ADD COLUMN statements (story 1.18)", () => {
  it("keeps the old mapping for the pre-existing types: number REAL, integer and boolean INTEGER, others TEXT", () => {
    const sql = (type: string) => entityAddColumnStatements("things", undefined, { name: "f", type }).map((s) => s.sql);
    expect(sql("number")).toEqual(["ALTER TABLE things ADD COLUMN f REAL;"]);
    expect(sql("integer")).toEqual(["ALTER TABLE things ADD COLUMN f INTEGER;"]);
    expect(sql("boolean")).toEqual(["ALTER TABLE things ADD COLUMN f INTEGER;"]);
    for (const type of ["text", "string", "json", "datetime", "enum"]) expect(sql(type)).toEqual(["ALTER TABLE things ADD COLUMN f TEXT;"]);
  });

  it("adds date, longtext, relation and money columns with the CHECK a new table gets (money is two columns)", () => {
    expect(entityAddColumnStatements("things", undefined, { name: "due_on", type: "date" } as never)).toEqual([
      { column: "due_on", sql: 'ALTER TABLE things ADD COLUMN "due_on" TEXT CHECK ("due_on" IS date("due_on"));' },
    ]);
    expect(entityAddColumnStatements("things", undefined, { name: "notes", type: "longtext" } as never)[0]!.sql).toBe(
      'ALTER TABLE things ADD COLUMN "notes" TEXT CHECK (length("notes") <= 20000);',
    );
    expect(entityAddColumnStatements("things", undefined, { name: "owner_id", type: "relation", relation: "users" } as never)[0]!.sql).toBe(
      'ALTER TABLE things ADD COLUMN "owner_id" TEXT CHECK (length("owner_id") = 36);',
    );
    expect(entityAddColumnStatements("things", undefined, { name: "fee", type: "money", currencies: ["INR"] } as never).map((s) => s.column)).toEqual(["fee", "fee__currency"]);
  });

  it("a field that becomes money gains its currency column; other unchanged or changed fields add nothing", () => {
    const money = { name: "fee", type: "money", currencies: ["INR"] } as never;
    expect(entityAddColumnStatements("things", { name: "fee", type: "number" }, money)).toEqual([
      {
        column: "fee__currency",
        sql: `ALTER TABLE things ADD COLUMN "fee__currency" TEXT CHECK ("fee__currency" IN ('INR') AND (("fee" IS NULL) = ("fee__currency" IS NULL)));`,
      },
    ]);
    expect(entityAddColumnStatements("things", { name: "fee", type: "money" }, money)).toEqual([]);
    expect(entityAddColumnStatements("things", { name: "f", type: "text" }, { name: "f", type: "number" })).toEqual([]);
  });

  it("the statements run in D1 and their CHECKs bite", async () => {
    await db.prepare("DROP TABLE IF EXISTS evo_things").run();
    await db.prepare("CREATE TABLE evo_things (id TEXT PRIMARY KEY, fee INTEGER)").run();
    const fields = [
      { name: "due_on", type: "date" },
      { name: "owner_id", type: "relation", relation: "users" },
    ];
    for (const field of fields) for (const { sql } of entityAddColumnStatements("evo_things", undefined, field as never)) await db.prepare(sql).run();
    for (const { sql } of entityAddColumnStatements("evo_things", { name: "fee", type: "number" }, { name: "fee", type: "money", currencies: ["INR"] } as never)) await db.prepare(sql).run();
    await db.prepare("INSERT INTO evo_things (id, fee, fee__currency, due_on) VALUES ('a', 100, 'INR', '2026-11-26')").run();
    await expect(db.prepare("INSERT INTO evo_things (id, due_on) VALUES ('b', '2026-13-01')").run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(db.prepare("INSERT INTO evo_things (id, fee, fee__currency) VALUES ('c', 1, 'USD')").run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(db.prepare("INSERT INTO evo_things (id, owner_id) VALUES ('d', 'short')").run()).rejects.toThrow(/CHECK constraint failed/);
  });
});
