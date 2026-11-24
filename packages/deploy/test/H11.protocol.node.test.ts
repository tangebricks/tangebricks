import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { assemble } from "@poc/assembler";
import { parseHypotheses, verdict } from "@poc/harness";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { catalog } from "../../assembler/catalog.generated.ts";
import { INVOICE_FLOW_BLUEPRINT } from "../../../test/support/blueprints.ts";
import { OUT_DIR, writeProject } from "../../../test/support/emitted.ts";
import { bundleWorker } from "../src/bundle.ts";
import { H11_GRAPHS, H11_IDS, SLOW_DELAY_MS, baseName, canon, canonical11, evaluateH11, localAnswer, runH11, storeLabel } from "../src/h11.ts";
import type { H11Calls, H11Deps, H11Result } from "../src/h11.ts";
import { APP_WORKSPACE, GRAPH_MIGRATIONS, GRAPH_TABLE, WORKFLOW_BINDING, WORKFLOW_CLASS } from "../src/worker/graph-run.ts";
import { createClient, createRedactor, findSecrets, migrationsFrom, resourceNames } from "../src/provisioner/index.ts";
import { createFakeCloudflare } from "./support/fake-cloudflare.ts";

// Story 5.6, rehearsed. The H11 protocol runs against a real workerd that runs the real bundle and the real local Workflow
// engine; Cloudflare's REST side is the fake, with two bridges so the rehearsal is coherent: D1 REST queries are carried out
// on the same local database the Worker reads, and Cloudflare's record of a run is built from what the local engine reports.
// That record is a stand-in: only the real account shows what Cloudflare itself writes down (story 5.6's real run).
const root = resolve(import.meta.dirname, "..", "..", "..");
const TOKEN = "cfut_Zq8rLm3VxN2pTb7YkWd4HsJc9GaE5uRo6QiXf1BvPn0AyMt";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const KEY = "9f".repeat(32);
const SUFFIX = "0a1b2c3d";
const names = resourceNames(SUFFIX);
const URL_BASE = `https://${names.script}.fake-subdomain.workers.dev`;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const h11 = parseHypotheses(JSON.parse(readFileSync(join(root, "hypotheses.json"), "utf8"))).hypotheses.find((h) => h.id === "H11")!;
const NINE = ["oneWorkflowClassRanAllGraphs", "graphReadFromD1", "editChangedNextRun", "scriptVersionUnchanged", "resultsMatchLocalInterpreter", "everyNodeRanInsideStepDo", "runKeepsItsGraphWhenEditedMidRun", "badEditRefusedBeforeAnyStep", "writeLatencyRecorded"];

let mf: Miniflare;
let db: D1Like;
const startedAt = new Map<string, number>();

beforeAll(async () => {
  const assembled = assemble(INVOICE_FLOW_BLUEPRINT, catalog);
  if (!assembled.ok) throw new Error(assembled.errors.join("; "));
  const projectDir = join(OUT_DIR, "deploy-test", "h11");
  await writeProject(projectDir, assembled.files);
  const bundle = await bundleWorker({ projectDir });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.code,
      compatibilityDate: "2026-10-01",
      d1Databases: ["DB"],
      bindings: { POC_ACCESS_KEY: KEY },
      workflows: { [WORKFLOW_BINDING]: { name: names.workflow, className: WORKFLOW_CLASS } },
    } as never),
  );
  await mf.ready;
  db = (await mf.getD1Database("DB")) as unknown as D1Like;
  for (const m of [...migrationsFrom(assembled.files), ...GRAPH_MIGRATIONS]) await applyMigration(db, m.sql);
}, 90_000);
afterAll(async () => {
  await mf?.dispose();
});

const fromWorker = async (path: string, init: { method?: string; body?: string } = {}) => {
  const response = (await mf.dispatchFetch(`http://deployed.invalid${path}`, { method: init.method ?? "GET", headers: { "x-poc-key": KEY, "content-type": "application/json" }, body: init.body } as never)) as unknown as Response;
  return response;
};

