// Breaks the deploy package on purpose, one way at a time, and prints how many tests fail in each of its three suites.
// Used while building epic 5, story 1. Always restores what it touched: it keeps its own copy of every file it edits
// (the package may not be committed yet, so git is not a safety net), restores from that copy even after an interrupted
// run, and compares hashes at the end.
// Usage: node scripts/mutate-deploy.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const backup = join(root, "out", "mutate-deploy-backup");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const write = (rel: string, text: string) => writeFileSync(join(root, rel), text);
const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const slug = (rel: string) => rel.replace(/[\\/]/g, "__");

const G = "packages/deploy/src/worker/gate.ts";
const B = "packages/deploy/src/bundle.ts";
const S = "packages/deploy/src/scripted-check.ts";
const D = "packages/deploy/client/demo-entry.tsx";
const P = "packages/deploy/src/provisioner/deploy.ts";

interface Case {
  name: string;
  file: string;
  from: string;
  to: string;
}
const cases: Case[] = [
  { name: "the key is not checked", file: G, from: "if (given === null || !(await sameSecret(given, expected))) return json(401, { error: \"unauthorized\" });", to: "" },
  { name: "the key is compared by prefix", file: G, from: "!(await sameSecret(given, expected))", to: "!expected.startsWith(given)" },
  { name: "the key is compared by its first 8 bytes only (EQUIVALENT: a 64-bit collision of two SHA-256 digests is not observable)", file: G, from: "for (let i = 0; i < a.length; i += 1)", to: "for (let i = 0; i < 8; i += 1)" },
  { name: "every secret matches", file: G, from: "return difference === 0;", to: "return true;" },
  { name: "anything under /demo is open", file: G, from: "request.method === \"GET\" && url.pathname === DEMO_PATH", to: "request.method === \"GET\" && url.pathname.startsWith(DEMO_PATH)" },
  { name: "any method on /demo is open", file: G, from: "request.method === \"GET\" && url.pathname === DEMO_PATH", to: "url.pathname === DEMO_PATH" },
  { name: "the key is also accepted in the query string", file: G, from: "const given = request.headers.get(KEY_HEADER);", to: "const given = request.headers.get(KEY_HEADER) ?? url.searchParams.get(KEY_HEADER);" },
  { name: "the key is also accepted as a bearer token", file: G, from: "const given = request.headers.get(KEY_HEADER);", to: "const given = request.headers.get(KEY_HEADER) ?? request.headers.get(\"authorization\")?.replace(/^Bearer /, \"\") ?? null;" },
  { name: "the key header is a different one", file: G, from: 'export const KEY_HEADER = "x-poc-key";', to: 'export const KEY_HEADER = "x-key";' },
  { name: "a short key is accepted (minimum length 0)", file: G, from: "export const MIN_KEY_LENGTH = 16;", to: "export const MIN_KEY_LENGTH = 0;" },
  { name: "no key configured lets everyone in", file: G, from: "return json(503, { error: \"this deployment has no access key configured\" });", to: "return options.app.fetch(request, env, ctx);" },
  { name: "a refusal echoes the key it was given", file: G, from: 'return json(401, { error: "unauthorized" });', to: 'return json(401, { error: "unauthorized", given });' },
  { name: "the 503 echoes the configured key", file: G, from: 'return json(503, { error: "this deployment has no access key configured" });', to: 'return json(503, { error: "this deployment has no access key configured", expected });' },
  { name: "the demo page carries the key", file: G, from: "return new Response(options.demoHtml, { status: 200, headers: DEMO_HEADERS });", to: "return new Response(options.demoHtml + String((env as GateEnv).POC_ACCESS_KEY ?? \"\"), { status: 200, headers: DEMO_HEADERS });" },
  { name: "the demo page may call anywhere (CSP connect-src opened)", file: G, from: "connect-src 'self';", to: "connect-src *;" },
  { name: "the demo page is cached", file: G, from: '"cache-control": "no-store",\n  "x-content-type-options"', to: '"cache-control": "public, max-age=3600",\n  "x-content-type-options"' },
  { name: "the bundle has no gate (the project is exported directly)", file: B, from: "`export default createGatedWorker({ app, demoHtml: ${JSON.stringify(demoHtml)} });`,", to: "`export default app;`," },
  { name: "Node-only imports are left for the runtime to find", file: B, from: 'external: ["cloudflare:*"],', to: 'external: ["cloudflare:*", "node:*"],' },
  { name: "the bundle carries a timestamp", file: B, from: "legalComments: \"none\",\n    metafile: true,", to: "legalComments: \"none\",\n    banner: { js: `// built ${Date.now()}` },\n    metafile: true," },
  { name: "the demo page's script is not escaped", file: B, from: 'const safe = script.replace(/<\\/script/gi, "<\\\\/script");', to: "const safe = script;" },
  { name: "a missing project folder is not noticed", file: B, from: 'if (!existsSync(join(projectDir, "src", "index.ts"))) throw', to: 'if (false as boolean) throw' },
  { name: "the size limit is not enforced in the report (always within)", file: B, from: "within: bytes <= WORKER_SIZE_LIMIT_BYTES", to: "within: true" },
  { name: "the scripted check passes everything", file: S, from: "return JSON.stringify(observations) === JSON.stringify(SCRIPTED_EXPECTED);", to: "return true;" },
  { name: "the scripted check expects a leak (B sees A's invoice)", file: S, from: '{ step: "B lists its invoices and sees none of A\'s", status: 200, facts: { total: 0, sawAcme: false } },', to: '{ step: "B lists its invoices and sees none of A\'s", status: 200, facts: { total: 1, sawAcme: true } },' },
  { name: "the scripted check does not ask for the foreign invoice", file: S, from: 'const readOther = await call("B reads A\'s invoice by id and is refused", "GET", `/api/invoices/${encodeURIComponent(invoiceId)}`, "bob", wsB);', to: 'const readOther = await call("B reads A\'s invoice by id and is refused", "GET", `/api/invoices/${encodeURIComponent("nothing")}`, "bob", wsB);' },
  { name: "the demo page script makes its own network call", file: D, from: "const root = document.getElementById(\"root\");", to: "void fetch(\"/api/wallet\");\nconst root = document.getElementById(\"root\");" },
  { name: "the bundler starts another program", file: B, from: 'import { gzipSync } from "node:zlib";', to: 'import { gzipSync } from "node:zlib";\nimport { execSync } from "node:child_process";\nvoid execSync;' },
  { name: "the gate evaluates code", file: G, from: "const encoder = new TextEncoder();", to: "const encoder = new TextEncoder();\nvoid eval(\"1\");" },
  { name: "orphan version is not adopted (always re-uploaded)", file: P, from: "if (orphanVersion) {", to: "if (false as boolean && orphanVersion) {" },
  { name: "active 100% deployment is not reconciled (always creates deployment)", file: P, from: "if (!isAlreadyActiveAt100) {", to: "if (true) {" },
  { name: "bookmark failure does not block migrations", file: P, from: "const bookmark = await client.getD1Bookmark(databaseId);", to: 'const bookmark = "bypassed_bookmark";' },
  { name: "uploadVersion failure is not recorded in deploy history", file: P, from: "status = 'upload_failed'", to: "status = 'success'" },
];

