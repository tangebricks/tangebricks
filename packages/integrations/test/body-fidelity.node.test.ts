import { describe, expect, it } from "vitest";
import {
  analyzeSpec,
  extractGoogleDiscoveryOperations,
  extractOpenApi3Operations,
  importIntegrationSpec,
} from "../src/importer.ts";

const testCuration = {
  app: "test",
  specProvenance: "upstream" as const,
  ui: {
    displayName: "Test",
    category: "communication" as const,
    summary: "Test",
    maturity: "beta" as const,
    maturityReason: "Testing body fidelity",
  },
  auth: { type: "none" as const },
  baseUrl: "https://api.test.com",
  allowedHosts: ["api.test.com"],
};

const googleCuration = {
  app: "google",
  specProvenance: "upstream" as const,
  ui: {
    displayName: "Google",
    category: "communication" as const,
    summary: "Google",
    maturity: "beta" as const,
    maturityReason: "Testing body fidelity",
  },
  auth: { type: "none" as const },
  baseUrl: "https://www.googleapis.com",
  allowedHosts: ["www.googleapis.com"],
};

describe("UC3.5 Request body fidelity importer tests", () => {
  it("7-prop body whose 7th prop is required type: imports all 7 fields with required type first", () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "Test API", version: "1.0.0" },
      paths: {
        "/accounts": {
          post: {
            operationId: "createAccount",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["type"],
                    properties: {
                      prop1: { type: "string" },
                      prop2: { type: "string" },
                      prop3: { type: "string" },
                      prop4: { type: "string" },
                      prop5: { type: "string" },
                      prop6: { type: "string" },
                      type: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };

    const curation = {
      app: "test",
      specProvenance: "upstream" as const,
      ui: { displayName: "Test", summary: "Test", maturity: "beta" as const },
    };

    const res = importIntegrationSpec({
      spec,
      format: "openapi3",
      curation: testCuration,
    });

    const op = res.manifest.operations.find((o) => o.operationId === "createAccount");
    expect(op?.body?.fields).toBeDefined();
    expect(op?.body?.fields).toHaveLength(7);
    // Required-first ordering: 'type' must be first
    expect(op?.body?.fields?.[0]?.name).toBe("type");
    expect(op?.body?.fields?.[0]?.required).toBe(true);

    const report = analyzeSpec({ appName: "test", spec, format: "openapi3" });
    const cappedCodes = report.entries.filter(
      (e) => e.code === "BODY_FIELD_CAPPED" || e.code === "BODY_REQUIRED_FIELD_CAPPED",
    );
    expect(cappedCodes).toHaveLength(0);
  });

  it("nested collection_options:{fields, future_requirements}: preserves nested field with schema.properties", () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "Test API", version: "1.0.0" },
      paths: {
        "/accounts": {
          post: {
            operationId: "createAccountWithOptions",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      collection_options: {
                        type: "object",
                        properties: {
                          fields: { type: "string" },
                          future_requirements: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };

    const curation = {
      app: "test",
      specProvenance: "upstream" as const,
      ui: { displayName: "Test", summary: "Test", maturity: "beta" as const },
    };

    const res = importIntegrationSpec({
      spec,
      format: "openapi3",
      curation: testCuration,
    });

    const op = res.manifest.operations.find((o) => o.operationId === "createAccountWithOptions");
    const field = op?.body?.fields?.find((f) => f.name === "collection_options");
    expect(field).toBeDefined();
    expect((field as any)?.schema?.properties?.fields).toBeDefined();
    expect((field as any)?.schema?.properties?.future_requirements).toBeDefined();

    const report = analyzeSpec({ appName: "test", spec, format: "openapi3" });
    const flattened = report.entries.filter((e) => e.code === "BODY_NESTED_FLATTENED");
    expect(flattened).toHaveLength(0);
  });

  it("allOf of two $refs: merges fields with union of required", () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "Test API", version: "1.0.0" },
      components: {
        schemas: {
          BasePart: {
            type: "object",
            required: ["id"],
            properties: {
              id: { type: "string" },
            },
          },
          ExtraPart: {
            type: "object",
            required: ["extra"],
            properties: {
              extra: { type: "string" },
            },
          },
        },
      },
      paths: {
        "/composite": {
          post: {
            operationId: "createComposite",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    allOf: [
                      { $ref: "#/components/schemas/BasePart" },
                      { $ref: "#/components/schemas/ExtraPart" },
                    ],
                  },
                },
              },
            },
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };

    const curation = {
      app: "test",
      specProvenance: "upstream" as const,
      ui: { displayName: "Test", summary: "Test", maturity: "beta" as const },
    };

    const res = importIntegrationSpec({
      spec,
      format: "openapi3",
      curation: testCuration,
    });

    const op = res.manifest.operations.find((o) => o.operationId === "createComposite");
    expect(op?.body?.fields).toBeDefined();
    const names = op?.body?.fields?.map((f) => f.name);
    expect(names).toContain("id");
    expect(names).toContain("extra");
    const idField = op?.body?.fields?.find((f) => f.name === "id");
    const extraField = op?.body?.fields?.find((f) => f.name === "extra");
    expect(idField?.required).toBe(true);
    expect(extraField?.required).toBe(true);

    const report = analyzeSpec({ appName: "test", spec, format: "openapi3" });
    const composedDropped = report.entries.filter((e) => e.code === "BODY_COMPOSED_DROPPED");
    expect(composedDropped).toHaveLength(0);
  });

  it("oneOf [string, object] with a discriminator: preserves variants and discriminator", () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "Test API", version: "1.0.0" },
      paths: {
        "/discriminated": {
          post: {
            operationId: "sendVariant",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    discriminator: { propertyName: "kind" },
                    oneOf: [
                      {
                        type: "object",
                        properties: {
                          kind: { type: "string" },
                          textVal: { type: "string" },
                        },
                      },
                      {
                        type: "object",
                        properties: {
                          kind: { type: "string" },
                          numVal: { type: "number" },
                        },
                      },
                    ],
                  },
                },
              },
            },
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };

    const curation = {
      app: "test",
      specProvenance: "upstream" as const,
      ui: { displayName: "Test", summary: "Test", maturity: "beta" as const },
    };

    const res = importIntegrationSpec({
      spec,
      format: "openapi3",
      curation: testCuration,
    });

    const op = res.manifest.operations.find((o) => o.operationId === "sendVariant");
    expect(op?.body).toBeDefined();
    // Root schema or field schema contains variants and discriminator
    const rootOrField = (op?.body as any)?.root?.schema ?? (op?.body?.fields?.[0] as any)?.schema;
    expect(rootOrField?.variants).toBeDefined();
    expect(rootOrField.variants.length).toBe(2);
    expect(rootOrField.discriminator).toBe("kind");

    const report = analyzeSpec({ appName: "test", spec, format: "openapi3" });
    const composedDropped = report.entries.filter(
      (e) => e.code === "BODY_COMPOSED_DROPPED" || e.code === "SCHEMA_COMPOSITION_ERASED",
    );
    expect(composedDropped).toHaveLength(0);
  });

  it("top-level array body: maps to body.root = { dataType: 'array', schema }", () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "Test API", version: "1.0.0" },
      paths: {
        "/batch": {
          post: {
            operationId: "uploadBatch",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      type: "string",
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };

    const curation = {
      app: "test",
      specProvenance: "upstream" as const,
      ui: { displayName: "Test", summary: "Test", maturity: "beta" as const },
    };

    const res = importIntegrationSpec({
      spec,
      format: "openapi3",
      curation: testCuration,
    });

    const op = res.manifest.operations.find((o) => o.operationId === "uploadBatch");
    expect(op?.body).toBeDefined();
    expect((op?.body as any)?.root).toBeDefined();
    expect((op?.body as any)?.root?.dataType).toBe("array");
    expect((op?.body as any)?.root?.schema?.items?.dataType).toBe("string");

    const report = analyzeSpec({ appName: "test", spec, format: "openapi3" });
    const dropped = report.entries.filter((e) => e.code === "BODY_TOPLEVEL_ARRAY_DROPPED");
    expect(dropped).toHaveLength(0);
  });

  it("additionalProperties: true object: maps to body.root = { dataType: 'object' }", () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "Test API", version: "1.0.0" },
      paths: {
        "/freeform": {
          post: {
            operationId: "uploadFreeform",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: true,
                  },
                },
              },
            },
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };

    const curation = {
      app: "test",
      specProvenance: "upstream" as const,
      ui: { displayName: "Test", summary: "Test", maturity: "beta" as const },
    };

    const res = importIntegrationSpec({
      spec,
      format: "openapi3",
      curation: testCuration,
    });

    const op = res.manifest.operations.find((o) => o.operationId === "uploadFreeform");
    expect(op?.body).toBeDefined();
    expect((op?.body as any)?.root).toBeDefined();
    expect((op?.body as any)?.root?.dataType).toBe("object");

    const report = analyzeSpec({ appName: "test", spec, format: "openapi3" });
    const dropped = report.entries.filter((e) => e.code === "BODY_FREEFORM_DROPPED");
    expect(dropped).toHaveLength(0);
  });

  it("Discovery property $ref: 'EventDateTime': resolves sub-fields", () => {
    const doc = {
      discoveryVersion: "v1",
      id: "calendar:v3",
      name: "calendar",
      version: "v3",
      baseUrl: "https://www.googleapis.com/calendar/v3/",
      servicePath: "calendar/v3/",
      schemas: {
        Event: {
          id: "Event",
          type: "object",
          properties: {
            start: { $ref: "EventDateTime" },
          },
        },
        EventDateTime: {
          id: "EventDateTime",
          type: "object",
          properties: {
            date: { type: "string" },
            dateTime: { type: "string" },
            timeZone: { type: "string" },
          },
        },
      },
      resources: {
        events: {
          methods: {
            insert: {
              id: "calendar.events.insert",
              httpMethod: "POST",
              path: "calendars/{calendarId}/events",
              request: { $ref: "Event" },
              parameters: {
                calendarId: { type: "string", location: "path", required: true },
              },
            },
          },
        },
      },
    };

    const curation = {
      app: "google",
      specProvenance: "upstream" as const,
      ui: { displayName: "Google", summary: "Google", maturity: "beta" as const },
    };

    const res = importIntegrationSpec({
      spec: doc,
      format: "google-discovery",
      curation: googleCuration,
    });

    const op = res.manifest.operations.find((o) => o.operationId === "calendar_events_insert");
    const startField = op?.body?.fields?.find((f) => f.name === "start");
    expect(startField).toBeDefined();
    expect((startField as any)?.schema?.properties?.dateTime).toBeDefined();
    expect((startField as any)?.schema?.properties?.timeZone).toBeDefined();

    const report = analyzeSpec({ appName: "google", spec: doc, format: "google-discovery" });
    const unresolved = report.entries.filter((e) => e.code === "BODY_REF_PROPERTY_UNRESOLVED");
    expect(unresolved).toHaveLength(0);
  });

  it("recursive schema: terminates (cycle-safe) in < 1s (AC3)", () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "Test API", version: "1.0.0" },
      components: {
        schemas: {
          Node: {
            type: "object",
            properties: {
              value: { type: "string" },
              parent: { $ref: "#/components/schemas/Node" },
              children: {
                type: "array",
                items: { $ref: "#/components/schemas/Node" },
              },
            },
          },
        },
      },
      paths: {
        "/tree": {
          post: {
            operationId: "createTree",
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Node" },
                },
              },
            },
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };

    const t0 = performance.now();
    const curation = {
      app: "test",
      specProvenance: "upstream" as const,
      ui: { displayName: "Test", summary: "Test", maturity: "beta" as const },
    };

    const res = importIntegrationSpec({
      spec,
      format: "openapi3",
      curation: testCuration,
    });
    const t1 = performance.now();
    expect(t1 - t0).toBeLessThan(1000);

    const op = res.manifest.operations.find((o) => o.operationId === "createTree");
    expect(op?.body?.fields).toBeDefined();
    const parentField = op?.body?.fields?.find((f) => f.name === "parent");
    expect(parentField).toBeDefined();
  });

  it("schema exceeding recursion depth 8 degrades to generic object without throwing and emits SCHEMA_DEPTH_LIMIT", () => {
    let deepSchema: any = { type: "string" };
    for (let i = 10; i >= 1; i--) {
      deepSchema = {
        type: "object",
        properties: {
          [`level_${i}`]: deepSchema,
        },
      };
    }

    const spec = {
      openapi: "3.0.3",
      info: { title: "Test API", version: "1.0.0" },
      paths: {
        "/deep": {
          post: {
            operationId: "deepOp",
            requestBody: {
              content: {
                "application/json": {
                  schema: deepSchema,
                },
              },
            },
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };

    const res = importIntegrationSpec({
      spec,
      format: "openapi3",
      curation: testCuration,
      mode: "lenient",
    });

    expect(res).toBeDefined();
    expect(res.manifest).toBeDefined();
    const op = res.manifest.operations.find((o) => o.operationId === "deepOp");
    expect(op).toBeDefined();
    expect(op?.body?.fields).toBeDefined();

    const depthEntry = res.report.entries.find((e) => e.code === "SCHEMA_DEPTH_LIMIT");
    expect(depthEntry).toBeDefined();
    expect(depthEntry?.status).toBe("approximated");
    expect(depthEntry?.blocking).toBe(false);
  });

  it("schema exceeding 200 nodes degrades to generic object without throwing and emits SCHEMA_NODE_LIMIT", () => {
    const props: Record<string, any> = {};
    for (let i = 0; i < 250; i++) {
      props[`field_${i}`] = { type: "string" };
    }

    const spec = {
      openapi: "3.0.3",
      info: { title: "Test API", version: "1.0.0" },
      paths: {
        "/wide": {
          post: {
            operationId: "wideOp",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      nested: {
                        type: "object",
                        properties: props,
                      },
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };

    const res = importIntegrationSpec({
      spec,
      format: "openapi3",
      curation: testCuration,
      mode: "lenient",
    });

    expect(res).toBeDefined();
    expect(res.manifest).toBeDefined();
    const op = res.manifest.operations.find((o) => o.operationId === "wideOp");
    expect(op).toBeDefined();
    expect(op?.body?.fields).toBeDefined();

    const nodeLimitEntry = res.report.entries.find((e) => e.code === "SCHEMA_NODE_LIMIT");
    expect(nodeLimitEntry).toBeDefined();
    expect(nodeLimitEntry?.status).toBe("approximated");
    expect(nodeLimitEntry?.blocking).toBe(false);
  });
});
