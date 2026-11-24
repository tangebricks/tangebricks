import { describe, expect, it } from "vitest";
import { SandboxDispatchPlatform } from "../src/index.ts";

// The default sandbox database (the platform's lightweight in-memory D1) is the preview data store the Studio data
// browser reads (story 17). Its filters compile to `"col" op ?N` clauses after the workspace clause; the database
// must apply them, not return every row of the workspace.
describe("sandbox lightweight D1: WHERE filter clauses", () => {
  async function seeded() {
    const platform = new SandboxDispatchPlatform();
    const { d1Binding: db } = await platform.ensureDatabase("sbx-where-filters");
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS ent_invoices (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL, amount_cents INTEGER NOT NULL)`,
    ).run();
    for (const [id, ws, title, amount] of [
      ["inv_a_1", "ws_a", "Alpha", 100],
      ["inv_a_9", "ws_a", "Gamma", 900],
      ["inv_a_10", "ws_a", "alphabet", 1000],
      ["inv_b_1", "ws_b", "Alpha", 5000],
    ] as const) {
      await db
        .prepare(`INSERT INTO ent_invoices (id, workspace_id, title, amount_cents) VALUES (?1, ?2, ?3, ?4)`)
        .bind(id, ws, title, amount)
        .run();
    }
    return db;
  }

  const ids = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.id).sort();

  it("applies gt / lt / eq numerically against a text-bound value, and counts the filtered rows", async () => {
    const db = await seeded();
    const gt = await db
      .prepare(`SELECT * FROM "ent_invoices" WHERE "workspace_id" = ?1 AND "amount_cents" > ?2 ORDER BY "id" ASC LIMIT ?3 OFFSET ?4`)
      .bind("ws_a", "800", 50, 0)
      .all<Record<string, unknown>>();
    expect(ids(gt.results)).toEqual(["inv_a_10", "inv_a_9"]);

    const count = await db
      .prepare(`SELECT COUNT(*) AS cnt FROM "ent_invoices" WHERE "workspace_id" = ?1 AND "amount_cents" > ?2`)
      .bind("ws_a", "800")
      .first<{ cnt: number }>();
    expect(count?.cnt).toBe(2);

    const lt = await db
      .prepare(`SELECT * FROM "ent_invoices" WHERE "workspace_id" = ?1 AND "amount_cents" < ?2`)
      .bind("ws_a", "200")
      .all<Record<string, unknown>>();
    expect(ids(lt.results)).toEqual(["inv_a_1"]);

    const eq = await db
      .prepare(`SELECT * FROM "ent_invoices" WHERE "workspace_id" = ?1 AND "amount_cents" = ?2`)
      .bind("ws_a", "900")
      .all<Record<string, unknown>>();
    expect(ids(eq.results)).toEqual(["inv_a_9"]);
  });

  it("applies a contains (LIKE) clause case-insensitively and never crosses the workspace clause", async () => {
    const db = await seeded();
    const like = await db
      .prepare(`SELECT * FROM "ent_invoices" WHERE "workspace_id" = ?1 AND CAST("title" AS TEXT) LIKE ?2`)
      .bind("ws_a", "%alpha%")
      .all<Record<string, unknown>>();
    expect(ids(like.results)).toEqual(["inv_a_1", "inv_a_10"]);
  });

  it("updates only the row its WHERE names, as the data browser's edit does", async () => {
    const db = await seeded();
    await db
      .prepare(`UPDATE "ent_invoices" SET "title" = ?3, "amount_cents" = ?4 WHERE "workspace_id" = ?1 AND "id" = ?2`)
      .bind("ws_a", "inv_a_1", "Edited", 2500)
      .run();
    const all = await db.prepare(`SELECT * FROM "ent_invoices"`).all<Record<string, unknown>>();
    const byId = new Map(all.results.map((r) => [r.id, r]));
    expect(byId.get("inv_a_1")).toMatchObject({ title: "Edited", amount_cents: 2500 });
    expect(byId.get("inv_b_1")).toMatchObject({ title: "Alpha", amount_cents: 5000 });
    expect(byId.get("inv_a_9")).toMatchObject({ title: "Gamma", amount_cents: 900 });

    // The same id in another workspace is not touched
    await db
      .prepare(`UPDATE "ent_invoices" SET "title" = ?3 WHERE "workspace_id" = ?1 AND "id" = ?2`)
      .bind("ws_b", "inv_a_9", "Cross")
      .run();
    const after = await db.prepare(`SELECT * FROM "ent_invoices" WHERE "id" = ?1`).bind("inv_a_9").first<Record<string, unknown>>();
    expect(after?.title).toBe("Gamma");
  });

  it("deletes only the row its WHERE names, never the rest of the table", async () => {
    const db = await seeded();
    await db.prepare(`DELETE FROM "ent_invoices" WHERE "workspace_id" = ?1 AND "id" = ?2`).bind("ws_a", "inv_a_1").run();
    const all = await db.prepare(`SELECT * FROM "ent_invoices"`).all<Record<string, unknown>>();
    expect(ids(all.results)).toEqual(["inv_a_10", "inv_a_9", "inv_b_1"]);
  });

  it("deletes nothing when the WHERE has a shape it cannot evaluate, and clears the table only without a WHERE", async () => {
    const db = await seeded();
    await db.prepare(`DELETE FROM "ent_invoices" WHERE "amount_cents" BETWEEN ?1 AND ?2`).bind(0, 950).run();
    const afterOpaque = await db.prepare(`SELECT * FROM "ent_invoices"`).all<Record<string, unknown>>();
    expect(ids(afterOpaque.results)).toEqual(["inv_a_1", "inv_a_10", "inv_a_9", "inv_b_1"]);

    await db.prepare(`DELETE FROM "ent_invoices"`).run();
    const afterAll = await db.prepare(`SELECT * FROM "ent_invoices"`).all<Record<string, unknown>>();
    expect(afterAll.results).toEqual([]);
  });
});
