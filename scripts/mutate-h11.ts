// Breaks the H11 protocol and the re-reading of its evidence on purpose, one way at a time, and prints how many of its tests
// fail each time. Used while building epic 5, story 6. Always restores what it touched: it keeps its own copy of every file it
// edits and restores from that copy even after an interrupted run; a backup is only deleted after a clean finish; an empty
// backup is never trusted; hashes are compared at the end.
// Usage: node scripts/mutate-h11.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const backup = join(root, "out", "mutate-h11-backup");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const write = (rel: string, text: string) => writeFileSync(join(root, rel), text);
const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const slug = (rel: string) => rel.replace(/[\\/]/g, "__");

const H = "packages/deploy/src/h11.ts";
const W = "packages/deploy/src/worker/proof-routes.ts";

interface Case {
  name: string;
  file: string;
  from: string;
  to: string;
}
const cases: Case[] = [
  // ---- the protocol
  { name: "the slow run is edited without waiting to catch it under way", file: H, from: "if (loadDone && !delayDone && !terminal(d.status)) {", to: "if (true as boolean) {" },
  { name: "a run's record is taken before it has ended", file: H, from: "if (details && terminal(details.status)) {", to: "if (details) {" },
  { name: "the REST write timings are made up", file: H, from: "facts.latency.rest = timings(rest.calls.filter((c) => c.method === \"POST\" && c.sqlKind === \"write\").map((c) => c.ms));", to: "facts.latency.rest = timings(Array.from({ length: 10 }, () => 1));" },
  { name: "the Worker's own write timings are not kept", file: H, from: "if (inside.status === 200 && Array.isArray(inside.json?.timingsMs))", to: "if (false as boolean)" },
  { name: "the last reading of the Worker's version is skipped", file: H, from: "facts.versions.final = await versionsOf(\"bracket-final\");", to: "facts.versions.final = facts.versions.after;" },
  { name: "the Worker's route stores the 'owner's' edit too", file: W, from: "export const LATENCY_WRITES = 10;", to: "export const LATENCY_WRITES = 7;" },
  // ---- one class ran every graph
  { name: "a second Workflow is not noticed", file: H, from: "wf.length === 1 && wf[0]!.name", to: "wf.length >= 1 && wf[0]!.name" },
  { name: "fewer than three kinds of graph still count", file: H, from: "new Set(runs.map((r) => r!.graphId)).size >= 3 &&", to: "" },
  { name: "a run that was never started through the route still counts", file: H, from: "started.length === f.runs.filter((r) => r.instanceId).length && started.every((e) => e.status === 202)", to: "true" },
  // ---- read from D1
  { name: "the graph the run loaded is not compared with the intended one", file: H, from: "load !== undefined && same(load.output, expected) && r!.rowText !== null", to: "load !== undefined && r!.rowText !== null" },
  { name: "the row as read over REST is not compared with the intended graph", file: H, from: "&& same(safeJson(r!.rowText), expected);", to: ";" },
  // ---- the edit changed the next run
  { name: "two runs with the same answer still count as 'the edit changed the next run'", file: H, from: "!same(r1.details.output, r2.details.output) &&", to: "" },
  { name: "an edit made through the Worker's own route still counts", file: H, from: "&& storesOfSum === 1 &&", to: "&&" },
  { name: "a second store of the graph over REST is not counted", file: H, from: "const storesOfSum = restStores + ", to: "const storesOfSum = 1 + " },
  // ---- the graphs are stored over REST, and the Worker must show each one back (story 0.18)
  { name: "a stored graph the Worker cannot show back is not noticed", file: H, from: "if (seen.status !== 200 || seen.json?.graph !== written.rowText) throw", to: "if (false as boolean) throw" },
  { name: "a graph is stored under a workspace the Worker does not read", file: H, from: "VALUES ('${APP_WORKSPACE}', ?1, ?2,", to: "VALUES ('ws-other', ?1, ?2," },
  { name: "an edit with no write in its log still counts", file: H, from: "(editLog?.calls.some((c) => isQuery(c) && c.sqlKind === \"write\") ?? false) &&", to: "" },
  // ---- the script did not change
  { name: "a version that moved before the edited run is not noticed", file: H, from: "before[0] === after[0] && after[0] === final[0] &&", to: "after[0] === final[0] &&" },
  { name: "a version that moved after the edited run is not noticed", file: H, from: "before[0] === after[0] && after[0] === final[0] &&", to: "before[0] === after[0] &&" },
  { name: "a write to anything but rows is not noticed", file: H, from: "checks.scriptVersionUnchanged = sameIds && onlyReadsAndRowWrites && h10Link && bracketOrdered;", to: "checks.scriptVersionUnchanged = sameIds && h10Link && bracketOrdered;" },
  { name: "a newest version that is not the one H10 left is not noticed", file: H, from: "checks.scriptVersionUnchanged = sameIds && onlyReadsAndRowWrites && h10Link && bracketOrdered;", to: "checks.scriptVersionUnchanged = sameIds && onlyReadsAndRowWrites && bracketOrdered;" },
  { name: "the order of the readings around the runs is not checked", file: H, from: "checks.scriptVersionUnchanged = sameIds && onlyReadsAndRowWrites && h10Link && bracketOrdered;", to: "checks.scriptVersionUnchanged = sameIds && onlyReadsAndRowWrites && h10Link;" },
  // ---- results and steps
  { name: "the Worker's own answer is not compared with the interpreter's", file: H, from: "all = all && same(r.details.output, local) && same(r.workerStatus.output, local);", to: "all = all && same(r.details.output, local);" },
  { name: "a step that failed or was retried or is not a step still counts", file: H, from: "steps.every((s) => s.type === \"step\" && s.success === true && s.attempts === 1) &&", to: "" },
  { name: "a step holding the wrong output still counts", file: H, from: "&& Object.entries(local.outputs).every(([id, out]) => same(steps.find((s) => baseName(s.name) === nodeStepName(id))?.output, out));", to: ";" },
  { name: "the step names are not compared with the graph's nodes", file: H, from: "all = all && same(names, wanted) &&", to: "all = all &&" },
  // ---- a run keeps its graph
  { name: "an edit that did not land under way still counts", file: H, from: "&& inFlight && watched?.loadDone === true", to: "&& watched?.loadDone === true" },
  { name: "what was seen before the edit is not required to be 'wait not done'", file: H, from: "watched?.loadDone === true && watched.delayDone === false", to: "watched?.loadDone === true" },
  { name: "the graph the slow run loaded is not compared with its original", file: H, from: "&& same(load?.output, SLOW);", to: ";" },
  { name: "the run after the edit is not compared with the edited graph's answer", file: H, from: "same(r4.details.output, edited) && inFlight", to: "inFlight" },
  // ---- refused before any step
  { name: "a refused run that ran a node of any other name still counts", file: H, from: "steps.every((s) => baseName(s.name) === LOAD_STEP) && !steps.some((s) => s.name.startsWith(\"node:\"))", to: "!steps.some((s) => s.name.startsWith(\"node:\"))" },
  { name: "a refused run with a successful first step still counts", file: H, from: "steps.some((s) => s.success === false) &&", to: "" },
  { name: "the refused row is not required to be the bad graph", file: H, from: "&& r.rowText !== null && same(safeJson(r.rowText), CYCLIC) && r.details.output == null;", to: "&& r.details.output == null;" },
  // ---- latency
  { name: "a median that does not match the timings still counts", file: H, from: "Math.abs(t.medianMs - Math.round(median(t.timingsMs) * 10) / 10) <= 0.1 &&", to: "" },
  { name: "REST timings that are not the log's own still count", file: H, from: "(source === undefined || same(t.timingsMs, source))", to: "true" },
  // ---- the files
  { name: "an edited calls file is believed", file: H, from: "if (sha256(input.callsText) !== input.result.callsSha256 ||", to: "if (false as boolean ||" },
];

