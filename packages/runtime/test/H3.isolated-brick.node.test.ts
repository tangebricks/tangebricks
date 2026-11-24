import { describe, expect, test, afterAll } from "vitest";
import { z } from "zod";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { assemble } from "@poc/assembler";
import type { Catalog } from "@poc/assembler";
import { catalog } from "../../assembler/catalog.generated.ts";
import { runGraph, toyExecutors } from "../src/index.ts";
import { createRegistry, toyRegistry, type BrickManifest } from "@poc/sdk";
import { node, wire } from "./graphs.ts";

const requireDeploy = createRequire(join(process.cwd(), "packages/deploy/package.json"));
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(requireDeploy.resolve("miniflare")).href);

describe("H3 untrusted brick isolation (UC6.7)", () => {
  let mf: any;

  afterAll(async () => {
    if (mf) await mf.dispose();
  });

  const fixtureBrickManifest = {
    manifestVersion: 2 as const,
    kind: "brick" as const,
    id: "fixture-isolated",
    version: "1.0.0",
    trust: "untrusted" as const,
    isolation: "dispatch" as const,
    provides: [],
    requires: ["workspace-context"],
    migrations: [],
    routePrefixes: ["isolated"],
    npmDependencies: {},
    settings: {},
    secrets: ["DECLARED_SECRET"],
    bindings: ["DECLARED_BINDING"],
    nodes: [
      {
        type: "fixture.isolated_snoop",
        label: "Isolated Snoop",
        role: "action" as const,
        inputs: [{ id: "in", dataType: "any" }],
        outputs: [{ id: "out", dataType: "any" }],
        config: {},
        secrets: ["DECLARED_SECRET"],
        bindings: ["DECLARED_BINDING"],
        executor: "fixture.isolated_snoop",
        durable: true,
        sideEffects: "none" as const,
      },
    ],
    worker: {
      package: "@fixture/isolated",
      routes: [
        {
          mountAt: "/api/isolated",
          factory: "createIsolatedRoutes",
          guardWith: "workspace-context",
          guardPaths: ["/api/isolated/*"],
          options: {},
        },
      ],
    },
  };

  const fixtureCatalog: Catalog = {
    bricks: {
      ...catalog.bricks,
      "fixture-isolated": {
        manifest: fixtureBrickManifest as any,
        files: {},
      },
    },
  };

  test("AC1 & AC3: untrusted brick runs isolated in separate Worker with only declared env keys", async () => {
    // Step 1: assemble blueprint with untrusted isolated brick
    const blueprint = {
      project: "test-isolated-app",
      bricks: ["multi-workspace", "fixture-isolated"],
    };

    const assembled = assemble(blueprint, fixtureCatalog);
    // On untouched tree, assemble() refuses dispatch with "per-brick isolation is not yet available"
    expect(assembled.ok, assembled.ok ? "" : assembled.errors.join("; ")).toBe(true);
    if (!assembled.ok) return;

    // Verify assembler emitted files for isolated brick
    expect(assembled.files["bricks/fixture-isolated/wrangler.jsonc"]).toBeDefined();
    expect(assembled.files["bricks/fixture-isolated/src/index.ts"]).toBeDefined();
    expect(assembled.files["src/index.ts"]).toContain("BRICK_FIXTURE_ISOLATED");

    // Miniflare multi-worker setup
    const hostSecrets = {
      UNDECLARED_HOST_SECRET: "secret_host_only_token_xyz",
      POC_ACCESS_KEY: "deploy-test-key",
    };

    const brickWorkerScript = `
      import { WorkerEntrypoint, env } from "cloudflare:workers";

      export default class extends WorkerEntrypoint {
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/api/isolated/info") {
            return Response.json({
              ok: true,
              envKeys: Object.keys(env).sort(),
              hasHostSecret: env.UNDECLARED_HOST_SECRET !== undefined,
            });
          }
          return new Response("Not found", { status: 404 });
        }
        async execute(nodeType, snapshot) {
          return {
            ok: true,
            nodeType,
            snapshot,
            keys: Object.keys(this.env).sort(),
            hostSecret: this.env.UNDECLARED_HOST_SECRET,
            declaredSecret: this.env.DECLARED_SECRET,
          };
        }
      }
    `;

    // Host worker proxying to brick behind simulated tenant guard
    const hostWorkerScript = `
      export default {
        async fetch(request, env) {
          const url = new URL(request.url);
          if (url.pathname.startsWith("/api/isolated")) {
            const ws = request.headers.get("x-workspace-id");
            if (!ws || ws === "ws-unauthorized") {
              return new Response("Forbidden: invalid workspace", { status: 403 });
            }
            return env.BRICK_FIXTURE_ISOLATED.fetch(request);
          }
          return new Response("Not found", { status: 404 });
        },
      };
    `;

    mf = new Miniflare(
      convertV4MiniflareOptions({
        workers: [
          {
            name: "host",
            modules: true,
            script: hostWorkerScript,
            compatibilityDate: "2026-10-01",
            bindings: hostSecrets,
            serviceBindings: {
              BRICK_FIXTURE_ISOLATED: "fixture-isolated",
            },
          },
          {
            name: "fixture-isolated",
            modules: true,
            script: brickWorkerScript,
            compatibilityDate: "2026-10-01",
            bindings: {
              DECLARED_SECRET: "brick_secret_value",
              DECLARED_BINDING: "brick_binding_value",
            },
          },
        ],
      }),
    );

    // Test RPC node execution
    const isolatedService = await mf.getWorker("host");
    // AC1: In the isolated brick, Object.keys(env) equals the declared names, and undeclared secret is undefined
    const hostEnv = await mf.getBindings("host");
    const isolatedBinding = hostEnv.BRICK_FIXTURE_ISOLATED as any;
    expect(isolatedBinding).toBeDefined();

    const rpcResult = await isolatedBinding.execute("fixture.isolated_snoop", {
      nodeId: "n1",
      data: {},
      inputs: {},
      payload: {},
    });

    expect(rpcResult.ok).toBe(true);
    expect(rpcResult.keys).toEqual(["DECLARED_BINDING", "DECLARED_SECRET"].sort());
    expect(rpcResult.hostSecret).toBeUndefined();
    expect(rpcResult.declaredSecret).toBe("brick_secret_value");

    // Runtime integration: test runGraph with isolated registry entry
    const registry = createRegistry([
      ...toyRegistry.values(),
      {
        type: "fixture.isolated_snoop",
        category: "action",
        inputs: [{ id: "in", dataType: "any" }],
        outputs: [{ id: "out", dataType: "any" }],
        configSchema: z.object({}),
        secrets: ["DECLARED_SECRET"],
        bindings: ["DECLARED_BINDING"],
        isolation: "dispatch",
        brickId: "fixture-isolated",
      } as any,
    ]);

    const runResult = await runGraph(
      {
        nodes: [node("t", "trigger.manual"), node("n1", "fixture.isolated_snoop")],
        edges: [wire("t", "n1")],
      },
      registry,
      toyExecutors,
      {
        env: {
          BRICK_FIXTURE_ISOLATED: isolatedBinding,
          UNDECLARED_HOST_SECRET: "host_token",
        },
      },
    );

    expect(runResult.ok).toBe(true);
    expect(runResult.outputs.n1).toBeDefined();
    const nodeOut = runResult.outputs.n1 as any;
    expect(nodeOut.keys).toEqual(["DECLARED_BINDING", "DECLARED_SECRET"].sort());
    expect(nodeOut.hostSecret).toBeUndefined();
    expect(nodeOut.declaredSecret).toBe("brick_secret_value");
  });

  test("AC2: host tenant guard runs before proxy, refusing unauthorized requests before forwarding", async () => {
    expect(mf).toBeDefined();
    // 1. Attack / unauthenticated request without workspace header -> 403 by host guard
    const unauthorizedRes = await mf.dispatchFetch("http://host/api/isolated/info");
    expect(unauthorizedRes.status).toBe(403);

    // 2. Cross-tenant attempt with unauthorized workspace -> 403
    const crossTenantRes = await mf.dispatchFetch("http://host/api/isolated/info", {
      headers: { "x-workspace-id": "ws-unauthorized" },
    });
    expect(crossTenantRes.status).toBe(403);

    // 3. Authorized request with valid workspace -> 200 via proxy
    const authorizedRes = await mf.dispatchFetch("http://host/api/isolated/info", {
      headers: { "x-workspace-id": "ws-alice" },
    });
    expect(authorizedRes.status).toBe(200);
    const body = (await authorizedRes.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.envKeys).toEqual(["DECLARED_BINDING", "DECLARED_SECRET"].sort());
    expect(body.hasHostSecret).toBe(false);
  });
});
