// Breaks the assembled project, the assembler and the H6 evidence on purpose, one way at a time, and prints what the H6
// scoreboard says each time. Used while building story 4.3. Always restores what it touched.
// Usage: node scripts/mutate-h6.ts
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const write = (rel: string, text: string) => writeFileSync(join(root, rel), text);

function h6(): string {
  const run = spawnSync(process.execPath, [join(root, "scripts", "verify.ts"), "H6"], { cwd: root, encoding: "utf8" });
  const out = (run.stdout + run.stderr).replace(/\x1B\[[0-9;]*m/g, "");
  const lines = out.split(/\r?\n/);
  const row = lines.find((l) => /^H6 /.test(l))?.replace(/\s{2,}/g, " ") ?? "(no H6 row)";
  const reasons = lines.filter((l) => /^\s+- /.test(l)).map((l) => l.trim().replace(/^- /, "")).join("; ");
  const extra = lines.filter((l) => /^(assembler names a brick|denial tests:)/.test(l)).map((l) => l.slice(0, 90)).slice(0, 2).join(" / ");
  const tests = lines.find((l) => /^Tests:/.test(l))?.replace(/\. Verdicts.*/, "") ?? "";
  return `exit ${run.status} | ${row.slice(0, 40)} | ${tests} | ${reasons.slice(0, 150)}${extra ? " | " + extra : ""}`;
}

const ASM = "packages/assembler/src/assemble.ts";
const DENIAL = "packages/assembler/test/H6.denial.test.ts";
const WALLET_MANIFEST = "bricks/credit-wallet/brick.manifest.json";
const MW = "bricks/multi-workspace/src/middleware.ts";
const ROUTES = "bricks/credit-wallet/src/routes.ts";

interface Case {
  name: string;
  file: string;
  from: string;
  to: string;
  /** More edits applied in the same mutation, each to its own file. */
  also?: Array<{ file: string; from: string; to: string }>;
}
const cases: Case[] = [
  { name: "the guard is never mounted", file: ASM, from: "for (const path of route.guardPaths) body.push(`app.use(${JSON.stringify(path)}, ${guard.export});`);", to: "" },
  { name: "the guard is mounted on the wallet only, not its sub-paths", file: WALLET_MANIFEST, from: '"guardPaths": ["/api/wallet", "/api/wallet/*", "/api/payments/create-order"]', to: '"guardPaths": ["/api/wallet"]' },
  { name: "the guard is mounted on a path that matches nothing", file: WALLET_MANIFEST, from: '"guardPaths": ["/api/wallet", "/api/wallet/*", "/api/payments/create-order"]', to: '"guardPaths": ["/api/other"]' },
  { name: "the guard does not check membership (any identified user passes)", file: MW, from: "WHERE m.workspace_id = ? AND m.user_id = ?", to: "WHERE m.workspace_id = ? AND ? IS NOT NULL" },
  { name: "the guard trusts a workspace from the request body (reads the raw body)", file: ROUTES, from: "    const body = DeductSchema.safeParse(await c.req.json().catch(() => ({})));\n    if (!body.success) return c.json({ error: \"Invalid amount (a whole number above zero)\" }, 400);", to: "    const rawBody = (await c.req.json().catch(() => ({}))) as { workspaceId?: string };\n    const body = DeductSchema.safeParse(rawBody);\n    if (!body.success) return c.json({ error: \"Invalid amount (a whole number above zero)\" }, 400);", also: [{ file: ROUTES, from: "workspaceId: ctx.workspace.id,\n        userId: ctx.user.uid,\n        amount: body.data.amount,", to: "workspaceId: rawBody.workspaceId ?? ctx.workspace.id,\n        userId: ctx.user.uid,\n        amount: body.data.amount," }] },
  { name: "the identity stub is not mounted", file: ASM, from: '`app.use(${JSON.stringify(API_PREFIX + "/*")}, stubIdentity);`,', to: '"",' },
  { name: "the assembler special-cases a brick by id", file: ASM, from: "const chosen: Chosen[] = [];", to: "const chosen: Chosen[] = [];\n  void 'credit-wallet';" },
  { name: "the assembler names a brick's export", file: ASM, from: "const API_PREFIX = \"/api\";", to: "const API_PREFIX = \"/api\"; // createWalletRoutes" },
  { name: "the assembler emits a test file into the project", file: ASM, from: "files[\"src/identity.stub.ts\"] = IDENTITY_STUB_SOURCE;", to: "files[\"src/identity.stub.ts\"] = IDENTITY_STUB_SOURCE;\n  files[\"test/denial.test.ts\"] = 'export {}';" },
  { name: "the assembler emits test code inside a source file", file: ASM, from: "files[\"src/identity.stub.ts\"] = IDENTITY_STUB_SOURCE;", to: "files[\"src/identity.stub.ts\"] = IDENTITY_STUB_SOURCE + 'expect(1).toBe(1);\\n';" },
  { name: "the repo's denial test file is deleted from the run", file: DENIAL, from: 'test("H6 report", async ({ task }) => {', to: 'test.skip("H6 report", async ({ task }) => {' },
  { name: "the report is hard-coded to true AND the guard is never mounted", file: DENIAL, from: "crossTenantDenied: denied.every(Boolean), ownWalletWorks: mine.every(Boolean)", to: "crossTenantDenied: true, ownWalletWorks: true", also: [{ file: ASM, from: "for (const path of route.guardPaths) body.push(`app.use(${JSON.stringify(path)}, ${guard.export});`);", to: "" }] },
  { name: "the report is hard-coded to true AND the guard ignores which user asks", file: DENIAL, from: "crossTenantDenied: denied.every(Boolean), ownWalletWorks: mine.every(Boolean)", to: "crossTenantDenied: true, ownWalletWorks: true", also: [{ file: MW, from: "WHERE m.workspace_id = ? AND m.user_id = ?", to: "WHERE m.workspace_id = ? AND ? IS NOT NULL" }] },
  { name: "one named attack is renamed in the test file (its listed title disappears)", file: DENIAL, from: `test("spending B's credits"`, to: `test("spending B's credit"` },
  { name: "one named attack is skipped", file: DENIAL, from: `test("naming both workspaces in one header"`, to: `test.skip("naming both workspaces in one header"` },
  { name: "the denial tests stop checking the wallet read (no 403 assertion)", file: DENIAL, from: "    const reply = await call(\"/api/wallet\", \"alice\", w.b);\n    expect(reply.status).toBe(403);", to: "    const reply = await call(\"/api/wallet\", \"alice\", w.b);\n    expect(reply.status).toBeGreaterThan(0);" },
];

console.log(`baseline                                                    -> ${h6()}`);
for (const c of cases) {
  const edits = [{ file: c.file, from: c.from, to: c.to }, ...(c.also ?? [])];
  const originals = new Map(edits.map((e) => [e.file, read(e.file)]));
  if (edits.some((e) => !originals.get(e.file)!.includes(e.from))) {
    console.log(`${c.name.padEnd(60)}-> MUTATION DID NOT APPLY`);
    continue;
  }
  for (const e of edits) write(e.file, read(e.file).replace(e.from, e.to));
  // The catalog must be rebuilt when a manifest changes, as a developer would; otherwise the staleness test (not H6) is what fails.
  const rebuilds = edits.some((e) => e.file.endsWith("brick.manifest.json"));
  if (rebuilds) spawnSync(process.execPath, [join(root, "scripts", "build-catalog.ts")], { cwd: root });
  try {
    console.log(`${c.name.padEnd(60)}-> ${h6()}`);
  } finally {
    for (const [file, text] of originals) write(file, text);
    if (rebuilds) spawnSync(process.execPath, [join(root, "scripts", "build-catalog.ts")], { cwd: root });
  }
}
console.log(`restored                                                    -> ${h6()}`);
void existsSync;
