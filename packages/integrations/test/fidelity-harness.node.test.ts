import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFECT_CLASSES } from "../src/fidelity/classes.ts";
import { measureSpecFidelity } from "../src/fidelity/measure.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const miniFixturePath = resolve(__dirname, "fixtures/fidelity/mini-openapi.json");

describe("UC0.6 fidelity harness and measurement", () => {
  it("measures mini-openapi fixture with exact defect class counts", () => {
    const raw = readFileSync(miniFixturePath, "utf8");
    const spec = JSON.parse(raw);

    const report = measureSpecFidelity(spec, "openapi3");

    expect(report.specOps).toBe(1);
    expect(report.extractedOps).toBe(1);
    expect(report.importableOps).toBe(1);
    expect(report.opsWithStructuralDefect).toBe(1);

    // In UC3.5, body fields are uncapped and enums / compositions are preserved faithfully
    expect(report.classes["required_body_fields_lost_by_cap"]).toBeUndefined();
    expect(report.classes["body_fields_dropped_by_6_cap"]).toBeUndefined();
    expect(report.classes["enum_or_default_lost"]).toBeUndefined();
    expect(report.classes["type_erased_to_string(composition)"]).toBeUndefined();
    expect(report.classes["param_dropped_location(cookie/formData/body)"]).toBe(1);
    expect(report.classes["response_schema_ignored"]).toBe(1);

    // Verify examples map has an entry for each flagged class
    for (const defectClass of Object.keys(report.classes)) {
      expect(report.examples[defectClass as keyof typeof DEFECT_CLASSES]).toBeDefined();
      expect(report.examples[defectClass as keyof typeof DEFECT_CLASSES]?.op).toBeDefined();
    }
  });

  it("UC3.6: text/plain and octet-stream bodies are handled, so the free-form class does not flag them", () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "raw bodies", version: "1.0.0" },
      servers: [{ url: "https://api.example.test" }],
      paths: {
        "/markdown/raw": {
          post: {
            operationId: "renderRaw",
            requestBody: { content: { "text/plain": { schema: { type: "string" } } } },
            responses: { "200": { description: "ok", content: { "text/html": { schema: { type: "string" } } } } },
          },
        },
        "/assets/{id}": {
          post: {
            operationId: "uploadAsset",
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            requestBody: { content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
            responses: { "201": { description: "created", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" } } } } } } },
          },
        },
      },
    };
    const report = measureSpecFidelity(spec, "openapi3");
    expect(report.extractedOps).toBe(2);
    expect(report.classes["body_no_properties_dropped(free-form)"]).toBeUndefined();
  });

  it("UC3.7 follow-up: a pack acknowledgement for one op does not make every other single-op import stale", () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "acks", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/xml": {
          post: {
            operationId: "xmlBody",
            requestBody: { content: { "application/xml": { schema: { type: "object", properties: { a: { type: "string" } } } } } },
            responses: { "200": { description: "ok" } },
          },
        },
        "/plain": { get: { operationId: "plain", responses: { "200": { description: "ok" } } } },
      },
    };
    const curation: any = {
      app: "acks",
      version: "1.0.0",
      format: "openapi3",
      specProvenance: "upstream",
      baseUrl: "https://api.example.com",
      allowedHosts: ["api.example.com"],
      ui: { displayName: "Acks", category: "developer", icon: "spec", docsUrl: "https://example.com", summary: "s", maturity: "experimental", maturityReason: "r" },
      auth: { type: "none" },
      defaultRateLimit: { maxRetries: 3, initialBackoffMs: 200, respectRetryAfter: true, retryAfterHeader: "Retry-After" },
      operations: [],
      acknowledge: [{ op: "xmlBody", code: "CONTENT_TYPE_UNSUPPORTED", reason: "xml bodies out of scope" }],
    };

    const report = measureSpecFidelity(spec, "openapi3", { curation });
    expect(report.fails).toEqual({});
    expect(report.importableOps).toBe(2);

    // A genuinely stale acknowledgement on the op being imported still fails that op.
    const stale = measureSpecFidelity(spec, "openapi3", {
      curation: { ...curation, acknowledge: [{ op: "plain", code: "CONTENT_TYPE_UNSUPPORTED", reason: "no such loss on this op" }] },
    });
    expect(stale.importableOps).toBe(1);
    expect(Object.keys(stale.fails ?? {})[0]).toMatch(/OPENAPI_IMPORT_STALE_ACKNOWLEDGEMENT.*op="plain"/);
  });

  it("AC4: all DEFECT_CLASSES have defined non-empty descriptions", () => {
    expect(Object.keys(DEFECT_CLASSES).length).toBeGreaterThanOrEqual(20);
    for (const [defectClass, description] of Object.entries(DEFECT_CLASSES)) {
      expect(typeof defectClass).toBe("string");
      expect(typeof description).toBe("string");
      expect(description.trim().length).toBeGreaterThan(10);
    }
  });

  it("class-map.json maps defect classes to report codes", () => {
    const classMapPath = resolve(__dirname, "../../../scripts/fidelity/class-map.json");
    expect(existsSync(classMapPath)).toBe(true);
    const classMap = JSON.parse(readFileSync(classMapPath, "utf8"));
    for (const defectClass of Object.keys(DEFECT_CLASSES)) {
      expect(classMap[defectClass]).toBeDefined();
      expect(typeof classMap[defectClass]).toBe("string");
    }
  });
});