const suites = ["packages/deploy/test/H11"];
function run(): string {
  const result = spawnSync(process.execPath, [join(root, "node_modules", "vitest", "vitest.mjs"), "run", ...suites], { cwd: root, encoding: "utf8", timeout: 600_000 });
  const out = (result.stdout + result.stderr).replace(/\x1B\[[0-9;]*m/g, "");
  const tests = out.split(/\r?\n/).find((l) => /^\s+Tests /.test(l))?.trim().replace(/^Tests\s+/, "");
  if (tests) return tests.replace(/ passed/g, "p").replace(/ failed/g, "f");
  return /FAIL|Error/.test(out) || result.error ? "(did not run)" : "(no summary)";
}

mkdirSync(backup, { recursive: true });
const targets = [...new Set(cases.map((c) => c.file))];
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
  const original = read(c.file);
  if (!original.includes(c.from)) {
    console.log(`${c.name.padEnd(86)}-> MUTATION DID NOT APPLY`);
    continue;
  }
  write(c.file, original.replace(c.from, c.to));
  try {
    console.log(`${c.name.padEnd(86)}-> ${run()}`);
  } finally {
    write(c.file, original);
  }
}
console.log(`restored -> ${run()}`);
const after = new Map(targets.map((f) => [f, sha(read(f))]));
const changed = targets.filter((f) => before.get(f) !== after.get(f));
console.log(changed.length === 0 ? `files identical to before the run: ${targets.length} of ${targets.length}` : `FILES NOT RESTORED: ${changed.join(", ")}`);
if (changed.length === 0) for (const file of targets) rmSync(join(backup, slug(file)), { force: true });
