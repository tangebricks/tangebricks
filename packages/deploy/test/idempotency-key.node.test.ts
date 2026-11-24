import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type { BrickManifest, ExecutionContext, Executor } from "@poc/sdk";
import { createRegistry, toyRegistry } from "@poc/sdk";
import { toyExecutors } from "@poc/runtime";
import {
  APP_WORKSPACE,
  GRAPH_MIGRATIONS,
  GRAPH_TABLE,
  TELEMETRY_MIGRATION,
  runStoredGraph,
} from "../src/worker/graph-run.ts";
import type { StepConfig, StepLike } from "../src/worker/graph-run.ts";
import { sqliteD1 } from "../../../test/support/sqlite-d1.ts";

interface StepCall {
  name: string;
  config?: StepConfig;
  executed: boolean;
}

function fakeStep(kept: Map<string, unknown> = new Map()) {
  const calls: StepCall[] = [];
  const started = new Set<string>();
  const step: StepLike = {
    do: (async (
      name: string,
      a: StepConfig | (() => Promise<unknown>),
      b?: () => Promise<unknown>,
    ) => {
      const config = typeof a === "function" ? undefined : a;
      const callback = (typeof a === "function" ? a : b)!;
      if (started.has(name)) throw new Error(`DUPLICATE_STEP_NAME ${name}`);
      started.add(name);
      const call: StepCall = { name, config, executed: false };
      calls.push(call);
      if (kept.has(name)) return kept.get(name);
      call.executed = true;
      const value = await callback();
      kept.set(name, value);
      return value;
    }) as StepLike["do"],
  };
  return { step, calls, kept };
}

const nonRetryable = (message: string) =>
  Object.assign(new Error(message), { retry: false });

const writeManifest: BrickManifest = {
  type: "proof.write",
  category: "action",
  inputs: [{ id: "in", dataType: "json" }],
  outputs: [{ id: "out", dataType: "json" }],
  configSchema: z.object({}),
  secrets: [],
  sideEffects: "write",
};

const secondWriteManifest: BrickManifest = {
  type: "proof.write_second",
  category: "action",
  inputs: [{ id: "in", dataType: "json" }],
  outputs: [{ id: "out", dataType: "json" }],
  configSchema: z.object({}),
  secrets: [],
  sideEffects: "write",
};

const testRegistry = createRegistry([
  ...toyRegistry.values(),
  writeManifest,
  secondWriteManifest,
]);

let world: ReturnType<typeof sqliteD1>;

const storeGraph = (id: string, graph: unknown) =>
  world.db
    .prepare(
      `INSERT INTO ${GRAPH_TABLE} (workspace_id, id, graph, updated_at) VALUES ('${APP_WORKSPACE}', ?, ?, 'now') ON CONFLICT(workspace_id, id) DO UPDATE SET graph = excluded.graph`,
    )
    .run(id, typeof graph === "string" ? graph : JSON.stringify(graph));

beforeEach(() => {
  world = sqliteD1();
  for (const m of GRAPH_MIGRATIONS) world.db.exec(m.sql);
  world.db.exec(TELEMETRY_MIGRATION.sql);
});

