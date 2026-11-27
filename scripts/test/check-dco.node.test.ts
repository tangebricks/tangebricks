// The DCO sign-off gate. The pure checker must fail unsigned or wrongly signed commits, skip merges and bots, and the
// CLI must exit 1 on a real git range that holds an unsigned commit and 0 on a range of signed commits only.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkDco, type DcoCommit } from "../check-dco.ts";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const cli = join(repoRoot, "scripts", "check-dco.ts");

const author = { authorName: "Ada Lovelace", authorEmail: "ada@example.com" };

function commit(over: Partial<DcoCommit>): DcoCommit {
  return { sha: "a".repeat(40), parents: ["b".repeat(40)], ...author, message: "feat: thing\n", ...over };
}

describe("checkDco (pure)", () => {
  it("fails an unsigned commit", () => {
    const failures = checkDco([commit({})]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toContain("Signed-off-by: Ada Lovelace <ada@example.com>");
  });

  it("passes a commit signed off by its author", () => {
    expect(checkDco([commit({ message: "feat: thing\n\nSigned-off-by: Ada Lovelace <ada@example.com>\n" })])).toEqual([]);
  });

  it("fails a commit signed off by someone else", () => {
    const failures = checkDco([commit({ message: "feat: thing\n\nSigned-off-by: Charles Babbage <cb@example.com>\n" })]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toContain("does not match");
  });

  it("fails a malformed trailer", () => {
    expect(checkDco([commit({ message: "feat: thing\n\nSigned-off-by: Ada Lovelace ada@example.com\n" })])).toHaveLength(1);
  });

  it("passes when the email differs only in case", () => {
    expect(checkDco([commit({ message: "feat: thing\n\nSigned-off-by: Ada Lovelace <ADA@Example.COM>\n" })])).toEqual([]);
  });

  it("skips merge commits", () => {
    expect(checkDco([commit({ parents: ["b".repeat(40), "c".repeat(40)], message: "Merge pull request #1\n" })])).toEqual([]);
  });

  it("skips bot authors by email or name", () => {
    expect(
      checkDco([
        commit({ authorName: "dependabot", authorEmail: "49699333+dependabot[bot]@users.noreply.github.com" }),
        commit({ authorName: "github-actions[bot]", authorEmail: "actions@github.com" }),
      ]),
    ).toEqual([]);
  });

  it("fails when the only matching sign-off sits mid-body, not in the trailer block", () => {
    const message = "feat: thing\n\nSigned-off-by: Ada Lovelace <ada@example.com>\n\nMore prose after it.\n";
    expect(checkDco([commit({ message })])).toHaveLength(1);
  });

  it("accepts the trailer key case-insensitively", () => {
    expect(checkDco([commit({ message: "feat: thing\n\nsigned-off-by: Ada Lovelace <ada@example.com>\n" })])).toEqual([]);
  });

  it("passes when one of several trailers matches the author", () => {
    const message =
      "feat: thing\n\nCo-Authored-By: Someone <s@example.com>\nSigned-off-by: Charles Babbage <cb@example.com>\n" +
      "Signed-off-by: Ada Lovelace <ada@example.com>\n";
    expect(checkDco([commit({ message })])).toEqual([]);
  });
});

describe("check-dco CLI on a real repository", () => {
  let dir: string;
  let base: string;
  let signed: string;
  let unsigned: string;

  function git(...args: string[]): string {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  }

  function runCli(from: string, to: string): { status: number | null; output: string } {
    const run = spawnSync(process.execPath, [cli, from, to], { cwd: dir, encoding: "utf8" });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "check-dco-"));
    git("init", "-q");
    git("config", "user.name", "Ada Lovelace");
    git("config", "user.email", "ada@example.com");
    git("config", "commit.gpgsign", "false");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(dir, "a.txt"), "a\n", "utf8");
    git("add", "a.txt");
    git("commit", "-q", "-m", "base (unsigned, outside the range)");
    base = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "b.txt"), "b\n", "utf8");
    git("add", "b.txt");
    git("commit", "-q", "-s", "-m", "signed commit", "-m", "with a multi-line\nbody");
    signed = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "c.txt"), "c\n", "utf8");
    git("add", "c.txt");
    git("commit", "-q", "-m", "unsigned commit");
    unsigned = git("rev-parse", "HEAD");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 0 on a range of signed commits only", () => {
    const { status, output } = runCli(base, signed);
    expect(status, output).toBe(0);
    expect(output).toContain("DCO: 1 commit(s) checked, 0 failing");
  });

  it("exits 1 and names the unsigned commit when it is in the range", () => {
    const { status, output } = runCli(base, unsigned);
    expect(status, output).toBe(1);
    expect(output).toContain(unsigned.slice(0, 12));
    expect(output).toContain("unsigned commit");
    expect(output).toContain("Signed-off-by: Ada Lovelace <ada@example.com>");
    expect(output).toContain("git rebase --signoff");
    expect(output).not.toContain(signed.slice(0, 12));
    expect(output).toContain("DCO: 2 commit(s) checked, 1 failing");
  });
});
