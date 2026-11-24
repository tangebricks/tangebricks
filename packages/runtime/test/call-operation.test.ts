import { describe, expect, it } from "vitest";
import { IntegrationManifestSchema } from "@poc/assembler";
import type { IntegrationManifestFile } from "@poc/assembler";
import type { ExecutionContext } from "@poc/sdk";
import {
  callOperation,
  createIntegrationOperationExecutor,
  IntegrationCallError,
} from "../src/index.ts";
import type { CallOperationOptions, IntegrationFetcher } from "../src/index.ts";
import callOperationSource from "../src/call-operation.ts?raw";

const stripeManifest: IntegrationManifestFile = IntegrationManifestSchema.parse({
  manifestVersion: 2,
  kind: "integration",
  app: "stripe",
  version: "1.0.0",
  ui: {
    displayName: "Stripe",
    category: "billing",
    summary: "Stripe billing and payments",
    maturity: "beta",
    maturityReason: "Verified against recorded fixtures",
    behaviourTest: "packages/runtime/test/call-operation.test.ts",
  },
  auth: {
    type: "oauth2",
    headerName: "Authorization",
    prefix: "Bearer",
  },
  baseUrl: "https://api.stripe.com",
  allowedHosts: ["api.stripe.com"],
  operations: [
    {
      operationId: "createCustomer",
      label: "Create Customer",
      summary: "Create a customer object in Stripe",
      method: "POST",
      path: "/v1/customers",
      idempotency: {
        header: "Idempotency-Key",
      },
      body: {
        contentType: "application/x-www-form-urlencoded",
        fields: [
          { name: "email", dataType: "string", required: true },
          { name: "name", dataType: "string", required: false },
        ],
      },
      sideEffects: "write",
    },
    {
      operationId: "getCustomer",
      label: "Get Customer",
      summary: "Retrieve a customer object",
      method: "GET",
      path: "/v1/customers/{id}",
      params: [
        { name: "id", in: "path", dataType: "string", required: true },
      ],
      sideEffects: "read",
    },
  ],
  fidelity: {
    specHash: "sha256:" + "0".repeat(64),
    importerVersion: "1.0.0",
    level: "curated",
    unsupported: [],
  },
});

