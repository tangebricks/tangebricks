import { createHash } from "node:crypto";
import { runGraph } from "@poc/runtime";
import type { Graph, RunResult } from "@poc/runtime";
import { APP_WORKSPACE, GRAPH_TABLE, LOAD_STEP, nodeStepName } from "./worker/graph-run.ts";
import { proofExecutors, proofRegistry } from "./worker/proof-bricks.ts";
import type { Attempt, ClientLog, UrlEvent } from "./h10.ts";
import type { CallRecord, Client, WorkflowInstance } from "./provisioner/cloudflare.ts";
import type { ResourceNames } from "./provisioner/names.ts";

// The H11 protocol: on the deployed Worker, with no upload, show that one Workflow class runs graphs that live in D1, that
// editing a row changes the next run, and what Cloudflare itself records about each run. See packages/deploy/src/h10.ts
// for how the files are split and why neither is the evidence on its own; the same rules apply here.
//
// Graphs are stored and edited the owner's way: over Cloudflare's D1 REST endpoint, as app-wide rows (APP_WORKSPACE), which
// does not go through the Worker at all. The Worker has no route that writes a graph. After each first store, the Worker is
// asked (GET /poc/graphs/:id, which reads only app-wide rows) to show the row back, so a Worker that cannot see it stops the
// protocol before any run. Evidence recorded before story 0.18 stored through the Worker's old PUT route; it is still read.

const node = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, data });
const wire = (source: string, sourceHandle: string, target: string, targetHandle: string) => ({ id: `${source}.${sourceHandle}-${target}.${targetHandle}`, source, target, sourceHandle, targetHandle });
const pick = (id: string, path: string) => node(id, "transform.pick", { path });

/** (a + b) * c */
const SUM_PRODUCT: Graph = {
  nodes: [node("t", "trigger.manual"), pick("pa", "a"), pick("pb", "b"), pick("pc", "c"), node("add", "proof.add"), node("mul", "proof.multiply")],
  edges: [wire("t", "out", "pa", "in"), wire("t", "out", "pb", "in"), wire("t", "out", "pc", "in"), wire("pa", "out", "add", "a"), wire("pb", "out", "add", "b"), wire("add", "out", "mul", "a"), wire("pc", "out", "mul", "b")],
};
/** (a + b) + c: the same graph with the multiplier swapped for an adder. */
const SUM_SUM: Graph = { ...SUM_PRODUCT, nodes: SUM_PRODUCT.nodes.map((n) => (n.id === "mul" ? node("mul", "proof.add") : n)) };
/** A run that waits four seconds in the middle, long enough to edit its row while it is under way. a + b after the wait. */
export const SLOW_DELAY_MS = 4000;
const SLOW: Graph = {
  nodes: [node("t", "trigger.manual"), pick("pa", "a"), pick("pb", "b"), node("wait", "util.delay", { ms: SLOW_DELAY_MS }), node("add", "proof.add")],
  edges: [wire("t", "out", "pa", "in"), wire("t", "out", "pb", "in"), wire("pa", "out", "wait", "in"), wire("wait", "out", "add", "a"), wire("pb", "out", "add", "b")],
};
const SLOW_EDITED: Graph = { ...SLOW, nodes: SLOW.nodes.map((n) => (n.id === "add" ? node("add", "proof.multiply") : n)) };
const DIAMOND: Graph = {
  nodes: [node("t", "trigger.manual"), node("l", "util.delay", { ms: 50 }), pick("r", "a"), node("j", "util.join")],
  edges: [wire("t", "out", "l", "in"), wire("t", "out", "r", "in"), wire("l", "out", "j", "a"), wire("r", "out", "j", "b")],
};
/** Has a cycle, so the validator must refuse it. */
const CYCLIC: Graph = { nodes: [node("t", "trigger.manual"), node("x", "proof.add"), node("y", "proof.add")], edges: [wire("t", "out", "x", "a"), wire("x", "out", "y", "a"), wire("y", "out", "x", "b")] };

