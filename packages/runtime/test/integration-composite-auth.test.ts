import { describe, expect, it } from "vitest";
import { IntegrationManifestSchema } from "@poc/assembler";
import type { IntegrationManifestFile } from "@poc/assembler";
import {
  callOperation,
  IntegrationCallError,
} from "../src/index.ts";

const compositeAuthManifest: IntegrationManifestFile = IntegrationManifestSchema.parse({
  manifestVersion: 2,
  kind: "integration",
  app: "cashfree",
  version: "1.0.0",
  ui: {
    displayName: "Cashfree",
    category: "billing",
    summary: "Cashfree PG integration",
    maturity: "beta",
    maturityReason: "Composite auth test",
    behaviourTest: "packages/runtime/test/integration-composite-auth.test.ts",
  },
  auth: {
    type: "headers",
    headers: {
      "x-client-id": "{{conn.clientId}}",
      "x-client-secret": "{{conn.clientSecret}}",
      "x-api-version": "2023-08-01",
    },
  },
  defaultHeaders: {
    "x-platform-source": "projectx",
  },
  baseUrl: "https://sandbox.cashfree.com/pg",
  allowedHosts: ["sandbox.cashfree.com"],
  operations: [
    {
      operationId: "createOrder",
      label: "Create Order",
      method: "POST",
      path: "/orders",
      params: [],
      body: {
        contentType: "application/json",
        fields: [{ name: "order_id", dataType: "string", required: true }],
      },
      response: {},
      sideEffects: "write",
    },
    {
      operationId: "publicPing",
      label: "Public Ping",
      method: "GET",
      path: "/ping",
      security: [],
      params: [],
      response: {},
      sideEffects: "none",
    },
    {
      operationId: "conflictingOp",
      label: "Conflicting Op",
      method: "GET",
      path: "/conflict",
      params: [
        {
          name: "clientId",
          wireName: "x-client-id",
          in: "header",
          dataType: "string",
          required: false,
        },
      ],
      response: {},
      sideEffects: "none",
    },
  ],
  fidelity: {
    specHash: "sha256:" + "0".repeat(64),
    importerVersion: "2.0.0",
    level: "exact",
    unsupported: [],
  },
});

describe("Story UC3.3 — Composite header auth, static default headers, and public op handling", () => {
  it("renders multi-header composite auth and static default headers, and keeps canaries absent from outputs", async () => {
    let capturedHeaders: Record<string, string> = {};
    const recordedFetcher = async (_url: unknown, init?: RequestInit) => {
      const h = init?.headers;
      if (h instanceof Headers) {
        capturedHeaders = Object.fromEntries(h.entries());
      } else if (Array.isArray(h)) {
        capturedHeaders = Object.fromEntries(h);
      } else if (h && typeof h === "object") {
        capturedHeaders = Object.fromEntries(
          Object.entries(h as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
        );
      }
      return new Response(JSON.stringify({ ok: true, order_id: "ord_123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const res = await callOperation(
      compositeAuthManifest,
      "createOrder",
      { order_id: "ord_123" },
      {
        connection: {
          clientId: "cf_id_canary",
          clientSecret: "cf_secret_canary",
        },
        fetcher: recordedFetcher,
      },
    );

    // Verify fetcher sees all three composite auth headers plus default header
    expect(capturedHeaders["x-client-id"]).toBe("cf_id_canary");
    expect(capturedHeaders["x-client-secret"]).toBe("cf_secret_canary");
    expect(capturedHeaders["x-api-version"]).toBe("2023-08-01");
    expect(capturedHeaders["x-platform-source"]).toBe("projectx");

    // Both canaries must be absent from outputs and serialized response
    const outputString = JSON.stringify(res);
    expect(outputString.includes("cf_id_canary")).toBe(false);
    expect(outputString.includes("cf_secret_canary")).toBe(false);
  });

  it("rejects INTEGRATION_CONNECTION_INCOMPLETE when a required conn placeholder is missing", async () => {
    const fetcher = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    await expect(
      callOperation(
        compositeAuthManifest,
        "createOrder",
        { order_id: "ord_123" },
        {
          connection: {
            clientId: "cf_id_canary",
            // clientSecret omitted
          },
          fetcher,
        },
      ),
    ).rejects.toThrow("INTEGRATION_CONNECTION_INCOMPLETE: missing conn.clientSecret");
  });

  it("skips auth headers entirely for ops with security: []", async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetcher = async (_url: unknown, init?: RequestInit) => {
      const h = init?.headers;
      if (h instanceof Headers) {
        capturedHeaders = Object.fromEntries(h.entries());
      } else if (Array.isArray(h)) {
        capturedHeaders = Object.fromEntries(h);
      } else if (h && typeof h === "object") {
        capturedHeaders = Object.fromEntries(
          Object.entries(h as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
        );
      }
      return new Response(JSON.stringify({ pong: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    // Even with a connection passed, security: [] op must send 0 auth headers
    await callOperation(
      compositeAuthManifest,
      "publicPing",
      {},
      {
        connection: {
          clientId: "cf_id_canary",
          clientSecret: "cf_secret_canary",
        },
        fetcher,
      },
    );

    expect(capturedHeaders["x-client-id"]).toBeUndefined();
    expect(capturedHeaders["x-client-secret"]).toBeUndefined();
    expect(capturedHeaders["authorization"]).toBeUndefined();
    // Default headers are still applied
    expect(capturedHeaders["x-platform-source"]).toBe("projectx");

    // Also works when connection is omitted
    await callOperation(
      compositeAuthManifest,
      "publicPing",
      {},
      {
        connection: null,
        fetcher,
      },
    );
  });

  it("rejects INTEGRATION_HEADER_CONFLICT when a param header collides with an auth header", async () => {
    let fetchCalled = false;
    const fetcher = async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      callOperation(
        compositeAuthManifest,
        "conflictingOp",
        { clientId: "attacker-override-id" },
        {
          connection: {
            clientId: "cf_id_canary",
            clientSecret: "cf_secret_canary",
          },
          fetcher,
        },
      ),
    ).rejects.toThrow("INTEGRATION_HEADER_CONFLICT");

    expect(fetchCalled).toBe(false);
  });
});
