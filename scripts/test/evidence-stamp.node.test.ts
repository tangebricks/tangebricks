import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isPrePublicCommit } from "../check-evidence.ts";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const evidenceDir = resolve(repoRoot, "evidence");
const checkEvidenceScript = resolve(repoRoot, "scripts/check-evidence.ts");

/** Run the checker on a temporary COPY of evidence/ plus one extra file, so tests never write into the tracked folder (UC0.7 rework). */
function checkWithExtraFile(name: string, body: unknown) {
  const copy = mkdtempSync(join(tmpdir(), "check-evidence-copy-"));
  try {
    cpSync(evidenceDir, copy, { recursive: true });
    writeFileSync(join(copy, name), JSON.stringify(body));
    return spawnSync(process.execPath, [checkEvidenceScript], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, EVIDENCE_CHECK_DIR: copy } });
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

function getAllEvidenceJsonFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const rel = relative(evidenceDir, fullPath).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (rel === "deployed" || rel.startsWith("deployed/")) {
        continue;
      }
      results.push(...getAllEvidenceJsonFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      results.push(fullPath);
    }
  }
  return results;
}

describe("UC0.1 evidence provenance and stamp helper", () => {
  it("every evidence/*.json (recursive, excluding deployed) has valid provenance", () => {
    const files = getAllEvidenceJsonFiles(evidenceDir);
    expect(files.length).toBeGreaterThan(0);

    const failures: { file: string; reason: string }[] = [];

    for (const file of files) {
      const rel = relative(repoRoot, file).replace(/\\/g, "/");
      let content: any;
      try {
        content = JSON.parse(readFileSync(file, "utf8"));
      } catch (err: any) {
        failures.push({ file: rel, reason: `Failed to parse JSON: ${err.message}` });
        continue;
      }

      if (!content || typeof content !== "object") {
        failures.push({ file: rel, reason: "Content is not an object" });
        continue;
      }

      const prov = content.provenance;
      if (!prov || typeof prov !== "object") {
        failures.push({ file: rel, reason: "Missing provenance object" });
        continue;
      }

      if (typeof prov.generatedAt !== "string" || !prov.generatedAt) {
        failures.push({ file: rel, reason: "Missing or invalid provenance.generatedAt" });
      } else if (prov.generatedAt === "2026-11-01T00:00:00.000Z") {
        failures.push({ file: rel, reason: "provenance.generatedAt equals hardcoded 2026-11-01T00:00:00.000Z" });
      } else if (isNaN(Date.parse(prov.generatedAt))) {
        failures.push({ file: rel, reason: `provenance.generatedAt is not a valid ISO date: ${prov.generatedAt}` });
      }

      if (typeof prov.gitSha !== "string" || !/^[0-9a-f]{40}$/i.test(prov.gitSha)) {
        failures.push({ file: rel, reason: `provenance.gitSha is not 40 hex chars: ${prov.gitSha}` });
      } else if (/^0{40}$/.test(prov.gitSha)) {
        failures.push({ file: rel, reason: `provenance.gitSha must not be all-zero: ${prov.gitSha}` });
      } else {
        const catRes = spawnSync("git", ["cat-file", "-e", `${prov.gitSha}^{commit}`], { cwd: repoRoot });
        if (catRes.status !== 0 && !isPrePublicCommit(prov.gitSha, rel)) {
          failures.push({ file: rel, reason: `provenance.gitSha is not an existing commit in repository: ${prov.gitSha}` });
        }
      }

      if (typeof prov.gitDirty !== "boolean") {
        failures.push({ file: rel, reason: `provenance.gitDirty is not boolean: ${prov.gitDirty}` });
      }

      if (typeof prov.generator !== "string" || !prov.generator) {
        failures.push({ file: rel, reason: "Missing or empty provenance.generator" });
      }

      if (prov.inputKind !== "measured" && prov.inputKind !== "simulated") {
        failures.push({ file: rel, reason: `Invalid provenance.inputKind: ${prov.inputKind}` });
      }
    }

    if (failures.length > 0) {
      const msg = failures.map((f) => `  - ${f.file}: ${f.reason}`).join("\n");
      expect.fail(`Evidence files failed provenance validation:\n${msg}`);
    }
  });

  it("quarantines cp8 and cp9 evidence from top level into evidence/quarantine", () => {
    const cp8Top = join(evidenceDir, "cp8-beta-readiness.json");
    const cp9Top = join(evidenceDir, "cp9-sandbox-verification.json");
    expect(existsSync(cp8Top), "evidence/cp8-beta-readiness.json must not exist at top level").toBe(false);
    expect(existsSync(cp9Top), "evidence/cp9-sandbox-verification.json must not exist at top level").toBe(false);

    const cp8Quarantine = join(evidenceDir, "quarantine", "cp8-beta-readiness.json");
    const cp9Quarantine = join(evidenceDir, "quarantine", "cp9-sandbox-verification.json");
    expect(existsSync(cp8Quarantine), "evidence/quarantine/cp8-beta-readiness.json must exist").toBe(true);
    expect(existsSync(cp9Quarantine), "evidence/quarantine/cp9-sandbox-verification.json must exist").toBe(true);

    const readmeQuarantine = join(evidenceDir, "quarantine", "README.md");
    expect(existsSync(readmeQuarantine), "evidence/quarantine/README.md must exist").toBe(true);

    const cp8Data = JSON.parse(readFileSync(cp8Quarantine, "utf8"));
    const cp9Data = JSON.parse(readFileSync(cp9Quarantine, "utf8"));
    expect(cp8Data.provenance?.quarantined).toBe(true);
    expect(cp9Data.provenance?.quarantined).toBe(true);
    expect(cp8Data.provenance?.inputKind).toBe("simulated");
    expect(cp9Data.provenance?.inputKind).toBe("simulated");
  });

  it("stampEvidence generates real provenance from git and environment", async () => {
    const { stampEvidence } = await import("../lib/evidence-stamp.ts");
    const prov = stampEvidence("scripts/test-generator.ts", "measured");

    expect(prov.generator).toBe("scripts/test-generator.ts");
    expect(prov.inputKind).toBe("measured");
    expect(typeof prov.generatedAt).toBe("string");
    expect(prov.generatedAt).not.toBe("2026-11-01T00:00:00.000Z");
    expect(isNaN(Date.parse(prov.generatedAt))).toBe(false);
    expect(typeof prov.gitDirty).toBe("boolean");
    expect(prov.gitSha).toMatch(/^[0-9a-f]{40}$/i);
  });

  it("writeEvidence refuses simulated input outside evidence/simulated/", async () => {
    const { stampEvidence, writeEvidence } = await import("../lib/evidence-stamp.ts");
    const prov = stampEvidence("scripts/test-generator.ts", "simulated");

    const tempRoot = mkdtempSync(join(tmpdir(), "evidence-write-test-"));
    try {
      const outsidePath = join(tempRoot, "evidence", "foo.json");
      expect(() => {
        writeEvidence(outsidePath, { test: 1 }, prov);
      }).toThrow(/EVIDENCE_SIMULATED_OUTSIDE_QUARANTINE/);

      const insideSimulated = join(tempRoot, "evidence", "simulated", "foo.json");
      writeEvidence(insideSimulated, { test: 2 }, prov);
      expect(existsSync(insideSimulated)).toBe(true);
      const parsed = JSON.parse(readFileSync(insideSimulated, "utf8"));
      expect(parsed.test).toBe(2);
      expect(parsed.provenance).toBeDefined();
      expect(parsed.provenance.inputKind).toBe("simulated");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("check-evidence CLI exits 0 on clean valid evidence and exits 1 on invalid evidence", () => {
    expect(existsSync(checkEvidenceScript), "scripts/check-evidence.ts must exist").toBe(true);
    const cleanRes = spawnSync(process.execPath, [checkEvidenceScript], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(cleanRes.status).toBe(0);
    expect(cleanRes.stdout).toContain("PASS");

    const badRes = checkWithExtraFile("bad-evidence-fixture.json", { generatedAt: "2026-11-01T00:00:00.000Z", test: true });
    expect(badRes.status).toBe(1);
    expect(badRes.stderr).toContain("FAIL");
  });

  it("getGitSha and isGitDirty throw on failure instead of returning fake values", async () => {
    const { getGitSha, isGitDirty } = await import("../lib/evidence-stamp.ts");
    const emptyTempDir = mkdtempSync(join(tmpdir(), "git-fail-test-"));
    try {
      expect(() => getGitSha(emptyTempDir)).toThrow(/GIT_REV_PARSE_FAILED/);
      expect(() => isGitDirty(emptyTempDir)).toThrow(/GIT_STATUS_FAILED/);
    } finally {
      rmSync(emptyTempDir, { recursive: true, force: true });
    }
  });

  it("check-evidence CLI rejects all-zero gitSha", () => {
    const res = checkWithExtraFile("bad-sha-fixture.json", {
      test: true,
      provenance: { generatedAt: new Date().toISOString(), gitSha: "0000000000000000000000000000000000000000", gitDirty: false, generator: "scripts/test.ts", inputKind: "measured" },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("all-zero");
  });

  it("check-evidence CLI rejects well-formed 40-hex gitSha that does not exist in repository", () => {
    const nonExistentSha = "1111111111111111111111111111111111111111";
    const res = checkWithExtraFile("nonexistent-sha-fixture.json", {
      test: true,
      provenance: { generatedAt: new Date().toISOString(), gitSha: nonExistentSha, gitDirty: false, generator: "scripts/test.ts", inputKind: "measured" },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/gitSha is not an existing commit in repository/i);
  });

  it("writeEvidence throws EVIDENCE_HARDCODED_TIMESTAMP on old constant generatedAt", async () => {
    const { stampEvidence, writeEvidence } = await import("../lib/evidence-stamp.ts");
    const prov = stampEvidence("scripts/test-generator.ts", "measured");

    const tempRoot = mkdtempSync(join(tmpdir(), "evidence-write-ts-test-"));
    try {
      const targetPath = join(tempRoot, "evidence", "test-ts.json");
      expect(() => {
        writeEvidence(
          targetPath,
          { generatedAt: "2026-11-01T00:00:00.000Z", test: 1 },
          prov,
        );
      }).toThrow(/EVIDENCE_HARDCODED_TIMESTAMP/);

      expect(() => {
        writeEvidence(
          targetPath,
          { test: 2 },
          { ...prov, generatedAt: "2026-11-01T00:00:00.000Z" },
        );
      }).toThrow(/EVIDENCE_HARDCODED_TIMESTAMP/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
