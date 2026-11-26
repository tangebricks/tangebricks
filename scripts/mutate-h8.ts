// Breaks the entity router, the shared contract, the assembler's entity handling and the H8 evidence on purpose, one way at
// a time, and prints what the H8 scoreboard says each time. Used while building story 4.5. Always restores what it touched.
// Usage: node scripts/mutate-h8.ts
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const root = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const write = (rel: string, text: string) => writeFileSync(join(root, rel), text);

function units(): string {
  const run = spawnSync(process.execPath, [join(root, "node_modules", "vitest", "vitest.mjs"), "run", "packages/sdk", "bricks/dynamic-entities", "packages/assembler/test/H8.entities-assembly", "packages/assembler/test/assembler", "packages/assembler/test/catalog"], { cwd: root, encoding: "utf8" });
  const out = stripVTControlCharacters(run.stdout + run.stderr);
  return out.split(/\r?\n/).find((l) => /^\s+Tests /.test(l))?.trim().replace(/^Tests\s+/, "") ?? "(no summary)";
}

function h8(): string {
  const run = spawnSync(process.execPath, [join(root, "scripts", "verify.ts"), "H8"], { cwd: root, encoding: "utf8" });
  const out = stripVTControlCharacters(run.stdout + run.stderr);
  const lines = out.split(/\r?\n/);
  const row = lines.find((l) => l.startsWith("H8 "))?.replace(/\s{2,}/g, " ").replace(" An entity declaration yields tenant-safe CRUD", "") ?? "(no H8 row)";
  const reasons = lines.filter((l) => /^\s+- /.test(l)).map((l) => l.trim().replace(/^- (check )?/, "")).join("; ");
  const extra = lines.filter((l) => /^(entity named in code|h8-entity-tests\.json: (?!not found))/.test(l)).map((l) => l.slice(0, 80)).slice(0, 1).join("");
  const tests = lines.find((l) => l.startsWith("Tests:"))?.replace(/\. Verdicts.*/, "") ?? "";
  return `exit ${run.status} | ${row} | ${tests} | ${reasons.slice(0, 110)}${extra ? " | " + extra : ""}`;
}

const R = "bricks/dynamic-entities/src/routes.ts";
const ASM = "packages/assembler/src/assemble.ts";
const SDK = "packages/sdk/src/entities.ts";
const TEST = "packages/assembler/test/H8.entities.test.ts";
const MW = "bricks/multi-workspace/src/middleware.ts";

