// Breaks the read-only probe on purpose, one way at a time, and prints how many of its tests fail each time.
// Used while building epic 5, story 4. Always restores what it touched: it keeps its own copy of every file it edits and
// restores from that copy even after an interrupted run; a backup is only deleted after a clean finish; an empty backup is
// never trusted; hashes are compared at the end.
// Usage: node scripts/mutate-probe.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const backup = join(root, "out", "mutate-probe-backup");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const write = (rel: string, text: string) => writeFileSync(join(root, rel), text);
const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const slug = (rel: string) => rel.replace(/[\\/]/g, "__");

const P = "packages/deploy/src/provisioner/probe.ts";
const C = "packages/deploy/src/provisioner/cloudflare.ts";

interface Case {
  name: string;
  file: string;
  from: string;
  to: string;
}
const cases: Case[] = [
  { name: "a token Cloudflare does not accept does not stop the probe", file: P, from: 'report.missing.push("a working token: Cloudflare did not accept the one given");\n    return report;', to: 'report.missing.push("a working token: Cloudflare did not accept the one given");' },
  { name: "a token that is not active does not stop the probe", file: P, from: 'if (report.token.status !== "active") return report;', to: "" },
  { name: "a refusal is called a failure, so no permission is ever named missing", file: P, from: "const authentication = error.status === 401 || error.status === 403 || error.codes.includes(10000);", to: "const authentication = false as boolean;" },
  { name: "'not found' is called a refusal", file: P, from: "if (error.status === 404) return", to: "if (error.status === 404 && false as boolean) return" },
  { name: "a refused database list is not named", file: P, from: 'if (d1.state === "refused") report.missing.push("D1 (Read or Write)");', to: "" },
  { name: "a refused Worker list is not named", file: P, from: 'if (scripts.state === "refused" || subdomain.state === "refused") report.missing.push("Workers Scripts (Read or Write)");', to: "" },
  { name: "a refused Workflow list is not named", file: P, from: 'if (workflows.state === "refused") report.missing.push(', to: 'if (false as boolean) report.missing.push(' },
  { name: "an account with no workers.dev name counts as ready", file: P, from: "subdomain.value !== null && report.missing.length === 0", to: "report.missing.length === 0" },
  { name: "missing permissions do not stop it being ready", file: P, from: "subdomain.value !== null && report.missing.length === 0 &&", to: "subdomain.value !== null &&" },
  { name: "a token about to expire counts as ready", file: P, from: "(report.token.daysLeft === null || report.token.daysLeft >= 1)", to: "true" },
  { name: "days left are counted wrongly", file: P, from: "const DAY_MS = 24 * 60 * 60 * 1000;", to: "const DAY_MS = 12 * 60 * 60 * 1000;" },
  { name: "leftovers with this proof's prefix are not reported", file: P, from: "if (name.startsWith(PROOF_PREFIX)) report.existingProofResources.push", to: "if (false as boolean) report.existingProofResources.push" },
  { name: "the evidence keeps the owner's other resource names", file: P, from: "return value === undefined ? rest : { ...rest, value: value.filter((n) => n.startsWith(PROOF_PREFIX)) };", to: "return value === undefined ? rest : { ...rest, value };" },
  { name: "a D1 Read group is accepted as write access", file: P, from: "d1: /\\bD1\\b.*\\b(Write|Edit)\\b/i,", to: "d1: /\\bD1\\b/i," },
  { name: "the token's own list, when readable, is ignored", file: P, from: "if (permissionGroupsKnown(report)) {", to: "if (false as boolean) {" },
  { name: "the probe also creates a database", file: P, from: "// 2. What the token says it may do", to: 'await client.createDatabase("projectx-poc-00000000-db");\n  // 2. What the token says it may do' },
  { name: "the probe also switches an address on", file: P, from: "// 3. What it can read, one request each.", to: 'await client.setScriptSubdomain("x", true);\n  // 3. What it can read, one request each.' },
  { name: "onlyReads accepts any log", file: P, from: 'calls.length > 0 && calls.every((c) => c.method === "GET")', to: "true" },
  { name: "the token's id is kept in the call log", file: C, from: "const shownPath = spec.display ?? ", to: "const shownPath = " },
  { name: "the account's name is shown as 'none' when it exists", file: P, from: 'details.subdomain ? `${details.subdomain}.workers.dev` : "the account has none yet"', to: '"the account has none yet"' },
];

const suites = ["packages/deploy/test/probe", "packages/deploy/test/provisioner"];
function run(): string {
  const result = spawnSync(process.execPath, [join(root, "node_modules", "vitest", "vitest.mjs"), "run", ...suites], { cwd: root, encoding: "utf8", timeout: 300_000 });
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
