import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeEvidence } from "./evidence-stamp.ts";
import type { EvidenceProvenance } from "./evidence-stamp.ts";

/**
 * Pure helpers behind `pnpm evidence:refresh` (story UC0.7), kept apart from the script so they can be tested.
 *
 * Rules they enforce:
 *  - Only evidence a generator produced in THIS run is re-stamped. Quarantined (simulated) files, deployed/** files,
 *    raw results, committed baselines and internal verification records are never touched.
 *  - A tracked evidence file that no generator regenerated is an error, never a fresh stamp.
 */

/**
 * Steps run after the generators, in this order: PROOF.md and the README's generated section must follow the new
 * evidence, and the pass ends with the checks.
 */
export const FINALIZE_STEPS: readonly string[] = [
  "scripts/generate-proof.ts",
  "scripts/generate-readme.ts",
  "scripts/proof-check.ts",
  "scripts/check-evidence.ts",
];

/** Is this path (relative to the evidence directory) a file the refresh may write? */
export function isRefreshable(relPath: string): boolean {
  const rel = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!rel.endsWith(".json")) return false;
  if (rel.startsWith("deployed/") || rel.startsWith("quarantine/")) return false;
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (base === "raw-results.json") return false;
  if (base.endsWith(".hashes.json") || base.endsWith(".verified.json")) return false;
  // Committed baselines are changed only on purpose (e.g. `measure-importer-fidelity.ts --baseline`) and reviewed as a diff.
  if (base.endsWith(".baseline.json")) return false;
  return true;
}

function walk(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else if (entry.isFile() && isRefreshable(rel)) out.push(rel);
  }
  return out.sort();
}

export interface RefreshPlan {
  /** relative paths produced in this run (will be copied and stamped) */
  toCopy: string[];
  /** relative paths of tracked evidence that no generator regenerated */
  missing: string[];
}

export function planRefresh(opts: { stagingDir: string; evidenceDir: string }): RefreshPlan {
  const toCopy = walk(opts.stagingDir);
  const staged = new Set(toCopy);
  const missing = walk(opts.evidenceDir).filter((rel) => !staged.has(rel));
  return { toCopy, missing };
}

export interface FinishRefreshResult {
  ok: boolean;
  /** exit code the CLI should use */
  code: number;
  error?: string;
  /** files written into the evidence directory */
  written: string[];
  /** finalize steps that were started, in order */
  stepsRun: string[];
}

/**
 * Everything `evidence:refresh` does after the generators have run (story UC0.7): refuse when a tracked file was not
 * regenerated (nothing is written), copy and stamp the regenerated files, then run the finalize steps in order and stop
 * at the first one that fails. `runStep` returns the step's exit code.
 */
export function finishRefresh(opts: {
  stagingDir: string;
  evidenceDir: string;
  baseProv: EvidenceProvenance;
  runStep: (script: string) => number;
  steps?: readonly string[];
}): FinishRefreshResult {
  const plan = planRefresh(opts);
  if (plan.missing.length > 0) {
    return {
      ok: false,
      code: 1,
      error:
        `EVIDENCE_NOT_REGENERATED: ${plan.missing.length} tracked evidence file(s) were not produced by any generator in this run:\n` +
        plan.missing.map((m) => `  - evidence/${m}`).join("\n") +
        "\nFix the generator (or remove the stale file); the refresh will not re-stamp it as measured. Nothing was written to evidence/.",
      written: [],
      stepsRun: [],
    };
  }
  const written = stampStaged(opts);
  const stepsRun: string[] = [];
  for (const step of opts.steps ?? FINALIZE_STEPS) {
    stepsRun.push(step);
    const code = opts.runStep(step);
    if (code !== 0) {
      return { ok: false, code, error: `Finalize step failed with status ${code}: ${step}`, written, stepsRun };
    }
  }
  return { ok: true, code: 0, written, stepsRun };
}

/** Copy every regenerated file into the evidence directory, stamped with one shared provenance. Returns the files written. */
export function stampStaged(opts: { stagingDir: string; evidenceDir: string; baseProv: EvidenceProvenance }): string[] {
  const written: string[] = [];
  for (const rel of planRefresh(opts).toCopy) {
    const data = JSON.parse(readFileSync(join(opts.stagingDir, rel), "utf8")) as Record<string, unknown> & { provenance?: Record<string, unknown> };
    const prov = {
      ...data.provenance,
      generatedAt: opts.baseProv.generatedAt,
      gitSha: opts.baseProv.gitSha,
      gitDirty: false,
    } as unknown as EvidenceProvenance;
    if (typeof data.generatedAt === "string") data.generatedAt = opts.baseProv.generatedAt;
    const dest = join(opts.evidenceDir, rel);
    writeEvidence(dest, data, prov);
    written.push(dest.replace(/\\/g, "/"));
  }
  return written;
}