describe("UC3.1 — Standalone callOperation() with node executor wrapper", () => {
  it("resolves {ok:true, status:200, data, body, headers, pagesFetched:1} and matches node-executor request byte for byte", async () => {
    let capturedCallOpRequest: { url: string; method: string; headers: Record<string, string>; body?: string } | null = null;
    const callOpFetcher: IntegrationFetcher = async (input, init) => {
      capturedCallOpRequest = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      return new Response(JSON.stringify({ id: "cus_123", email: "a@b.c" }), {
        status: 200,
        headers: { "content-type": "application/json", "x-stripe-request-id": "req_123" },
      });
    };

    const options: CallOperationOptions = {
      connection: { accessToken: "sk_test_canary" },
      fetcher: callOpFetcher,
      idempotencyKey: "run_1:node_1",
    };

    const result = await callOperation(stripeManifest, "createCustomer", { email: "a@b.c" }, options);

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ id: "cus_123", email: "a@b.c" });
    expect(result.body).toEqual({ id: "cus_123", email: "a@b.c" });
    expect(result.pagesFetched).toBe(1);
    expect(result.headers["x-stripe-request-id"]).toBe("req_123");
    expect(result.truncated).toBe(false);
    expect(result.nextCursor).toBeNull();

    // Now execute via node executor with the exact same inputs and connection
    let capturedNodeRequest: { url: string; method: string; headers: Record<string, string>; body?: string } | null = null;
    const nodeFetcher: IntegrationFetcher = async (input, init) => {
      capturedNodeRequest = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      return new Response(JSON.stringify({ id: "cus_123", email: "a@b.c" }), {
        status: 200,
        headers: { "content-type": "application/json", "x-stripe-request-id": "req_123" },
      });
    };

    const createCustomerOp = stripeManifest.operations.find((op) => op.operationId === "createCustomer")!;
    const nodeExecutor = createIntegrationOperationExecutor(stripeManifest, createCustomerOp, {
      fetcher: nodeFetcher,
    });

    const fakeCtx = {
      nodeId: "node_1",
      runId: "run_1",
      data: {},
      inputs: { email: "a@b.c" },
      payload: {},
      connection: ((_selector?: unknown) => ({ accessToken: "sk_test_canary" })) as unknown as ExecutionContext["connection"],
      env: {},
    } as unknown as ExecutionContext;

    await nodeExecutor(fakeCtx);

    expect(capturedCallOpRequest).not.toBeNull();
    expect(capturedNodeRequest).not.toBeNull();
    expect(capturedCallOpRequest!.url).toBe(capturedNodeRequest!.url);
    expect(capturedCallOpRequest!.method).toBe(capturedNodeRequest!.method);
    expect(capturedCallOpRequest!.body).toBe(capturedNodeRequest!.body);
    expect(capturedCallOpRequest!.headers).toEqual(capturedNodeRequest!.headers);
  });

  it("AC3: blocking op rejects with INTEGRATION_UNSUPPORTED_FEATURE before any fetch", async () => {
    let fetchCalled = false;
    const fetcher: IntegrationFetcher = async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    };

    const blockingManifest: IntegrationManifestFile = {
      ...stripeManifest,
      operations: [
        ...stripeManifest.operations,
        {
          operationId: "unsupportedOp",
          label: "Unsupported Op",
          method: "POST",
          path: "/v1/unsupported",
          response: {},
          sideEffects: "write",
        },
      ],
      fidelity: {
        specHash: "sha256:" + "0".repeat(64),
        importerVersion: "1.0.0",
        level: "partial",
        unsupported: [
          {
            op: "unsupportedOp",
            code: "UNSUPPORTED_OP_CODE",
            pointer: "#/paths/~1v1~1unsupported/post",
            blocking: true,
          },
        ],
      },
    };

    await expect(
      callOperation(blockingManifest, "unsupportedOp", {}, {
        connection: { accessToken: "sk_test_canary" },
        fetcher,
      }),
    ).rejects.toThrow(/INTEGRATION_UNSUPPORTED_FEATURE/);

    expect(fetchCalled).toBe(false);
  });

  it("unknown op rejects with INTEGRATION_OPERATION_NOT_FOUND", async () => {
    const fetcher: IntegrationFetcher = async () => new Response("{}", { status: 200 });

    await expect(
      callOperation(stripeManifest, "unknownOp", {}, {
        connection: { accessToken: "sk_test_canary" },
        fetcher,
      }),
    ).rejects.toThrow(/INTEGRATION_OPERATION_NOT_FOUND/);
  });

  it("AC4: sends Idempotency-Key only when op declares it AND idempotencyKey option is provided", async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetcher: IntegrationFetcher = async (_input, init) => {
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return new Response(JSON.stringify({ id: "cus_123" }), { status: 200 });
    };

    // 1. Op declares idempotency + key provided => header sent
    await callOperation(
      stripeManifest,
      "createCustomer",
      { email: "a@b.c" },
      {
        connection: { accessToken: "sk_test_canary" },
        fetcher,
        idempotencyKey: "run1:n1",
      },
    );
    expect(capturedHeaders["idempotency-key"]).toBe("run1:n1");

    // 2. Op declares idempotency + NO key provided => header NOT sent
    capturedHeaders = {};
    await callOperation(
      stripeManifest,
      "createCustomer",
      { email: "a@b.c" },
      {
        connection: { accessToken: "sk_test_canary" },
        fetcher,
      },
    );
    expect(capturedHeaders["idempotency-key"]).toBeUndefined();

    // 3. Op does NOT declare idempotency + key provided => header NOT sent
    capturedHeaders = {};
    await callOperation(
      stripeManifest,
      "getCustomer",
      { id: "cus_123" },
      {
        connection: { accessToken: "sk_test_canary" },
        fetcher,
        idempotencyKey: "run1:n1",
      },
    );
    expect(capturedHeaders["idempotency-key"]).toBeUndefined();
  });

  it("AC2: call-operation.ts imports nothing from @poc/sdk ExecutionContext and never reads globalThis.fetch", () => {
    expect(callOperationSource).toBeDefined();
    expect(callOperationSource).not.toMatch(/ExecutionContext/);
    expect(callOperationSource).not.toMatch(/globalThis\.fetch/);
    expect(callOperationSource).not.toMatch(/global\.fetch/);
  });

  it("throws IntegrationCallError which extends Error and retains CODE prefix", async () => {
    const fetcher: IntegrationFetcher = async () => new Response("{}", { status: 200 });

    try {
      await callOperation(stripeManifest, "unknownOp", {}, {
        connection: { accessToken: "sk_test_canary" },
        fetcher,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(IntegrationCallError);
      expect((err as IntegrationCallError).code).toBe("INTEGRATION_OPERATION_NOT_FOUND");
      expect((err as Error).message).toMatch(/^INTEGRATION_OPERATION_NOT_FOUND:/);
    }
  });
});
