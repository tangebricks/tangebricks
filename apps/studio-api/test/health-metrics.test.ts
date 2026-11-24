import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import type { EnvironmentHealthSummary } from "@poc/telemetry";
import studioAuthOrgsSql from "../migrations/0001_studio_auth_orgs.sql?raw";
import studioSecretVaultSql from "../migrations/0002_studio_secret_vault.sql?raw";
import cp5DeployTokensSql from "../migrations/0003_cp5_deploy_tokens.sql?raw";
import cp6DataBrowserSql from "../migrations/0005_cp6_data_browser.sql?raw";
import { app as studioApp, ensureStudioD1Schema } from "../src/index.ts";
import type { StudioApiEnv } from "../src/index.ts";

const rawEnv = env as unknown as StudioApiEnv;
const studioDb = rawEnv.STUDIO_DB as D1Like;

const TEST_ENV: StudioApiEnv = {
  ...rawEnv,
  BETTER_AUTH_SECRET: "studio-test-better-auth-secret-0123456789abcdef",
  PX_VAULT_KEY: "studio-test-aes-gcm-256-vault-master-key-99887766",
  PX_TOKEN_KEK: "studio-cp6-test-master-kek-v1-256bit-key-material-0001",
  PX_TOKEN_KEK_VERSION: "1",
  GITHUB_CLIENT_ID: "studio-gh-test-client-id",
  GITHUB_CLIENT_SECRET: "studio-gh-test-client-secret",
};

interface CallOptions {
  method?: string;
  token?: string;
  headers?: Record<string, string>;
  body?: unknown;
  env?: Partial<StudioApiEnv>;
}

async function callStudio(
  path: string,
  options: CallOptions = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);

  let rawBody: string | undefined;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    rawBody = JSON.stringify(options.body);
  }

  return studioApp.fetch(
    new Request(`https://example.test${path}`, {
      method: options.method ?? (rawBody !== undefined ? "POST" : "GET"),
      headers,
      body: rawBody,
    }),
    { ...TEST_ENV, ...(options.env ?? {}) },
  );
}

