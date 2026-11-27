// The unused code gate (story 1.31, CONTRIBUTING.md "Unused code"). `pnpm lint:unused`'s command, run with the pinned
// knip on the real repo, passes on the clean repo and fails, naming the export, when a module exports a symbol nothing
// imports. CI runs the same script in the gates job.
//
// The seed is a temporary scratch folder under scripts/test, outside the proof inputsHash and outside what the vitest
// projects collect: seed.ts exports a used and an unused symbol, and seed.test-d.ts (an entry for knip's vitest plugin,
// never run by `vitest run`) imports the used one. It is removed in `finally`.
//
// Exports a brick manifest names (route factories, executors, capability exports, guards, schedule and queue handlers)
// are wired by name by the assembler, so nothing imports them statically. They stay safe because check-manifests
// requires each one to be exported by the brick's package entry, knip treats that entry as an entry file, and knip never
// reports an entry file's exports while `includeEntryExports` is off. The last tests check those three facts.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkUnused, findingsOf, runKnip, type UnusedFinding } from "../lint-unused.ts";
import { UNUSED_ALLOWLIST } from "../lint-unused-allowlist.ts";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const scripts = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
const TIMEOUT = 180_000;

/** Runs the exact `lint:unused` package script, as `pnpm lint:unused` does. */
function runLintUnused(): { status: number | null; output: string } {
  const command = scripts["lint:unused"];
  expect(command, "package.json script lint:unused").toBe("node scripts/lint-unused.ts");
  const r = spawnSync(command!, { cwd: repoRoot, encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, output: `${r.error?.message ?? ""}${r.stdout}${r.stderr}` };
}

/**
 * Runs `lint:unused` on the clean repo. Other gate tests (import-boundaries, oxlint-types-gate) briefly write seed files
 * into the repo while the suite runs in parallel, and knip reports such a seed as an unused file. A failure is retried
 * only when every file it names is already gone again, so a real finding still fails.
 */
function runLintUnusedOnCleanRepo(): { status: number | null; output: string } {
  let result = runLintUnused();
  for (let attempt = 0; attempt < 3 && result.status === 1; attempt++) {
    const files = [...result.output.matchAll(/^[a-z][a-zA-Z ]+: ([^:\n]+): /gm)].map((m) => m[1]!);
    if (files.length === 0 || files.some((f) => existsSync(join(repoRoot, f)))) break;
    result = runLintUnused();
  }
  return result;
}

/** Every export name a brick manifest wires by name, per brick directory. */
function manifestNamedExports(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const bricksDir = join(repoRoot, "bricks");
  for (const dir of readdirSync(bricksDir, { withFileTypes: true })) {
    const manifestPath = join(bricksDir, dir.name, "brick.manifest.json");
    if (!dir.isDirectory() || !existsSync(manifestPath)) continue;
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      worker?: {
        routes?: { factory: string; options?: Record<string, unknown> }[];
        guard?: { export: string; suspension?: string };
        approvalGuard?: { export: string };
        capabilityExports?: Record<string, string[]>;
      };
      triggers?: { schedules?: { handler: string }[]; queues?: { handler: string }[] };
      nodes?: { executor: string }[];
    };
    const names = new Set<string>();
    for (const route of m.worker?.routes ?? []) {
      names.add(route.factory);
      for (const value of Object.values(route.options ?? {})) {
        if (value && typeof value === "object" && "$call" in value) names.add(String((value as { $call: unknown }).$call));
      }
    }
    if (m.worker?.guard) names.add(m.worker.guard.export);
    if (m.worker?.guard?.suspension) names.add(m.worker.guard.suspension);
    if (m.worker?.approvalGuard) names.add(m.worker.approvalGuard.export);
    for (const list of Object.values(m.worker?.capabilityExports ?? {})) for (const name of list) names.add(name);
    for (const s of m.triggers?.schedules ?? []) names.add(s.handler);
    for (const q of m.triggers?.queues ?? []) names.add(q.handler);
    for (const n of m.nodes ?? []) names.add(n.executor);
    out.set(dir.name, names);
  }
  return out;
}

