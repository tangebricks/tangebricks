import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { assemble } from "@poc/assembler";
import { runGraph } from "@poc/runtime";
import type { Graph, RunResult } from "@poc/runtime";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { catalog } from "../../assembler/catalog.generated.ts";
import { INVOICE_FLOW_BLUEPRINT } from "../../../test/support/blueprints.ts";
import { OUT_DIR, writeProject } from "../../../test/support/emitted.ts";
import { bundleWorker } from "../src/bundle.ts";
import type { WorkerBundle } from "../src/bundle.ts";
import { APP_WORKSPACE, GRAPH_MIGRATIONS, GRAPH_TABLE, LATENCY_TABLE, WORKFLOW_BINDING, WORKFLOW_CLASS } from "../src/worker/graph-run.ts";
import { proofExecutors, proofRegistry } from "../src/worker/proof-bricks.ts";
import { LATENCY_ROW } from "../src/worker/proof-routes.ts";

// Story 5.3: the Workflow class, run by the real Workflow engine inside a real workerd (Miniflare 5), from the same bundle
// that gets uploaded. Nothing here imports the Workflow's code: the bundle's text is all the runtime is given.
//
// What this can show: the class registers and runs, graphs come from D1, an edit changes the next run with the script
// untouched, each node is a step, a bad graph ends the run before any node, results match the local interpreter.
// What it cannot: the local engine's status carries step OUTPUTS but not step names, and its error carries a generic
// message, not the validator's reasons; and it never pauses and replays a run (the Node tests in graph-run.node.test.ts
// do that with a stand-in step). The real account (stories 5.5-5.6) is where those are read from Cloudflare itself.
const KEY = "workflow-test-key-0123456789abcdef";
const node = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, data });
const wire = (source: string, sourceHandle: string, target: string, targetHandle: string) => ({ id: `${source}.${sourceHandle}-${target}.${targetHandle}`, source, target, sourceHandle, targetHandle });
const pick = (id: string, path: string) => node(id, "transform.pick", { path });

const ADD_THEN_MULTIPLY: Graph = {
  nodes: [node("t", "trigger.manual"), pick("pa", "a"), pick("pb", "b"), pick("pc", "c"), node("add", "proof.add"), node("mul", "proof.multiply")],
  edges: [wire("t", "out", "pa", "in"), wire("t", "out", "pb", "in"), wire("t", "out", "pc", "in"), wire("pa", "out", "add", "a"), wire("pb", "out", "add", "b"), wire("add", "out", "mul", "a"), wire("pc", "out", "mul", "b")],
};
const ADD_THEN_ADD: Graph = { ...ADD_THEN_MULTIPLY, nodes: ADD_THEN_MULTIPLY.nodes.map((n) => (n.id === "mul" ? node("mul", "proof.add") : n)) };
const DIAMOND: Graph = {
  nodes: [node("t", "trigger.manual"), node("l", "util.delay", { ms: 20 }), pick("r", "a"), node("j", "util.join")],
  edges: [wire("t", "out", "l", "in"), wire("t", "out", "r", "in"), wire("l", "out", "j", "a"), wire("r", "out", "j", "b")],
};
const BOOM: Graph = {
  nodes: [node("t", "trigger.manual"), pick("pa", "a"), node("bad", "util.boom"), node("after", "util.delay", { ms: 0 })],
  edges: [wire("t", "out", "pa", "in"), wire("t", "out", "bad", "in"), wire("bad", "out", "after", "in")],
};
const PAYLOAD = { a: 2, b: 3, c: 4 };

interface Finished {
  id: string;
  status: string;
  output: RunResult | null;
  error?: { name?: string; message?: string };
  __LOCAL_DEV_STEP_OUTPUTS?: unknown[];
}

