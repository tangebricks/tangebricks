import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IntegrationManifestSchema, projectIntegrationToNodes } from "@poc/assembler";
import {
  extractGoogleDiscoveryOperations,
  extractOpenApi3Operations,
} from "../src/importer.ts";
import { ReportCollector } from "../src/report.ts";

const spec = {
  openapi: "3.0.3",
  info: { title: "Response Outputs API", version: "1.0.0" },
  paths: {
    "/customers": {
      post: {
        operationId: "createCustomer",
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["amount"],
                  properties: {
                    id: { type: "string" },
                    amount: { type: "integer" },
                    metadata: { type: "object" },
                    items: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          default: {
            description: "Error",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    error: {
                      type: "object",
                      properties: {
                        code: { type: "string" },
                        message: { type: "string" },
                        type: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/customers/{id}": {
      delete: {
        operationId: "deleteCustomer",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "204": { description: "No content" } },
      },
    },
  },
};

const discoveryDoc = {
  discoveryVersion: "v1",
  id: "cal:v3",
  name: "cal",
  version: "v3",
  baseUrl: "https://cal.googleapis.com/",
  servicePath: "v3/",
  schemas: {
    Event: {
      id: "Event",
      type: "object",
      properties: {
        id: { type: "string" },
        summary: { type: "string" },
        sequence: { type: "integer" },
      },
    },
  },
  resources: {
    events: {
      methods: {
        get: {
          id: "cal.events.get",
          httpMethod: "GET",
          path: "events/{eventId}",
          parameters: { eventId: { type: "string", location: "path", required: true } },
          response: { $ref: "Event" },
        },
      },
    },
  },
};

describe("UC3.2 response outputs and error shape (OpenAPI)", () => {
  it("maps 200 schema to ordered outputs, status and errorShape, reported mapped", () => {
    const report = new ReportCollector();
    const ops = extractOpenApi3Operations(spec, report);
    const op = ops.get("createCustomer")!;
    expect(op.response.outputs).toEqual([
      { id: "amount", dataType: "number" },
      { id: "id", dataType: "string" },
      { id: "metadata", dataType: "object" },
      { id: "items", dataType: "array" },
    ]);
    expect(op.response.status).toBe(200);
    expect(op.response.errorShape).toEqual({
      codePath: "error.code",
      messagePath: "error.message",
      typePath: "error.type",
    });
    const mine = report.entries.filter((e) => e.op === "createCustomer");
    expect(mine.some((e) => e.code === "RESPONSE_SCHEMA" && e.status === "mapped")).toBe(true);
    expect(mine.some((e) => e.code === "ERROR_SHAPE" && e.status === "mapped")).toBe(true);
    expect(mine.some((e) => e.code === "RESPONSE_SCHEMA_IGNORED")).toBe(false);
  });

  it("a 204 op maps to no outputs, reported mapped RESPONSE_EMPTY", () => {
    const report = new ReportCollector();
    const ops = extractOpenApi3Operations(spec, report);
    const op = ops.get("deleteCustomer")!;
    expect(op.response.outputs ?? []).toEqual([]);
    const mine = report.entries.filter((e) => e.op === "deleteCustomer");
    expect(mine.some((e) => e.code === "RESPONSE_EMPTY" && e.status === "mapped")).toBe(true);
    expect(mine.some((e) => e.code === "RESPONSE_SCHEMA_IGNORED")).toBe(false);
  });
});

describe("UC3.2 response outputs (Discovery)", () => {
  it("resolves response.$ref against schemas", () => {
    const report = new ReportCollector();
    const ops = extractGoogleDiscoveryOperations(discoveryDoc as any, report);
    const op = ops.get("cal_events_get")!;
    expect(op.response.outputs).toEqual([
      { id: "id", dataType: "string" },
      { id: "summary", dataType: "string" },
      { id: "sequence", dataType: "number" },
    ]);
    const mine = report.entries.filter((e) => e.op === "cal_events_get");
    expect(mine.some((e) => e.code === "RESPONSE_SCHEMA" && e.status === "mapped")).toBe(true);
    expect(mine.some((e) => e.code === "RESPONSE_SCHEMA_IGNORED")).toBe(false);
  });
});

describe("UC3.2 packs", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const packs = ["stripe", "github", "discord", "slack", "google"];

  it("AC1: projected int:stripe.createCustomer exposes typed output port id:string", () => {
    const manifest = IntegrationManifestSchema.parse(
      JSON.parse(readFileSync(resolve(root, "integrations/stripe/integration.json"), "utf8")),
    );
    const node = projectIntegrationToNodes(manifest).find((n) => n.type === "int:stripe.createCustomer");
    expect(node).toBeDefined();
    expect(node!.outputs).toContainEqual(expect.objectContaining({ id: "id", dataType: "string" }));
  });

  it("AC4: no pack curation keeps a RESPONSE_SCHEMA_IGNORED acknowledgement", () => {
    for (const app of packs) {
      const curation = JSON.parse(
        readFileSync(resolve(root, `integrations/${app}/curation.config.json`), "utf8"),
      );
      const stale = (curation.acknowledge ?? []).filter(
        (a: { code: string }) => a.code === "RESPONSE_SCHEMA_IGNORED",
      );
      expect(stale, `${app} keeps RESPONSE_SCHEMA_IGNORED acknowledgements`).toEqual([]);
    }
  });
});

describe("UC3.2 rework: top-level oneOf/anyOf responses", () => {
  const composedSpec = {
    openapi: "3.0.3",
    info: { title: "Composed", version: "1.0.0" },
    paths: {
      "/things/{id}": {
        get: {
          operationId: "getThing",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    anyOf: [
                      {
                        type: "object",
                        properties: { id: { type: "string" }, name: { type: "string" }, size: { type: "integer" } },
                      },
                      {
                        type: "object",
                        properties: { id: { type: "string" }, deleted: { type: "boolean" }, size: { type: "string" } },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  it("maps properties present in every variant, mixed types become any, reported mapped", () => {
    const report = new ReportCollector();
    const op = extractOpenApi3Operations(composedSpec, report).get("getThing")!;
    expect(op.response.outputs).toEqual([
      { id: "id", dataType: "string" },
      { id: "size", dataType: "any" },
    ]);
    const mine = report.entries.filter((e) => e.op === "getThing");
    expect(mine.some((e) => e.code === "RESPONSE_SCHEMA" && e.status === "mapped")).toBe(true);
    expect(mine.some((e) => e.code === "RESPONSE_SCHEMA_IGNORED")).toBe(false);
  });
});
