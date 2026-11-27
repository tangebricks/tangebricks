// The type-aware lint gate (`pnpm lint:types`). Run exactly as the script runs it (the pinned oxlint with
// .oxlintrc.types.json and --type-aware, which drives the pinned oxlint-tsgolint, over the money, auth and deploy paths),
// it must fail on a seeded file inside a covered path that calls the real wallet's async deduct without awaiting it,
// naming no-floating-promises, and must pass on the repository while actually linting files.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const oxlintBin = join(repoRoot, "node_modules", "oxlint", "bin", "oxlint");

/** The arguments `pnpm lint:types` passes to oxlint, read from package.json so the test cannot drift from the script. */
function lintTypesArgs(): string[] {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const [command, ...args] = (pkg.scripts["lint:types"] ?? "").split(/\s+/).filter(Boolean);
  expect(command).toBe("oxlint");
  return args;
}

function runOxlint(args: readonly string[]): { status: number | null; output: string } {
  const run = spawnSync(process.execPath, [oxlintBin, ...args], { cwd: repoRoot, encoding: "utf8" });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

/** An oxlint config file: JSON with whole-line `//` comments. */
function readConfig(name: string): { ignorePatterns?: string[] } {
  const text = readFileSync(join(repoRoot, name), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return JSON.parse(text) as { ignorePatterns?: string[] };
}

describe("oxlint type-aware gate (lint:types)", () => {
  it("the script runs the dedicated config, type-aware, with warnings denied, over bricks/credit-wallet/src", () => {
    const args = lintTypesArgs();
    expect(args.slice(0, 4)).toEqual(["-c", ".oxlintrc.types.json", "--type-aware", "--deny-warnings"]);
    expect(args).toContain("bricks/credit-wallet/src");
  });

  it("ignores everything the base config ignores", () => {
    const base = readConfig(".oxlintrc.json").ignorePatterns ?? [];
    const types = readConfig(".oxlintrc.types.json").ignorePatterns ?? [];
    expect(base.length).toBeGreaterThan(0);
    for (const pattern of base) expect(types, pattern).toContain(pattern);
  });

  // The seed goes under bricks/subscription-plans/src: covered by lint:types, but not one of the proven bricks whose files
  // feed the proof inputsHash, so a test hashing those files in parallel never sees it. It calls the real async credit
  // grant (a wallet credit through walletCharger) without awaiting it.
  it("fails on a seeded un-awaited credit grant in a covered brick and names no-floating-promises", () => {
    const seedName = `__lint_types_seed_${process.pid}__.ts`;
    const seed = join(repoRoot, "bricks", "subscription-plans", "src", seedName);
    writeFileSync(
      seed,
      [
        'import { grantPlanCredits } from "./credits.ts";',
        "",
        "export function grantWithoutAwait(...args: Parameters<typeof grantPlanCredits>): void {",
        "  grantPlanCredits(...args);",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      const { status, output } = runOxlint(lintTypesArgs());
      expect(status, output).not.toBe(0);
      expect(output).toContain("no-floating-promises");
      expect(output).toContain(seedName);
    } finally {
      rmSync(seed, { force: true });
    }
  }, 60_000);

  it("passes on the money, auth and deploy paths, run exactly as `pnpm lint:types` runs it, and lints files", () => {
    const { status, output } = runOxlint([...lintTypesArgs(), "-f", "json"]);
    expect(status, output).toBe(0);
    const report = JSON.parse(output.slice(output.indexOf("{"))) as { diagnostics: unknown[]; number_of_files: number };
    expect(report.diagnostics).toEqual([]);
    expect(report.number_of_files).toBeGreaterThan(0);
  }, 60_000);
});