export const H11_GRAPHS = { sum: SUM_PRODUCT, sumEdited: SUM_SUM, slow: SLOW, slowEdited: SLOW_EDITED, diamond: DIAMOND, bad: CYCLIC } as const;
export const H11_IDS = { sum: "h11-sum", slow: "h11-slow", diamond: "h11-diamond", bad: "h11-bad", latency: "__latency_rest__" } as const;
export const H11_PAYLOAD = { a: 2, b: 3, c: 4 };

/** What each named run is supposed to have run. */
const EXPECTED_GRAPH: Record<string, Graph> = { "sum-first": SUM_PRODUCT, "sum-edited": SUM_SUM, "slow-midrun": SLOW, "slow-after": SLOW_EDITED, diamond: DIAMOND };

const UPSERT = `INSERT INTO ${GRAPH_TABLE} (workspace_id, id, graph, updated_at) VALUES ('${APP_WORKSPACE}', ?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ON CONFLICT(workspace_id, id) DO UPDATE SET graph = excluded.graph, updated_at = excluded.updated_at`;
const SELECT_ROW = `SELECT graph, updated_at FROM ${GRAPH_TABLE} WHERE workspace_id = '${APP_WORKSPACE}' AND id = ?1`;
/** The label of the REST client that stores a graph for the n-th time (1-based). */
export const storeLabel = (graphId: string, n: number) => `store-${graphId}-${n}`;

export interface H11Run {
  key: string;
  graphId: string;
  instanceId: string | null;
  /** The row as read over REST just before the run was started. */
  rowText: string | null;
  /** What the Worker's route said when the run ended. */
  workerStatus: { status: string; error?: unknown; output?: unknown } | null;
  /** Cloudflare's own record of the run, read over REST. */
  details: WorkflowInstance | null;
}
export interface Timings {
  timingsMs: number[];
  medianMs: number;
  slowestMs: number;
}
export interface H11Facts {
  names: ResourceNames;
  url: string;
  databaseId: string;
  /** The Worker's version ids, newest first, read just before the first run, just after the edited run, and at the very end. */
  versions: { before: string[] | null; after: string[] | null; final: string[] | null };
  /** The version the H10 evidence says the deploy left behind, if that evidence was available. */
  deployedVersionFromH10: string | null;
  runs: H11Run[];
  /** Every edit, all made over the D1 REST endpoint. updatedAt is the row's own timestamp, read back from D1. */
  edits: Array<{ key: string; graphId: string; client: string; updatedAt: string | null }>;
  /** What was seen of the slow run before it was edited. */
  midRun: { polls: Array<{ status: string; loadDone: boolean; delayDone: boolean }>; tooLate: number } | null;
  latency: { worker: Timings | null; rest: Timings | null };
  workflows: Array<{ name: string; className: string; scriptName: string }> | null;
  attempts: Attempt[];
}
export interface H11Calls {
  schema: 1;
  commandStartedAt: string;
  clients: ClientLog[];
  urlEvents: UrlEvent[];
  facts: H11Facts;
}
export interface H11Result {
  schema: 1;
  commandStartedAt: string;
  finishedAt: string;
  completed: boolean;
  callsSha256: string;
  stoppedBecause?: string;
  leakScan?: { filesScanned: number; found: string[]; scannedFor: string[] };
}