interface Case {
  name: string;
  file: string;
  from: string;
  to: string;
  also?: Array<{ file: string; from: string; to: string }>;
}
const cases: Case[] = [
  { name: "read by id ignores the workspace", file: R, from: 'WHERE "id" = ? AND "workspace_id" = ?`).bind(id, workspaceId).first<Row>();', to: 'WHERE "id" = ? AND ? IS NOT NULL`).bind(id, workspaceId).first<Row>();' },
  { name: "list ignores the workspace", file: R, from: 'WHERE "workspace_id" = ? ORDER BY "created_at" DESC, "id" LIMIT ? OFFSET ?`)\n          .bind(ctx.workspace.id,', to: 'WHERE ? IS NOT NULL ORDER BY "created_at" DESC, "id" LIMIT ? OFFSET ?`)\n          .bind(ctx.workspace.id,' },
  { name: "the total counts every workspace's rows", file: R, from: 'SELECT COUNT(*) AS n FROM ${table} WHERE "workspace_id" = ?`', to: 'SELECT COUNT(*) AS n FROM ${table} WHERE ? IS NOT NULL`' },
  { name: "update ignores the workspace", file: R, from: '"updated_at" = datetime(\'now\') WHERE "id" = ? AND "workspace_id" = ?`)', to: '"updated_at" = datetime(\'now\') WHERE "id" = ? AND ? IS NOT NULL`)' },
  { name: "delete ignores the workspace", file: R, from: 'DELETE FROM ${table} WHERE "id" = ? AND "workspace_id" = ?`', to: 'DELETE FROM ${table} WHERE "id" = ? AND ? IS NOT NULL`' },
  { name: "create takes the workspace from the body", file: R, from: '.bind(id, ctx.workspace.id, ...entity.fields.map((f) => store(f, (body.data as Row)[f.name])))', to: '.bind(id, String(((await c.req.raw.clone().json().catch(() => ({}))) as { workspace_id?: string }).workspace_id ?? ctx.workspace.id), ...entity.fields.map((f) => store(f, (body.data as Row)[f.name])))' },
  { name: "create takes the row id from the body", file: R, from: "      const id = crypto.randomUUID();\n      try {\n        await c.env.DB.prepare(`INSERT", to: "      const id = String(((await c.req.raw.clone().json().catch(() => ({}))) as { id?: string }).id ?? crypto.randomUUID());\n      try {\n        await c.env.DB.prepare(`INSERT" },
  { name: "a row in another workspace is answered differently from a missing row (it leaks that the row exists)", file: R, from: 'const row = await readOne(c, ctx.workspace.id, id);\n        // A row in another workspace is answered exactly like a row that does not exist.', to: 'const row = await readOne(c, ctx.workspace.id, id);\n        const elsewhere = row ? null : await c.env.DB.prepare(`SELECT "id" FROM ${table} WHERE "id" = ?`).bind(id).first();\n        if (elsewhere) return c.json({ error: "Forbidden" }, 403);\n        // A row in another workspace is answered exactly like a row that does not exist.' },
  { name: "the update takes its column names from the raw body, not the declaration", file: R, from: "const changes = entity.fields.filter((f) => (body.data as Row)[f.name] !== undefined);", to: "const rawKeys = Object.keys((await c.req.raw.clone().json().catch(() => ({}))) as Row);\n      const changes = [...entity.fields.filter((f) => (body.data as Row)[f.name] !== undefined), ...rawKeys.filter((k) => !entity.fields.some((f) => f.name === k)).map((k) => ({ name: k, type: \"text\" as const, required: false, maxLength: 99 }))];" },
  { name: "a text value is joined into the SQL instead of bound", file: R, from: '.bind(...changes.map((f) => store(f, (body.data as Row)[f.name])), id, ctx.workspace.id)', to: '.bind(...changes.map((f) => store(f, (body.data as Row)[f.name])), id, ctx.workspace.id)', also: [{ file: R, from: 'SET ${changes.map((f) => `${q(f.name)} = ?`).join(", ")},', to: 'SET ${changes.map((f) => `${q(f.name)} = \'${String((body.data as Row)[f.name]).replaceAll("\'", "\'\'")}\'`).join(", ")},' }] },
  { name: "paging values are not validated", file: R, from: "limit: z.coerce.number().int().min(1).max(100).default(50),", to: "limit: z.coerce.number().default(50)," },
  { name: "the id is no longer checked before it reaches the database", file: R, from: "const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;", to: "const UUID = /^.*$/;" },
  { name: "enum values are not enforced", file: R, from: "return z.enum(field.values as [string, ...string[]]);", to: "return z.string();" },
  { name: "text length is not enforced", file: R, from: "return z.string().max(field.maxLength);", to: "return z.string();" },
  { name: "numbers may be fractional", file: R, from: 'let schema = z.number().int().refine(Number.isSafeInteger, "must be a whole number");', to: "let schema = z.number() as unknown as z.ZodNumber;" },
  { name: "required fields become optional", file: R, from: "shape[field.name] = field.required ? value : value.nullable().optional();", to: "shape[field.name] = value.nullable().optional();" },
  { name: "the router fails open when no guard ran (guesses the workspace from the header)", file: R, from: 'if (!workspace) return { failure: c.json({ error: "Missing workspace context" }, 400) } as const;', to: 'if (!workspace) return { user, workspace: { id: c.req.header("x-workspace-id") ?? "", role: "member", suspended: false } } as const;' },
  { name: "database errors are returned to the caller", file: R, from: 'console.error(where, error);\n    return c.json({ error: "Internal error" }, 500);', to: 'return c.json({ error: String(error) }, 500);' },
  { name: "the contract allows a field named workspace_id", file: SDK, from: 'new Set(["id", "workspace_id", "created_at", "updated_at", "rowid", "oid", "_rowid_"])', to: 'new Set(["id", "created_at", "updated_at", "rowid", "oid", "_rowid_"])' },
  { name: "the contract allows any characters in a name", file: SDK, from: "const NAME = /^[a-z][a-z0-9_]{0,39}$/;", to: "const NAME = /^.{1,40}$/;" },
  { name: "the contract allows any enum value", file: SDK, from: "const ENUM_VALUE = /^[a-z0-9_]{1,40}$/;", to: "const ENUM_VALUE = /^.{1,40}$/;" },
  { name: "the generated table has no workspace column constraint (nullable)", file: SDK, from: '`${q("workspace_id")} TEXT NOT NULL`,', to: '`${q("workspace_id")} TEXT`,' },
  { name: "the assembler does not mount the guard in front of the entity's routes", file: ASM, from: "path.includes(\"{entity}\") ? entities.map((entity) => path.replaceAll(\"{entity}\", entity.name)) : [path]", to: "path.includes(\"{entity}\") ? [] : [path]" },
  { name: "the assembler writes an entity's name into the entry's code", file: ASM, from: 'body.push(`app.route(${JSON.stringify(route.mountAt)}, ${route.factory}(', to: 'body.push(`// ${entities.map((e) => e.name).join(",")}`);\n      body.push(`app.route(${JSON.stringify(route.mountAt)}, ${route.factory}(' },
  { name: "the assembler hard-codes the invoices entity", file: ASM, from: "const reserved = new Set(", to: "const invoicesHardCoded = 'invoices';\n  const reserved = new Set(" },
  { name: "a brick's routes are no longer reserved against entity names", file: ASM, from: "const reserved = new Set(Object.values(catalog.bricks).flatMap((b) => b.manifest.routePrefixes));", to: "const reserved = new Set<string>();" },
  { name: "the report claims every check without looking (and the router is broken)", file: TEST, from: "const checks = Object.fromEntries(Object.entries(ok).map(([name, results]) => [name, results.length > 0 && results.every(Boolean)]));", to: "const checks = Object.fromEntries(Object.entries(ok).map(([name]) => [name, true]));", also: [{ file: R, from: 'WHERE "id" = ? AND "workspace_id" = ?`).bind(id, workspaceId).first<Row>();', to: 'WHERE "id" = ? AND ? IS NOT NULL`).bind(id, workspaceId).first<Row>();' }] },
  { name: "one listed attack is renamed in the test file", file: TEST, from: 'it("B updating A\'s invoice"', to: 'it("B updating A\'s invoices"' },
  { name: "one listed attack is skipped", file: TEST, from: 'it("injection-shaped ids reach nothing"', to: 'it.skip("injection-shaped ids reach nothing"' },
  { name: "the guard stops checking membership AND the report is hard-coded", file: TEST, from: "const checks = Object.fromEntries(Object.entries(ok).map(([name, results]) => [name, results.length > 0 && results.every(Boolean)]));", to: "const checks = Object.fromEntries(Object.entries(ok).map(([name]) => [name, true]));", also: [{ file: MW, from: "WHERE m.workspace_id = ? AND m.user_id = ?", to: "WHERE m.workspace_id = ? AND ? IS NOT NULL" }] },
];

console.log(`baseline                                                    -> ${h8()}  || units: ${units()}`);
for (const c of cases) {
  const edits = [{ file: c.file, from: c.from, to: c.to }, ...(c.also ?? [])];
  const originals = new Map(edits.map((e) => [e.file, read(e.file)]));
  if (edits.some((e) => !originals.get(e.file)!.includes(e.from)) || c.from === c.to && !c.also) {
    console.log(`${c.name.padEnd(60)}-> MUTATION DID NOT APPLY`);
    continue;
  }
  for (const e of edits) write(e.file, read(e.file).replace(e.from, e.to));
  try {
    console.log(`${c.name.padEnd(60)}-> ${h8()}  || units: ${units()}`);
  } finally {
    for (const [file, text] of originals) write(file, text);
  }
}
console.log(`restored                                                    -> ${h8()}  || units: ${units()}`);
