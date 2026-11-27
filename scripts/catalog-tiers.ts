import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IntegrationManifestSchema, ManifestSchema } from "../packages/assembler/src/schemas.ts";
import type { BrickMaturity } from "../packages/assembler/src/schemas.ts";
import { checkAllBricks, checkIntegrationConformance, formatViolationLine, loadTierEvidenceMap } from "./check-manifests.ts";
import { deriveTier, loadTierPolicy } from "./lib/derive-tier.ts";
import { getEvidenceDir, getGitSha, stampEvidence, writeEvidence } from "./lib/evidence-stamp.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface BrickTierEvidence {
  gitSha: string;
  runAt: string;
  assertionCount: number;
  liveVerifiedAt?: string | null;
  fidelity?: any | null;
}

export interface BrickTierRow {
  id: string;
  tier: BrickMaturity;
  declaredTier: BrickMaturity;
  derivedTier: BrickMaturity;
  blockers: string[];
  reason: string | null;
  behaviourTest: string | null;
  evidence: BrickTierEvidence;
}

export interface BrickTiersReport {
  generatedBy: string;
  counts: {
    total: number;
    production: number;
    beta: number;
    experimental: number;
  };
  presets: Record<string, string[]>;
  bricks: BrickTierRow[];
  integrations?: BrickTierRow[];
}

export function loadIntegrationTiers(rootDir = ROOT): BrickTierRow[] {
  const integrationsDir = join(rootDir, "integrations");
  if (!existsSync(integrationsDir)) return [];
  const apps = readdirSync(integrationsDir)
    .filter((name) => {
      const full = join(integrationsDir, name);
      return statSync(full).isDirectory() && existsSync(join(full, "integration.json"));
    })
    .sort();

  const tierEvidenceMap = loadTierEvidenceMap(rootDir);
  const policy = loadTierPolicy(existsSync(join(rootDir, "scripts", "tier-policy.json")) ? join(rootDir, "scripts", "tier-policy.json") : undefined);
  const headSha = getGitSha(rootDir);
  const now = new Date().toISOString();

  const evidenceDir = process.env.POC_EVIDENCE_DIR
    ? resolve(process.env.POC_EVIDENCE_DIR)
    : // Committed evidence unless a run directory is named explicitly (evidence:refresh sets POC_EVIDENCE_DIR).
      // A leftover .evidence-run/ from an earlier step is never picked up implicitly.
      join(rootDir, "evidence");

  const rows: BrickTierRow[] = [];
  for (const app of apps) {
    const integrationDir = join(integrationsDir, app);
    const manifestPath = join(integrationDir, "integration.json");
    const manifest = IntegrationManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));

    const canaryPath = join(evidenceDir, "live-canary", `${manifest.app}.json`);
    let liveCanary: any = null;
    if (existsSync(canaryPath)) {
      try {
        liveCanary = JSON.parse(readFileSync(canaryPath, "utf8"));
      } catch {}
    }

    const reportPath = join(integrationDir, "import-report.json");
    let fidelityReport: any = null;
    if (existsSync(reportPath)) {
      try {
        const report = JSON.parse(readFileSync(reportPath, "utf8"));
        const lossEntries = (report.entries ?? []).filter(
          (e: any) => e.status === "approximated" || e.status === "unsupported" || (typeof e.code === "string" && e.code.endsWith("_LOSS")),
        );
        const curationPath = existsSync(join(integrationDir, "curation.config.json"))
          ? join(integrationDir, "curation.config.json")
          : join(integrationDir, "curation.json");
        let unackCount = 0;
        if (lossEntries.length > 0) {
          const acks = new Set<string>();
          if (existsSync(curationPath)) {
            try {
              const curation = JSON.parse(readFileSync(curationPath, "utf8"));
              const rawAcks = Array.isArray(curation.acknowledge)
                ? curation.acknowledge
                : Array.isArray(curation.acknowledgements)
                  ? curation.acknowledgements
                  : [];
              for (const ack of rawAcks) {
                acks.add(`${ack.op ?? "<doc>"}:${ack.code}`);
                if (ack.pointer) {
                  acks.add(`${ack.op ?? "<doc>"}:${ack.code}:${ack.pointer}`);
                }
              }
            } catch {}
          }
          unackCount = lossEntries.filter(
            (e: any) => !acks.has(`${e.op ?? "<doc>"}:${e.code}`) && !acks.has(`${e.op ?? "<doc>"}:${e.code}:${e.pointer ?? ""}`),
          ).length;
        }
        fidelityReport = {
          reportPresent: true,
          unacknowledgedLosses: unackCount,
          ...report,
        };
      } catch {}
    }

    const tierEvidence = tierEvidenceMap.get(app);
    const derived = deriveTier(manifest, tierEvidence, fidelityReport, liveCanary, policy);
    const declaredTier = manifest.ui.maturity as BrickMaturity;
    const derivedTier = derived.tier as BrickMaturity;

    rows.push({
      id: manifest.app,
      tier: declaredTier,
      declaredTier,
      derivedTier,
      blockers: derived.blockers,
      reason: manifest.ui.maturityReason ?? null,
      behaviourTest: manifest.ui.behaviourTest ?? null,
      evidence: {
        gitSha: headSha,
        runAt: now,
        assertionCount: tierEvidence?.assertionCount ?? 0,
        liveVerifiedAt: liveCanary?.verifiedAt ?? null,
        fidelity: manifest.fidelity ?? null,
      },
    });
  }
  return rows;
}

