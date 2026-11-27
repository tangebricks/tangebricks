/**
 * Live evidence: which recorded live runs back which hypothesis, how old they are, and whether a stored result file
 * still matches the integrity record written when its run was recorded (story 0.12, R54).
 *
 * - `LIVE_EVIDENCE` names the live result file behind each live hypothesis (H10, H11, H12, the hosted half of H5 and
 *   the deployed half of H9).
 * - `evidence/deployed/integrity.json` holds, for every live result file, its sha256 and its run timestamp. A file whose
 *   bytes change while its run timestamp stays the same was edited without a re-run: `checkLiveIntegrity` fails on it.
 *   A genuine re-run (new timestamp) is recorded with `pnpm evidence:record-live` (`recordLiveIntegrity`), never by hand.
 * - Staleness for the README is judged against the newest released version in CHANGELOG.md (a committed file), so the
 *   generated README section depends on committed files only. Git dates are used only by release:check.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const INTEGRITY_REL = "evidence/deployed/integrity.json";
const DEPLOYED_REL = "evidence/deployed";
const CHANGELOG_REL = "CHANGELOG.md";

interface LiveEvidenceSource {
  /** First column of the README's live-evidence table; also how release:check finds the row. */
  key: string;
  hypothesis: string;
  /** Which part of the hypothesis this run backs. */
  part: string;
  /** Result file, relative to the repo root. */
  file: string;
}

const LIVE_EVIDENCE: readonly LiveEvidenceSource[] = [
  { key: "H5 (hosted)", hypothesis: "H5", part: "hosted D1 half", file: "evidence/deployed/h5-hosted-result.json" },
  { key: "H9 (deployed)", hypothesis: "H9", part: "deployed MCP Worker half", file: "evidence/deployed/mcp-result.json" },
  { key: "H10", hypothesis: "H10", part: "whole hypothesis", file: "evidence/deployed/h10-result.json" },
  { key: "H11", hypothesis: "H11", part: "whole hypothesis", file: "evidence/deployed/h11-result.json" },
  { key: "H12", hypothesis: "H12", part: "whole hypothesis", file: "evidence/deployed/h12-result.json" },
];

export const STATUS_RECORDED = "recorded";
const STATUS_HAND_EDITED = "hand-edited, unverified";

/**
 * Live result files known to have been edited by hand without a re-run. While a file's recorded run timestamp is the
 * pinned one, integrity.json must carry status "hand-edited, unverified" and exactly this note; a genuine re-run (new
 * timestamp) clears the pin. Pinned in code so that editing integrity.json cannot quietly drop the label.
 */
export const KNOWN_HAND_EDITS: Readonly<Record<string, { runTimestamp: string; note: string }>> = {
  "evidence/deployed/h12-result.json": {
    runTimestamp: "2026-10-21T05:36:08.661Z",
    note: "result file edited by hand on 2026-10-28 (commit 8f83415) without a re-run",
  },
  "evidence/deployed/attempts/2026-10-21T05-36-19-462Z-h12-result.json": {
    runTimestamp: "2026-10-21T05:24:35.628Z",
    note: "one scanned-file path edited by hand on 2026-10-28 (commit 8f83415) without a re-run",
  },
};

interface IntegrityEntry {
  sha256: string;
  /** The run's own start time (`commandStartedAt` or the equivalent field), copied from the result file. */
  runTimestamp: string;
  status: string;
  note?: string;
}

export interface IntegrityFile {
  schema: 1;
  description: string;
  files: Record<string, IntegrityEntry>;
}

const DESCRIPTION =
  "sha256 and run timestamp of every live result file under evidence/deployed. proof:check fails when a file's hash changes while its run timestamp does not (edited without a re-run), or when a file has no entry. Record a genuine re-run with `pnpm evidence:record-live`; never edit this file by hand.";

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The run's start time from a live result object, or undefined when the file carries none. */
function runTimestampOf(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  for (const key of ["commandStartedAt", "startedAt", "at"]) {
    if (typeof r[key] === "string" && r[key]) return r[key] as string;
  }
  return undefined;
}

/** Live result files outside evidence/deployed, recorded in the same integrity file: the restore drill's run (story 1.3). */
const EXTRA_LIVE_RESULT_FILES: readonly string[] = [];

/** Every live result file (`*-result.json`) under evidence/deployed, plus EXTRA_LIVE_RESULT_FILES that exist, relative to `root`, forward slashes, sorted. */
function listLiveResultFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile() && entry.name.endsWith("-result.json")) out.push(childRel);
    }
  };
  walk(DEPLOYED_REL);
  for (const rel of EXTRA_LIVE_RESULT_FILES) if (existsSync(join(root, rel))) out.push(rel);
  return out.sort();
}

