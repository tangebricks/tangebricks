import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { importIntegrationSpec } from "../src/importer.ts";
import { swagger2ToOpenApi3 } from "../src/swagger2.ts";

const FIXTURE_PATH = resolve(
  __dirname,
  "fixtures/swagger2/slack-chat-min.json",
);

describe("UC3.7 — Swagger 2.0 import and in-importer up-conversion", () => {
  const baseCuration = {
    app: "slack",
    version: "1.0.0",
    specProvenance: "upstream" as const,
    ui: {
      displayName: "Slack",
      category: "communication" as const,
      summary: "Slack API",
      maturity: "beta" as const,
      maturityReason: "Test fixture",
      behaviourTest: "packages/integrations/test/pack-v1-contract.workerd.test.ts",
    },
    auth: {
      type: "oauth2" as const,
      authorizeUrl: "https://slack.com/oauth/authorize",
      tokenUrl: "https://slack.com/api/oauth.access",
    },
    baseUrl: "https://slack.com/api",
    allowedHosts: ["slack.com"],
    includeOperations: ["chat_postMessage", "files_upload"],
  };

  it("Task 1: imports slack-chat-min.json with faithful body, auth, server, and report pointers", () => {
    const rawText = readFileSync(FIXTURE_PATH, "utf8");
    const spec = JSON.parse(rawText);

    const result = importIntegrationSpec({
      spec,
      curation: baseCuration,
      mode: "lenient",
    });

    // 1. chat_postMessage body is form-urlencoded with channel required and text
    const chatOp = result.manifest.operations.find((o) => o.operationId === "chat_postMessage");
    expect(chatOp).toBeDefined();
    expect(chatOp?.body).toBeDefined();
    expect(chatOp?.body?.contentType).toBe("application/x-www-form-urlencoded");
    const channelField = chatOp?.body?.fields?.find((f) => f.name === "channel");
    expect(channelField).toBeDefined();
    expect(channelField?.required).toBe(true);
    const textField = chatOp?.body?.fields?.find((f) => f.name === "text");
    expect(textField).toBeDefined();

    // 2. files_upload body is multipart/form-data with file binary:true
    const filesOp = result.manifest.operations.find((o) => o.operationId === "files_upload");
    expect(filesOp).toBeDefined();
    expect(filesOp?.body).toBeDefined();
    expect(filesOp?.body?.contentType).toBe("multipart/form-data");
    const fileField = filesOp?.body?.fields?.find((f) => f.name === "file");
    expect(fileField).toBeDefined();
    expect(fileField?.binary).toBe(true);
    expect(fileField?.dataType).toBe("any");

    // 3. Auth requirement slackAuth mapped
    expect(result.manifest.auth.schemes?.slackAuth).toEqual({ type: "oauth2" });
    const authEntry = result.report.entries.find(
      (e) => e.op === "chat_postMessage" && e.element === "auth",
    );
    expect(authEntry).toBeDefined();
    expect(authEntry?.status).toBe("mapped");

    // 4. Server diff computed from https://slack.com/api
    const serverEntry = result.report.entries.find((e) => e.element === "server");
    expect(serverEntry).toBeDefined();
    expect(serverEntry?.status).toBe("mapped");
    expect(serverEntry?.from).toBe("https://slack.com/api");
    expect(serverEntry?.to).toBe("https://slack.com/api");

    // 5. Report pointers into the original Swagger paths
    expect(serverEntry?.pointer).toBe("#/host");

    const upconvertEntry = result.report.entries.find((e) => e.code === "SWAGGER2_UPCONVERTED");
    expect(upconvertEntry).toBeDefined();
    expect(upconvertEntry?.status).toBe("normalized");
    expect(upconvertEntry?.element).toBe("document");
    expect(upconvertEntry?.pointer).toBe("#/swagger");

    // Body field pointers translated back through pointerMap into Swagger 2 paths
    const bodyFieldEntries = result.report.entries.filter(
      (e) => e.op === "chat_postMessage" && e.element === "bodyField",
    );
    expect(bodyFieldEntries.length).toBeGreaterThan(0);
    for (const bfe of bodyFieldEntries) {
      expect(bfe.pointer).toMatch(/^#\/paths\/~1chat\.postMessage\/post\/parameters\//);
    }
  });

  it("AC2: --format openapi3 on a Swagger doc fails with OPENAPI_IMPORT_FORMAT_MISMATCH, auto-detects when omitted", () => {
    const rawText = readFileSync(FIXTURE_PATH, "utf8");
    const spec = JSON.parse(rawText);

    // Explicit --format openapi3 on a Swagger doc fails
    expect(() =>
      importIntegrationSpec({
        spec,
        format: "openapi3",
        curation: baseCuration,
        mode: "lenient",
      }),
    ).toThrowError(/OPENAPI_IMPORT_FORMAT_MISMATCH/);

    // When format is omitted, auto-detection routes through swagger2 conversion and succeeds
    const result = importIntegrationSpec({
      spec,
      curation: baseCuration,
      mode: "lenient",
    });
    expect(result.manifest.app).toBe("slack");
    expect(result.report.format).toBe("swagger2");
  });

  it("Task 2: swagger2ToOpenApi3 pure converter handles collectionFormat, body, definitions, and securityDefinitions", () => {
    const swaggerDoc = {
      swagger: "2.0",
      info: { title: "Test", version: "1.0.0" },
      host: "example.com",
      basePath: "/v1",
      schemes: ["https"],
      securityDefinitions: {
        basicAuth: { type: "basic" },
        apiKeyAuth: { type: "apiKey", name: "X-API-Key", in: "header" },
      },
      definitions: {
        User: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
          },
        },
      },
      paths: {
        "/users": {
          post: {
            operationId: "createUser",
            parameters: [
              {
                name: "body",
                in: "body",
                required: true,
                schema: {
                  $ref: "#/definitions/User",
                },
              },
            ],
            responses: {
              200: {
                description: "OK",
                schema: {
                  $ref: "#/definitions/User",
                },
              },
            },
          },
          get: {
            operationId: "listUsers",
            parameters: [
              {
                name: "tags",
                in: "query",
                type: "array",
                items: { type: "string" },
                collectionFormat: "multi",
              },
              {
                name: "tsvTags",
                in: "query",
                type: "array",
                items: { type: "string" },
                collectionFormat: "tsv",
              },
            ],
            responses: {
              200: {
                description: "OK",
              },
            },
          },
        },
      },
    };

    const { spec: oas3, pointerMap, unsupportedEntries } = swagger2ToOpenApi3(swaggerDoc);

    // host/basePath/schemes -> servers
    expect(oas3.servers).toEqual([{ url: "https://example.com/v1" }]);

    // securityDefinitions basic -> http basic
    expect(oas3.components?.securitySchemes?.basicAuth).toEqual({
      type: "http",
      scheme: "basic",
    });

    // #/definitions/ refs rewritten to #/components/schemas/
    expect(oas3.components?.schemas?.User).toBeDefined();
    const createReqBody = oas3.paths["/users"].post.requestBody;
    expect(createReqBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/User",
    );

    // response schema -> response content
    const resp200 = oas3.paths["/users"].post.responses["200"];
    expect(resp200.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/User",
    );

    // collectionFormat multi -> style: form, explode: true
    const listParams = oas3.paths["/users"].get.parameters;
    const tagsParam = listParams.find((p: any) => p.name === "tags");
    expect(tagsParam.style).toBe("form");
    expect(tagsParam.explode).toBe(true);

    // collectionFormat tsv -> unsupported COLLECTION_FORMAT_UNSUPPORTED
    const tsvLoss = unsupportedEntries.find(
      (e: any) => e.code === "COLLECTION_FORMAT_UNSUPPORTED",
    );
    expect(tsvLoss).toBeDefined();

    // pointerMap maps OpenAPI 3 pointers back to original Swagger pointers
    expect(pointerMap.get("#/servers/0")).toBe("#/host");
  });
});
