import { createHash } from "node:crypto";
import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import {
  DeployError,
  createClient,
  deploy,
  isWriteCall,
  memoryStore,
  openLedger,
  resourceNames,
} from "../src/provisioner/index.ts";
import type { DeployInput, Migration } from "../src/provisioner/index.ts";
import { createFakeCloudflare } from "./support/fake-cloudflare.ts";
import type { FakeOptions } from "./support/fake-cloudflare.ts";
import { lintMigration } from "../src/migration-lint.ts";

const TOKEN = "cfut_Zq8rLm3VxN2pTb7YkWd4HsJc9GaE5uRo6QiXf1BvPn0AyMt";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const KEY = "9f".repeat(32);
const SUFFIX = "0a1b2c3d";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const bundleOf = (code: string) => ({ code, sha256: sha(code) });
const BUNDLE = bundleOf("export default { fetch() { return new Response('ok'); } };");

function world(options: Partial<FakeOptions> = {}) {
  const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT, ...options });
  const credentials = { token: TOKEN, accountId: ACCOUNT };
  const client = createClient({ credentials, fetch: fake.fetch, sleep: async () => {}, alsoHide: [KEY] });
  const store = memoryStore();
  const ledger = openLedger(store, () => SUFFIX, () => new Date("2026-10-21T00:00:00Z"));
  const names = resourceNames(SUFFIX);
  const input = (over: Partial<DeployInput> = {}): DeployInput => ({
    client,
    ledger,
    names,
    accessKey: KEY,
    bundle: BUNDLE,
    migrations: [],
    compatibilityDate: "2026-10-01",
    nowIso: () => "2026-10-21T00:00:00.000Z",
    ...over,
  });
  return { fake, client, store, ledger, names, input };
}

describe("migration classification (UC8.4)", () => {
  describe("additive migrations", () => {
    test("CREATE TABLE classifies as additive", () => {
      const res = lintMigration(
        "0001_create.sql",
        "CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);"
      );
      expect(res.class).toBe("additive");
      expect(res.findings).toHaveLength(0);
    });

    test("ADD COLUMN nullable classifies as additive", () => {
      const res = lintMigration(
        "0002_add_col.sql",
        "ALTER TABLE users ADD COLUMN age INTEGER;"
      );
      expect(res.class).toBe("additive");
      expect(res.findings).toHaveLength(0);
    });

    test("ADD COLUMN with default classifies as additive", () => {
      const res = lintMigration(
        "0003_add_default.sql",
        "ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active';"
      );
      expect(res.class).toBe("additive");
      expect(res.findings).toHaveLength(0);
    });

    test("ADD COLUMN NOT NULL with default classifies as additive", () => {
      const res = lintMigration(
        "0004_add_not_null_default.sql",
        "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer';"
      );
      expect(res.class).toBe("additive");
      expect(res.findings).toHaveLength(0);
    });

    test("CREATE INDEX classifies as additive", () => {
      const res = lintMigration(
        "0005_idx.sql",
        "CREATE INDEX idx_users_name ON users(name);\nCREATE UNIQUE INDEX idx_users_role ON users(role);"
      );
      expect(res.class).toBe("additive");
      expect(res.findings).toHaveLength(0);
    });
  });

  describe("rewrite migrations", () => {
    test("SQLite rebuild pattern classifies as rewrite", () => {
      const sql = `
        CREATE TABLE users_new (id TEXT PRIMARY KEY, name TEXT, email TEXT);
        INSERT INTO users_new (id, name) SELECT id, name FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `;
      const res = lintMigration("0006_rebuild.sql", sql);
      expect(res.class).toBe("rewrite");
      expect(res.findings).toHaveLength(0);
    });

    test("UPDATE backfill classifies as rewrite", () => {
      const sql = "UPDATE users SET status = 'active' WHERE status IS NULL;";
      const res = lintMigration("0007_backfill.sql", sql);
      expect(res.class).toBe("rewrite");
      expect(res.findings).toHaveLength(0);
    });
  });

  describe("destructive migrations", () => {
    test("DROP TABLE classifies as destructive", () => {
      const res = lintMigration("0008_drop_table.sql", "DROP TABLE users;");
      expect(res.class).toBe("destructive");
      expect(res.findings.some((f) => f.kind === "drop_table")).toBe(true);
    });

    test("DROP COLUMN classifies as destructive", () => {
      const res = lintMigration(
        "0009_drop_col.sql",
        "ALTER TABLE users DROP COLUMN age;"
      );
      expect(res.class).toBe("destructive");
      expect(res.findings.some((f) => f.kind === "drop_column")).toBe(true);
    });

    test("ADD COLUMN NOT NULL without default classifies as destructive", () => {
      const res = lintMigration(
        "0010_add_not_null_no_default.sql",
        "ALTER TABLE users ADD COLUMN email TEXT NOT NULL;"
      );
      expect(res.class).toBe("destructive");
      expect(res.findings.length).toBeGreaterThan(0);
    });

    test("DELETE FROM without WHERE classifies as destructive", () => {
      const res = lintMigration("0011_truncate.sql", "DELETE FROM audit_logs;");
      expect(res.class).toBe("destructive");
      expect(res.findings.some((f) => f.kind === "truncate")).toBe(true);
    });

    test("narrowed type classifies as destructive", () => {
      const res = lintMigration(
        "0012_narrow.sql",
        "ALTER TABLE users MODIFY COLUMN bio VARCHAR(50);",
        { users: { bio: "VARCHAR(255)" } }
      );
      expect(res.class).toBe("destructive");
      expect(res.findings.some((f) => f.kind === "type_narrowing")).toBe(true);
    });

    test("ALTER TABLE RENAME TO outside rebuild pattern classifies as destructive", () => {
      const res = lintMigration(
        "0013_rename_table.sql",
        "ALTER TABLE users RENAME TO users_old;"
      );
      expect(res.class).toBe("destructive");
      expect(
        res.findings.some((f) => f.kind === "rename_table" || f.kind === "drop_table")
      ).toBe(true);
    });
  });
});

