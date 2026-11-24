#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAllCanaries, runAppCanary } from "./lib/live-canary.ts";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function main() {
  const args = process.argv.slice(2);
  let targetApp: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--app" && args[i + 1]) {
      targetApp = args[i + 1];
      i++;
    }
  }

  console.log("=== ProjectX Live Integration Canary ===");
  let hasFailure = false;

  if (targetApp) {
    console.log(`Running canary for single app: ${targetApp}`);
    const res = await runAppCanary(targetApp);
    console.log(`\nResult for ${res.app}: ${res.status.toUpperCase()} ${res.reason ? `(${res.reason})` : ""}`);
    if (res.status === "fail") {
      hasFailure = true;
    }
  } else {
    console.log("Running canaries for all registered integrations...");
    const results = await runAllCanaries();
    console.log("\n--- Canary Summary ---");
    console.log("App".padEnd(12) + "Status".padEnd(10) + "Operations".padEnd(12) + "Notes");
    console.log("-".repeat(50));

    for (const [app, res] of Object.entries(results)) {
      const opCount = `${res.operations.length} ops`;
      const note = res.reason ?? (res.verifiedAt ? `verified @ ${res.verifiedAt.slice(0, 19)}` : "");
      console.log(app.padEnd(12) + res.status.toUpperCase().padEnd(10) + opCount.padEnd(12) + note);
      if (res.status === "fail") {
        hasFailure = true;
      }
    }
  }

  if (hasFailure) {
    console.error("\n[live-canary] One or more integration canaries failed.");
    process.exit(1);
  } else {
    console.log("\n[live-canary] All canaries completed successfully (or skipped due to missing secrets).");
    process.exit(0);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`\n[live-canary] Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