export function loadBrickTiers(rootDir = ROOT): BrickTierRow[] {
  const bricksDir = join(rootDir, "bricks");
  const ids = readdirSync(bricksDir)
    .filter((name) => {
      const full = join(bricksDir, name);
      return statSync(full).isDirectory() && existsSync(join(full, "brick.manifest.json"));
    })
    .sort();

  const tierEvidenceMap = loadTierEvidenceMap(rootDir);
  const policy = loadTierPolicy(existsSync(join(rootDir, "scripts", "tier-policy.json")) ? join(rootDir, "scripts", "tier-policy.json") : undefined);
  const headSha = getGitSha(rootDir);
  const now = new Date().toISOString();

  const rows: BrickTierRow[] = [];
  for (const id of ids) {
    const manifestPath = join(bricksDir, id, "brick.manifest.json");
    const manifest = ManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    if (!manifest.ui?.maturity) {
      throw new Error(`${id}: missing ui.maturity`);
    }
    const tierEvidence = tierEvidenceMap.get(id);
    const derived = deriveTier(manifest, tierEvidence, null, null, policy);
    const declaredTier = manifest.ui.maturity as BrickMaturity;
    const derivedTier = derived.tier as BrickMaturity;

    rows.push({
      id,
      tier: declaredTier,
      declaredTier,
      derivedTier,
      blockers: derived.blockers,
      reason: manifest.ui.maturityReason ?? null,
      behaviourTest: manifest.ui.behaviourTest ? `bricks/${id}/${manifest.ui.behaviourTest}` : null,
      evidence: {
        gitSha: headSha,
        runAt: now,
        assertionCount: tierEvidence?.assertionCount ?? 0,
      },
    });
  }
  return rows;
}

export function verifyPresetTiers(rows: BrickTierRow[], rootDir = ROOT): Record<string, string[]> {
  const tierById = new Map(rows.map((r) => [r.id, r.tier]));
  const presetNames = ["ai-credits-saas", "b2b-workspace-app", "marketplace", "stripe-discord-ops"];
  const presets: Record<string, string[]> = {};

  for (const name of presetNames) {
    const presetPath = join(rootDir, "presets", `${name}.blueprint.json`);
    const blueprint = JSON.parse(readFileSync(presetPath, "utf8")) as {
      bricks: Array<string | { id: string }>;
    };
    const brickIds = blueprint.bricks.map((b) => (typeof b === "string" ? b : b.id));
    for (const id of brickIds) {
      const tier = tierById.get(id);
      if (tier !== "production" && tier !== "beta") {
        throw new Error(`Preset "${name}" includes non-production/beta brick "${id}" (tier: ${tier ?? "unknown"})`);
      }
    }
    presets[name] = brickIds;
  }

  return presets;
}

export function printTierTable(rows: BrickTierRow[]): void {
  const header = ["id".padEnd(22), "declared".padEnd(12), "derived".padEnd(12), "blockers".padEnd(32), "behaviourTest".padEnd(48), "reason"].join(" | ");
  console.log(header);
  console.log("-".repeat(150));
  for (const row of rows) {
    console.log(
      [
        row.id.padEnd(22),
        row.declaredTier.padEnd(12),
        row.derivedTier.padEnd(12),
        (row.blockers.join(",") || "-").padEnd(32),
        (row.behaviourTest ?? "-").padEnd(48),
        row.reason ?? "-",
      ].join(" | "),
    );
  }
}

