import { describe, expect, it } from "vitest";
import { projectIntegrationToNodes } from "@poc/assembler";
import {
  analyzeSpec,
  extractGoogleDiscoveryOperations,
  extractOpenApi3Operations,
  importIntegrationSpec,
} from "../src/importer.ts";

describe("UC3.4 Parameter fidelity importer tests", () => {
  const openApiSpec = {
    openapi: "3.0.3",
    info: { title: "Param Fidelity API", version: "1.0.0" },
    paths: {
      "/items": {
        get: {
          operationId: "listItems",
          parameters: [
            {
              name: "status",
              in: "query",
              schema: {
                type: "string",
                enum: ["active", "pending", "archived"],
              },
            },
            {
              name: "limit",
              in: "query",
              schema: {
                type: "integer",
                default: 25,
              },
            },
            {
              name: "ids",
              in: "query",
              schema: {
                type: "array",
                items: {
                  type: "string",
                  enum: ["id_a", "id_b"],
                },
              },
              style: "form",
              explode: true,
            },
            {
              name: "filter",
              in: "query",
              style: "deepObject",
              explode: true,
              schema: {
                type: "object",
              },
            },
            {
              name: "session_id",
              in: "cookie",
              required: true,
              schema: {
                type: "string",
              },
            },
          ],
          responses: {
            "200": { description: "OK" },
          },
        },
      },
    },
  };

  const discoveryDoc = {
    discoveryVersion: "v1",
    id: "test:v1",
    name: "test",
    version: "v1",
    baseUrl: "https://test.googleapis.com/",
    servicePath: "v1/",
    resources: {
      projects: {
        methods: {
          get: {
            id: "test.projects.get",
            httpMethod: "GET",
            path: "projects/{+name}",
            flatPath: "projects/{+name}",
            parameters: {
              name: {
                type: "string",
                location: "path",
                required: true,
              },
              pageSize: {
                type: "integer",
                location: "query",
                default: 50,
              },
              view: {
                type: "string",
                location: "query",
                enum: ["BASIC", "FULL"],
              },
              tags: {
                type: "string",
                location: "query",
                repeated: true,
              },
            },
          },
        },
      },
    },
  };

  it("OpenAPI importer keeps enum, default, items, style, explode, and cookie params", () => {
    const ops = extractOpenApi3Operations(openApiSpec);
    const op = ops.get("listItems");
    expect(op).toBeDefined();

    const statusParam = op!.params?.find((p) => p.name === "status");
    expect(statusParam).toBeDefined();
    expect(statusParam?.enum).toEqual(["active", "pending", "archived"]);

    const limitParam = op!.params?.find((p) => p.name === "limit");
    expect(limitParam).toBeDefined();
    expect(limitParam?.default).toBe(25);

    const idsParam = op!.params?.find((p) => p.name === "ids");
    expect(idsParam).toBeDefined();
    expect(idsParam?.style).toBe("form");
    expect(idsParam?.explode).toBe(true);
    expect(idsParam?.items).toEqual({
      dataType: "string",
      enum: ["id_a", "id_b"],
    });

    const filterParam = op!.params?.find((p) => p.name === "filter");
    expect(filterParam).toBeDefined();
    expect(filterParam?.style).toBe("deepObject");
    expect(filterParam?.explode).toBe(true);

    const cookieParam = op!.params?.find((p) => p.name === "session_id");
    expect(cookieParam).toBeDefined();
    expect(cookieParam?.in).toBe("cookie");
    expect(cookieParam?.required).toBe(true);
  });

  it("Google Discovery importer preserves enum, default, allowReserved, and maps repeated:true to style:form, explode:true", () => {
    const ops = extractGoogleDiscoveryOperations(discoveryDoc as any);
    const op = ops.get("test_projects_get");
    expect(op).toBeDefined();

    const nameParam = op!.params?.find((p) => p.name === "name");
    expect(nameParam).toBeDefined();
    expect(nameParam?.allowReserved).toBe(true);
    expect(op!.path).toBe("/v1/projects/{name}");

    const pageSizeParam = op!.params?.find((p) => p.name === "pageSize");
    expect(pageSizeParam).toBeDefined();
    expect(pageSizeParam?.default).toBe(50);

    const viewParam = op!.params?.find((p) => p.name === "view");
    expect(viewParam).toBeDefined();
    expect(viewParam?.enum).toEqual(["BASIC", "FULL"]);

    const tagsParam = op!.params?.find((p) => p.name === "tags");
    expect(tagsParam).toBeDefined();
    expect(tagsParam?.dataType).toBe("array");
    expect(tagsParam?.style).toBe("form");
    expect(tagsParam?.explode).toBe(true);
  });

  it("AC4: analysis does not emit PARAM_ENUM_DROPPED, PARAM_DEFAULT_DROPPED, PARAM_ITEMS_TYPE_DROPPED, PARAM_STYLE_UNHONOURED, PATH_RESERVED_EXPANSION_LOST, or PARAM_LOCATION_UNSUPPORTED for cookie", () => {
    const openApiReport = analyzeSpec({
      spec: openApiSpec,
      format: "openapi3",
      appName: "test-openapi",
    });

    const disallowedOpenApiCodes = [
      "PARAM_ENUM_DROPPED",
      "PARAM_DEFAULT_DROPPED",
      "PARAM_ITEMS_TYPE_DROPPED",
      "PARAM_STYLE_UNHONOURED",
    ];
    for (const code of disallowedOpenApiCodes) {
      const found = openApiReport.entries.filter((e) => e.code === code);
      expect(found, `Expected 0 entries for ${code}`).toHaveLength(0);
    }
    const cookieUnsupported = openApiReport.entries.filter(
      (e) => e.code === "PARAM_LOCATION_UNSUPPORTED" && e.from === "cookie",
    );
    expect(cookieUnsupported).toHaveLength(0);

    const discoveryReport = analyzeSpec({
      spec: discoveryDoc as any,
      format: "google-discovery",
      appName: "test-discovery",
    });
    const disallowedDiscoveryCodes = [
      "PARAM_ENUM_DROPPED",
      "PARAM_DEFAULT_DROPPED",
      "PARAM_STYLE_UNHONOURED",
      "PATH_RESERVED_EXPANSION_LOST",
    ];
    for (const code of disallowedDiscoveryCodes) {
      const found = discoveryReport.entries.filter((e) => e.code === code);
      expect(found, `Expected 0 entries for ${code}`).toHaveLength(0);
    }
  });

  it("Enums longer than 256 items are reported as approximated PARAM_ENUM_TRUNCATED", () => {
    const largeEnum = Array.from({ length: 300 }, (_, i) => `item_${i}`);
    const largeEnumSpec = {
      openapi: "3.0.3",
      info: { title: "Large Enum API", version: "1.0.0" },
      paths: {
        "/large": {
          get: {
            operationId: "getLarge",
            parameters: [
              {
                name: "huge",
                in: "query",
                schema: {
                  type: "string",
                  enum: largeEnum,
                },
              },
            ],
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };

    const report = analyzeSpec({
      spec: largeEnumSpec,
      format: "openapi3",
      appName: "test-large-enum",
    });

    const truncEntry = report.entries.find((e) => e.code === "PARAM_ENUM_TRUNCATED");
    expect(truncEntry).toBeDefined();
    expect(truncEntry?.status).toBe("approximated");

    const ops = extractOpenApi3Operations(largeEnumSpec);
    const param = ops.get("getLarge")?.params?.find((p) => p.name === "huge");
    expect(param?.enum).toBeDefined();
    expect(param?.enum).toHaveLength(256);
  });

  it("projectIntegrationToNodes copies enum and default to node input definitions", () => {
    const result = importIntegrationSpec({
      spec: openApiSpec,
      curation: {
        app: "test-project-nodes",
        specProvenance: "upstream",
        ui: {
          displayName: "Test Nodes",
          category: "developer",
          summary: "Test projection to nodes",
          maturity: "beta",
          maturityReason: "Test",
        },
        auth: { type: "none" },
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });

    const nodes = projectIntegrationToNodes(result.manifest);
    expect(nodes).toHaveLength(1);
    const node = nodes[0]!;

    const statusInput = node.inputs.find((i) => i.id === "status");
    expect(statusInput).toBeDefined();
    expect(statusInput?.enum).toEqual(["active", "pending", "archived"]);

    const limitInput = node.inputs.find((i) => i.id === "limit");
    expect(limitInput).toBeDefined();
    expect(limitInput?.default).toBe(25);
  });
});
