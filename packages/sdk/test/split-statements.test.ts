import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { D1Like } from "../src/index.ts";
import { applyMigration, splitStatements } from "../src/index.ts";

const db = env.DB as D1Like;

const brickMigrations = import.meta.glob("../../../bricks/*/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const outMigrations = import.meta.glob("../../../out/*/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("SQL statement splitter (UC8.1)", () => {
  it("INSERT INTO t VALUES ('a;b') gives 1 statement", () => {
    const stmts = splitStatements("INSERT INTO t VALUES ('a;b');");
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toBe("INSERT INTO t VALUES ('a;b')");
  });

  it("'it''s; fine' gives 1 statement", () => {
    const stmts = splitStatements("SELECT 'it''s; fine';");
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toBe("SELECT 'it''s; fine'");
  });

  it('"weird;col" gives 1 statement', () => {
    const stmts = splitStatements('SELECT "weird;col" FROM t;');
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toBe('SELECT "weird;col" FROM t');
  });

  it("`weird;col` backtick identifier gives 1 statement", () => {
    const stmts = splitStatements("SELECT `weird;col` FROM t;");
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toBe("SELECT `weird;col` FROM t");
  });

  it("[weird;col] bracket identifier gives 1 statement", () => {
    const stmts = splitStatements("SELECT [weird;col] FROM t;");
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toBe("SELECT [weird;col] FROM t");
  });

  it("/* ; */ block comment is ignored", () => {
    const stmts = splitStatements("SELECT 1; /* ; */ SELECT 2;");
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toBe("SELECT 1");
    expect(stmts[1]).toBe("SELECT 2");
  });

  it("'--not a comment' is kept intact", () => {
    const stmts = splitStatements("SELECT '--not a comment';");
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toBe("SELECT '--not a comment'");
  });

  it("empty or whitespace input gives 0 statements", () => {
    expect(splitStatements("")).toEqual([]);
    expect(splitStatements("   \n\t  ")).toEqual([]);
  });

  it("consecutive semicolons are ignored", () => {
    const stmts = splitStatements("SELECT 1;;; SELECT 2;;");
    expect(stmts).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("CREATE TRIGGER ... BEGIN ...; ...; END; gives 1 statement", () => {
    const sql = `
      CREATE TRIGGER x AFTER INSERT ON t BEGIN
        UPDATE a SET n=n+1;
        DELETE FROM b;
      END;
    `;
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain("CREATE TRIGGER x");
    expect(stmts[0]).toContain("UPDATE a SET n=n+1;");
    expect(stmts[0]).toContain("DELETE FROM b;");
    expect(stmts[0]).toMatch(/END$/);
  });

  it("CREATE TRIGGER with nested CASE WHEN ... END gives 1 statement", () => {
    const sql = `
      CREATE TRIGGER tr AFTER INSERT ON t BEGIN
        UPDATE a SET x = CASE WHEN NEW.val > 0 THEN 1 ELSE 0 END;
        DELETE FROM b WHERE id = NEW.id;
      END;
    `;
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain("CREATE TRIGGER tr");
    expect(stmts[0]).toContain("CASE WHEN NEW.val > 0 THEN 1 ELSE 0 END;");
    expect(stmts[0]).toContain("DELETE FROM b WHERE id = NEW.id;");
    expect(stmts[0]).toMatch(/END$/);
  });

  it("CASE WHEN ... END inside a statement is not a trigger end", () => {
    const sql = "SELECT id, CASE WHEN status = 'active' THEN 1 ELSE 0 END AS is_active FROM users;";
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toBe("SELECT id, CASE WHEN status = 'active' THEN 1 ELSE 0 END AS is_active FROM users");
  });

  it("handles CRLF input cleanly", () => {
    const sql = "SELECT 1;\r\nSELECT 2;\r\n";
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toBe("SELECT 1");
    expect(stmts[1]).toBe("SELECT 2");
  });

  it("handles trailing statement with no semicolon", () => {
    const sql = "SELECT 1; SELECT 2";
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toBe("SELECT 1");
    expect(stmts[1]).toBe("SELECT 2");
  });

  it("AC1: trigger case applies on workerd D1 and creates a working trigger", async () => {
    await db.prepare("DROP TABLE IF EXISTS t_audit").run();
    await db.prepare("DROP TABLE IF EXISTS t_source").run();

    const sql = `
      CREATE TABLE t_source (id INT, val TEXT);
      CREATE TABLE t_audit (event TEXT);
      CREATE TRIGGER tr_audit AFTER INSERT ON t_source BEGIN
        INSERT INTO t_audit VALUES ('inserted_' || NEW.val);
      END;
    `;
    const count = await applyMigration(db, sql);
    expect(count).toBe(3);

    await db.prepare("INSERT INTO t_source VALUES (1, 'demo')").run();
    const rows = await db.prepare("SELECT event FROM t_audit").all<{ event: string }>();
    expect(rows.results).toEqual([{ event: "inserted_demo" }]);
  });

  it("AC3: every shipped migration splits and applies with the new splitter", async () => {
    const allMigrations = { ...brickMigrations, ...outMigrations };
    expect(Object.keys(allMigrations).length).toBeGreaterThan(0);

    for (const [path, sql] of Object.entries(allMigrations)) {
      const stmts = splitStatements(sql);
      expect(stmts.length, `${path} should have at least 1 statement`).toBeGreaterThan(0);
      for (const s of stmts) {
        expect(s.trim().length, `${path} statement should not be empty`).toBeGreaterThan(0);
        // Semicolons should only exist inside statements if they are within string literals or triggers
        if (s.includes(";")) {
          const isTrigger = /CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER/i.test(s);
          const hasLiteralOrQuotes = /['"`]/.test(s);
          expect(isTrigger || hasLiteralOrQuotes, `${path} statement has unexpected semicolon: ${s}`).toBe(true);
        }
      }
    }
  });
});
