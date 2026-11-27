import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TARGET_TS_PATH = join(ROOT, "packages", "deploy", "src", "target.ts");
const CONTRACTS_TS_PATH = join(ROOT, "bricks", "contracts.ts");

describe("UC8.9 — Refactor sweep (UC8)", () => {
  it("AC2 & Task 2: target.ts line count is lower than at UC8.1 start (< 5447 lines)", () => {
    const content = readFileSync(TARGET_TS_PATH, "utf8");
    const lines = content.split(/\r?\n/);
    const lineCount = lines.length;

    // Line count at UC8.1 start (commit b6c534d) was 5,447 lines; context cites 5,791 at earlier baseline.
    expect(lineCount, `target.ts line count must be lower than at UC8.1 start (5447 lines), but got ${lineCount}`).toBeLessThan(5447);
  });

  it("Task 2: target.ts does not import unused symbols from migration-lint.ts", () => {
    const content = readFileSync(TARGET_TS_PATH, "utf8");
    const migrationLintImportMatch = content.match(/import\s*\{([^}]+)\}\s*from\s*["']\.\/migration-lint(?:\.ts)?["']/);
    expect(migrationLintImportMatch, "import from ./migration-lint.ts must exist").toBeTruthy();

    const importedSymbols = migrationLintImportMatch![1]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // cleanSqlIdentifier, isNarrowerSqlType, parseSqlColumnType are superseded by lintMigration
    expect(importedSymbols).not.toContain("cleanSqlIdentifier");
    expect(importedSymbols).not.toContain("isNarrowerSqlType");
    expect(importedSymbols).not.toContain("parseSqlColumnType");
  });

  it("Task 3: bricks/contracts.ts imports schemas from packages/assembler/src/schemas.ts and removes duplicate definitions", () => {
    const content = readFileSync(CONTRACTS_TS_PATH, "utf8");

    // Must import from packages/assembler/src/schemas.ts
    const hasAssemblerImport =
      content.includes('from "../packages/assembler/src/schemas.ts"') ||
      content.includes('from "../packages/assembler/src/schemas"') ||
      content.includes('from "@poc/assembler"');
    expect(hasAssemblerImport, 'bricks/contracts.ts must import from "../packages/assembler/src/schemas.ts" or "@poc/assembler"').toBe(true);

    // Must not duplicate SettingDefinitionSchema or SettingDeprecatedSchema inline
    expect(content.includes('z.discriminatedUnion("type", ['), "bricks/contracts.ts must not duplicate settingDefinition schema inline").toBe(false);
  });

  it("Task 3: bricks/contracts.ts exported schemas validate valid and invalid brick definitions", async () => {
    const contracts = await import("../../bricks/contracts.ts");

    // SettingDeprecatedSchema
    expect(contracts.SettingDeprecatedSchema.safeParse({ since: "1.0.0" }).success).toBe(true);
    expect(contracts.SettingDeprecatedSchema.safeParse({ since: "1.0" }).success).toBe(false);

    // SettingDefinitionSchema
    expect(
      contracts.SettingDefinitionSchema.safeParse({
        type: "integer",
        min: 0,
        max: 100,
        default: 10,
      }).success,
    ).toBe(true);

    // BrickManifestSchema rejects invalid semver version (e.g. "1.2")
    const invalidManifest = {
      manifestVersion: 2,
      kind: "brick",
      id: "test-brick",
      version: "1.2",
      trust: "first-party",
      isolation: "none",
      provides: [],
      requires: [],
      migrations: [],
      routePrefixes: ["test"],
      npmDependencies: {},
      settings: {},
      worker: {
        package: "@poc/test-brick",
        routes: [],
      },
    };
    expect(contracts.BrickManifestSchema.safeParse(invalidManifest).success).toBe(false);
  });
});