describe("UC7.1 — Tracer: stable run id and idempotency key runId:nodeId on ExecutionContext", () => {
  test("AC1: same instance id and same node produce the same key across replays; different nodes and runs produce different keys", async () => {
    const recordedEvents: Array<{
      nodeId: string;
      runId: string;
      idempotencyKey: string;
    }> = [];

    const testExecutors = new Map<string, Executor>([
      ...toyExecutors,
      [
        "proof.write",
        (ctx: ExecutionContext) => {
          recordedEvents.push({
            nodeId: ctx.nodeId,
            runId: ctx.runId,
            idempotencyKey: ctx.idempotencyKey,
          });
          return { out: "write1_done" };
        },
      ],
      [
        "proof.write_second",
        (ctx: ExecutionContext) => {
          recordedEvents.push({
            nodeId: ctx.nodeId,
            runId: ctx.runId,
            idempotencyKey: ctx.idempotencyKey,
          });
          return { out: "write2_done" };
        },
      ],
    ]);

    const graph = {
      nodes: [
        { id: "t", type: "trigger.manual", data: {} },
        { id: "w1", type: "proof.write", data: {} },
        { id: "w2", type: "proof.write_second", data: {} },
      ],
      edges: [
        { id: "e1", source: "t", sourceHandle: "out", target: "w1", targetHandle: "in" },
        { id: "e2", source: "t", sourceHandle: "out", target: "w2", targetHandle: "in" },
      ],
    };

    storeGraph("g_idemp", graph);

    const instanceId = "wf_inst_replay_001";

    // First execution
    const stepper1 = fakeStep();
    const result1 = await runStoredGraph({
      step: stepper1.step,
      db: world.d1,
      params: { graphId: "g_idemp", workspaceId: "ws_test", payload: { ping: true }, runId: instanceId },
      env: {},
      registry: testRegistry,
      executors: testExecutors,
      nonRetryable,
    });
    expect(result1.ok).toBe(true);

    // Second execution simulating replay with same instanceId
    const stepper2 = fakeStep();
    const result2 = await runStoredGraph({
      step: stepper2.step,
      db: world.d1,
      params: { graphId: "g_idemp", workspaceId: "ws_test", payload: { ping: true }, runId: instanceId },
      env: {},
      registry: testRegistry,
      executors: testExecutors,
      nonRetryable,
    });
    expect(result2.ok).toBe(true);

    // Filter events for w1
    const w1Events = recordedEvents.filter((e) => e.nodeId === "w1");
    expect(w1Events).toHaveLength(2);
    // Same instance id and same node produce the same key across replays
    expect(w1Events[0]!.idempotencyKey).toBe(`${instanceId}:w1`);
    expect(w1Events[1]!.idempotencyKey).toBe(`${instanceId}:w1`);
    expect(w1Events[0]!.runId).toBe(instanceId);
    expect(w1Events[1]!.runId).toBe(instanceId);

    // Filter events for w2
    const w2Events = recordedEvents.filter((e) => e.nodeId === "w2");
    expect(w2Events).toHaveLength(2);
    expect(w2Events[0]!.idempotencyKey).toBe(`${instanceId}:w2`);
    expect(w2Events[1]!.idempotencyKey).toBe(`${instanceId}:w2`);

    // Different nodes in the same run produce different keys
    expect(w1Events[0]!.idempotencyKey).not.toBe(w2Events[0]!.idempotencyKey);

    // A different run produces a different key
    const differentInstanceId = "wf_inst_other_002";
    const stepper3 = fakeStep();
    const result3 = await runStoredGraph({
      step: stepper3.step,
      db: world.d1,
      params: { graphId: "g_idemp", workspaceId: "ws_test", payload: { ping: true }, runId: differentInstanceId },
      env: {},
      registry: testRegistry,
      executors: testExecutors,
      nonRetryable,
    });
    expect(result3.ok).toBe(true);

    const w1Run3 = recordedEvents.find(
      (e) => e.nodeId === "w1" && e.runId === differentInstanceId,
    );
    expect(w1Run3).toBeDefined();
    expect(w1Run3!.idempotencyKey).toBe(`${differentInstanceId}:w1`);
    expect(w1Run3!.idempotencyKey).not.toBe(w1Events[0]!.idempotencyKey);
  });

  test("AC3: telemetry run record stores the same runId as the Workflow instance id", async () => {
    const testExecutors = new Map<string, Executor>([
      ...toyExecutors,
      ["proof.write", () => ({ out: "ok" })],
    ]);

    const graph = {
      nodes: [
        { id: "t", type: "trigger.manual", data: {} },
        { id: "w1", type: "proof.write", data: {} },
      ],
      edges: [
        { id: "e1", source: "t", sourceHandle: "out", target: "w1", targetHandle: "in" },
      ],
    };

    storeGraph("g_telemetry_idemp", graph);

    const instanceId = "wf_inst_telemetry_999";
    const stepper = fakeStep();
    const result = await runStoredGraph({
      step: stepper.step,
      db: world.d1,
      params: {
        graphId: "g_telemetry_idemp",
        workspaceId: "ws_test",
        payload: {},
        runId: instanceId,
        telemetry: {
          db: world.d1,
        },
      },
      env: {},
      registry: testRegistry,
      executors: testExecutors,
      nonRetryable,
    });

    expect(result.ok).toBe(true);
    expect(result.runId).toBe(instanceId);
    expect(result.runRecord).toBeDefined();
    expect(result.runRecord!.runId).toBe(instanceId);
  });
});
