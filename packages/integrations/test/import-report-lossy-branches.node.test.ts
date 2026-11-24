import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyzeSpec,
  importIntegrationSpec,
  type CurationConfig,
  type ImportReportStatus,
} from "../src/importer.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../");

interface LossyTestCase {
  readonly code: string;
  readonly op: string | null;
  readonly pointer: string;
  readonly status: ImportReportStatus;
  readonly blocking: boolean;
  readonly fixtureFile: string;
  readonly format: "openapi3" | "google-discovery" | "swagger2";
}

const LOSSY_BRANCH_CASES: LossyTestCase[] = [
  {
    code: "SCHEMA_COMPOSITION_ERASED",
    op: "opSchemaComposition",
    pointer: "#/paths/~1schema-composition/get/parameters/0",
    status: "approximated",
    blocking: false,
    fixtureFile: "lossy-branches.openapi.json",
    format: "openapi3",
  },
  {
    code: "CONTENT_TYPE_UNSUPPORTED",
    op: "opContentTypeUnsupported",
    pointer: "#/paths/~1content-type-unsupported/post/requestBody/content",
    status: "unsupported",
    blocking: true,
    fixtureFile: "lossy-branches.openapi.json",
    format: "openapi3",
  },
  {
    code: "MEDIA_UPLOAD_UNSUPPORTED",
    op: "drive_files_insert",
    pointer: "#/methods/drive.files.insert/supportsMediaUpload",
    status: "unsupported",
    blocking: false,
    fixtureFile: "lossy-discovery.json",
    format: "google-discovery",
  },
  {
    code: "SWAGGER2_UPCONVERTED",
    op: null,
    pointer: "#/swagger",
    status: "normalized",
    blocking: false,
    fixtureFile: "lossy-swagger2.json",
    format: "swagger2",
  },
  {
    code: "REF_DEPTH_EXCEEDED",
    op: "opRefDepth",
    pointer: "#/paths/~1ref-depth/get/parameters/0",
    status: "approximated",
    blocking: false,
    fixtureFile: "lossy-branches.openapi.json",
    format: "openapi3",
  },
  {
    code: "OPERATION_SKIPPED",
    op: "opSkippedHead",
    pointer: "#/paths/~1op-skipped/head",
    status: "unsupported",
    blocking: false,
    fixtureFile: "lossy-branches.openapi.json",
    format: "openapi3",
  },
];

