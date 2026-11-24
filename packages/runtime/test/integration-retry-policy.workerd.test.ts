import { describe, expect, it, vi } from "vitest";
import type { IntegrationManifestFile } from "@poc/assembler";
import type { ExecutionContext } from "@poc/sdk";
import { createIntegrationOperationExecutor } from "../src/index.ts";

describe("UC1.4 / F-SEC-3: Integration Retry Policy", () => {
  const manifest: IntegrationManifestFile = {
    manifestVersion: 2,
    kind: "integration",
    app: "payment_service",
    version: "1.0.0",
    ui: {
      displayName: "Payment Service",
      category: "developer",
      summary: "Payment service for testing retry policy",
      maturity: "production",
    },
    auth: {
      type: "apiKey",
      headerName: "Authorization",
    },
    baseUrl: "https://api.payment.example.com",
    allowedHosts: ["api.payment.example.com"],
    operations: [
      {
        operationId: "create_charge",
        label: "Create Charge",
        method: "POST",
        path: "/v1/charges",
        sideEffects: "write",
        body: {
          contentType: "application/json",
          fields: [{ name: "amount", required: true, dataType: "number" }],
        },
        response: { dataPath: "data" },
      },
      {
        operationId: "get_charge",
        label: "Get Charge",
        method: "GET",
        path: "/v1/charges/:chargeId",
        params: [{ name: "chargeId", in: "path", required: true, dataType: "string" }],
        sideEffects: "read",
        response: { dataPath: "data" },
      },
      {
        operationId: "create_charge_idempotent",
        label: "Create Charge Idempotent",
        method: "POST",
        path: "/v1/charges_idempotent",
        sideEffects: "write",
        idempotency: {
          header: "Idempotency-Key",
        },
        body: {
          contentType: "application/json",
          fields: [{ name: "amount", required: true, dataType: "number" }],
        },
        response: { dataPath: "data" },
      },
    ],
    fidelity: {
      specHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      importerVersion: "2.0.0",
      level: "exact",
      unsupported: [],
    },
  };

  const createContext = (overrides?: Partial<ExecutionContext>): ExecutionContext => ({ workspaceId: "ws_test",
    nodeId: "test_retry_node",
    runId: "run_retry_test",
    idempotencyKey: "run_retry_test:test_retry_node",
    data: {},
    inputs: {},
    payload: {},
    secret: () => {
      throw new Error("not configured");
    },
    binding: () => {
      throw new Error("not configured");
    },
    connection: ((_name: unknown) => ({
      accessToken: "canary_payment_token",
    })) as ExecutionContext["connection"],
    ...overrides,
  });

  it("F-SEC-3 (a): non-idempotent write op makes exactly 1 fetch call on 503 and throws INTEGRATION_HTTP_ERROR with retryable: false (AC1)", async () => {
    const fetcher = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ error: "Service Unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    });
    const sleepSpy = vi.fn();
    const executor = createIntegrationOperationExecutor(
      manifest,
      manifest.operations[0]!,
      { fetcher, sleep: sleepSpy },
    );
    let thrownError: any;
    try {
      await executor(createContext({ inputs: { amount: 100 } }));
    } catch (err) {
      thrownError = err;
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
    expect(thrownError).toBeDefined();
    expect(thrownError.message).toContain("INTEGRATION_HTTP_ERROR");
    expect(thrownError.message).toContain("503");
    expect(thrownError.status).toBe(503);
    expect(thrownError.retryable).toBe(false);
  });

  it("F-SEC-3 (b): GET op with Retry-After in delta seconds honours Retry-After: 2 -> sleep(2000) (AC3)", async () => {
    let attempt = 0;
    const fetcher = vi.fn().mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        return new Response(JSON.stringify({ error: "Rate limited" }), {
          status: 429,
          headers: { "Retry-After": "2", "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: { id: "ch_123" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const sleepSpy = vi.fn().mockResolvedValue(undefined);
    const executor = createIntegrationOperationExecutor(
      manifest,
      manifest.operations[1]!,
      { fetcher, sleep: sleepSpy },
    );
    const result = await executor(createContext({ inputs: { chargeId: "ch_123" } }));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(sleepSpy).toHaveBeenCalledWith(2000);
    expect(result).toBeDefined();
  });

  it("F-SEC-3 (c): GET op with Retry-After in IMF-fixdate HTTP-date form 3s ahead sleeps ~3000ms (AC3)", async () => {
    const fixedNow = 1700000000000;
    const targetDate = new Date(fixedNow + 3000).toUTCString();
    let attempt = 0;
    const fetcher = vi.fn().mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        return new Response(JSON.stringify({ error: "Rate limited" }), {
          status: 429,
          headers: { "Retry-After": targetDate, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: { id: "ch_123" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const sleepSpy = vi.fn().mockResolvedValue(undefined);
    const executor = createIntegrationOperationExecutor(
      manifest,
      manifest.operations[1]!,
      { fetcher, sleep: sleepSpy, now: () => fixedNow },
    );
    await executor(createContext({ inputs: { chargeId: "ch_123" } }));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    const sleptMs = sleepSpy.mock.calls[0]![0];
    expect(sleptMs).toBeGreaterThanOrEqual(2000);
    expect(sleptMs).toBeLessThanOrEqual(4000);
    expect(Math.abs(sleptMs - 3000)).toBeLessThanOrEqual(1000);
  });

  it("F-SEC-3 (d): GET op with epoch x-ratelimit-reset (now+4) sleeps ~4000ms instead of clamping 4e9 to 50ms (AC3)", async () => {
    const fixedNowMs = 1700000000000;
    const epochNowSec = 1700000000;
    const resetEpochSec = epochNowSec + 4;
    let attempt = 0;
    const fetcher = vi.fn().mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        return new Response(JSON.stringify({ error: "Rate limited" }), {
          status: 429,
          headers: {
            "x-ratelimit-reset": String(resetEpochSec),
            "Content-Type": "application/json",
          },
        });
      }
      return new Response(JSON.stringify({ data: { id: "ch_123" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const sleepSpy = vi.fn().mockResolvedValue(undefined);
    const executor = createIntegrationOperationExecutor(
      manifest,
      manifest.operations[1]!,
      { fetcher, sleep: sleepSpy, now: () => fixedNowMs },
    );
    await executor(createContext({ inputs: { chargeId: "ch_123" } }));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    const sleptMs = sleepSpy.mock.calls[0]![0];
    expect(Math.abs(sleptMs - 4000)).toBeLessThanOrEqual(1000);
  });

  it("F-SEC-3 (e): delay above ceiling fails fast with RATE_LIMITED and retryAfterMs: 600000 without sleeping (AC3)", async () => {
    const fetcher = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ error: "Rate limited" }), {
        status: 429,
        headers: {
          "Retry-After": "600",
          "Content-Type": "application/json",
        },
      });
    });
    const sleepSpy = vi.fn().mockResolvedValue(undefined);
    const executor = createIntegrationOperationExecutor(
      manifest,
      manifest.operations[1]!,
      { fetcher, sleep: sleepSpy, maxSleepMs: 30000 },
    );
    let thrownError: any;
    try {
      await executor(createContext({ inputs: { chargeId: "ch_123" } }));
    } catch (err) {
      thrownError = err;
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
    expect(thrownError).toBeDefined();
    expect(thrownError.message).toContain("RATE_LIMITED");
    expect(thrownError.retryAfterMs).toBe(600000);
    expect(thrownError.retryable).toBe(false);
  });

  it("F-SEC-3 (f): declared-idempotent write is retried and sends identical Idempotency-Key on every attempt (AC2)", async () => {
    const capturedHeaders: Headers[] = [];
    let attempt = 0;
    const fetcher = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      attempt += 1;
      capturedHeaders.push(new Headers(init?.headers));
      if (attempt === 1) {
        return new Response(JSON.stringify({ error: "Service Unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: { id: "ch_idemp_1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const sleepSpy = vi.fn().mockResolvedValue(undefined);
    const executor = createIntegrationOperationExecutor(
      manifest,
      manifest.operations[2]!,
      { fetcher, sleep: sleepSpy },
    );
    const result = await executor(createContext({ inputs: { amount: 500 } }));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(capturedHeaders).toHaveLength(2);
    const key1 = capturedHeaders[0]?.get("Idempotency-Key");
    const key2 = capturedHeaders[1]?.get("Idempotency-Key");
    expect(key1).toBeDefined();
    expect(key1).not.toBeNull();
    expect(key1!.length).toBeGreaterThan(0);
    expect(key2).toBe(key1);
    expect(result).toBeDefined();
  });

  it("AC4: default ceiling without options.maxSleepMs honours multi-second Retry-After and does not clamp to 50ms", async () => {
    let attempt = 0;
    const fetcher = vi.fn().mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        return new Response(JSON.stringify({ error: "Rate limited" }), {
          status: 429,
          headers: { "Retry-After": "5", "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: { id: "ch_123" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const sleepSpy = vi.fn().mockResolvedValue(undefined);
    const executor = createIntegrationOperationExecutor(
      manifest,
      manifest.operations[1]!,
      { fetcher, sleep: sleepSpy },
    );
    await executor(createContext({ inputs: { chargeId: "ch_123" } }));
    expect(sleepSpy).toHaveBeenCalledWith(5000);
  });
});
