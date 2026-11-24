import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FINALIZE_STEPS, finishRefresh } from "../lib/refresh-evidence-core.ts";

// UC0.7 rework round 2 (review findings 1 and 2): behaviour of the refresh pass and of verify.ts, not just their helpers.

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const made: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "uc07-run-"));
  made.push(d);
  return d;
}
function put(root: string, rel: string, body: unknown): string {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(body, null, 2) + "\n");
  return p;
}
afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

const baseProv = {
  generatedAt: "2031-01-02T03:04:05.000Z",
  gitSha: "a".repeat(40),
  gitDirty: false,
  generator: "scripts/refresh-evidence.ts",
  inputKind: "measured" as const,
};
const measured = (x: number) => ({ x, provenance: { inputKind: "measured", generator: "g" } });

describe("finishRefresh: a tracked file nobody regenerated stops the pass before anything is written", () => {
  it("returns EVIDENCE_NOT_REGENERATED naming the file, writes nothing, runs no finalize step", () => {
    const root = tmp();
    const a = put(root, "evidence/a.json", measured(0));
    put(root, "evidence/b.json", measured(0));
    put(root, "stage/a.json", measured(1));
    const before = readFileSync(a, "utf8");
    const ran: string[] = [];

    const res = finishRefresh({
      stagingDir: join(root, "stage"),
      evidenceDir: join(root, "evidence"),
      baseProv,
      runStep: (s) => (ran.push(s), 0),
    });

    expect(res.ok).toBe(false);
    expect(res.code).toBe(1);
    expect(res.error).toMatch(/EVIDENCE_NOT_REGENERATED/);
    expect(res.error).toContain("evidence/b.json");
    expect(res.written).toEqual([]);
    expect(readFileSync(a, "utf8")).toBe(before);
    expect(ran).toEqual([]);
  });
});

describe("finishRefresh: PROOF.md is regenerated and proof:check ends the pass", () => {
  const setup = () => {
    const root = tmp();
    put(root, "evidence/a.json", measured(0));
    put(root, "stage/a.json", measured(1));
    return { stagingDir: join(root, "stage"), evidenceDir: join(root, "evidence"), root };
  };

  it("runs generate-proof, proof-check and check-evidence AFTER the evidence files were stamped", () => {
    const { stagingDir, evidenceDir, root } = setup();
    const seenAtStep: Array<{ step: string; gitSha: string }> = [];
    const res = finishRefresh({
      stagingDir,
      evidenceDir,
      baseProv,
      runStep: (step) => {
        seenAtStep.push({ step, gitSha: JSON.parse(readFileSync(join(root, "evidence/a.json"), "utf8")).provenance.gitSha });
        return 0;
      },
    });
    expect(res.ok).toBe(true);
    expect(res.stepsRun).toEqual([...FINALIZE_STEPS]);
    expect(seenAtStep.map((s) => s.step.replace(/^.*[\\/]/, ""))).toEqual(["generate-proof.ts", "generate-readme.ts", "proof-check.ts", "check-evidence.ts"]);
    // each step ran only once the new evidence was already in place
    expect(seenAtStep.every((s) => s.gitSha === baseProv.gitSha)).toBe(true);
  });

  it("a failing proof-check fails the refresh with its exit code and skips check-evidence", () => {
    const { stagingDir, evidenceDir } = setup();
    const res = finishRefresh({
      stagingDir,
      evidenceDir,
      baseProv,
      runStep: (step) => (step.endsWith("proof-check.ts") ? 3 : 0),
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(3);
    expect(res.error).toContain("proof-check.ts");
    expect(res.stepsRun.map((s) => s.replace(/^.*[\\/]/, ""))).toEqual(["generate-proof.ts", "generate-readme.ts", "proof-check.ts"]);
  });

  it("a failing generate-proof stops before proof-check", () => {
    const { stagingDir, evidenceDir } = setup();
    const res = finishRefresh({ stagingDir, evidenceDir, baseProv, runStep: (step) => (step.endsWith("generate-proof.ts") ? 1 : 0) });
    expect(res.ok).toBe(false);
    expect(res.stepsRun).toHaveLength(1);
  });
});

describe("verify.ts: an empty run directory is an error, tracked evidence is never read instead", () => {
  it("exits non-zero with NO_RUN_RESULTS when the test run left no raw-results.json in the run directory", () => {
    // The child test run writes its results to POC_EVIDENCE_DIR (a temp folder), so verify.ts finds its own
    // run directory (.evidence-run, ignored by git) without results. It must fail instead of falling back to evidence/.
    const elsewhere = tmp();
    const res = spawnSync(process.execPath, [join(repoRoot, "scripts", "verify.ts"), "H1"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, POC_EVIDENCE_DIR: elsewhere },
      timeout: 240_000,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("NO_RUN_RESULTS");
    expect(res.stdout).not.toMatch(/\bH1\b.*\b(pass|fail)\b/);
  }, 250_000);
});
