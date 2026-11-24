import { beforeEach, describe, expect, test } from "vitest";
import {
  TELEMETRY_SIGNATURE_HEADER,
  runGraph,
  signControlPlaneRequest,
  signTelemetryPayload,
  stepPolicyFor,
} from "@poc/runtime";
import type { Graph } from "@poc/runtime";
import { createRegistry } from "@poc/sdk";
import type { Executor } from "@poc/sdk";
import { APP_WORKSPACE, GRAPH_MIGRATIONS, GRAPH_TABLE, LOAD_STEP, TELEMETRY_MIGRATION, nodeStepName, readStoredGraph, runStoredGraph } from "../src/worker/graph-run.ts";
import type { StepConfig, StepLike } from "../src/worker/graph-run.ts";
import { proofExecutors, proofRegistry } from "../src/worker/proof-bricks.ts";
import { createProofRoutes } from "../src/worker/proof-routes.ts";
import { sqliteD1 } from "../../../test/support/sqlite-d1.ts";

// Story 5.3, the parts of the Workflow that are plain code, tested in Node against a stand-in for the engine's step. The
// stand-in does what a real step does that matters here: it keeps the result of a step by name, and a step whose name was
// already finished is NOT run again (that is what a replay after a pause relies on). That the REAL engine behaves so, and
// that the class is wired to it, is checked in workerd by graph-workflow.node.test.ts. Both are needed.

const node = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, data });
const wire = (source: string, sourceHandle: string, target: string, targetHandle: string) => ({ id: `${source}.${sourceHandle}-${target}.${targetHandle}`, source, target, sourceHandle, targetHandle });

// (a + b) * c
const ADD_THEN_MULTIPLY: Graph = {
  nodes: [node("t", "trigger.manual"), node("pa", "transform.pick", { path: "a" }), node("pb", "transform.pick", { path: "b" }), node("pc", "transform.pick", { path: "c" }), node("add", "proof.add"), node("mul", "proof.multiply")],
  edges: [wire("t", "out", "pa", "in"), wire("t", "out", "pb", "in"), wire("t", "out", "pc", "in"), wire("pa", "out", "add", "a"), wire("pb", "out", "add", "b"), wire("add", "out", "mul", "a"), wire("pc", "out", "mul", "b")],
};
// The same shape with the multiplier swapped for an adder: an "edit".
const ADD_THEN_ADD: Graph = { ...ADD_THEN_MULTIPLY, nodes: ADD_THEN_MULTIPLY.nodes.map((n) => (n.id === "mul" ? node("mul", "proof.add") : n)) };
const PAYLOAD = { a: 2, b: 3, c: 4 };

