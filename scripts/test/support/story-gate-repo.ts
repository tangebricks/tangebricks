import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The story-gate fixtures cite commits by short SHA. Those SHAs came from the
 * private history that preceded the public repository, so they do not exist
 * here. Each one stands for a kind of commit; buildStoryGateRepo() makes a
 * throwaway git repository with one real commit of each kind and copies the
 * fixtures into it with every stand-in SHA replaced by the real one.
 */
const STAND_INS = {
  "86544e8": "base", // code change whose subject belongs to no story
  "63a8be2": "uc01-a", // "UC0.1: ..." code change
  "2332f00": "uc01-b", // "UC0.1: ..." code change
  "b4294d1": "uc01-c", // "UC0.1: ..." code change
  "c8e8a9c": "uc04-docs", // "UC0.4: ..." markdown-only change
  a67cfb6: "uc04-docs", // markdown-only change
  b1dafe5: "evidence-only", // change under evidence/ only
  "8ff5a65": "side-branch", // commit that is not an ancestor of HEAD
} as const;

type Kind = (typeof STAND_INS)[keyof typeof STAND_INS];

export interface StoryGateRepo {
  root: string;
  fixtures: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(root: string, file: string, subject: string): string {
  const full = join(root, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${subject}\n`);
  git(root, ["add", "--", file]);
  git(root, ["commit", "-q", "-m", subject]);
  return git(root, ["rev-parse", "HEAD"]);
}

export function buildStoryGateRepo(fixturesSource: string): StoryGateRepo {
  const root = mkdtempSync(join(tmpdir(), "story-gate-repo-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Story Gate Test"]);
  git(root, ["config", "user.email", "story-gate@example.com"]);
  git(root, ["config", "commit.gpgsign", "false"]);

  const sha: Record<Kind, string> = {
    base: commit(root, "src/base.ts", "Base commit"),
    "uc01-a": commit(root, "src/uc01-a.ts", "UC0.1: evidence stamp helper"),
    "uc01-b": commit(root, "src/uc01-b.ts", "UC0.1: quarantine simulated evidence"),
    "uc01-c": commit(root, "src/uc01-c.ts", "UC0.1: wire the stamp into the generators"),
    "uc04-docs": commit(root, "notes/uc04.md", "UC0.4: document the story gate"),
    "evidence-only": commit(root, "evidence/result.json", "Refresh evidence"),
    "side-branch": "",
  };
  git(root, ["switch", "-q", "-c", "side"]);
  sha["side-branch"] = commit(root, "src/side.ts", "UC9.9: work that was never merged");
  git(root, ["switch", "-q", "main"]);

  const fixtures = join(root, "fixtures");
  cpSync(fixturesSource, fixtures, { recursive: true });
  for (const name of readdirSync(fixtures)) {
    const path = join(fixtures, name);
    let text = readFileSync(path, "utf8");
    for (const [standIn, kind] of Object.entries(STAND_INS)) {
      text = text.split(standIn).join(sha[kind]);
    }
    writeFileSync(path, text);
  }
  return { root, fixtures };
}
