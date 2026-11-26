import { describe, expect, it } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { importIntegrationSpec } from "../src/importer.ts";
import {
  runOpenApiImportCli,
  runOpenApiImportFile,
} from "../src/cli.ts";
import type { CurationConfig } from "../src/curation.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const UNACKNOWLEDGED_LOSS_SPEC = {
  openapi: "3.1.0",
  info: { title: "Lossy Spec", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/v1/unsupported": {
      post: {
        operationId: "lossyOp",
        summary: "Operation with unsupported content type",
        requestBody: {
          content: {
            "application/xml": {
              schema: {
                type: "string",
              },
            },
          },
        },
      },
    },
  },
};
const BODY_CAP_SPEC = UNACKNOWLEDGED_LOSS_SPEC;

const BASE_CURATION: CurationConfig = {
  app: "test-strict-app",
  version: "1.0.0",
  specProvenance: "upstream",
  ui: {
    displayName: "Test Strict App",
    category: "automation",
    summary: "App for testing strict mode and curation overlays.",
    maturity: "production",
    behaviourTest: "packages/integrations/test/pack-v1-contract.workerd.test.ts",
  },
  auth: {
    type: "apiKey",
    headerName: "Authorization",
    prefix: "Bearer ",
  },
  baseUrl: "https://api.example.com",
  allowedHosts: ["api.example.com"],
  includeOperations: ["lossyOp"],
};