const suites = ["packages/deploy/test/gate.test", "packages/deploy/test/scripted-check.test", "packages/deploy/test/bundle.node", "packages/deploy/test/deploy-faults.node"];
function run(filter: string): string {
  const result = spawnSync(process.execPath, [join(root, "node_modules", "vitest", "vitest.mjs"), "run", filter], { cwd: root, encoding: "utf8" });
  const out = (result.stdout + result.stderr).replace(/\x1B\[[0-9;]*m/g, "");
  const tests = out.split(/\r?\n/).find((l) => /^\s+Tests /.test(l))?.trim().replace(/^Tests\s+/, "") ?? (/FAIL|Error/.test(out) ? "(did not run)" : "(no summary)");
  return tests.replace(/ passed/g, "p").replace(/ failed/g, "f");
}
const runAll = () => suites.map((s) => `${s.split("/").pop()!.replace(".test", "")} ${run(s)}`).join(" | ");

// restore anything a previous interrupted run left behind. A backup is only ever deleted after a run that finished and
// found every file identical, so a backup that exists belongs to an interrupted run. An EMPTY backup is never trusted:
// restoring it would overwrite a real source file with nothing (this happened once, when finished runs blanked their
// backups instead of deleting them).
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

console.log(`baseline -> ${runAll()}`);
for (const c of cases) {
  const original = read(c.file);
  if (!original.includes(c.from)) {
    console.log(`${c.name.padEnd(66)}-> MUTATION DID NOT APPLY`);
    continue;
  }
  write(c.file, original.replace(c.from, c.to));
  try {
    console.log(`${c.name.padEnd(66)}-> ${runAll()}`);
  } finally {
    write(c.file, original);
  }
}
console.log(`restored -> ${runAll()}`);
const after = new Map(targets.map((f) => [f, sha(read(f))]));
const changed = targets.filter((f) => before.get(f) !== after.get(f));
console.log(changed.length === 0 ? `files identical to before the run: ${targets.length} of ${targets.length}` : `FILES NOT RESTORED: ${changed.join(", ")}`);
if (changed.length === 0) for (const file of targets) rmSync(join(backup, slug(file)), { force: true }); // a clean finish leaves nothing behind to restore
