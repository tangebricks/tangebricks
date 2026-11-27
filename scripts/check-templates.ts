/**
 * Story 8.1 — Starter Templates Verification Gate (`pnpm studio:templates:check`).
 *
 * Verifies all 4 starter templates (`ai-credits-saas`, `b2b-workspace-app`,
 * `marketplace`, `stripe-discord-ops`):
 * 1. Every enabled brick is "production" or "beta" maturity, never "experimental" (which includes every
 *    quarantined brick). Owner decision 2026-11-24, replacing the production-only rule (Risk K1) after
 *    story 0.11 re-tiered bricks honestly; Studio shows each brick's tier badge in the template.
 * 2. Every template has pre-populated bricks, entities, and workflows with layout coordinates.
 * 3. Every template passes `computeReadiness` (with `stripe-discord-ops` surfacing
 *    only the expected unbound `sec_discord_bot` connection in `needs[]`, and becoming
 *    100% ready once `sec_discord_bot` is bound).
 * 4. Every template assembles deterministically (`buildHash` equal across two runs).
 * 5. Every template boots in `workerd` (`test/boot-presets.test.ts`).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble, hashFiles, sha256Hex } from "../packages/assembler/src/index.ts";
import { catalog } from "../packages/assembler/catalog.generated.ts";
import { checkGraphBudget, toyRegistry } from "../packages/sdk/src/index.ts";
import { buildCatalogNodeRegistry, computeReadiness, normalizeBlueprintState, toAssemblerBlueprint } from "../packages/blueprint/src/index.ts";
import type { BlueprintState } from "../packages/blueprint/src/index.ts";
import { OUT_DIR, writeProject } from "../test/support/emitted.ts";
import { getBootBlueprints } from "../test/support/global-setup.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const STARTER_TEMPLATE_IDS = ["ai-credits-saas", "b2b-workspace-app", "marketplace", "stripe-discord-ops"] as const;

export type StarterTemplateId = (typeof STARTER_TEMPLATE_IDS)[number];

export interface TemplateVerificationRow {
  id: StarterTemplateId;
  bricksCount: number;
  entitiesCount: number;
  workflowsCount: number;
  allProductionMaturity: boolean;
  readinessOk: boolean;
  unboundNeeds: string[];
  deterministicAssemble: boolean;
  buildHash: string;
}

async function computeBuildHash(files: Record<string, string>): Promise<string> {
  const fileHashes = await hashFiles(files);
  return sha256Hex(JSON.stringify(fileHashes));
}

function coercePresetToBlueprintState(raw: Record<string, unknown>): BlueprintState {
  const bricks = (Array.isArray(raw.bricks) ? raw.bricks : []).map((b) =>
    typeof b === "string"
      ? { id: b, config: {} }
      : {
          id: String((b as { id: unknown }).id),
          config: (b as { config?: Record<string, string | number | boolean> }).config ?? {},
        },
  );
  const entities = (Array.isArray(raw.entities) ? raw.entities : []).map((e) => {
    const ent = e as { name: string; fields: Array<Record<string, unknown>> };
    return {
      name: ent.name,
      workspaceScoped: true as const,
      fields: ent.fields.map((f) => {
        if (f.type === "text") {
          return {
            ...f,
            required: Boolean(f.required ?? false),
            maxLength: typeof f.maxLength === "number" ? f.maxLength : 500,
          };
        }
        return {
          ...f,
          required: Boolean(f.required ?? false),
        };
      }),
    };
  });
  return normalizeBlueprintState({
    schemaVersion: 2,
    project: String(raw.project),
    identity: typeof raw.identity === "string" ? raw.identity : "stub",
    bricks,
    entities: entities as BlueprintState["entities"],
    workflows: (Array.isArray(raw.workflows) ? raw.workflows : []) as BlueprintState["workflows"],
    secretRefs: (Array.isArray(raw.secretRefs) ? raw.secretRefs : []) as BlueprintState["secretRefs"],
    metadata: (typeof raw.metadata === "object" && raw.metadata !== null ? raw.metadata : {}) as BlueprintState["metadata"],
  });
}

export async function verifyStarterTemplates(rootDir = ROOT): Promise<{
  ok: boolean;
  rows: TemplateVerificationRow[];
  errors: string[];
}> {
  const errors: string[] = [];
  const rows: TemplateVerificationRow[] = [];

  const presetsDataPath = join(rootDir, "apps", "studio-web", "src", "presets-data.json");
  const presetsData = existsSync(presetsDataPath) ? (JSON.parse(readFileSync(presetsDataPath, "utf8")) as Record<string, unknown>) : {};

  for (const id of STARTER_TEMPLATE_IDS) {
    const presetPath = join(rootDir, "presets", `${id}.blueprint.json`);
    if (!existsSync(presetPath)) {
      errors.push(`Missing starter template file: presets/${id}.blueprint.json`);
      continue;
    }
    if (!(id in presetsData)) {
      errors.push(`Missing starter template "${id}" in apps/studio-web/src/presets-data.json`);
    }

    const raw = JSON.parse(readFileSync(presetPath, "utf8")) as Record<string, unknown>;
    const state = coercePresetToBlueprintState(raw);

    if (state.bricks.length === 0) {
      errors.push(`${id}: must enable at least 1 brick`);
    }
    if (state.entities.length === 0) {
      errors.push(`${id}: must declare at least 1 entity`);
    }
    if (state.workflows.length === 0) {
      errors.push(`${id}: must include at least 1 pre-wired workflow`);
    }

    // Verify layout coordinates exist for every workflow node
    for (const wf of state.workflows) {
      for (const node of wf.nodes) {
        const hasNodePos = node.position !== undefined && Number.isFinite(node.position.x) && Number.isFinite(node.position.y);
        const layoutPos = state.metadata?.layout?.[node.id];
        const hasMetaLayout = layoutPos !== undefined && Number.isFinite(layoutPos.x) && Number.isFinite(layoutPos.y);
        if (!hasNodePos && !hasMetaLayout) {
          errors.push(`${id}: workflow "${wf.id}" node "${node.id}" is missing layout coordinates`);
        }
      }
    }

    // Verify every enabled brick is production or beta maturity: never experimental or quarantined.
    let allProductionMaturity = true;
    for (const brick of state.bricks) {
      const catEntry = catalog.bricks[brick.id];
      const maturity = catEntry?.manifest.ui?.maturity;
      if (maturity !== "production" && maturity !== "beta") {
        allProductionMaturity = false;
        errors.push(`${id}: brick "${brick.id}" has maturity "${maturity ?? "unknown"}" (expected "production" or "beta")`);
      }
    }

    // Verify readiness
    const readiness = computeReadiness(state, catalog);
    let readinessOk = false;
    if (id === "stripe-discord-ops") {
      const onlyDiscordUnbound =
        readiness.needs.length === 1 && readiness.needs[0]?.code === "UNBOUND_CONNECTION" && readiness.needs[0]?.message.includes("sec_discord_bot");
      const boundState = normalizeBlueprintState({
        ...state,
        secretRefs: [
          ...state.secretRefs,
          {
            ref: "sec_discord_bot",
            targetKind: "connection",
            targetId: "n_discord_notify",
            secretName: "DISCORD_BOT_TOKEN",
          },
        ],
      });
      const boundReadiness = computeReadiness(boundState, catalog);
      readinessOk = onlyDiscordUnbound && boundReadiness.ready;
      if (!readinessOk) {
        errors.push(`${id}: expected only UNBOUND_CONNECTION for sec_discord_bot in readiness.needs (got: ${JSON.stringify(readiness.needs)})`);
      }
    } else {
      readinessOk = readiness.ready && readiness.needs.length === 0;
      if (!readinessOk) {
        errors.push(`${id}: expected readiness.ready === true (needs: ${JSON.stringify(readiness.needs)})`);
      }
    }

    // Verify deterministic assembly
    const assemblerBp = toAssemblerBlueprint(state);
    const first = assemble(assemblerBp, catalog);
    const second = assemble(assemblerBp, catalog);
    if (!first.ok || !second.ok) {
      const asmErrors = !first.ok ? first.errors : !second.ok ? second.errors : [];
      errors.push(`${id}: assemble() failed: ${asmErrors.join("; ")}`);
      continue;
    }

    // Verify static budget check on paid plan (UC7.4 AC2)
    const nodeRegistry = buildCatalogNodeRegistry(catalog, toyRegistry);
    for (const wf of state.workflows) {
      const budgetIssues = checkGraphBudget({ nodes: wf.nodes, edges: wf.edges }, nodeRegistry, "paid");
      const errorsFound = budgetIssues.filter((i) => i.severity === "error");
      if (errorsFound.length > 0) {
        errors.push(`${id}: workflow "${wf.id}" failed budget check on paid: ${errorsFound.map((i) => `${i.code}: ${i.message}`).join("; ")}`);
      }
    }

    const hash1 = await computeBuildHash(first.files);
    const hash2 = await computeBuildHash(second.files);
    const deterministicAssemble = hash1 === hash2;
    if (!deterministicAssemble) {
      errors.push(`${id}: non-deterministic buildHash (${hash1} !== ${hash2})`);
    }

    rows.push({
      id,
      bricksCount: state.bricks.length,
      entitiesCount: state.entities.length,
      workflowsCount: state.workflows.length,
      allProductionMaturity,
      readinessOk,
      unboundNeeds: readiness.needs.map((n) => `${n.code}:${n.path}`),
      deterministicAssemble,
      buildHash: hash1,
    });
  }

  return {
    ok: errors.length === 0 && rows.length === STARTER_TEMPLATE_IDS.length,
    rows,
    errors,
  };
}

async function main(): Promise<void> {
  const skipWorkerd = process.argv.includes("--no-workerd");
  const result = await verifyStarterTemplates(ROOT);

  if (!result.ok) {
    console.error("[studio:templates:check] Template verification failed:");
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  // Emit all boot blueprints into out/<project> so workerd boot tests have fresh files
  for (const blueprint of getBootBlueprints()) {
    const assembled = assemble(blueprint, catalog);
    if (!assembled.ok) {
      console.error(`FAIL ${blueprint.project}: ${assembled.errors.join("; ")}`);
      process.exit(1);
    }
    await writeProject(join(OUT_DIR, blueprint.project), assembled.files);
  }

  let workerdPassed = true;
  if (!skipWorkerd) {
    const vitestCli = join(ROOT, "node_modules", "vitest", "vitest.mjs");
    const run = spawnSync(process.execPath, [vitestCli, "run", "-c", "vitest.workers.config.ts", "test/boot-presets.test.ts"], { cwd: ROOT, stdio: "inherit" });
    workerdPassed = run.status === 0;
  }

  console.log("\n=== Starter Templates Verification Summary (Story 8.1) ===");
  console.log(
    [
      "Template".padEnd(20),
      "Bricks".padStart(6),
      "Entities".padStart(8),
      "Workflows".padStart(9),
      "Maturity".padEnd(12),
      "Readiness".padEnd(10),
      "BuildHash".padEnd(14),
      "Workerd".padEnd(8),
    ].join(" | "),
  );
  console.log("-".repeat(106));
  for (const row of result.rows) {
    console.log(
      [
        row.id.padEnd(20),
        String(row.bricksCount).padStart(6),
        String(row.entitiesCount).padStart(8),
        String(row.workflowsCount).padStart(9),
        (row.allProductionMaturity ? "beta+" : "FAIL").padEnd(12),
        (row.readinessOk ? "PASS" : "FAIL").padEnd(10),
        row.buildHash.slice(0, 12).padEnd(14),
        (skipWorkerd ? "SKIP" : workerdPassed ? "PASS" : "FAIL").padEnd(8),
      ].join(" | "),
    );
  }

  if (!workerdPassed) {
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("check-templates.ts")) {
  await main();
}
