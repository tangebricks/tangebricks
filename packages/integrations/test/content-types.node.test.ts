import { describe, expect, it } from "vitest";
import { importIntegrationSpec } from "../src/importer.ts";

describe("UC3.6 — Importer content types preference order, XML blocking, and Discovery media upload", () => {
  const baseCuration = {
    app: "test-content-types",
    specProvenance: "upstream" as const,
    version: "1.0.0",
    ui: {
      displayName: "Test Content Types",
      category: "developer" as const,
      summary: "Test",
      maturity: "beta" as const,
      maturityReason: "UC3.6 test verification",
    },
    auth: { type: "none" as const },
    baseUrl: "https://api.example.com",
    allowedHosts: ["api.example.com"],
  };

  it("content-type preference order is json > form > multipart/form-data > octet-stream > text/*; chosen type is mapped and alternatives recorded", () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "Content Types API", version: "1.0.0" },
      paths: {
        "/multi-all": {
          post: {
            operationId: "multiAll",
            requestBody: {
              content: {
                "text/plain": { schema: { type: "string" } },
                "application/octet-stream": { schema: { type: "string", format: "binary" } },
                "multipart/form-data": {
                  schema: {
                    type: "object",
                    properties: { file: { type: "string", format: "binary" } },
                  },
                },
                "application/x-www-form-urlencoded": {
                  schema: { type: "object", properties: { key: { type: "string" } } },
                },
                "application/json": {
                  schema: { type: "object", properties: { key: { type: "string" } } },
                },
              },
            },
            responses: { "200": { description: "OK" } },
          },
        },
        "/multipart-over-octet": {
          post: {
            operationId: "multipartOverOctet",
            requestBody: {
              content: {
                "application/octet-stream": { schema: { type: "string", format: "binary" } },
                "multipart/form-data": {
                  schema: {
                    type: "object",
                    properties: { file: { type: "string", format: "binary" } },
                  },
                },
              },
            },
            responses: { "200": { description: "OK" } },
          },
        },
        "/octet-over-text": {
          post: {
            operationId: "octetOverText",
            requestBody: {
              content: {
                "text/plain": { schema: { type: "string" } },
                "application/octet-stream": { schema: { type: "string", format: "binary" } },
              },
            },
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };

    const result = importIntegrationSpec({
      spec,
      format: "openapi3",
      curation: baseCuration,
    });

    const multiAllOp = result.manifest.operations.find((o) => o.operationId === "multiAll");
    expect(multiAllOp?.body?.contentType).toBe("application/json");

    const multipartOp = result.manifest.operations.find(
      (o) => o.operationId === "multipartOverOctet",
    );
    expect(multipartOp?.body?.contentType).toBe("multipart/form-data");

    const octetOp = result.manifest.operations.find((o) => o.operationId === "octetOverText");
    expect(octetOp?.body?.contentType).toBe("application/octet-stream");

    // Verify alternatives recorded in report
    const multiEntry = result.report.entries.find(
      (e) => e.op === "multipartOverOctet" && e.element === "contentType",
    );
    expect(multiEntry).toBeDefined();
    expect(multiEntry?.code).toBe("CONTENT_TYPE_MAPPED");
    expect(multiEntry?.to).toBe("multipart/form-data");
    expect(multiEntry?.from).toContain("application/octet-stream");
  });

  it("XML-only bodies are unsupported CONTENT_TYPE_UNSUPPORTED with blocking:true", () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "XML Only API", version: "1.0.0" },
      paths: {
        "/xml-endpoint": {
          post: {
            operationId: "postXml",
            requestBody: {
              content: {
                "application/xml": {
                  schema: { type: "object" },
                },
              },
            },
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };

    const result = importIntegrationSpec({
      spec,
      format: "openapi3",
      curation: baseCuration,
      mode: "lenient",
    });

    const entry = result.report.entries.find(
      (e) => e.op === "postXml" && e.code === "CONTENT_TYPE_UNSUPPORTED",
    );
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("unsupported");
    expect(entry?.blocking).toBe(true);
    expect(entry?.from).toContain("application/xml");
  });

  it("a Discovery supportsMediaUpload method yields an <id>_upload op using mediaUpload.protocols.simple|multipart paths, normalized MEDIA_UPLOAD_VARIANT", () => {
    const discoveryDoc = {
      kind: "discovery#restDescription",
      discoveryVersion: "v1",
      name: "drive",
      version: "v3",
      baseUrl: "https://www.googleapis.com/drive/v3/",
      servicePath: "drive/v3/",
      resources: {
        files: {
          methods: {
            create: {
              id: "drive.files.create",
              httpMethod: "POST",
              path: "files",
              description: "Creates a copy of the specified file.",
              supportsMediaUpload: true,
              mediaUpload: {
                accept: ["*/*"],
                maxSize: "5120GB",
                protocols: {
                  simple: {
                    multipart: true,
                    path: "/upload/drive/v3/files",
                  },
                  resumable: {
                    multipart: true,
                    path: "/resumable/upload/drive/v3/files",
                  },
                },
              },
              request: {
                $ref: "File",
              },
              response: {
                $ref: "File",
              },
            },
          },
        },
      },
      schemas: {
        File: {
          id: "File",
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
          },
        },
      },
    };

    const result = importIntegrationSpec({
      spec: discoveryDoc,
      format: "google-discovery",
      curation: {
        ...baseCuration,
        app: "google",
      },
      mode: "lenient",
    });

    // Check base operation exists
    const baseOp = result.manifest.operations.find(
      (o) => o.operationId === "drive_files_create" || o.operationId === "create",
    );
    expect(baseOp).toBeDefined();

    // Check upload variant operation exists
    const uploadOp = result.manifest.operations.find(
      (o) =>
        o.operationId === "drive_files_create_upload" || o.operationId === "create_upload",
    );
    expect(uploadOp).toBeDefined();
    expect(uploadOp?.path).toBe("/upload/drive/v3/files");
    expect(uploadOp?.body?.contentType).toBe("multipart/related");

    // Check report entry normalized with MEDIA_UPLOAD_VARIANT
    const variantEntry = result.report.entries.find((e) => e.code === "MEDIA_UPLOAD_VARIANT");
    expect(variantEntry).toBeDefined();
    expect(variantEntry?.status).toBe("normalized");
    expect(variantEntry?.blocking).toBe(false);
  });
});