interface IntegrityRead {
  integrity?: IntegrityFile;
  /** set when the file exists but cannot be read as an integrity record */
  error?: string;
}

/** Reads evidence/deployed/integrity.json without throwing: a malformed file comes back as an INTEGRITY_UNREADABLE error. */
function loadIntegrity(root: string): IntegrityRead {
  const p = join(root, INTEGRITY_REL);
  if (!existsSync(p)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    return { error: `INTEGRITY_UNREADABLE: ${INTEGRITY_REL} is not valid JSON (${(err as Error).message})` };
  }
  const files = (parsed as { files?: unknown } | null)?.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    return { error: `INTEGRITY_UNREADABLE: ${INTEGRITY_REL} has no "files" object` };
  }
  return { integrity: parsed as IntegrityFile };
}

export function readIntegrity(root: string): IntegrityFile | undefined {
  return loadIntegrity(root).integrity;
}

/** The status and note an entry must carry, given the pinned hand edits. */
function pinnedLabelFor(rel: string, runTimestamp: string): { status: string; note?: string } {
  const pin = KNOWN_HAND_EDITS[rel];
  if (pin && pin.runTimestamp === runTimestamp) return { status: STATUS_HAND_EDITED, note: pin.note };
  return { status: STATUS_RECORDED };
}

function readRunTimestamp(root: string, rel: string): string | undefined {
  try {
    return runTimestampOf(JSON.parse(readFileSync(join(root, rel), "utf8")));
  } catch {
    return undefined;
  }
}

/** Errors (empty when clean) comparing the live result files under `root` with evidence/deployed/integrity.json. */
export function checkLiveIntegrity(root: string): string[] {
  const files = listLiveResultFiles(root);
  const { integrity, error } = loadIntegrity(root);
  if (error) return [error];
  const errors: string[] = [];
  if (!integrity) {
    if (files.length > 0) errors.push(`LIVE_INTEGRITY_MISSING: ${INTEGRITY_REL} does not exist but ${files.length} live result file(s) do`);
    return errors;
  }
  for (const rel of files) {
    const entry = integrity.files[rel];
    const ts = readRunTimestamp(root, rel);
    if (!entry) {
      errors.push(`UNTRACKED_LIVE: ${rel} has no entry in ${INTEGRITY_REL} (record a genuine run with pnpm evidence:record-live)`);
      continue;
    }
    if (!ts) {
      errors.push(`LIVE_NO_TIMESTAMP: ${rel} carries no run timestamp (commandStartedAt)`);
      continue;
    }
    const pinned = pinnedLabelFor(rel, entry.runTimestamp);
    if (entry.status !== pinned.status || entry.note !== pinned.note) {
      errors.push(
        `LIVE_LABEL_CHANGED: ${rel} must be recorded with status "${pinned.status}"${pinned.note ? ` and note "${pinned.note}"` : " and no note"} (KNOWN_HAND_EDITS in scripts/lib/live-evidence.ts), but ${INTEGRITY_REL} has status "${entry.status}"${entry.note ? ` and note "${entry.note}"` : " and no note"}`,
      );
    }
    const hash = sha256File(join(root, rel));
    if (hash === entry.sha256) {
      if (ts !== entry.runTimestamp) {
        errors.push(`LIVE_TAMPER: ${rel} run timestamp ${ts} differs from the recorded ${entry.runTimestamp} although the hash is unchanged`);
      }
      continue;
    }
    if (ts === entry.runTimestamp) {
      errors.push(
        `LIVE_TAMPER: ${rel} changed (sha256 ${hash.slice(0, 12)}... != recorded ${entry.sha256.slice(0, 12)}...) but its run timestamp ${ts} is unchanged: a stored live result was edited without a re-run`,
      );
    } else {
      errors.push(`LIVE_UNRECORDED_RUN: ${rel} has a new run (${ts}, recorded ${entry.runTimestamp}); record it with pnpm evidence:record-live`);
    }
  }
  const present = new Set(files);
  for (const rel of Object.keys(integrity.files)) {
    if (!present.has(rel)) errors.push(`LIVE_MISSING: ${INTEGRITY_REL} lists ${rel}, which does not exist`);
  }
  return errors;
}

export interface RecordLiveResult {
  ok: boolean;
  errors: string[];
  /** files added or updated */
  recorded: string[];
}

/**
 * Records new live runs in evidence/deployed/integrity.json. A file with no entry, or whose run timestamp is later than
 * its entry's, gets a fresh entry (status from `pinnedLabelFor`). A changed file with the same timestamp is refused:
 * that is an edit, not a run. Nothing is written unless every file is acceptable.
 */
