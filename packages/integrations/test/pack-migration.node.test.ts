import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { importIntegrationSpec } from "../src/importer.ts";
import type { ImportSpecFormat } from "../src/importer.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PACKS = ["discord", "github", "google", "slack", "stripe"];

describe("UC2.7 — Pack migration, mandatory fidelity, and drift check", () => {
  for (const app of PACKS) {
    it(`migrates pack ${app} to strict mode with matching report and manifest fidelity`, () => {
      const appDir = join(repoRoot, "integrations", app);
      const curationPath = join(appDir, "curation.config.json");
      expect(existsSync(curationPath)).toBe(true);

      const curation = JSON.parse(readFileSync(curationPath, "utf8"));
      expect(curation.specProvenance).toBe(app === "slack" ? "upstream" : "hand-trimmed");
      expect(curation.upstream).toBeDefined();
      expect(curation.upstream.corpusSpec).toBe(app === "google" ? "google" : app);
      expect(typeof curation.upstream.operationIds).toBe("object");

      const discoveryPath = join(appDir, "discovery.json");
      const openApiPath = join(appDir, "openapi.json");
      const specPath = existsSync(discoveryPath) ? discoveryPath : openApiPath;
      const format: ImportSpecFormat = existsSync(discoveryPath)
        ? "google-discovery"
        : (curation.format ?? "openapi3");
      const specText = readFileSync(specPath, "utf8");

      // Run strict import
      const result = importIntegrationSpec({
        spec: specText,
        format,
        curation,
        mode: "strict",
      });

      // Assert manifest fidelity is present and valid
      expect(result.manifest.fidelity).toBeDefined();
      expect(result.manifest.fidelity?.specHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(result.manifest.fidelity?.importerVersion).toBe("2.0.0");
      expect(["curated", "partial"]).toContain(result.manifest.fidelity?.level);
      expect(result.manifest.fidelity?.level).not.toBe("exact");

      if (app === "slack") {
        const upconvertedEntry = result.report.entries.find(
          (e) => e.code === "SWAGGER2_UPCONVERTED" && e.status === "normalized",
        );
        expect(upconvertedEntry).toBeDefined();
      } else {
        // Document-level SPEC_HAND_TRIMMED entry must be present in report
        const handTrimmedEntry = result.report.entries.find(
          (e) => e.code === "SPEC_HAND_TRIMMED" && e.status === "curated",
        );
        expect(handTrimmedEntry).toBeDefined();
      }

      // Assert committed import-report.json equals regenerated report
      const reportPath = join(appDir, "import-report.json");
      expect(existsSync(reportPath)).toBe(true);
      const committedReport = JSON.parse(readFileSync(reportPath, "utf8"));
      expect(result.report).toEqual(committedReport);

      // Assert committed integration.json carries fidelity matching result.manifest.fidelity
      const manifestPath = join(appDir, "integration.json");
      expect(existsSync(manifestPath)).toBe(true);
      const committedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(committedManifest.fidelity).toEqual(result.manifest.fidelity);
    });
  }
});
