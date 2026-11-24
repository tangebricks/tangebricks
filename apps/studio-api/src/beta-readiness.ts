import { z } from "zod";
import type { D1Like } from "@poc/sdk";
import { ensureStudioD1Schema } from "./blueprint-do.ts";
import {
  computeOnboardingFunnelAnalytics,
  generateUuidV7,
  recordStudioOnboardingEvent,
} from "./security/token-vault.ts";
import type { StudioOnboardingStep } from "./security/token-vault.ts";

export const BETA_PARTNER_TYPES = [
  "agency",
  "mcp-first-dev",
  "solo-founder",
] as const;

export type BetaPartnerType = (typeof BETA_PARTNER_TYPES)[number];

export const BetaPartnerTypeSchema = z.enum(BETA_PARTNER_TYPES);

export const CohortPartnerSessionTelemetrySchema = z.object({
  projectId: z.string().min(1).max(128).optional(),
  templateId: z.string().min(1).max(128).optional(),
  signupAt: z.string().min(1).optional(),
  connectCfWizardOpenedAt: z.string().min(1).optional(),
  connectCfTokenLinkClickedAt: z.string().min(1).optional(),
  connectCfTokenSubmittedAt: z.string().min(1).optional(),
  connectCfPermissionCheckFailedAt: z.string().min(1).optional(),
  connectCfVerifiedAt: z.string().min(1).optional(),
  firstPreviewDeployStartedAt: z.string().min(1).optional(),
  firstPreviewDeploySucceededAt: z.string().min(1).optional(),
  ttfdMinutes: z.number().min(0).optional(),
  connectCfCompleted: z.boolean().optional(),
  connectCfPermissionFailedOnce: z.boolean().optional(),
  deployedIntegrationWorkflows: z.number().int().min(0).optional(),
  meanTimeToLocateFailingNodeSec: z.number().min(0).nullable().optional(),
  weeklyActiveSessionsW4: z.number().int().min(0).optional(),
});

export type CohortPartnerSessionTelemetry = z.infer<
  typeof CohortPartnerSessionTelemetrySchema
>;

