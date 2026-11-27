import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import type { WalletEnv } from "@poc/credit-wallet";
import { assemble } from "@poc/assembler";
import { catalog } from "@poc/assembler/catalog";
import { buildRegistryFromCatalog, isNotConfiguredExecutor, isPlaceholderExecutor, runGraph } from "@poc/runtime";
import { computeMaxCompatible } from "../../../scripts/max-compatible.ts";
import * as creditWallet from "@poc/credit-wallet";
import agentSandboxSource from "../../../bricks/agent-sandbox/src/agent.ts?raw";
import { createWalletRoutes } from "@poc/credit-wallet";
import { defaultStudioRuntimeExecutors, studioExecutorsFor } from "../src/index.ts";
import { placeholderExecutors } from "./placeholder-executors.ts";

/**
 * Story 0.9 BUILD_MODE: compose what ships by default (studio-api's runtime executors and the assembled
 * max-compatible app) and check that no placeholder executor or mock adapter is wired as a default.
 * Fakes stay available only to tests that inject them.
 */

const brickNodeTypes = Object.values(catalog.bricks ?? {}).flatMap((b) => (b.manifest.nodes ?? []).map((n) => n.type));

describe("BUILD_MODE: studio-api default runtime executors", () => {
  test("no brick action node is wired to a placeholder executor", () => {
    expect(brickNodeTypes.length).toBeGreaterThan(0);
    const placeholders = brickNodeTypes.filter((type) => isPlaceholderExecutor(defaultStudioRuntimeExecutors.get(type)));
    expect(placeholders).toEqual([]);
    for (const type of [
      "credit-wallet.debit",
      "credit-wallet.credit",
      "omnichannel-outbound.send_message",
      "in-app-notifications.send",
      "scripting-sandbox.run_script",
    ]) {
      expect(isNotConfiguredExecutor(defaultStudioRuntimeExecutors.get(type)), type).toBe(true);
    }
  });

  test("PLACEHOLDER_DEFAULT: a brick action run with the defaults fails NOT_CONFIGURED; HTTP_NODE_DEFAULT: no fabricated 200", async () => {
    const result = await runGraph(
      {
        nodes: [
          { id: "trig", type: "trigger.manual", data: {} },
          { id: "debit", type: "credit-wallet.debit", data: { amount: 20 } },
          { id: "http", type: "core.http_request", data: { url: "https://api.example.com/hook", method: "post" } },
        ],
        edges: [
          { id: "e1", source: "trig", sourceHandle: "out", target: "debit", targetHandle: "in" },
          { id: "e2", source: "trig", sourceHandle: "out", target: "http", targetHandle: "in" },
        ],
      },
      buildRegistryFromCatalog(catalog),
      defaultStudioRuntimeExecutors,
      { workspaceId: "ws_test", payload: { balance: 120, workspaceId: "ws_build_mode" } },
    );
    expect(result.ok).toBe(false);
    expect(result.outputs.debit).toBeUndefined();
    expect(result.outputs.http).toBeUndefined();
    expect(result.failed.debit).toMatch(/^NOT_CONFIGURED: credit-wallet\.debit/);
    expect(result.failed.http).toMatch(/^NOT_CONFIGURED: core\.http_request/);
  });
});