let bundle: WorkerBundle;
let mf: Miniflare;
let files: Record<string, string>;

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { "x-poc-key": KEY }) => {
  const response = (await mf.dispatchFetch(`http://deployed.invalid${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) } as never)) as unknown as Response;
  const text = await response.text();
  return { status: response.status, text, json: (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; } })() };
};
/**
 * The owner's way of writing a row: straight to D1, not through the Worker (on the real account, the D1 REST query endpoint).
 * The Worker has no route that writes a graph. Rows are app-wide (APP_WORKSPACE) unless a workspace is given.
 */
const editRow = async (id: string, graph: unknown, workspaceId: string = APP_WORKSPACE) => {
  const db = (await mf.getD1Database("DB")) as unknown as D1Like;
  await db.prepare(`INSERT INTO ${GRAPH_TABLE} (workspace_id, id, graph, updated_at) VALUES (?1, ?2, ?3, 'edited directly') ON CONFLICT(workspace_id, id) DO UPDATE SET graph = excluded.graph, updated_at = excluded.updated_at`).bind(workspaceId, id, typeof graph === "string" ? graph : JSON.stringify(graph)).run();
};
/** Storing a graph is the same direct write: the owner's way in, as the Studio deploy path does for an app. */
const store = editRow;
const graphRows = async () => {
  const db = (await mf.getD1Database("DB")) as unknown as D1Like;
  return (await db.prepare(`SELECT workspace_id, id, graph, updated_at FROM ${GRAPH_TABLE} ORDER BY workspace_id, id`).all()).results;
};
const start = async (graphId: string, payload: unknown = PAYLOAD) => {
  const created = await api("POST", "/poc/runs", { graphId, payload });
  expect(created.status).toBe(202);
  return String(created.json!.id);
};
const status = async (id: string) => (await api("GET", `/poc/runs/${id}`)).json as unknown as Finished;
async function finish(id: string, timeoutMs = 20_000): Promise<Finished> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const now = await status(id);
    if (["complete", "errored", "terminated"].includes(now.status)) return now;
    if (Date.now() > deadline) throw new Error(`run ${id} did not finish: ${JSON.stringify(now)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const runAndFinish = async (graphId: string, payload?: unknown) => finish(await start(graphId, payload));
const local = (graph: Graph) => runGraph(graph, proofRegistry, proofExecutors, { payload: PAYLOAD });
const sorted = (values: unknown[]) => values.map((v) => JSON.stringify(v)).sort();

beforeAll(async () => {
  const assembled = assemble(INVOICE_FLOW_BLUEPRINT, catalog);
  if (!assembled.ok) throw new Error(assembled.errors.join("; "));
  files = assembled.files;
  const projectDir = join(OUT_DIR, "deploy-test", "workflow");
  await writeProject(projectDir, files);
  bundle = await bundleWorker({ projectDir });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.code,
      compatibilityDate: "2026-10-01",
      d1Databases: ["DB"],
      bindings: { POC_ACCESS_KEY: KEY },
      workflows: { [WORKFLOW_BINDING]: { name: "projectx-poc-test-graphs", className: WORKFLOW_CLASS } },
    } as never),
  );
  await mf.ready;
  const db = (await mf.getD1Database("DB")) as unknown as D1Like;
  for (const path of Object.keys(files).filter((p) => p.startsWith("migrations/")).sort()) await applyMigration(db, files[path]!);
  for (const m of GRAPH_MIGRATIONS) await applyMigration(db, m.sql);
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});

describe("the bundle carries the Workflow class", () => {
  test("it exports exactly one class besides the default handler, under the name the upload's binding uses", () => {
    const exported = [...bundle.code.matchAll(/^export \{([^}]*)\};?$/gm)].flatMap((m) => m[1]!.split(",").map((s) => s.trim()));
    expect(exported.sort()).toEqual([`${WORKFLOW_CLASS}`, `${exported.find((e) => e.endsWith("as default"))}`].sort());
    expect(exported.some((e) => e === WORKFLOW_CLASS)).toBe(true);
    expect(bundle.code.match(/extends\s+\w*WorkflowEntrypoint/g) ?? []).toHaveLength(1); // one class extends the engine's base class, which is imported, not copied
    expect(bundle.code).toMatch(/from "cloudflare:workers"/);
    expect(bundle.code).toMatch(/from "cloudflare:workflows"/);
  });

  test("the only imports the bundle has left are the runtime's own", () => {
    const imports = bundle.code.split(/\r?\n/).filter((line) => /^\s*import\b/.test(line));
    expect(imports.every((line) => /from "cloudflare:(workers|workflows)"/.test(line))).toBe(true);
    expect(bundle.warnings).toEqual([]);
  });
});

