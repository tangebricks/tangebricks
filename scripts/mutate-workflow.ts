// Breaks the Workflow code on purpose, one way at a time, and prints how many of its tests fail each time.
// Used while building epic 5, story 3. Always restores what it touched: it keeps its own copy of every file it edits and
// restores from that copy even after an interrupted run; a backup is only deleted after a clean finish; an empty backup is
// never trusted; hashes are compared at the end.
// Usage: node scripts/mutate-workflow.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const root = resolve(import.meta.dirname, "..");
const backup = join(root, "out", "mutate-workflow-backup");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const write = (rel: string, text: string) => writeFileSync(join(root, rel), text);
const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const slug = (rel: string) => rel.replace(/[\\/]/g, "__");

const W = "packages/deploy/src/worker/";
const RUN = `${W}graph-run.ts`;
const ROUTES = `${W}proof-routes.ts`;
const GATE = `${W}gate.ts`;
const WF = `${W}graph-workflow.ts`;
const BRICKS = `${W}proof-bricks.ts`;
const BUNDLE = "packages/deploy/src/bundle.ts";
const INTERP = "packages/runtime/src/run.ts";

interface Edit {
  file: string;
  from: string;
  to: string;
}
interface Case {
  name: string;
  edits: Edit[];
}
const one = (name: string, file: string, from: string, to: string): Case => ({ name, edits: [{ file, from, to }] });

