#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const vitestBin = resolve(repoRoot, "node_modules", "vitest", "vitest.mjs");

function parseArgs(args: string[]) {
  let runs = 10;
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--runs") {
      const next = args[++i];
      if (next) runs = parseInt(next, 10);
    } else if (arg.startsWith("--runs=")) {
      const parts = arg.split("=");
      if (parts[1]) runs = parseInt(parts[1], 10);
    } else if (!arg.startsWith("--")) {
      files.push(arg);
    }
  }

  return { runs: isNaN(runs) || runs <= 0 ? 10 : runs, files };
}

function stripAnsi(str: string): string {
  return stripVTControlCharacters(str);
}

function extractFailures(output: string): string[] {
  const failures: string[] = [];
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const clean = stripAnsi(line).trim();
    if (clean.startsWith("FAIL") || clean.startsWith("×") || clean.startsWith("✕")) {
      failures.push(clean.replace(/^(\s*FAIL\s+|[×✕]\s+)/, "").trim());
    }
  }
  return [...new Set(failures)];
}

export function runStress(runs: number, files: string[]) {
  console.log(`[stress:dom] Running ${runs} iteration(s) on ${files.length > 0 ? files.join(", ") : "full dom suite"}...`);

  let passedRuns = 0;
  let failedRuns = 0;
  const failureDetails: Array<{ run: number; failures: string[] }> = [];

  const vitestArgs = ["run", "--config", "vitest.dom.config.ts", ...files];

  for (let i = 1; i <= runs; i++) {
    const start = Date.now();
    const result = spawnSync(process.execPath, [vitestBin, ...vitestArgs], {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
    });
    const duration = ((Date.now() - start) / 1000).toFixed(2);

    const isSuccess = result.status === 0;
    if (isSuccess) {
      passedRuns++;
      console.log(`Run ${i}/${runs}: PASS (${duration}s)`);
    } else {
      failedRuns++;
      const fullOutput = (result.stdout || "") + "\n" + (result.stderr || "");
      const failures = extractFailures(fullOutput);
      const failureSummary = failures.length > 0 ? failures.join("; ") : "non-zero exit code";
      failureDetails.push({ run: i, failures: failures.length > 0 ? failures : ["non-zero exit code"] });
      console.log(`Run ${i}/${runs}: FAIL (${duration}s) - ${failureSummary}`);
      const cleanOutput = stripAnsi(fullOutput);
      const errorMatch =
        cleanOutput.match(/(TestingLibraryElementError:[^\r\n]+)/) ||
        cleanOutput.match(/(AssertionError:[^\r\n]+)/) ||
        cleanOutput.match(/(Error:[^\r\n]+)/);
      if (errorMatch) {
        console.log(`    Detail: ${errorMatch[1]}`);
      }
    }
  }

  console.log(`\n[stress:dom] Summary: ${passedRuns}/${runs} passed, ${failedRuns} failed.`);
  if (failureDetails.length > 0) {
    console.log(`[stress:dom] Failure Breakdown:`);
    for (const f of failureDetails) {
      console.log(`  Run ${f.run}: ${f.failures.join(", ")}`);
    }
  }

  return failedRuns === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { runs, files } = parseArgs(process.argv.slice(2));
  const exitCode = runStress(runs, files);
  process.exit(exitCode);
}
