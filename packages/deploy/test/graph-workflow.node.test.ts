import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { assemble } from "@poc/assembler";
import { TELEMETRY_SIGNATURE_HEADER, runGraph, signTelemetryPayload } from "@poc/runtime";
import { SIGNED_AT_HEADER, signControlPlaneRequest } from "../src/worker/proof-routes.ts";
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
import { LATENCY_ROW, WORKFLOW_RUNS_PATH } from "../src/worker/proof-routes.ts";

// Story 5.3: the Workflow class, run by the real Workflow engine inside a real workerd (Miniflare 5), from the same bundle
// that gets uploaded. Nothing here imports the Workflow's code: the bundle's text is all the runtime is given.
//
// What this can show: the class registers and runs, graphs come from D1, an edit changes the next run with the script
// untouched, each node is a step, a bad graph ends the run before any node, results match the local interpreter.
// What it cannot: the local engine's status carries step OUTPUTS but not step names, and its error carries a generic
// message, not the validator's reasons; and it never pauses and replays a run (the Node tests in graph-run.node.test.ts
// do that with a stand-in step). The real account (stories 5.5-5.6) is where those are read from Cloudflare itself.
const KEY = "workflow-test-key-0123456789abcdef";
/** The Worker's control-plane signing secret (PX_TELEMETRY_SECRET). Since story 1.1 a run starts only from a signed request naming its workspace. */
const SIGNING_SECRET = "workflow-test-signing-secret-0123456789";
const WS_A = "ws-a";
const WS_B = "ws-b";
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
/** Starts a run the authenticated way: a body naming the verified workspace, HMAC-signed with PX_TELEMETRY_SECRET. */
const signedRun = async (body: Record<string, unknown>, secret = SIGNING_SECRET) => {
  const text = JSON.stringify({ requestId: crypto.randomUUID(), ...body });
  return api("POST", WORKFLOW_RUNS_PATH, text, { "x-poc-key": KEY, "content-type": "application/json", ...(await signControlPlaneRequest(secret, "POST", WORKFLOW_RUNS_PATH, text)) });
};
/** A signed GET: since story 1.1 a run's status needs the control-plane signature as well as the key. */
const signedGet = async (path: string) => api("GET", path, undefined, { "x-poc-key": KEY, ...(await signControlPlaneRequest(SIGNING_SECRET, "GET", path)) });
const start = async (graphId: string, payload: unknown = PAYLOAD, workspaceId = WS_A) => {
  const created = await signedRun({ graphId, workspaceId, payload });
  expect(created.status).toBe(202);
  return String(created.json!.id);
};
const status = async (id: string) => (await signedGet(`/poc/runs/${id}`)).json as unknown as Finished;
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
const local = (graph: Graph) => runGraph(graph, proofRegistry, proofExecutors, { payload: PAYLOAD, workspaceId: WS_A });
const sorted = (values: unknown[]) => values.map((v) => JSON.stringify(v)).sort();

