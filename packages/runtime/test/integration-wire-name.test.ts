import { describe, expect, it, vi } from "vitest";
import { IntegrationManifestSchema } from "@poc/assembler";
import type { IntegrationManifestFile } from "@poc/assembler";
import type { ExecutionContext } from "@poc/sdk";
import { createIntegrationOperationExecutor } from "../src/index.ts";

describe("UC2.3 runtime executor wireName handling", () => {
  const cashfreeManifest: IntegrationManifestFile = IntegrationManifestSchema.parse({
    manifestVersion: 2,
    kind: "integration",
    app: "cashfree",
    version: "1.0.0",
    ui: {
      displayName: "Cashfree",
      category: "billing",
      summary: "Cashfree PG integration",
      maturity: "beta",
      maturityReason: "Beta testing",
    },
    auth: {
      type: "none",
    },
    baseUrl: "https://api.cashfree.com/pg",
    allowedHosts: ["api.cashfree.com"],
    operations: [
      {
        operationId: "create_order",
        label: "Create Order",
        summary: "Create an order in Cashfree",
        method: "POST",
        path: "/orders",
        params: [
          {
            name: "x_client_id",
            wireName: "x-client-id",
            in: "header",
            dataType: "string",
            required: true,
          },
          {
            name: "filter_status_",
            wireName: "filter[status]",
            in: "query",
            dataType: "string",
            required: false,
          },
        ],
        body: {
          contentType: "application/json",
          fields: [
            {
              name: "billing_address",
              wireName: "billing-address",
              dataType: "string",
              required: true,
            },
          ],
        },
        response: {},
        sideEffects: "write",
      },
      {
        operationId: "create_order_form",
        label: "Create Order Form",
        summary: "Create an order using form urlencoded",
        method: "POST",
        path: "/orders-form",
        body: {
          contentType: "application/x-www-form-urlencoded",
          fields: [
            {
              name: "billing_address",
              wireName: "billing-address",
              dataType: "string",
              required: true,
            },
          ],
        },
        response: {},
        sideEffects: "write",
      },
    ],
    fidelity: {
      specHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      importerVersion: "2.0.0",
      level: "exact",
      unsupported: [],
    },
  });

  it("AC1: recorded request carries header x-client-id, query filter[status], and JSON key billing-address", async () => {
    let recordedUrl = "";
    let recordedHeaders: Record<string, string> = {};
    let recordedBody = "";

    const fetcher = vi.fn().mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      recordedUrl = String(url);
      if (init?.headers instanceof Headers) {
        recordedHeaders = Object.fromEntries(init.headers.entries());
      } else if (Array.isArray(init?.headers)) {
        recordedHeaders = Object.fromEntries(init.headers);
      } else {
        recordedHeaders = (init?.headers as Record<string, string>) ?? {};
      }
      recordedBody = String(init?.body ?? "");

      return new Response(JSON.stringify({ status: "SUCCESS" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const executor = createIntegrationOperationExecutor(cashfreeManifest, cashfreeManifest.operations[0]!, { fetcher, resolveHost: undefined });

    const ctx: ExecutionContext = {
      workspaceId: "ws_test",
      nodeId: "test_node_cashfree",
      runId: "run_cashfree_test",
      idempotencyKey: "run_cashfree_test:test_node_cashfree",
      data: {},
      inputs: {
        x_client_id: "cf_client_12345",
        filter_status_: "paid",
        billing_address: "123 Market St, Suite 400",
      },
      payload: {},
      secret: () => {
        throw new Error("not configured");
      },
      binding: () => {
        throw new Error("not configured");
      },
      connection: (() => ({})) as ExecutionContext["connection"],
      log: {
        debug: async () => {},
        info: async () => {},
        warn: async () => {},
        error: async () => {},
      },
    };

    const result = await executor(ctx);
    expect(result).toBeDefined();

    // Verify header wireName
    expect(recordedHeaders["x-client-id"]).toBe("cf_client_12345");
    expect(recordedHeaders["x_client_id"]).toBeUndefined();

    // Verify query wireName
    expect(recordedUrl).toContain("filter%5Bstatus%5D=paid");
    expect(recordedUrl).not.toContain("filter_status_");

    // Verify JSON body wireName
    const parsedBody = JSON.parse(recordedBody);
    expect(parsedBody["billing-address"]).toBe("123 Market St, Suite 400");
    expect(parsedBody["billing_address"]).toBeUndefined();
  });

  it("sends form-urlencoded body with wireName key", async () => {
    let recordedBody = "";

    const fetcher = vi.fn().mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      recordedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ status: "SUCCESS" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const executor = createIntegrationOperationExecutor(cashfreeManifest, cashfreeManifest.operations[1]!, { fetcher, resolveHost: undefined });

    const ctx: ExecutionContext = {
      workspaceId: "ws_test",
      nodeId: "test_node_cashfree_form",
      runId: "run_cashfree_test",
      idempotencyKey: "run_cashfree_test:test_node_cashfree_form",
      data: {},
      inputs: {
        billing_address: "123 Market St",
      },
      payload: {},
      secret: () => {
        throw new Error("not configured");
      },
      binding: () => {
        throw new Error("not configured");
      },
      connection: (() => ({})) as ExecutionContext["connection"],
      log: {
        debug: async () => {},
        info: async () => {},
        warn: async () => {},
        error: async () => {},
      },
    };

    await executor(ctx);

    const params = new URLSearchParams(recordedBody);
    expect(params.get("billing-address")).toBe("123 Market St");
    expect(params.get("billing_address")).toBeNull();
  });
});
