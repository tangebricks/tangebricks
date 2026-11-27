#!/usr/bin/env node
/**
 * scripts/run-gitleaks-staged.ts
 *
 * The pre-commit secret scan (lefthook.yml): runs gitleaks over the staged changes with the repo's .gitleaks.toml
 * (.gitleaksignore is picked up from the repo root). The binary is GITLEAKS_BIN, else `gitleaks` on PATH. When neither
 * exists the scan is skipped with a one-line warning: contributors may not have gitleaks installed, and the gitleaks
 * job in .github/workflows/security.yml stays the real gate.
 *
 * gitleaks 8.19+ scans staged changes with `gitleaks git --staged`; older releases only have `protect --staged`.
 */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The scan arguments for a gitleaks version string such as "8.21.2" or "v8.18.4". */
export function gitleaksArgs(version: string): string[] {
  const m = /(\d+)\.(\d+)/.exec(version);
  const legacy = m !== null && (Number(m[1]) < 8 || (Number(m[1]) === 8 && Number(m[2]) < 19));
  const common = ["--staged", "--redact", "--no-banner", "-c", ".gitleaks.toml"];
  return legacy ? ["protect", ...common] : ["git", ...common, "."];
}

export function main(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): number {
  const bin = env.GITLEAKS_BIN || "gitleaks";
  const probe = spawnSync(bin, ["version"], { cwd, encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    console.warn(`gitleaks: not found (${bin}); skipping the staged secret scan. CI's gitleaks job still runs.`);
    return 0;
  }
  const scan = spawnSync(bin, gitleaksArgs(probe.stdout.trim()), { cwd, stdio: "inherit" });
  if (scan.error) {
    console.error(`gitleaks: ${scan.error.message}`);
    return 1;
  }
  return scan.status ?? 1;
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
  process.exit(main());
}
