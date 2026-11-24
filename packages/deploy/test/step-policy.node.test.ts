import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { runStoredGraph, APP_WORKSPACE, GRAPH_MIGRATIONS, GRAPH_TABLE } from "../src/worker/graph-run.ts";
import type { StepConfig, StepLike } from "../src/worker/graph-run.ts";
import { createRegistry, toyRegistry } from "@poc/sdk";
import type { BrickManifest, Executor } from "@poc/sdk";
import { toyExecutors } from "@poc/runtime";
import { sqliteD1 } from "../../../test/support/sqlite-d1.ts";

// UC7.2: the retry and timeout policy of a node step comes from what the node declares (sideEffects, idempotent), and the
// engine, not the interpreter, does the retrying. The stand-in step below behaves like the engine where it matters: it
// records each step's config, honours retries.limit (and a non-retryable error), and THROWS if the same step name is
// started twice in one run (a second step.do of the same name is a cached/duplicate step in the real engine, not a retry).

interface Call {
  name: string;
  config?: StepConfig;
  attempts: number;
}
function retryingStep() {
  const calls: Call[] = [];
  const names = new Set<string>();
  const step: StepLike = {
    do: (async (name: string, a: StepConfig | (() => Promise<unknown>), b?: () => Promise<unknown>) => {
      const config = typeof a === "function" ? undefined : a;
      const callback = (typeof a === "function" ? a : b)!;
      if (names.has(name)) throw new Error(`DUPLICATE_STEP_NAME ${name}`);
      names.add(name);
      const call: Call = { name, config, attempts: 0 };
      calls.push(call);
      const limit = config?.retries?.limit ?? 0;
      for (;;) {
        call.attempts += 1;
        try {
          return await callback();
        } catch (error) {
          if (call.attempts > limit || (error as { retry?: boolean }).retry === false) throw error;
        }
      }
    }) as StepLike["do"],
  };
  return { step, calls };
}

const brick = (type: string, sideEffects: "none" | "read" | "write" | undefined, extra: Partial<BrickManifest> = {}): BrickManifest => ({
  type,
  category: "action",
  inputs: [{ id: "in", dataType: "json" }],
  outputs: [{ id: "out", dataType: "json" }],
  configSchema: z.object({}).passthrough(),
  secrets: [],
  ...(sideEffects ? { sideEffects } : {}),
  ...extra,
});
const registry = createRegistry([
  ...toyRegistry.values(),
  brick("t.none", "none"),
  brick("t.read", "read"),
  brick("t.write", "write"),
  brick("t.write-idem", "write", { idempotent: true }),
]);

/** Fails `failures` times with a transient error, then succeeds; counts every execution. */
function flaky(failures: number, counter: { n: number }): Executor {
  return () => {
    counter.n += 1;
    if (counter.n <= failures) throw new Error("503 transient");
    return { out: "done" };
  };
}

let world: ReturnType<typeof sqliteD1>;
beforeEach(() => {
  world = sqliteD1();
  for (const m of GRAPH_MIGRATIONS) world.db.exec(m.sql);
});

async function run(type: string, failures: number) {
  const counter = { n: 0 };
  const graph = {
    nodes: [
      { id: "t", type: "trigger.manual", data: {} },
      { id: "x", type: type, data: {} },
    ],
    edges: [{ id: "e1", source: "t", target: "x", sourceHandle: "out", targetHandle: "in" }],
  };
  world.db.prepare(`INSERT INTO ${GRAPH_TABLE} (workspace_id, id, graph, updated_at) VALUES ('${APP_WORKSPACE}', 'g', ?, 'now')`).run(JSON.stringify(graph));
  const stepper = retryingStep();
  const executors = new Map<string, Executor>([...toyExecutors, [type, flaky(failures, counter)]]);
  const result = await runStoredGraph({
    step: stepper.step,
    db: world.d1,
    params: { graphId: "g", workspaceId: "ws_test", payload: {} },
    env: {},
    registry,
    executors,
    nonRetryable: (m) => Object.assign(new Error(m), { retry: false }),
  });
  return { result, counter, calls: stepper.calls, node: stepper.calls.find((c) => c.name === "node:x")! };
}

