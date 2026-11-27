// The import boundary gate (story 1.30, docs/import-boundaries.md). `pnpm lint:deps`'s command, run with the pinned
// dependency-cruiser on the real repo, passes on the clean repo and fails, naming the rule, when a brick reaches into
// another brick's folder by path or a package imports an app (by path or by package name). CI runs the same script in
// the gates job.
//
// The seeds are temporary files outside the proof inputsHash (which hashes .ts/.tsx/.sql/.json under packages/*/src,
// packages/*/test and the proven bricks credit-wallet, multi-workspace and dynamic-entities): the brick seed is a .mts
// file in a brick that is not proven (also outside what the brick manifest check and the vitest projects pick up), and
// the package seed sits in a scratch folder of packages/harness that is neither src nor test.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const depcruiseBin = join(repoRoot, "node_modules", "dependency-cruiser", "bin", "dependency-cruiser.mjs");
const scripts = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

interface Rule {
  name: string;
  comment?: string;
  from: { path?: string };
  to: { path?: string; pathNot?: string[] };
}
const loadConfig = () => createRequire(import.meta.url)(join(repoRoot, ".dependency-cruiser.cjs")) as { forbidden: Rule[] };

/** The arguments of the `depcruise ...` lint:deps script, so the test runs exactly what `pnpm lint:deps` runs. */
function lintDepsArgs(): string[] {
  const command = scripts["lint:deps"];
  expect(command, "package.json script lint:deps").toMatch(/^depcruise /);
  return command!.split(" ").slice(1);
}

function run(args: string[]): { status: number | null; output: string; stdout: string } {
  const r = spawnSync(process.execPath, [depcruiseBin, ...args], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, output: `${r.error?.message ?? ""}${r.stdout}${r.stderr}`, stdout: r.stdout ?? "" };
}

/**
 * Writes `files` (repo-relative path -> text), runs lint:deps, and deletes them again whatever happens, together with
 * `dirs`, the scratch folders created for them.
 */
function runWithSeeds(files: Record<string, string>, dirs: string[] = []): { status: number | null; output: string } {
  for (const rel of [...Object.keys(files), ...dirs]) expect(existsSync(join(repoRoot, rel)), `${rel} must not exist before seeding`).toBe(false);
  try {
    for (const dir of dirs) mkdirSync(join(repoRoot, dir), { recursive: true });
    for (const [rel, text] of Object.entries(files)) writeFileSync(join(repoRoot, rel), text, "utf8");
    return run(lintDepsArgs());
  } finally {
    for (const rel of Object.keys(files)) rmSync(join(repoRoot, rel), { force: true });
    for (const dir of dirs) rmSync(join(repoRoot, dir), { recursive: true, force: true });
  }
}

const BRICK_SEED = "bricks/subscription-plans/src/boundary-seed.tmp.mts";
// Not packages/harness/src or test, which the proof walks; lint:deps still scans it as packages/**.
const PACKAGE_SEED_DIR = "packages/harness/boundary-seed-tmp";
const PACKAGE_SEED = `${PACKAGE_SEED_DIR}/seed.ts`;

describe("import boundary gate (pnpm lint:deps)", () => {
  it("passes on the clean repo", () => {
    const { status, output } = run(lintDepsArgs());
    expect(status, output).toBe(0);
    expect(output).toContain("no dependency violations found");
  });

  it("fails, naming the rule, when a brick imports another brick's internal file by relative path", () => {
    const { status, output } = runWithSeeds({
      [BRICK_SEED]: 'export { auditRecorder } from "../../audit-trail/src/index.ts";\n',
    });
    expect(status, output).not.toBe(0);
    expect(output).toMatch(/brick-no-path-into-other-brick: bricks\/subscription-plans\/src\/boundary-seed\.tmp\.mts → bricks\/audit-trail\/src\/index\.ts/);
  });

  it("fails, naming the rule, when a package imports an app by path or by package name", () => {
    const { status, output } = runWithSeeds({ [PACKAGE_SEED]: 'export * from "../../../apps/studio-api/src/index.ts";\nexport * from "@poc/studio-api";\n' }, [
      PACKAGE_SEED_DIR,
    ]);
    expect(status, output).not.toBe(0);
    expect(output).toMatch(/package-no-app: packages\/harness\/boundary-seed-tmp\/seed\.ts → apps\/studio-api\/src\/index\.ts/);
    expect(output).toMatch(/no-app-package-import: packages\/harness\/boundary-seed-tmp\/seed\.ts → node_modules\/@poc\/studio-api\//);
  });

  it("forbids an app package by name however it resolves (the importer's own node_modules or the root's)", () => {
    const rule = loadConfig().forbidden.find((r) => r.name === "no-app-package-import");
    expect(rule, "no-app-package-import rule").toBeDefined();
    const from = new RegExp(rule!.from.path!);
    const to = new RegExp(rule!.to.path!);
    for (const source of ["packages/deploy/src/index.ts", "bricks/credit-wallet/src/index.ts"]) expect(source).toMatch(from);
    for (const resolved of [
      "packages/deploy/node_modules/@poc/studio-api/src/index.ts",
      "bricks/credit-wallet/node_modules/@poc/studio-web/src/main.tsx",
      "node_modules/@poc/studio-api/src/index.ts",
    ])
      expect(resolved).toMatch(to);
    expect("node_modules/@poc/studio-apix/src/index.ts").not.toMatch(to);
  });

  it("left no seed behind", () => {
    expect(existsSync(join(repoRoot, BRICK_SEED))).toBe(false);
    expect(existsSync(join(repoRoot, PACKAGE_SEED_DIR))).toBe(false);
  });

  it("lists only exceptions that are still in use: each excepted import exists in the repo", () => {
    const unescape = (pattern: string) => pattern.replace(/^\^/, "").replace(/\$$/, "").replace(/\\(.)/g, "$1");
    const isExact = (pattern: string) => pattern.startsWith("^") && pattern.endsWith("$");
    const excepted = loadConfig()
      .forbidden.filter((rule) => rule.comment?.startsWith("Exception"))
      .flatMap((rule) => (rule.to.pathNot ?? []).filter(isExact).map((to) => ({ rule: rule.name, from: unescape(rule.from.path!), to: unescape(to) })));
    expect(excepted.length).toBeGreaterThan(0);

    const args = lintDepsArgs().map((arg) => (arg === "err" ? "json" : arg));
    const { status, output, stdout } = run(args);
    expect(status, output.slice(0, 2000)).toBe(0);
    const result = JSON.parse(stdout) as { modules: { source: string; dependencies: { resolved: string }[] }[] };
    const edges = new Set(result.modules.flatMap((m) => m.dependencies.map((d) => `${m.source} -> ${d.resolved}`)));
    const stale = excepted.filter(({ from, to }) => !edges.has(`${from} -> ${to}`));
    expect(stale, "exceptions in .dependency-cruiser.cjs whose import no longer exists: remove them").toEqual([]);
  });

  it("runs in the CI gates job", () => {
    const ci = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const gates = ci.slice(ci.indexOf("\n  gates:"), ci.indexOf("\n  proof:"));
    expect(gates).toMatch(/run: pnpm lint:deps\n/);
  });
});
