import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SDK_AUTH_TS = join(ROOT, "packages", "sdk", "src", "auth.ts");
const CORE_AUTH_INDEX_TS = join(ROOT, "bricks", "core-auth", "src", "index.ts");
const OIDC_VERIFY_INDEX_TS = join(ROOT, "bricks", "oidc-verify", "src", "index.ts");
const MULTI_WORKSPACE_INDEX_TS = join(ROOT, "bricks", "multi-workspace", "src", "index.ts");
const PRIVACY_TS = join(ROOT, "bricks", "data-privacy-gdpr", "src", "privacy.ts");
const VALUE_PATTERNS_TS = join(ROOT, "packages", "telemetry", "src", "value-patterns.ts");

describe("UC9.9 — Refactor sweep (UC9)", () => {
  it("AC2 & Task 2: exactly one AuthUser interface definition exists in the repo (in packages/sdk)", () => {
    const searchDirs = [
      join(ROOT, "bricks"),
      join(ROOT, "packages"),
      join(ROOT, "apps"),
      join(ROOT, "scripts"),
    ];

    const authUserDefHits: string[] = [];

    function scan(dir: string) {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (
          entry.name === "node_modules" ||
          entry.name === "dist" ||
          entry.name === ".evidence-run" ||
          entry.name === "catalog.generated.ts"
        ) {
          continue;
        }
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full);
        } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
          if (entry.name === "refactor-sweep-uc9.node.test.ts") continue;
          const content = readFileSync(full, "utf8");
          const matches = content.match(/\binterface\s+AuthUser\b/g);
          if (matches) {
            authUserDefHits.push(full.replace(/\\/g, "/"));
          }
        }
      }
    }

    for (const dir of searchDirs) {
      scan(dir);
    }

    expect(
      authUserDefHits,
      `Exactly one interface AuthUser definition must exist across the repo (found in: ${authUserDefHits.join(", ")})`,
    ).toHaveLength(1);

    expect(
      authUserDefHits[0]?.endsWith("packages/sdk/src/auth.ts"),
      `The single AuthUser interface must be defined in packages/sdk/src/auth.ts (found in: ${authUserDefHits[0]})`,
    ).toBe(true);
  });

  it("Task 2: core-auth, oidc-verify, and multi-workspace import and re-export AuthUser from @poc/sdk", () => {
    expect(existsSync(SDK_AUTH_TS), "packages/sdk/src/auth.ts must exist").toBe(true);

    const coreAuthIndex = readFileSync(CORE_AUTH_INDEX_TS, "utf8");
    expect(
      coreAuthIndex.includes("AuthUser"),
      "bricks/core-auth/src/index.ts must export AuthUser",
    ).toBe(true);

    const oidcVerifyIndex = readFileSync(OIDC_VERIFY_INDEX_TS, "utf8");
    expect(
      oidcVerifyIndex.includes("AuthUser"),
      "bricks/oidc-verify/src/index.ts must export AuthUser",
    ).toBe(true);

    const multiWorkspaceIndex = readFileSync(MULTI_WORKSPACE_INDEX_TS, "utf8");
    expect(
      multiWorkspaceIndex.includes("AuthUser"),
      "bricks/multi-workspace/src/index.ts must export AuthUser",
    ).toBe(true);
  });

  it("Task 2: registerDataCollector and UserDataCollector are removed from data-privacy-gdpr", () => {
    const privacyContent = readFileSync(PRIVACY_TS, "utf8");
    expect(
      privacyContent.includes("registerDataCollector"),
      "registerDataCollector should be removed from bricks/data-privacy-gdpr/src/privacy.ts",
    ).toBe(false);
    expect(
      privacyContent.includes("UserDataCollector"),
      "UserDataCollector should be removed from bricks/data-privacy-gdpr/src/privacy.ts",
    ).toBe(false);
  });

  it("Task 3: VALUE_PATTERNS in packages/telemetry/src/value-patterns.ts does not duplicate regex literals per entry", () => {
    const content = readFileSync(VALUE_PATTERNS_TS, "utf8");
    // Look for entries having both "regex:" and "pattern:" literal regex definitions in the same object
    const lines = content.split(/\r?\n/);
    let duplicatedLiteralCount = 0;
    for (let i = 0; i < lines.length - 1; i++) {
      const current = lines[i]!.trim();
      const next = lines[i + 1]!.trim();
      if (current.startsWith("regex:") && next.startsWith("pattern:") && current.slice(6).trim() === next.slice(8).trim()) {
        duplicatedLiteralCount++;
      }
    }
    expect(
      duplicatedLiteralCount,
      "VALUE_PATTERNS must not declare duplicate regex and pattern regex literals on every item",
    ).toBe(0);
  });
});