describe("UC7.2 step policy from sideEffects", () => {
  test("a read node failing twice then succeeding ends ok", async () => {
    const { result, counter, node } = await run("t.read", 2);
    expect(result.failed).toEqual({});
    expect(counter.n).toBe(3);
    expect(node.config?.retries?.limit).toBeGreaterThanOrEqual(2);
  });

  test("a write node without idempotency gets limit 0 and is attempted exactly once", async () => {
    const { result, counter, node } = await run("t.write", 1);
    expect(node.config?.retries?.limit).toBe(0);
    expect(counter.n).toBe(1);
    expect(Object.keys(result.failed)).toEqual(["x"]);
  });

  test("an idempotent write node is retried", async () => {
    const { result, counter, node } = await run("t.write-idem", 2);
    expect(node.config?.retries?.limit).toBe(3);
    expect(counter.n).toBe(3);
    expect(result.failed).toEqual({});
  });

  test("a none node gets limit 5", async () => {
    const { node } = await run("t.none", 0);
    expect(node.config?.retries?.limit).toBe(5);
  });

  test("every node step has a timeout", async () => {
    for (const type of ["t.none", "t.read", "t.write", "t.write-idem"]) {
      const { calls } = await run(type, 0);
      world.db.exec(`DELETE FROM ${GRAPH_TABLE}`);
      for (const call of calls.filter((c) => c.name.startsWith("node:"))) {
        expect((call.config as { timeout?: string }).timeout, `${type} ${call.name}`).toMatch(/^\d+ seconds?$/);
      }
    }
  });

  test("no step name is started twice in a run, even with the interpreter's own retry option on", async () => {
    const counter = { n: 0 };
    const graph = {
      nodes: [
        { id: "t", type: "trigger.manual", data: {} },
        { id: "x", type: "t.read", data: {} },
      ],
      edges: [{ id: "e1", source: "t", target: "x", sourceHandle: "out", targetHandle: "in" }],
    };
    world.db.prepare(`INSERT INTO ${GRAPH_TABLE} (workspace_id, id, graph, updated_at) VALUES ('${APP_WORKSPACE}', 'g', ?, 'now')`).run(JSON.stringify(graph));
    const stepper = retryingStep();
    const result = await runStoredGraph({
      step: stepper.step,
      db: world.d1,
      params: { graphId: "g", workspaceId: "ws_test", payload: {} },
      env: {},
      registry,
      executors: new Map<string, Executor>([...toyExecutors, ["t.read", flaky(1, counter)]]),
      nonRetryable: (m) => Object.assign(new Error(m), { retry: false }),
      telemetry: { db: world.d1, workflowId: "g", stepRetries: { limit: 3, delayMs: 0 } },
    });
    expect(result.failed).toEqual({});
    expect(counter.n).toBe(2);
  });

  test("a failed non-idempotent write is not started again by the interpreter's own retry loop (same step name twice)", async () => {
    const counter = { n: 0 };
    const graph = {
      nodes: [
        { id: "t", type: "trigger.manual", data: {} },
        { id: "x", type: "t.write", data: {} },
      ],
      edges: [{ id: "e1", source: "t", target: "x", sourceHandle: "out", targetHandle: "in" }],
    };
    world.db.prepare(`INSERT INTO ${GRAPH_TABLE} (workspace_id, id, graph, updated_at) VALUES ('${APP_WORKSPACE}', 'g', ?, 'now')`).run(JSON.stringify(graph));
    const stepper = retryingStep();
    const result = await runStoredGraph({
      step: stepper.step,
      db: world.d1,
      params: { graphId: "g", workspaceId: "ws_test", payload: {} },
      env: {},
      registry,
      executors: new Map<string, Executor>([...toyExecutors, ["t.write", flaky(5, counter)]]),
      nonRetryable: (m) => Object.assign(new Error(m), { retry: false }),
      telemetry: { db: world.d1, workflowId: "g", stepRetries: { limit: 3, delayMs: 0 } },
    });
    expect(result.failed).toEqual({ x: "503 transient" });
    expect(counter.n).toBe(1);
    expect(stepper.calls.filter((c) => c.name === "node:x")).toHaveLength(1);
  });
});