describe("UC2.2 import report lossy branches and skipped operations", () => {
  const reportsByFixture = new Map<string, ReturnType<typeof analyzeSpec>>();

  function getReport(fixtureFile: string, format: "openapi3" | "google-discovery" | "swagger2") {
    const key = `${fixtureFile}:${format}`;
    if (!reportsByFixture.has(key)) {
      const fixturePath = resolve(__dirname, "fixtures/report", fixtureFile);
      const text = readFileSync(fixturePath, "utf8");
      const parsed = JSON.parse(text);
      const rep = analyzeSpec({
        spec: parsed,
        format,
        appName: fixtureFile.replace(/\..*$/, ""),
      });
      reportsByFixture.set(key, rep);
    }
    return reportsByFixture.get(key)!;
  }

  describe("AC1: table-driven lossy branch report codes", () => {
    for (const tc of LOSSY_BRANCH_CASES) {
      it(`emits code "${tc.code}" with status "${tc.status}" and blocking=${tc.blocking}`, () => {
        const report = getReport(tc.fixtureFile, tc.format);
        const entry = report.entries.find((e) => e.code === tc.code && (e.op === tc.op || !tc.op));

        expect(entry, `Expected report to contain entry with code ${tc.code}`).toBeDefined();
        expect(entry!.pointer).toBe(tc.pointer);
        expect(entry!.status).toBe(tc.status);
        expect(entry!.blocking).toBe(tc.blocking);
      });
    }
  });

  describe("AC2: clean spec yields exact fidelity and zero lossy entries", () => {
    it("reports fidelity.level === 'exact' and 0 approximated/unsupported entries for clean.openapi.json", () => {
      const cleanPath = resolve(__dirname, "fixtures/report/clean.openapi.json");
      const cleanText = readFileSync(cleanPath, "utf8");
      const curation: CurationConfig = {
        app: "clean",
        specProvenance: "upstream",
        ui: {
          displayName: "Clean API",
          category: "developer",
          icon: "clean",
          docsUrl: "https://example.com",
          summary: "Clean API test",
          maturity: "production",
          maturityReason: "Clean spec",
        },
        auth: {
          type: "none",
        },
        baseUrl: "https://clean.example.com",
        allowedHosts: ["clean.example.com"],
      };

      const result = importIntegrationSpec({
        spec: cleanText,
        format: "openapi3",
        curation,
      });

      expect(result.report.summary.approximated).toBe(0);
      expect(result.report.summary.unsupported).toBe(0);
      expect(result.report.summary.curated).toBe(0);
      expect(result.report.summary.mapped).toBeGreaterThan(0);
      expect(result.manifest.fidelity).toBeDefined();
      expect(result.manifest.fidelity?.level).toBe("exact");
      expect(result.manifest.fidelity?.unsupported).toHaveLength(0);
    });
  });

  describe("AC4 (UC3.4): parameter fidelity entries no longer emitted for fixtures", () => {
    it("does not emit PARAM_LOCATION_UNSUPPORTED(cookie), PARAM_ENUM_DROPPED, PARAM_DEFAULT_DROPPED, PARAM_ITEMS_TYPE_DROPPED, PARAM_STYLE_UNHONOURED, or PATH_RESERVED_EXPANSION_LOST", () => {
      const openApiReport = getReport("lossy-branches.openapi.json", "openapi3");
      const retiredCodes = [
        "PARAM_ENUM_DROPPED",
        "PARAM_DEFAULT_DROPPED",
        "PARAM_ITEMS_TYPE_DROPPED",
        "PARAM_STYLE_UNHONOURED",
      ];
      for (const code of retiredCodes) {
        expect(openApiReport.entries.filter((e) => e.code === code)).toHaveLength(0);
      }
      expect(
        openApiReport.entries.filter(
          (e) => e.code === "PARAM_LOCATION_UNSUPPORTED" && e.from === "cookie",
        ),
      ).toHaveLength(0);

      const discoveryReport = getReport("lossy-discovery.json", "google-discovery");
      expect(
        discoveryReport.entries.filter((e) => e.code === "PATH_RESERVED_EXPANSION_LOST"),
      ).toHaveLength(0);
    });
  });

  describe("AC2 (UC3.5): request body fidelity entries no longer emitted for fixtures", () => {
    it("does not emit BODY_FIELD_CAPPED, BODY_REQUIRED_FIELD_CAPPED, BODY_NESTED_FLATTENED, BODY_COMPOSED_DROPPED, BODY_FREEFORM_DROPPED, BODY_TOPLEVEL_ARRAY_DROPPED, or BODY_REF_PROPERTY_UNRESOLVED", () => {
      const openApiReport = getReport("lossy-branches.openapi.json", "openapi3");
      const retiredBodyCodes = [
        "BODY_FIELD_CAPPED",
        "BODY_REQUIRED_FIELD_CAPPED",
        "BODY_NESTED_FLATTENED",
        "BODY_COMPOSED_DROPPED",
        "BODY_FREEFORM_DROPPED",
        "BODY_TOPLEVEL_ARRAY_DROPPED",
      ];
      for (const code of retiredBodyCodes) {
        expect(openApiReport.entries.filter((e) => e.code === code)).toHaveLength(0);
      }

      const discoveryReport = getReport("lossy-discovery.json", "google-discovery");
      expect(
        discoveryReport.entries.filter((e) => e.code === "BODY_REF_PROPERTY_UNRESOLVED"),
      ).toHaveLength(0);
    });
  });

  describe("AC1 (UC3.7): Swagger 2.0 bodies up-converted, SWAGGER2_BODY_DROPPED no longer emitted", () => {
    it("does not emit SWAGGER2_BODY_DROPPED, emits SWAGGER2_UPCONVERTED", () => {
      const swaggerReport = getReport("lossy-swagger2.json", "swagger2");
      expect(
        swaggerReport.entries.filter((e) => e.code === "SWAGGER2_BODY_DROPPED"),
      ).toHaveLength(0);
      expect(
        swaggerReport.entries.filter((e) => e.code === "SWAGGER2_UPCONVERTED"),
      ).toHaveLength(1);
    });
  });

  describe("AC3: analyzeSpec covers all operations in 5 corpus specs", () => {
    const corpusSpecs = [
      { id: "stripe", format: "openapi3" as const, file: "stripe.json", expectedOps: 612 },
      { id: "github", format: "openapi3" as const, file: "github.json", expectedOps: 1254 },
      { id: "discord", format: "openapi3" as const, file: "discord.json", expectedOps: 250 },
      { id: "slack", format: "swagger2" as const, file: "slack.json", expectedOps: 174 },
      {
        id: "google",
        format: "google-discovery" as const,
        files: [
          "google-calendar.json",
          "google-gmail.json",
          "google-drive.json",
          "google-sheets.json",
        ],
        expectedOps: 198,
      },
    ];

    for (const specDef of corpusSpecs) {
      it(`covers all ${specDef.expectedOps} operations for ${specDef.id}`, () => {
        const cacheDir = resolve(repoRoot, "corpus/real-specs/.cache");
        if (!existsSync(cacheDir)) {
          console.warn("Corpus cache directory not found, skipping corpus coverage test");
          return;
        }

        let report: ReturnType<typeof analyzeSpec>;
        if (specDef.files) {
          const docs = specDef.files.map((f) =>
            JSON.parse(readFileSync(resolve(cacheDir, f), "utf8")),
          );
          report = analyzeSpec({
            spec: docs,
            format: specDef.format,
            appName: specDef.id,
          });
        } else {
          const raw = JSON.parse(
            readFileSync(resolve(cacheDir, specDef.file!), "utf8"),
          );
          report = analyzeSpec({
            spec: raw,
            format: specDef.format,
            appName: specDef.id,
          });
        }

        // Collect all distinct operations recorded in the report (by spec operation pointer)
        const opKeys = new Set<string>();
        for (const e of report.entries) {
          const m = e.pointer.match(/^#\/(?:paths\/[^/]+\/(?:get|post|put|patch|delete|head|options|trace)|methods\/[^/]+)/i);
          if (m) opKeys.add(m[0]);
        }

        expect(opKeys.size).toBe(specDef.expectedOps);
      });
    }
  });

  describe("Summary invariant: sum(summary) === entries.length", () => {
    it("satisfies sum(summary) === entries.length across reports", () => {
      const report = getReport("lossy-branches.openapi.json", "openapi3");
      const sum =
        report.summary.mapped +
        report.summary.normalized +
        report.summary.curated +
        report.summary.approximated +
        report.summary.unsupported;
      expect(sum).toBe(report.entries.length);
    });
  });
});
