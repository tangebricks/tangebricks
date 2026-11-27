// Breaks the H10 protocol, the provisioner's deploy logic and the re-reading of the evidence on purpose, one way at a time,
// and prints how many of their tests fail each time. Used while building epic 5, story 5. Always restores what it touched: it
// keeps its own copy of every file it edits and restores from that copy even after an interrupted run; a backup is only
// deleted after a clean finish; an empty backup is never trusted; hashes are compared at the end.
// Usage: node scripts/mutate-h10.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const root = resolve(import.meta.dirname, "..");
const backup = join(root, "out", "mutate-h10-backup");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const write = (rel: string, text: string) => writeFileSync(join(root, rel), text);
const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const slug = (rel: string) => rel.replace(/[\\/]/g, "__");
const BT = "\u0060"; // a backtick, so snippets can quote template literals

const D = "packages/deploy/src/provisioner/deploy.ts";
const H = "packages/deploy/src/h10.ts";
const L = "packages/deploy/src/leak-scan.ts";

interface Case {
  name: string;
  file: string;
  from: string;
  to: string;
}
const cases: Case[] = [
  // ---- a provisioner that lies or misbehaves
  {
    name: "a provisioner that uploads on every run",
    file: D,
    from: "const upToDate = versionsBefore !== null && versionsBefore.length > 0 && last?.upload_sha256 === fingerprint && last?.version_id === versionsBefore[0]!.id;",
    to: "const upToDate = false as boolean;",
  },
  {
    name: "a provisioner that uploads every time and always says zero changes",
    file: D,
    from: 'changes.push({ kind: "script_uploaded",',
    to: 'void ({ kind: "script_uploaded",',
  },
  {
    name: "a provisioner that always says one change",
    file: D,
    from: "const changes: Change[] = [];",
    to: 'const changes: Change[] = [{ kind: "address_enabled", what: "claimed" }];',
  },
  {
    name: "a provisioner that never uploads a changed project",
    file: D,
    from: "const upToDate = versionsBefore !== null && versionsBefore.length > 0 && last?.upload_sha256 === fingerprint && last?.version_id === versionsBefore[0]!.id;",
    to: "const upToDate = versionsBefore !== null && versionsBefore.length > 0;",
  },
  {
    name: "a provisioner that maps every failed upload to a refusal",
    file: D,
    from: `throw new UploadFailed(\n      "not_the_workflow_binding",\n      ${BT}the upload was refused with and without`,
    to: `throw new UploadFailed(\n      "platform_refusal",\n      ${BT}the upload was refused with and without`,
  },
  {
    name: "a provisioner that maps a network failure to a refusal",
    file: D,
    from: "if (!(error instanceof CloudflareApiError))\n      throw new UploadFailed(",
    to: "if (false as boolean)\n      throw new UploadFailed(",
  },
  // ---- the Workflow registration (found missing on the real service)
  {
    name: "the Workflow is never registered",
    file: D,
    from: "await client.putWorkflow(names.workflow, { className: spec.className, scriptName: names.script });",
    to: "",
  },
  { name: "the Workflow is registered only the first time, not after a new upload", file: D, from: "if (!current || !upToDate) {", to: "if (!current) {" },
  { name: "the Workflow is registered on every run", file: D, from: "if (!current || !upToDate) {", to: "if (true as boolean) {" },
  {
    name: "the registered class is not compared",
    file: D,
    from: "registered.className === spec.className && registered.scriptName === names.script;",
    to: "registered.scriptName === names.script;",
  },
  {
    name: "the registered Worker is not compared",
    file: D,
    from: "registered.className === spec.className && registered.scriptName === names.script;",
    to: "registered.className === spec.className;",
  },
  {
    name: "the Workflow is not in the ledger before it is asked for",
    file: D,
    from: 'if (!ledger.has("workflow", names.workflow)) ledger.planned("workflow", names.workflow);\n      await client.putWorkflow',
    to: "await client.putWorkflow",
  },
  // ---- the protocol
  { name: "the clock stops at the start of the last answer, not its end", file: H, from: "timedEnd = last.atMs + last.ms;", to: "timedEnd = last.atMs;" },
  {
    name: "the second run is given a different project",
    file: H,
    from: 'deploy(input(newClient("second-deploy"), rebuilt))',
    to: 'deploy(input(newClient("second-deploy"), { ...rebuilt, bundle: { ...rebuilt.bundle, code: rebuilt.bundle.code + "\\n// x", sha256: "ff" } }))',
  },
  {
    name: "the fourth run does not put the setting back",
    file: H,
    from: 'deploy(input(newClient("fourth-deploy"), base))',
    to: 'deploy(input(newClient("fourth-deploy"), changed))',
  },
  {
    name: "the gate probes carry the key",
    file: H,
    from: 'const headers: Record<string, string> = probe.key === "wrong" ? { "x-poc-key": WRONG_KEY } : {};',
    to: "const headers: Record<string, string> = keyHeader;",
  },
  {
    name: "the readings are taken by the deploying client, not a client of their own",
    file: H,
    from: "const reading = async (label: string) => readAccountState(newClient(label), deps.names);",
    to: "const reading = async (label: string) => readAccountState(clients.at(-1) ? deps.createClient(deps.clock) : newClient(label), deps.names);",
  },
  // ---- re-reading the evidence
  { name: "an edited calls file is believed", file: H, from: "sha256(input.callsText) !== input.result.callsSha256 ||", to: "" },
  {
    name: "a claimed time is believed",
    file: H,
    from: "if (input.result.secondsToCorrectAnswer !== recomputed)\n      notes.push(",
    to: "if (false as boolean)\n      notes.push(",
  },
  {
    name: "the scripted check's answers are not compared",
    file: H,
    from: "checks.urlAnswersCorrectly =\n    observed !== undefined &&",
    to: "checks.urlAnswersCorrectly =\n    true ||",
  },
  { name: "a write in the second run's log is ignored", file: H, from: "writes(second.calls).length === 0 &&", to: "" },
  { name: "the readings before and after the second run are not compared", file: H, from: "real && same(b2, a2) &&", to: "real &&" },
  { name: "the version count of the third run is not compared", file: H, from: "a3.versionCount === b3.versionCount + 1 &&", to: "" },
  { name: "the number of uploads in the third run's log is not compared", file: H, from: "&&\n      uploads === 1 &&", to: "&&" },
  { name: "any answer to a gate probe is accepted", file: H, from: "gate[i]?.status === p.expect", to: "true" },
  { name: "a leak scan with a hit still passes", file: H, from: "scan.found.length === 0 &&", to: "" },
  { name: "a refusal counts without the control upload having been accepted", file: H, from: "f.upload.control?.accepted === true &&", to: "" },
  {
    name: "an upload that is not in the log counts as accepted",
    file: H,
    from: 'f.upload.outcome === "accepted" && putOk("first-deploy") && bound',
    to: 'f.upload.outcome === "accepted" && bound',
  },
  {
    name: "the source is not read for programs being started",
    file: H,
    from: "checks.deployedOverRestOnly = apiOnly && sourcesClean &&",
    to: "checks.deployedOverRestOnly = apiOnly &&",
  },
  // ---- the scan of the repositories
  { name: "the repository scan finds nothing", file: L, from: "for (const name of hits) found.push(", to: "for (const name of []) found.push(" },
  {
    name: "the repository scan also skips the evidence folder",
    file: L,
    from: '".git", ".wran" + "gler", "vendor"]);',
    to: '".git", ".wran" + "gler", "vendor", "src", "evidence"]);',
  },
];

const suites = ["packages/deploy/test/H10", "packages/deploy/test/provisioner"];
function run(): string {
  const result = spawnSync(process.execPath, [join(root, "node_modules", "vitest", "vitest.mjs"), "run", ...suites], {
    cwd: root,
    encoding: "utf8",
    timeout: 600_000,
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
