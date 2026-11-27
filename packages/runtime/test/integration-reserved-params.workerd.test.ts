import { describe, expect, it, vi } from "vitest";
import type { IntegrationManifestFile } from "@poc/assembler";
import type { ExecutionContext } from "@poc/sdk";
import { createIntegrationOperationExecutor } from "../src/index.ts";

describe("UC1.2 / F-SEC-6: Inputs named url, baseUrl or host are ordinary parameters, never host overrides", () => {
  const manifest: IntegrationManifestFile = {
    manifestVersion: 2,
    kind: "integration",
    app: "webhook_service",
    version: "1.0.0",
    ui: {
      displayName: "Webhook Service",
      category: "developer",
      summary: "Webhook integration with legitimate url and host parameters",
      maturity: "production",
    },
    auth: {
      type: "apiKey",
      headerName: "Authorization",
    },
    baseUrl: "https://api.webhooks.example.com/v1",
    allowedHosts: ["api.webhooks.example.com"],
    operations: [
      {
        operationId: "create_subscription",
        label: "Create Subscription",
        method: "POST",
        path: "/subscriptions",
        params: [
          {
            name: "host",
            in: "query",
            dataType: "string",
            required: false,
          },
        ],
        body: {
          contentType: "application/json",
          fields: [
            { name: "url", dataType: "string", required: true },
            { name: "baseUrl", dataType: "string", required: false },
          ],
        },
        response: {
          dataPath: "data",
        },
        sideEffects: "write",
      },
    ],
    fidelity: {
      specHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      importerVersion: "2.0.0",
      level: "exact",
      unsupported: [],
    },
  };

  const createContext = (inputs: Record<string, unknown>): ExecutionContext => ({
    workspaceId: "ws_test",
    nodeId: "test_reserved_params_node",
    runId: "run_reserved_params_test",
    idempotencyKey: "run_reserved_params_test:test_reserved_params_node",
    data: {},
    inputs,
    payload: {},
    secret: () => {
      throw new Error("not configured");
    },
    binding: () => {
      throw new Error("not configured");
    },
    connection: ((_name: unknown) => ({
      apiKey: "test_key",
    })) as ExecutionContext["connection"],
  });

  it("F-SEC-6 (AC1, AC2): treats url, host, and baseUrl as ordinary parameters and never as host overrides", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;

    const fetcher = vi.fn().mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      capturedInit = init;
      return new Response(JSON.stringify({ data: { id: "sub_123", ok: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const executor = createIntegrationOperationExecutor(manifest, manifest.operations[0]!, { fetcher, resolveHost: undefined });

    const inputs = {
      url: "https://customer.example/hook",
      host: "x",
      baseUrl: "https://custom-base.example/api",
    };

    const result = await executor(createContext(inputs));

    expect(result).toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Target URL must use the manifest's baseUrl and path, plus query param host=x
    expect(capturedUrl).toBeDefined();
    const parsedTarget = new URL(capturedUrl!);
    expect(parsedTarget.origin).toBe("https://api.webhooks.example.com");
    expect(parsedTarget.pathname).toBe("/v1/subscriptions");
    expect(parsedTarget.searchParams.get("host")).toBe("x");

    // Body must contain the legitimate url and baseUrl parameters
    expect(capturedInit).toBeDefined();
    expect(capturedInit?.body).toBeDefined();
    const parsedBody = JSON.parse(String(capturedInit!.body));
    expect(parsedBody).toEqual({
      url: "https://customer.example/hook",
      baseUrl: "https://custom-base.example/api",
    });
  });
});