describe("UC2.5 — Strict mode by default, curation acknowledge, and overlay reporting", () => {
  it("(a) An unacknowledged loss throws OPENAPI_IMPORT_UNACKNOWLEDGED_LOSS, listing op/code/pointer", () => {
    let thrownError: Error | null = null;
    try {
      importIntegrationSpec({
        spec: UNACKNOWLEDGED_LOSS_SPEC,
        format: "openapi3",
        curation: BASE_CURATION,
      });
    } catch (err) {
      thrownError = err as Error;
    }

    expect(thrownError).not.toBeNull();
    expect(thrownError?.message).toContain("OPENAPI_IMPORT_UNACKNOWLEDGED_LOSS");
    expect(thrownError?.message).toContain("lossyOp");
    expect(thrownError?.message).toContain("CONTENT_TYPE_UNSUPPORTED");
    expect(thrownError?.message).toContain(
      "#/paths/~1v1~1unsupported/post/requestBody/content",
    );
  });

  it("(b) The same import with acknowledge: [{op, code, reason}] succeeds with fidelity.level === 'partial'", () => {
    const curationWithAck: CurationConfig = {
      ...BASE_CURATION,
      acknowledge: [
        {
          op: "lossyOp",
          code: "CONTENT_TYPE_UNSUPPORTED",
          pointer:
            "#/paths/~1v1~1unsupported/post/requestBody/content",
          reason: "XML content type is unsupported and deferred to future release",
        },
      ],
    };

    const result = importIntegrationSpec({
      spec: UNACKNOWLEDGED_LOSS_SPEC,
      format: "openapi3",
      curation: curationWithAck,
    });

    expect(result.manifest.fidelity?.level).toBe("partial");
    const lossEntry = result.report.entries.find(
      (e) => e.op === "lossyOp" && e.code === "CONTENT_TYPE_UNSUPPORTED",
    );
    expect(lossEntry).toBeDefined();
    expect(lossEntry?.status).toBe("unsupported");
    expect(lossEntry?.acknowledged).toEqual({
      reason: "XML content type is unsupported and deferred to future release",
    });

    const fidelityUnsupported = result.manifest.fidelity?.unsupported.find(
      (e) => e.op === "lossyOp" && e.code === "CONTENT_TYPE_UNSUPPORTED",
    );
    expect(fidelityUnsupported).toBeDefined();
  });

  it("(c) An acknowledgement that matches no entry throws OPENAPI_IMPORT_STALE_ACKNOWLEDGEMENT", () => {
    const curationWithStaleAck: CurationConfig = {
      ...BASE_CURATION,
      acknowledge: [
        {
          op: "cappedOp",
          code: "BODY_FIELD_CAPPED",
          reason: "Valid reason for real field",
        },
        {
          op: "nonExistentOp",
          code: "BODY_FIELD_CAPPED",
          reason: "Stale acknowledgement that matches nothing",
        },
      ],
    };

    expect(() =>
      importIntegrationSpec({
        spec: BODY_CAP_SPEC,
        format: "openapi3",
        curation: curationWithStaleAck,
      }),
    ).toThrow(/OPENAPI_IMPORT_STALE_ACKNOWLEDGEMENT/);
  });

  it("(d) A params overlay that differs from the spec params produces curated OVERLAY_OVERRIDE with from/to and pointer curation:#/operations/<key>/params", () => {
    const specWithParams = {
      openapi: "3.1.0",
      info: { title: "Params Spec", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/v1/items": {
          get: {
            operationId: "listItems",
            summary: "List items",
            parameters: [
              {
                name: "limit",
                in: "query",
                schema: { type: "integer" },
                description: "Spec description",
              },
            ],
          },
        },
      },
    };

    const curationWithOverlay: CurationConfig = {
      ...BASE_CURATION,
      includeOperations: ["listItems"],
      operations: {
        listItems: {
          params: [
            {
              name: "limit",
              in: "query",
              dataType: "number",
              required: false,
              description: "Curated description overriding spec",
            },
          ],
        },
      },
    };

    const result = importIntegrationSpec({
      spec: specWithParams,
      format: "openapi3",
      curation: curationWithOverlay,
    });

    const overlayEntry = result.report.entries.find(
      (e) => e.op === "listItems" && e.code === "OVERLAY_OVERRIDE" && e.pointer === "curation:#/operations/listItems/params",
    );
    expect(overlayEntry).toBeDefined();
    expect(overlayEntry?.status).toBe("curated");
    expect(overlayEntry?.element).toBe("param");
    expect(overlayEntry?.from).toBeDefined();
    expect(overlayEntry?.to).toBeDefined();
  });

  it("AC3: A curation file with an unknown key fails with OPENAPI_IMPORT_CURATION_INVALID", () => {
    const invalidCuration = {
      ...BASE_CURATION,
      acknowlege: [
        {
          op: "cappedOp",
          code: "BODY_FIELD_CAPPED",
          reason: "Typo in acknowledge key",
        },
      ],
    };

    expect(() =>
      importIntegrationSpec({
        spec: BODY_CAP_SPEC,
        format: "openapi3",
        curation: invalidCuration as any,
      }),
    ).toThrow(/OPENAPI_IMPORT_CURATION_INVALID/);
  });

  it("AC4: --lenient --out integrations/stripe/integration.json is refused with OPENAPI_IMPORT_LENIENT_OUTPUT_FORBIDDEN", () => {
    const tmpSpecPath = join(REPO_ROOT, "integrations", "stripe", "openapi.json");
    const tmpCurationPath = join(REPO_ROOT, "integrations", "stripe", "curation.config.json");
    const forbiddenOutPath = join(REPO_ROOT, "integrations", "stripe", "integration.json");

    expect(() =>
      runOpenApiImportFile({
        specPath: tmpSpecPath,
        curationPath: tmpCurationPath,
        outPath: forbiddenOutPath,
        mode: "lenient",
      }),
    ).toThrow(/OPENAPI_IMPORT_LENIENT_OUTPUT_FORBIDDEN/);

    expect(() =>
      runOpenApiImportCli([
        "--spec",
        tmpSpecPath,
        "--curation",
        tmpCurationPath,
        "--out",
        forbiddenOutPath,
        "--lenient",
      ]),
    ).toThrow(/OPENAPI_IMPORT_LENIENT_OUTPUT_FORBIDDEN/);
  });

  it("throws OPENAPI_IMPORT_OVERLAY_CONTRADICTS_SPEC when overlay method or path contradicts spec", () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "Simple Spec", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/v1/resource": {
          get: {
            operationId: "getResource",
            summary: "Get resource",
          },
        },
      },
    };

    const curationMethodConflict: CurationConfig = {
      ...BASE_CURATION,
      includeOperations: ["getResource"],
      operations: {
        getResource: {
          method: "POST",
        },
      },
    };

    expect(() =>
      importIntegrationSpec({
        spec,
        format: "openapi3",
        curation: curationMethodConflict,
      }),
    ).toThrow(/OPENAPI_IMPORT_OVERLAY_CONTRADICTS_SPEC/);

    const curationPathConflict: CurationConfig = {
      ...BASE_CURATION,
      includeOperations: ["getResource"],
      operations: {
        getResource: {
          path: "/v1/different_path",
        },
      },
    };

    expect(() =>
      importIntegrationSpec({
        spec,
        format: "openapi3",
        curation: curationPathConflict,
      }),
    ).toThrow(/OPENAPI_IMPORT_OVERLAY_CONTRADICTS_SPEC/);
  });

  it("emits curated OPERATION_CURATED_ONLY for curation-only operations", () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "Empty Spec", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      paths: {},
    };

    const curationWithCustomOp: CurationConfig = {
      ...BASE_CURATION,
      includeOperations: ["customOp"],
      operations: {
        customOp: {
          operationId: "customOp",
          method: "POST",
          path: "/v1/custom",
          summary: "Curation only operation",
        },
      },
    };

    const result = importIntegrationSpec({
      spec,
      format: "openapi3",
      curation: curationWithCustomOp,
    });

    const curatedOpEntry = result.report.entries.find(
      (e) => e.op === "customOp" && e.code === "OPERATION_CURATED_ONLY",
    );
    expect(curatedOpEntry).toBeDefined();
    expect(curatedOpEntry?.status).toBe("curated");
  });

  it("AC5: Every overlay in the 5 packs appears in their reports as OVERLAY_ADDED or OVERLAY_OVERRIDE", () => {
    const packs = ["discord", "github", "google", "slack", "stripe"];
    const overlayCounts: Record<string, number> = {};

    for (const app of packs) {
      const appDir = join(REPO_ROOT, "integrations", app);
      const reportPath = join(appDir, "import-report.json");
      expect(existsSync(reportPath)).toBe(true);

      const curationPath = join(appDir, "curation.config.json");
      const curation = JSON.parse(readFileSync(curationPath, "utf8"));
      const specPath = existsSync(join(appDir, "discovery.json"))
        ? join(appDir, "discovery.json")
        : join(appDir, "openapi.json");
      const specText = readFileSync(specPath, "utf8");
      const format = existsSync(join(appDir, "discovery.json"))
        ? "google-discovery"
        : (curation.format ?? "openapi3");

      const result = importIntegrationSpec({
        spec: specText,
        format,
        curation,
        mode: "lenient",
      });

      const overlayEntries = result.report.entries.filter(
        (e) => e.code === "OVERLAY_ADDED" || e.code === "OVERLAY_OVERRIDE",
      );
      overlayCounts[app] = overlayEntries.length;
    }

    // Discord has 1 pagination overlay (getChannelMessages)
    expect(overlayCounts["discord"]).toBeGreaterThanOrEqual(1);
    // GitHub has 1 pagination overlay (listIssues)
    expect(overlayCounts["github"]).toBeGreaterThanOrEqual(1);
    // Google has 2 pagination overlays (calendar_events_list, gmail_messages_list)
    expect(overlayCounts["google"]).toBeGreaterThanOrEqual(2);
    // Slack has 1 pagination overlay (conversations_list) + 1 errorWhen overlay (UC3.8) + 2 body overlays (chat_postMessage, files_upload) (UC3.7)
    expect(overlayCounts["slack"]).toBeGreaterThanOrEqual(4);
    // Stripe has 2 pagination overlays (listCustomers, listInvoices) + 9 idempotency overlays (UC3.1)
    expect(overlayCounts["stripe"]).toBeGreaterThanOrEqual(11);

    const totalOverlays = Object.values(overlayCounts).reduce((a, b) => a + b, 0);
    expect(totalOverlays).toBe(19);
  });
});
