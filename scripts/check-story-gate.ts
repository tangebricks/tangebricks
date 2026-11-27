#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLegacyStories, validateStoryGate, validateTaskFile } from "./lib/story-provenance.ts";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const bmadOutputDir = resolve(repoRoot, "_bmad-output");
const defaultTaskFilePath = resolve(repoRoot, "UPDATIONS-BY-CLAUDE-TASKS.md");

export function findStoryFiles(dir: string = bmadOutputDir): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  function traverse(current: string) {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        traverse(fullPath);
      } else if (entry.isFile()) {
        const norm = fullPath.replace(/\\/g, "/");
        const b = basename(norm);
        if (norm.includes("/tickets/") && b.startsWith("story-") && b.endsWith(".md") && !b.endsWith("-plan.md")) {
          results.push(fullPath);
        }
      }
    }
  }

  traverse(dir);
  return results.sort();
}

export function runStoryGate(options: { taskFilePath?: string } = {}): number {
  const storyFiles = findStoryFiles();
  const legacyMap = loadLegacyStories(resolve(repoRoot, "scripts/story-gate.legacy.json"));

  const ticketResult = validateStoryGate(storyFiles, { repoRoot, legacyMap });

  const taskFilePath = options.taskFilePath || defaultTaskFilePath;
  let taskResult: ReturnType<typeof validateTaskFile> | null = null;

  if (existsSync(taskFilePath)) {
    taskResult = validateTaskFile(taskFilePath, { repoRoot });
  } else {
    console.log(`[check-story-gate] Task file ${taskFilePath} absent; skipping task file validation.`);
  }

  const taskFailed = taskResult ? taskResult.failed : 0;
  const totalFailed = ticketResult.failed + taskFailed;

  if (ticketResult.failed > 0) {
    for (const r of ticketResult.results) {
      for (const err of r.errors) {
        console.error(err);
      }
    }
  }

  if (taskResult && taskResult.failed > 0) {
    for (const r of taskResult.results) {
      for (const err of r.errors) {
        console.error(err);
      }
    }
  }

  const taskSummary = taskResult ? `task file: ${taskResult.checked} checked, ${taskResult.failed} failed` : "task file: skipped (file absent)";

  if (totalFailed > 0) {
    console.error(
      `Story gate failed: ticket files: ${ticketResult.total} (${ticketResult.grandfathered} grandfathered, ${ticketResult.passed} passed, ${ticketResult.failed} failed) · ${taskSummary}`,
    );
    return 1;
  }

  console.log(
    `Story gate passed: ticket files: ${ticketResult.total} (${ticketResult.grandfathered} grandfathered, ${ticketResult.passed} passed) · ${taskSummary}`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  let taskFileArg: string | undefined = undefined;
  const idx = process.argv.indexOf("--task-file");
  if (idx !== -1 && idx + 1 < process.argv.length) {
    taskFileArg = resolve(process.argv[idx + 1]!);
  }
  const code = runStoryGate({ taskFilePath: taskFileArg });
  process.exit(code);
}