beforeAll(async () => {
  const assembled = assemble(INVOICE_FLOW_BLUEPRINT, catalog);
  if (!assembled.ok) throw new Error(assembled.errors.join("; "));
  files = assembled.files;
  const projectDir = join(OUT_DIR, "deploy-test", "workflow");
  await writeProject(projectDir, files);
  // The proof bricks are test fixtures (story 1.1): injected into this test's bundle, never into the shipped one.
  bundle = await bundleWorker({ projectDir, fixtureBricksModule: resolve(import.meta.dirname, "..", "src", "worker", "proof-bricks.ts") });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.code,
      compatibilityDate: "2026-10-01",
      d1Databases: ["DB"],
      bindings: { POC_ACCESS_KEY: KEY, PX_TELEMETRY_SECRET: SIGNING_SECRET },
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
    for (const [method, path, body] of [["PUT", "/poc/graphs/x", "{}"], ["GET", "/poc/graphs/x", undefined], ["POST", "/poc/runs", { graphId: "x" }], ["POST", WORKFLOW_RUNS_PATH, { graphId: "x", workspaceId: WS_A }], ["GET", "/poc/runs/abc", undefined], ["POST", "/poc/write-latency", undefined]] as const) {
      expect((await api(method, path, body, {})).status, `${method} ${path}`).toBe(401);
      expect((await api(method, path, body, { "x-poc-key": "wrong-key-wrong-key-wrong-key" })).status, `${method} ${path} wrong`).toBe(401);
    }
  });

  test("bad requests are refused with a reason, not started", async () => {
    expect((await signedRun({ graphId: "a/b", workspaceId: WS_A })).status).toBe(400);
    expect((await signedRun({ workspaceId: WS_A })).status).toBe(400);
    const notJson = await api("POST", WORKFLOW_RUNS_PATH, "not json", { "x-poc-key": KEY, "content-type": "application/json", ...(await signControlPlaneRequest(SIGNING_SECRET, "POST", WORKFLOW_RUNS_PATH, "not json")) });
    expect(notJson.status).toBe(400);
    expect((await api("PUT", "/poc/graphs/a%20b", "{}")).status).toBe(400);
    expect((await api("PUT", "/poc/graphs/x".padEnd(80, "x"), "{}")).status).toBe(400);
    expect((await signedGet("/poc/runs/no-such-run-id")).status).toBe(404);
    expect((await signedGet("/poc/runs/bad.id")).status).toBe(400);
    expect((await signedRun({ graphId: "x", workspaceId: WS_A, requestId: "not-a-uuid" })).status).toBe(400);
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

  test("a graph stored only for one workspace is invisible to GET /poc/graphs, and runs only for that workspace", async () => {
    await editRow("ws-only", ADD_THEN_MULTIPLY, WS_A);
    expect((await api("GET", "/poc/graphs/ws-only")).status).toBe(404);
    // POST /poc/runs cannot start it whatever the body names; a signed run for B does not see A's row; one for A runs it
    expect((await api("POST", "/poc/runs", { graphId: "ws-only", workspaceId: WS_A, payload: PAYLOAD })).status).toBe(403);
    const forB = await finish(await start("ws-only", PAYLOAD, WS_B));
    expect(forB.status).toBe("errored");
    expect(forB.__LOCAL_DEV_STEP_OUTPUTS).toEqual([]);
    expect((await runAndFinish("ws-only")).output!.outputs.mul).toEqual({ out: 20 });
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

// Story 1.1 (R52): the deployed Workflow runs the real catalog executors for a verified workspace, and only an authenticated
// trigger starts it. The wallet below is the credit-wallet brick's own D1 table in the same local database the Worker uses.
describe("real executors and a verified workspace", () => {
  const DEBIT: Graph = {
    nodes: [node("t", "trigger.manual"), node("pay", "credit-wallet.debit", { amount: 5 })],
    edges: [wire("t", "out", "pay", "in")],
  };
  const db = async () => (await mf.getD1Database("DB")) as unknown as D1Like;
  const openWallets = async (balances: Record<string, number>) => {
    const d = await db();
    for (const [workspaceId, balance] of Object.entries(balances)) {
      await d.prepare("INSERT INTO credit_wallets (workspace_id, balance) VALUES (?1, ?2) ON CONFLICT(workspace_id) DO UPDATE SET balance = excluded.balance").bind(workspaceId, balance).run();
    }
  };
  const balance = async (workspaceId: string) => (await (await db()).prepare("SELECT balance FROM credit_wallets WHERE workspace_id = ?1").bind(workspaceId).first<{ balance: number }>())?.balance ?? null;
  const ledger = async (workspaceId: string) => (await (await db()).prepare("SELECT workspace_id, user_id, amount, balance_after FROM credit_ledger WHERE workspace_id = ?1").bind(workspaceId).all()).results;

  test("BUNDLE_REAL_DEBIT: a signed run for workspace A debits A's wallet with the real executor; B's is untouched", async () => {
    await openWallets({ [WS_A]: 50, [WS_B]: 50 });
    await store("debit", DEBIT);
    const done = await finish(await start("debit", { userId: "u1" }, WS_A));
    expect(done.status).toBe("complete");
    expect(done.output!.ok).toBe(true);
    expect(done.output!.outputs.pay).toEqual({ out: { charged: 5, balanceAfter: 45, duplicate: false } });
    expect(await balance(WS_A)).toBe(45);
    expect(await ledger(WS_A)).toEqual([{ workspace_id: WS_A, user_id: "u1", amount: -5, balance_after: 45 }]);
    expect(await balance(WS_B)).toBe(50);
    expect(await ledger(WS_B)).toEqual([]);
  });

  test("PAYLOAD_SPOOF: a run for A whose payload names B fails WORKSPACE_MISMATCH and debits neither wallet", async () => {
    await openWallets({ [WS_A]: 50, [WS_B]: 50 });
    await store("debit-spoof", DEBIT);
    const before = [await ledger(WS_A), await ledger(WS_B)];
    const done = await finish(await start("debit-spoof", { userId: "u1", workspaceId: WS_B }, WS_A));
    expect(done.status).toBe("complete");
    expect(done.output!.ok).toBe(false);
    expect(done.output!.failed.pay).toMatch(/WORKSPACE_MISMATCH: /); // the engine names the error class first
    expect([await balance(WS_A), await balance(WS_B)]).toEqual([50, 50]);
    expect([await ledger(WS_A), await ledger(WS_B)]).toEqual(before);
  });

  test("POC_RUNS_UNVERIFIED: POST /poc/runs with only the shared key is refused 403 and starts nothing", async () => {
    await openWallets({ [WS_A]: 50 });
    await store("debit-unverified", DEBIT);
    const ledgerBefore = await ledger(WS_A);
    for (const body of [{ graphId: "debit-unverified", payload: { userId: "u1" } }, { graphId: "debit-unverified", workspaceId: WS_A, payload: { userId: "u1", workspaceId: WS_A } }]) {
      const refused = await api("POST", "/poc/runs", body);
      expect(refused.status).toBe(403);
      expect(refused.json).toEqual({ error: expect.objectContaining({ code: "NO_VERIFIED_WORKSPACE" }) });
      expect(refused.json!.id).toBeUndefined();
    }
    // nothing ran: had a Workflow instance been created, its debit would have landed by now
    await new Promise((r) => setTimeout(r, 500));
    expect(await balance(WS_A)).toBe(50);
    expect(await ledger(WS_A)).toEqual(ledgerBefore);
  });

  test("SIGNED_NO_WORKSPACE: a signed run without a workspace is 400; the reserved app workspace and bad ids are refused", async () => {
    const missing = await signedRun({ graphId: "debit" });
    expect(missing.status).toBe(400);
    expect((missing.json!.error as { code: string }).code).toBe("NO_WORKSPACE");
    for (const workspaceId of [APP_WORKSPACE, "ws__x", "a/b", 7]) expect((await signedRun({ graphId: "debit", workspaceId })).status, String(workspaceId)).toBe(400);
  });

  test("the run route accepts only a PX_TELEMETRY_SECRET signature: none, a wrong one, or one made with the access key is 401", async () => {
    const body = JSON.stringify({ requestId: crypto.randomUUID(), graphId: "debit", workspaceId: WS_A, payload: { userId: "u1" } });
    const send = async (headers: Record<string, string> = {}) => api("POST", WORKFLOW_RUNS_PATH, body, { "x-poc-key": KEY, "content-type": "application/json", ...headers });
    expect((await send()).status).toBe(401);
    expect((await send(await signControlPlaneRequest("some-other-secret-0123456789", "POST", WORKFLOW_RUNS_PATH, body))).status).toBe(401);
    expect((await send(await signControlPlaneRequest(KEY, "POST", WORKFLOW_RUNS_PATH, body))).status).toBe(401);
    // the old body-only signature is not enough on this route
    expect((await send({ [TELEMETRY_SIGNATURE_HEADER]: await signTelemetryPayload(body, SIGNING_SECRET) })).status).toBe(401);
  });

  test("REPLAY: the same signed request sent twice is 409 DUPLICATE_REQUEST the second time, and the wallet is debited once", async () => {
    await openWallets({ [WS_A]: 50 });
    await store("debit-replay", DEBIT);
    const before = (await ledger(WS_A)).length;
    const body = JSON.stringify({ requestId: crypto.randomUUID(), graphId: "debit-replay", workspaceId: WS_A, payload: { userId: "u1" } });
    const headers = { "x-poc-key": KEY, "content-type": "application/json", ...(await signControlPlaneRequest(SIGNING_SECRET, "POST", WORKFLOW_RUNS_PATH, body)) };
    const first = await api("POST", WORKFLOW_RUNS_PATH, body, headers);
    expect(first.status).toBe(202);
    expect((await finish(String(first.json!.id))).status).toBe("complete");
    const replay = await api("POST", WORKFLOW_RUNS_PATH, body, headers);
    expect(replay.status).toBe(409);
    expect((replay.json!.error as { code: string }).code).toBe("DUPLICATE_REQUEST");
    await new Promise((r) => setTimeout(r, 300));
    expect(await balance(WS_A)).toBe(45);
    expect((await ledger(WS_A)).length).toBe(before + 1);
  });

  test("a stale or future signing time is 401, and a signature made for another route's path or body does not verify", async () => {
    const body = JSON.stringify({ requestId: crypto.randomUUID(), graphId: "debit", workspaceId: WS_A, payload: { userId: "u1" } });
    const send = async (headers: Record<string, string>) => api("POST", WORKFLOW_RUNS_PATH, body, { "x-poc-key": KEY, "content-type": "application/json", ...headers });
    expect((await send(await signControlPlaneRequest(SIGNING_SECRET, "POST", WORKFLOW_RUNS_PATH, body, Date.now() - 400_000))).status).toBe(401);
    expect((await send(await signControlPlaneRequest(SIGNING_SECRET, "POST", WORKFLOW_RUNS_PATH, body, Date.now() + 400_000))).status).toBe(401);
    expect((await send({ [SIGNED_AT_HEADER]: "not-a-time", [TELEMETRY_SIGNATURE_HEADER]: "sha256=00" })).status).toBe(401);
    expect((await send(await signControlPlaneRequest(SIGNING_SECRET, "POST", "/__px/runs", body))).status).toBe(401);
    expect((await send(await signControlPlaneRequest(SIGNING_SECRET, "GET", WORKFLOW_RUNS_PATH, body))).status).toBe(401);
    expect((await send(await signControlPlaneRequest(SIGNING_SECRET, "POST", WORKFLOW_RUNS_PATH, body.replace(WS_A, WS_B)))).status).toBe(401);
  });

  test("GET /poc/runs/:id needs the control-plane signature: the shared key alone, or a signature for another run, is 401", async () => {
    await store("debit-read", DEBIT);
    const id = await start("debit-read", { userId: "u1" });
    await finish(id);
    expect((await api("GET", `/poc/runs/${id}`)).status).toBe(401);
    expect((await api("GET", `/poc/runs/${id}`, undefined, { "x-poc-key": KEY, ...(await signControlPlaneRequest(SIGNING_SECRET, "GET", "/poc/runs/other")) })).status).toBe(401);
    expect((await signedGet(`/poc/runs/${id}`)).status).toBe(200);
  });
});