/** Cloudflare's record of a run, built from what the local engine reports. The real thing is read on the real account. */
async function synthesize(instanceId: string, options: { delayAlreadyDone?: boolean }): Promise<unknown | null> {
  const response = await fromWorker(`/poc/runs/${instanceId}`);
  if (response.status !== 200) return null;
  const st = (await response.json()) as { status: string; output?: { outputs: Record<string, unknown> } | null; error?: { name?: string; message?: string } | null; __LOCAL_DEV_STEP_OUTPUTS?: unknown[] };
  const t0 = startedAt.get(instanceId) ?? Date.now();
  const iso = (ms: number) => new Date(t0 + ms).toISOString();
  const stored = st.__LOCAL_DEV_STEP_OUTPUTS?.[0] as { nodes?: unknown[] } | undefined;
  const loaded = stored !== undefined;
  const step = (name: string, output: unknown, start: number, end: number, success = true) => ({ type: "step", name: `${name}-1`, success, attempts: [{ start: iso(start), end: iso(end), success }], start: iso(start), end: iso(end), output: JSON.stringify(output) });
  const steps: unknown[] = [];
  const hasDelay = JSON.stringify(stored ?? {}).includes('"util.delay"') && JSON.stringify(stored ?? {}).includes(`"ms":${SLOW_DELAY_MS}`);
  if (loaded) steps.push(step("load graph", stored, 0, 1));
  if (st.status === "complete" && st.output) {
    let at = 2;
    for (const [id, out] of Object.entries(st.output.outputs)) {
      const isWait = id === "wait";
      steps.push(step(`node:${id}`, out, at, isWait ? 1 + SLOW_DELAY_MS : at + 10));
      at += isWait ? 0 : 10;
    }
  } else if (options.delayAlreadyDone && hasDelay) {
    steps.push(step("node:wait", { out: 2 }, 2, 3));
  } else if (st.status === "errored") {
    steps.length = 0;
    steps.push({ type: "step", name: "load graph-1", success: false, attempts: [{ start: iso(0), end: iso(1), success: false }], start: iso(0), end: iso(1) });
  }
  return { status: st.status === "complete" || st.status === "errored" ? st.status : "running", success: st.status === "complete", error: st.error ?? null, output: st.output ?? null, params: {}, start: iso(0), end: st.status === "complete" || st.status === "errored" ? iso(SLOW_DELAY_MS + 10) : null, step_count: steps.length, steps };
}

