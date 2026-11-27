// The commit-msg hook's sign-off check (scripts/check-commit-msg.ts). It must refuse an unsigned message and one signed
// by someone other than the author, accept one signed by the author, and skip merges and fixup!/squash! commits. The
// rules themselves are scripts/check-dco.ts's; these tests pin that the hook applies them to the message file.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, parseIdent, stripComments } from "../check-commit-msg.ts";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const cli = join(repoRoot, "scripts", "check-commit-msg.ts");
// The caller's environment without git or lefthook variables, so a run from inside a hook (GIT_DIR, GIT_AUTHOR_*,
// GIT_INDEX_FILE ...) cannot leak into these tests' git calls.
const baseEnv: NodeJS.ProcessEnv = {};
for (const [key, value] of Object.entries(process.env)) {
  if (!/^(GIT_|LEFTHOOK)/i.test(key)) baseEnv[key] = value;
}
const author = { ...baseEnv, GIT_AUTHOR_NAME: "Ada Lovelace", GIT_AUTHOR_EMAIL: "ada@example.com" };
const signed = "feat: thing\n\nSigned-off-by: Ada Lovelace <ada@example.com>\n";

describe("check-commit-msg", () => {
  let dir: string;
  let n = 0;

  function msg(text: string): string {
    const file = join(dir, `msg-${n++}.txt`);
    writeFileSync(file, text, "utf8");
    return file;
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "commit-msg-"));
    execFileSync("git", ["init", "-q"], { cwd: dir, env: baseEnv });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an unsigned message", () => {
    expect(main([msg("feat: thing\n")], author, dir)).toBe(1);
  });

  it("accepts a message signed off by the author", () => {
    expect(main([msg(signed)], author, dir)).toBe(0);
  });

  it("refuses a message signed off by someone else", () => {
    expect(main([msg("feat: thing\n\nSigned-off-by: Charles Babbage <cb@example.com>\n")], author, dir)).toBe(1);
  });

  it("matches the trailer key case-insensitively and the email ignoring case", () => {
    expect(main([msg("feat: thing\n\nsigned-off-by: Ada Lovelace <ADA@example.com>\n")], author, dir)).toBe(0);
  });

  it("ignores git's comment lines and everything below the --verbose scissors line", () => {
    const text = `${signed}\n# Please enter the commit message for your changes.\n# ------------------------ >8 ------------------------\ndiff --git a/x b/x\n`;
    expect(main([msg(text)], author, dir)).toBe(0);
    expect(stripComments(text).trim()).toBe(signed.trim());
  });

  it("checks a -m/-F message as it is: a trailing '# notes' paragraph is kept by git, so the sign-off is not last", () => {
    // git commit -m "feat: thing" -m "Signed-off-by: ..." -m "# notes" records the '# notes' line (whitespace cleanup).
    expect(main([msg(`${signed}\n# notes\n`)], author, dir)).toBe(1);
  });

  it("strips the comment block of an editor-template message before checking", () => {
    const template =
      `${signed}\n# Please enter the commit message for your changes. Lines starting\n` +
      "# with '#' will be ignored, and an empty message aborts the commit.\n#\n# On branch main\n";
    expect(main([msg(template)], author, dir)).toBe(0);
  });

  it("skips fixup!, squash! and amend! commits", () => {
    for (const prefix of ["fixup!", "squash!", "amend!"]) {
      expect(main([msg(`${prefix} feat: thing\n`)], author, dir)).toBe(0);
    }
  });

  it("skips a merge commit (MERGE_HEAD present)", () => {
    const mergeHead = join(dir, ".git", "MERGE_HEAD");
    writeFileSync(mergeHead, `${"a".repeat(40)}\n`, "utf8");
    try {
      expect(main([msg("Merge branch 'x'\n")], author, dir)).toBe(0);
    } finally {
      rmSync(mergeHead);
    }
    expect(main([msg("Merge branch 'x'\n")], author, dir)).toBe(1);
  });

  it("reads the author from git var GIT_AUTHOR_IDENT when the env does not name one", () => {
    execFileSync("git", ["config", "user.name", "Ada Lovelace"], { cwd: dir, env: baseEnv });
    execFileSync("git", ["config", "user.email", "ada@example.com"], { cwd: dir, env: baseEnv });
    const env = baseEnv;
    expect(main([msg(signed)], env, dir)).toBe(0);
    expect(main([msg("feat: thing\n")], env, dir)).toBe(1);
    expect(parseIdent("Ada Lovelace <ada@example.com> 1700000000 +0000")).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
  });

  it("the CLI exits 1 with the `git commit -s` hint on an unsigned message and 0 on a signed one", () => {
    const env = author;
    const bad = spawnSync(process.execPath, [cli, msg("feat: thing\n")], { cwd: dir, env, encoding: "utf8" });
    expect(bad.status, bad.stderr).toBe(1);
    expect(bad.stderr).toContain("git commit -s");
    expect(bad.stderr).toContain("Signed-off-by: Ada Lovelace <ada@example.com>");
    const good = spawnSync(process.execPath, [cli, msg(signed)], { cwd: dir, env, encoding: "utf8" });
    expect(good.status, good.stderr).toBe(0);
  });
});
