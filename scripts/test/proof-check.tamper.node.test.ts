import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { VerdictsFile } from "../poc-verdict.ts";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const proofCheckScript = resolve(repoRoot, "scripts/proof-check.ts");
const pocVerdictScript = resolve(repoRoot, "scripts/poc-verdict.ts");

function createTempProofRoot(): string {
  const tempRoot = mkdtempSync(join(tmpdir(), "proof-check-tamper-"));
  cpSync(join(repoRoot, "evidence"), join(tempRoot, "evidence"), { recursive: true });
  cpSync(join(repoRoot, "PROOF.md"), join(tempRoot, "PROOF.md"));
  cpSync(join(repoRoot, "hypotheses.json"), join(tempRoot, "hypotheses.json"));
  cpSync(join(repoRoot, "README.md"), join(tempRoot, "README.md"));
  return tempRoot;
}

describe("proof-check tamper and staleness detection", () => {
  it("fails and names H9 when H9 in verdicts.json is tampered to pass / 14.1%", { timeout: 360_000 }, () => {
    const tempRoot = createTempProofRoot();
    try {
      const verdictsPath = join(tempRoot, "evidence", "verdicts.json");
      const data = JSON.parse(readFileSync(verdictsPath, "utf8")) as VerdictsFile;
      data.verdicts.H9 = {
        ...(data.verdicts.H9 ?? { reasons: [], recordedAt: new Date().toISOString() }),
        verdict: "pass",
        measured: "14.1%",
      };
      writeFileSync(verdictsPath, JSON.stringify(data, null, 2) + "\n", "utf8");

      const res = spawnSync(process.execPath, [proofCheckScript, "--root", tempRoot], {
        cwd: repoRoot,
        encoding: "utf8",
      });

      expect(res.status).not.toBe(0);
      const combined = `${res.stdout}\n${res.stderr}`;
      expect(combined).toContain("H9");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails with a staleness error when a tested source file is edited without re-verifying", { timeout: 360_000 }, () => {
    const tempRoot = createTempProofRoot();
    try {
      const relSource = "packages/sdk/src/validate.ts";
      const srcOrig = readFileSync(join(repoRoot, relSource), "utf8");
      const destPath = join(tempRoot, relSource);
      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, `${srcOrig}\nexport const TAMPER_PROBE = true;\n`, "utf8");

      const res = spawnSync(process.execPath, [proofCheckScript, "--root", tempRoot], {
        cwd: repoRoot,
        encoding: "utf8",
      });

      expect(res.status).not.toBe(0);
      const combined = `${res.stdout}\n${res.stderr}`;
      expect(combined).toMatch(/inputsHash/i);
      expect(combined).toContain("packages/sdk/src/validate.ts");

      const verdictRes = spawnSync(process.execPath, [pocVerdictScript, "--root", tempRoot], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(verdictRes.status).toBe(2);
      expect(`${verdictRes.stdout}\n${verdictRes.stderr}`).toMatch(/stale inputsHash/i);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails and names the file when a stored live result is edited without a re-run (story 0.12, LIVE_TAMPER)", { timeout: 360_000 }, () => {
    const tempRoot = createTempProofRoot();
    try {
      // One byte in a scanned-file hash; commandStartedAt (the run timestamp) stays the same.
      const rel = "evidence/deployed/h12-result.json";
      const p = join(tempRoot, rel);
      const text = readFileSync(p, "utf8");
      const tampered = text.replace(
        /("bricks\/credit-wallet\/client\/CreditWidget\.tsx": ")([0-9a-f])/,
        (_m, pre: string, c: string) => `${pre}${c === "0" ? "1" : "0"}`,
      );
      expect(tampered).not.toBe(text);
      writeFileSync(p, tampered, "utf8");

      const res = spawnSync(process.execPath, [proofCheckScript, "--root", tempRoot], {
        cwd: repoRoot,
        encoding: "utf8",
      });

      expect(res.status).not.toBe(0);
      const combined = `${res.stdout}\n${res.stderr}`;
      expect(combined).toContain("LIVE_TAMPER");
      expect(combined).toContain(rel);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("exits 0 when evidence/ and PROOF.md are untouched and match current inputs", { timeout: 360_000 }, () => {
    const tempRoot = createTempProofRoot();
    try {
      const res = spawnSync(process.execPath, [proofCheckScript, "--root", tempRoot], {
        cwd: repoRoot,
        encoding: "utf8",
      });

      expect(res.status, `stderr: ${res.stderr}\nstdout: ${res.stdout}`).toBe(0);
      expect(res.stdout).toContain("proof:check passed");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