export const CohortPartnerSeedInputSchema = z.object({
  orgId: z.string().min(1).max(128).optional(),
  orgName: z.string().min(1).max(160),
  orgSlug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .min(2)
    .max(80),
  partnerType: BetaPartnerTypeSchema,
  ownerEmail: z.string().email(),
  ownerName: z.string().min(1).max(120).optional(),
  ownerUserId: z.string().min(1).max(128).optional(),
  sessionTelemetry: CohortPartnerSessionTelemetrySchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type CohortPartnerSeedInput = z.infer<
  typeof CohortPartnerSeedInputSchema
>;

export const CohortProvisionRequestSchema = z.object({
  cohortId: z.string().min(1).max(64).optional(),
  resetCohortEvents: z.boolean().optional(),
  partners: z.array(CohortPartnerSeedInputSchema).min(1).max(20),
});

export type CohortProvisionRequest = z.infer<
  typeof CohortProvisionRequestSchema
>;

export interface CohortCompositionValidationResult {
  ok: boolean;
  code?: "INVALID_COHORT_COMPOSITION";
  message?: string;
  counts: {
    total: number;
    agency: number;
    mcpFirstDev: number;
    soloFounder: number;
  };
}

export function validateCohort1Composition(
  partners: ReadonlyArray<{ partnerType: BetaPartnerType }>,
): CohortCompositionValidationResult {
  let agency = 0;
  let mcpFirstDev = 0;
  let soloFounder = 0;

  for (const p of partners) {
    if (p.partnerType === "agency") agency += 1;
    else if (p.partnerType === "mcp-first-dev") mcpFirstDev += 1;
    else if (p.partnerType === "solo-founder") soloFounder += 1;
  }

  const counts = {
    total: partners.length,
    agency,
    mcpFirstDev,
    soloFounder,
  };

  if (agency < 1 || mcpFirstDev < 1) {
    return {
      ok: false,
      code: "INVALID_COHORT_COMPOSITION",
      message: `Owner Decision D1 requires Cohort 1 to include >= 1 "agency" partner and >= 1 "mcp-first-dev" partner (received agency=${agency}, mcp-first-dev=${mcpFirstDev}, solo-founder=${soloFounder}).`,
      counts,
    };
  }

  return {
    ok: true,
    counts,
  };
}

export interface ProvisionedCohortPartnerRecord {
  orgId: string;
  cohortId: string;
  orgName: string;
  orgSlug: string;
  partnerType: BetaPartnerType;
  ownerEmail: string;
  ownerUserId: string;
  inviteToken: string;
  status: string;
  ttfdMinutes: number | null;
  connectCfWizardOpened: boolean;
  connectCfVerified: boolean;
  deployedIntegrationWorkflows: number;
  meanTimeToLocateFailingNodeSec: number | null;
  meanTimeToLocateFailingNodeMinutes: number | null;
  weeklyActiveSessionsW4: number;
  isActiveW4: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BetaReadinessReport {
  generatedAt: string;
  cohortId: string;
  composition: {
    totalPartners: number;
    agencyCount: number;
    mcpFirstDevCount: number;
    soloFounderCount: number;
    d1CompositionPassed: boolean;
  };
  ttfd: {
    sampleSize: number;
    medianTtfdMinutes: number | null;
    p90TtfdMinutes: number | null;
    targetMinutes: 30;
    passed: boolean;
    perPartnerMinutes: Array<{
      orgId: string;
      orgSlug: string;
      partnerType: BetaPartnerType;
      minutes: number;
    }>;
  };
  connectCloudflare: {
    wizardOpenedCount: number;
    tokenLinkClickedCount: number;
    tokenSubmittedCount: number;
    permissionCheckFailedCount: number;
    verifiedCount: number;
    dropOffRate: number;
    dropOffThreshold: 0.25;
    cp9TriggerFired: boolean;
    soloFoundersUnlocked: boolean;
  };
  integrationAdoption: {
    partnersWithIntegrationWorkflows: number;
    totalPartners: number;
    totalDeployedIntegrationWorkflows: number;
    targetPartners: 3;
    passed: boolean;
  };
  failingNodeLocalization: {
    sampleSize: number;
    meanTimeToLocateSec: number | null;
    meanTimeToLocateMinutes: number | null;
    targetSec: 120;
    targetMinutes: 2;
    passed: boolean;
  };
  weeklyActiveRetention: {
    activePartnersW4: number;
    totalPartners: number;
    targetActivePartners: 3;
    passed: boolean;
  };
  overallPassed: boolean;
  partners: ProvisionedCohortPartnerRecord[];
}

export const DEFAULT_COHORT_1_PARTNERS: ReadonlyArray<CohortPartnerSeedInput> = [
  {
    orgId: "org_cohort1_agency_northstar",
    orgName: "Northstar Digital Agency",
    orgSlug: "northstar-agency",
    partnerType: "agency",
    ownerEmail: "lead@northstar-agency.example.com",
    ownerName: "Maya Lin (Agency Architect)",
    ownerUserId: "usr_cohort1_maya",
    sessionTelemetry: {
      projectId: "northstar-client-ops",
      templateId: "stripe-discord-ops",
      ttfdMinutes: 14.5,
      connectCfCompleted: true,
      deployedIntegrationWorkflows: 2,
      meanTimeToLocateFailingNodeSec: 42,
      weeklyActiveSessionsW4: 6,
    },
    metadata: {
      primaryUseCase: "Client Stripe billing + Discord ops automation",
    },
  },
  {
    orgId: "org_cohort1_agency_kestrel",
    orgName: "Kestrel Cloud Studio",
    orgSlug: "kestrel-cloud-studio",
    partnerType: "agency",
    ownerEmail: "cto@kestrel-studio.example.com",
    ownerName: "Devon Patel (Agency CTO)",
    ownerUserId: "usr_cohort1_devon",
    sessionTelemetry: {
      projectId: "kestrel-b2b-portal",
      templateId: "b2b-workspace-app",
      ttfdMinutes: 18.2,
      connectCfCompleted: true,
      deployedIntegrationWorkflows: 1,
      meanTimeToLocateFailingNodeSec: 58,
      weeklyActiveSessionsW4: 5,
    },
    metadata: {
      primaryUseCase: "Multi-workspace SaaS starter for agency clients",
    },
  },
  {
    orgId: "org_cohort1_mcp_synthwave",
    orgName: "Synthwave AI Labs",
    orgSlug: "synthwave-ai-labs",
    partnerType: "mcp-first-dev",
    ownerEmail: "alex@synthwave-ai.example.com",
    ownerName: "Alex Rivera (MCP Builder)",
    ownerUserId: "usr_cohort1_alex",
    sessionTelemetry: {
      projectId: "synthwave-credits-api",
      templateId: "ai-credits-saas",
      ttfdMinutes: 11.8,
      connectCfCompleted: true,
      deployedIntegrationWorkflows: 2,
      meanTimeToLocateFailingNodeSec: 36,
      weeklyActiveSessionsW4: 8,
    },
    metadata: {
      primaryUseCase: "Claude Code + Cursor MCP co-building for AI credits backend",
    },
  },
  {
    orgId: "org_cohort1_mcp_hyperion",
    orgName: "Hyperion Agentic Systems",
    orgSlug: "hyperion-agentic",
    partnerType: "mcp-first-dev",
    ownerEmail: "priya@hyperion-agentic.example.com",
    ownerName: "Priya Nair (Staff Engineer)",
    ownerUserId: "usr_cohort1_priya",
    sessionTelemetry: {
      projectId: "hyperion-webhook-router",
      templateId: "stripe-discord-ops",
      ttfdMinutes: 16.4,
      connectCfCompleted: true,
      connectCfPermissionFailedOnce: true,
      deployedIntegrationWorkflows: 1,
      meanTimeToLocateFailingNodeSec: 51,
      weeklyActiveSessionsW4: 4,
    },
    metadata: {
      primaryUseCase: "MCP-authored webhook + GitHub/Slack ops pipelines",
    },
  },
  {
    orgId: "org_cohort1_founder_Vela",
    orgName: "Vela Marketplace Co",
    orgSlug: "vela-marketplace",
    partnerType: "solo-founder",
    ownerEmail: "sam@vela-marketplace.example.com",
    ownerName: "Sam Okafor (Technical Founder)",
    ownerUserId: "usr_cohort1_sam",
    sessionTelemetry: {
      projectId: "vela-escrow-core",
      templateId: "marketplace",
      ttfdMinutes: 22.0,
      connectCfCompleted: true,
      deployedIntegrationWorkflows: 0,
      meanTimeToLocateFailingNodeSec: 68,
      weeklyActiveSessionsW4: 3,
    },
    metadata: {
      primaryUseCase: "Two-sided marketplace ledger and payouts",
    },
  },
];

function addMinutesIso(baseIso: string, minutes: number): string {
  const baseMs = Date.parse(baseIso);
  return new Date(baseMs + Math.round(minutes * 60_000)).toISOString();
}

export async function provisionBetaCohortPartners(
  db: D1Like,
  input: CohortProvisionRequest,
): Promise<
  | {
      ok: true;
      cohortId: string;
      partners: ProvisionedCohortPartnerRecord[];
      metrics: BetaReadinessReport;
    }
  | {
      ok: false;
      status: 422;
      error: {
        code: "INVALID_COHORT_COMPOSITION";
        message: string;
        counts: CohortCompositionValidationResult["counts"];
      };
    }
> {
  await ensureStudioD1Schema(db);

  const compositionCheck = validateCohort1Composition(input.partners);
  if (!compositionCheck.ok) {
    return {
      ok: false,
      status: 422,
      error: {
        code: "INVALID_COHORT_COMPOSITION",
        message:
          compositionCheck.message ??
          "Invalid Cohort-1 partner composition under Owner Decision D1.",
        counts: compositionCheck.counts,
      },
    };
  }

  const cohortId = input.cohortId ?? "cohort-1";
  if (input.resetCohortEvents) {
    const existingRows = await db
      .prepare(
        "SELECT org_id FROM studio_beta_cohort_partners WHERE cohort_id = ?",
      )
      .bind(cohortId)
      .all<{ org_id: string }>();
    for (const r of existingRows.results ?? []) {
      await db
        .prepare("DELETE FROM studio_onboarding_events WHERE org_id = ?")
        .bind(r.org_id)
        .run();
    }
    await db
      .prepare("DELETE FROM studio_beta_cohort_partners WHERE cohort_id = ?")
      .bind(cohortId)
      .run();
  }

  const nowIso = new Date().toISOString();
  const baseStartMs = Date.parse("2026-11-01T10:00:00.000Z");

  for (let idx = 0; idx < input.partners.length; idx += 1) {
    const p = input.partners[idx]!;
    const orgId = p.orgId ?? `org_${cohortId}_${p.orgSlug.replace(/-/g, "_")}`;
    const userId =
      p.ownerUserId ?? `usr_${cohortId}_${p.orgSlug.replace(/-/g, "_")}`;
    const ownerName = p.ownerName ?? p.ownerEmail.split("@")[0] ?? "Partner Owner";
    const inviteToken = `inv_${cohortId}_${p.partnerType}_${generateUuidV7().slice(0, 12)}`;
    const telemetry = p.sessionTelemetry;
    const projectId = telemetry?.projectId ?? `${p.orgSlug}-app`;

    await db
      .prepare(
        `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT("id") DO UPDATE SET
           "name" = excluded."name",
           "email" = excluded."email",
           "updatedAt" = excluded."updatedAt"`,
      )
      .bind(userId, ownerName, p.ownerEmail, nowIso, nowIso)
      .run()
      .catch(() => {});

    await db
      .prepare(
        `INSERT INTO studio_orgs (id, slug, name, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           slug = excluded.slug,
           name = excluded.name`,
      )
      .bind(orgId, p.orgSlug, p.orgName, nowIso)
      .run();

    await db
      .prepare(
        `INSERT INTO studio_org_members (org_id, user_id, role, created_at)
         VALUES (?, ?, 'owner', ?)
         ON CONFLICT(org_id, user_id) DO UPDATE SET role = 'owner'`,
      )
      .bind(orgId, userId, nowIso)
      .run();

    const deployedIntegrationWorkflows =
      telemetry?.deployedIntegrationWorkflows ?? 0;
    const meanTimeToLocateFailingNodeSec =
      telemetry?.meanTimeToLocateFailingNodeSec ?? null;
    const weeklyActiveSessionsW4 = telemetry?.weeklyActiveSessionsW4 ?? 0;

    await db
      .prepare(
        `INSERT INTO studio_beta_cohort_partners (
           org_id, cohort_id, org_name, org_slug, partner_type,
           owner_email, owner_user_id, invite_token, status,
           deployed_integration_workflows, mean_time_to_locate_failing_node_sec,
           weekly_active_sessions_w4, metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id) DO UPDATE SET
           cohort_id = excluded.cohort_id,
           org_name = excluded.org_name,
           org_slug = excluded.org_slug,
           partner_type = excluded.partner_type,
           owner_email = excluded.owner_email,
           owner_user_id = excluded.owner_user_id,
           deployed_integration_workflows = excluded.deployed_integration_workflows,
           mean_time_to_locate_failing_node_sec = excluded.mean_time_to_locate_failing_node_sec,
           weekly_active_sessions_w4 = excluded.weekly_active_sessions_w4,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      )
      .bind(
        orgId,
        cohortId,
        p.orgName,
        p.orgSlug,
        p.partnerType,
        p.ownerEmail,
        userId,
        inviteToken,
        deployedIntegrationWorkflows,
        meanTimeToLocateFailingNodeSec,
        weeklyActiveSessionsW4,
        JSON.stringify(p.metadata ?? {}),
        nowIso,
        nowIso,
      )
      .run();

    if (telemetry) {
      await db
        .prepare("DELETE FROM studio_onboarding_events WHERE org_id = ?")
        .bind(orgId)
        .run();

      const partnerStartIso =
        telemetry.signupAt ??
        new Date(baseStartMs + idx * 3_600_000).toISOString();

      const recordStep = async (
        step: StudioOnboardingStep,
        createdAt: string,
        extraMeta?: Record<string, unknown>,
      ) => {
        await recordStudioOnboardingEvent(db, {
          orgId,
          projectId,
          actorId: userId,
          step,
          templateId: telemetry.templateId ?? null,
          source: "cohort-1-session",
          metadata: {
            cohortId,
            partnerType: p.partnerType,
            ...(extraMeta ?? {}),
          },
          createdAt,
        });
      };

      await recordStep("signup_completed", partnerStartIso);
      await recordStep(
        "project_created",
        addMinutesIso(partnerStartIso, 1.0),
      );

      const wizardOpenedAt =
        telemetry.connectCfWizardOpenedAt ??
        addMinutesIso(partnerStartIso, 3.0);
      await recordStep("connect_cf_wizard_opened", wizardOpenedAt);

      const linkClickedAt =
        telemetry.connectCfTokenLinkClickedAt ??
        addMinutesIso(wizardOpenedAt, 0.5);
      await recordStep("connect_cf_token_link_clicked", linkClickedAt);

      const tokenSubmittedAt =
        telemetry.connectCfTokenSubmittedAt ??
        addMinutesIso(wizardOpenedAt, 2.5);
      await recordStep("connect_cf_token_submitted", tokenSubmittedAt);

      if (
        telemetry.connectCfPermissionFailedOnce ||
        telemetry.connectCfPermissionCheckFailedAt
      ) {
        const failedAt =
          telemetry.connectCfPermissionCheckFailedAt ??
          addMinutesIso(tokenSubmittedAt, 0.25);
        await recordStep("connect_cf_permission_check_failed", failedAt);
      }

      const cfCompleted = telemetry.connectCfCompleted ?? true;
      if (cfCompleted) {
        const verifiedAt =
          telemetry.connectCfVerifiedAt ??
          addMinutesIso(tokenSubmittedAt, 1.0);
        await recordStep("connect_cf_verified", verifiedAt);

        const ttfdMinutes = telemetry.ttfdMinutes;
        if (
          typeof ttfdMinutes === "number" ||
          telemetry.firstPreviewDeploySucceededAt
        ) {
          const resolvedMinutes = ttfdMinutes ?? 15;
          const deployStartedAt =
            telemetry.firstPreviewDeployStartedAt ??
            addMinutesIso(
              partnerStartIso,
              Math.max(4.5, resolvedMinutes - 1.0),
            );
          const deploySucceededAt =
            telemetry.firstPreviewDeploySucceededAt ??
            addMinutesIso(partnerStartIso, resolvedMinutes);

          await recordStep("first_preview_deploy_started", deployStartedAt);
          await recordStep("first_preview_deploy_succeeded", deploySucceededAt);
        }
      }
    }
  }

  const metrics = await computeCohortBetaMetrics(db, { cohortId });
  return {
    ok: true,
    cohortId,
    partners: metrics.partners,
    metrics,
  };
}

function computePercentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return Number(sortedAsc[0]!.toFixed(2));
  if (p === 0.5) {
    const mid = Math.floor(sortedAsc.length / 2);
    const val =
      sortedAsc.length % 2 === 1
        ? sortedAsc[mid]!
        : (sortedAsc[mid - 1]! + sortedAsc[mid]!) / 2;
    return Number(val.toFixed(2));
  }
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil(p * sortedAsc.length) - 1),
  );
  return Number(sortedAsc[idx]!.toFixed(2));
}

export async function computeCohortBetaMetrics(
  db: D1Like,
  options?: { cohortId?: string },
): Promise<BetaReadinessReport> {
  await ensureStudioD1Schema(db);
  const cohortId = options?.cohortId ?? "cohort-1";

  const rowsRes = await db
    .prepare(
      `SELECT
         org_id, cohort_id, org_name, org_slug, partner_type,
         owner_email, owner_user_id, invite_token, status,
         deployed_integration_workflows, mean_time_to_locate_failing_node_sec,
         weekly_active_sessions_w4, metadata_json, created_at, updated_at
       FROM studio_beta_cohort_partners
       WHERE cohort_id = ?
       ORDER BY created_at ASC, org_id ASC`,
    )
    .bind(cohortId)
    .all<{
      org_id: string;
      cohort_id: string;
      org_name: string;
      org_slug: string;
      partner_type: BetaPartnerType;
      owner_email: string;
      owner_user_id: string;
      invite_token: string;
      status: string;
      deployed_integration_workflows: number;
      mean_time_to_locate_failing_node_sec: number | null;
      weekly_active_sessions_w4: number;
      metadata_json: string;
      created_at: string;
      updated_at: string;
    }>();

  const partnerRows = rowsRes.results ?? [];

  let agencyCount = 0;
  let mcpFirstDevCount = 0;
  let soloFounderCount = 0;

  let wizardOpenedCount = 0;
  let tokenLinkClickedCount = 0;
  let tokenSubmittedCount = 0;
  let permissionCheckFailedCount = 0;
  let verifiedCount = 0;

  const perPartnerMinutes: Array<{
    orgId: string;
    orgSlug: string;
    partnerType: BetaPartnerType;
    minutes: number;
  }> = [];

  const partners: ProvisionedCohortPartnerRecord[] = [];

  for (const r of partnerRows) {
    if (r.partner_type === "agency") agencyCount += 1;
    else if (r.partner_type === "mcp-first-dev") mcpFirstDevCount += 1;
    else if (r.partner_type === "solo-founder") soloFounderCount += 1;

    const orgFunnel = await computeOnboardingFunnelAnalytics(db, {
      orgId: r.org_id,
    });

    wizardOpenedCount += orgFunnel.connectCloudflare.wizardOpenedCount;
    tokenLinkClickedCount += orgFunnel.connectCloudflare.tokenLinkClickedCount;
    tokenSubmittedCount += orgFunnel.connectCloudflare.tokenSubmittedCount;
    permissionCheckFailedCount +=
      orgFunnel.connectCloudflare.permissionCheckFailedCount;
    verifiedCount += orgFunnel.connectCloudflare.verifiedCount;

    const ttfdMinutes = orgFunnel.ttfd.medianTtfdMinutes;
    if (ttfdMinutes !== null) {
      perPartnerMinutes.push({
        orgId: r.org_id,
        orgSlug: r.org_slug,
        partnerType: r.partner_type,
        minutes: ttfdMinutes,
      });
    }

    let metadata: Record<string, unknown> = {};
    if (r.metadata_json) {
      try {
        metadata = JSON.parse(r.metadata_json) as Record<string, unknown>;
      } catch {
        metadata = {};
      }
    }

    const locateSec =
      r.mean_time_to_locate_failing_node_sec !== null &&
      r.mean_time_to_locate_failing_node_sec !== undefined
        ? Number(r.mean_time_to_locate_failing_node_sec)
        : null;
    const locateMin =
      locateSec !== null ? Number((locateSec / 60).toFixed(2)) : null;
    const weeklyActiveW4 = Number(r.weekly_active_sessions_w4 ?? 0);

    partners.push({
      orgId: r.org_id,
      cohortId: r.cohort_id,
      orgName: r.org_name,
      orgSlug: r.org_slug,
      partnerType: r.partner_type,
      ownerEmail: r.owner_email,
      ownerUserId: r.owner_user_id,
      inviteToken: r.invite_token,
      status: r.status,
      ttfdMinutes,
      connectCfWizardOpened:
        orgFunnel.connectCloudflare.wizardOpenedCount > 0,
      connectCfVerified: orgFunnel.connectCloudflare.verifiedCount > 0,
      deployedIntegrationWorkflows: Number(
        r.deployed_integration_workflows ?? 0,
      ),
      meanTimeToLocateFailingNodeSec: locateSec,
      meanTimeToLocateFailingNodeMinutes: locateMin,
      weeklyActiveSessionsW4: weeklyActiveW4,
      isActiveW4: weeklyActiveW4 >= 1,
      metadata,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  }

  const totalPartners = partners.length;
  const d1CompositionPassed = agencyCount >= 1 && mcpFirstDevCount >= 1;

  const sortedTtfd = perPartnerMinutes
    .map((item) => item.minutes)
    .sort((a, b) => a - b);
  const medianTtfdMinutes = computePercentile(sortedTtfd, 0.5);
  const p90TtfdMinutes = computePercentile(sortedTtfd, 0.9);
  const ttfdPassed =
    medianTtfdMinutes !== null && medianTtfdMinutes <= 30;

  const rawDropOff =
    wizardOpenedCount > 0 ? 1 - verifiedCount / wizardOpenedCount : 0;
  const dropOffRate = Number(Math.max(0, Math.min(1, rawDropOff)).toFixed(4));
  const dropOffThreshold = 0.25 as const;
  const cp9TriggerFired = dropOffRate > dropOffThreshold;
  const soloFoundersUnlocked = !cp9TriggerFired;

  const partnersWithIntegrationWorkflows = partners.filter(
    (p) => p.deployedIntegrationWorkflows >= 1,
  ).length;
  const totalDeployedIntegrationWorkflows = partners.reduce(
    (acc, p) => acc + p.deployedIntegrationWorkflows,
    0,
  );
  const integrationAdoptionPassed = partnersWithIntegrationWorkflows >= 3;

  const locateSamples = partners
    .map((p) => p.meanTimeToLocateFailingNodeSec)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const meanTimeToLocateSec =
    locateSamples.length > 0
      ? Number(
          (
            locateSamples.reduce((a, b) => a + b, 0) / locateSamples.length
          ).toFixed(2),
        )
      : null;
  const meanTimeToLocateMinutes =
    meanTimeToLocateSec !== null
      ? Number((meanTimeToLocateSec / 60).toFixed(2))
      : null;
  const failingNodeLocalizationPassed =
    meanTimeToLocateMinutes !== null && meanTimeToLocateMinutes <= 2;

  const activePartnersW4 = partners.filter((p) => p.isActiveW4).length;
  const weeklyActiveRetentionPassed = activePartnersW4 >= 3;

  const overallPassed =
    d1CompositionPassed &&
    ttfdPassed &&
    integrationAdoptionPassed &&
    failingNodeLocalizationPassed &&
    weeklyActiveRetentionPassed;

  return {
    generatedAt: new Date().toISOString(),
    cohortId,
    composition: {
      totalPartners,
      agencyCount,
      mcpFirstDevCount,
      soloFounderCount,
      d1CompositionPassed,
    },
    ttfd: {
      sampleSize: sortedTtfd.length,
      medianTtfdMinutes,
      p90TtfdMinutes,
      targetMinutes: 30,
      passed: ttfdPassed,
      perPartnerMinutes,
    },
    connectCloudflare: {
      wizardOpenedCount,
      tokenLinkClickedCount,
      tokenSubmittedCount,
      permissionCheckFailedCount,
      verifiedCount,
      dropOffRate,
      dropOffThreshold,
      cp9TriggerFired,
      soloFoundersUnlocked,
    },
    integrationAdoption: {
      partnersWithIntegrationWorkflows,
      totalPartners,
      totalDeployedIntegrationWorkflows,
      targetPartners: 3,
      passed: integrationAdoptionPassed,
    },
    failingNodeLocalization: {
      sampleSize: locateSamples.length,
      meanTimeToLocateSec,
      meanTimeToLocateMinutes,
      targetSec: 120,
      targetMinutes: 2,
      passed: failingNodeLocalizationPassed,
    },
    weeklyActiveRetention: {
      activePartnersW4,
      totalPartners,
      targetActivePartners: 3,
      passed: weeklyActiveRetentionPassed,
    },
    overallPassed,
    partners,
  };
}
