import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { findUnscopedTableRefs, lintTenantQueries } from "../lint-tenant-queries.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES_DIR = join(ROOT, "scripts", "test", "fixtures", "tenant-lint");
const SCRIPT_PATH = join(ROOT, "scripts", "lint-tenant-queries.ts");

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("lint-tenant-queries", () => {
  test("flags direct db.prepare on a tenant table (1 violation)", () => {
    const result = lintTenantQueries({
      bricksDir: join(FIXTURES_DIR, "violating-direct-prepare"),
      allowlistPath: join(FIXTURES_DIR, "non-existent-allowlist.json"),
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.table).toBe("t");
    expect(result.violations[0]!.file).toContain("violating-direct-prepare");
    expect(result.violations[0]!.line).toBeGreaterThan(0);
    expect(result.violations[0]!.message).toMatch(/violating-direct-prepare.*:\d+\s+t/);
  });

  test("passes brick using scoped() on a tenant table (0 violations)", () => {
    const result = lintTenantQueries({
      bricksDir: join(FIXTURES_DIR, "valid-scoped"),
      allowlistPath: join(FIXTURES_DIR, "non-existent-allowlist.json"),
    });

    expect(result.violations).toHaveLength(0);
  });

  test("passes brick querying declared global table with a reason (0 violations)", () => {
    const result = lintTenantQueries({
      bricksDir: join(FIXTURES_DIR, "valid-global"),
      allowlistPath: join(FIXTURES_DIR, "non-existent-allowlist.json"),
    });

    expect(result.violations).toHaveLength(0);
  });

  test("flags template-literal prepare on a tenant table (1 violation)", () => {
    const result = lintTenantQueries({
      bricksDir: join(FIXTURES_DIR, "violating-template-literal"),
      allowlistPath: join(FIXTURES_DIR, "non-existent-allowlist.json"),
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.table).toBe("t");
    expect(result.violations[0]!.file).toContain("violating-template-literal");
    expect(result.violations[0]!.line).toBeGreaterThan(0);
  });

  test("allows a query with a preceding // tenant-lint: allow <reason> comment, alongside a named allowlist entry", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tenant-lint-test-"));
    tempDirs.push(tempDir);

    const brickDir = join(tempDir, "allowed-brick");
    mkdirSync(join(brickDir, "src"), { recursive: true });
    mkdirSync(join(brickDir, "migrations"), { recursive: true });

    writeFileSync(
      join(brickDir, "brick.manifest.json"),
      JSON.stringify({
        manifestVersion: 2,
        kind: "brick",
        id: "allowed-brick",
        version: "1.0.0",
        trust: "first-party",
        provides: [],
        requires: [],
        migrations: ["migrations/0001_init.sql"],
        routePrefixes: ["allowed"],
        npmDependencies: {},
        settings: {},
        ui: {
          displayName: "Allowed Brick",
          category: "core",
          summary: "Fixture",
          maturity: "experimental",
          behaviourTest: "test/test.ts",
        },
        worker: { package: "@poc/allowed", routes: [] },
      }),
    );

    writeFileSync(
      join(brickDir, "migrations", "0001_init.sql"),
      "CREATE TABLE t (id TEXT, workspace_id TEXT);",
    );

    writeFileSync(
      join(brickDir, "src", "index.ts"),
      `interface D1Like { prepare(q: string): any; }
export function test(db: D1Like) {
  // tenant-lint: allow cross-tenant admin maintenance
  return db.prepare("SELECT * FROM t WHERE id = ?");
}
`,
    );

    const allowlistPath = join(tempDir, "allowlist.json");
    writeFileSync(
      allowlistPath,
      JSON.stringify([
        { file: "allowed-brick/src/index.ts", table: "t", reason: "cross-tenant admin maintenance" },
      ]),
    );

    const result = lintTenantQueries({
      bricksDir: tempDir,
      allowlistPath,
    });

    expect(result.violations).toHaveLength(0);
    expect(result.allowlistEntries).toHaveLength(1);
  });

  test("rejects a // tenant-lint: allow comment that gives no reason", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tenant-lint-test-"));
    tempDirs.push(tempDir);

    const brickDir = join(tempDir, "unauthorized-brick");
    mkdirSync(join(brickDir, "src"), { recursive: true });
    mkdirSync(join(brickDir, "migrations"), { recursive: true });

    writeFileSync(
      join(brickDir, "brick.manifest.json"),
      JSON.stringify({
        manifestVersion: 2,
        kind: "brick",
        id: "unauthorized-brick",
        version: "1.0.0",
        trust: "first-party",
        provides: [],
        requires: [],
        migrations: ["migrations/0001_init.sql"],
        routePrefixes: ["unauthorized"],
        npmDependencies: {},
        settings: {},
        ui: {
          displayName: "Unauthorized Brick",
          category: "core",
          summary: "Fixture",
          maturity: "experimental",
          behaviourTest: "test/test.ts",
        },
        worker: { package: "@poc/unauthorized", routes: [] },
      }),
    );

    writeFileSync(
      join(brickDir, "migrations", "0001_init.sql"),
      "CREATE TABLE t (id TEXT, workspace_id TEXT);",
    );

    writeFileSync(
      join(brickDir, "src", "index.ts"),
      `interface D1Like { prepare(q: string): any; }
export function test(db: D1Like) {
  // tenant-lint: allow
  return db.prepare("SELECT * FROM t WHERE id = ?");
}
`,
    );

    const allowlistPath = join(tempDir, "allowlist.json");
    writeFileSync(allowlistPath, JSON.stringify([]));

    const result = lintTenantQueries({
      bricksDir: tempDir,
      allowlistPath,
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.message).toMatch(/needs a reason/);
  });

  // -------------------------------------------------------------------------------------------------------------------
  // AD-V2 (story 0.7): the lint reads WHERE clauses, and global()/systemScope() do not bypass it.

  const seededMigration = [
    "CREATE TABLE IF NOT EXISTS credit_ledger (",
    "  id TEXT PRIMARY KEY,",
    "  workspace_id TEXT NOT NULL,",
    "  idempotency_key TEXT,",
    "  balance_after INTEGER NOT NULL",
    ");",
    "CREATE TABLE IF NOT EXISTS plan_catalog (",
    "  id TEXT PRIMARY KEY,",
    "  name TEXT NOT NULL",
    ");",
  ].join("\n");

  /** Writes a one-file brick into a temp dir and lints it. */
  function lintSource(
    source: string,
    options: { allowlist?: unknown; globalTables?: Array<{ table: string; reason: string }> } = {},
  ) {
    const tempDir = mkdtempSync(join(tmpdir(), "tenant-lint-test-"));
    tempDirs.push(tempDir);
    const brickDir = join(tempDir, "seeded-brick");
    mkdirSync(join(brickDir, "src"), { recursive: true });
    mkdirSync(join(brickDir, "migrations"), { recursive: true });
    writeFileSync(
      join(brickDir, "brick.manifest.json"),
      JSON.stringify({
        id: "seeded-brick",
        migrations: ["migrations/0001_init.sql"],
        ...(options.globalTables ? { globalTables: options.globalTables } : {}),
      }),
    );
    writeFileSync(join(brickDir, "migrations", "0001_init.sql"), seededMigration);
    writeFileSync(join(brickDir, "src", "index.ts"), source);
    const allowlistPath = join(tempDir, "allowlist.json");
    writeFileSync(allowlistPath, JSON.stringify(options.allowlist ?? []));
    return { tempDir, allowlistPath, result: lintTenantQueries({ bricksDir: tempDir, allowlistPath }) };
  }

  const lines = (...l: string[]) => l.join("\n") + "\n";

  test("LINT_SEEDED_LEAK: an id read on a tenant table without workspace_id fails, naming file:line and table", () => {
    const { tempDir, allowlistPath, result } = lintSource(
      lines(
        'import type { D1Like } from "@poc/sdk";',
        "export function read(db: D1Like, id: string) {",
        '  return db.prepare("SELECT * FROM credit_ledger WHERE id = ?").bind(id).first();',
        "}",
      ),
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.table).toBe("credit_ledger");
    expect(result.violations[0]!.line).toBe(3);
    expect(result.violations[0]!.message).toMatch(/seeded-brick\/src\/index\.ts:3 credit_ledger/);

    // The CLI exits 1 and prints the same file:line and table.
    let status = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [SCRIPT_PATH, "--bricks-dir", tempDir, "--allowlist", allowlistPath], {
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (err) {
      status = (err as { status: number }).status;
      stderr = String((err as { stderr: string }).stderr);
    }
    expect(status).toBe(1);
    expect(stderr).toMatch(/seeded-brick\/src\/index\.ts:3 credit_ledger/);
  });

  test("LINT_SEEDED_LEAK: a key lookup, an UPDATE, a DELETE, an INSERT and a COUNT without workspace_id are each flagged", () => {
    const { result } = lintSource(
      lines(
        'import type { D1Like } from "@poc/sdk";',
        "export async function leaks(db: D1Like, key: string) {",
        '  await db.prepare("SELECT balance_after FROM credit_ledger WHERE idempotency_key = ?").bind(key).first();',
        '  await db.prepare("UPDATE credit_ledger SET balance_after = 0 WHERE id = ?").bind(key).run();',
        "  await db.prepare(`DELETE FROM credit_ledger WHERE id = ?`).bind(key).run();",
        '  await db.prepare("INSERT INTO credit_ledger (id, balance_after) VALUES (?, 0)").bind(key).run();',
        '  await db.prepare("SELECT COUNT(*) AS n FROM credit_ledger").first();',
        "}",
      ),
    );
    expect(result.violations.map((v) => v.line)).toEqual([3, 4, 5, 6, 7]);
    expect(result.violations.every((v) => v.table === "credit_ledger")).toBe(true);
  });

  test("LINT_SYSTEMSCOPE_UNSCOPED: systemScope() and global() on a tenant table are checked, not trusted", () => {
    const { result } = lintSource(
      lines(
        'import { global, systemScope } from "@poc/sdk";',
        'import type { D1Like } from "@poc/sdk";',
        "export async function bypass(db: D1Like, id: string) {",
        '  await systemScope(db, "x").raw("SELECT * FROM credit_ledger WHERE id = ?", [id]).first();',
        '  await systemScope(db, "x").first("credit_ledger", "id = ?", [id]);',
        '  const sys = systemScope(db, "x");',
        '  await sys.delete("credit_ledger", "id = ?", [id]);',
        '  await global(db, "credit_ledger", "reasoned but still a leak").first("id = ?", [id]);',
        "}",
      ),
    );
    expect(result.violations.map((v) => `${v.line}:${v.table}`)).toEqual([
      "4:credit_ledger",
      "5:credit_ledger",
      "7:credit_ledger",
      "8:credit_ledger",
    ]);
  });

  test("LINT_SYSTEMSCOPE_UNSCOPED: an allowlist entry naming the file and table exempts it; one for another table does not", () => {
    const source = lines(
      'import { systemScope } from "@poc/sdk";',
      'import type { D1Like } from "@poc/sdk";',
      "export async function bypass(db: D1Like, id: string) {",
      '  return systemScope(db, "x").raw("SELECT * FROM credit_ledger WHERE id = ?", [id]).first();',
      "}",
    );
    const named = lintSource(source, {
      allowlist: [{ file: "seeded-brick/src/index.ts", table: "credit_ledger", reason: "fixture: platform sweep" }],
    });
    expect(named.result.violations).toHaveLength(0);

    const otherTable = lintSource(source, {
      allowlist: [{ file: "seeded-brick/src/index.ts", table: "plan_catalog", reason: "fixture: wrong table" }],
    });
    expect(otherTable.result.violations).toHaveLength(1);
  });

  test("LINT_SCOPED_OK: scoped() calls and SQL with a workspace_id predicate are not flagged", () => {
    const { result } = lintSource(
      lines(
        'import { scoped, systemScope } from "@poc/sdk";',
        'import type { D1Like } from "@poc/sdk";',
        "export async function ok(db: D1Like, ws: string, id: string, key: string) {",
        '  await scoped(db, ws).first("credit_ledger");',
        '  await scoped(db, ws).first("credit_ledger", "id = ?", [id]);',
        '  await db.prepare("SELECT * FROM credit_ledger WHERE id = ? AND workspace_id = ?").bind(id, ws).first();',
        '  await db.prepare("SELECT l.id FROM credit_ledger l WHERE l.workspace_id = ? AND l.idempotency_key = ?").bind(ws, key).first();',
        '  await db.prepare("UPDATE credit_ledger SET balance_after = 0 WHERE workspace_id = ? AND id = ?").bind(ws, id).run();',
        "  await db",
        "    .prepare(",
        '      "INSERT INTO credit_ledger (id, workspace_id, balance_after) " +',
        '        "SELECT ?, workspace_id, 0 FROM credit_ledger WHERE workspace_id = ? LIMIT 1",',
        "    )",
        "    .bind(id, ws)",
        "    .run();",
        '  await systemScope(db, "x").first("credit_ledger", "workspace_id = ? AND id = ?", [ws, id]);',
        "  // A table with no workspace_id column is not a tenant table.",
        '  await db.prepare("SELECT * FROM plan_catalog WHERE id = ?").bind(id).first();',
        "  // Prose that mentions a table is not a query.",
        '  throw new Error("Could not update credit_ledger row");',
        "}",
      ),
    );
    expect(result.violations).toEqual([]);
  });

  test("a workspace_id predicate in a sub-select does not cover the outer query, and vice versa", () => {
    const { result } = lintSource(
      lines(
        'import type { D1Like } from "@poc/sdk";',
        "export async function nested(db: D1Like, ws: string, id: string) {",
        '  await db.prepare("SELECT * FROM credit_ledger WHERE id IN (SELECT id FROM credit_ledger WHERE workspace_id = ?)").bind(ws).all();',
        '  await db.prepare("UPDATE credit_ledger SET balance_after = 0 WHERE workspace_id = ? AND EXISTS (SELECT 1 FROM credit_ledger WHERE id = ?)").bind(ws, id).run();',
        "}",
      ),
    );
    expect(result.violations.map((v) => v.line)).toEqual([3, 4]);
  });

  test("a table declared in globalTables is not checked", () => {
    const { result } = lintSource(
      lines(
        'import type { D1Like } from "@poc/sdk";',
        'export const read = (db: D1Like, id: string) => db.prepare("SELECT * FROM credit_ledger WHERE id = ?").bind(id).first();',
      ),
      { globalTables: [{ table: "credit_ledger", reason: "fixture: declared global" }] },
    );
    expect(result.violations).toHaveLength(0);
  });

  test("allowlist entries must name a file, a table and a non-empty reason", () => {
    const { result } = lintSource(lines("export const nothing = 1;"), {
      allowlist: [
        { file: "seeded-brick/src/index.ts", reason: "no table" },
        { file: "seeded-brick/src/index.ts", table: "credit_ledger", reason: "  " },
      ],
    });
    const messages = result.violations.map((v) => v.message).join("\n");
    expect(messages).toMatch(/names no table/);
    expect(messages).toMatch(/empty reason/);
  });

  test("findUnscopedTableRefs reads WHERE clauses, INSERT column lists and quoted values", () => {
    const tables = ["credit_ledger"];
    expect(findUnscopedTableRefs("SELECT * FROM credit_ledger WHERE id = ?", tables)).toHaveLength(1);
    expect(findUnscopedTableRefs("SELECT * FROM credit_ledger WHERE id = ? AND workspace_id = ?", tables)).toHaveLength(0);
    expect(findUnscopedTableRefs("SELECT * FROM credit_ledger WHERE workspace_id IN (?, ?)", tables)).toHaveLength(0);
    // `SET workspace_id = ?` is not a predicate.
    expect(findUnscopedTableRefs("UPDATE credit_ledger SET workspace_id = ? WHERE id = ?", tables)).toHaveLength(1);
    expect(findUnscopedTableRefs("INSERT OR IGNORE INTO credit_ledger (id, workspace_id) VALUES (?, ?)", tables)).toHaveLength(0);
    expect(findUnscopedTableRefs("INSERT INTO credit_ledger VALUES (?, ?)", tables)).toHaveLength(1);
    // A table name inside a quoted SQL string value is not a table reference.
    expect(findUnscopedTableRefs("SELECT 'FROM credit_ledger' AS note", tables)).toHaveLength(0);
    expect(findUnscopedTableRefs("SELECT * FROM credit_ledger_archive WHERE id = ?", tables)).toHaveLength(0);
  });

  test("a predicate counts only when workspace_id is compared to a bound value on every OR branch", () => {
    const t = ["credit_ledger"];
    const unscoped = (sql: string) => findUnscopedTableRefs(sql, t).length;
    // Bound values: positional, numbered, named, IN lists and template substitutions.
    expect(unscoped("SELECT * FROM credit_ledger WHERE workspace_id = ?1")).toBe(0);
    expect(unscoped("SELECT * FROM credit_ledger WHERE workspace_id = :ws AND id = ?")).toBe(0);
    expect(unscoped("SELECT * FROM credit_ledger WHERE workspace_id = ${...}")).toBe(0);
    expect(unscoped("SELECT * FROM credit_ledger WHERE ? = workspace_id")).toBe(0);
    expect(unscoped("SELECT * FROM credit_ledger WHERE (id = ? AND workspace_id = ?)")).toBe(0);
    // IS [NOT] NULL never binds.
    expect(unscoped("SELECT * FROM credit_ledger WHERE workspace_id IS NOT NULL")).toBe(1);
    expect(unscoped("SELECT * FROM credit_ledger WHERE id = ? AND workspace_id IS ?")).toBe(1);
    // A top-level OR needs the predicate on both sides.
    expect(unscoped("SELECT * FROM credit_ledger WHERE id = ? OR workspace_id = ?")).toBe(1);
    expect(unscoped("SELECT * FROM credit_ledger WHERE workspace_id = ? AND (id = ? OR id = ?)")).toBe(0);
    expect(unscoped("SELECT * FROM credit_ledger WHERE (workspace_id = ? AND id = ?) OR (workspace_id = ? AND id = ?)")).toBe(0);
    expect(unscoped("SELECT * FROM credit_ledger WHERE workspace_id = ? OR workspace_id IS NULL")).toBe(1);
    // Comparing with another column is not a binding.
    expect(unscoped("SELECT * FROM credit_ledger WHERE workspace_id = owner_workspace")).toBe(1);
  });

  test("a join equality passes a binding only from a table that is itself bound to a value", () => {
    const t = ["credit_ledger", "credit_wallets"];
    const unscoped = (sql: string) => findUnscopedTableRefs(sql, t).map((f) => f.table);
    // Join equality alone binds neither side.
    expect(unscoped("SELECT * FROM credit_ledger l JOIN credit_wallets w ON w.workspace_id = l.workspace_id WHERE l.id = ?")).toEqual([
      "credit_ledger",
      "credit_wallets",
    ]);
    // One side bound by value: the join carries it to the other.
    expect(unscoped("SELECT * FROM credit_ledger l JOIN credit_wallets w ON w.workspace_id = l.workspace_id WHERE w.workspace_id = ?")).toEqual([]);
    // A value predicate on one alias does not bind the other.
    expect(unscoped("SELECT * FROM credit_ledger l JOIN credit_wallets w ON w.id = l.id WHERE w.workspace_id = ?")).toEqual(["credit_ledger"]);
  });

  test("global() with a non-literal table is a violation unless exempted", () => {
    const { result } = lintSource(
      lines(
        'import { global } from "@poc/sdk";',
        'import type { D1Like } from "@poc/sdk";',
        "export const read = (db: D1Like, table: string) => global(db, table, \"dynamic\").first(\"id = ?\", [1]);",
        "// tenant-lint: allow fixture: the table is chosen from a fixed list of global tables",
        "export const ok = (db: D1Like, table: string) => global(db, table, \"dynamic\").first(\"id = ?\", [1]);",
      ),
    );
    expect(result.violations.map((v) => `${v.line}:${v.table}`)).toEqual(["3:<non-literal table>"]);
  });

  test("systemScope()/global() handles kept on class fields or typed parameters are tracked", () => {
    const { result } = lintSource(
      lines(
        'import { global, systemScope, type SystemScopeDb } from "@poc/sdk";',
        'import type { D1Like } from "@poc/sdk";',
        "export class Repo {",
        '  private readonly ledger = global(this.db, "credit_ledger", "fixture");',
        "  private sys;",
        "  constructor(private readonly db: D1Like) {",
        '    this.sys = systemScope(db, "fixture");',
        "  }",
        "  async a(id: string) {",
        '    await this.sys.first("credit_ledger", "id = ?", [id]);',
        '    await this.ledger.first("id = ?", [id]);',
        "  }",
        "}",
        "export async function b(sys: SystemScopeDb, id: string) {",
        '  await sys.delete("credit_ledger", "id = ?", [id]);',
        "}",
      ),
    );
    expect(result.violations.map((v) => v.line)).toEqual([10, 11, 15]);
  });

  test("a where argument holding a sub-select is read as SQL", () => {
    const { result } = lintSource(
      lines(
        'import { scoped } from "@poc/sdk";',
        'import type { D1Like } from "@poc/sdk";',
        "export async function sub(db: D1Like, ws: string, id: string) {",
        '  await scoped(db, ws).first("plan_catalog", "id IN (SELECT id FROM credit_ledger WHERE id = ?)", [id]);',
        '  await scoped(db, ws).first("plan_catalog", "id IN (SELECT id FROM credit_ledger WHERE workspace_id = ?)", [ws]);',
        '  throw new Error("could not read from credit_ledger");',
        "}",
      ),
    );
    expect(result.violations.map((v) => v.line)).toEqual([4]);
  });

  test("LINT_REPO: the repository itself has no unscoped tenant queries", () => {
    const result = lintTenantQueries();
    expect(result.violations.map((v) => v.message)).toEqual([]);
    for (const entry of result.allowlistEntries) {
      expect(entry.table.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });
});