interface StepCall {
  name: string;
  config?: StepConfig;
  executed: boolean;
}
/** A stand-in for the engine's step: results are kept by name; a kept result is returned without running the callback. */
function fakeStep(kept: Map<string, unknown> = new Map()) {
  const calls: StepCall[] = [];
  const started = new Set<string>();
  const step: StepLike = {
    do: (async (name: string, a: StepConfig | (() => Promise<unknown>), b?: () => Promise<unknown>) => {
      const config = typeof a === "function" ? undefined : a;
      const callback = (typeof a === "function" ? a : b)!;
      // UC7.2 AC3: a second step.do of the same name inside one run is a duplicate step in the real engine, not a retry.
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

const nonRetryable = (message: string) => Object.assign(new Error(message), { retry: false });
let world: ReturnType<typeof sqliteD1>;
/** The verified workspace these runs are for (story 1.1: a run without one is refused). Graphs stay app-wide rows. */
const RUN_WS = "ws-run";
const store = (id: string, graph: unknown, workspaceId: string = APP_WORKSPACE) =>
  world.db.prepare(`INSERT INTO ${GRAPH_TABLE} (workspace_id, id, graph, updated_at) VALUES (?, ?, ?, 'now') ON CONFLICT(workspace_id, id) DO UPDATE SET graph = excluded.graph`).run(workspaceId, id, typeof graph === "string" ? graph : JSON.stringify(graph));
const start = (stepper: ReturnType<typeof fakeStep>, graphId = "g1", over: { executors?: ReadonlyMap<string, Executor>; payload?: unknown; workspaceId?: string } = {}) =>
  runStoredGraph({ step: stepper.step, db: world.d1, params: { graphId, workspaceId: over.workspaceId ?? RUN_WS, payload: "payload" in over ? over.payload : PAYLOAD }, env: {}, registry: proofRegistry, executors: over.executors ?? proofExecutors, nonRetryable });

beforeEach(() => {
  world = sqliteD1();
  for (const m of GRAPH_MIGRATIONS) world.db.exec(m.sql);
});

describe("the graph table", () => {
  test("the migrations make the table the Workflow reads, keyed by (workspace_id, id)", () => {
    const columns = world.db.prepare(`PRAGMA table_info(${GRAPH_TABLE})`).all() as Array<{ name: string; pk: number; notnull: number }>;
    expect(columns.map((c) => c.name)).toEqual(["workspace_id", "id", "graph", "updated_at"]);
    expect(columns.find((c) => c.name === "workspace_id")!.pk).toBe(1);
    expect(columns.find((c) => c.name === "id")!.pk).toBe(2);
    expect(columns.find((c) => c.name === "workspace_id")!.notnull).toBe(1);
    expect(columns.find((c) => c.name === "graph")!.notnull).toBe(1);
  });
});

describe("running a stored graph", () => {
  test("add-then-multiply gives (2 + 3) * 4 = 20, which is what the repository's own interpreter gives", async () => {
    store("g1", ADD_THEN_MULTIPLY);
    const result = await start(fakeStep());
    expect(result.ok).toBe(true);
    expect(result.outputs.mul).toEqual({ out: 20 });
    expect(result).toEqual(await runGraph(ADD_THEN_MULTIPLY, proofRegistry, proofExecutors, { payload: PAYLOAD, workspaceId: RUN_WS }));
  });

  test("each node is one step, named for the node, after one step that loads the graph; nothing else is a step", async () => {
    store("g1", ADD_THEN_MULTIPLY);
    const stepper = fakeStep();
    await start(stepper);
    const names = stepper.calls.map((c) => c.name);
    expect(names[0]).toBe(LOAD_STEP);
    expect(names.slice(1).sort()).toEqual(ADD_THEN_MULTIPLY.nodes.map((n) => nodeStepName(n.id)).sort());
    expect(new Set(names).size).toBe(names.length);
    expect(stepper.calls.every((c) => c.executed)).toBe(true);
  });

  test("a node's step comes after the steps of the nodes feeding it", async () => {
    store("g1", ADD_THEN_MULTIPLY);
    const stepper = fakeStep();
    await start(stepper);
    const at = (id: string) => stepper.calls.findIndex((c) => c.name === nodeStepName(id));
    expect(at("t")).toBeLessThan(at("pa"));
    expect(at("pa")).toBeLessThan(at("add"));
    expect(at("pb")).toBeLessThan(at("add"));
    expect(at("add")).toBeLessThan(at("mul"));
    expect(at("pc")).toBeLessThan(at("mul"));
  });

  test("the graph is read from the table exactly once per run, however many nodes it has", async () => {
    store("g1", ADD_THEN_MULTIPLY);
    await start(fakeStep());
    expect(world.reads(GRAPH_TABLE)).toBe(1);
  });

  test("a node's step carries the policy derived from what the node declares (UC7.2), and the step that reads the table keeps the engine's default", async () => {
    store("g1", ADD_THEN_MULTIPLY);
    const stepper = fakeStep();
    await start(stepper);
    expect(stepper.calls[0]!.config).toBeUndefined();
    for (const call of stepper.calls.slice(1)) {
      const type = ADD_THEN_MULTIPLY.nodes.find((n) => nodeStepName(n.id) === call.name)!.type;
      expect(call.config).toEqual(stepPolicyFor(proofRegistry.get(type)!, { idempotent: false }));
      expect(call.config).toHaveProperty("timeout");
    }
  });

  test("a graph with a branch that fails: the failure is recorded, what depends on it is skipped, the other branch still ran, as in the local interpreter", async () => {
    const graph: Graph = {
      nodes: [node("t", "trigger.manual"), node("pa", "transform.pick", { path: "a" }), node("bad", "util.boom"), node("after", "util.delay", { ms: 0 }), node("pb", "transform.pick", { path: "b" })],
      edges: [wire("t", "out", "pa", "in"), wire("t", "out", "bad", "in"), wire("bad", "out", "after", "in"), wire("t", "out", "pb", "in")],
    };
    store("g1", graph);
    const stepper = fakeStep();
    // a step that throws leaves the engine's step the way this stand-in does: the error propagates to the caller
    const result = await start(stepper);
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual({ bad: "boom" });
    expect(result.skipped).toEqual(["after"]);
    expect(result.outputs.pa).toEqual({ out: 2 });
    expect(result.outputs.pb).toEqual({ out: 3 });
    expect(stepper.calls.map((c) => c.name)).not.toContain(nodeStepName("after"));
    expect(result).toEqual(await runGraph(graph, proofRegistry, proofExecutors, { payload: PAYLOAD, workspaceId: RUN_WS }));
  });

  test("a node nothing connects to is a warning, not an error: the graph runs and that node is skipped, as in the local interpreter", async () => {
    const withOrphan: Graph = { ...ADD_THEN_MULTIPLY, nodes: [...ADD_THEN_MULTIPLY.nodes, node("lonely", "proof.add")] };
    store("g1", withOrphan);
    const stepper = fakeStep();
    const result = await start(stepper);
    expect(result.ok).toBe(true);
    expect(result.skipped).toEqual(["lonely"]);
    expect(stepper.calls.map((c) => c.name)).not.toContain(nodeStepName("lonely"));
    expect(result).toEqual(await runGraph(withOrphan, proofRegistry, proofExecutors, { payload: PAYLOAD, workspaceId: RUN_WS }));
  });

  test("a diamond with a delay (the toy bricks) gives the same answer as the local interpreter", async () => {
    const graph: Graph = {
      nodes: [node("t", "trigger.manual"), node("l", "util.delay", { ms: 5 }), node("r", "transform.pick", { path: "a" }), node("j", "util.join")],
      edges: [wire("t", "out", "l", "in"), wire("t", "out", "r", "in"), wire("l", "out", "j", "a"), wire("r", "out", "j", "b")],
    };
    store("g1", graph);
    expect(await start(fakeStep())).toEqual(await runGraph(graph, proofRegistry, proofExecutors, { payload: PAYLOAD, workspaceId: RUN_WS }));
  });
});

describe("one class, any graph: the row decides", () => {
  test("editing the row changes the next run, and the code and bricks are the same objects", async () => {
    store("g1", ADD_THEN_MULTIPLY);
    expect((await start(fakeStep())).outputs.mul).toEqual({ out: 20 });
    store("g1", ADD_THEN_ADD);
    expect((await start(fakeStep())).outputs.mul).toEqual({ out: 9 }); // (2 + 3) + 4
  });

  test("two rows are two graphs, run by the same function", async () => {
    store("one", ADD_THEN_MULTIPLY);
    store("two", ADD_THEN_ADD);
    expect((await start(fakeStep(), "one")).outputs.mul).toEqual({ out: 20 });
    expect((await start(fakeStep(), "two")).outputs.mul).toEqual({ out: 9 });
  });

  test("a run that was replayed after its first step used the graph it started with, not the row as it is now, and did not run finished nodes again", async () => {
    store("g1", ADD_THEN_MULTIPLY);
    const runs: string[] = [];
    const counting = new Map(proofExecutors);
    for (const [type, executor] of proofExecutors) counting.set(type, (ctx) => (runs.push(ctx.nodeId), executor(ctx)));

    // First pass: the engine gets as far as finishing the load step and the first nodes, then the run is paused.
    const kept = new Map<string, unknown>();
    const first = fakeStep(kept);
    const partial = new Promise<void>((resolve) => {
      const original = first.step.do.bind(first.step) as StepLike["do"];
      first.step.do = (async (name: string, a: unknown, b?: unknown) => {
        if (name === nodeStepName("add")) {
          resolve();
          return new Promise(() => undefined); // the run never gets past here: it is paused
        }
        return (original as (...args: unknown[]) => Promise<unknown>)(name, a, b);
      }) as StepLike["do"];
    });
    void start(first, "g1", { executors: counting });
    await partial;
    expect(kept.has(LOAD_STEP)).toBe(true);
    const ranBeforePause = [...runs];

    store("g1", ADD_THEN_ADD); // the row is edited while the run is paused

    // Second pass: a fresh run() call with the engine's kept results, as after a replay.
    const second = fakeStep(kept);
    const result = await start(second, "g1", { executors: counting });
    expect(result.outputs.mul).toEqual({ out: 20 }); // the OLD graph's answer
    expect(result).toEqual(await runGraph(ADD_THEN_MULTIPLY, proofRegistry, proofExecutors, { payload: PAYLOAD, workspaceId: RUN_WS }));
    expect(world.reads(GRAPH_TABLE)).toBe(1); // the table was read once, before the edit
    // nodes whose steps had finished were not executed again
    for (const id of ranBeforePause) expect(runs.filter((r) => r === id)).toHaveLength(1);
    expect(second.calls.filter((c) => c.executed).map((c) => c.name)).not.toContain(LOAD_STEP);
    // and the very next run reads the table afresh and gets the edited graph
    expect((await start(fakeStep())).outputs.mul).toEqual({ out: 9 });
  });
});

describe("a graph that cannot run is refused before any node does", () => {
  const refused = async (id: string, expectation: RegExp) => {
    const stepper = fakeStep();
    const executed: string[] = [];
    const watching = new Map(proofExecutors);
    for (const [type, executor] of proofExecutors) watching.set(type, (ctx) => (executed.push(ctx.nodeId), executor(ctx)));
    const error = await start(stepper, id, { executors: watching }).catch((e: unknown) => e as Error & { retry?: boolean });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(expectation);
    expect((error as { retry?: boolean }).retry).toBe(false); // told not to retry
    expect(stepper.calls.map((c) => c.name)).toEqual([LOAD_STEP]); // the load step is the only step there was
    expect(executed).toEqual([]);
    return (error as Error).message;
  };

  test("a graph with a cycle", async () => {
    const cyclic: Graph = { nodes: [node("t", "trigger.manual"), node("x", "proof.add"), node("y", "proof.add")], edges: [wire("t", "out", "x", "a"), wire("x", "out", "y", "a"), wire("y", "out", "x", "b")] };
    store("g1", cyclic);
    expect(await refused("g1", /graph is invalid: .*cycle/)).toContain("cycle");
  });

  test("a graph with no trigger", async () => {
    store("g1", { nodes: [node("x", "proof.add")], edges: [] });
    await refused("g1", /no_trigger/);
  });

  test("a graph that uses a brick that does not exist", async () => {
    store("g1", { nodes: [node("t", "trigger.manual"), node("x", "proof.nonexistent")], edges: [wire("t", "out", "x", "a")] });
    await refused("g1", /unknown_brick at x/);
  });

  test("a graph whose node settings are wrong", async () => {
    store("g1", { nodes: [node("t", "trigger.manual"), node("p", "transform.pick", { path: 5 })], edges: [wire("t", "out", "p", "in")] });
    await refused("g1", /invalid_config at p/);
  });

  test("a graph wired port to a port of the wrong kind", async () => {
    store("g1", { nodes: [node("t", "trigger.manual"), node("s", "sink.text"), node("add", "proof.add")], edges: [wire("add", "out", "s", "in"), wire("t", "out", "add", "a")] });
    await refused("g1", /incompatible_wire/);
  });

  test("a reference in a node's settings to a node that does not run before it", async () => {
    store("g1", { nodes: [node("t", "trigger.manual"), node("p", "transform.pick", { path: "{{$node.ghost.out}}" })], edges: [wire("t", "out", "p", "in")] });
    await refused("g1", /bad_ref at p/);
  });

  test("an edge that points at a node that is not there is ignored by the validator (existing behaviour, from H1), so the graph runs as the local interpreter runs it", async () => {
    const dangling: Graph = { nodes: [node("t", "trigger.manual")], edges: [wire("t", "out", "ghost", "a")] };
    store("g1", dangling);
    expect(await start(fakeStep())).toEqual(await runGraph(dangling, proofRegistry, proofExecutors, { payload: PAYLOAD, workspaceId: RUN_WS }));
  });

  test("text that is not JSON", async () => {
    store("g1", "{ this is not json");
    await refused("g1", /not valid JSON/);
  });

  test.each([
    ["JSON that is not a graph", "[1,2,3]", /not an object|needs a list/],
    ["a graph with no edges list", '{"nodes":[]}', /needs a list of nodes and a list of edges/],
    ["a node with no id", '{"nodes":[{"type":"trigger.manual","data":{}}],"edges":[]}', /every node needs/],
    ["a node whose data is a list", '{"nodes":[{"id":"t","type":"trigger.manual","data":[]}],"edges":[]}', /every node needs/],
    ["an edge with no target", '{"nodes":[],"edges":[{"id":"e","source":"a"}]}', /every edge needs/],
    ["JSON null", "null", /not an object/],
  ])("%s", async (_name, text, expectation) => {
    store("g1", text);
    await refused("g1", expectation);
  });

  test("no row under that id", async () => {
    await refused("never-stored", /no graph is stored under "never-stored"/);
  });

  test.each([["a/b"], [""], ["x".repeat(65)], ["a b"], ["../x"]])("a graph id of %j", async (id) => {
    const stepper = fakeStep();
    const error = (await start(stepper, id).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/usable graph id/);
    expect(stepper.calls).toEqual([]); // nothing, not even the table, was touched
    expect(world.statements).toEqual([]);
  });

  test("a graph id is passed to SQL as a parameter, never written into it", async () => {
    store("g1", ADD_THEN_MULTIPLY);
    const error = (await start(fakeStep(), "g1' OR '1'='1").catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/usable graph id/);
    await start(fakeStep(), "g1");
    expect(world.statements.every((s) => !s.includes("g1"))).toBe(true);
  });

  test("a long list of reasons is cut short, so the message stays small", async () => {
    const many: Graph = { nodes: Array.from({ length: 80 }, (_, i) => node(`x${i}`, "proof.nonexistent")), edges: [] };
    store("g1", many);
    const message = await refused("g1", /graph is invalid/);
    expect(message.length).toBeLessThanOrEqual(900);
  });
});

describe("readStoredGraph", () => {
  test("accepts a good graph and returns it", () => {
    const read = readStoredGraph(JSON.stringify(ADD_THEN_MULTIPLY), proofRegistry);
    expect(read).toEqual({ ok: true, graph: ADD_THEN_MULTIPLY });
  });
  test("never throws, whatever it is given", () => {
    for (const input of [undefined, null, 5, {}, [], "", "null", "[]", '{"nodes":5,"edges":5}', '{"nodes":[null],"edges":[]}', '{"nodes":[],"edges":[null]}']) {
      const read = readStoredGraph(input, proofRegistry);
      expect(read.ok).toBe(false);
    }
  });
  test("an empty graph is refused because it has no trigger", () => {
    const read = readStoredGraph('{"nodes":[],"edges":[]}', proofRegistry);
    expect(read).toMatchObject({ ok: false });
    expect((read as { reason: string }).reason).toContain("no_trigger");
  });
  test("works with any registry it is given, not only the proof's", () => {
    const empty = createRegistry([]);
    expect(readStoredGraph(JSON.stringify(ADD_THEN_MULTIPLY), empty)).toMatchObject({ ok: false });
  });
  test("refuses graphs that exceed platform budget limits (UC7.4)", () => {
    // 1 trigger + 300 targets connected to it exceeds 256 fan-out
    const nodes = [
      { id: "trig", type: "trigger.manual", data: {} },
    ];
    const edges = [];
    for (let i = 0; i < 300; i++) {
      nodes.push({ id: `target_${i}`, type: "transform.pick", data: { path: "x" } });
      edges.push({
        id: `e_${i}`,
        source: "trig",
        target: `target_${i}`,
        sourceHandle: "out",
        targetHandle: "in",
      });
    }
    const read = readStoredGraph(JSON.stringify({ nodes, edges }), proofRegistry);
    expect(read.ok).toBe(false);
    expect((read as { reason: string }).reason).toContain("BUDGET_FANOUT_EXCEEDED");
  });
});

describe("TELEMETRY_MIGRATION, runStoredGraph telemetry, and /__px/* proof routes", () => {
  test("applies TELEMETRY_MIGRATION, records px_runs + px_step_events from runStoredGraph, and serves /__px/rehearse, /__px/runs, /__px/runs/rerun, and /__px/events", async () => {
    world.db.exec(TELEMETRY_MIGRATION.sql);
    expect(TELEMETRY_MIGRATION.name).toBe("9001_px_telemetry.sql");

    store("g1", ADD_THEN_MULTIPLY);
    const secret = "px-deploy-worker-telemetry-secret";
    const result = await runStoredGraph({
      step: fakeStep().step,
      db: world.d1,
      params: {
        graphId: "g1",
        workspaceId: RUN_WS,
        payload: PAYLOAD,
        telemetry: {
          runId: "run_stored_graph_1",
          workflowId: "g1",
          revision: 2,
        },
      },
      env: { PX_TELEMETRY_SECRET: secret },
      registry: proofRegistry,
      executors: proofExecutors,
      nonRetryable,
    });
    expect(result.ok).toBe(true);
    expect(result.outputs.mul).toEqual({ out: 20 });

    const runRows = world.db
      .prepare("SELECT run_id, workflow_id, revision, status FROM px_runs WHERE run_id = ?")
      .all("run_stored_graph_1") as Array<{
      run_id: string;
      workflow_id: string;
      revision: number;
      status: string;
    }>;
    expect(runRows).toEqual([
      {
        run_id: "run_stored_graph_1",
        workflow_id: "g1",
        revision: 2,
        status: "succeeded",
      },
    ]);

    const stepRows = world.db
      .prepare("SELECT node_id, status FROM px_step_events WHERE run_id = ?")
      .all("run_stored_graph_1") as Array<{ node_id: string; status: string }>;
    expect(stepRows.length).toBeGreaterThanOrEqual(ADD_THEN_MULTIPLY.nodes.length);

    const routes = createProofRoutes();
    const env = {
      DB: world.d1,
      PX_TELEMETRY_SECRET: secret,
      PX_ENV: "preview",
    };

    // 1. POST /__px/rehearse
    const rehearseBody = JSON.stringify({
      workflowId: "g1",
      revision: 2,
      nodeId: "pa",
      nodeType: "transform.pick",
      config: { path: "a" },
      input: PAYLOAD,
      workspaceId: RUN_WS,
    });
    const rehearseSig = await signTelemetryPayload(rehearseBody, secret);
    const rehearseRes = await routes(
      new Request("http://deployed.invalid/__px/rehearse", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TELEMETRY_SIGNATURE_HEADER]: rehearseSig,
        },
        body: rehearseBody,
      }),
      env,
    );
    expect(rehearseRes?.status).toBe(200);
    const rehearseJson = (await rehearseRes!.json()) as {
      status: string;
      output: Record<string, unknown>;
    };
    expect(rehearseJson.status).toBe("succeeded");
    expect(rehearseJson.output).toEqual({ out: 2 });

    // 2. POST /__px/runs (with a failing branch for rerun testing)
    const boomGraph: Graph = {
      nodes: [
        node("t", "trigger.manual"),
        node("pa", "transform.pick", { path: "a" }),
        node("bad", "util.boom"),
      ],
      edges: [wire("t", "out", "pa", "in"), wire("pa", "out", "bad", "in")],
    };
    const runBody = JSON.stringify({
      runId: "run_px_route_failed_1",
      workflowId: "g_boom",
      revision: 1,
      triggerType: "manual_test",
      triggerPayload: PAYLOAD,
      workspaceId: RUN_WS,
      graph: boomGraph,
    });
    const runSig = await signTelemetryPayload(runBody, secret);
    const runRes = await routes(
      new Request("http://deployed.invalid/__px/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TELEMETRY_SIGNATURE_HEADER]: runSig,
        },
        body: runBody,
      }),
      env,
    );
    expect(runRes?.status).toBe(200);
    const runJson = (await runRes!.json()) as { runStatus: string; runId: string };
    expect(runJson.runStatus).toBe("failed");

    // 3. POST /__px/runs/rerun (swap util.boom for transform.pick so rerun from 'bad' succeeds)
    const fixedGraph: Graph = {
      nodes: [
        node("t", "trigger.manual"),
        node("pa", "transform.pick", { path: "a" }),
        node("bad", "util.delay", { ms: 0 }),
      ],
      edges: [wire("t", "out", "pa", "in"), wire("pa", "out", "bad", "in")],
    };
    const rerunBody = JSON.stringify({
      sourceRunId: "run_px_route_failed_1",
      runId: "run_px_route_rerun_2",
      fromNodeId: "bad",
      workflowId: "g_boom",
      revision: 1,
      workspaceId: RUN_WS,
      graph: fixedGraph,
    });
    const rerunSig = await signTelemetryPayload(rerunBody, secret);
    const rerunRes = await routes(
      new Request("http://deployed.invalid/__px/runs/rerun", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TELEMETRY_SIGNATURE_HEADER]: rerunSig,
        },
        body: rerunBody,
      }),
      env,
    );
    expect(rerunRes?.status).toBe(200);
    const rerunJson = (await rerunRes!.json()) as {
      runStatus: string;
      retryOfRunId: string;
    };
    expect(rerunJson.runStatus).toBe("succeeded");
    expect(rerunJson.retryOfRunId).toBe("run_px_route_failed_1");

    // 4. GET /__px/events?workspaceId=<run ws>&after=0&limit=50, signed over method, path and query, time (story 1.4)
    const eventsUrl = new URL(`http://deployed.invalid/__px/events?workspaceId=${RUN_WS}&after=0&limit=50`);
    const eventsRes = await routes(
      new Request(eventsUrl.toString(), {
        method: "GET",
        headers: await signControlPlaneRequest(secret, "GET", eventsUrl),
      }),
      env,
    );
    expect(eventsRes?.status).toBe(200);
    const eventsJson = (await eventsRes!.json()) as {
      events: unknown[];
      nextCursor: number;
    };
    expect(eventsJson.events.length).toBeGreaterThan(0);
    expect(eventsJson.nextCursor).toBeGreaterThan(0);
  });
});
