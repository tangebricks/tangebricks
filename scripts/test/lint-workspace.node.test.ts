import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintWorkspace } from "../lint-workspace.ts";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const scriptPath = resolve(repoRoot, "scripts/lint-workspace.ts");

describe("lint-workspace", () => {
  it("exits 0 on the repository workspace when every package name is unique", () => {
    const result = lintWorkspace(repoRoot);
    expect(result.ok).toBe(true);
    expect(result.duplicates).toEqual([]);
    expect(result.checked).toBeGreaterThan(0);

    const cli = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(cli.status).toBe(0);
    expect(cli.stdout).toContain("Workspace package names are unique");
  });

  it("exits 1 and names both directories when two workspace package.json files share a name", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "lint-workspace-dup-"));
    try {
      writeFileSync(join(fixtureRoot, "pnpm-workspace.yaml"), ["packages:", "  - packages/*", "  - bricks/*", ""].join("\n"), "utf8");

      const pkgDir = join(fixtureRoot, "packages", "dup-pkg");
      const brickDir = join(fixtureRoot, "bricks", "dup-pkg");
      const uniqueDir = join(fixtureRoot, "packages", "unique-pkg");
      mkdirSync(pkgDir, { recursive: true });
      mkdirSync(brickDir, { recursive: true });
      mkdirSync(uniqueDir, { recursive: true });

      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@poc/dup-pkg", version: "0.0.1" }, null, 2), "utf8");
      writeFileSync(join(brickDir, "package.json"), JSON.stringify({ name: "@poc/dup-pkg", version: "0.0.1" }, null, 2), "utf8");
      writeFileSync(join(uniqueDir, "package.json"), JSON.stringify({ name: "@poc/unique-pkg", version: "0.0.1" }, null, 2), "utf8");

      const result = lintWorkspace(fixtureRoot);
      expect(result.ok).toBe(false);
      expect(result.duplicates).toEqual([
        {
          name: "@poc/dup-pkg",
          dirs: ["bricks/dup-pkg", "packages/dup-pkg"],
        },
      ]);

      const cli = spawnSync(process.execPath, [scriptPath, fixtureRoot], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(cli.status).toBe(1);
      expect(cli.stderr).toContain("@poc/dup-pkg");
      expect(cli.stderr).toContain("packages/dup-pkg");
      expect(cli.stderr).toContain("bricks/dup-pkg");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
