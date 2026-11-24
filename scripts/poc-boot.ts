import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble, hashFiles, sha256Hex } from "../packages/assembler/src/index.ts";
import { catalog } from "../packages/assembler/catalog.generated.ts";
import { OUT_DIR, writeProject } from "../test/support/emitted.ts";
import { getBootBlueprints } from "../test/support/global-setup.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

interface PresetSummary {
  project: string;
  bricks: number;
  migrations: number;
  buildHash: string;
  deterministic: boolean;
}

async function computeBuildHash(files: Record<string, string>): Promise<string> {
  const fileHashes = await hashFiles(files);
  return sha256Hex(JSON.stringify(fileHashes));
}

async function main(): Promise<void> {
  const blueprints = getBootBlueprints();
  const summaries: PresetSummary[] = [];
  let failed = false;

  for (const blueprint of blueprints) {
    const first = assemble(blueprint, catalog);
    const second = assemble(blueprint, catalog);
    if (!first.ok || !second.ok) {
      const errors = !first.ok ? first.errors : !second.ok ? second.errors : [];
      console.error(`FAIL ${blueprint.project}: assemble() refused blueprint:\n  ${errors.join("\n  ")}`);
      failed = true;
      continue;
    }

    const hash1 = await computeBuildHash(first.files);
    const hash2 = await computeBuildHash(second.files);
    const deterministic = hash1 === hash2;
    if (!deterministic) {
      console.error(`FAIL ${blueprint.project}: non-deterministic buildHash (${hash1} !== ${hash2})`);
      failed = true;
    }

    await writeProject(join(OUT_DIR, blueprint.project), first.files);
    const migrations = Object.keys(first.files).filter((path) => path.startsWith("migrations/")).length;

    summaries.push({
      project: blueprint.project,
      bricks: first.order.length,
      migrations,
      buildHash: hash1.slice(0, 12),
      deterministic,
    });
  }

  if (failed) {
    process.exit(1);
  }

  const vitestCli = join(root, "node_modules", "vitest", "vitest.mjs");
  const run = spawnSync(
    process.execPath,
    [vitestCli, "run", "-c", "vitest.workers.config.ts", "test/boot-presets.test.ts"],
    { cwd: root, stdio: "inherit" },
  );

  const workerdPassed = run.status === 0;
  console.log("\n=== Multi-Brick Preset Boot Summary (workerd + D1) ===");
  console.log(
    [
      "Preset".padEnd(20),
      "Bricks".padStart(6),
      "Migrations".padStart(10),
      "BuildHash".padEnd(14),
      "Deterministic".padEnd(13),
      "Workerd Boot & Isolation",
    ].join(" | "),
  );
  console.log("-".repeat(96));
  for (const row of summaries) {
    console.log(
      [
        row.project.padEnd(20),
        String(row.bricks).padStart(6),
        String(row.migrations).padStart(10),
        row.buildHash.padEnd(14),
        (row.deterministic ? "PASS" : "FAIL").padEnd(13),
        workerdPassed ? "PASS" : "FAIL",
      ].join(" | "),
    );
  }

  if (!workerdPassed) {
    process.exit(run.status ?? 1);
  }
}

await main();