describe("running graphs through the engine", () => {
  test("a stored add-then-multiply graph runs to the interpreter's own answer, (2 + 3) * 4 = 20", async () => {
    await store("sum-product", ADD_THEN_MULTIPLY);
    const done = await runAndFinish("sum-product");
    expect(done.status).toBe("complete");
    expect(done.output).toEqual(await local(ADD_THEN_MULTIPLY));
    expect(done.output!.outputs.mul).toEqual({ out: 20 });
  });

  test("the same single class runs other graphs too, each matching the interpreter, including a failing one", async () => {
    for (const [id, graph] of [["diamond", DIAMOND], ["boom", BOOM], ["sum-sum", ADD_THEN_ADD]] as const) {
      await store(id, graph);
      const done = await runAndFinish(id);
      expect(done.status, id).toBe("complete");
      expect(done.output, id).toEqual(await local(graph));
    }
    const boom = (await runAndFinish("boom")).output!;
    expect(boom.ok).toBe(false);
    expect(boom.failed).toEqual({ bad: "boom" });
    expect(boom.skipped).toEqual(["after"]);
  });

  test("a graph with a payload the nodes cannot use fails that node, not the run", async () => {
    await store("needs-numbers", ADD_THEN_MULTIPLY);
    const done = await runAndFinish("needs-numbers", { a: "two", b: 3, c: 4 });
    expect(done.status).toBe("complete");
    expect(done.output!.ok).toBe(false);
    expect(done.output!.failed.add).toMatch(/input a is not a finite number/);
    expect(done.output!.skipped).toContain("mul");
  });

  test("every node ran as its own step: the engine kept one result for the graph and one for each node that ran", async () => {
    await store("steps", ADD_THEN_MULTIPLY);
    const done = await runAndFinish("steps");
    const kept = done.__LOCAL_DEV_STEP_OUTPUTS!;
    expect(kept).toHaveLength(1 + ADD_THEN_MULTIPLY.nodes.length);
    // the multiset of kept results is the graph (the load step) plus each node's own output
    expect(sorted(kept)).toEqual(sorted([ADD_THEN_MULTIPLY, ...Object.values(done.output!.outputs)]));
  });

  test("a skipped node has no step, and a node that threw leaves no kept result", async () => {
    await store("steps-boom", BOOM);
    const done = await runAndFinish("steps-boom");
    expect(done.output!.skipped).toEqual(["after"]);
    // load + t + pa ran and finished; bad threw (no kept result); after was skipped (no step at all)
    expect(done.__LOCAL_DEV_STEP_OUTPUTS).toHaveLength(3);
  });

  test("two runs of the same graph at once do not disturb each other", async () => {
    await store("twice", ADD_THEN_MULTIPLY);
    const [one, two] = await Promise.all([start("twice", { a: 1, b: 1, c: 1 }), start("twice", { a: 5, b: 5, c: 5 })]);
    const [first, second] = await Promise.all([finish(one), finish(two)]);
    expect(first.output!.outputs.mul).toEqual({ out: 2 });
    expect(second.output!.outputs.mul).toEqual({ out: 50 });
  });
});

