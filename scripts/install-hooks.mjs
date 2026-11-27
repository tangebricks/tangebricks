#!/usr/bin/env node
/**
 * scripts/install-hooks.mjs
 *
 * The `prepare` script: installs the lefthook git hooks (lefthook.yml) after `pnpm install`. It does nothing in CI
 * (CI set to anything but "", "0" or "false"), outside a git work tree (e.g. an extracted tarball), or when lefthook is missing, and it never fails the
 * install: any problem is reported in one line and the script exits 0.
 *
 * Plain JavaScript, not TypeScript, so it runs on any Node that can run the install.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

function note(message) {
  console.log(`install-hooks: ${message}`);
}

// CI=true, CI=1 or any other value counts as CI; unset, empty, "0" and "false" do not (as lefthook's postinstall).
function isCI(value) {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function run() {
  if (isCI(process.env.CI)) return note("CI is set; git hooks not installed.");
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (inside.error || inside.status !== 0 || inside.stdout.trim() !== "true") {
    return note("not inside a git work tree; git hooks not installed.");
  }
  let bin;
  try {
    bin = createRequire(import.meta.url).resolve("lefthook/bin/index.js");
  } catch {
    return note("lefthook is not installed; git hooks not installed.");
  }
  const install = spawnSync(process.execPath, [bin, "install"], { encoding: "utf8" });
  if (install.error || install.status !== 0) {
    const detail = (install.error?.message ?? `${install.stderr}${install.stdout}`).trim().split(/\r?\n/)[0];
    return note(`lefthook install failed (${detail || `exit ${install.status}`}); git hooks not installed.`);
  }
  note("git hooks installed (lefthook.yml).");
}

try {
  run();
} catch (err) {
  note(`skipped (${err instanceof Error ? err.message : String(err)}).`);
}
process.exit(0);