describe("BUILD_MODE: the assembled max-compatible app", () => {
  const max = computeMaxCompatible(catalog);
  const assembled = assemble({ project: max.project, bricks: max.bricks }, catalog);
  if (!assembled.ok) throw new Error(assembled.errors.join("; "));
  const sources = Object.entries(assembled.files).filter(([path]) => path.endsWith(".ts"));
  const entry = assembled.files["src/index.ts"] ?? "";

  test("wires no mock adapter, fake gateway or placeholder executor", () => {
    const found: string[] = [];
    for (const [path, text] of sources) {
      for (const m of text.matchAll(/\b\w*(?:Mock|Fake|Placeholder|PLACEHOLDER)\w*\b/g)) found.push(`${path}: ${m[0]}`);
    }
    expect(found).toEqual([]);
  });

  test("the LLM and outbound routes are mounted with no adapter, so they answer NOT_CONFIGURED rather than mock output", () => {
    const ai = entry.match(/createAiRoutes\(([^)]*)\)/);
    expect(ai, "llm-gateway is in max-compatible").not.toBeNull();
    expect(ai![1]).not.toMatch(/adapters/);
    const outbound = entry.match(/createMessageRoutes\(([^)]*)\)/);
    expect(outbound, "omnichannel-outbound is in max-compatible").not.toBeNull();
    expect(outbound![1]).not.toMatch(/adapter/);
  });

  test("the wallet routes are mounted with no payment gateway (payment routes answer 503 NOT_CONFIGURED)", () => {
    const wallet = entry.match(/createWalletRoutes\(([^)]*)\)/);
    expect(wallet, "credit-wallet is in max-compatible").not.toBeNull();
    expect(wallet![1]).not.toMatch(/gateway/);
  });

  test("no executor falls back to a silent success", () => {
    for (const [path, text] of sources) expect(text, path).not.toContain("async () => ({})");
  });
});

describe("BUILD_MODE: brick package executors an isolated brick worker would wire", () => {
  test("credit-wallet: debit is the D1-backed deduction and credit fails NOT_CONFIGURED (no arithmetic fake)", async () => {
    // Debit delegates to the D1-backed deduction: with no DB binding it fails on the binding, not with a made-up balance.
    await expect(
      creditWallet.executeWalletDebit({
        nodeId: "cw",
        workspaceId: "ws_a",
        data: { amount: 5 },
        inputs: { in: { workspaceId: "ws_a", userId: "usr_a", balance: 100 } },
        binding: () => {
          throw new Error("binding DB not provided");
        },
      } as never),
    ).rejects.toThrow(/binding DB not provided/);
    await expect(creditWallet.executeWalletCredit({ nodeId: "cw", data: { amount: 5 }, inputs: { in: { balance: 0 } } } as never)).rejects.toThrow(
      /^NOT_CONFIGURED: credit-wallet\.credit/,
    );
  });

  test("agent-sandbox: a non-built-in tool is not reported as executed", () => {
    // Behaviour is covered in bricks/agent-sandbox/test/agent.test.ts; here the shipped source has no echo fallback.
    expect(agentSandboxSource).not.toContain("executed: true");
    expect(agentSandboxSource).toContain("NOT_CONFIGURED: no handler is configured for");
  });
});

describe("BUILD_MODE: production refusals", () => {
  test("studio-api refuses placeholder executors (default or injected) when PX_ENVIRONMENT is production", () => {
    expect(() => studioExecutorsFor(placeholderExecutors, { PX_ENVIRONMENT: "production" })).toThrow(/^NOT_CONFIGURED: placeholder executor/);
    expect(studioExecutorsFor(placeholderExecutors, { PX_ENVIRONMENT: "preview" })).toBe(placeholderExecutors);
    expect(() => studioExecutorsFor(undefined, { PX_ENVIRONMENT: "production" })).not.toThrow();
  });

  test("the wallet payment routes answer 503 NOT_CONFIGURED with no gateway", async () => {
    const routes = createWalletRoutes({});
    const app = new Hono<WalletEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { uid: "usr_a" });
      c.set("workspace", { id: "ws_a", role: "owner", suspended: false });
      c.set("ctx", Object.freeze({ userId: "usr_a", workspaceId: "ws_a", role: "owner" }));
      await next();
    });
    app.route("/api", routes);
    for (const [path, body] of [
      ["/api/payments/create-order", { amount: 100 }],
      ["/api/payments/verify", { order_id: "order_x" }],
    ] as const) {
      const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, { DB: {} });
      expect(res.status, path).toBe(503);
      expect(((await res.json()) as { code: string }).code).toBe("NOT_CONFIGURED");
    }
  });
});