export interface H11Deps {
  clock(): number;
  commandStart: number;
  sleep(ms: number): Promise<void>;
  createClient(now: () => number): Client;
  names: ResourceNames;
  databaseId: string;
  url: string;
  accessKey: string;
  fetchUrl(request: Request): Promise<Response>;
  hide(text: string): string;
  nowIso(): string;
  log?(line: string): void;
  deployedVersionFromH10?: string | null;
  pollIntervalMs?: number;
  runTimeoutMs?: number;
  /** How many times the slow run may be started before giving up on catching it under way. */
  midRunTries?: number;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
export const canonical11 = (calls: H11Calls): string => `${JSON.stringify(calls, null, 2)}\n`;
const terminal = (status: string | undefined) => status === "complete" || status === "errored" || status === "terminated";
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const timings = (values: number[]): Timings => ({ timingsMs: values, medianMs: Math.round(median(values) * 10) / 10, slowestMs: Math.max(...values) });

export async function runH11(deps: H11Deps): Promise<{ calls: H11Calls; result: H11Result }> {
  const rel = () => deps.clock() - deps.commandStart;
  const say = deps.log ?? (() => undefined);
  const clients: ClientLog[] = [];
  const urlEvents: UrlEvent[] = [];
  const facts: H11Facts = { names: deps.names, url: deps.url, databaseId: deps.databaseId, versions: { before: null, after: null, final: null }, deployedVersionFromH10: deps.deployedVersionFromH10 ?? null, runs: [], edits: [], midRun: null, latency: { worker: null, rest: null }, workflows: null, attempts: [] };
  const commandStartedAt = deps.nowIso();
  let stoppedBecause: string | undefined;
  const pollMs = deps.pollIntervalMs ?? 400;

  const attempt = (phase: string, outcome: "ok" | "failed", detail: string) => {
    facts.attempts.push({ n: facts.attempts.length + 1, phase, atMs: Math.round(rel()), outcome, detail: deps.hide(detail).slice(0, 600) });
    say(`[${(rel() / 1000).toFixed(1)}s] ${phase}: ${outcome}${detail ? ` - ${deps.hide(detail).slice(0, 200)}` : ""}`);
  };
  const newClient = (label: string) => {
    const client = deps.createClient(deps.clock);
    clients.push({ label, startedAtMs: Math.round(rel()), calls: client.calls as CallRecord[] });
    return client;
  };
  const sendFor = (phase: string, note?: string) => async (request: Request): Promise<Response> => {
    const started = rel();
    const url = new URL(request.url);
    const event: UrlEvent = { n: urlEvents.length + 1, atMs: Math.round(started), ms: 0, phase, ...(note ? { note } : {}), method: request.method, path: `${url.pathname}${url.search}`, status: null };
    urlEvents.push(event);
    try {
      const response = await deps.fetchUrl(request);
      event.status = response.status;
      return response;
    } finally {
      event.ms = Math.round(rel() - started);
    }
  };
  /** A request to the deployed Worker with the access key; returns the status and the JSON body if there is one. */
  const worker = async (phase: string, method: string, path: string, body?: string, note?: string) => {
    const response = await sendFor(phase, note)(new Request(`${deps.url}${path}`, { method, headers: { "x-poc-key": deps.accessKey, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body ?? null }));
    const text = await response.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // not JSON: the caller sees a null
    }
    return { status: response.status, json };
  };
  const versionsOf = async (label: string) => (await newClient(label).listVersions(deps.names.script))?.map((v) => v.id) ?? null;

  /** The owner's way into their data: Cloudflare's D1 REST endpoint. Writes the row, then reads it back with D1's own clock. */
  const restWrite = async (label: string, graphId: string, graph: unknown) => {
    const client = newClient(label);
    const text = typeof graph === "string" ? graph : JSON.stringify(graph);
    await client.queryDatabase(deps.databaseId, [{ sql: UPSERT, params: [graphId, text] }]);
    const [read] = await client.queryDatabase(deps.databaseId, [{ sql: SELECT_ROW, params: [graphId] }]);
    const row = read!.results[0] as { graph?: string; updated_at?: string } | undefined;
    return { rowText: row?.graph ?? null, updatedAt: row?.updated_at ?? null, client: label };
  };
  const restRead = async (label: string, graphId: string) => {
    const [read] = await newClient(label).queryDatabase(deps.databaseId, [{ sql: SELECT_ROW, params: [graphId] }]);
    return (read!.results[0] as { graph?: string } | undefined)?.graph ?? null;
  };

  const finish = (completed: boolean): { calls: H11Calls; result: H11Result } => {
    const calls: H11Calls = { schema: 1, commandStartedAt, clients, urlEvents, facts };
    const result: H11Result = { schema: 1, commandStartedAt, finishedAt: deps.nowIso(), completed, callsSha256: sha256(canonical11(calls)), ...(stoppedBecause ? { stoppedBecause } : {}) };
    return { calls, result };
  };

  try {
    // ---- the bracket opens: the Worker's version, read just before the first run
    facts.versions.before = await versionsOf("bracket-before");
    attempt("version before the first run", facts.versions.before?.length ? "ok" : "failed", `${facts.versions.before?.length ?? 0} version(s), newest ${facts.versions.before?.[0]?.slice(0, 8) ?? "none"}`);
    if (!facts.versions.before?.length) throw new Error("Cloudflare lists no version for the Worker");

    // ---- which Workflows exist
    facts.workflows = await newClient("workflows").listWorkflowDefinitions();

    // ---- start a run, wait for the Worker's answer, then read Cloudflare's own record of it
    const startRun = async (key: string, graphId: string, rowText: string | null): Promise<H11Run> => {
      const created = await worker("start-run", "POST", "/poc/runs", JSON.stringify({ graphId, payload: H11_PAYLOAD }), key);
      const run: H11Run = { key, graphId, instanceId: created.status === 202 && typeof created.json?.id === "string" ? created.json.id : null, rowText, workerStatus: null, details: null };
      facts.runs.push(run);
      if (!run.instanceId) attempt(`start ${key}`, "failed", `HTTP ${created.status}`);
      return run;
    };
    const endRun = async (run: H11Run) => {
      if (!run.instanceId) return;
      const deadline = rel() + (deps.runTimeoutMs ?? 120_000);
      while (rel() < deadline) {
        const status = await worker("poll-run", "GET", `/poc/runs/${run.instanceId}`, undefined, run.key);
        if (status.json && terminal(String(status.json.status))) {
          run.workerStatus = { status: String(status.json.status), ...(status.json.error ? { error: status.json.error } : {}), ...(status.json.output !== undefined ? { output: status.json.output } : {}) };
          break;
        }
        await deps.sleep(pollMs);
      }
      const reader = newClient(`instance-${run.key}`);
      while (rel() < deadline) {
        const details = await reader.getWorkflowInstance(deps.names.workflow, run.instanceId);
        if (details && terminal(details.status)) {
          run.details = details;
          break;
        }
        await deps.sleep(pollMs);
      }
      attempt(`run ${run.key}`, run.workerStatus && run.details ? "ok" : "failed", `worker says ${run.workerStatus?.status ?? "nothing"}, Cloudflare says ${run.details?.status ?? "nothing"}, ${run.details?.steps.length ?? 0} step(s)`);
    };
    const storesSoFar = new Map<string, number>();
    const store = async (graphId: string, graph: unknown) => {
      const n = (storesSoFar.get(graphId) ?? 0) + 1;
      storesSoFar.set(graphId, n);
      const written = await restWrite(storeLabel(graphId, n), graphId, graph);
      const seen = await worker("check-stored", "GET", `/poc/graphs/${graphId}`);
      if (seen.status !== 200 || seen.json?.graph !== written.rowText) throw new Error(`the Worker did not show ${graphId} back after it was stored over REST (HTTP ${seen.status})`);
    };

    // ---- 1. a stored graph, run; 2. its row edited over REST, run again on the same class and script
    await store(H11_IDS.sum, SUM_PRODUCT);
    const row1 = await restRead("owner-read-1", H11_IDS.sum);
    const first = await startRun("sum-first", H11_IDS.sum, row1);
    await endRun(first);

    const edit1 = await restWrite("owner-edit-1", H11_IDS.sum, SUM_SUM);
    facts.edits.push({ key: "sum-edit", graphId: H11_IDS.sum, client: edit1.client, updatedAt: edit1.updatedAt });
    const second = await startRun("sum-edited", H11_IDS.sum, edit1.rowText);
    await endRun(second);
    facts.versions.after = await versionsOf("bracket-after");
    attempt("version after the edited run", "ok", `${facts.versions.after?.length ?? 0} version(s), newest ${facts.versions.after?.[0]?.slice(0, 8) ?? "none"}`);

    // ---- 3. a run under way while its row is edited
    facts.midRun = { polls: [], tooLate: 0 };
    const tries = deps.midRunTries ?? 3;
    for (let k = 1; k <= tries; k += 1) {
      await store(H11_IDS.slow, SLOW);
      const rowSlow = await restRead(`owner-read-slow-${k}`, H11_IDS.slow);
      const run = await startRun("slow-midrun", H11_IDS.slow, rowSlow);
      if (!run.instanceId) break;
      const reader = newClient(`midrun-watch-${k}`);
      const polls: Array<{ status: string; loadDone: boolean; delayDone: boolean }> = [];
      let caught = false;
      const deadline = rel() + 30_000;
      while (rel() < deadline) {
        const d = await reader.getWorkflowInstance(deps.names.workflow, run.instanceId);
        if (d) {
          const loadDone = d.steps.some((s) => baseName(s.name) === LOAD_STEP && s.end !== null);
          const delayDone = d.steps.some((s) => baseName(s.name) === nodeStepName("wait") && s.end !== null);
          polls.push({ status: d.status, loadDone, delayDone });
          if (loadDone && !delayDone && !terminal(d.status)) {
            caught = true;
            break;
          }
          if (delayDone || terminal(d.status)) break;
        }
        await deps.sleep(pollMs);
      }
      facts.midRun.polls = polls;
      if (!caught) {
        facts.midRun.tooLate += 1;
        run.key = `slow-missed-${k}`;
        attempt("catch the slow run under way", "failed", `try ${k}: it had already passed the wait, or never started`);
        await endRun(run);
        continue;
      }
      const edit = await restWrite("owner-edit-mid", H11_IDS.slow, SLOW_EDITED);
      facts.edits.push({ key: "mid-edit", graphId: H11_IDS.slow, client: edit.client, updatedAt: edit.updatedAt });
      attempt("edit the row under a run", "ok", `try ${k}: edited while the run was waiting`);
      await endRun(run);
      const after = await startRun("slow-after", H11_IDS.slow, edit.rowText);
      await endRun(after);
      break;
    }

    // ---- 4. a third kind of graph through the same class
    await store(H11_IDS.diamond, DIAMOND);
    const diamond = await startRun("diamond", H11_IDS.diamond, await restRead("owner-read-diamond", H11_IDS.diamond));
    await endRun(diamond);

    // ---- 5. a row the validator must refuse, put in over REST
    const bad = await restWrite("owner-edit-bad", H11_IDS.bad, CYCLIC);
    facts.edits.push({ key: "bad-edit", graphId: H11_IDS.bad, client: bad.client, updatedAt: bad.updatedAt });
    const badRun = await startRun("bad", H11_IDS.bad, bad.rowText);
    await endRun(badRun);

    // ---- 6. ten timed writes, inside the Worker and over REST
    const inside = await worker("write-latency", "POST", "/poc/write-latency");
    if (inside.status === 200 && Array.isArray(inside.json?.timingsMs)) facts.latency.worker = { timingsMs: inside.json.timingsMs as number[], medianMs: Number(inside.json.medianMs), slowestMs: Number(inside.json.slowestMs) };
    const rest = newClient("latency-rest");
    for (let i = 0; i < 10; i += 1) await rest.queryDatabase(deps.databaseId, [{ sql: UPSERT, params: [H11_IDS.latency, JSON.stringify({ write: i })] }]);
    facts.latency.rest = timings(rest.calls.filter((c) => c.method === "POST" && c.sqlKind === "write").map((c) => c.ms));
    attempt("ten timed writes", "ok", `inside the Worker: median ${facts.latency.worker?.medianMs} ms; over REST: median ${facts.latency.rest.medianMs} ms`);

    // ---- the bracket closes for good: nothing was uploaded in all of this
    facts.versions.final = await versionsOf("bracket-final");
    attempt("version at the end", "ok", `${facts.versions.final?.length ?? 0} version(s), newest ${facts.versions.final?.[0]?.slice(0, 8) ?? "none"}`);
  } catch (error) {
    stoppedBecause = `stopped: ${deps.hide(error instanceof Error ? error.message : String(error)).slice(0, 1500)}`;
    attempt("protocol", "failed", stoppedBecause);
    return finish(false);
  }
  return finish(true);
}

// ---------------------------------------------------------------------------------------------------------------------

/** Cloudflare numbers repeated step names ("node:t-1"); the number is not part of the name this code gave. */
export const baseName = (name: string): string => name.replace(/-\d+$/, "");
/** A spelling of a value that does not depend on the order its keys were written in. */
export function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canon((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const same = (a: unknown, b: unknown) => canon(a) === canon(b);

/**
 * What this repository's own interpreter gives for a graph, computed here and not read from any file. The wait in a graph is
 * skipped (a delay hands its input through unchanged, so skipping the wait cannot change an answer), which keeps this fast.
 */
export async function localAnswer(graph: Graph): Promise<RunResult> {
  const executors = new Map(proofExecutors);
  executors.set("util.delay", ({ inputs }) => ({ out: inputs.in }));
  return runGraph(graph, proofRegistry, executors, { payload: H11_PAYLOAD });
}

export interface H11EvaluationInput {
  callsText: string;
  result: H11Result;
}
export interface H11Evaluation {
  checks: Record<string, boolean>;
  notes: string[];
}

const isQuery = (c: CallRecord) => c.method === "POST" && /\/d1\/database\/[^/]+\/query$/.test(c.path);
const logOf = (calls: H11Calls, label: string) => calls.clients.find((c) => c.label === label);

export async function evaluateH11(input: H11EvaluationInput): Promise<H11Evaluation> {
  const notes: string[] = [];
  const checks: Record<string, boolean> = {};
  let calls: H11Calls;
  try {
    calls = JSON.parse(input.callsText) as H11Calls;
  } catch {
    return { checks, notes: ["the calls file is not valid JSON; nothing in it is believed"] };
  }
  if (sha256(input.callsText) !== input.result.callsSha256 || input.callsText !== canonical11(calls)) {
    return { checks, notes: ["the calls file does not match the hash in the result file (one of them was edited, or they come from different runs); nothing in them is believed"] };
  }
  const f = calls.facts;
  notes.push(`from the run that started ${calls.commandStartedAt}${input.result.completed ? "" : " (it did not complete)"}`);
  const run = (key: string) => f.runs.find((r) => r.key === key);
  type EndedRun = H11Run & { details: WorkflowInstance; workerStatus: NonNullable<H11Run["workerStatus"]> };
  const ended = (r: H11Run | undefined): r is EndedRun => r !== undefined && r.details !== null && r.workerStatus !== null;
  const completeRun = (r: H11Run | undefined): r is EndedRun => ended(r) && r.details.status === "complete" && r.workerStatus.status === "complete";
  const stepsOf = (r: H11Run) => r.details?.steps ?? [];
  const loadStep = (r: H11Run) => stepsOf(r).find((s) => baseName(s.name) === LOAD_STEP);
  const graphKeys = ["sum-first", "sum-edited", "slow-midrun", "slow-after", "diamond"];

  // 1. one class ran every graph
  {
    const runs = graphKeys.map(run);
    const wf = f.workflows ?? [];
    const started = urlStarts(calls);
    checks.oneWorkflowClassRanAllGraphs = runs.every(completeRun) && new Set(runs.map((r) => r!.graphId)).size >= 3 && wf.length === 1 && wf[0]!.name === f.names.workflow && wf[0]!.className === "GraphRunner" && wf[0]!.scriptName === f.names.script && started.length === f.runs.filter((r) => r.instanceId).length && started.every((e) => e.status === 202);
  }

  // 2. the graph a run used is the row in D1
  checks.graphReadFromD1 = graphKeys.every((k) => {
    const r = run(k);
    const expected = EXPECTED_GRAPH[k]!;
    const load = r && ended(r) ? loadStep(r) : undefined;
    return load !== undefined && same(load.output, expected) && r!.rowText !== null && same(safeJson(r!.rowText), expected);
  });

  // 3. an edit made over REST changed the next run
  {
    const r1 = run("sum-first");
    const r2 = run("sum-edited");
    const edit = f.edits.find((e) => e.key === "sum-edit");
    const editLog = edit ? logOf(calls, edit.client) : undefined;
    // Stores of the graph: over REST (store-<id>-<n> clients with a write), or, in evidence recorded before story 0.18, through
    // the Worker's old PUT route. Either way it is stored exactly once, so the only change between the two runs is the edit.
    const restStores = calls.clients.filter((c) => c.label.startsWith(`store-${H11_IDS.sum}-`) && c.calls.some((k) => isQuery(k) && k.sqlKind === "write")).length;
    const storesOfSum = restStores + calls.urlEvents.filter((e) => e.phase === "store-graph" && e.path === `/poc/graphs/${H11_IDS.sum}`).length;
    if (completeRun(r1) && completeRun(r2) && edit?.updatedAt) {
      const [l1, l2] = await Promise.all([localAnswer(SUM_PRODUCT), localAnswer(SUM_SUM)]);
      checks.editChangedNextRun = !same(r1.details.output, r2.details.output) && same(r1.details.output, l1) && same(r2.details.output, l2) && (editLog?.calls.some((c) => isQuery(c) && c.sqlKind === "write") ?? false) && storesOfSum === 1 && r1.graphId === r2.graphId && r1.workerStatus.status === "complete";
    }
  }

  // 4. the Worker's script did not change
  {
    const { before, after, final } = f.versions;
    const allClients = calls.clients.flatMap((c) => c.calls);
    const onlyReadsAndRowWrites = allClients.every((c) => c.method === "GET" || isQuery(c));
    const sameIds = before !== null && after !== null && final !== null && before.length > 0 && before[0] === after[0] && after[0] === final[0] && before.length === after.length && after.length === final.length;
    const h10Link = f.deployedVersionFromH10 === null || f.deployedVersionFromH10 === before?.[0];
    const firstRun = calls.urlEvents.find((e) => e.phase === "start-run");
    const lastRunPoll = calls.urlEvents.filter((e) => e.phase === "poll-run" && e.note === "sum-edited").at(-1);
    const bracketBefore = logOf(calls, "bracket-before");
    const bracketAfter = logOf(calls, "bracket-after");
    const bracketOrdered = bracketBefore !== undefined && bracketAfter !== undefined && firstRun !== undefined && lastRunPoll !== undefined && bracketBefore.startedAtMs <= firstRun.atMs && bracketAfter.startedAtMs >= lastRunPoll.atMs;
    checks.scriptVersionUnchanged = sameIds && onlyReadsAndRowWrites && h10Link && bracketOrdered;
    if (!h10Link) notes.push("the Worker's newest version is not the one the H10 evidence says the deploy left behind: something uploaded in between");
  }

  // 5. every result is the interpreter's own
  {
    let all = true;
    for (const k of graphKeys) {
      const r = run(k);
      if (!completeRun(r)) {
        all = false;
        continue;
      }
      const local = await localAnswer(EXPECTED_GRAPH[k]!);
      all = all && same(r.details.output, local) && same(r.workerStatus.output, local);
    }
    checks.resultsMatchLocalInterpreter = all;
  }

  // 6. every node ran inside its own step, and the step holds that node's own output
  {
    let all = true;
    for (const k of graphKeys) {
      const r = run(k);
      if (!completeRun(r)) {
        all = false;
        continue;
      }
      const local = await localAnswer(EXPECTED_GRAPH[k]!);
      const wanted = [LOAD_STEP, ...Object.keys(local.outputs).map(nodeStepName)].sort();
      const steps = stepsOf(r);
      const names = steps.map((s) => baseName(s.name)).sort();
      all = all && same(names, wanted) && steps.every((s) => s.type === "step" && s.success === true && s.attempts === 1) && Object.entries(local.outputs).every(([id, out]) => same(steps.find((s) => baseName(s.name) === nodeStepName(id))?.output, out));
    }
    checks.everyNodeRanInsideStepDo = all;
  }

  // 7. a run keeps the graph it started with
  {
    const r3 = run("slow-midrun");
    const r4 = run("slow-after");
    const edit = f.edits.find((e) => e.key === "mid-edit");
    const watched = f.midRun?.polls.at(-1);
    if (completeRun(r3) && completeRun(r4) && edit?.updatedAt) {
      const [original, edited] = await Promise.all([localAnswer(SLOW), localAnswer(SLOW_EDITED)]);
      const load = loadStep(r3);
      const delayStep = stepsOf(r3).find((s) => baseName(s.name) === nodeStepName("wait"));
      const editAt = Date.parse(edit.updatedAt);
      const inFlight = load?.end != null && delayStep?.end != null && Date.parse(load.end) < editAt && editAt < Date.parse(delayStep.end);
      checks.runKeepsItsGraphWhenEditedMidRun = same(r3.details.output, original) && !same(r3.details.output, edited) && same(r4.details.output, edited) && inFlight && watched?.loadDone === true && watched.delayDone === false && same(load?.output, SLOW);
      if (!inFlight) notes.push("the edit was not shown to land between the end of the run's first step and the end of its wait");
    }
  }

  // 8. a graph the validator refuses ends the run before any node
  {
    const r = run("bad");
    if (ended(r)) {
      const steps = stepsOf(r);
      checks.badEditRefusedBeforeAnyStep = r.details.status === "errored" && r.workerStatus.status === "errored" && steps.length >= 1 && steps.every((s) => baseName(s.name) === LOAD_STEP) && !steps.some((s) => s.name.startsWith("node:")) && steps.some((s) => s.success === false) && r.rowText !== null && same(safeJson(r.rowText), CYCLIC) && r.details.output == null;
      notes.push(`the refused run's error, as Cloudflare records it: ${JSON.stringify(r.details.error)?.slice(0, 300)}`);
    }
  }

  // 9. write latency
  {
    const { worker, rest } = f.latency;
    const restCalls = (logOf(calls, "latency-rest")?.calls ?? []).filter((c) => c.method === "POST" && c.sqlKind === "write").map((c) => c.ms);
    const ok = (t: Timings | null, source?: number[]) => t !== null && t.timingsMs.length === 10 && t.timingsMs.every((x) => Number.isFinite(x) && x >= 0) && Math.abs(t.medianMs - Math.round(median(t.timingsMs) * 10) / 10) <= 0.1 && t.slowestMs === Math.max(...t.timingsMs) && (source === undefined || same(t.timingsMs, source));
    checks.writeLatencyRecorded = ok(worker) && ok(rest, restCalls);
    if (worker && rest) notes.push(`ten writes: inside the Worker median ${worker.medianMs} ms, slowest ${worker.slowestMs} ms; over the D1 REST endpoint median ${rest.medianMs} ms, slowest ${rest.slowestMs} ms`);
  }

  notes.push(`the Worker's newest version before the first run and after the edited run: ${f.versions.before?.[0] ?? "unknown"} and ${f.versions.after?.[0] ?? "unknown"} (${f.versions.before?.length ?? "?"} version(s) both times)`);
  if (f.midRun && f.midRun.tooLate > 0) notes.push(`the slow run was started ${f.midRun.tooLate + 1} times before an edit landed under it`);
  return { checks, notes };
}

function urlStarts(calls: H11Calls): UrlEvent[] {
  return calls.urlEvents.filter((e) => e.phase === "start-run");
}
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
