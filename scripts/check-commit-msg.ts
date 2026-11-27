#!/usr/bin/env node
/**
 * scripts/check-commit-msg.ts
 *
 * The commit-msg hook (lefthook.yml): refuses a commit whose message lacks a `Signed-off-by` trailer naming the
 * commit's author. The rules (trailer block, case-insensitive key, author match) are scripts/check-dco.ts's, imported
 * here, so the hook and the pull-request DCO check cannot drift apart. Merge commits and fixup!/squash!/amend! commits
 * are skipped locally: the first is not checked by the DCO workflow, the others are meant to be squashed into a signed
 * commit. The DCO check on the pull request still requires a sign-off on a fixup!/squash!/amend! commit pushed
 * unsquashed.
 *
 * The author is read from GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL (git exports them to hooks, including for --author and
 * --amend), falling back to `git var GIT_AUTHOR_IDENT`.
 *
 * Usage:
 *   node scripts/check-commit-msg.ts <message-file>
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDco } from "./check-dco.ts";

export interface Author {
  name: string;
  email: string;
}

const SCISSORS = / -{8,} >8 -{8,}/;

function git(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/**
 * True when the message file came from the editor, i.e. git will strip comment lines from it: it holds git's commit
 * template comment ("Please enter the commit message ...") or the `--verbose` scissors line. A message given with
 * `-m` or `-F` is only whitespace-cleaned, so its comment-like lines are kept and must be checked as they are.
 */
export function isEditorMessage(message: string, commentChar = "#"): boolean {
  return message
    .replace(/\r\n/g, "\n")
    .split("\n")
    .some((line) => line.startsWith(commentChar) && (SCISSORS.test(line) || line.startsWith(`${commentChar} Please enter the commit message`)));
}

/**
 * The message as git will record it from the editor: comment lines removed and everything from the `--verbose`
 * scissors line on dropped. The commit-msg hook runs before git's own cleanup, so the file can still hold both.
 */
export function stripComments(message: string, commentChar = "#"): string {
  const kept: string[] = [];
  for (const line of message.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith(commentChar)) {
      if (SCISSORS.test(line)) break;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/** fixup!, squash! and amend! commits are folded into another commit by `rebase --autosquash` before they land. */
export function isAutosquashCommit(message: string): boolean {
  return /^(fixup|squash|amend)! /.test(message.trimStart());
}

export function parseIdent(ident: string): Author | undefined {
  const m = /^(.*?)\s*<([^<>]*)>/.exec(ident);
  return m ? { name: (m[1] ?? "").trim(), email: (m[2] ?? "").trim() } : undefined;
}

export function readAuthor(env: NodeJS.ProcessEnv, cwd: string): Author | undefined {
  const name = env.GIT_AUTHOR_NAME;
  const email = env.GIT_AUTHOR_EMAIL;
  if (name && email) return { name, email };
  const ident = git(["var", "GIT_AUTHOR_IDENT"], cwd, env);
  return ident ? parseIdent(ident) : undefined;
}

function isMerging(cwd: string, env: NodeJS.ProcessEnv): boolean {
  const mergeHead = git(["rev-parse", "--git-path", "MERGE_HEAD"], cwd, env);
  if (!mergeHead) return false;
  return existsSync(isAbsolute(mergeHead) ? mergeHead : join(cwd, mergeHead));
}

/** core.commentString (git 2.45+) wins over core.commentChar; '#' only when neither is set ("auto" counts as '#'). */
function commentChar(cwd: string, env: NodeJS.ProcessEnv): string {
  for (const key of ["core.commentString", "core.commentChar"]) {
    const configured = git(["config", "--get", key], cwd, env);
    if (configured && configured !== "auto") return configured;
  }
  return "#";
}

export function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): number {
  const [file] = argv;
  if (!file) {
    console.error("usage: node scripts/check-commit-msg.ts <message-file>");
    return 2;
  }
  if (isMerging(cwd, env)) return 0;
  const raw = readFileSync(resolve(cwd, file), "utf8");
  const comment = commentChar(cwd, env);
  const message = isEditorMessage(raw, comment) ? stripComments(raw, comment) : raw;
  if (isAutosquashCommit(message)) return 0;
  const author = readAuthor(env, cwd);
  if (!author) {
    console.error("commit-msg: could not determine the commit author (set git user.name and user.email).");
    return 1;
  }
  const [failure] = checkDco([{ sha: "", parents: [], authorName: author.name, authorEmail: author.email, message }]);
  if (!failure) return 0;
  console.error(`commit-msg: ${failure.reason}.`);
  console.error("Fix: commit with `git commit -s`, which adds the sign-off. See CONTRIBUTING.md (Sign your commits).");
  return 1;
}

// Compare real paths (case-folded on Windows), as scripts/check-dco.ts does, so the CLI cannot silently skip main().
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
