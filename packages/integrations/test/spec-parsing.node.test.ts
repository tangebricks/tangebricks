import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseSpecDocument,
  detectSpecVersion,
  importIntegrationSpec,
} from "../src/importer.ts";

const YAML_FIXTURES_DIR = resolve(__dirname, "fixtures/yaml");
const REPORT_FIXTURES_DIR = resolve(__dirname, "fixtures/report");

const BASE_CURATION = {
  app: "ping-app",
  specProvenance: "upstream" as const,
  baseUrl: "https://api.example.com/v1",
  allowedHosts: ["api.example.com"],
  ui: {
    displayName: "Ping",
    category: "developer" as const,
    summary: "Ping test service",
    maturity: "production" as const,
  },
  auth: { type: "none" as const },
  includeOperations: ["ping"],
};

function loadYamlFixture(name: string): string {
  return readFileSync(resolve(YAML_FIXTURES_DIR, name), "utf8");
}

function loadJsonFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(YAML_FIXTURES_DIR, name), "utf8"));
}

describe("UC2.4: Spec parsing, version detection and servers diff", () => {
  describe("AC1: Real YAML parser on YAML fixtures vs JSON twins", () => {
    it.each([
      ["anchors", "anchors.yaml", "anchors.json"],
      ["block-scalars", "block-scalars.yaml", "block-scalars.json"],
      ["quoted-hash", "quoted-hash.yaml", "quoted-hash.json"],
      ["version-string", "version-string.yaml", "version-string.json"],
    ])("parses %s identically to its JSON twin", (_id, yamlFile, jsonFile) => {
      const yamlText = loadYamlFixture(yamlFile);
      const expectedJson = loadJsonFixture(jsonFile);
      const parsed = parseSpecDocument(yamlText);
      expect(parsed).toEqual(expectedJson);
    });
  });

  describe("AC2: Alias bomb rejection", () => {
    it("fails on alias-bomb.yaml with OPENAPI_IMPORT_PARSE_ERROR", () => {
      const aliasBombYaml = loadYamlFixture("alias-bomb.yaml");
      expect(() => parseSpecDocument(aliasBombYaml)).toThrowError(
        /OPENAPI_IMPORT_PARSE_ERROR/,
      );
    });
  });

  describe("detectSpecVersion & format mismatch", () => {
    it("detects spec dialects correctly", () => {
      expect(detectSpecVersion({ openapi: "3.0.3" })).toBe("openapi3.0");
      expect(detectSpecVersion({ openapi: "3.1.0" })).toBe("openapi3.1");
      expect(detectSpecVersion({ swagger: "2.0" })).toBe("swagger2");
      expect(
        detectSpecVersion({
          kind: "discovery#restDescription",
          discoveryVersion: "v1",
        }),
      ).toBe("google-discovery");
    });

    it("throws OPENAPI_IMPORT_FORMAT_MISMATCH on format mismatch", () => {
      expect(() =>
        importIntegrationSpec({
          spec: {
            kind: "discovery#restDescription",
            discoveryVersion: "v1",
            rootUrl: "https://www.googleapis.com/",
            servicePath: "test/v1/",
            resources: {},
          },
          format: "openapi3",
          curation: {
            ...BASE_CURATION,
            app: "test",
            baseUrl: "https://www.googleapis.com/test/v1",
            allowedHosts: ["www.googleapis.com"],
            includeOperations: [],
          },
        }),
      ).toThrowError(/OPENAPI_IMPORT_FORMAT_MISMATCH/);
    });
  });

  describe("AC3: Swagger 2.0 import with format openapi3 vs auto-detected / swagger2", () => {
    it("fails with OPENAPI_IMPORT_FORMAT_MISMATCH on format openapi3, up-converts on swagger2", () => {
      const swagger2Spec = JSON.parse(
        readFileSync(resolve(REPORT_FIXTURES_DIR, "lossy-swagger2.json"), "utf8"),
      );

      // AC2: --format openapi3 on a Swagger doc fails with OPENAPI_IMPORT_FORMAT_MISMATCH
      expect(() =>
        importIntegrationSpec({
          spec: swagger2Spec,
          format: "openapi3",
          curation: {
            ...BASE_CURATION,
            app: "test-swagger",
            baseUrl: "https://api.example.com",
            allowedHosts: ["api.example.com"],
            includeOperations: ["opSwaggerBody"],
          },
          mode: "lenient",
        }),
      ).toThrowError(/OPENAPI_IMPORT_FORMAT_MISMATCH/);

      // When format is omitted or swagger2, up-converts faithfully
      const result = importIntegrationSpec({
        spec: swagger2Spec,
        format: "swagger2",
        curation: {
          ...BASE_CURATION,
          app: "test-swagger",
          baseUrl: "https://api.example.com",
          allowedHosts: ["api.example.com"],
          includeOperations: ["opSwaggerBody"],
        },
        mode: "lenient",
      });

      const report = result.report;
      const upconvertEntry = report.entries.find(
        (e) => e.code === "SWAGGER2_UPCONVERTED",
      );
      expect(upconvertEntry).toBeDefined();
      expect(upconvertEntry?.element).toBe("document");
      expect(upconvertEntry?.status).toBe("normalized");

      const writeOp = result.manifest.operations.find(
        (o) => o.operationId === "opSwaggerBody",
      );
      expect(writeOp).toBeDefined();
      expect(writeOp?.body).toBeDefined();
    });
  });

  describe("AC4 & AC5: Servers diff and variables expansion", () => {
    it("emits BASEURL when spec server equals curation baseUrl", () => {
      const spec = {
        openapi: "3.0.0",
        servers: [{ url: "https://api.example.com/v1" }],
        paths: {
          "/ping": {
            get: {
              operationId: "ping",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      };

      const result = importIntegrationSpec({
        spec,
        format: "openapi3",
        curation: BASE_CURATION,
      });

      const serverEntries = result.report.entries.filter(
        (e) => e.element === "server",
      );
      expect(serverEntries).toHaveLength(1);
      expect(serverEntries[0]!.code).toBe("BASEURL");
      expect(serverEntries[0]!.status).toBe("mapped");
    });

    it("emits BASEURL_CURATED when spec server differs from curation baseUrl", () => {
      const spec = {
        openapi: "3.0.0",
        servers: [{ url: "https://api-spec.example.com/v1" }],
        paths: {
          "/ping": {
            get: {
              operationId: "ping",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      };

      const result = importIntegrationSpec({
        spec,
        format: "openapi3",
        curation: {
          ...BASE_CURATION,
          baseUrl: "https://curated-api.example.com/v1",
          allowedHosts: ["curated-api.example.com"],
        },
      });

      const serverEntries = result.report.entries.filter(
        (e) => e.element === "server" && e.code === "BASEURL_CURATED",
      );
      expect(serverEntries).toHaveLength(1);
      expect(serverEntries[0]!.status).toBe("curated");
      expect(serverEntries[0]!.from).toBe("https://api-spec.example.com/v1");
      expect(serverEntries[0]!.to).toBe("https://curated-api.example.com/v1");
    });

    it("expands server variables with defaults and emits SERVER_VARIABLE_EXPANDED", () => {
      const spec = {
        openapi: "3.0.0",
        servers: [
          {
            url: "https://{env}.example.com:{port}/v1",
            variables: {
              env: { default: "api" },
              port: { default: "443" },
            },
          },
        ],
        paths: {
          "/ping": {
            get: {
              operationId: "ping",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      };

      const result = importIntegrationSpec({
        spec,
        format: "openapi3",
        curation: {
          ...BASE_CURATION,
          baseUrl: "https://api.example.com:443/v1",
        },
      });

      const expandedEntry = result.report.entries.find(
        (e) => e.code === "SERVER_VARIABLE_EXPANDED",
      );
      expect(expandedEntry).toBeDefined();
      expect(expandedEntry?.element).toBe("server");
      expect(expandedEntry?.status).toBe("normalized");
      expect(expandedEntry?.from).toBe("https://{env}.example.com:{port}/v1");
      expect(expandedEntry?.to).toBe("https://api.example.com:443/v1");
    });

    it("emits OPERATION_SERVER_OVERRIDE with blocking: true on op-level server override", () => {
      const spec = {
        openapi: "3.0.0",
        servers: [{ url: "https://api.example.com/v1" }],
        paths: {
          "/ping": {
            get: {
              operationId: "ping",
              servers: [{ url: "https://other.example.com/v1" }],
              responses: { "200": { description: "OK" } },
            },
          },
        },
      };

      const result = importIntegrationSpec({
        spec,
        format: "openapi3",
        curation: {
          ...BASE_CURATION,
          allowedHosts: ["api.example.com", "other.example.com"],
        },
        mode: "lenient",
      });

      const overrideEntry = result.report.entries.find(
        (e) => e.code === "OPERATION_SERVER_OVERRIDE",
      );
      expect(overrideEntry).toBeDefined();
      expect(overrideEntry?.op).toBe("ping");
      expect(overrideEntry?.status).toBe("unsupported");
      expect(overrideEntry?.blocking).toBe(true);
    });

    it("emits ALLOWED_HOSTS_NARROWED when spec server host is missing from curation.allowedHosts", () => {
      const spec = {
        openapi: "3.0.0",
        servers: [{ url: "https://spec-server.example.com/v1" }],
        paths: {
          "/ping": {
            get: {
              operationId: "ping",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      };

      const result = importIntegrationSpec({
        spec,
        format: "openapi3",
        curation: {
          ...BASE_CURATION,
          baseUrl: "https://api.example.com/v1",
          allowedHosts: ["api.example.com"], // missing spec-server.example.com
        },
      });

      const narrowedEntry = result.report.entries.find(
        (e) => e.code === "ALLOWED_HOSTS_NARROWED",
      );
      expect(narrowedEntry).toBeDefined();
      expect(narrowedEntry?.status).toBe("curated");
    });
  });
});
