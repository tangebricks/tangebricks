import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("UC1.8 — Refactor sweep (UC1)", () => {
  const rootDir = resolve(__dirname, "..");
  const executorPath = resolve(rootDir, "src/integration-executor.ts");
  const requestBuildPath = resolve(rootDir, "src/integration/request-build.ts");
  const retryPath = resolve(rootDir, "src/integration/retry.ts");
  const redactionPath = resolve(rootDir, "src/integration/redaction.ts");

  it("Task 3: packages/runtime/src/integration-executor.ts line count is <= 900 lines", () => {
    expect(existsSync(executorPath)).toBe(true);
    const content = readFileSync(executorPath, "utf-8");
    const lines = content.split(/\r?\n/).length;
    expect(lines, `integration-executor.ts must be <= 900 lines (actual: ${lines})`).toBeLessThanOrEqual(900);
  });

  it("Task 3: split modules exist under packages/runtime/src/integration/", () => {
    expect(existsSync(requestBuildPath), "src/integration/request-build.ts must exist").toBe(true);
    expect(existsSync(retryPath), "src/integration/retry.ts must exist").toBe(true);
    expect(existsSync(redactionPath), "src/integration/redaction.ts must exist").toBe(true);
  });

  it("Task 3: split modules export their modular responsibilities", async () => {
    // Dynamic import to test modules exist and export expected functions
    const reqBuild = await import("../src/integration/request-build.ts");
    expect(typeof reqBuild.validateAndBuildTargetUrl).toBe("function");
    expect(typeof reqBuild.assertNoReservedDataKeys).toBe("function");
    expect(typeof reqBuild.substitutePathParams).toBe("function");

    const retryMod = await import("../src/integration/retry.ts");
    expect(typeof retryMod.isRetryable).toBe("function");
    expect(typeof retryMod.parseRetryDelayMs).toBe("function");

    const redactMod = await import("../src/integration/redaction.ts");
    expect(Array.isArray(redactMod.DEFAULT_SECRET_HEADER_AND_FIELD_NAMES)).toBe(true);
    expect(typeof redactMod.collectConnectionSecretValues).toBe("function");
    expect(typeof redactMod.collectConnectionsMapSecrets).toBe("function");
  });

  it("Task 2: no stale comments or code referring to __fetcher in packages/runtime/src", () => {
    const srcDir = resolve(rootDir, "src");
    const checkDir = (dir: string): string[] => {
      const fs = require("node:fs");
      const path = require("node:path");
      const hits: string[] = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          hits.push(...checkDir(fullPath));
        } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
          const content = fs.readFileSync(fullPath, "utf-8");
          if (content.includes("__fetcher")) {
            hits.push(fullPath);
          }
        }
      }
      return hits;
    };

    const staleHits = checkDir(srcDir);
    expect(staleHits, `No file in packages/runtime/src should contain __fetcher, but found in: ${staleHits.join(", ")}`).toEqual([]);
  });

  it("AC1: public exports of @poc/runtime remain intact and identical to expected baseline", async () => {
    const runtimeExports = await import("../src/index.ts");
    const expectedExportNames = [
      "assertNoReservedDataKeys",
      "createHardenedFetch",
      "isPrivateAddress",
      "PX_CONNECTIONS_MIGRATION_SQL",
      "computeConnectionKeyHint",
      "createIntegrationOperationExecutor",
      "deriveConnectionVaultKey",
      "ensureConnectionsTable",
      "ensurePxConnectionsTable",
      "executeIntegrationOperation",
      "getRegisteredIntegrationOperation",
      "getRegisteredTokenUrlsByApp",
      "isRetryable",
      "parseRetryDelayMs",
      "projectCatalogIntegrations",
      "registerCatalogIntegrations",
      "registerIntegrationManifest",
      "resetConnectionRefreshLocksForTest",
      "resolveCaseAConnection",
      "resolveCaseBWorkspaceConnection",
      "sealConnectionCredentials",
      "sealWorkspaceCredentialsWithAad",
      "unsealConnectionCredentials",
      "unsealWorkspaceCredentialsWithAad",
      "upsertSealedConnection",
      "validateAndBuildTargetUrl",
      "GraphInvalidError",
    ];

    for (const name of expectedExportNames) {
      expect(runtimeExports, `@poc/runtime must export ${name}`).toHaveProperty(name);
    }
  });
});
