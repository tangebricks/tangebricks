// release:check (story 0.12, R54): fails when any live evidence predates the release commit unless the README's
// generated "What works today" section labels it stale. Story 0.13 runs it when tagging a release.
//
// Usage: node scripts/release-check.ts [--root <dir>] [--ref <revision>]
//   --ref  the commit being released (default HEAD); its commit date is the cut-off
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractWhatWorks } from "./generate-readme.ts";
import { commitDateOf, loadLiveRuns, staleLabel } from "./lib/live-evidence.ts";
import type { LiveRunInfo } from "./lib/live-evidence.ts";

const repoRoot = resolve(import.meta.dirname, "..");

export const LIVE_EVIDENCE_HEADING = "### Live evidence";

/** Lines of the generated section's "Live evidence" subsection only (up to the next heading), never the hypotheses table. */
export function liveEvidenceLines(readme: string): string[] {
  const section = extractWhatWorks(readme.replace(/\r\n/g, "\n"));
  if (!section) return [];
  const lines = section.split("\n");
  const start = lines.findIndex((l) => l.trim() === LIVE_EVIDENCE_HEADING);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,6}\s/.test(l) || l.startsWith("<!--"));
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * Live runs that predate `releaseDate` and are not labelled "stale (run YYYY-MM-DD)" on their row of the README's
 * generated section. A missing row or section counts as unlabelled.
 */
export function findUnlabelledLiveEvidence(readme: string, runs: readonly LiveRunInfo[], releaseDate: string): string[] {
  const liveTable = liveEvidenceLines(readme);
  const cutoff = Date.parse(releaseDate);
  const problems: string[] = [];
  for (const run of runs) {
    const run_ms = run.runTimestamp ? Date.parse(run.runTimestamp) : Number.NaN;
    if (Number.isFinite(run_ms) && run_ms >= cutoff) continue;
    const row = liveTable.find((line) => line.startsWith(`| ${run.key} |`));
    if (!row || !row.includes(staleLabel(run.runDate))) {
      problems.push(
        `${run.key} (${run.file}) ran ${run.runTimestamp ?? "at an unknown time"}, before the release commit (${releaseDate}), and the README does not label it "${staleLabel(run.runDate)}"`,
      );
    }
  }
  return problems;
}

export function runReleaseCheckCli(argv: string[] = process.argv.slice(2)): number {
  let targetRoot = repoRoot;
  let ref = "HEAD";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root" && argv[i + 1]) {
      targetRoot = resolve(argv[i + 1]!);
      i += 1;
    } else if (argv[i] === "--ref" && argv[i + 1]) {
      ref = argv[i + 1]!;
      i += 1;
    }
  }
  const releaseDate = commitDateOf(targetRoot, ref) ?? commitDateOf(repoRoot, ref);
  if (!releaseDate) {
    console.error(`release:check FAILED: cannot read the commit date of ${ref}`);
    return 2;
  }
  const readmePath = join(targetRoot, "README.md");
  if (!existsSync(readmePath)) {
    console.error(`release:check FAILED: README.md does not exist at ${readmePath}`);
    return 2;
  }
  const problems = findUnlabelledLiveEvidence(readFileSync(readmePath, "utf8"), loadLiveRuns(targetRoot), releaseDate);
  if (problems.length > 0) {
    console.error("release:check FAILED: live evidence predates the release commit and is not labelled stale:");
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log(`release:check passed: every live run older than ${ref} (${releaseDate}) is labelled stale in README.md.`);
  return 0;
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  process.exit(runReleaseCheckCli());
}