export function recordLiveIntegrity(root: string): RecordLiveResult {
  const files = listLiveResultFiles(root);
  const read = loadIntegrity(root);
  if (read.error) return { ok: false, errors: [read.error], recorded: [] };
  const current = read.integrity ?? { schema: 1 as const, description: DESCRIPTION, files: {} };
  const next: Record<string, IntegrityEntry> = {};
  const errors: string[] = [];
  const recorded: string[] = [];
  for (const rel of files) {
    const ts = readRunTimestamp(root, rel);
    const hash = sha256File(join(root, rel));
    const entry = current.files[rel];
    if (!ts) {
      errors.push(`LIVE_NO_TIMESTAMP: ${rel} carries no run timestamp (commandStartedAt); cannot record it`);
      continue;
    }
    if (!entry) {
      next[rel] = { sha256: hash, runTimestamp: ts, ...pinnedLabelFor(rel, ts) };
      recorded.push(rel);
      continue;
    }
    if (entry.sha256 === hash && entry.runTimestamp === ts) {
      next[rel] = entry;
      continue;
    }
    if (ts === entry.runTimestamp) {
      errors.push(`LIVE_TAMPER: ${rel} changed but its run timestamp ${ts} did not; refusing to record an edit as a run`);
      continue;
    }
    if (Date.parse(ts) <= Date.parse(entry.runTimestamp)) {
      errors.push(`LIVE_OLDER_RUN: ${rel} run timestamp ${ts} is not later than the recorded ${entry.runTimestamp}`);
      continue;
    }
    next[rel] = { sha256: hash, runTimestamp: ts, ...pinnedLabelFor(rel, ts) };
    recorded.push(rel);
  }
  const present = new Set(files);
  for (const rel of Object.keys(current.files)) {
    if (!present.has(rel)) errors.push(`LIVE_MISSING: ${INTEGRITY_REL} lists ${rel}, which does not exist`);
  }
  if (errors.length > 0) return { ok: false, errors, recorded: [] };
  const out: IntegrityFile = { schema: 1, description: current.description || DESCRIPTION, files: next };
  writeFileSync(join(root, INTEGRITY_REL), `${JSON.stringify(out, null, 2)}\n`, "utf8");
  return { ok: true, errors: [], recorded };
}

export interface LiveRunInfo extends LiveEvidenceSource {
  runTimestamp: string | undefined;
  /** YYYY-MM-DD of the run, or "unknown" */
  runDate: string;
  entry: IntegrityEntry | undefined;
}

/** Live runs with their integrity entries; an unreadable integrity file leaves `entry` undefined (proof:check reports it). */
export function loadLiveRuns(root: string): LiveRunInfo[] {
  const integrity = loadIntegrity(root).integrity;
  return LIVE_EVIDENCE.map((src) => {
    const ts = existsSync(join(root, src.file)) ? readRunTimestamp(root, src.file) : undefined;
    return {
      ...src,
      runTimestamp: ts,
      runDate: ts ? ts.slice(0, 10) : "unknown",
      entry: integrity?.files[src.file],
    };
  });
}

export interface ReleaseRef {
  version: string;
  /** YYYY-MM-DD */
  date: string;
}

/** The newest released version in CHANGELOG.md text (`## [x.y.z] - YYYY-MM-DD`; Unreleased has no date and is skipped). */
export function latestReleaseFromChangelog(text: string): ReleaseRef | undefined {
  let best: ReleaseRef | undefined;
  for (const m of text.matchAll(/^##\s*\[(\d+\.\d+\.\d+[^\]]*)\]\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/gm)) {
    const ref = { version: m[1]!, date: m[2]! };
    if (!best || ref.date > best.date) best = ref;
  }
  return best;
}

/** Reads the newest release from CHANGELOG.md in `root`, else in `fallbackRoot`. */
export function readLatestRelease(root: string, fallbackRoot: string): ReleaseRef | undefined {
  for (const dir of [root, fallbackRoot]) {
    const p = join(dir, CHANGELOG_REL);
    if (existsSync(p)) return latestReleaseFromChangelog(readFileSync(p, "utf8"));
  }
  return undefined;
}

/**
 * A live run is stale when it started before the release date (start of that day, UTC). A run with no timestamp is
 * always stale; with no release date, no run with a timestamp is.
 */
export function isStale(runTimestamp: string | undefined, releaseDate: string | undefined): boolean {
  if (!runTimestamp) return true;
  const run = Date.parse(runTimestamp);
  if (!Number.isFinite(run)) return true;
  return releaseDate !== undefined && run < Date.parse(releaseDate);
}

export function staleLabel(runDate: string): string {
  return `stale (run ${runDate})`;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Commit date (ISO) of any revision, or undefined. Used only by release:check, never by the README generator. */
export function commitDateOf(cwd: string, rev: string): string | undefined {
  return git(cwd, ["log", "-1", "--format=%cI", `${rev}^{commit}`]);
}
