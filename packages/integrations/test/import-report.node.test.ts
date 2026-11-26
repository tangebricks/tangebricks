import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IntegrationManifestSchema } from "@poc/assembler";
import {
  importIntegrationSpec,
  type CurationConfig,
} from "../src/importer.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("UC2.1 import report and manifest fidelity block", () => {
  const fixturePath = resolve(__dirname, "fixtures/report/petstore-min.openapi.json");
  const petstoreSpecText = readFileSync(fixturePath, "utf8");

  const baseCuration: CurationConfig = {
    app: "petstore",
    specProvenance: "upstream",
    ui: {
      displayName: "Petstore",
      category: "developer",
      icon: "pet",
      docsUrl: "https://example.com/docs",
      summary: "Petstore min test",
      maturity: "experimental",
      maturityReason: "Testing import report",
    },
    auth: {
      type: "apiKey",
      headerName: "Authorization",
      prefix: "Bearer ",
    },
    baseUrl: "https://petstore.example.com",
    allowedHosts: ["petstore.example.com"],
  };

  it("produces report entries and fidelity block for petstore fixture", () => {
    const result = importIntegrationSpec({
      spec: petstoreSpecText,
      format: "openapi3",
      curation: baseCuration,
      mode: "lenient",
    }) as any;

    expect(result.report).toBeDefined();
    expect(result.report.entries).toContainEqual({
      op: "getPet",
      element: "response",
      status: "mapped",
      code: "RESPONSE_SCHEMA",
      pointer: "#/paths/~1pets~1{id}/get/responses/200",
      blocking: false,
    });

    const authEntry = result.report.entries.find(
      (e: any) => e.op === "getPet" && e.element === "auth",
    );
    expect(authEntry).toBeDefined();
    expect(authEntry.status).toBe("curated");
    expect(authEntry.code).toBe("AUTH_FROM_CURATION");

    expect(result.manifest.fidelity).toBeDefined();
    expect(result.manifest.fidelity.level).toBe("curated");
  });

  it("AC2: manifest.fidelity.specHash equals sha256 of spec file bytes and changes on 1-byte change", () => {
    const expectedHash =
      "sha256:" +
      createHash("sha256").update(Buffer.from(petstoreSpecText, "utf8")).digest("hex");

    const result1 = importIntegrationSpec({
      spec: petstoreSpecText,
      format: "openapi3",
      curation: baseCuration,
      mode: "lenient",
    }) as any;

    expect(result1.manifest.fidelity.specHash).toBe(expectedHash);

    const tamperedText = petstoreSpecText.replace("Petstore Min", "Petstore Mix");
    const result2 = importIntegrationSpec({
      spec: tamperedText,
      format: "openapi3",
      curation: baseCuration,
      mode: "lenient",
    }) as any;

    expect(result2.manifest.fidelity.specHash).not.toBe(expectedHash);
  });

  it("AC3: every imported operation has exactly one response entry and exactly one auth entry", () => {
    const result = importIntegrationSpec({
      spec: petstoreSpecText,
      format: "openapi3",
      curation: baseCuration,
      mode: "lenient",
    }) as any;

    const opIds = result.manifest.operations.map((op: any) => op.operationId);
    for (const opId of opIds) {
      const responseEntries = result.report.entries.filter(
        (e: any) => e.op === opId && e.element === "response",
      );
      expect(responseEntries).toHaveLength(1);

      const authEntries = result.report.entries.filter(
        (e: any) => e.op === opId && e.element === "auth",
      );
      expect(authEntries).toHaveLength(1);
    }
  });

  it("AC4: IntegrationManifestSchema validates fidelity block and rejects invalid op / specHash", () => {
    const validManifest = {
      manifestVersion: 2,
      kind: "integration",
      app: "petstore",
      version: "1.0.0",
      ui: baseCuration.ui,
      auth: baseCuration.auth,
      baseUrl: baseCuration.baseUrl,
      allowedHosts: baseCuration.allowedHosts,
      operations: [
        {
          operationId: "getPet",
          label: "Get Pet",
          summary: "Get pet by id",
          method: "GET",
          path: "/pets/{id}",
          params: [{ name: "id", in: "path", dataType: "string", required: true }],
          response: {},
          sideEffects: "read",
        },
      ],
      fidelity: {
        specHash: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        importerVersion: "2.0.0",
        level: "partial",
        unsupported: [
          {
            op: "getPet",
            code: "RESPONSE_SCHEMA_IGNORED",
            pointer: "#/paths/~1pets~1{id}/get/responses/200",
            blocking: false,
          },
        ],
      },
    };

    const validCheck = IntegrationManifestSchema.safeParse(validManifest);
    expect(validCheck.success).toBe(true);

    // Rejects non-existent op in unsupported
    const invalidOpManifest = {
      ...validManifest,
      fidelity: {
        ...validManifest.fidelity,
        unsupported: [
          {
            op: "nonExistentOp",
            code: "RESPONSE_SCHEMA_IGNORED",
            pointer: "#/paths/foo",
            blocking: false,
          },
        ],
      },
    };
    const invalidOpCheck = IntegrationManifestSchema.safeParse(invalidOpManifest);
    expect(invalidOpCheck.success).toBe(false);

    // Rejects invalid specHash format
    const invalidHashManifest = {
      ...validManifest,
      fidelity: {
        ...validManifest.fidelity,
        specHash: "md5:1234",
      },
    };
    const invalidHashCheck = IntegrationManifestSchema.safeParse(invalidHashManifest);
    expect(invalidHashCheck.success).toBe(false);
  });
});