interface WorldOptions {
  delayAlreadyDone?: boolean;
  midRunTries?: number;
  detailsNeverArrive?: boolean;
  /** Cloudflare's record of a run lags behind: it says "running" this many times before it says what the run did. */
  detailsLagCalls?: number;
  runTimeoutMs?: number;
  onFetch?: (request: Request) => void;
}
async function world(options: WorldOptions = {}) {
  const lagSeen = new Map<string, number>();
  const fake = createFakeCloudflare({
    token: TOKEN,
    accountId: ACCOUNT,
    instanceDetails: options.detailsNeverArrive ? () => null : async (_workflow, id) => {
      const seen = (lagSeen.get(id) ?? 0) + 1;
      lagSeen.set(id, seen);
      const details = (await synthesize(id, { delayAlreadyDone: options.delayAlreadyDone })) as { status: string; steps: unknown[] } | null;
      return details && seen <= (options.detailsLagCalls ?? 0) && details.status !== "running" ? { ...details, status: "running", steps: details.steps.slice(0, 1), output: null, end: null } : details;
    },
  });
  fake.seedScript(names.script, `export class ${WORKFLOW_CLASS} {}`);
  await fake.fetch(new Request(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workflows/${names.workflow}`, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ class_name: WORKFLOW_CLASS, script_name: names.script }) }));
  const hide = createRedactor([TOKEN, ACCOUNT, KEY]);
  const lines: string[] = [];
  // D1 REST queries go to the local database the Worker reads; everything else goes to the fake
  const bridge = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "POST" && /\/d1\/database\/[^/]+\/query$/.test(url.pathname)) {
      const body = (await request.json()) as { sql?: string; params?: unknown[]; batch?: Array<{ sql: string; params?: unknown[] }> };
      const results = [];
      for (const s of body.batch ?? [{ sql: body.sql!, params: body.params }]) {
        const statement = db.prepare(s.sql).bind(...(s.params ?? []));
        if (/^\s*select/i.test(s.sql)) results.push({ results: (await statement.all()).results, success: true, meta: {} });
        else results.push({ results: [], success: true, meta: { changes: (await statement.run()).meta.changes } });
      }
      return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: results }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return fake.fetch(request);
  };
  const deps: H11Deps = {
    clock: () => performance.now(),
    commandStart: performance.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 30))),
    createClient: (now) => createClient({ credentials: { token: TOKEN, accountId: ACCOUNT }, fetch: bridge, now, sleep: async () => undefined, alsoHide: [KEY] }),
    names,
    databaseId: "db-1",
    url: URL_BASE,
    accessKey: KEY,
    fetchUrl: async (request) => {
      options.onFetch?.(request);
      const url = new URL(request.url);
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
      const response = (await mf.dispatchFetch(`http://deployed.invalid${url.pathname}${url.search}`, { method: request.method, headers: Object.fromEntries(request.headers), body } as never)) as unknown as Response;
      if (request.method === "POST" && url.pathname === "/poc/runs" && response.status === 202) {
        const created = (await response.clone().json()) as { id: string };
        startedAt.set(created.id, Date.now());
      }
      return response;
    },
    hide,
    nowIso: () => "2026-10-21T00:00:00.000Z",
    log: (line) => lines.push(line),
    pollIntervalMs: 20,
    runTimeoutMs: options.runTimeoutMs ?? 60_000,
    midRunTries: options.midRunTries,
    deployedVersionFromH10: null,
  };
  return { fake, deps, lines, hide };
}

let complete: { calls: H11Calls; result: H11Result; lines: string[] };
async function runComplete() {
  const w = await world();
  const { calls, result } = await runH11(w.deps);
  return { calls, result, lines: w.lines };
}
const rehash = (calls: H11Calls, result: H11Result): [string, H11Result] => {
  const text = canonical11(calls);
  return [text, { ...result, callsSha256: sha(text) }];
};
const evaluate = (calls: H11Calls | string, result: H11Result) => evaluateH11({ callsText: typeof calls === "string" ? calls : canonical11(calls), result });
const tampered = async (edit: (c: H11Calls) => void) => {
  const calls = clone(complete.calls);
  edit(calls);
  const [text, result] = rehash(calls, complete.result);
  return evaluate(text, result);
};
const runOf = (c: H11Calls, key: string) => c.facts.runs.find((r) => r.key === key)!;

beforeAll(async () => {
  complete = await runComplete();
}, 180_000);

