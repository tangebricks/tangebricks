// The lefthook git hooks end to end. lefthook.yml and the scripts it runs are copied into a temporary git repository,
// the pinned lefthook binary installs the hooks there, and real `git commit`s must then be refused for a staged unused
// variable (pre-commit oxlint) and for an unsigned message (commit-msg), while a clean signed commit and a JSON-only
// commit (the shape of an evidence refresh) go through, and an unformatted staged file is committed as Prettier formats it.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { gitleaksArgs, main as gitleaksMain } from "../run-gitleaks-staged.ts";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const lefthookBin = join(repoRoot, "node_modules", "lefthook", "bin", "index.js");
const copied = [
  "lefthook.yml",
  ".oxlintrc.json",
  ".prettierrc.json",
  ".prettierignore",
  ".gitleaks.toml",
  "scripts/check-commit-msg.ts",
  "scripts/check-dco.ts",
  "scripts/run-gitleaks-staged.ts",
];

// A clean environment: no git variables leaking in from a hook that runs this test, and no LEFTHOOK=0.
const env: NodeJS.ProcessEnv = {};
for (const [key, value] of Object.entries(process.env)) {
  if (!/^(GIT_|LEFTHOOK)/i.test(key)) env[key] = value;
}

describe("lefthook hooks (temporary repository)", () => {
  let dir: string;
  let installError = "";

  function run(cmd: string, args: readonly string[]): { status: number | null; output: string } {
    const r = spawnSync(cmd, args, { cwd: dir, env, encoding: "utf8" });
    return { status: r.status, output: `${r.error?.message ?? ""}${r.stdout}${r.stderr}` };
  }
  const git = (...args: string[]) => run("git", args);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "lefthook-e2e-"));
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "src"));
    for (const file of copied) copyFileSync(join(repoRoot, file), join(dir, file));
    writeFileSync(join(dir, "package.json"), '{ "type": "module", "private": true }\n', "utf8");
    writeFileSync(join(dir, ".gitignore"), "node_modules\n", "utf8");
    // The hooks call node_modules/oxlint; a junction (no admin rights needed on Windows) reuses the repo's install.
    symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "junction");
    git("init", "-q");
    git("config", "user.name", "Ada Lovelace");
    git("config", "user.email", "ada@example.com");
    git("config", "commit.gpgsign", "false");
    const install = run(process.execPath, [lefthookBin, "install"]);
    if (install.status !== 0) installError = install.output || `exit ${install.status}`;
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an unused variable and an unsigned message, accepts clean signed commits", (ctx) => {
    if (installError) {
      if (process.env.CI) ctx.skip(`lefthook install failed on this CI platform: ${installError}`);
      throw new Error(`lefthook install failed: ${installError}`);
    }

    // pre-commit: oxlint refuses a staged file with an unused variable (in a subdirectory, so the glob is exercised).
    writeFileSync(join(dir, "src", "bad.ts"), "export function f(): number {\n  const unused = 1;\n  return 2;\n}\n", "utf8");
    expect(git("add", "-A").status).toBe(0);
    const lint = git("commit", "-s", "-m", "feat: add f");
    expect(lint.status, lint.output).not.toBe(0);
    expect(lint.output).toContain("no-unused-vars");

    // commit-msg: a clean file, but an unsigned message, is refused with the fix hint.
    writeFileSync(join(dir, "src", "bad.ts"), "export function f(): number {\n  return 2;\n}\n", "utf8");
    expect(git("add", "-A").status).toBe(0);
    const unsigned = git("commit", "-m", "feat: add f");
    expect(unsigned.status, unsigned.output).not.toBe(0);
    expect(unsigned.output).toContain("git commit -s");
    expect(git("rev-list", "--all", "--count").output.trim()).toBe("0");

    // A clean, signed commit goes through.
    const clean = git("commit", "-s", "-m", "feat: add f");
    expect(clean.status, clean.output).toBe(0);

    // A JSON-only signed commit (what an evidence refresh commits) passes: oxlint has nothing to lint.
    writeFileSync(join(dir, "evidence.json"), '{ "ok": true }\n', "utf8");
    expect(git("add", "evidence.json").status).toBe(0);
    const json = git("commit", "-s", "-m", "Evidence refresh");
    expect(json.status, json.output).toBe(0);
    expect(git("rev-list", "--count", "HEAD").output.trim()).toBe("2");

    // A staged source under an oxlint-ignored path (fixtures/**) is not linted, and an all-ignored set of staged
    // sources must not fail with "No files found to lint" (--no-error-on-unmatched-pattern).
    mkdirSync(join(dir, "fixtures"));
    writeFileSync(join(dir, "fixtures", "x.ts"), "const unused = 1;\n", "utf8");
    expect(git("add", "fixtures/x.ts").status).toBe(0);
    const ignored = git("commit", "-s", "-m", "test: add fixture");
    expect(ignored.status, ignored.output).toBe(0);
    expect(git("rev-list", "--count", "HEAD").output.trim()).toBe("3");

    // pre-commit Prettier: an unformatted staged file is formatted and re-staged before oxlint, so the commit holds the
    // formatted text and nothing is left unstaged.
    writeFileSync(join(dir, "src", "ugly.ts"), "export const answer = {a:1,b:'two'}\n", "utf8");
    expect(git("add", "src/ugly.ts").status).toBe(0);
    const formatted = git("commit", "-s", "-m", "feat: add answer");
    expect(formatted.status, formatted.output).toBe(0);
    expect(git("show", "HEAD:src/ugly.ts").output).toBe('export const answer = { a: 1, b: "two" };\n');
    expect(git("status", "--porcelain").output.trim()).toBe("");
  });
});

describe("pre-commit gitleaks wrapper", () => {
  it("uses `git --staged` on gitleaks 8.19+ and `protect --staged` before that, with the repo config", () => {
    expect(gitleaksArgs("8.21.2")).toEqual(["git", "--staged", "--redact", "--no-banner", "-c", ".gitleaks.toml", "."]);
    expect(gitleaksArgs("v8.18.4")).toEqual(["protect", "--staged", "--redact", "--no-banner", "-c", ".gitleaks.toml"]);
  });

  it("warns in one line and passes when the gitleaks binary is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(gitleaksMain({ ...process.env, GITLEAKS_BIN: "no-such-gitleaks-binary" }, repoRoot)).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("skipping");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("prepare script (scripts/install-hooks.mjs) CI decision", () => {
  // Run outside any git work tree, so the non-CI path stops at its work-tree check and never installs anything.
  function prepare(ci: string | undefined): string {
    const dir = mkdtempSync(join(tmpdir(), "install-hooks-"));
    try {
      const childEnv: NodeJS.ProcessEnv = { ...env };
      delete childEnv.CI;
      if (ci !== undefined) childEnv.CI = ci;
      const r = spawnSync(process.execPath, [join(repoRoot, "scripts", "install-hooks.mjs")], { cwd: dir, env: childEnv, encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("skips when CI is truthy", () => {
    for (const ci of ["true", "1", "yes"]) expect(prepare(ci)).toContain("CI is set; git hooks not installed.");
  });

  it("takes the install path when CI is unset, empty, 0 or false", () => {
    for (const ci of [undefined, "", "0", "false"]) {
      const out = prepare(ci);
      expect(out).not.toContain("CI is set");
      expect(out).toContain("not inside a git work tree");
    }
  });
});
