// Test-only data seeding. POST .../data/seed refuses raw DDL and only seeds a project's own blueprint entity tables
// (story 16), and it writes only to the project's own data store, never to STUDIO_DB (story 17). Tests that need brick
// tables or arbitrary fixture tables write them here, straight to the test D1 that stands in for that data store (see
// sandbox-data-store.ts), as an operator would.
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";

export async function seedRowsDirectly(
  db: D1Like,
  options: {
    ddl?: string[];
    tables?: Record<string, Array<Record<string, unknown>>>;
  },
): Promise<number> {
  for (const sqlText of options.ddl ?? []) {
    if (sqlText.trim()) await applyMigration(db, sqlText);
  }
  let inserted = 0;
  for (const [tableName, rows] of Object.entries(options.tables ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) continue;
    for (const row of rows) {
      const cols = Object.keys(row).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
      if (cols.length === 0) continue;
      const vals = cols.map((col) => {
        const v = row[col];
        if (typeof v === "boolean") return v ? 1 : 0;
        if (v !== null && typeof v === "object") return JSON.stringify(v);
        return v ?? null;
      });
      await db
        .prepare(
          `INSERT OR REPLACE INTO "${tableName}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols
            .map((_, i) => `?${i + 1}`)
            .join(", ")})`,
        )
        .bind(...vals)
        .run();
      inserted += 1;
    }
  }
  return inserted;
}