describe("a complete rehearsal", () => {
  test("all four sections ran and nothing stopped it", () => {
    expect(complete.result.completed).toBe(true);
    expect(complete.result.stoppedBecause).toBeUndefined();
    expect(complete.calls.facts.runs.map((r) => r.key)).toEqual(["sum-first", "sum-edited", "slow-midrun", "slow-after", "diamond", "bad"]);
    expect(complete.calls.facts.attempts.filter((a) => a.outcome === "failed")).toEqual([]);
  });

  test("every store and every edit was made over the D1 REST endpoint, the sum graph was stored only once, and nothing was written through the Worker", () => {
    expect(complete.calls.facts.edits.map((e) => [e.key, e.graphId])).toEqual([["sum-edit", H11_IDS.sum], ["mid-edit", H11_IDS.slow], ["bad-edit", H11_IDS.bad]]);
    for (const e of complete.calls.facts.edits) {
      expect(e.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(complete.calls.clients.find((c) => c.label === e.client)!.calls.some((c) => c.method === "POST" && c.sqlKind === "write")).toBe(true);
    }
    const storesOfSum = complete.calls.clients.filter((c) => c.label.startsWith(`store-${H11_IDS.sum}-`));
    expect(storesOfSum.map((c) => c.label)).toEqual([storeLabel(H11_IDS.sum, 1)]);
    expect(storesOfSum[0]!.calls.some((c) => c.method === "POST" && c.sqlKind === "write")).toBe(true);
    // the Worker was only read from and asked to start runs: no PUT, and no store through it
    expect(complete.calls.urlEvents.filter((e) => e.method === "PUT" || e.phase === "store-graph")).toEqual([]);
    expect(complete.calls.urlEvents.filter((e) => e.phase === "check-stored").every((e) => e.method === "GET" && e.status === 200)).toBe(true);
  });

  test("the slow run was caught under way: the first step done, the wait not", () => {
    const polls = complete.calls.facts.midRun!.polls;
    expect(polls.at(-1)).toMatchObject({ loadDone: true, delayDone: false });
    expect(complete.calls.facts.midRun!.tooLate).toBe(0);
  });

  test("the Worker's version was read three times and never changed, and nothing but reads and row writes was sent to Cloudflare", () => {
    const v = complete.calls.facts.versions;
    expect(v.before).toHaveLength(1);
    expect(v.after).toEqual(v.before);
    expect(v.final).toEqual(v.before);
    for (const c of complete.calls.clients.flatMap((x) => x.calls)) expect(c.method === "GET" || /\/query$/.test(c.path)).toBe(true);
  });

  test("ten timings from inside the Worker and ten from the REST endpoint are kept", () => {
    expect(complete.calls.facts.latency.worker!.timingsMs).toHaveLength(10);
    expect(complete.calls.facts.latency.rest!.timingsMs).toHaveLength(10);
    expect(complete.calls.facts.latency.rest!.timingsMs.length).toBe(complete.calls.clients.find((c) => c.label === "latency-rest")!.calls.filter((c) => c.sqlKind === "write").length);
  });

  test("neither the token, the account id nor the access key is in the files or the lines printed", () => {
    expect(findSecrets(canonical11(complete.calls) + JSON.stringify(complete.result) + complete.lines.join("\n"), { token: TOKEN, accountId: ACCOUNT, accessKey: KEY })).toEqual([]);
  });
});

describe("what the files say when re-read", () => {
  test("all nine checks come out true, and the verdict is a pass", async () => {
    const e = await evaluate(complete.calls, complete.result);
    expect(Object.keys(e.checks).sort()).toEqual([...NINE].sort());
    expect(e.checks).toEqual(Object.fromEntries(NINE.map((n) => [n, true])));
    expect(verdict(h11, { checks: e.checks }).verdict).toBe("pass");
    expect(e.notes.join("\n")).toMatch(/ten writes: inside the Worker median .* over the D1 REST endpoint median/);
  });

  test("the answers are the interpreter's own: (2+3)*4 = 20, then (2+3)+4 = 9, and the slow run 5 then 6", async () => {
    expect((await localAnswer(H11_GRAPHS.sum)).outputs.mul).toEqual({ out: 20 });
    expect((await localAnswer(H11_GRAPHS.sumEdited)).outputs.mul).toEqual({ out: 9 });
    expect(runOf(complete.calls, "sum-first").details!.output).toMatchObject({ outputs: { mul: { out: 20 } } });
    expect(runOf(complete.calls, "sum-edited").details!.output).toMatchObject({ outputs: { mul: { out: 9 } } });
    expect(runOf(complete.calls, "slow-midrun").details!.output).toMatchObject({ outputs: { add: { out: 5 } } });
    expect(runOf(complete.calls, "slow-after").details!.output).toMatchObject({ outputs: { add: { out: 6 } } });
  });

  test("a calls file edited without the hash being updated, or a result file pointing at another file, is not believed at all", async () => {
    const edited = canonical11(complete.calls).replace('"status": "complete"', '"status": "errored"');
    expect((await evaluate(edited, complete.result)).checks).toEqual({});
    expect((await evaluate(complete.calls, { ...complete.result, callsSha256: "0".repeat(64) })).notes.join(" ")).toMatch(/does not match the hash/);
    expect((await evaluate("not json", complete.result)).notes.join(" ")).toMatch(/not valid JSON/);
  });

  test("a result that is not the interpreter's fails 'results match', in the output or in the Worker's own answer", async () => {
    expect((await tampered((c) => void (runOf(c, "sum-edited").details!.output = { ok: true, outputs: {}, failed: {}, skipped: [] }))).checks.resultsMatchLocalInterpreter).toBe(false);
    expect((await tampered((c) => void ((runOf(c, "diamond").workerStatus!.output as { ok: boolean }).ok = false))).checks.resultsMatchLocalInterpreter).toBe(false);
  });

  test("an edit that changed nothing, or was made through the Worker, or with no write in its log, is not an edit that changed the next run", async () => {
    expect((await tampered((c) => void (runOf(c, "sum-edited").details!.output = runOf(c, "sum-first").details!.output))).checks.editChangedNextRun).toBe(false);
    expect((await tampered((c) => void c.urlEvents.push({ n: 999, atMs: 1, ms: 1, phase: "store-graph", method: "PUT", path: `/poc/graphs/${H11_IDS.sum}`, status: 200 }))).checks.editChangedNextRun).toBe(false);
    // a second store of the same graph over REST is not "the edit" either
    expect((await tampered((c) => void c.clients.push({ ...c.clients.find((x) => x.label === storeLabel(H11_IDS.sum, 1))!, label: storeLabel(H11_IDS.sum, 2) }))).checks.editChangedNextRun).toBe(false);
    expect((await tampered((c) => void (c.clients.find((x) => x.label === "owner-edit-1")!.calls = c.clients.find((x) => x.label === "owner-edit-1")!.calls.filter((k) => k.sqlKind !== "write")))).checks.editChangedNextRun).toBe(false);
  });

  test("a Worker whose version moved, in any of the three readings, or that was written to other than by rows, fails — and a newest version that is not the one H10 left does too", async () => {
    for (const where of ["before", "after", "final"] as const) {
      const e = await tampered((c) => void (c.facts.versions[where] = ["another-version-id"]));
      expect(e.checks.scriptVersionUnchanged, where).toBe(false);
    }
    expect((await tampered((c) => void (c.facts.versions.after = [...c.facts.versions.after!, "extra"]))).checks.scriptVersionUnchanged).toBe(false);
    expect((await tampered((c) => void c.clients.find((x) => x.label === "bracket-final")!.calls.push({ n: 99, atMs: 0, method: "PUT", path: "/accounts/{account}/workers/scripts/x", status: 200, ms: 1, outcome: "ok", attempt: 1 }))).checks.scriptVersionUnchanged).toBe(false);
    expect((await tampered((c) => void (c.facts.deployedVersionFromH10 = "some-other-version"))).checks.scriptVersionUnchanged).toBe(false);
  });

  test("the bracket is judged by its order: a reading taken after the runs began is not 'just before'", async () => {
    expect((await tampered((c) => void (c.clients.find((x) => x.label === "bracket-before")!.startedAtMs = 10 ** 9))).checks.scriptVersionUnchanged).toBe(false);
    expect((await tampered((c) => void (c.clients.find((x) => x.label === "bracket-after")!.startedAtMs = 0))).checks.scriptVersionUnchanged).toBe(false);
  });

  test("a step that is missing, doubled, renamed, retried, failed or carries the wrong output fails 'every node ran inside its own step'", async () => {
    for (const edit of [
      (c: H11Calls) => void runOf(c, "sum-first").details!.steps.splice(2, 1),
      (c: H11Calls) => void runOf(c, "sum-first").details!.steps.push({ ...runOf(c, "sum-first").details!.steps[1]! }),
      (c: H11Calls) => void (runOf(c, "sum-first").details!.steps[2]!.name = "something else-1"),
      (c: H11Calls) => void (runOf(c, "sum-first").details!.steps[2]!.attempts = 2),
      (c: H11Calls) => void (runOf(c, "sum-first").details!.steps[2]!.success = false),
      (c: H11Calls) => void (runOf(c, "sum-first").details!.steps[2]!.output = { out: 999 }),
      (c: H11Calls) => void (runOf(c, "sum-first").details!.steps[1]!.type = "sleep"),
    ]) expect((await tampered(edit)).checks.everyNodeRanInsideStepDo).toBe(false);
  });

  test("the step names carry Cloudflare's own numbering, which is not part of the name", () => {
    expect(runOf(complete.calls, "sum-first").details!.steps.map((s) => s.name)[0]).toBe("load graph-1");
    expect(baseName("load graph-1")).toBe("load graph");
    expect(baseName("node:pa-12")).toBe("node:pa");
    expect(baseName("node:a-b-1")).toBe("node:a-b");
  });

  test("a run that read a different graph from the one in the row, or a row that is not the intended graph, fails 'read from D1'", async () => {
    expect((await tampered((c) => void (runOf(c, "sum-edited").details!.steps[0]!.output = H11_GRAPHS.sum))).checks.graphReadFromD1).toBe(false);
    expect((await tampered((c) => void (runOf(c, "sum-first").rowText = JSON.stringify(H11_GRAPHS.sumEdited)))).checks.graphReadFromD1).toBe(false);
    expect((await tampered((c) => void (runOf(c, "diamond").rowText = null))).checks.graphReadFromD1).toBe(false);
  });

  test("one class, any graph: fewer than three kinds of graph, a second Workflow, or a run that was never started through the route fails", async () => {
    expect((await tampered((c) => void (runOf(c, "diamond").graphId = H11_IDS.sum))).checks.oneWorkflowClassRanAllGraphs).toBe(false);
    expect((await tampered((c) => void c.facts.workflows!.push({ name: "another", className: "GraphRunner", scriptName: "x" }))).checks.oneWorkflowClassRanAllGraphs).toBe(false);
    expect((await tampered((c) => void (c.facts.workflows = []))).checks.oneWorkflowClassRanAllGraphs).toBe(false);
    expect((await tampered((c) => void (c.urlEvents.find((e) => e.phase === "start-run")!.status = 500))).checks.oneWorkflowClassRanAllGraphs).toBe(false);
  });

  test("an edit that did not land while the run was under way fails 'keeps its graph' — before the first step ended, after the wait ended, or with a wrong answer", async () => {
    const stamp = (ms: number) => new Date(ms).toISOString();
    const base = Date.parse(runOf(complete.calls, "slow-midrun").details!.steps[0]!.end!);
    expect((await tampered((c) => void (c.facts.edits.find((e) => e.key === "mid-edit")!.updatedAt = stamp(base - 1000)))).checks.runKeepsItsGraphWhenEditedMidRun).toBe(false);
    expect((await tampered((c) => void (c.facts.edits.find((e) => e.key === "mid-edit")!.updatedAt = stamp(base + 60_000)))).checks.runKeepsItsGraphWhenEditedMidRun).toBe(false);
    expect((await tampered((c) => void (runOf(c, "slow-midrun").details!.output = runOf(c, "slow-after").details!.output))).checks.runKeepsItsGraphWhenEditedMidRun).toBe(false);
    expect((await tampered((c) => void (c.facts.midRun!.polls.at(-1)!.delayDone = true))).checks.runKeepsItsGraphWhenEditedMidRun).toBe(false);
    expect((await tampered((c) => void (runOf(c, "slow-after").details!.output = runOf(c, "slow-midrun").details!.output))).checks.runKeepsItsGraphWhenEditedMidRun).toBe(false);
    expect((await tampered((c) => void (runOf(c, "slow-midrun").details!.steps[0]!.output = H11_GRAPHS.slowEdited))).checks.runKeepsItsGraphWhenEditedMidRun).toBe(false);
  });

  test("a refused graph that ran a node, was not refused, or was never stored fails 'refused before any step'", async () => {
    expect((await tampered((c) => void runOf(c, "bad").details!.steps.push({ type: "step", name: "something-else-1", success: true, start: null, end: null, attempts: 1 }))).checks.badEditRefusedBeforeAnyStep).toBe(false);
    expect((await tampered((c) => void runOf(c, "bad").details!.steps.push({ type: "step", name: "node:t-1", success: true, start: null, end: null, attempts: 1 }))).checks.badEditRefusedBeforeAnyStep).toBe(false);
    expect((await tampered((c) => void (runOf(c, "bad").details!.status = "complete"))).checks.badEditRefusedBeforeAnyStep).toBe(false);
    expect((await tampered((c) => void (runOf(c, "bad").rowText = JSON.stringify(H11_GRAPHS.sum)))).checks.badEditRefusedBeforeAnyStep).toBe(false);
    expect((await tampered((c) => void (runOf(c, "bad").details!.steps[0]!.success = true))).checks.badEditRefusedBeforeAnyStep).toBe(false);
    expect((await tampered((c) => void (runOf(c, "bad").details!.steps = []))).checks.badEditRefusedBeforeAnyStep).toBe(false);
  });

  test("write timings that are not ten, are negative, do not match their median, or are not the log's own fail 'latency recorded'", async () => {
    expect((await tampered((c) => void c.facts.latency.worker!.timingsMs.pop())).checks.writeLatencyRecorded).toBe(false);
    expect((await tampered((c) => void (c.facts.latency.worker!.timingsMs[0] = -1))).checks.writeLatencyRecorded).toBe(false);
    expect((await tampered((c) => void (c.facts.latency.worker!.medianMs += 5))).checks.writeLatencyRecorded).toBe(false);
    expect((await tampered((c) => void (c.facts.latency.rest!.slowestMs += 1))).checks.writeLatencyRecorded).toBe(false);
    expect((await tampered((c) => void (c.facts.latency.rest!.timingsMs = c.facts.latency.rest!.timingsMs.map((x) => x + 1)))).checks.writeLatencyRecorded).toBe(false);
    expect((await tampered((c) => void (c.facts.latency.rest = null))).checks.writeLatencyRecorded).toBe(false);
    // timings that are consistent in themselves (ten values, the right median and slowest) but are not the ones in the log
    expect((await tampered((c) => void (c.facts.latency.rest = { timingsMs: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14], medianMs: 9.5, slowestMs: 14 }))).checks.writeLatencyRecorded).toBe(false);
  });

  test("the two kill rules: a failed edit or a changed script is a kill; any other false check is a fail", async () => {
    const e = await tampered((c) => void (c.facts.versions.final = ["x"]));
    expect(verdict(h11, { checks: e.checks }).verdict).toBe("kill");
    const f = await tampered((c) => void (c.facts.latency.rest = null));
    expect(verdict(h11, { checks: f.checks }).verdict).toBe("fail");
    const g = await tampered((c) => void (runOf(c, "sum-edited").details!.output = runOf(c, "sum-first").details!.output));
    expect(verdict(h11, { checks: g.checks }).verdict).toBe("kill");
  });

  test("canon spells a value the same whatever order its keys were written in", () => {
    expect(canon({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canon({ a: [2, { c: 2, d: 1 }], b: 1 }));
    expect(canon([1, 2])).not.toBe(canon([2, 1]));
  });
});

describe("when something goes wrong during the run", () => {
  test("a slow run that is always past its wait when looked at is reported after the tries are used up, and the check is left unreported (a fail, not a kill)", async () => {
    const w = await world({ delayAlreadyDone: true, midRunTries: 2 });
    const { calls, result } = await runH11(w.deps);
    expect(calls.facts.midRun!.tooLate).toBe(2);
    expect(calls.facts.runs.filter((r) => r.key.startsWith("slow-missed"))).toHaveLength(2);
    expect(calls.facts.runs.some((r) => r.key === "slow-midrun" || r.key === "slow-after")).toBe(false);
    const e = await evaluate(calls, result);
    expect("runKeepsItsGraphWhenEditedMidRun" in e.checks).toBe(false);
    expect(verdict(h11, { checks: e.checks }).verdict).toBe("fail");
    expect(calls.facts.attempts.filter((a) => a.phase === "catch the slow run under way" && a.outcome === "failed")).toHaveLength(2);
  }, 120_000);

  test("Cloudflare's record of a run that never arrives leaves that run without details, and the checks that stand on it do not pass", async () => {
    const w = await world({ detailsNeverArrive: true, runTimeoutMs: 400, midRunTries: 1 });
    const { calls, result } = await runH11(w.deps);
    expect(calls.facts.runs.every((r) => r.details === null)).toBe(true);
    const e = await evaluate(calls, result);
    expect(Object.values(e.checks).some((v) => v)).toBe(true); // the latency and some others can still hold
    for (const name of ["oneWorkflowClassRanAllGraphs", "graphReadFromD1", "everyNodeRanInsideStepDo", "resultsMatchLocalInterpreter"]) expect(e.checks[name], name).toBe(false);
    expect(verdict(h11, { checks: e.checks }).verdict).not.toBe("pass");
  }, 120_000);

  test("Cloudflare's record of a run that lags behind the Worker's answer is waited for, not taken half written", async () => {
    const w = await world({ detailsLagCalls: 2, midRunTries: 1 });
    const { calls, result } = await runH11(w.deps);
    expect(result.completed).toBe(true);
    for (const r of calls.facts.runs.filter((x) => !x.key.startsWith("slow-missed"))) expect(r.details?.status, r.key).toMatch(/complete|errored/);
    const e = await evaluate(calls, result);
    expect(e.checks).toEqual(Object.fromEntries(NINE.map((n) => [n, true])));
  }, 120_000);

  test("a Worker whose route does not start runs ends the protocol with a reason and no checks pass", async () => {
    const w = await world();
    w.deps.fetchUrl = async () => new Response("<html>1101</html>", { status: 500 });
    const { calls, result } = await runH11(w.deps);
    const e = await evaluate(calls, result);
    expect(result.completed).toBe(false);
    expect(result.stoppedBecause).toMatch(/the Worker did not show h11-sum back after it was stored over REST \(HTTP 500\)/);
    expect(calls.facts.runs).toEqual([]);
    expect(Object.values(e.checks).every((v) => v === false)).toBe(true);
  });

  test("a version list that comes back empty stops the protocol before any run", async () => {
    const w = await world();
    w.fake.fail({ when: (m, p) => m === "GET" && p.endsWith("/versions"), respond: { status: 404, body: { success: false, errors: [{ code: 10007, message: "no such Worker" }] } } });
    const { calls, result } = await runH11(w.deps);
    expect(result.completed).toBe(false);
    expect(calls.facts.runs).toEqual([]);
    expect(result.stoppedBecause).toMatch(/lists no version/);
  });

  test("the files of a failed run are still written with secrets hidden", async () => {
    const w = await world();
    w.fake.fail({ when: (m, p) => m === "GET" && p.endsWith("/versions"), respond: { status: 403, body: { success: false, errors: [{ code: 10000, message: `no for ${TOKEN} ${ACCOUNT} ${KEY}` }] } } });
    const { calls, result } = await runH11(w.deps);
    expect(result.stoppedBecause).toContain("[hidden]");
    expect(findSecrets(canonical11(calls) + JSON.stringify(result) + w.lines.join("\n"), { token: TOKEN, accountId: ACCOUNT, accessKey: KEY })).toEqual([]);
  });
});

describe("the graph table in the local database is what the rehearsal edited", () => {
  test("the last row of the scratch id is the tenth REST write, so the timed writes really happened", async () => {
    const row = await db.prepare(`SELECT graph FROM ${GRAPH_TABLE} WHERE workspace_id = ? AND id = ?`).bind(APP_WORKSPACE, H11_IDS.latency).first<{ graph: string }>();
    expect(JSON.parse(row!.graph)).toEqual({ write: 9 });
  });

  test("every graph row the rehearsal left is app-wide: the protocol stores nothing under any other workspace", async () => {
    const rows = (await db.prepare(`SELECT DISTINCT workspace_id FROM ${GRAPH_TABLE}`).all<{ workspace_id: string }>()).results;
    expect(rows.map((r) => r.workspace_id)).toEqual([APP_WORKSPACE]);
  });
});
