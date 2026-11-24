import { afterEach, describe, expect, it } from "vitest";
import { catalog } from "@poc/assembler/catalog";
import { buildExecutorsFromCatalog, buildRegistryFromCatalog, runGraph } from "@poc/runtime";
import { EgressForbiddenError, type ExecutionContext } from "@poc/sdk";
import { executeHttpRequestNode } from "../src/index.ts";

const originalFetch = globalThis.fetch;

function ctxFor(data: Record<string, unknown>): ExecutionContext {
  return { workspaceId: "ws_test",
    nodeId: "n_http",
    runId: "run_ssrf",
    idempotencyKey: "idem_ssrf",
    data,
    inputs: {},
    payload: null,
    secret: (name: string) => {
      throw new Error(`undeclared secret ${name}`);
    },
    binding: <T,>(name: string): T => {
      throw new Error(`undeclared binding ${name}`);
    },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("core.http_request live path SSRF guard", () => {
  it("executor refuses internal-address URLs with EGRESS_FORBIDDEN without fetching", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      return new Response("internal", { status: 200 });
    }) as typeof fetch;

    for (const url of [
      "http://127.0.0.1/admin",
      "http://10.0.0.5/",
      "http://[::1]/",
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost/",
      "http://metadata.google.internal/",
      "https://user:pass@example.com/",
    ]) {
      const err = await Promise.resolve(executeHttpRequestNode(ctxFor({ liveFetch: true, method: "get", url }))).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, url).toBeInstanceOf(EgressForbiddenError);
      expect((err as EgressForbiddenError).code).toBe("EGRESS_FORBIDDEN");
    }
    expect(calls).toHaveLength(0);
  });

  it("a run whose core.http_request targets the metadata address is recorded failed with the guard code", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response("metadata", { status: 200 });
    }) as typeof fetch;
    const result = await runGraph(
      {
        nodes: [
          { id: "hook", type: "core.webhook", data: {} },
          {
            id: "http",
            type: "core.http_request",
            data: { url: "http://169.254.169.254/latest/meta-data/", method: "get", liveFetch: true },
          },
        ],
        edges: [{ id: "e1", source: "hook", sourceHandle: "out", target: "http", targetHandle: "in" }],
      },
      buildRegistryFromCatalog(catalog),
      buildExecutorsFromCatalog(catalog),
      { workspaceId: "ws_test", payload: {} },
    );
    expect(result.ok).toBe(false);
    expect(result.failed.http).toMatch(/EGRESS_FORBIDDEN/);
    expect(calls).toHaveLength(0);
  });

  it("only the exact port-less http://fixture.local host bypasses the guard", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response("x", { status: 200 });
    }) as typeof fetch;
    const err = await Promise.resolve(
      executeHttpRequestNode(ctxFor({ liveFetch: true, method: "get", url: "http://fixture.local:8080/x" })),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EgressForbiddenError);
    expect(calls).toHaveLength(0);
  });

  it("does not follow redirects from the fixture host", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } })) as typeof fetch;
    await expect(executeHttpRequestNode(ctxFor({ method: "get", url: "http://fixture.local/x" }))).rejects.toThrow(
      /redirects from the fixture host/,
    );
  });

  it("does not treat look-alike hosts as the fixture host", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response("x", { status: 200 });
    }) as typeof fetch;
    // Not the fixture host and live fetch off: nothing is sent and no 200 is fabricated (story 0.9).
    await expect(executeHttpRequestNode(ctxFor({ url: "http://fixture.local.attacker.example/x" }))).rejects.toThrow(
      /^NOT_CONFIGURED: core\.http_request/,
    );
    expect(calls).toHaveLength(0);
  });

  it("with live fetch off and no fixture injected, the step fails NOT_CONFIGURED instead of a fabricated 200 (story 0.9)", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response("x", { status: 200 });
    }) as typeof fetch;
    const result = await runGraph(
      {
        nodes: [
          { id: "hook", type: "core.webhook", data: {} },
          { id: "http", type: "core.http_request", data: { url: "https://api.example.com/hook", method: "post" } },
        ],
        edges: [{ id: "e1", source: "hook", sourceHandle: "out", target: "http", targetHandle: "in" }],
      },
      buildRegistryFromCatalog(catalog),
      buildExecutorsFromCatalog(catalog),
      { workspaceId: "ws_test", payload: {} },
    );
    expect(result.ok).toBe(false);
    expect(result.outputs.http).toBeUndefined();
    expect(result.failed.http).toMatch(/^NOT_CONFIGURED: core\.http_request/);
    expect(calls).toHaveLength(0);
  });
});