const cases: Case[] = [
  // ---- how a stored graph is run
  one(
    "the graph is not validated when it is loaded",
    RUN,
    "if (!read.ok) throw run.nonRetryable(read.reason.slice(0, 900));",
    "if (!read.ok) { /* ignored */ }",
  ),
  one(
    "a missing row ends the run with an ordinary error that the engine would retry",
    RUN,
    "throw run.nonRetryable(`no graph is stored under",
    "throw new Error(`no graph is stored under",
  ),
  one(
    "a bad graph ends the run with an ordinary error that the engine would retry",
    RUN,
    "if (!read.ok) throw run.nonRetryable(read.reason.slice(0, 900));",
    "if (!read.ok) throw new Error(read.reason.slice(0, 900));",
  ),
  {
    name: "the graph is read every time it is needed rather than once inside a step",
    edits: [
      { file: RUN, from: "const graph = await step.do(LOAD_STEP, async () => {", to: "const graph = await (async () => {" },
      { file: RUN, from: "return read.graph;\n  });", to: "return read.graph;\n  })();" },
    ],
  },
  one("nodes are not run as steps", RUN, "runStep: (nodeId, execute) => step.do(nodeStepName(nodeId), NODE_STEP, execute),", ""),
  one("every node's step has the same name", RUN, "step.do(nodeStepName(nodeId), NODE_STEP, execute)", 'step.do("node", NODE_STEP, execute)'),
  one("a node's step is retried by the engine", RUN, "const NODE_STEP: StepConfig = { retries: { limit: 0, delay: 0 } };", "const NODE_STEP: StepConfig = {};"),
  one(
    "a graph id with odd characters is accepted",
    RUN,
    'if (typeof params?.graphId !== "string" || !ID_PATTERN.test(params.graphId))',
    'if (typeof params?.graphId !== "string")',
  ),
  one(
    "the graph id is written into the SQL text instead of passed as a parameter",
    RUN,
    "WHERE id = ?1 AND workspace_id IN (?2,",
    "WHERE id = '${params.graphId}' AND workspace_id IN (?2,",
  ),
  // ---- whose graph a run may load (story 0.18)
  one("a run loads a graph stored for any workspace", RUN, ` AND workspace_id IN (?2, '\${APP_WORKSPACE}')`, ""),
  one(
    "the app-wide graph wins over the workspace's own",
    RUN,
    "CASE WHEN workspace_id = ?2 THEN 0 ELSE 1 END",
    "CASE WHEN workspace_id = ?2 THEN 1 ELSE 0 END",
  ),
  one("a run with no usable workspace is started anyway", RUN, "if (!isTenantWorkspaceId(params.workspaceId)) throw", "if (false as boolean) throw"),
  one("a reserved workspace id other than the app's is accepted", RUN, ' && !value.includes("__")', ""),
  one("the run's workspace is not handed to the interpreter (story 1.1)", RUN, "    workspaceId,\n    runStep:", "    runStep:"),
  one(
    "a run with no workspace, or the app's, is started anyway (story 1.1)",
    RUN,
    "if (params.workspaceId === undefined || params.workspaceId === APP_WORKSPACE)\n    throw",
    "if (false as boolean)\n    throw",
  ),
  one(
    "warnings count as errors, so a graph with an unconnected node is refused",
    RUN,
    '.filter((i) => i.severity === "error");\n  if (errors.length > 0)\n    return',
    ".filter(() => true);\n  if (errors.length > 0)\n    return",
  ),
  one(
    "the shape of the nodes is not checked",
    RUN,
    'if (typeof n?.id !== "string" || typeof n.type !== "string" || typeof n.data !== "object" || n.data === null || Array.isArray(n.data))\n      return',
    "if (false as boolean)\n      return",
  ),
  one(
    "the shape of the edges is not checked",
    RUN,
    'if (typeof e?.id !== "string" || typeof e.source !== "string" || typeof e.target !== "string")\n      return',
    "if (false as boolean)\n      return",
  ),
  one("the reasons are not cut short", RUN, "throw run.nonRetryable(read.reason.slice(0, 900));", "throw run.nonRetryable(read.reason);"),
  one("the stored text is not checked to be a JSON object", RUN, 'if (typeof parsed !== "object" || parsed === null) return', "if (false as boolean) return"),
  one("the table is keyed by id alone, not by workspace and id", RUN, "PRIMARY KEY (workspace_id, id)", "PRIMARY KEY (id)"),
  one(
    "the table accepts an empty graph",
    RUN,
    "  graph TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  PRIMARY KEY",
    "  graph TEXT,\n  updated_at TEXT NOT NULL,\n  PRIMARY KEY",
  ),
  one("the migration does not keep the rows it moves", RUN, "updated_at FROM ${GRAPH_TABLE};", "updated_at FROM ${GRAPH_TABLE} WHERE 0;"),
  // ---- the class
  one(
    "the Workflow class tells the engine nothing about not retrying",
    WF,
    "nonRetryable: (message) => new NonRetryableError(message),",
    "nonRetryable: (message) => new Error(message),",
  ),
  one("the Workflow class reads its graph id from the wrong place", WF, "params: event.payload,", "params: { graphId: 'x' },"),
  // ---- the interpreter's hook
  one("the interpreter ignores the hook", INTERP, "options.runStep ? await options.runStep(id, call) : await call()", "await call()"),
  one(
    "the interpreter runs the executor outside the step as well as inside it",
    INTERP,
    "options.runStep ? await options.runStep(id, call) : await call()",
    "options.runStep ? (await call(), await options.runStep(id, call)) : await call()",
  ),
  // ---- the bricks
  one("the multiplier adds", BRICKS, 'number(inputs.a, "input a") * number(inputs.b, "input b")', 'number(inputs.a, "input a") + number(inputs.b, "input b")'),
  one("the adder accepts text", BRICKS, 'if (typeof value !== "number" || !Number.isFinite(value))', "if (false as boolean)"),
  // ---- the routes
  one("the extra routes shadow the project's own", ROUTES, 'if (!url.pathname.startsWith("/poc/")) return null;', ""),
  one("nine timed writes, not ten", ROUTES, "export const LATENCY_WRITES = 10;", "export const LATENCY_WRITES = 9;"),
  one(
    "the median is the largest",
    ROUTES,
    "return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;",
    "return sorted[sorted.length - 1]!;",
  ),
  one("the slowest write is the fastest", ROUTES, "slowestMs: Math.max(...timings)", "slowestMs: Math.min(...timings)"),
  one(
    "the timed writes are not written",
    ROUTES,
    "await writeScratch(env.DB, LATENCY_ROW, JSON.stringify({ write: i }));",
    "await Promise.resolve(JSON.stringify({ write: i }));",
  ),
  one(
    "the route shows a graph stored for any workspace",
    ROUTES,
    "WHERE workspace_id = ?1 AND id = ?2`)\n          .bind(APP_WORKSPACE, id)",
    "WHERE id = ?2`)\n          .bind(APP_WORKSPACE, id)",
  ),
  one(
    "POST /poc/runs starts a run with the shared key alone (story 1.1)",
    ROUTES,
    'return json(403, {\n        error: { code: "NO_VERIFIED_WORKSPACE"',
    'if (workflow) await workflow.create({ params: { graphId: "x", workspaceId: "ws-a" } });\n      return json(403, {\n        error: { code: "NO_VERIFIED_WORKSPACE"',
  ),
  one(
    "the signed run route does not check the signature (story 1.1)",
    ROUTES,
    "const unsigned = await refuseUnsignedControlPlane(request, WORKFLOW_RUNS_PATH, rawBody, secret, nowMs);\n  if (unsigned) return unsigned;\n",
    "",
  ),
  one(
    "the executing routes take a replayed requestId (story 1.17)",
    "packages/telemetry/src/index.ts",
    "  if (!fresh) {\n    return {",
    "  if (false as boolean) {\n    return {",
  ),
  one(
    "the access key alone can sign a run (story 1.1)",
    ROUTES,
    'if (typeof env.POC_ACCESS_KEY === "string" && secret === env.POC_ACCESS_KEY) return null;',
    "",
  ),
  one(
    "any graph id is accepted when reading",
    ROUTES,
    'if (!ID_PATTERN.test(id)) return json(400, { error: "graph ids',
    'if (false as boolean) return json(400, { error: "graph ids',
  ),
  one(
    "any graph id is accepted when starting a run",
    ROUTES,
    'if (typeof body?.graphId !== "string" || !ID_PATTERN.test(body.graphId))',
    'if (typeof body?.graphId !== "string")',
  ),
  one("any run id is looked up", ROUTES, 'if (!INSTANCE_ID.test(id)) return json(400, { error: "not a run id" });', ""),
  {
    name: "the extra routes are answered before the access key is checked",
    edits: [
      { file: GATE, from: "const extra = await options.extra?.(request, env as never);\n      if (extra) return extra;\n", to: "" },
      {
        file: GATE,
        from: "const expected = env.POC_ACCESS_KEY;",
        to: "const early = await options.extra?.(request, env as never);\n      if (early) return early;\n      const expected = env.POC_ACCESS_KEY;",
      },
    ],
  },
  // ---- the bundle
  one("the bundle does not export the Workflow class", BUNDLE, "    `export class ${WORKFLOW_CLASS} extends createGraphRunner(bricks) {}`,\n", ""),
  one("the bundle does not wire the extra routes", BUNDLE, "extra: createProofRoutes({ registry: bricks.registry, executors: bricks.executors }) });", "});"),
  one(
    "the shipped bundle runs no real executors (story 1.1)",
    BUNDLE,
    "`const bricks = createDeployBricks({ ${deployOptions} });`",
    "`const bricks = { registry: new Map(), executors: new Map() };`",
  ),
];