describe("deploy() migration linter gate (UC8.4)", () => {
  test("deploy() with a destructive pending migration and no flag throws MIGRATION_DESTRUCTIVE_BLOCKED before any write call", async () => {
    const w = world();
    const migrations: Migration[] = [
      { name: "0001_init.sql", sql: "CREATE TABLE t (id TEXT PRIMARY KEY, val TEXT);" },
      { name: "0002_drop.sql", sql: "DROP TABLE t;" },
    ];

    await expect(deploy(w.input({ migrations }))).rejects.toThrow("MIGRATION_DESTRUCTIVE_BLOCKED");

    // AC2: A blocked deploy performs zero write calls against the fake Cloudflare
    const writeCalls = w.client.calls.filter(isWriteCall);
    expect(writeCalls).toHaveLength(0);
  });

  test("AC3: contract migration whose expand migration is not yet deployed is refused naming both", async () => {
    const w = world();
    const migrations: Migration[] = [
      {
        name: "0002_contract.sql",
        sql: "-- projectx: phase=contract expands=0001_expand.sql\nALTER TABLE t DROP COLUMN old_col;",
      },
    ];

    let thrownError: Error | null = null;
    try {
      await deploy(w.input({ migrations }));
    } catch (err) {
      thrownError = err as Error;
    }

    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).toContain("0002_contract.sql");
    expect(thrownError!.message).toContain("0001_expand.sql");

    // Zero writes
    expect(w.client.calls.filter(isWriteCall)).toHaveLength(0);
  });

  test("contract migration whose expand migration was already deployed is allowed", async () => {
    const w = world();
    // Deploy expand migration in first deploy
    await deploy(
      w.input({
        migrations: [
          { name: "0001_expand.sql", sql: "CREATE TABLE t (id TEXT PRIMARY KEY, old_col TEXT, new_col TEXT);" },
        ],
      })
    );

    // Second deploy has contract migration with expand header
    const contractDeploy = await deploy(
      w.input({
        migrations: [
          { name: "0001_expand.sql", sql: "CREATE TABLE t (id TEXT PRIMARY KEY, old_col TEXT, new_col TEXT);" },
          {
            name: "0002_contract.sql",
            sql: "-- projectx: phase=contract expands=0001_expand.sql\nALTER TABLE t DROP COLUMN old_col;",
          },
        ],
      })
    );

    expect(contractDeploy.changes.some((c) => c.what.includes("0002_contract.sql"))).toBe(true);
  });

  test("destructive migration with allowDestructive: true proceeds and records allow_destructive in ledger", async () => {
    const w = world();
    const migrations: Migration[] = [
      { name: "0001_init.sql", sql: "CREATE TABLE t (id TEXT PRIMARY KEY);" },
      { name: "0002_drop.sql", sql: "DROP TABLE t;" },
    ];

    const result = await deploy(w.input({ migrations, allowDestructive: true }));
    expect(result.changes.some((c) => c.what.includes("0002_drop.sql"))).toBe(true);
    expect(w.ledger.entries().some((e) => e.kind === "allow_destructive")).toBe(true);
  });
});
