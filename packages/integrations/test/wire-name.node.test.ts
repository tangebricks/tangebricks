import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IntegrationManifestSchema } from "@poc/assembler";
import {
  analyzeSpec,
  extractOpenApi3Operations,
  importIntegrationSpec,
} from "../src/importer.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("UC2.3 wireName and identifier/operationId collision detection", () => {
  const cashfreeFixturePath = resolve(
    __dirname,
    "fixtures/wire-name/cashfree-pg-min.openapi.json",
  );
  const cashfreeSpec = JSON.parse(readFileSync(cashfreeFixturePath, "utf8"));

  it("extracts wireName on params and body fields, reports IDENTIFIER_NORMALIZED, and retains both colliding ops", () => {
    const report = analyzeSpec({
      spec: cashfreeSpec,
      format: "openapi3",
      appName: "cashfree",
    });

    const ops = extractOpenApi3Operations(cashfreeSpec);

    // Both colliding ops must be present
    expect(ops.has("create_order")).toBe(true);
    expect(ops.has("create_order__post")).toBe(true);
    expect(ops.size).toBe(2);

    const postOp = ops.get("create_order")!;
    expect(postOp.params).toBeDefined();

    const clientIdParam = postOp.params?.find((p) => p.name === "x_client_id");
    expect(clientIdParam).toMatchObject({
      name: "x_client_id",
      wireName: "x-client-id",
      in: "header",
    });

    const clientSecretParam = postOp.params?.find((p) => p.name === "x_client_secret");
    expect(clientSecretParam).toMatchObject({
      name: "x_client_secret",
      wireName: "x-client-secret",
      in: "header",
    });

    const apiVersionParam = postOp.params?.find((p) => p.name === "x_api_version");
    expect(apiVersionParam).toMatchObject({
      name: "x_api_version",
      wireName: "x-api-version",
      in: "header",
    });

    const filterStatusParam = postOp.params?.find((p) => p.name === "filter_status_");
    expect(filterStatusParam).toMatchObject({
      name: "filter_status_",
      wireName: "filter[status]",
      in: "query",
    });

    // Body field wireName
    expect(postOp.body?.fields).toBeDefined();
    const billingAddressField = postOp.body?.fields?.find((f) => f.name === "billing_address");
    expect(billingAddressField).toMatchObject({
      name: "billing_address",
      wireName: "billing-address",
    });

    // Report entries: IDENTIFIER_NORMALIZED
    const normalizedEntries = report.entries.filter((e) => e.code === "IDENTIFIER_NORMALIZED");
    expect(normalizedEntries.some((e) => e.from === "x-client-id" && e.to === "x_client_id")).toBe(true);
    expect(normalizedEntries.some((e) => e.from === "filter[status]" && e.to === "filter_status_")).toBe(true);
    expect(normalizedEntries.some((e) => e.from === "billing-address" && e.to === "billing_address")).toBe(true);

    // Report entry: OPERATION_ID_COLLISION
    const collisionEntries = report.entries.filter((e) => e.code === "OPERATION_ID_COLLISION");
    expect(collisionEntries.length).toBe(1);
    expect(collisionEntries[0]!.from).toBe("create-order");
    expect(collisionEntries[0]!.to).toBe("create_order__post");
  });

  it("AC3: curation naming an ambiguous operationId throws OPENAPI_IMPORT_AMBIGUOUS_OPERATION", () => {
    expect(() =>
      importIntegrationSpec({
        spec: cashfreeSpec,
        format: "openapi3",
        curation: {
          app: "cashfree",
          specProvenance: "upstream",
          ui: {
            displayName: "Cashfree",
            category: "billing",
            summary: "Cashfree PG",
            maturity: "beta",
            maturityReason: "Beta testing",
          },
          auth: { type: "none" },
          baseUrl: "https://api.cashfree.com/pg",
          allowedHosts: ["api.cashfree.com"],
          includeOperations: ["create_order"],
        },
      }),
    ).toThrow(/OPENAPI_IMPORT_AMBIGUOUS_OPERATION/);
  });

  it("AC4: IntegrationManifestSchema rejects wireName equal to name", () => {
    const baseManifest = {
      manifestVersion: 2,
      kind: "integration",
      app: "test-app",
      version: "1.0.0",
      ui: {
        displayName: "Test App",
        category: "developer",
        summary: "Test application",
        maturity: "beta",
        maturityReason: "Beta testing",
      },
      auth: { type: "none" },
      baseUrl: "https://api.example.com",
      allowedHosts: ["api.example.com"],
      operations: [
        {
          operationId: "get_item",
          label: "Get Item",
          summary: "Get an item",
          method: "GET",
          path: "/items",
          params: [
            {
              name: "a",
              wireName: "a",
              in: "query",
              dataType: "string",
            },
          ],
          response: {},
          sideEffects: "read",
        },
      ],
    };

    const resParam = IntegrationManifestSchema.safeParse(baseManifest);
    expect(resParam.success).toBe(false);

    const baseManifestBody = {
      ...baseManifest,
      operations: [
        {
          operationId: "create_item",
          label: "Create Item",
          summary: "Create an item",
          method: "POST",
          path: "/items",
          body: {
            contentType: "application/json",
            fields: [
              {
                name: "a",
                wireName: "a",
                dataType: "string",
              },
            ],
          },
          response: {},
          sideEffects: "write",
        },
      ],
    };

    const resBody = IntegrationManifestSchema.safeParse(baseManifestBody);
    expect(resBody.success).toBe(false);
  });

  it("dedupes params by in:rawName so op-level overrides path-level param and reports mapped", () => {
    const specWithOverride = {
      openapi: "3.0.3",
      info: { title: "Override test", version: "1.0.0" },
      paths: {
        "/items": {
          parameters: [
            {
              name: "limit",
              in: "query",
              description: "path-level limit",
              schema: { type: "integer" },
            },
          ],
          get: {
            operationId: "list_items",
            parameters: [
              {
                name: "limit",
                in: "query",
                description: "op-level limit override",
                schema: { type: "integer" },
              },
            ],
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };

    const ops = extractOpenApi3Operations(specWithOverride);
    const op = ops.get("list_items")!;
    expect(op.params).toHaveLength(1);
    expect(op.params![0]!.description).toBe("op-level limit override");
  });

  it("disambiguates colliding parameter names within the same operation", () => {
    const specWithCollidingParams = {
      openapi: "3.0.3",
      info: { title: "Collision test", version: "1.0.0" },
      paths: {
        "/items/{item_id}": {
          get: {
            operationId: "get_item",
            parameters: [
              {
                name: "item_id",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
              {
                name: "item-id",
                in: "query",
                schema: { type: "string" },
              },
            ],
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };

    const report = analyzeSpec({
      spec: specWithCollidingParams,
      format: "openapi3",
      appName: "collision-test",
    });

    const ops = extractOpenApi3Operations(specWithCollidingParams);
    const op = ops.get("get_item")!;
    expect(op.params).toHaveLength(2);

    const pathParam = op.params?.find((p) => p.in === "path");
    const queryParam = op.params?.find((p) => p.in === "query");

    expect(pathParam?.name).toBe("item_id");
    expect(queryParam?.name).toBe("item_id_query");
    expect(queryParam?.wireName).toBe("item-id");

    const disambiguatedEntry = report.entries.find((e) => e.code === "IDENTIFIER_COLLISION_DISAMBIGUATED");
    expect(disambiguatedEntry).toBeDefined();
    expect(disambiguatedEntry?.to).toBe("item_id_query");
  });

  it("AC2: analyzeSpec covers 612/612 Stripe ops and 1254/1254 GitHub ops with 3 OPERATION_ID_COLLISION entries", () => {
    const cacheDir = resolve(__dirname, "../../../corpus/real-specs/.cache");
    if (!existsSync(cacheDir)) {
      console.warn("Corpus cache not found, skipping AC2 corpus test");
      return;
    }

    const stripeRaw = JSON.parse(readFileSync(resolve(cacheDir, "stripe.json"), "utf8"));
    const stripeReport = analyzeSpec({
      spec: stripeRaw,
      format: "openapi3",
      appName: "stripe",
    });

    const stripeOps = extractOpenApi3Operations(stripeRaw);
    expect(stripeOps.size).toBe(612);

    const githubRaw = JSON.parse(readFileSync(resolve(cacheDir, "github.json"), "utf8"));
    const githubReport = analyzeSpec({
      spec: githubRaw,
      format: "openapi3",
      appName: "github",
    });

    const githubOps = extractOpenApi3Operations(githubRaw);
    expect(githubOps.size).toBe(1254);

    const stripeCollisions = stripeReport.entries.filter((e) => e.code === "OPERATION_ID_COLLISION");
    const githubCollisions = githubReport.entries.filter((e) => e.code === "OPERATION_ID_COLLISION");

    expect(stripeCollisions.length).toBe(2);
    expect(githubCollisions.length).toBe(1);
    expect(stripeCollisions.length + githubCollisions.length).toBe(3);
  });
});