const suites = [
  "packages/deploy/test/graph-run",
  "packages/deploy/test/graph-workflow",
  "packages/deploy/test/poc-graphs-workspace",
  "packages/deploy/test/bundle",
  "packages/deploy/test/gate",
  "packages/deploy/test/executing-routes-replay.node.test.ts",
  "packages/telemetry/test/control-plane-v1.test.ts",
];
function run(): string {
  const result = spawnSync(process.execPath, [join(root, "node_modules", "vitest", "vitest.mjs"), "run", ...suites], {
    cwd: root,
    encoding: "utf8",
    timeout: 300_000,
  });
  const out = stripVTControlCharacters(result.stdout + result.stderr);
  const tests = out
    .split(/\r?\n/)
    .find((l) => /^\s+Tests /.test(l))
    ?.trim()
    .replace(/^Tests\s+/, "");
  if (tests) return tests.replace(/ passed/g, "p").replace(/ failed/g, "f");
  return /FAIL|Error/.test(out) || result.error ? "(did not run)" : "(no summary)";
}

mkdirSync(backup, { recursive: true });
const targets = [...new Set(cases.flatMap((c) => c.edits.map((e) => e.file)))];
for (const file of targets) {
  const saved = join(backup, slug(file));
  if (!existsSync(saved)) continue;
  const text = readFileSync(saved, "utf8");
  if (text.length === 0) {
    rmSync(saved);
    console.log(`ignored an empty leftover backup of ${file}`);
    continue;
  }
  write(file, text);
  rmSync(saved);
  console.log(`restored ${file} from a previous interrupted run`);
}
const before = new Map(targets.map((f) => [f, sha(read(f))]));
for (const file of targets) {
  if (read(file).length === 0) throw new Error(`${file} is empty: refusing to start, there is nothing to protect`);
  writeFileSync(join(backup, slug(file)), read(file));
}

console.log(`baseline -> ${run()}`);
for (const c of cases) {
  const originals = new Map(c.edits.map((e) => [e.file, read(e.file)]));
  let text = new Map(originals);
  let applied = true;
  for (const e of c.edits) {
    const current = text.get(e.file)!;
    if (!current.includes(e.from)) {
      applied = false;
      break;
    }
    text.set(e.file, current.replace(e.from, e.to));
  }
  if (!applied) {
    console.log(`${c.name.padEnd(86)}-> MUTATION DID NOT APPLY`);
    continue;
  }
  for (const [file, content] of text) write(file, content);
  try {
    console.log(`${c.name.padEnd(86)}-> ${run()}`);
  } finally {
    for (const [file, content] of originals) write(file, content);
  }
}
console.log(`restored -> ${run()}`);
const after = new Map(targets.map((f) => [f, sha(read(f))]));
const changed = targets.filter((f) => before.get(f) !== after.get(f));
console.log(changed.length === 0 ? `files identical to before the run: ${targets.length} of ${targets.length}` : `FILES NOT RESTORED: ${changed.join(", ")}`);
if (changed.length === 0) for (const file of targets) rmSync(join(backup, slug(file)), { force: true });
