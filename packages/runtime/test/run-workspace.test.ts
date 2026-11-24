import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createRegistry, toyRegistry } from "@poc/sdk";
import type { BrickManifest, ExecutionContext, Executor } from "@poc/sdk";
import { RunRefusedError, RuntimeGraphWorkflow, runGraph, toyExecutors } from "../src/index.ts";
import type { Graph } from "../src/index.ts";

// Story 1.1 (R52, AD-S19): the run's workspace is a verified, immutable field of every executor's context. A run without one
// is refused before any node runs; nothing reads a workspace from inputs, payload or config; the logger records the run's.

const WS_A = "ws_a";
const WS_B = "ws_b";
const probe: BrickManifest = {
  type: "test.probe",
  category: "action",
  inputs: [{ id: "in", dataType: "json" }],
  outputs: [{ id: "out", dataType: "json" }],
  configSchema: z.object({}).passthrough(),
  secrets: [],
};
const registry = createRegistry([...toyRegistry.values(), probe]);
const graph: Graph = {
  nodes: [
    { id: "t", type: "trigger.manual", data: {} },
    { id: "p", type: "test.probe", data: { workspaceId: WS_B } },
    { id: "q", type: "test.probe", data: {} },
  ],
  edges: [
    { id: "e1", source: "t", target: "p", sourceHandle: "out", targetHandle: "in" },
    { id: "e2", source: "p", target: "q", sourceHandle: "out", targetHandle: "in" },
  ],
};
const withProbe = (fn: Executor) => new Map<string, Executor>([...toyExecutors, ["test.probe", fn]]);

describe("RUN_NO_WORKSPACE: a run without a verified workspace is refused before any executor runs", () => {
  test.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["not text", 7],
    ["with a space", "ws a"],
    ["with a slash", "ws/a"],
    ["too long", "w".repeat(201)],
  ])("%s workspace: RunRefusedError NO_WORKSPACE, no executor called", async (_name, workspaceId) => {
    const calls: string[] = [];
    const executors = new Map<string, Executor>([...toyExecutors].map(([type, exec]): [string, Executor] => [type, (ctx) => (calls.push(ctx.nodeId), exec(ctx))]));
    executors.set("test.probe", (ctx) => (calls.push(ctx.nodeId), { out: 1 }));
    const options = { payload: { workspaceId: WS_A }, ...(workspaceId === undefined ? {} : { workspaceId: workspaceId as string }) };
    const error = await runGraph(graph, registry, executors, options as never).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(RunRefusedError);
    expect((error as RunRefusedError).code).toBe("NO_WORKSPACE");
    expect((error as Error).message).toMatch(/^NO_WORKSPACE: /);
    expect(calls).toEqual([]);
  });

  test("RuntimeGraphWorkflow.start passes the workspace through and refuses without one", async () => {
    const seen: string[] = [];
    const wf = new RuntimeGraphWorkflow(registry, withProbe((ctx) => (seen.push(ctx.workspaceId), { out: 1 })));
    expect((await wf.start({ graph, workspaceId: WS_A })).ok).toBe(true);
    expect(seen).toEqual([WS_A, WS_A]);
    await expect(wf.start({ graph } as never)).rejects.toThrow(RunRefusedError);
  });

  test("a telemetry option naming another workspace is refused WORKSPACE_MISMATCH, before any executor runs", async () => {
    const calls: string[] = [];
    const error = await runGraph(graph, registry, withProbe((ctx) => (calls.push(ctx.nodeId), { out: 1 })), {
      workspaceId: WS_A,
      telemetry: { runId: "r_mismatch", workspaceId: WS_B },
    }).then(() => null, (e: unknown) => e);
    expect((error as RunRefusedError).code).toBe("WORKSPACE_MISMATCH");
    expect(calls).toEqual([]);
  });
});

describe("CTX_WORKSPACE: every executor sees the run's workspace, and nothing else moves it", () => {
  test("ctx.workspaceId is the run's for every node, though config, input and payload name another", async () => {
    const seen: Array<[string, string]> = [];
    const result = await runGraph(
      graph,
      registry,
      withProbe((ctx) => (seen.push([ctx.nodeId, ctx.workspaceId]), { out: { workspaceId: WS_B } })),
      { workspaceId: WS_A, payload: { workspaceId: WS_B } },
    );
    expect(result.ok).toBe(true);
    expect(seen).toEqual([["p", WS_A], ["q", WS_A]]);
  });

  test("an executor cannot reassign ctx.workspaceId", async () => {
    let after: string | undefined;
    const result = await runGraph(graph, registry, withProbe((ctx) => {
      try {
        (ctx as { workspaceId: string }).workspaceId = WS_B;
      } catch {
        // strict mode: assigning a read-only property throws
      }
      after = ctx.workspaceId;
      return { out: 1 };
    }), { workspaceId: WS_A });
    expect(result.ok).toBe(true);
    expect(after).toBe(WS_A);
  });
});

describe("PAYLOAD_SPOOF: the logger records the run's workspace only", () => {
  test("logs, the run record and auto error logs carry the run's workspace even when payload, input and log fields claim another", async () => {
    const executor: Executor = async (ctx: ExecutionContext) => {
      await ctx.log?.info("probe ran", { workspaceId: WS_B });
      if (ctx.nodeId === "q") throw new Error("boom");
      return { out: { workspaceId: WS_B } };
    };
    const result = await runGraph(graph, registry, withProbe(executor), {
      workspaceId: WS_A,
      payload: { workspaceId: WS_B },
      telemetry: { runId: "run_logger_ws" },
    });
    expect(result.logs!.length).toBeGreaterThanOrEqual(2);
    expect(result.logs!.every((entry) => entry.workspaceId === WS_A)).toBe(true);
    expect(result.runRecord!.workspaceId).toBe(WS_A);
  });
});
