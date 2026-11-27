import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_COHORT_1_PARTNERS, app as studioApp, ensureStudioD1Schema, validateCohort1Composition } from "../../../apps/studio-api/src/index.ts";
import type { BetaReadinessReport, CohortPartnerSeedInput, ProvisionedCohortPartnerRecord, StudioApiEnv } from "../../../apps/studio-api/src/index.ts";

const studioEnv = env as unknown as StudioApiEnv;

// Story 16: /api/admin/* is for platform operators only (a signed-in person listed in PX_PLATFORM_OPERATORS); MCP
// tokens, including the default seed token, are refused. The harness signs an operator in once.
let operator: { token: string; userId: string } | null = null;

async function adminReq(path: string, init: RequestInit = {}): Promise<Response> {
  if (!operator) {
    const res = await studioApp.request(
      "/api/auth/signup",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: `cohort-operator-${crypto.randomUUID().slice(0, 8)}@example.test`,
          password: "Password12345!",
          name: "Cohort Operator",
        }),
      },
      studioEnv,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; user: { id: string } };
    operator = { token: body.token, userId: body.user.id };
  }
  const headers = new Headers(init.headers);
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${operator.token}`);
  return studioApp.request(
    path,
    { ...init, headers },
    {
      ...studioEnv,
      PX_PLATFORM_OPERATORS: operator.userId,
    },
  );
}

describe("Story 8.4 — Cohort-1 Design Partner Simulation & Beta Metrics", () => {
  beforeEach(async () => {
    await ensureStudioD1Schema(studioEnv.STUDIO_DB);
    await studioEnv.STUDIO_DB.prepare("DELETE FROM studio_beta_cohort_partners").run();
    await studioEnv.STUDIO_DB.prepare("DELETE FROM studio_onboarding_events").run();
  });

  test("1. enforces Owner Decision D1 cohort composition (>= 1 agency and >= 1 mcp-first-dev) and rejects invalid cohort configs with HTTP 422", async () => {
    const onlySoloFounders: CohortPartnerSeedInput[] = [
      {
        orgName: "Solo One",
        orgSlug: "solo-one",
        partnerType: "solo-founder",
        ownerEmail: "s1@example.com",
      },
      {
        orgName: "Solo Two",
        orgSlug: "solo-two",
        partnerType: "solo-founder",
        ownerEmail: "s2@example.com",
      },
    ];

    const check = validateCohort1Composition(onlySoloFounders);
    expect(check.ok).toBe(false);
    expect(check.code).toBe("INVALID_COHORT_COMPOSITION");

    const res = await adminReq("/api/admin/beta-cohort/provision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cohortId: "cohort-invalid",
        partners: onlySoloFounders,
      }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; message: string; counts: { agency: number; mcpFirstDev: number } };
    };
    expect(body.error.code).toBe("INVALID_COHORT_COMPOSITION");
    expect(body.error.counts.agency).toBe(0);
    expect(body.error.counts.mcpFirstDev).toBe(0);
  });

  test("2. runs the 5-session Cohort-1 simulation via /api/admin/beta-cohort/provision and verifies all PRD section 8 metrics via /api/admin/beta-metrics", async () => {
    const provisionRes = await adminReq("/api/admin/beta-cohort/provision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cohortId: "cohort-1",
        resetCohortEvents: true,
        partners: DEFAULT_COHORT_1_PARTNERS,
      }),
    });

    expect(provisionRes.status).toBe(201);
    const provisioned = (await provisionRes.json()) as {
      ok: true;
      cohortId: string;
      partners: ProvisionedCohortPartnerRecord[];
      metrics: BetaReadinessReport;
    };

    expect(provisioned.ok).toBe(true);
    expect(provisioned.partners).toHaveLength(5);
    expect(provisioned.partners.every((p) => p.inviteToken.startsWith("inv_cohort-1_"))).toBe(true);

    // Fetch live metrics from GET /api/admin/beta-metrics
    const metricsRes = await adminReq("/api/admin/beta-metrics?cohortId=cohort-1");
    expect(metricsRes.status).toBe(200);
    const metrics = (await metricsRes.json()) as BetaReadinessReport;

    // D1 composition: 2 agencies, 2 mcp-first-devs, 1 solo-founder
    expect(metrics.composition).toEqual({
      totalPartners: 5,
      agencyCount: 2,
      mcpFirstDevCount: 2,
      soloFounderCount: 1,
      d1CompositionPassed: true,
    });

    // Metric 1: Median TTFD <= 30 min (sorted: 11.8, 14.5, 16.4, 18.2, 22.0 -> median 16.4)
    expect(metrics.ttfd.sampleSize).toBe(5);
    expect(metrics.ttfd.medianTtfdMinutes).toBe(16.4);
    expect(metrics.ttfd.p90TtfdMinutes).toBe(22);
    expect(metrics.ttfd.targetMinutes).toBe(30);
    expect(metrics.ttfd.passed).toBe(true);

    // Metric 2: Connect Cloudflare drop-off <= 25% -> cp9TriggerFired: false
    expect(metrics.connectCloudflare.wizardOpenedCount).toBe(5);
    expect(metrics.connectCloudflare.verifiedCount).toBe(5);
    expect(metrics.connectCloudflare.permissionCheckFailedCount).toBe(1);
    expect(metrics.connectCloudflare.dropOffRate).toBe(0);
    expect(metrics.connectCloudflare.cp9TriggerFired).toBe(false);
    expect(metrics.connectCloudflare.soloFoundersUnlocked).toBe(true);

    // Metric 3: >= 3 of 5 partners using >= 1 CP10 integration in a deployed workflow
    expect(metrics.integrationAdoption.partnersWithIntegrationWorkflows).toBe(4);
    expect(metrics.integrationAdoption.totalDeployedIntegrationWorkflows).toBe(6);
    expect(metrics.integrationAdoption.passed).toBe(true);

    // Metric 4: Mean time to locate failing node <= 2 min (120s)
    // (42 + 58 + 36 + 51 + 68) / 5 = 51s = 0.85 min
    expect(metrics.failingNodeLocalization.sampleSize).toBe(5);
    expect(metrics.failingNodeLocalization.meanTimeToLocateSec).toBe(51);
    expect(metrics.failingNodeLocalization.meanTimeToLocateMinutes).toBe(0.85);
    expect(metrics.failingNodeLocalization.passed).toBe(true);

    // Metric 5: Weekly active sessions at 4 weeks >= 3 of 5 partners
    expect(metrics.weeklyActiveRetention.activePartnersW4).toBe(5);
    expect(metrics.weeklyActiveRetention.passed).toBe(true);

    expect(metrics.overallPassed).toBe(true);
  });

  test("3. fires cp9TriggerFired: true and blocks solo-founder unlock when Connect Cloudflare wizard drop-off exceeds 25%", async () => {
    // 2 of 5 partners drop off at Connect Cloudflare (40% drop-off > 25% threshold)
    const highDropOffCohort: CohortPartnerSeedInput[] = DEFAULT_COHORT_1_PARTNERS.map((partner, idx) => ({
      ...partner,
      orgId: `${partner.orgId}_dropoff`,
      orgSlug: `${partner.orgSlug}-dropoff`,
      ownerEmail: `dropoff-${idx}@example.com`,
      ownerUserId: `usr_dropoff_${idx}`,
      sessionTelemetry: {
        ...partner.sessionTelemetry,
        connectCfCompleted: idx < 3, // Only 3 of 5 complete Connect Cloudflare -> 40% drop-off
      },
    }));

    const res = await adminReq("/api/admin/beta-cohort/provision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cohortId: "cohort-1-dropoff-sim",
        resetCohortEvents: true,
        partners: highDropOffCohort,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { metrics: BetaReadinessReport };
    expect(body.metrics.connectCloudflare.wizardOpenedCount).toBe(5);
    expect(body.metrics.connectCloudflare.verifiedCount).toBe(3);
    expect(body.metrics.connectCloudflare.dropOffRate).toBe(0.4);
    expect(body.metrics.connectCloudflare.cp9TriggerFired).toBe(true);
    expect(body.metrics.connectCloudflare.soloFoundersUnlocked).toBe(false);
  });
});
