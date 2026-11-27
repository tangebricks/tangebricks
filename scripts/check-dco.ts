#!/usr/bin/env node
/**
 * scripts/check-dco.ts
 *
 * Enforces the Developer Certificate of Origin sign-off (CONTRIBUTING.md) on a pull request's commits. Every
 * non-merge, non-bot commit in `<base>..<head>` must carry a `Signed-off-by: <author name> <author email>` trailer
 * that matches the commit's author. Email comparison is case-insensitive; names are trimmed. Commits already on the
 * base branch are never checked, and history is never rewritten.
 *
 * Usage:
 *   node scripts/check-dco.ts <base> <head>
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DcoCommit {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  message: string;
}

export interface DcoFailure {
  sha: string;
  reason: string;
}

// Git treats trailer keys case-insensitively, so the key is matched that way too.
const SIGN_OFF = /^Signed-off-by:[ \t]*(.*?)[ \t]*<([^<>\s]+)>[ \t]*$/i;
const SIGN_OFF_KEY = /^Signed-off-by:/i;

/** The trailer block: the last paragraph of the message (the lines after its final blank line). */
export function trailerLines(message: string): string[] {
  const paragraphs = message.replace(/\r\n/g, "\n").trim().split(/\n[ \t]*\n/);
  if (paragraphs.length < 2) return [];
  return (paragraphs[paragraphs.length - 1] ?? "").split("\n").map((l) => l.trim());
}

export function isBot(commit: Pick<DcoCommit, "authorName" | "authorEmail">): boolean {
  return (
    commit.authorEmail.trim().toLowerCase().endsWith("[bot]@users.noreply.github.com") ||
    commit.authorName.trim().endsWith("[bot]")
  );
}

export function expectedTrailer(commit: Pick<DcoCommit, "authorName" | "authorEmail">): string {
  return `Signed-off-by: ${commit.authorName.trim()} <${commit.authorEmail.trim()}>`;
}

/** True when the message's trailer block has a sign-off naming exactly this author. */
export function hasMatchingSignOff(commit: DcoCommit): boolean {
  const name = commit.authorName.trim();
  const email = commit.authorEmail.trim().toLowerCase();
  for (const line of trailerLines(commit.message)) {
    const m = SIGN_OFF.exec(line);
    if (!m) continue;
    const signerName = (m[1] ?? "").trim();
    const signerEmail = (m[2] ?? "").trim().toLowerCase();
    if (signerName === name && signerEmail === email) return true;
  }
  return false;
}

/** Pure check: returns one failure per commit that needs a sign-off and lacks a matching one. */
export function checkDco(commits: readonly DcoCommit[]): DcoFailure[] {
  const failures: DcoFailure[] = [];
  for (const commit of commits) {
    if (commit.parents.length > 1) continue;
    if (isBot(commit)) continue;
    if (hasMatchingSignOff(commit)) continue;
    const signed = trailerLines(commit.message).some((l) => SIGN_OFF_KEY.test(l));
    failures.push({
      sha: commit.sha,
      reason: signed
        ? `Signed-off-by trailer does not match the author; expected "${expectedTrailer(commit)}"`
        : `missing Signed-off-by trailer in the message's final paragraph; expected "${expectedTrailer(commit)}"`,
    });
  }
  return failures;
}

// ASCII record and unit separators: they cannot appear in names or emails and do not occur in normal messages.
const RS = "\x1e";
const US = "\x1f";

export function parseGitLog(output: string): DcoCommit[] {
  const commits: DcoCommit[] = [];
  for (const raw of output.split(RS)) {
    const record = raw.replace(/^\r?\n/, "");
    if (record.trim() === "") continue;
    const [sha = "", parents = "", authorName = "", authorEmail = "", ...rest] = record.split(US);
    commits.push({
      sha: sha.trim(),
      parents: parents.trim() === "" ? [] : parents.trim().split(/\s+/),
      authorName,
      authorEmail,
      message: rest.join(US),
    });
  }
  return commits;
}

export function readCommits(base: string, head: string, cwd: string = process.cwd()): DcoCommit[] {
  const output = execFileSync(
    "git",
    ["log", "--no-color", `--format=%H${US}%P${US}%an${US}%ae${US}%B${RS}`, `${base}..${head}`],
    { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return parseGitLog(output);
}

export function main(argv: readonly string[], cwd: string = process.cwd()): number {
  const [base, head] = argv;
  if (!base || !head) {
    console.error("usage: node scripts/check-dco.ts <base> <head>");
    return 2;
  }
  const commits = readCommits(base, head, cwd);
  const failures = checkDco(commits);
  const summary = `DCO: ${commits.length} commit(s) checked, ${failures.length} failing (${base}..${head})`;
  if (failures.length === 0) {
    console.log(summary);
    return 0;
  }
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  console.error(`DCO: ${failures.length} commit(s) in ${base}..${head} lack a matching Signed-off-by trailer:`);
  for (const f of failures) {
    const c = bySha.get(f.sha);
    const subject = c?.message.split(/\r?\n/)[0] ?? "";
    console.error(`  ${f.sha.slice(0, 12)} ${subject}`);
    console.error(`    expected: ${c ? expectedTrailer(c) : "Signed-off-by: <author name> <author email>"}`);
  }
  console.error(
    "\nFix: the sign-off must name the commit's author. `git commit --amend -s --no-edit` (last commit) and\n" +
      "`git rebase --signoff <base>` (every commit) sign as the committer, your git user.name/user.email, so they\n" +
      "only fix commits you authored. If author and committer differ, the author must sign off, or the commit must\n" +
      "be re-authored (`git commit --amend --reset-author -s --no-edit`). Then force-push the branch.\n" +
      "See CONTRIBUTING.md (Sign your commits).",
  );
  console.error(summary);
  return 1;
}

// Compare real paths (case-folded on Windows) so a symlink, junction or drive-letter case difference cannot make
// the CLI silently skip main() and exit 0.
function canonicalPath(path: string): string {
  let real = resolve(path);
  try {
    real = realpathSync(real);
  } catch {
    // keep the resolved path
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

if (process.argv[1] && canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
