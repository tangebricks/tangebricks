import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeEvidence } from "../lib/evidence-stamp.ts";

// UC0.7 rework (review round 1, finding 5): simulated evidence may only be written under evidence/simulated,
// evidence/quarantine or the .evidence-run directory, not under any folder that happens to be named that.

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const checkEvidenceScript = join(repoRoot, "scripts", "check-evidence.ts");

const made: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "uc07-guard-"));
  made.push(d);
  return d;
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

describe("simulated evidence stays inside evidence/simulated, evidence/quarantine or the run dir (finding 5)", () => {
  const sim = { ...baseProv, inputKind: "simulated" as const };
  it("rejects a folder merely named simulated or quarantine elsewhere", () => {
    const root = tmp();
    expect(() => writeEvidence(join(root, "anywhere", "simulated", "a.json"), {}, sim)).toThrow(/EVIDENCE_SIMULATED_OUTSIDE_QUARANTINE/);
    expect(() => writeEvidence(join(root, "anywhere", "quarantine", "a.json"), {}, sim)).toThrow(/EVIDENCE_SIMULATED_OUTSIDE_QUARANTINE/);
  });
  it("accepts evidence/simulated, evidence/quarantine and .evidence-run subfolders", () => {
    const root = tmp();
    expect(() => writeEvidence(join(root, "evidence", "simulated", "a.json"), {}, sim)).not.toThrow();
    expect(() => writeEvidence(join(root, "evidence", "quarantine", "a.json"), {}, sim)).not.toThrow();
    expect(() => writeEvidence(join(root, ".evidence-run", "simulated", "a.json"), {}, sim)).not.toThrow();
    expect(() => writeEvidence(join(root, ".evidence-run", "quarantine", "a.json"), {}, sim)).not.toThrow();
  });
});

// UC0.7 rework: tests of the evidence checker used to drop bad fixture files into the tracked evidence/ folder, which made
// the clean-tree test (a test run leaves tracked evidence untouched) fail whenever both ran at once. The CLI must be able to
// check another folder so such tests never write into the real one.
describe("check-evidence CLI can check another folder (EVIDENCE_CHECK_DIR)", () => {
  const run = (dir: string) =>
    spawnSync(process.execPath, [checkEvidenceScript], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, EVIDENCE_CHECK_DIR: dir } });

  it("fails on a bad file in that folder, naming it", () => {
    const dir = join(tmp(), "ev");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ generatedAt: "2026-11-01T00:00:00.000Z" }));
    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("bad.json");
  });

  it("passes on a folder whose files all have valid provenance and counts only that folder", () => {
    const dir = join(tmp(), "ev");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ok.json"),
      JSON.stringify({
        provenance: {
          generatedAt: new Date().toISOString(),
          gitSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
          gitDirty: false,
          generator: "scripts/test.ts",
          inputKind: "measured",
        },
      }),
    );
    const res = run(dir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("All 1 evidence files");
  });
});
