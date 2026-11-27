// Breaks the provisioner on purpose, one way at a time, and prints how many of its tests fail each time.
// Used while building epic 5, story 2. Always restores what it touched: it keeps its own copy of every file it edits and
// restores from that copy even after an interrupted run; a backup is only deleted after a clean finish; an empty backup is
// never trusted; hashes are compared at the end.
// Usage: node scripts/mutate-provisioner.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const root = resolve(import.meta.dirname, "..");
const backup = join(root, "out", "mutate-provisioner-backup");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const write = (rel: string, text: string) => writeFileSync(join(root, rel), text);
const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const slug = (rel: string) => rel.replace(/[\\/]/g, "__");
const BT = "\u0060"; // a backtick, so snippets can quote template literals

const P = "packages/deploy/src/provisioner/";
const D = `${P}deploy.ts`;
const C = `${P}cloudflare.ts`;
const T = `${P}teardown.ts`;
const L = `${P}ledger.ts`;
const R = `${P}redact.ts`;
const N = `${P}names.ts`;
const K = `${P}access-key.ts`;
const CR = `${P}credentials.ts`;

interface Case {
  name: string;
  file: string;
  from: string;
  to: string;
}
const cases: Case[] = [
  // ---- the deploy logic
  { name: "a database that exists is created again", file: D, from: "if (found.length === 1) {", to: "if (false as boolean) {" },
  {
    name: "any database whose name merely contains ours is taken for ours",
    file: D,
    from: "const found = (await client.listDatabases(names.database)).filter((d) => d.name === names.database);",
    to: "const found = await client.listDatabases(names.database);",
  },
  { name: "migrations are run again every time", file: D, from: "if (before === hash) continue;", to: "" },
  {
    name: "a migration edited after it ran is run again instead of refused",
    file: D,
    from: "if (before !== undefined)\n      throw new DeployError(",
    to: "if (false as boolean)\n      throw new DeployError(",
  },
  {
    name: "a migration's statements are sent one by one, not as one atomic batch",
    file: D,
    from: "await client.queryDatabase(databaseId, statements); // one atomic batch",
    to: "for (const s of statements) await client.queryDatabase(databaseId, [s]); // one atomic batch",
  },
  { name: "the Worker is uploaded on every run", file: D, from: "if (!upToDate) {", to: "if (true as boolean) {" },
  { name: "a Worker changed behind the tool's back is not noticed", file: D, from: " && last?.version_id === versionsBefore[0]!.id", to: "" },
  { name: "a new access key is not noticed", file: D, from: "text: sha256(String(b.text))", to: 'text: "same"' },
  {
    name: "a changed bundle is not noticed (it is in neither the fingerprint's own field nor its version note)",
    file: D,
    from: "return sha256(JSON.stringify({ code: input.bundle.sha256, metadata: shaped }));",
    to: "return sha256(JSON.stringify({ metadata: { ...shaped, annotations: null } }));",
  },
  { name: "the address is switched on every run", file: D, from: "if (address === null || !address.enabled) {", to: "if (true as boolean) {" },
  {
    name: "an account with no workers.dev name is not noticed",
    file: D,
    from: "if (subdomain === null)\n    throw new DeployError(",
    to: "if (false as boolean)\n    throw new DeployError(",
  },
  {
    name: "the ledger is written only after the database exists",
    file: D,
    from: 'ledger.planned("d1_database", names.database);\n    const made',
    to: "const made",
  },
  {
    name: "every refused upload is called a refusal of the Workflow binding",
    file: D,
    from: `throw new UploadFailed(\n      "not_the_workflow_binding",\n      ${BT}the upload was refused with and without`,
    to: `throw new UploadFailed(\n      "platform_refusal",\n      ${BT}the upload was refused with and without`,
  },
  {
    name: "a network failure during the upload is treated as a refusal",
    file: D,
    from: "if (!(error instanceof CloudflareApiError))\n      throw new UploadFailed(",
    to: "if (false as boolean)\n      throw new UploadFailed(",
  },
  { name: "the throw-away control script is left in the account", file: D, from: "await client.deleteScript(controlName);", to: "" },
  {
    name: "the control upload is skipped, so every refusal looks like the binding's fault",
    file: D,
    from: 'await send(controlName, false);\n      input.ledger.created("worker_script", controlName);\n      control = { accepted: true };',
    to: "control = { accepted: true };",
  },
  // ---- the Cloudflare client
  {
    name: "the token is also put in the address",
    file: C,
    from: "new Request(`${base}${path}${queryString}`,",
    to: 'new Request(`${base}${path}${queryString || "?"}&t=${token}`,',
  },
  {
    name: "Cloudflare's error messages are shown without hiding secrets",
    file: C,
    from: 'const details = (body.errors ?? []).map((e) => hide(String(e.message ?? ""))).filter(Boolean);',
    to: 'const details = (body.errors ?? []).map((e) => String(e.message ?? "")).filter(Boolean);',
  },
  {
    name: "the saved answer body is not hidden",
    file: C,
    from: "throw new CloudflareApiError(spec.method, shownPath, response.status, codes, details, hide(text).slice(0, 4000));",
    to: "throw new CloudflareApiError(spec.method, shownPath, response.status, codes, details, text.slice(0, 4000));",
  },
  {
    name: "a write is repeated after a network failure",
    file: C,
    from: "if (safeToRepeatOnServerError && attempt < 3) {\n          await sleep(200 * attempt);\n          continue;\n        }\n        throw new CloudflareNetworkError",
    to: "if (attempt < 3) {\n          await sleep(200 * attempt);\n          continue;\n        }\n        throw new CloudflareNetworkError",
  },
  {
    name: "a write is repeated after a server error",
    file: C,
    from: "if (response.status >= 500 && safeToRepeatOnServerError && attempt < 3) {",
    to: "if (response.status >= 500 && attempt < 3) {",
  },
  {
    name: "the account id is kept in the call log",
    file: C,
    from: 'const shown = (path: string) => path.split(accountId).join("{account}");',
    to: "const shown = (path: string) => path;",
  },
  { name: "an answer that is not JSON is not noticed", file: C, from: 'if (body === null || typeof body !== "object") {', to: "if (false as boolean) {" },
  { name: "being rate limited is not waited out", file: C, from: "if (response.status === 429 && attempt < 4) {", to: "if (false as boolean) {" },
  { name: "every D1 query is called a read", file: C, from: 'statements.every((s) => readOnly(s.sql)) ? "select" : "write"', to: '"select"' },
  // ---- teardown
  { name: "teardown checks names only as it reaches them", file: T, from: "for (const entry of entries) assertProofName(entry.name);\n", to: "\n" },
  {
    name: "teardown does not check names at all",
    file: T,
    from: "for (const entry of entries) assertProofName(entry.name);\n\n  for (const entry of entries) {\n    assertProofName(entry.name); // and again at the point of use",
    to: "\n  for (const entry of entries) {\n",
  },
  {
    name: "teardown deletes a database by name without checking the id the ledger recorded",
    file: T,
    from: "const target = named.find((d) => d.uuid === entry.id) ?? (entry.id === undefined ? named[0] : undefined);",
    to: "const target = named[0];",
  },
  {
    name: "teardown also deletes proof-prefixed Workers the ledger does not know",
    file: T,
    from: "result.unledgered = await findUnledgered(client, ledger);",
    to: 'result.unledgered = await findUnledgered(client, ledger);\n  for (const u of result.unledgered) if (u.kind === "worker_script") await client.deleteScript(u.name);',
  },
  {
    name: "teardown deletes the database before the Worker",
    file: T,
    from: "{ workflow: 0, worker_script: 1, d1_database: 2 }",
    to: "{ workflow: 0, worker_script: 2, d1_database: 1 }",
  },
  // ---- the small pieces
  { name: "a URL-encoded secret is not hidden", file: R, from: "forms.add(encodeURIComponent(secret));", to: "" },
  {
    name: "the ledger is not saved when a resource is only planned",
    file: L,
    from: '} else current.entries.push({ kind, name, status: "creating", at: stamp() });\n      save();',
    to: '} else current.entries.push({ kind, name, status: "creating", at: stamp() });',
  },
  { name: "any name counts as the proof's", file: N, from: "const NAME = /^projectx-poc-[a-z0-9][a-z0-9-]{0,60}$/;", to: "const NAME = /^.*$/;" },
  {
    name: "the access key is replaced every run",
    file: K,
    from: "if (existing && existing.length >= 32) return existing;",
    to: "if (false as boolean) return existing;",
  },
  {
    name: "a damaged ledger file is treated as an empty one",
    file: L,
    from: 'return JSON.parse(readFileSync(path, "utf8")) as LedgerData;',
    to: 'try {\n        return JSON.parse(readFileSync(path, "utf8")) as LedgerData;\n      } catch {\n        return null;\n      }',
  },
  { name: "a token still wrapped in quotes is accepted", file: CR, from: "/[\\s\"']/.test(token)", to: "/\\s/.test(token)" },
];

function run(): string {
  const result = spawnSync(process.execPath, [join(root, "node_modules", "vitest", "vitest.mjs"), "run", "packages/deploy/test/provisioner"], {
    cwd: root,
    encoding: "utf8",
  });
  const out = stripVTControlCharacters(result.stdout + result.stderr);
  const tests = out
    .split(/\r?\n/)
    .find((l) => /^\s+Tests /.test(l))
    ?.trim()
    .replace(/^Tests\s+/, "");
  if (tests) return tests.replace(/ passed/g, "p").replace(/ failed/g, "f");
  return /FAIL|Error/.test(out) ? "(did not run)" : "(no summary)";
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