describe("the row is the graph: an edit needs no new script", () => {
  test("editing the row directly (as the D1 REST endpoint would) changes the next run, on the same running script", async () => {
    await store("editable", ADD_THEN_MULTIPLY);
    expect((await runAndFinish("editable")).output!.outputs.mul).toEqual({ out: 20 });
    await editRow("editable", ADD_THEN_ADD);
    const after = await runAndFinish("editable");
    expect(after.output).toEqual(await local(ADD_THEN_ADD));
    expect(after.output!.outputs.mul).toEqual({ out: 9 });
    // one script, one Workflow class: nothing was uploaded, started again or reconfigured between the two runs
    expect(bundle.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the graph the Worker reports as stored is the row", async () => {
    await store("reported", ADD_THEN_MULTIPLY);
    const direct = (await mf.getD1Database("DB")) as unknown as D1Like;
    const row = await direct.prepare(`SELECT graph FROM ${GRAPH_TABLE} WHERE workspace_id = ? AND id = ?`).bind(APP_WORKSPACE, "reported").first<{ graph: string }>();
    expect(JSON.parse(row!.graph)).toEqual(ADD_THEN_MULTIPLY);
    const via = await api("GET", "/poc/graphs/reported");
    expect(JSON.parse(via.json!.graph as string)).toEqual(ADD_THEN_MULTIPLY);
  });

  test("a run that has already read its graph finishes with that graph, though the row is edited while it is waiting", async () => {
    const slow: Graph = {
      nodes: [node("t", "trigger.manual"), pick("pa", "a"), pick("pb", "b"), node("wait", "util.delay", { ms: 1500 }), node("add", "proof.add")],
      edges: [wire("t", "out", "pa", "in"), wire("t", "out", "pb", "in"), wire("pa", "out", "wait", "in"), wire("wait", "out", "add", "a"), wire("pb", "out", "add", "b")],
    };
    const slowEdited: Graph = { ...slow, nodes: slow.nodes.map((n) => (n.id === "add" ? node("add", "proof.multiply") : n)) };
    await store("slow", slow);
    const id = await start("slow");
    // wait until the engine has kept the graph (the load step is finished): from then on, the run has what it needs
    for (let i = 0; i < 400; i += 1) {
      const now = await status(id);
      if ((now.__LOCAL_DEV_STEP_OUTPUTS?.length ?? 0) >= 1) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await status(id)).status).not.toBe("complete");
    await editRow("slow", slowEdited);
    const done = await finish(id);
    expect(done.output!.outputs.add).toEqual({ out: 5 }); // 2 + 3, the graph it started with, not 2 * 3
    expect(done.output).toEqual(await local(slow));
    // the next run gets the edited graph
    expect((await runAndFinish("slow")).output!.outputs.add).toEqual({ out: 6 });
  }, 30_000);
});

describe("a graph the validator rejects ends the run before any node", () => {
  const cyclic: Graph = { nodes: [node("t", "trigger.manual"), node("x", "proof.add"), node("y", "proof.add")], edges: [wire("t", "out", "x", "a"), wire("x", "out", "y", "a"), wire("y", "out", "x", "b")] };
  test.each([
    ["a cycle", cyclic],
    ["no trigger", { nodes: [node("x", "proof.add")], edges: [] }],
    ["an unknown brick", { nodes: [node("t", "trigger.manual"), node("x", "proof.nope")], edges: [wire("t", "out", "x", "a")] }],
    ["text that is not JSON", "{ nope"],
    ["JSON that is not a graph", "[1]"],
  ])("%s: the run ends in error with nothing kept, not even a half result", async (_name, graph) => {
    await editRow("bad", graph); // a bad row can only get in by the owner's own path, which does not check it either
    const done = await runAndFinish("bad");
    expect(done.status).toBe("errored");
    expect(done.output).toBeNull();
    expect(done.__LOCAL_DEV_STEP_OUTPUTS).toEqual([]);
    expect(done.error?.name).toBe("WorkflowFatalError");
  });

  test("a row that does not exist ends the same way", async () => {
    const done = await runAndFinish("no-such-row");
    expect(done.status).toBe("errored");
    expect(done.__LOCAL_DEV_STEP_OUTPUTS).toEqual([]);
  });

  test("a good run still works after bad ones: a refused run leaves nothing behind", async () => {
    await store("good", ADD_THEN_MULTIPLY);
    expect((await runAndFinish("good")).output!.outputs.mul).toEqual({ out: 20 });
  });
});

