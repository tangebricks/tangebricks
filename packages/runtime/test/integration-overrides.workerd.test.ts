import { describe, expect, it, vi } from "vitest";
import { catalog } from "@poc/assembler/catalog";
import type { ExecutionContext } from "@poc/sdk";
import { buildExecutorsFromCatalog, executeIntegrationOperation } from "../src/index.ts";

function createDummyContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    workspaceId: "ws_test",
    nodeId: "node_1",
    runId: "run_dummy",
    idempotencyKey: "run_dummy:node_1",
    data: {},
    inputs: {},
    payload: {},
    secret: () => "mock-secret",
    binding: () => {
      throw new Error("No bindings in test");
    },
    connection: (() => ({
      token: "ghp_mock_token_1234567890",
    })) as any,
    ...overrides,
  };
}

describe("F-SEC-1 — Integration runtime security overrides", () => {
  it("rejects registered int:github.* execution when ctx.data contains __fetcher, __manifest, and __pathOverride", async () => {
    const executors = buildExecutorsFromCatalog(catalog);
    const githubExecutor = executors.get("int:github.getRepo");
    expect(githubExecutor).toBeDefined();

    const spyFetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 1, name: "evil-repo" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const ctx = createDummyContext({
      data: {
        __fetcher: spyFetcher,
        __manifest: {
          app: "evil",
          baseUrl: "https://evil.example",
          allowedHosts: ["evil.example"],
          operations: [
            {
              operationId: "evilOp",
              method: "GET",
              path: "/evil",
            },
          ],
        },
        __pathOverride: "/../admin",
        owner: "octocat",
        repo: "hello-world",
      },
    });

    await expect(githubExecutor!(ctx)).rejects.toThrow(/INTEGRATION_RESERVED_DATA_KEY/);
    expect(spyFetcher).not.toHaveBeenCalled();
  });

  it("AC2: fails node with INTEGRATION_RESERVED_DATA_KEY when __ key is present in ctx.data", async () => {
    const executors = buildExecutorsFromCatalog(catalog);
    const githubExecutor = executors.get("int:github.getRepo");
    expect(githubExecutor).toBeDefined();

    const spyFetcher = vi.fn();
    const ctx = createDummyContext({
      data: {
        __fetcher: spyFetcher,
        owner: "octocat",
        repo: "hello-world",
      },
    });

    await expect(githubExecutor!(ctx)).rejects.toThrow("INTEGRATION_RESERVED_DATA_KEY: __fetcher");
    expect(spyFetcher).not.toHaveBeenCalled();
  });

  it("AC2: fails node with INTEGRATION_RESERVED_DATA_KEY when __ key is present in ctx.inputs", async () => {
    const executors = buildExecutorsFromCatalog(catalog);
    const githubExecutor = executors.get("int:github.getRepo");
    expect(githubExecutor).toBeDefined();

    const spyFetcher = vi.fn();
    const ctx = createDummyContext({
      data: {
        owner: "octocat",
        repo: "hello-world",
      },
      inputs: {
        __pathOverride: "/admin",
      },
    });

    await expect(githubExecutor!(ctx)).rejects.toThrow("INTEGRATION_RESERVED_DATA_KEY: __pathOverride");
    expect(spyFetcher).not.toHaveBeenCalled();
  });

  it("AC2: fails node with INTEGRATION_RESERVED_DATA_KEY when __ key is present in ctx.payload", async () => {
    const executors = buildExecutorsFromCatalog(catalog);
    const githubExecutor = executors.get("int:github.getRepo");
    expect(githubExecutor).toBeDefined();

    const ctx = createDummyContext({
      data: {
        owner: "octocat",
        repo: "hello-world",
      },
      payload: {
        __injectedPayloadKey: "malicious",
      },
    });

    await expect(githubExecutor!(ctx)).rejects.toThrow("INTEGRATION_RESERVED_DATA_KEY: __injectedPayloadKey");
  });

  it("fails executeIntegrationOperation when __manifest or __operation is supplied in data", async () => {
    const ctx = createDummyContext({
      data: {
        __manifest: {
          app: "evil",
          baseUrl: "https://evil.example",
          allowedHosts: ["evil.example"],
        },
        __operation: {
          operationId: "evilOp",
          method: "GET",
          path: "/evil",
        },
      },
    });

    await expect(executeIntegrationOperation(ctx)).rejects.toThrow(/INTEGRATION_RESERVED_DATA_KEY/);
  });
});
