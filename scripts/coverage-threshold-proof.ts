#!/usr/bin/env node
// Proof that the coverage thresholds in vitest.coverage.config.ts fail a run (strictness H7). It runs vitest with that
// config on the metered-usage tests only (a few seconds) three times, and never edits the committed thresholds:
//   1. control: coverage measured on metered-usage's src only, committed thresholds -> must pass, so the two failures
//      below are caused by the thresholds and not by a broken setup;
//   2. a global threshold of 100 % lines, set on the command line, above the measured value -> must fail with vitest's
//      threshold message;
//   3. the committed per-brick thresholds, with only metered-usage's tests run, so the other bricks fall far below
//      theirs -> must fail with the per-glob threshold message.
// Every run has CI set, so autoUpdate is off and no run can rewrite the config. Reports go to a temporary directory,
// not coverage/. Exit code 0 means all three behaved as expected.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The environment without the variables that make vitest write a GitHub Actions job summary. */
function withoutGithubSummary(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { GITHUB_ACTIONS: _actions, GITHUB_STEP_SUMMARY: _summary, ...rest } = env;
  return rest;
}

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const vitestBin = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const reportsDir = mkdtempSync(join(tmpdir(), "px-coverage-proof-"));

type Case = { name: string; extraArgs: string[]; expectFail: boolean; expectMessage?: RegExp };

const cases: Case[] = [
  {
    name: "control: committed thresholds, metered-usage measured alone",
    extraArgs: ["--coverage.include=bricks/metered-usage/src/**/*.ts"],
    expectFail: false,
  },
  {
    name: "global lines threshold of 100 % (above the measured value)",
    extraArgs: ["--coverage.include=bricks/metered-usage/src/**/*.ts", "--coverage.thresholds.lines=100"],
    expectFail: true,
    expectMessage: /ERROR: Coverage for lines \([\d.]+%\) does not meet global threshold \(100%\)/,
  },
  {
    name: "committed per-brick thresholds with the other bricks' tests left out",
    extraArgs: [],
    expectFail: true,
    expectMessage: /ERROR: Coverage for \w+ \([\d.]+%\) does not meet "bricks\/core-auth\/src\/\*\*" threshold \(\d+%\)/,
  },
];

let failures = 0;
try {
  for (const c of cases) {
    const args = [
      vitestBin,
      "run",
      "-c",
      "vitest.coverage.config.ts",
      `--coverage.reportsDirectory=${reportsDir}`,
      ...c.extraArgs,
      "bricks/metered-usage/test",
    ];
    const run = spawnSync(process.execPath, args, {
      cwd: repoRoot,
      encoding: "utf8",
      // GITHUB_ACTIONS / GITHUB_STEP_SUMMARY are dropped so these deliberate pass/fail runs do not add vitest's
      // github-actions job summaries to the CI step summary (only the real coverage table belongs there).
      env: { ...withoutGithubSummary(process.env), CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      timeout: 300_000,
      windowsHide: true,
    });
    const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    const failed = run.status !== 0;
    const messageOk = c.expectMessage === undefined || c.expectMessage.test(output);
    const ok = failed === c.expectFail && messageOk;
    console.log(`${ok ? "ok  " : "FAIL"} ${c.name} (exit ${run.status ?? run.signal})`);
    if (!ok) {
      failures++;
      if (failed !== c.expectFail) console.log(`     expected ${c.expectFail ? "a non-zero" : "a zero"} exit`);
      if (!messageOk) console.log(`     expected output matching ${String(c.expectMessage)}`);
      console.log(output.split("\n").slice(-40).join("\n"));
    }
  }
} finally {
  rmSync(reportsDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`coverage threshold proof: ${failures} case(s) did not behave as expected`);
  process.exit(1);
}
console.log("coverage threshold proof: thresholds pass when met and fail the run when not met");