async function main(): Promise<void> {
  const skipTests = process.argv.includes("--no-run");

  // First collect behaviour tests from manifests
  const rawBrickRows = loadBrickTiers(ROOT);
  const rawIntegrationRows = loadIntegrationTiers(ROOT);

  const conformanceTestFiles: string[] = [];
  const bricksDir = join(ROOT, "bricks");
  if (existsSync(bricksDir)) {
    for (const b of readdirSync(bricksDir)) {
      const cf = join("bricks", b, "test", "conformance.workerd.test.ts");
      if (existsSync(join(ROOT, cf))) {
        conformanceTestFiles.push(cf.replace(/\\/g, "/"));
      }
    }
  }

  const testFiles = [
    ...new Set([
      ...rawBrickRows.filter((r) => (r.declaredTier === "production" || r.declaredTier === "beta") && r.behaviourTest !== null).map((r) => r.behaviourTest!),
      ...rawIntegrationRows
        .filter((r) => (r.declaredTier === "production" || r.declaredTier === "beta") && r.behaviourTest !== null)
        .map((r) => r.behaviourTest!),
      ...conformanceTestFiles,
    ]),
  ];

  if (!skipTests) {
    const vitestCli = join(ROOT, "node_modules", "vitest", "vitest.mjs");
    const run = spawnSync(
      process.execPath,
      [vitestCli, "run", "-c", "vitest.workers.config.ts", "--reporter=default", "--reporter=./reporters/evidence-reporter.ts", ...testFiles],
      { cwd: ROOT, stdio: "inherit" },
    );
    if (run.status !== 0) {
      console.error("FAIL: One or more brick behaviour tests failed.");
      process.exit(run.status ?? 1);
    }
  }

  // 1. Conformance check (validates ui.maturity, ui.maturityReason, deriveTier)
  const violations = [...checkAllBricks(join(ROOT, "bricks"))];
  const integrationsDir = join(ROOT, "integrations");
  if (existsSync(integrationsDir)) {
    for (const app of readdirSync(integrationsDir)) {
      const appDir = join(integrationsDir, app);
      if (statSync(appDir).isDirectory() && existsSync(join(appDir, "integration.json"))) {
        violations.push(...checkIntegrationConformance(appDir, app));
      }
    }
  }

  if (violations.length > 0) {
    console.error("Manifest conformance violations found:");
    for (const v of violations) {
      console.error(`  ${formatViolationLine(v)}`);
    }
    process.exit(1);
  }

  // 2. Load fresh rows with derived tiers and evidence
  const rows = loadBrickTiers(ROOT);
  const integrationRows = loadIntegrationTiers(ROOT);
  if (rows.length < 40) {
    console.error(`Expected at least 40 bricks, found ${rows.length}`);
    process.exit(1);
  }
  const presets = verifyPresetTiers(rows, ROOT);

  // 3. Print the tables
  console.log(`\n=== Catalog Brick Maturity Tiers (${rows.length} Bricks) ===`);
  printTierTable(rows);

  if (integrationRows.length > 0) {
    console.log(`\n=== Curated Integration Pack v1 Tiers (${integrationRows.length} Integrations) ===`);
    printTierTable(integrationRows);
  }

  const counts = {
    total: rows.length,
    production: rows.filter((r) => r.tier === "production").length,
    beta: rows.filter((r) => r.tier === "beta").length,
    experimental: rows.filter((r) => r.tier === "experimental").length,
  };
  console.log(
    `\nSummary: ${counts.total} bricks (${counts.production} production, ${counts.beta} beta, ${counts.experimental} experimental), ${integrationRows.length} integrations`,
  );

  // 4. Write evidence/brick-tiers.json
  const report: BrickTiersReport = {
    generatedBy: "node scripts/catalog-tiers.ts",
    counts,
    presets,
    bricks: rows,
    integrations: integrationRows,
  };
  const evidenceDir = getEvidenceDir();
  mkdirSync(evidenceDir, { recursive: true });
  const outPath = join(evidenceDir, "brick-tiers.json");
  const prov = stampEvidence("scripts/catalog-tiers.ts", "measured");
  writeEvidence(outPath, report, prov);
  console.log(`Wrote ${outPath}`);

  // UC5.6: Copy freshly measured tier-evidence.json to evidenceDir so evidence/tier-evidence.json is updated
  const runTierEvidencePath = process.env.POC_EVIDENCE_DIR
    ? join(resolve(process.env.POC_EVIDENCE_DIR), "tier-evidence.json")
    : join(ROOT, ".evidence-run", "tier-evidence.json");
  const targetTierEvidencePath = join(evidenceDir, "tier-evidence.json");
  if (existsSync(runTierEvidencePath) && runTierEvidencePath !== targetTierEvidencePath) {
    copyFileSync(runTierEvidencePath, targetTierEvidencePath);
    console.log(`Wrote ${targetTierEvidencePath}`);
  }
}

if (import.meta.main) {
  await main();
}
