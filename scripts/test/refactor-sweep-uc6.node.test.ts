import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintTenantQueries, loadAllowlist } from "../lint-tenant-queries.ts";
import { ManifestSchema } from "../../packages/assembler/src/schemas.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BRICK_AUDIT_PATH = join(ROOT, "docs", "brick-audit.md");
const ALLOWLIST_PATH = join(ROOT, "scripts", "tenant-lint-allowlist.json");

describe("UC6.8 — Refactor sweep (UC6)", () => {
  // Story 0.7 (AD-V2) rewrote the lint to read WHERE clauses; entries are now one per (file, table), and the count at
  // that story's close (9 by-design cross-tenant lookups in other bricks) is the ratchet. It may only go down.
  it("AC2 & Task 2: tenant lint allowlist is at or below the count at story 0.7 close (<= 9) and lint passes with 0 violations", () => {
    const { entries, errors } = loadAllowlist(ALLOWLIST_PATH);
    expect(errors).toHaveLength(0);
    expect(
      entries.length,
      `tenant-lint allowlist must be <= 9 entries (found: ${entries.length})`,
    ).toBeLessThanOrEqual(9);

    for (const entry of entries) {
      expect(entry.table.trim().length).toBeGreaterThan(0);
      expect(entry.reason.trim().length).toBeGreaterThan(0);
    }

    const result = lintTenantQueries({
      bricksDir: join(ROOT, "bricks"),
      allowlistPath: ALLOWLIST_PATH,
    });
    expect(result.violations).toHaveLength(0);
  });

  it("Task 3: no stale FORBIDDEN_TOKENS exports or definitions exist across bricks or runtime packages", () => {
    const searchDirs = [
      join(ROOT, "bricks"),
      join(ROOT, "packages"),
      join(ROOT, "scripts"),
    ];

    const forbiddenHits: string[] = [];

    function scan(dir: string) {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".evidence-run") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full);
        } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
          if (entry.name === "refactor-sweep-uc6.node.test.ts") continue;
          const content = readFileSync(full, "utf8");
          if (content.includes("FORBIDDEN_TOKENS")) {
            forbiddenHits.push(full.replace(/\\/g, "/"));
          }
        }
      }
    }

    for (const dir of searchDirs) {
      scan(dir);
    }

    expect(
      forbiddenHits,
      `No FORBIDDEN_TOKENS should remain in runtime, bricks, or scripts (found in ${forbiddenHits.join(", ")})`,
    ).toEqual([]);
  });

  it("Task 3: ManifestSchema enforces that untrusted bricks require isolation: 'dispatch' and rejects isolation: 'none'", () => {
    const baseManifest = {
      manifestVersion: 2,
      kind: "brick",
      id: "untrusted-test-brick",
      version: "1.0.0",
      ui: {
        displayName: "Test Untrusted Brick",
        category: "developer",
        summary: "Test untrusted brick",
        maturity: "experimental",
        maturityReason: "Test brick",
        behaviourTest: "test/index.test.ts",
      },
      provides: [],
      requires: [],
      migrations: [],
      routePrefixes: ["test-untrusted"],
      npmDependencies: {},
      settings: {},
      worker: {
        package: "@poc/test-untrusted",
        routes: [],
      },
    };

    // 1. Untrusted with default isolation (none) must fail
    const parsedDefault = ManifestSchema.safeParse({
      ...baseManifest,
      trust: "untrusted",
    });
    expect(parsedDefault.success).toBe(false);
    if (!parsedDefault.success) {
      const msgs = parsedDefault.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes('untrusted requires isolation: "dispatch"'))).toBe(true);
    }

    // 2. Untrusted with explicit isolation: "none" must fail
    const parsedNone = ManifestSchema.safeParse({
      ...baseManifest,
      trust: "untrusted",
      isolation: "none",
    });
    expect(parsedNone.success).toBe(false);
    if (!parsedNone.success) {
      const msgs = parsedNone.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes('untrusted requires isolation: "dispatch"'))).toBe(true);
    }

    // 3. Untrusted with isolation: "dispatch" succeeds
    const parsedDispatch = ManifestSchema.safeParse({
      ...baseManifest,
      trust: "untrusted",
      isolation: "dispatch",
    });
    expect(parsedDispatch.success).toBe(true);
  });

  it("Task 4: docs/brick-audit.md tenancy section and scripting-sandbox entry reflect post-UC6 isolation architecture", () => {
    expect(existsSync(BRICK_AUDIT_PATH)).toBe(true);
    const content = readFileSync(BRICK_AUDIT_PATH, "utf8");

    // 1. scripting-sandbox must NOT describe itself as using new Function or regex token blocklist
    const scriptingLine = content
      .split(/\r?\n/)
      .find((line) => line.includes("| scripting-sandbox |"));
    expect(scriptingLine, "scripting-sandbox entry must exist in docs/brick-audit.md").toBeDefined();
    expect(
      scriptingLine!.includes("new Function") || scriptingLine!.includes("regex blocklist"),
      "scripting-sandbox in docs/brick-audit.md should no longer claim new Function or regex blocklist",
    ).toBe(false);
    expect(
      scriptingLine!.includes("isolated Worker") || scriptingLine!.includes("Dynamic Worker"),
      "scripting-sandbox in docs/brick-audit.md must reflect isolated Worker execution",
    ).toBe(true);

    // 2. Tenancy section must document scoped() and lint:tenant AST protection
    expect(
      content.includes("scoped(db, workspaceId)") || content.includes("`scoped()`"),
      "docs/brick-audit.md tenancy section must document scoped() database queries",
    ).toBe(true);
    expect(
      content.includes("lint:tenant") || content.includes("lint-tenant-queries"),
      "docs/brick-audit.md tenancy section must document tenant query linting",
    ).toBe(true);
    expect(
      content.includes("trust: first-party") || content.includes("isolation: dispatch"),
      "docs/brick-audit.md tenancy section must document trust and dispatch isolation",
    ).toBe(true);
  });
});