describe("the routes the deploy adds", () => {
  test("every one needs the access key, and without it the Workflow is not started", async () => {
    for (const [method, path, body] of [["PUT", "/poc/graphs/x", "{}"], ["GET", "/poc/graphs/x", undefined], ["POST", "/poc/runs", { graphId: "x" }], ["GET", "/poc/runs/abc", undefined], ["POST", "/poc/write-latency", undefined]] as const) {
      expect((await api(method, path, body, {})).status, `${method} ${path}`).toBe(401);
      expect((await api(method, path, body, { "x-poc-key": "wrong-key-wrong-key-wrong-key" })).status, `${method} ${path} wrong`).toBe(401);
    }
  });

  test("bad requests are refused with a reason, not started", async () => {
    expect((await api("POST", "/poc/runs", "not json")).status).toBe(400);
    expect((await api("POST", "/poc/runs", { graphId: "a/b" })).status).toBe(400);
    expect((await api("POST", "/poc/runs", {})).status).toBe(400);
    expect((await api("PUT", "/poc/graphs/a%20b", "{}")).status).toBe(400);
    expect((await api("PUT", "/poc/graphs/x".padEnd(80, "x"), "{}")).status).toBe(400);
    expect((await api("GET", "/poc/runs/no-such-run-id")).status).toBe(404);
    expect((await api("GET", "/poc/runs/bad.id")).status).toBe(400);
    expect((await api("DELETE", "/poc/graphs/x")).status).toBe(405);
    expect((await api("GET", "/poc/nothing")).status).toBe(404);
    expect((await api("GET", "/poc/graphs/never-written")).status).toBe(404);
  });

  test("no route behind the key stores a graph: PUT with the right key is refused and writes no row", async () => {
    const before = await graphRows();
    const refused = await api("PUT", "/poc/graphs/x", JSON.stringify(ADD_THEN_MULTIPLY), { "x-poc-key": KEY, "content-type": "text/plain" });
    expect(refused.status).toBe(405);
    for (const method of ["POST", "PATCH", "DELETE"]) expect((await api(method, "/poc/graphs/x", "{}")).status, method).toBe(405);
    expect((await api("GET", "/poc/graphs/x")).status).toBe(404);
    expect(await graphRows()).toEqual(before);
  });

  test("a graph stored only for one workspace is invisible here: the route reads and runs app-wide graphs only", async () => {
    await editRow("ws-only", ADD_THEN_MULTIPLY, "ws-a");
    expect((await api("GET", "/poc/graphs/ws-only")).status).toBe(404);
    // the body cannot name a workspace: the run is for APP_WORKSPACE whatever it says
    const created = await api("POST", "/poc/runs", { graphId: "ws-only", workspaceId: "ws-a", payload: PAYLOAD });
    expect(created.status).toBe(202);
    const done = await finish(String(created.json!.id));
    expect(done.status).toBe("errored");
    expect(done.__LOCAL_DEV_STEP_OUTPUTS).toEqual([]);
  });

  test("the project's own routes are untouched by the extra ones", async () => {
    const response = await api("GET", "/api/health");
    expect([200, 404]).toContain(response.status);
    expect(response.status).not.toBe(401);
    const demo = (await mf.dispatchFetch("http://deployed.invalid/demo")) as unknown as Response;
    expect(demo.status).toBe(200);
  });

  test("ten timed writes: ten timings, and the median and slowest agree with them", async () => {
    const result = await api("POST", "/poc/write-latency");
    expect(result.status).toBe(200);
    const timings = result.json!.timingsMs as number[];
    expect(timings).toHaveLength(10);
    expect(result.json!.writes).toBe(10);
    expect(timings.every((t) => typeof t === "number" && t >= 0)).toBe(true);
    expect(result.json!.slowestMs).toBe(Math.max(...timings));
    const ordered = [...timings].sort((a, b) => a - b);
    expect(Math.abs((result.json!.medianMs as number) - (ordered[4]! + ordered[5]!) / 2)).toBeLessThanOrEqual(0.1);
  });

  test("a write that was timed really happened, in the scratch table: ten writes leave the scratch row at the tenth and no graph row changes", async () => {
    const before = await graphRows();
    await api("POST", "/poc/write-latency");
    const db = (await mf.getD1Database("DB")) as unknown as D1Like;
    const row = await db.prepare(`SELECT body FROM ${LATENCY_TABLE} WHERE id = ?`).bind(LATENCY_ROW).first<{ body: string }>();
    expect(JSON.parse(row!.body)).toEqual({ write: 9 });
    expect(await graphRows()).toEqual(before);
    expect((await api("GET", `/poc/graphs/${LATENCY_ROW}`)).status).toBe(404);
  });
});
