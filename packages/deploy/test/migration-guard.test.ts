import { describe, expect, it } from "vitest";
import { analyzeSqlMigrations } from "../src/index.ts";

describe("Story 5.3 — SQL Destructive-Migration Guard (analyzeSqlMigrations)", () => {
  it("allows safe additive DDL migrations (CREATE TABLE, CREATE INDEX, ALTER TABLE ADD COLUMN, qualified DELETE WHERE)", () => {
    const warnings = analyzeSqlMigrations([
      {
        name: "0001_init.sql",
        sql: `
          CREATE TABLE IF NOT EXISTS customers (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            bio TEXT
          );
          CREATE INDEX IF NOT EXISTS customers_email_idx ON customers(email);
        `,
      },
      {
        name: "0002_add_tier.sql",
        sql: `
          ALTER TABLE customers ADD COLUMN tier TEXT DEFAULT 'free';
          DELETE FROM customers WHERE email = 'test@example.com';
        `,
      },
    ]);

    expect(warnings).toEqual([]);
  });

  it("detects DROP TABLE and flags kind = drop_table with affectedTable", () => {
    const warnings = analyzeSqlMigrations([
      {
        name: "0003_drop_legacy.sql",
        sql: "DROP TABLE IF EXISTS legacy_sessions;",
      },
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      migrationName: "0003_drop_legacy.sql",
      kind: "drop_table",
      affectedTable: "legacy_sessions",
    });
    expect(warnings[0]!.message).toContain("legacy_sessions");
  });

  it("detects ALTER TABLE ... DROP COLUMN and flags kind = drop_column with affectedTable and affectedColumn", () => {
    const warnings = analyzeSqlMigrations([
      {
        name: "0004_drop_col.sql",
        sql: "ALTER TABLE invoices DROP COLUMN internal_notes;",
      },
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      migrationName: "0004_drop_col.sql",
      kind: "drop_column",
      affectedTable: "invoices",
      affectedColumn: "internal_notes",
    });
    expect(warnings[0]!.message).toContain("internal_notes");
  });

  it("detects TRUNCATE TABLE and unqualified DELETE FROM <table> without WHERE as kind = truncate", () => {
    const warnings = analyzeSqlMigrations([
      {
        name: "0005_truncate.sql",
        sql: `
          TRUNCATE TABLE audit_events;
          DELETE FROM webhook_deliveries;
        `,
      },
    ]);

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatchObject({
      migrationName: "0005_truncate.sql",
      kind: "truncate",
      affectedTable: "audit_events",
    });
    expect(warnings[1]).toMatchObject({
      migrationName: "0005_truncate.sql",
      kind: "truncate",
      affectedTable: "webhook_deliveries",
    });
  });

  it("detects column type narrowing via ALTER COLUMN TYPE and SQLite table-rebuild pattern as kind = type_narrowing", () => {
    const warnings = analyzeSqlMigrations(
      [
        {
          name: "0006_narrow_amount.sql",
          sql: "ALTER TABLE orders ALTER COLUMN total_amount TYPE INTEGER;",
        },
        {
          name: "0007_sqlite_rebuild_narrow.sql",
          sql: `
            CREATE TABLE users_new (
              id TEXT PRIMARY KEY,
              age INTEGER NOT NULL
            );
            INSERT INTO users_new (id, age) SELECT id, CAST(age AS INTEGER) FROM users;
            DROP TABLE users;
            ALTER TABLE users_new RENAME TO users;
          `,
        },
      ],
      {
        previousSchemas: {
          orders: { id: "TEXT", total_amount: "TEXT" },
          users: { id: "TEXT", age: "TEXT", legacy_bio: "TEXT" },
        },
      },
    );

    expect(
      warnings.some(
        (w) =>
          w.migrationName === "0006_narrow_amount.sql" &&
          w.kind === "type_narrowing" &&
          w.affectedTable === "orders" &&
          w.affectedColumn === "total_amount",
      ),
    ).toBe(true);

    expect(
      warnings.some(
        (w) =>
          w.migrationName === "0007_sqlite_rebuild_narrow.sql" &&
          w.kind === "type_narrowing" &&
          w.affectedTable === "users" &&
          w.affectedColumn === "age",
      ),
    ).toBe(true);

    expect(
      warnings.some(
        (w) =>
          w.migrationName === "0007_sqlite_rebuild_narrow.sql" &&
          w.kind === "drop_column" &&
          w.affectedTable === "users" &&
          w.affectedColumn === "legacy_bio",
      ),
    ).toBe(true);
  });
});
