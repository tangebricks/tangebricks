import { afterEach, describe, expect, it } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const vitestBin = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const fixtureTest = join(repoRoot, "scripts", "test", "fixtures", "clean-tree-attach.node.test.ts");
const refreshScript = join(repoRoot, "scripts", "refresh-evidence.ts");
const runDir = join(repoRoot, ".evidence-run");

describe("UC0.7 clean tree evidence separation and refresh", () => {
  afterEach(() => {
    // If running vitest in Red state modified tracked evidence/, revert the change so tree stays clean
    try {
      const status = execSync("git status --porcelain evidence/", { cwd: repoRoot, encoding: "utf8" }).trim();
      if (status.length > 0) {
        execSync("git checkout -- evidence/", { cwd: repoRoot, stdio: "ignore" });
      }
    } catch {}
    // Clean up .evidence-run if present
    if (existsSync(runDir)) {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("running vitest on test attaching evidence leaves tracked evidence/ untouched and writes to .evidence-run/", () => {
    // Ensure initial evidence/ status is clean
    const preStatus = execSync("git status --porcelain evidence/", { cwd: repoRoot, encoding: "utf8" }).trim();
    expect(preStatus).toBe("");

    const res = spawnSync(
      process.execPath,
      [vitestBin, "run", fixtureTest, "--config", "vitest.config.ts"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(res.status).toBe(0);

    // Tracked evidence/ directory must have ZERO changes
    const postStatus = execSync("git status --porcelain evidence/", { cwd: repoRoot, encoding: "utf8" }).trim();
    expect(postStatus).toBe("");

    // Output must land in untracked .evidence-run/
    expect(existsSync(join(runDir, "h5-control.json")), ".evidence-run/h5-control.json must exist").toBe(true);
    expect(existsSync(join(runDir, "raw-results.json")), ".evidence-run/raw-results.json must exist").toBe(true);
  });

  it("POC_EVIDENCE_DIR override redirects reporter output to specified directory", () => {
    const customDir = mkdtempSync(join(tmpdir(), "poc-evidence-override-"));
    try {
      const res = spawnSync(
        process.execPath,
        [vitestBin, "run", fixtureTest, "--config", "vitest.config.ts"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: { ...process.env, POC_EVIDENCE_DIR: customDir },
        },
      );
      expect(res.status).toBe(0);
      expect(existsSync(join(customDir, "h5-control.json"))).toBe(true);
      expect(existsSync(join(customDir, "raw-results.json"))).toBe(true);
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });

  it("evidence:refresh refuses to run on a dirty tree with EVIDENCE_REFRESH_DIRTY_TREE", () => {
    expect(existsSync(refreshScript), "scripts/refresh-evidence.ts must exist").toBe(true);

    const dirtyMarker = join(repoRoot, "dirty-marker-test.tmp");
    try {
      writeFileSync(dirtyMarker, "dirty-tree-marker", "utf8");
      // stage the file to make tree dirty in git status --porcelain
      execSync("git add dirty-marker-test.tmp", { cwd: repoRoot });

      const res = spawnSync(process.execPath, [refreshScript], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("EVIDENCE_REFRESH_DIRTY_TREE");
    } finally {
      try {
        execSync("git reset HEAD dirty-marker-test.tmp", { cwd: repoRoot, stdio: "ignore" });
        rmSync(dirtyMarker, { force: true });
      } catch {}
    }
  });
});
