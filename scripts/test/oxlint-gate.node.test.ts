// The oxlint correctness gate. The pinned oxlint binary, run with the repo's .oxlintrc.json, must fail on a seeded
// unused variable and on seeded unsafe optional chaining, naming each rule, and must pass on the repository itself.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const oxlintBin = join(repoRoot, "node_modules", "oxlint", "bin", "oxlint");
const config = join(repoRoot, ".oxlintrc.json");

function runOxlint(args: readonly string[]): { status: number | null; output: string } {
  const run = spawnSync(process.execPath, [oxlintBin, "-c", config, "--deny-warnings", "-f", "unix", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

describe("oxlint correctness gate", () => {
  let dir: string;
  let unusedVar: string;
  let unsafeChain: string;
  let underscored: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "oxlint-gate-"));
    unusedVar = join(dir, "unused-var.ts");
    unsafeChain = join(dir, "unsafe-chain.ts");
    underscored = join(dir, "underscored.ts");
    writeFileSync(unusedVar, "export function f(): number {\n  const unused = 1;\n  return 2;\n}\n", "utf8");
    writeFileSync(unsafeChain, "export function g(a: { b?: () => number } | undefined): number {\n  return (a?.b)();\n}\n", "utf8");
    writeFileSync(
      underscored,
      "export function h(_ignored: number): number {\n  const [_first, second] = [1, 2];\n  try {\n    return second;\n  } catch (_err) {\n    return 0;\n  }\n}\n",
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails on a seeded unused variable and names no-unused-vars", () => {
    const { status, output } = runOxlint([unusedVar]);
    expect(status, output).not.toBe(0);
    expect(output).toContain("no-unused-vars");
    expect(output).toContain("unused-var.ts");
  });

  it("fails on seeded unsafe optional chaining and names no-unsafe-optional-chaining", () => {
    const { status, output } = runOxlint([unsafeChain]);
    expect(status, output).not.toBe(0);
    expect(output).toContain("no-unsafe-optional-chaining");
    expect(output).toContain("unsafe-chain.ts");
  });

  it("allows _-prefixed parameters, variables and caught errors", () => {
    const { status, output } = runOxlint([underscored]);
    expect(status, output).toBe(0);
  });

  it("passes on the repository itself, run exactly as `pnpm lint` runs it (config found by discovery)", () => {
    const run = spawnSync(process.execPath, [oxlintBin, "--deny-warnings"], { cwd: repoRoot, encoding: "utf8" });
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
  }, 60_000);
});
