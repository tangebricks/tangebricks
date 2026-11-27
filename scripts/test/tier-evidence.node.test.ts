import { afterEach, describe, expect, it } from "vitest";
import { startVitest } from "vitest/node";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getGitSha } from "../lib/evidence-stamp.ts";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixturesDir = join(repoRoot, "scripts", "test", "fixtures", "tier-evidence");
const passingTest = join(fixturesDir, "passing", "test", "passing.node.test.ts");
const skippedTest = join(fixturesDir, "skipped", "test", "skipped.node.test.ts");
const zeroExpectsTest = join(fixturesDir, "zero-expects", "test", "zero-expects.node.test.ts");

describe("UC5.2 tier evidence recording and assertion counting", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    delete process.env.POC_EVIDENCE_DIR;
    delete process.env.POC_MANIFEST_DIR;
    for (const dir of tempDirs) {
      if (existsSync(dir)) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
    tempDirs.length = 0;
  });

  it("records executed, passed, and assertionCount for fixture behaviour tests (AC1 / AC2)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tier-evidence-fixtures-"));
    tempDirs.push(tempDir);

    process.env.POC_EVIDENCE_DIR = tempDir;
    process.env.POC_MANIFEST_DIR = fixturesDir;

    const savedExitCode = process.exitCode;
    const vitest = await startVitest("test", [passingTest, skippedTest, zeroExpectsTest], {
      watch: false,
      run: true,
    });
    await vitest?.close();
    process.exitCode = savedExitCode;

    const tierEvidencePath = join(tempDir, "tier-evidence.json");
    expect(existsSync(tierEvidencePath), "tier-evidence.json must be written to POC_EVIDENCE_DIR").toBe(true);

    const raw = JSON.parse(readFileSync(tierEvidencePath, "utf8"));
    const rows = Array.isArray(raw) ? raw : (raw.data ?? raw.items ?? []);
    expect(rows.length).toBe(3);

    // AC1: provenance.gitSha equals HEAD
    const expectedSha = getGitSha(repoRoot);
    expect(raw.provenance).toBeDefined();
    expect(raw.provenance.gitSha).toBe(expectedSha);
    expect(raw.provenance.generator).toBe("reporters/evidence-reporter.ts");

    // Fixture with 3 passing expects: executed: true, passed: true, assertionCount: 3
    const passingRow = rows.find((r: any) => r.id === "fixture-passing");
    expect(passingRow).toBeDefined();
    expect(passingRow).toMatchObject({
      id: "fixture-passing",
      kind: "brick",
      executed: true,
      passed: true,
      assertionCount: 3,
    });
    expect(passingRow.testsRun).toBe(1);
    expect(passingRow.testsSkipped).toBe(0);

    // AC2: Fixture fully it.skip: executed: false, assertionCount: 0
    const skippedRow = rows.find((r: any) => r.id === "fixture-skipped");
    expect(skippedRow).toBeDefined();
    expect(skippedRow).toMatchObject({
      id: "fixture-skipped",
      kind: "brick",
      executed: false,
      assertionCount: 0,
    });
    expect(skippedRow.testsSkipped).toBeGreaterThanOrEqual(1);

    // AC2: Fixture with zero expects: executed: true, passed: true, assertionCount: 0
    const zeroRow = rows.find((r: any) => r.id === "fixture-zero-expects");
    expect(zeroRow).toBeDefined();
    expect(zeroRow).toMatchObject({
      id: "fixture-zero-expects",
      kind: "brick",
      executed: true,
      passed: true,
      assertionCount: 0,
    });
    expect(zeroRow.testsRun).toBe(1);
  });

  it("running a filtered subset marks un-run bricks as executed: false rather than leaving stale values (AC3)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tier-evidence-subset-"));
    tempDirs.push(tempDir);

    process.env.POC_EVIDENCE_DIR = tempDir;
    process.env.POC_MANIFEST_DIR = fixturesDir;

    // Run ONLY passingTest; skipped and zeroExpects tests are filtered out
    const savedExitCode = process.exitCode;
    const vitest = await startVitest("test", [passingTest], {
      watch: false,
      run: true,
    });
    await vitest?.close();
    process.exitCode = savedExitCode;

    const tierEvidencePath = join(tempDir, "tier-evidence.json");
    expect(existsSync(tierEvidencePath)).toBe(true);

    const raw = JSON.parse(readFileSync(tierEvidencePath, "utf8"));
    const rows = Array.isArray(raw) ? raw : (raw.data ?? raw.items ?? []);

    const passingRow = rows.find((r: any) => r.id === "fixture-passing");
    const skippedRow = rows.find((r: any) => r.id === "fixture-skipped");
    const zeroRow = rows.find((r: any) => r.id === "fixture-zero-expects");

    expect(passingRow).toMatchObject({
      id: "fixture-passing",
      executed: true,
      passed: true,
      assertionCount: 3,
    });
    // Un-run items must be marked executed: false
    expect(skippedRow).toMatchObject({
      id: "fixture-skipped",
      executed: false,
      assertionCount: 0,
    });
    expect(zeroRow).toMatchObject({
      id: "fixture-zero-expects",
      executed: false,
      assertionCount: 0,
    });
  });

  it("maps all 43 bricks and 5 integrations from repository manifests (AC1)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tier-evidence-repo-"));
    tempDirs.push(tempDir);

    process.env.POC_EVIDENCE_DIR = tempDir;
    // Do not set POC_MANIFEST_DIR -> loads repo manifests

    // Run on a fast single test file
    const fastTest = join(repoRoot, "scripts", "test", "fixtures", "clean-tree-attach.node.test.ts");
    const savedExitCode = process.exitCode;
    const vitest = await startVitest("test", [fastTest], {
      watch: false,
      run: true,
    });
    await vitest?.close();
    process.exitCode = savedExitCode;

    const tierEvidencePath = join(tempDir, "tier-evidence.json");
    expect(existsSync(tierEvidencePath)).toBe(true);

    const raw = JSON.parse(readFileSync(tierEvidencePath, "utf8"));
    const rows = Array.isArray(raw) ? raw : (raw.data ?? raw.items ?? []);

    // 43 bricks + 5 integrations = 48 rows
    expect(rows.length).toBe(48);

    const brickRows = rows.filter((r: any) => r.kind === "brick");
    const integrationRows = rows.filter((r: any) => r.kind === "integration");
    expect(brickRows.length).toBe(43);
    expect(integrationRows.length).toBe(5);

    // Each row has behaviourTest populated
    for (const row of rows) {
      expect(typeof row.id).toBe("string");
      expect(typeof row.behaviourTest).toBe("string");
      expect(row.behaviourTest.length).toBeGreaterThan(0);
      expect(typeof row.executed).toBe("boolean");
      expect(typeof row.passed).toBe("boolean");
      expect(typeof row.testsRun).toBe("number");
      expect(typeof row.testsSkipped).toBe("number");
      expect(typeof row.assertionCount).toBe("number");
    }

    expect(raw.provenance?.gitSha).toBe(getGitSha(repoRoot));
  });
});
