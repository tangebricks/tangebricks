#!/usr/bin/env node
/**
 * scripts/refresh-evidence.ts
 *
 * Implements `pnpm evidence:refresh` (Story UC0.7).
 *
 * 1. Refuses to run if the working tree has uncommitted changes (exits 1 with EVIDENCE_REFRESH_DIRTY_TREE).
 * 2. Computes a single provenance timestamp & commit SHA once at the start.
 * 3. Runs every evidence generator into an isolated run directory (.evidence-run/).
 * 4. Fails (EVIDENCE_NOT_REGENERATED) if any tracked evidence file was not produced in this run. It never stamps a file
 *    nobody measured. Quarantined (simulated) files and evidence/deployed/** are never touched.
 * 5. Copies the regenerated files into evidence/ in one pass, all stamped with the same gitSha and gitDirty: false.
 * 6. Regenerates PROOF.md from the new verdicts, then runs `proof:check` and `evidence:check`, so the pass only succeeds
 *    when the committed evidence, PROOF.md and the hash of the inputs all agree.
 *
 * The helpers live in scripts/lib/refresh-evidence-core.ts and are unit-tested.
 */
import { execSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stampEvidence } from "./lib/evidence-stamp.ts";
import { finishRefresh } from "./lib/refresh-evidence-core.ts";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const evidenceDir = join(repoRoot, "evidence");
const stagingDir = join(repoRoot, ".evidence-run");

export async function refreshEvidence(): Promise<void> {
  // 1. Refuse to run on a dirty tree
  const status = execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf8" }).trim();
  if (status.length > 0) {
    console.error(`EVIDENCE_REFRESH_DIRTY_TREE: Working tree has uncommitted changes:\n${status}\nStash or commit before running evidence:refresh.`);
    process.exit(1);
  }

  // 2. Compute stampEvidence once before any write
  const baseProv = stampEvidence("scripts/refresh-evidence.ts", "measured");
  console.log(`[evidence:refresh] Stamping evidence at clean commit ${baseProv.gitSha.slice(0, 7)} (${baseProv.generatedAt})...`);

  // 3. Prepare staging directory
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  // Clear offline verify cache so fresh test runs execute
  try {
    const tmpFiles = readdirSync(tmpdir()).filter((f) => f.startsWith("projectx-poc-offline-"));
    for (const f of tmpFiles) {
      rmSync(join(tmpdir(), f), { force: true });
    }
  } catch {}

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    POC_EVIDENCE_DIR: stagingDir,
  };

  const runCmd = (cmd: string, args: string[], runEnv: NodeJS.ProcessEnv = env) => {
    console.log(`[evidence:refresh] Running: ${cmd} ${args.join(" ")}`);
    const res = spawnSync(cmd, args, { cwd: repoRoot, stdio: "inherit", env: runEnv });
    if (res.status !== 0) {
      console.error(`[evidence:refresh] Command failed with status ${res.status}: ${cmd} ${args.join(" ")}`);
      process.exit(res.status ?? 1);
    }
  };

  // 4. Run generators into stagingDir
  runCmd(process.execPath, [join(repoRoot, "scripts", "beta-funnel-report.ts")]);
  runCmd(process.execPath, [join(repoRoot, "scripts", "integrations-live-smoke.ts")]);
  runCmd(process.execPath, [join(repoRoot, "scripts", "mcp-self-correct-eval.ts")]);
  runCmd(process.execPath, [join(repoRoot, "scripts", "benchmark-mcp-scale.ts")]);
  runCmd(process.execPath, [join(repoRoot, "scripts", "mcp-budget.ts")]);
  runCmd(process.execPath, [join(repoRoot, "scripts", "parity-scorecard.ts")]);
  runCmd(process.execPath, [join(repoRoot, "scripts", "measure-importer-fidelity.ts")]); // needs `pnpm fidelity:fetch` once (UC0.5/UC0.6)
  runCmd(process.execPath, [join(repoRoot, "scripts", "verify.ts"), "--out", stagingDir, "--offline"]);
  // UC6.4: evidence/cross-tenant-fuzz.json is attached by its own test. Run only that test into a scratch folder (a vitest run also
  // writes tier-evidence.json and raw-results.json, which verify.ts owns) and keep only its report in the staging folder.
  const fuzzDir = join(tmpdir(), "projectx-poc-fuzz-evidence");
  rmSync(fuzzDir, { recursive: true, force: true });
  mkdirSync(fuzzDir, { recursive: true });
  runCmd(
    process.execPath,
    [
      join(repoRoot, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--reporter=dot",
      "--reporter=./reporters/evidence-reporter.ts",
      "packages/assembler/test/cross-tenant.fuzz.test.ts",
    ],
    { ...process.env, POC_EVIDENCE_DIR: fuzzDir },
  );
  copyFileSync(join(fuzzDir, "cross-tenant-fuzz.json"), join(stagingDir, "cross-tenant-fuzz.json"));
  rmSync(fuzzDir, { recursive: true, force: true });

  // UC5.6: catalog-tiers.ts runs all brick behaviour and conformance tests with evidence-reporter,
  // producing tier-evidence.json with real executed/passed data and brick-tiers.json. It runs last
  // so prior test runs (verify.ts, fuzz) cannot clobber tier-evidence.json.
  runCmd(process.execPath, [join(repoRoot, "scripts", "catalog-tiers.ts")]);

  // 5-7. Refuse if a tracked file was not regenerated; copy with one shared provenance (quarantine/deployed files are never
  // touched); then regenerate PROOF.md and run the checks that tie everything together. Logic and tests: refresh-evidence-core.ts.
  const result = finishRefresh({
    stagingDir,
    evidenceDir,
    baseProv,
    runStep: (step) => {
      console.log(`[evidence:refresh] Running: ${step}`);
      return spawnSync(process.execPath, [join(repoRoot, step)], { cwd: repoRoot, stdio: "inherit", env: process.env }).status ?? 1;
    },
  });
  if (!result.ok) {
    console.error(result.error);
    process.exit(result.code);
  }
  console.log(`[evidence:refresh] Wrote ${result.written.length} evidence file(s) with identical provenance.`);
  console.log(
    "[evidence:refresh] SUCCESS: evidence and PROOF.md refreshed with identical commit SHA and gitDirty: false; proof:check and evidence:check pass.",
  );
}

if (process.argv[1] && (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("refresh-evidence.ts"))) {
  refreshEvidence().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
