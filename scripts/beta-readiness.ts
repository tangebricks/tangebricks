/**
 * Story 8.4 & UC0.2 — Cohort-1 Design Partner Readiness & PRD §8 Beta Metrics (`pnpm beta:readiness`).
 *
 * Provisions design partners, computes PRD §8 beta readiness metrics:
 *   1. Median & P90 TTFD (<= 30 min target, including Connect Cloudflare duration)
 *   2. Connect Cloudflare drop-off rate & CP9 trigger (> 25% threshold)
 *   3. Partners using >= 1 CP10 integration in a deployed workflow (>= 3/5 target)
 *   4. Mean time to locate a failing node in Run Replay (<= 2 min target)
 *   5. Weekly active sessions at 4 weeks (>= 3/5 active target)
 * and writes evidence.
 *
 * Story UC0.2: Requires `--cohort <path>` (real cohort export from STUDIO_DB) or `--simulate`.
 * Rejects seeded partner IDs with BETA_READINESS_SEEDED_INPUT.
 * Missing cohort export without --simulate exits 1 with BETA_READINESS_NO_REAL_COHORT.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { getEvidenceDir, stampEvidence, writeEvidence } from "./lib/evidence-stamp.ts";
import type { D1Like, D1Result, D1Statement } from "../packages/sdk/src/index.ts";
import {
  DEFAULT_COHORT_1_PARTNERS,
  computeCohortBetaMetrics,
  provisionBetaCohortPartners,
} from "../apps/studio-api/src/beta-readiness.ts";
import type {
  BetaReadinessReport,
  CohortPartnerSeedInput,
} from "../apps/studio-api/src/beta-readiness.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function createInMemorySqliteD1(): D1Like {
  const sqlite = new DatabaseSync(":memory:");
  const makeStatement = (sql: string, boundValues: unknown[] = []): D1Statement => ({
    bind(...values: unknown[]): D1Statement {
      return makeStatement(sql, values);
    },
    async first<Row = Record<string, unknown>>(): Promise<Row | null> {
      const stmt = sqlite.prepare(sql);
      const row = stmt.get(...(boundValues as never[])) as Row | undefined;
      return row ?? null;
    },
    async run(): Promise<D1Result> {
      const stmt = sqlite.prepare(sql);
      const res = stmt.run(...(boundValues as never[]));
      return {
        results: [],
        success: true,
        meta: { changes: Number(res.changes ?? 0) },
      };
    },
    async all<Row = Record<string, unknown>>(): Promise<D1Result<Row>> {
      const stmt = sqlite.prepare(sql);
      const rows = stmt.all(...(boundValues as never[])) as Row[];
      return {
        results: rows,
        success: true,
        meta: { changes: rows.length },
      };
    },
  });

  return {
    prepare(sql: string): D1Statement {
      return makeStatement(sql);
    },
    async batch(statements: D1Statement[]): Promise<D1Result[]> {
      const out: D1Result[] = [];
      for (const s of statements) {
        out.push(await s.run());
      }
      return out;
    },
    async exec(sql: string): Promise<unknown> {
      sqlite.exec(sql);
      return { ok: true };
    },
  };
}

export function formatBetaReadinessSummary(report: BetaReadinessReport): string {
  const lines: string[] = [];
  lines.push("=== ProjectX Studio Cohort-1 Beta Readiness Report (Story 8.4) ===");
  lines.push(`Cohort ID                   : ${report.cohortId}`);
  lines.push(
    `Partner Composition (D1)    : ${report.composition.totalPartners} total (${report.composition.agencyCount} agency, ${report.composition.mcpFirstDevCount} mcp-first-dev, ${report.composition.soloFounderCount} solo-founder) -> ${report.composition.d1CompositionPassed ? "PASS" : "FAIL"}`,
  );
  lines.push(
    `1. Median TTFD              : ${report.ttfd.medianTtfdMinutes ?? "N/A"} min (P90: ${report.ttfd.p90TtfdMinutes ?? "N/A"} min, target <= ${report.ttfd.targetMinutes} min) -> ${report.ttfd.passed ? "PASS" : "FAIL"}`,
  );
  lines.push(
    `2. CF Wizard Drop-Off       : ${(report.connectCloudflare.dropOffRate * 100).toFixed(1)}% (${report.connectCloudflare.verifiedCount}/${report.connectCloudflare.wizardOpenedCount} verified, threshold <= 25.0%) -> cp9TriggerFired=${report.connectCloudflare.cp9TriggerFired}`,
  );
  lines.push(
    `3. CP10 Integration Use     : ${report.integrationAdoption.partnersWithIntegrationWorkflows}/${report.integrationAdoption.totalPartners} partners (${report.integrationAdoption.totalDeployedIntegrationWorkflows} workflows, target >= ${report.integrationAdoption.targetPartners}/5) -> ${report.integrationAdoption.passed ? "PASS" : "FAIL"}`,
  );
  lines.push(
    `4. Failing Node Locate Time : ${report.failingNodeLocalization.meanTimeToLocateSec ?? "N/A"}s / ${report.failingNodeLocalization.meanTimeToLocateMinutes ?? "N/A"} min (target <= ${report.failingNodeLocalization.targetMinutes} min) -> ${report.failingNodeLocalization.passed ? "PASS" : "FAIL"}`,
  );
  lines.push(
    `5. Weekly Active @ 4 Weeks  : ${report.weeklyActiveRetention.activePartnersW4}/${report.weeklyActiveRetention.totalPartners} active partners (target >= ${report.weeklyActiveRetention.targetActivePartners}/5) -> ${report.weeklyActiveRetention.passed ? "PASS" : "FAIL"}`,
  );
  lines.push(`Overall Readiness Verdict   : ${report.overallPassed ? "READY FOR COHORT 1" : "NOT READY"}`);
  lines.push("");
  lines.push(
    [
      "Partner Slug".padEnd(24),
      "Type".padEnd(14),
      "TTFD (m)".padStart(9),
      "CF Verified".padStart(11),
      "CP10 WFs".padStart(9),
      "Locate (s)".padStart(10),
      "W4 Sessions".padStart(11),
    ].join(" | "),
  );
  lines.push("-".repeat(106));
  for (const p of report.partners) {
    lines.push(
      [
        p.orgSlug.padEnd(24),
        p.partnerType.padEnd(14),
        (p.ttfdMinutes !== null ? p.ttfdMinutes.toFixed(1) : "N/A").padStart(9),
        (p.connectCfVerified ? "yes" : "no").padStart(11),
        String(p.deployedIntegrationWorkflows).padStart(9),
        (p.meanTimeToLocateFailingNodeSec !== null
          ? `${p.meanTimeToLocateFailingNodeSec}s`
          : "N/A"
        ).padStart(10),
        String(p.weeklyActiveSessionsW4).padStart(11),
      ].join(" | "),
    );
  }
  return lines.join("\n");
}

export interface BetaReadinessOptions {
  cohortPath?: string | null;
  simulate?: boolean;
}

export async function runBetaReadiness(options: BetaReadinessOptions = {}): Promise<void> {
  const simulate = options.simulate ?? false;
  const cohortPath = options.cohortPath ?? null;

  if (!simulate && !cohortPath) {
    console.error(
      "BETA_READINESS_NO_REAL_COHORT: Real partner cohort export required via --cohort <path> (or use --simulate for testing).",
    );
    process.exit(1);
  }

  let partnersToProvision: CohortPartnerSeedInput[] = [];
  let cohortId = "cohort-1";
  let inputKind: "measured" | "simulated" = "measured";

  const evidenceDir = getEvidenceDir();

  if (simulate) {
    inputKind = "simulated";
    partnersToProvision = [...DEFAULT_COHORT_1_PARTNERS];
  } else if (cohortPath) {
    inputKind = "measured";
    const resolvedPath = resolve(cohortPath);
    if (!existsSync(resolvedPath)) {
      console.error(`BETA_READINESS_COHORT_NOT_FOUND: Cohort file does not exist: ${resolvedPath}`);
      process.exit(1);
    }

    let parsedData: unknown;
    try {
      parsedData = JSON.parse(readFileSync(resolvedPath, "utf8"));
    } catch (err: any) {
      console.error(`BETA_READINESS_INVALID_JSON: Failed to parse cohort JSON: ${err.message}`);
      process.exit(1);
    }

    let rawList: unknown[] = [];
    if (Array.isArray(parsedData)) {
      rawList = parsedData;
    } else if (
      parsedData &&
      typeof parsedData === "object" &&
      Array.isArray((parsedData as { partners: unknown[] }).partners)
    ) {
      const obj = parsedData as { cohortId?: string; partners: unknown[] };
      rawList = obj.partners;
      if (obj.cohortId) cohortId = obj.cohortId;
    } else {
      console.error("BETA_READINESS_INVALID_COHORT_FORMAT: Expected an array or { partners: [...] } in cohort JSON.");
      process.exit(1);
    }

    const seededOrgIds = new Set(
      DEFAULT_COHORT_1_PARTNERS.map((p) => p.orgId).filter(Boolean),
    );
    const seededSlugs = new Set(
      DEFAULT_COHORT_1_PARTNERS.map((p) => p.orgSlug).filter(Boolean),
    );
    const seededEmails = new Set(
      DEFAULT_COHORT_1_PARTNERS.map((p) => p.ownerEmail).filter(Boolean),
    );

    const hasSeeded = rawList.some((item: any) => {
      if (!item || typeof item !== "object") return false;
      return (
        (item.orgId && seededOrgIds.has(item.orgId)) ||
        (item.orgSlug && seededSlugs.has(item.orgSlug)) ||
        (item.ownerEmail && seededEmails.has(item.ownerEmail))
      );
    });

    if (hasSeeded) {
      console.error(
        "BETA_READINESS_SEEDED_INPUT: Cohort export contains seeded/default partner IDs from DEFAULT_COHORT_1_PARTNERS.",
      );
      process.exit(1);
    }

    partnersToProvision = rawList as CohortPartnerSeedInput[];
  }

  const db = createInMemorySqliteD1();
  const provisioned = await provisionBetaCohortPartners(db, {
    cohortId,
    resetCohortEvents: true,
    partners: partnersToProvision,
  });

  if (!provisioned.ok) {
    console.error(`[beta:readiness] FAIL: ${provisioned.error.message}`);
    process.exit(1);
  }

  const report = await computeCohortBetaMetrics(db, { cohortId });
  console.log(formatBetaReadinessSummary(report));

  const scorecardPath = resolve(evidenceDir, "n8n-parity-scorecard.json");
  const scorecardSummary = existsSync(scorecardPath)
    ? (JSON.parse(readFileSync(scorecardPath, "utf8")) as Record<string, unknown>)
    : null;

  const prov = stampEvidence("scripts/beta-readiness.ts", inputKind);
  const outPath =
    inputKind === "simulated"
      ? resolve(evidenceDir, "simulated", "cp8-beta-readiness.json")
      : resolve(evidenceDir, "cp8-beta-readiness.json");

  const artifact = {
    ...report,
    generatedAt: prov.generatedAt,
    n8nParityScorecard: scorecardSummary
      ? {
          totalInScope: scorecardSummary.totalInScope,
          passedInScope: scorecardSummary.passedInScope,
          passRate: scorecardSummary.passRate,
          allGreen: scorecardSummary.allGreen,
        }
      : null,
  };

  writeEvidence(outPath, artifact, prov);
  console.log(`\nWrote Cohort-1 readiness report to ${outPath}`);

  if (!report.overallPassed) {
    console.error("[beta:readiness] FAIL: Cohort-1 readiness targets not met.");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const simulate = args.includes("--simulate");
  const cohortIdx = args.indexOf("--cohort");
  const cohortPath = cohortIdx !== -1 && args[cohortIdx + 1] ? args[cohortIdx + 1] : null;

  await runBetaReadiness({ cohortPath, simulate });
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]).toLowerCase() ===
    resolve(fileURLToPath(import.meta.url)).toLowerCase();

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