describe("apps/studio-api — Story 6.4 Backend Health & Metrics Panel Endpoints", () => {
  beforeEach(async () => {
    await applyMigration(studioDb, studioAuthOrgsSql);
    await applyMigration(studioDb, studioSecretVaultSql);
    await applyMigration(studioDb, cp5DeployTokensSql);
    await applyMigration(studioDb, cp6DataBrowserSql);
    await ensureStudioD1Schema(studioDb);

    await studioDb.batch([
      studioDb.prepare("DELETE FROM px_http_rollups"),
      studioDb.prepare("DELETE FROM px_queue_metrics"),
      studioDb.prepare("DELETE FROM px_logs"),
      studioDb.prepare("DELETE FROM px_step_events"),
      studioDb.prepare("DELETE FROM px_runs"),
    ]);
  });

  it("aggregates 1h, 24h, and 7d metrics, reconciles Cloudflare GraphQL Analytics within ±1%, and enforces viewer/builder RBAC", async () => {
    const suffix = Date.now();
    const project = `cp6-health-${suffix}`;
    const baseNow = "2026-06-20T18:00:00.000Z";
    const baseMs = Date.parse(baseNow);
    const min15Ago = new Date(baseMs - 15 * 60_000).toISOString();
    const hours8Ago = new Date(baseMs - 8 * 3600_000).toISOString();
    const days4Ago = new Date(baseMs - 4 * 86_400_000).toISOString();

    await studioDb.batch([
      studioDb.prepare("DELETE FROM studio_org_members"),
      studioDb.prepare("DELETE FROM studio_orgs"),
      studioDb.prepare('DELETE FROM "session"'),
      studioDb.prepare('DELETE FROM "account"'),
      studioDb.prepare('DELETE FROM "verification"'),
      studioDb.prepare('DELETE FROM "user"'),
    ]);

    const signUpOwner = await callStudio("/api/auth/signup", {
      body: {
        email: `owner-health-${suffix}@example.com`,
        password: "Password123!",
        displayName: "Health Owner",
      },
    });
    expect(signUpOwner.status).toBe(201);
    const ownerData = (await signUpOwner.json()) as { token: string; user: { id: string } };
    const ownerToken = ownerData.token;
    // Story 16: a health reset wipes every project's rollups in the environment, so only a platform operator may send
    // one; this test's owner is made one for its reset calls.
    const operatorEnv = { PX_PLATFORM_OPERATORS: ownerData.user.id };

    const createOrgRes = await callStudio("/api/orgs", {
      token: ownerToken,
      body: {
        name: `Health Org ${suffix}`,
        slug: `health-org-${suffix}`,
      },
    });
    expect(createOrgRes.status).toBe(201);
    const orgPayload = (await createOrgRes.json()) as {
      id?: string;
      org?: { id: string };
    };
    const orgId = orgPayload.id ?? orgPayload.org?.id ?? "";

    const signUpViewer = await callStudio("/api/auth/signup", {
      body: {
        email: `viewer-health-${suffix}@example.com`,
        password: "Password123!",
        displayName: "Health Viewer",
      },
    });
    expect(signUpViewer.status).toBe(201);
    const viewerData = (await signUpViewer.json()) as {
      token: string;
      user: { id: string };
    };
    const viewerToken = viewerData.token;

    const addMemberRes = await callStudio(`/api/orgs/${orgId}/members`, {
      token: ownerToken,
      body: {
        userId: viewerData.user.id,
        role: "viewer",
      },
    });
    expect(addMemberRes.status).toBe(201);

    const createProjRes = await callStudio(`/api/orgs/${orgId}/projects`, {
      token: ownerToken,
      body: { project },
    });
    expect(createProjRes.status).toBe(201);

    // Viewer is forbidden from seeding health metrics (403)
    const viewerSeedRes = await callStudio(
      `/api/projects/${project}/environments/preview/health/seed`,
      {
        method: "POST",
        token: viewerToken,
        headers: { "x-org-id": orgId },
        body: { reset: true },
      },
    );
    expect(viewerSeedRes.status).toBe(403);

    // Builder/Owner seeds deterministic 1h, 24h, and 7d telemetry + Cloudflare GraphQL Analytics snapshot
    const seedRes = await callStudio(
      `/api/projects/${project}/environments/preview/health/seed`,
      {
        method: "POST",
        token: ownerToken,
        headers: { "x-org-id": orgId },
        env: operatorEnv,
        body: {
          reset: true,
          now: baseNow,
          window: "1h",
          samples: [
            // 18 successful requests and 2 5xx errors across webhook-gateway and credit-wallet in 1h window (total 20 req, 10% 5xx)
            ...Array.from({ length: 12 }, (_, idx) => ({
              ts: min15Ago,
              routePrefix: "/webhooks/stripe",
              brickId: "webhook-gateway",
              status: idx === 0 ? 500 : 200,
              latencyMs: 15 + idx * 5,
              d1Queries: 2,
              d1LatencyMs: 4,
              d1Errors: 0,
            })),
            ...Array.from({ length: 8 }, (_, idx) => ({
              ts: min15Ago,
              routePrefix: "/api/wallet/debit",
              brickId: "credit-wallet",
              status: idx === 0 ? 503 : idx === 1 ? 422 : 200,
              latencyMs: 40 + idx * 25,
              d1Queries: 3,
              d1LatencyMs: 7,
              d1Errors: idx === 0 ? 1 : 0,
            })),
          ],
          rollups: [
            {
              bucketMinute: hours8Ago,
              routePrefix: "/api/entities/invoices",
              brickId: "dynamic-entities",
              requestCount: 80,
              error4xxCount: 2,
              error5xxCount: 3,
              latencySamplesMs: [18, 28, 45, 95, 160],
              d1QueryCount: 160,
              d1LatencyMs: 5.5,
              d1ErrorCount: 1,
            },
            {
              bucketMinute: days4Ago,
              routePrefix: "/api/notify/push",
              brickId: "in-app-notifications",
              requestCount: 100,
              error4xxCount: 0,
              error5xxCount: 0,
              latencySamplesMs: [10, 14, 22, 34, 65],
              d1QueryCount: 100,
              d1LatencyMs: 3.1,
              d1ErrorCount: 0,
            },
          ],
          runs: [
            {
              runId: "run_health_ok_1",
              workflowId: "wf_invoice_settled",
              revision: 1,
              triggerType: "webhook",
              workspaceId: "ws_alpha",
              status: "succeeded",
              durationMs: 48,
              retries: 0,
              startedAt: min15Ago,
              endedAt: min15Ago,
            },
            {
              runId: "run_health_fail_1",
              workflowId: "wf_wallet_settlement",
              revision: 2,
              triggerType: "webhook",
              workspaceId: "ws_alpha",
              status: "failed",
              durationMs: 190,
              retries: 2,
              errorStack: "Error: credit-wallet D1 lock contention",
              startedAt: min15Ago,
              endedAt: min15Ago,
            },
          ],
          queues: [
            {
              queueName: "px-outbound-queue",
              pendingCount: 18,
              dlqCount: 2,
              updatedAt: min15Ago,
            },
          ],
          cloudflareAnalytics: {
            workersInvocationsAdaptive: {
              requests: 20,
              errors: 2,
              p50Ms: 52.5,
              p95Ms: 215,
              p99Ms: 215,
            },
            queuesBacklogAdaptive: [
              {
                queueName: "px-outbound-queue",
                depth: 18,
                dlqCount: 2,
                updatedAt: min15Ago,
              },
            ],
          },
        },
      },
    );
    expect(seedRes.status).toBe(200);

    // Viewer can read 1h health metrics
    const health1hRes = await callStudio(
      `/api/projects/${project}/environments/preview/health?window=1h&now=${encodeURIComponent(baseNow)}`,
      {
        token: viewerToken,
        headers: { "x-org-id": orgId },
      },
    );
    expect(health1hRes.status).toBe(200);
    const body1h = (await health1hRes.json()) as EnvironmentHealthSummary & {
      project: string;
      envName: string;
    };
    expect(body1h.project).toBe(project);
    expect(body1h.envName).toBe("preview");
    expect(body1h.window).toBe("1h");
    expect(body1h.requestCount).toBe(20);
    expect(body1h.error4xxCount).toBe(1);
    expect(body1h.error5xxCount).toBe(2);
    expect(body1h.errorRatePercent).toBe(10);
    expect(body1h.latencyP50Ms).toBeGreaterThan(0);
    expect(body1h.latencyP95Ms).toBeGreaterThanOrEqual(body1h.latencyP50Ms);
    expect(body1h.latencyP99Ms).toBeGreaterThanOrEqual(body1h.latencyP95Ms);
    expect(body1h.d1.queryCount).toBe(48); // 12*2 + 8*3
    expect(body1h.d1.errorCount).toBe(1);
    expect(body1h.workflows.totalRuns).toBe(2);
    expect(body1h.workflows.failedRuns).toBe(1);
    expect(body1h.workflows.topFailingWorkflows[0]).toEqual({
      workflowId: "wf_wallet_settlement",
      failedCount: 1,
      lastFailedRunId: "run_health_fail_1",
    });
    expect(body1h.queues).toContainEqual(
      expect.objectContaining({
        queueName: "px-outbound-queue",
        depth: 18,
        dlqCount: 2,
      }),
    );
    expect(body1h.perBrick).toHaveLength(2);
    expect(body1h.analyticsReconciliation?.source).toBe("cloudflare-graphql+d1");
    expect(body1h.analyticsReconciliation?.deltaPercent).toBeLessThanOrEqual(1);

    // Viewer can read 24h and 7d windows
    const health24hRes = await callStudio(
      `/api/projects/${project}/environments/preview/health?window=24h&now=${encodeURIComponent(baseNow)}`,
      {
        token: viewerToken,
        headers: { "x-org-id": orgId },
      },
    );
    expect(health24hRes.status).toBe(200);
    const body24h = (await health24hRes.json()) as EnvironmentHealthSummary;
    expect(body24h.requestCount).toBe(100); // 20 + 80
    expect(body24h.error5xxCount).toBe(5); // 2 + 3
    expect(body24h.errorRatePercent).toBe(5);

    const health7dRes = await callStudio(
      `/api/projects/${project}/environments/preview/health?window=7d&now=${encodeURIComponent(baseNow)}`,
      {
        token: viewerToken,
        headers: { "x-org-id": orgId },
      },
    );
    expect(health7dRes.status).toBe(200);
    const body7d = (await health7dRes.json()) as EnvironmentHealthSummary;
    expect(body7d.requestCount).toBe(200); // 20 + 80 + 100
    expect(body7d.error5xxCount).toBe(5);
    expect(body7d.errorRatePercent).toBe(2.5);

    // Production environment is isolated from preview HTTP rollups and queue metrics
    const prodRes = await callStudio(
      `/api/projects/${project}/environments/production/health?window=1h&now=${encodeURIComponent(baseNow)}`,
      {
        token: viewerToken,
        headers: { "x-org-id": orgId },
      },
    );
    expect(prodRes.status).toBe(200);
    const prodBody = (await prodRes.json()) as EnvironmentHealthSummary;
    expect(prodBody.requestCount).toBe(0);
    expect(prodBody.queues).toHaveLength(0);
  });
});
