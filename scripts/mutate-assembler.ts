// Breaks the assembler, its schemas, the manifests and the catalog on purpose, one way at a time, and prints how many
// assembler tests fail each time. Used while building story 4.1. Always restores what it touched.
// Usage: node scripts/mutate-assembler.ts
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const root = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const write = (rel: string, text: string) => writeFileSync(join(root, rel), text);

function runTests(): string {
  const run = spawnSync(process.execPath, [join(root, "node_modules", "vitest", "vitest.mjs"), "run", "packages/assembler"], { cwd: root, encoding: "utf8" });
  const out = stripVTControlCharacters(run.stdout + run.stderr);
  const tests =
    out
      .split(/\r?\n/)
      .find((l) => /^\s+Tests /.test(l))
      ?.trim() ?? "(no test summary)";
  const first = [...out.matchAll(/^ FAIL .*? > (.*)$/gm)].map((m) => m[1]!.slice(0, 80))[0];
  return `${tests}${first ? "  first: " + first : ""}`;
}

const ASM = "packages/assembler/src/assemble.ts";
const SCH = "packages/assembler/src/schemas.ts";
const WALLET_MANIFEST = "bricks/credit-wallet/brick.manifest.json";
const MW_MIGRATION = "bricks/multi-workspace/migrations/0001_multi_workspace.sql";
const cases: Array<{ name: string; file: string; from: string; to: string }> = [
  {
    name: "bricks are mounted in the order the blueprint lists them",
    file: ASM,
    from: "const order = orderBricks(chosen, providerOf);\n  if (!order.ok) return { ok: false, errors: order.errors };\n  const ordered = order.bricks;",
    to: "const ordered = chosen;",
  },
  {
    name: "ties are not broken by id (set order decides)",
    file: ASM,
    from: ".filter((id) => [...waitingOn.get(id)!].every((dep) => !remaining.has(dep))).sort();",
    to: ".filter((id) => [...waitingOn.get(id)!].every((dep) => !remaining.has(dep)));",
  },
  {
    name: "a dependency cycle is silently dropped, not refused",
    file: ASM,
    from: 'if (ready.length === 0) return { ok: false, errors: [`bricks depend on each other in a cycle: ${[...remaining].sort().join(", ")}`] };',
    to: "if (ready.length === 0) break;",
  },
  {
    name: "the guard is mounted after the routes it guards",
    file: ASM,
    from: "for (const path of route.guardPaths) body.push(`app.use(${JSON.stringify(path)}, ${guard.export});`);\n      }\n      use(brick.manifest.worker.package, route.factory);",
    to: "}\n      use(brick.manifest.worker.package, route.factory);",
  },
  { name: "a missing provider is not noticed", file: ASM, from: "if (providerOf.has(capability)) continue;", to: "continue;" },
  { name: "two providers of one capability are accepted", file: ASM, from: "if (existing) errors.push(", to: "if (false as boolean) errors.push(" },
  {
    name: "an unknown brick is skipped instead of refused",
    file: ASM,
    from: '      errors.push(`unknown brick "${id}" (available: ${available.join(", ") || "none"})`);\n      continue;',
    to: "      continue;",
  },
  { name: "a duplicate brick is accepted", file: ASM, from: "if (seen.has(id)) {", to: "if (false as boolean) {" },
  { name: "setting values are not range-checked", file: ASM, from: "|| value < definition.min || value > definition.max", to: "" },
  { name: "an unknown setting is ignored", file: ASM, from: "if (!(name in definitions)) errors.push(", to: "if (false as boolean) errors.push(" },
  {
    name: "the settings default is used even when the blueprint sets a value",
    file: ASM,
    from: "const value = name in config ? config[name]! : definition.default;",
    to: "const value = definition.default;",
  },
  {
    name: "conflicting package versions are accepted",
    file: ASM,
    from: "if (dependencies[name] !== undefined && dependencies[name] !== version) errors.push(",
    to: "if (false as boolean) errors.push(",
  },
  { name: "files come out in insertion order, not sorted", file: ASM, from: "files: sortKeys(files) };", to: "files };" },
  {
    name: "a timestamp is written into project.json",
    file: ASM,
    from: "project: blueprint.project,\n    identity: blueprint.identity,",
    to: "project: blueprint.project,\n    builtAt: new Date().toISOString(),\n    identity: blueprint.identity,",
  },
  {
    name: "a random id is written into package.json",
    file: ASM,
    from: "name: blueprint.project,\n    private: true,",
    to: "name: blueprint.project + globalThis.crypto.randomUUID().slice(0, 4),\n    private: true,",
  },
  {
    name: "the project name is not checked (path traversal allowed)",
    file: SCH,
    from: "project: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),",
    to: "project: z.string(),",
  },
  {
    name: "export names are not checked",
    file: SCH,
    from: "export const identifier = z.string().regex(IDENTIFIER);",
    to: "export const identifier = z.string();",
  },
  { name: "mount paths are not checked", file: SCH, from: "const mountPath = z.string().regex(MOUNT_PATH);", to: "const mountPath = z.string();" },
  {
    name: "migration paths are not checked",
    file: SCH,
    from: "migrations: z.array(z.string().regex(RELATIVE_FILE)).default([]),",
    to: "migrations: z.array(z.string()).default([]),",
  },
  {
    name: "dependency versions may be ranges",
    file: SCH,
    from: "npmDependencies: z.record(z.string().regex(PACKAGE_NAME), z.string().regex(EXACT_VERSION)).default({}),",
    to: "npmDependencies: z.record(z.string(), z.string()).default({}),",
  },
  {
    name: "unknown keys in a manifest are accepted",
    file: SCH,
    from: "export const ManifestSchema = z\n  .strictObject({",
    to: "export const ManifestSchema = z\n  .object({",
  },
  {
    name: "unknown keys in a blueprint are accepted",
    file: SCH,
    from: "export const BlueprintSchema = z.strictObject({",
    to: "export const BlueprintSchema = z.object({",
  },
  { name: "the wallet no longer says it needs a workspace guard", file: WALLET_MANIFEST, from: '"requires": ["workspace-context"],', to: '"requires": [],' },
  {
    name: "the wallet's routes are no longer guarded",
    file: WALLET_MANIFEST,
    from: '"guardPaths": ["/api/wallet", "/api/wallet/*", "/api/payments/create-order"]',
    to: '"guardPaths": ["/api/wallet"]',
  },
  {
    name: "a brick's migration changes without the catalog being rebuilt",
    file: MW_MIGRATION,
    from: "CREATE TABLE IF NOT EXISTS mw_members",
    to: "CREATE TABLE IF NOT EXISTS mw_member_list",
  },
  { name: "a brick's setting is renamed in the package but not the manifest", file: WALLET_MANIFEST, from: '"createWalletRoutes"', to: '"createWalletRoute"' },
];

console.log(`baseline                                                    -> ${runTests()}`);
for (const c of cases) {
  const original = read(c.file);
  if (!original.includes(c.from) || c.from === c.to) {
    console.log(`${c.name.padEnd(60)}-> MUTATION DID NOT APPLY`);
    continue;
  }
  write(c.file, original.replace(c.from, c.to));
  try {
    console.log(`${c.name.padEnd(60)}-> ${runTests()}`);
  } finally {
    write(c.file, original);
  }
}
console.log(`restored                                                    -> ${runTests()}`);
