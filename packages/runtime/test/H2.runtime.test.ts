import { describe, expect, test } from "vitest";
import { codeLines, findDynamicEvaluation, record } from "@poc/harness";
import { toyRegistry } from "@poc/sdk";
import type { Executor } from "@poc/sdk";
import { runGraph, toyExecutors } from "../src/index.ts";
import type { Graph } from "../src/index.ts";
import { branchOnly, BRANCH_MS, chainGraph, chainPayload, diamondGraph } from "./graphs.ts";

// Every source file of the packages that make up the runtime path, as text, to scan for dynamic evaluation.
const sources = import.meta.glob(["../src/**/*.ts", "../../sdk/src/**/*.ts", "../../../bricks/credit-wallet/src/**/*.ts", "../../../bricks/multi-workspace/src/**/*.ts", "../../assembler/src/**/*.ts", "../../../bricks/dynamic-entities/src/**/*.ts", "../../mcp-server/src/**/*.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const timed = async (graph: Graph) => {
  const start = performance.now();
  const result = await runGraph(graph, toyRegistry, toyExecutors, { workspaceId: "ws_test", payload: { value: 7 } });
  return { ms: performance.now() - start, result };
};

describe("H2 inputs", () => {
  test("the gate really scans the runtime path (not vacuously clean)", () => {
    const names = Object.keys(sources).map((p) => p.split("/").pop());
    expect(names).toEqual(expect.arrayContaining(["run.ts", "toy-executors.ts", "validate.ts", "manifest.ts"]));
  });

  test("no runtime or sdk source builds or evaluates code", () => {
    const hits = Object.entries(sources).flatMap(([path, text]) =>
      findDynamicEvaluation(text).map((h) => `${path}:${h.line} ${h.rule}`),
    );
    expect(hits).toEqual([]);
  });

  test("no source of the runtime path imports a node: module (C3 holds even though the tests run with nodejs_compat)", () => {
    const offenders = Object.entries(sources).flatMap(([path, text]) =>
      codeLines(text)
        .filter(({ text: line }) => /\bfrom\s+["']node:|\brequire\(\s*["']node:|\bimport\(\s*["']node:/.test(line))
        .map(({ line }) => `${path}:${line}`),
    );
    expect(offenders).toEqual([]);
  });

  test("the chain graph digs the payload down to 5", async () => {
    const result = await runGraph(chainGraph, toyRegistry, toyExecutors, { workspaceId: "ws_test", payload: chainPayload });
    expect(result.ok).toBe(true);
    expect(result.outputs.p2?.out).toBe(5);
  });

  test("the diamond graph joins both branches", async () => {
    const { result } = await timed(diamondGraph);
    expect(result.ok).toBe(true);
    expect(result.outputs.j?.out).toEqual({ a: { value: 7 }, b: { value: 7 } });
  });
});

test("H2 report", async ({ task }) => {
  const chain = await runGraph(chainGraph, toyRegistry, toyExecutors, { workspaceId: "ws_test", payload: chainPayload });
  // Same timer, same test: the diamond against branch A alone plus branch B alone.
  const a = await timed(branchOnly("a"));
  const b = await timed(branchOnly("b"));
  const diamond = await timed(diamondGraph);
  const hits = Object.values(sources).flatMap((text) => findDynamicEvaluation(text));
  const scanned = Object.keys(sources).some((p) => p.endsWith("/run.ts"));

  record(task, {
    id: "H2",
    measured: Math.round((diamond.ms / (a.ms + b.ms)) * 1000) / 1000,
    checks: {
      chainPasses: chain.ok && chain.outputs.p2?.out === 5,
      diamondPasses:
        diamond.result.ok &&
        JSON.stringify(diamond.result.outputs.j?.out) === JSON.stringify({ a: { value: 7 }, b: { value: 7 } }),
      noDynamicEvaluation: scanned && hits.length === 0,
    },
  });
  // Sanity on the setup itself: a branch really waits about BRANCH_MS.
  expect(a.ms).toBeGreaterThanOrEqual(BRANCH_MS * 0.9);
});

describe("H2 concurrency, shown by order of events rather than by a clock", () => {
  test("both branches start before either finishes", async () => {
    const log: string[] = [];
    const logging: Executor = async ({ nodeId, inputs }) => {
      log.push(`start ${nodeId}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      log.push(`end ${nodeId}`);
      return { out: inputs.in };
    };
    const executors = new Map([...toyExecutors, ["util.delay", logging]]);
    await runGraph(diamondGraph, toyRegistry, executors, { workspaceId: "ws_test", payload: 1 });
    expect(log.slice(0, 2).sort()).toEqual(["start a", "start b"]);
    expect(log.slice(2).sort()).toEqual(["end a", "end b"]);
  });
});
