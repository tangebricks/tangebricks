import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { IntegrationManifestSchema } from "@poc/assembler";
import {
  importIntegrationSpec,
  measureIntegrationTokenMetrics,
  parseSpecDocument,
} from "../src/index.ts";
import { parseImportCliArgs, runOpenApiImportCli } from "../src/cli.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

describe("Story 10.4 — tools/openapi-import CLI and importer (AC 1, AC 2, AC 3)", () => {
  it("parses OpenAPI 3.x YAML and JSON specs, applies curation overlays, and validates against IntegrationManifestSchema", () => {
    const yamlSpec = `
openapi: "3.1.0"
info:
  title: Sample YAML API
  version: "1.0.0"
paths:
  /v1/items:
    get:
      operationId: listItems
      summary: List items
    post:
      operationId: createItem
      summary: Create item
  /v1/ignored:
    delete:
      operationId: deleteIgnored
      summary: Should be filtered out
`;

    const parsedDoc = parseSpecDocument(yamlSpec);
    expect(parsedDoc.openapi).toBe("3.1.0");

    const result = importIntegrationSpec({
      spec: yamlSpec,
      format: "openapi3",
      curation: {
        app: "sample-app",
        specProvenance: "upstream",
        version: "1.0.0",
        ui: {
          displayName: "Sample App",
          category: "automation",
          summary: "Sample integration imported from YAML.",
          maturity: "production",
          behaviourTest: "packages/integrations/test/pack-v1-contract.workerd.test.ts",
        },
        auth: {
          type: "oauth2",
          authorizeUrl: "https://auth.example.com/authorize",
          tokenUrl: "https://auth.example.com/token",
          scopes: ["items:read", "items:write"],
        },
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
        includeOperations: ["listItems", "createItem"],
        operations: {
          listItems: {
            pagination: {
              style: "cursor",
              paramName: "cursor",
              responsePath: "items",
              nextCursorPath: "next_cursor",
              maxPages: 3,
            },
          },
        },
        triggers: [
          {
            id: "item_created",
            label: "Item Created",
            summary: "Fires when an item is created.",
            verifier: "hmac-sha256",
            signatureHeader: "X-Signature-256",
            eventIdPath: "id",
            outputs: [{ id: "out", label: "Event", dataType: "object" }],
          },
        ],
        errorMappings: {
          "401": {
            status: 401,
            code: "CONNECTION_EXPIRED",
            hint: "Re-authorize Sample App.",
            retryable: false,
          },
          "429": {
            status: 429,
            code: "RATE_LIMITED",
            retryable: true,
            retryAfterHeader: "Retry-After",
          },
        },
      },
    });

    expect(result.manifest.operations.map((o) => o.operationId)).toEqual([
      "listItems",
      "createItem",
    ]);
    expect(result.manifest.operations[0]?.pagination?.style).toBe("cursor");
    expect(result.manifest.triggers).toHaveLength(1);
    expect(IntegrationManifestSchema.safeParse(result.manifest).success).toBe(true);
    expect(result.tokenMetrics.compactSummaryTokens).toBeLessThanOrEqual(600);
    expect(result.tokenMetrics.maxOperationDetailTokens).toBeLessThanOrEqual(250);
  });

  it("hard-fails when curation selects > 30 operations or 0 operations", () => {
    const paths: Record<string, unknown> = {};
    const opIds: string[] = [];
    for (let i = 1; i <= 35; i += 1) {
      const id = `op_${i}`;
      opIds.push(id);
      paths[`/v1/op/${i}`] = {
        get: {
          operationId: id,
          summary: `Operation ${i}`,
        },
      };
    }

    expect(() =>
      importIntegrationSpec({
        spec: { openapi: "3.1.0", paths },
        format: "openapi3",
        curation: {
          app: "bloated-app",
          specProvenance: "upstream",
          ui: {
            displayName: "Bloated",
            category: "automation",
            summary: "Too many operations.",
            maturity: "beta",
            maturityReason: "Testing cap",
            behaviourTest: "packages/integrations/test/pack-v1-contract.workerd.test.ts",
          },
          auth: { type: "apiKey", headerName: "X-API-Key" },
          baseUrl: "https://api.example.com",
          allowedHosts: ["api.example.com"],
          includeOperations: opIds,
        },
      }),
    ).toThrow(/OPENAPI_IMPORT_TOO_MANY_OPERATIONS/);

    expect(() =>
      importIntegrationSpec({
        spec: { openapi: "3.1.0", paths: {} },
        format: "openapi3",
        curation: {
          app: "empty-app",
          specProvenance: "upstream",
          ui: {
            displayName: "Empty",
            category: "automation",
            summary: "Zero operations.",
            maturity: "beta",
            maturityReason: "Testing empty",
            behaviourTest: "packages/integrations/test/pack-v1-contract.workerd.test.ts",
          },
          auth: { type: "apiKey", headerName: "X-API-Key" },
          baseUrl: "https://api.example.com",
          allowedHosts: ["api.example.com"],
          includeOperations: [],
        },
      }),
    ).toThrow(/OPENAPI_IMPORT_EMPTY_OPERATIONS/);
  });

  it("supports CLI --spec --format --curation --out flags for both openapi3 and google-discovery specs", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "px-openapi-import-"));
    try {
      const outPath = join(tmpDir, "google.integration.json");
      const cliArgs = [
        "--spec",
        join(REPO_ROOT, "integrations", "google", "discovery.json"),
        "--format",
        "google-discovery",
        "--curation",
        join(REPO_ROOT, "integrations", "google", "curation.config.json"),
        "--out",
        outPath,
        "--lenient",
      ];

      const parsedArgs = parseImportCliArgs(cliArgs);
      expect(parsedArgs.format).toBe("google-discovery");

      const results = runOpenApiImportCli(cliArgs);
      expect(results).toHaveLength(1);

      const written = JSON.parse(readFileSync(outPath, "utf8"));
      const parsed = IntegrationManifestSchema.safeParse(written);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.app).toBe("google");
        expect(parsed.data.operations.length).toBeGreaterThanOrEqual(10);
        expect(parsed.data.operations.length).toBeLessThanOrEqual(30);
        const metrics = measureIntegrationTokenMetrics(parsed.data);
        expect(metrics.compactSummaryTokens).toBeLessThanOrEqual(600);
        expect(metrics.maxOperationDetailTokens).toBeLessThanOrEqual(250);
        expect(metrics.maxSearchPageTokens).toBeLessThanOrEqual(400);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