describe("pnpm lint:unused (knip)", () => {
  it(
    "passes on the clean repo",
    () => {
      const { status, output } = runLintUnusedOnCleanRepo();
      expect(output).toContain("lint:unused: no unused files, exports or dependencies");
      expect(status).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "fails, naming the export, when a module exports a symbol nothing imports",
    () => {
      const seedDir = join(repoRoot, "scripts", "test", `knip-seed-${process.pid}-${Date.now()}`);
      const rel = seedDir.slice(repoRoot.length + 1).replace(/\\/g, "/");
      try {
        mkdirSync(seedDir, { recursive: true });
        writeFileSync(join(seedDir, "seed.ts"), "export const knipSeedUsed = 1;\nexport const knipSeedUnusedExport = 2;\n");
        writeFileSync(join(seedDir, "seed.test-d.ts"), 'import { knipSeedUsed } from "./seed.ts";\n\nvoid knipSeedUsed;\n');
        const { status, output } = runLintUnused();
        expect(output).toContain(`unused export: ${rel}/seed.ts: knipSeedUnusedExport`);
        expect(output).not.toContain("knipSeedUsed\n");
        expect(status).toBe(1);
      } finally {
        rmSync(seedDir, { recursive: true, force: true });
      }
      expect(existsSync(seedDir)).toBe(false);
    },
    TIMEOUT,
  );

  it("fails on a finding the allowlist does not name, and on an allowlist entry that matches nothing", () => {
    const finding: UnusedFinding = { kind: "exports", file: "packages/x/src/a.ts", name: "a" };
    const other: UnusedFinding = { kind: "exports", file: "packages/x/src/a.ts", name: "b" };
    const allow = [{ file: "packages/x/src/a.ts", kind: "exports", names: ["a", "gone"], reason: "test" }] as const;
    expect(checkUnused([finding, other], allow)).toEqual({
      unexpected: [other],
      stale: [{ kind: "exports", file: "packages/x/src/a.ts", name: "gone" }],
    });
    // Same name, other kind or other file: not accepted.
    expect(checkUnused([{ ...finding, kind: "types" }], allow).unexpected).toHaveLength(1);
    expect(checkUnused([{ ...finding, file: "packages/x/src/b.ts" }], allow).unexpected).toHaveLength(1);
    expect(() => checkUnused([], [{ file: "f", kind: "exports", names: ["a"], reason: " " }])).toThrow(/no reason/);
  });

  it("every allowlist entry names exact symbols and gives a reason", () => {
    for (const entry of UNUSED_ALLOWLIST) {
      expect(entry.reason.trim().length, `${entry.file} (${entry.kind})`).toBeGreaterThan(40);
      expect(entry.names.length).toBeGreaterThan(0);
      for (const name of [entry.file, ...entry.names]) expect(name, `${entry.file}: ${name}`).not.toMatch(/[*?{}]/);
    }
  });

  it("runs in the CI gates job", () => {
    const ci = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const gates = ci.slice(ci.indexOf("\n  gates:"), ci.indexOf("\n  proof:"));
    expect(gates).toContain("run: pnpm lint:unused");
  });

  it("knip treats each brick's package entry as an entry file and does not report entry exports", () => {
    const knipConfig = readFileSync(join(repoRoot, "knip.ts"), "utf8");
    expect(knipConfig).toContain('"bricks/*"');
    expect(knipConfig).not.toMatch(/includeEntryExports\s*:\s*true/);
    for (const brick of manifestNamedExports().keys()) {
      const pkg = JSON.parse(readFileSync(join(repoRoot, "bricks", brick, "package.json"), "utf8")) as { exports?: Record<string, string> };
      const entry = pkg.exports?.["."];
      expect(entry, `bricks/${brick}/package.json exports["."]`).toBeDefined();
      expect(existsSync(join(repoRoot, "bricks", brick, entry!)), `bricks/${brick}/${entry}`).toBe(true);
    }
  });

  it(
    "never reports an export a brick manifest names",
    () => {
      const findings = findingsOf(runKnip(repoRoot));
      const named = manifestNamedExports();
      const reported = findings.filter((f) => {
        const brick = /^bricks\/([^/]+)\//.exec(f.file)?.[1];
        return brick !== undefined && named.get(brick)?.has(f.name) === true;
      });
      expect(reported).toEqual([]);
      expect([...named.values()].reduce((n, s) => n + s.size, 0)).toBeGreaterThan(50);
    },
    TIMEOUT,
  );
});
