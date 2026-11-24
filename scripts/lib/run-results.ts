import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where `scripts/verify.ts` reads the results of the test run it just made (story UC0.7, review round 1).
 *
 * They must come from the run directory of THIS run. Falling back to tracked files under evidence/ would let verdicts be
 * computed from stale results, so there is no fallback: an empty run directory is an error.
 */

export function readRawResults(runDir: string): unknown {
  const path = join(runDir, "raw-results.json");
  if (!existsSync(path)) {
    throw new Error(`NO_RUN_RESULTS: ${path} does not exist. The test run produced no results; run the tests first. Tracked evidence is never used instead.`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The H9 breakdown the test wrote during this run, or undefined if the run did not write one. */
export function h9BreakdownPath(runDir: string): string | undefined {
  const path = join(runDir, "h9-session.json");
  return existsSync(path) ? path : undefined;
}
