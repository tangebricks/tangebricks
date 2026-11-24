import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import studioAuthOrgsSql from "../migrations/0001_studio_auth_orgs.sql?raw";
import studioSecretVaultSql from "../migrations/0002_studio_secret_vault.sql?raw";
import cp5DeployTokensSql from "../migrations/0003_cp5_deploy_tokens.sql?raw";
import { app as studioApp } from "../src/index.ts";
import type { StudioApiEnv } from "../src/index.ts";

const rawEnv = env as unknown as StudioApiEnv;
const studioDb = rawEnv.STUDIO_DB as D1Like;

const TEST_ENV: StudioApiEnv = {
  ...rawEnv,
  BETTER_AUTH_SECRET: "studio-test-better-auth-secret-0123456789abcdef",
  PX_VAULT_KEY: "studio-test-aes-gcm-256-vault-master-key-99887766",
  PX_TOKEN_KEK: "studio-cp5-test-master-kek-v1-256bit-key-material-0001",
  PX_TOKEN_KEK_VERSION: "1",
  GITHUB_CLIENT_ID: "studio-gh-test-client-id",
  GITHUB_CLIENT_SECRET: "studio-gh-test-client-secret",
};

interface CallOptions {
  method?: string;
  token?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

async function callStudio(path: string, options: CallOptions = {}): Promise<Response> {
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
    TEST_ENV,
  );
}

describe("Story 5.3 — Pre-deploy Plan & Diff, Destructive-Migration Guard, and Stub-Identity Blocker (apps/studio-api)", () => {
  const VALID_CF_TOKEN = "cf_scoped_valid_token_story53_least_privilege";
  let ownerSessionToken = "";
  let orgId = "";
  let testCounter = 0;

  beforeEach(async () => {
    testCounter += 1;
    await applyMigration(studioDb, studioAuthOrgsSql);
    await applyMigration(studioDb, studioSecretVaultSql);
    await applyMigration(studioDb, cp5DeployTokensSql);
    await studioDb.batch([
      studioDb.prepare("DELETE FROM project_deployments"),
      studioDb.prepare("DELETE FROM onboarding_funnel_events"),
      studioDb.prepare("DELETE FROM project_environments"),
      studioDb.prepare("DELETE FROM deploy_token_audit_log"),
      studioDb.prepare("DELETE FROM deploy_tokens"),
      studioDb.prepare("DELETE FROM studio_secret_vault"),
      studioDb.prepare("DELETE FROM studio_audit_log"),
      studioDb.prepare("DELETE FROM studio_mcp_tokens"),
      studioDb.prepare("DELETE FROM studio_org_members"),
      studioDb.prepare("DELETE FROM studio_orgs"),
      studioDb.prepare('DELETE FROM "session"'),
      studioDb.prepare('DELETE FROM "account"'),
      studioDb.prepare('DELETE FROM "verification"'),
      studioDb.prepare('DELETE FROM "user"'),
    ]);

    const ownerSignup = await callStudio("/api/auth/signup", {
      body: {
        email: `owner-s53-${testCounter}@example.com`,
        password: "OwnerPassword123!",
        displayName: "Owner S53",
      },
    });
    const ownerData = (await ownerSignup.json()) as {
      token: string;
      user: { id: string };
    };
    ownerSessionToken = ownerData.token;

    const createOrgRes = await callStudio("/api/orgs", {
      token: ownerSessionToken,
      body: { name: "Acme Deploy Plan Org", slug: `acme-deploy-plan-${testCounter}` },
    });
    const orgData = (await createOrgRes.json()) as { id: string };
    orgId = orgData.id;
  });

  async function seedProjectAndConnectCloudflare(
    projectId: string,
    identity: "stub" | "core-auth" = "stub",
  ) {
    await callStudio(`/api/orgs/${orgId}/projects`, {
      token: ownerSessionToken,
      body: { project: projectId },
    });

    const connectRes = await callStudio(
      `/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`,
      {
        token: ownerSessionToken,
        body: {
          token: VALID_CF_TOKEN,
          projectId,
        },
      },
    );
    expect(connectRes.status).toBe(201);

    const opsRes = await callStudio(`/api/projects/${projectId}/ops`, {
      token: ownerSessionToken,
      headers: { "x-org-id": orgId },
      body: {
        summary: "Seed blueprint for Story 5.3",
        ops: [
          { opId: "op_brick_ws", type: "enable_brick", brickId: "multi-workspace", config: {} },
          { opId: "op_brick_auth", type: "enable_brick", brickId: "core-auth", config: {} },
          { opId: "op_brick_ent", type: "enable_brick", brickId: "dynamic-entities", config: {} },
          { opId: "op_id_mode", type: "set_identity", identity },
          {
            opId: "op_ent_invoices",
            type: "add_entity",
            entity: {
              name: "invoices",
              workspaceScoped: true,
              fields: [
                { name: "amount", type: "text", required: true },
                { name: "legacy_note", type: "text", required: false },
              ],
            },
          },
        ],
      },
    });
    expect(opsRes.status).toBe(200);

    for (const secName of [
      "BETTER_AUTH_SECRET",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
    ]) {
      const secretRes = await callStudio(`/api/projects/${projectId}/secrets`, {
        token: ownerSessionToken,
        headers: { "x-org-id": orgId },
        body: {
          // Story 16: px_connections refs are unique across projects, so each project uses its own ref.
          ref: `sec_${projectId}_${secName.toLowerCase()}`,
          kind: "brick_secret",
          label: secName,
          appOrBrick: "core-auth",
          value: `super_secret_${secName.toLowerCase()}_value_12345`,
          bindTarget: {
            targetKind: "brick",
            targetId: "core-auth",
            secretName: secName,
          },
        },
      });
      expect(secretRes.status).toBe(200);
    }
  }

  it("computes first-time deploy plan (action: 'create'), deploys to preview, computes repeat plan (action: 'noop'), and computes incremental update plan (action: 'update')", async () => {
    const projectId = "plan-diff-lifecycle";
    await seedProjectAndConnectCloudflare(projectId, "stub");

    // 1. First-time plan on preview -> action === "create"
    const plan1Res = await callStudio(
      `/api/projects/${projectId}/environments/preview/plan`,
      {
        token: ownerSessionToken,
        headers: { "x-org-id": orgId },
        body: {},
      },
    );
    expect(plan1Res.status).toBe(200);
    const plan1 = (await plan1Res.json()) as {
      action: string;
      worker: {
        currentBuildHash: string | null;
        nextBuildHash: string;
        changed: boolean;
      };
      d1: {
        createDatabase: boolean;
        pendingMigrations: string[];
        destructiveWarnings: unknown[];
      };
      blockers: unknown[];
    };
    expect(plan1.action).toBe("create");
    expect(plan1.worker.currentBuildHash).toBeNull();
    expect(plan1.worker.changed).toBe(true);
    expect(plan1.d1.createDatabase).toBe(true);
    expect(plan1.d1.pendingMigrations.length).toBeGreaterThan(0);
    expect(plan1.d1.destructiveWarnings).toEqual([]);
    expect(plan1.blockers).toEqual([]);

    // 2. Execute deploy on preview
    const deploy1Res = await callStudio(
      `/api/projects/${projectId}/environments/preview/deploy`,
      {
        token: ownerSessionToken,
        headers: { "x-org-id": orgId },
        body: {},
      },
    );
    expect(deploy1Res.status).toBe(200);
    const deploy1Body = (await deploy1Res.json()) as {
      ok: boolean;
      environment: { deployedRev: number; buildHash: string; status: string };
    };
    expect(deploy1Body.ok).toBe(true);
    expect(deploy1Body.environment.status).toBe("deployed");
    expect(deploy1Body.environment.buildHash).toBe(plan1.worker.nextBuildHash);

    // 3. Repeat plan on preview -> action === "noop"
    const planNoopRes = await callStudio(
      `/api/projects/${projectId}/environments/preview/plan`,
      {
        token: ownerSessionToken,
        headers: { "x-org-id": orgId },
        body: {},
      },
    );
    expect(planNoopRes.status).toBe(200);
    const planNoop = (await planNoopRes.json()) as {
      action: string;
      noChanges: boolean;
      worker: { changed: boolean };
      d1: { createDatabase: boolean; pendingMigrations: string[] };
    };
    expect(planNoop.action).toBe("noop");
    expect(planNoop.noChanges).toBe(true);
    expect(planNoop.worker.changed).toBe(false);
    expect(planNoop.d1.createDatabase).toBe(false);
    expect(planNoop.d1.pendingMigrations).toEqual([]);

    // 4. Add a brick (credit-wallet) and switch identity to core-auth -> action === "update"
    const addBrickRes = await callStudio(`/api/projects/${projectId}/ops`, {
      token: ownerSessionToken,
      headers: { "x-org-id": orgId },
      body: {
        summary: "Enable core-auth identity and credit-wallet brick",
        ops: [
          {
            opId: "op_set_core_auth",
            type: "set_identity",
            identity: "core-auth",
          },
          {
            opId: "op_add_wallet",
            type: "enable_brick",
            brickId: "credit-wallet",
            config: { creditsPerUnit: 10, minOrderAmount: 100 },
          },
        ],
      },
    });
    expect(addBrickRes.status).toBe(200);

    const planUpdateRes = await callStudio(
      `/api/projects/${projectId}/environments/preview/plan`,
      {
        token: ownerSessionToken,
        headers: { "x-org-id": orgId },
        body: {},
      },
    );
    expect(planUpdateRes.status).toBe(200);
    const planUpdate = (await planUpdateRes.json()) as {
      action: string;
      worker: {
        currentBuildHash: string | null;
        nextBuildHash: string;
        changed: boolean;
      };
      d1: { createDatabase: boolean; pendingMigrations: string[] };
    };
    expect(planUpdate.action).toBe("update");
    expect(planUpdate.worker.changed).toBe(true);
    expect(planUpdate.worker.currentBuildHash).toBe(plan1.worker.nextBuildHash);
    expect(planUpdate.d1.createDatabase).toBe(false);
    expect(
      planUpdate.d1.pendingMigrations.some((m) => m.includes("credit-wallet")),
    ).toBe(true);
  });

  it("unconditionally blocks identity: 'stub' on production with PRODUCTION_IDENTITY_STUB_FORBIDDEN in both /plan and /deploy (D8, AD-S12)", async () => {
    const projectId = "plan-diff-prod-stub";
    await seedProjectAndConnectCloudflare(projectId, "stub");

    const prodPlanRes = await callStudio(
      `/api/projects/${projectId}/environments/production/plan`,
      {
        token: ownerSessionToken,
        headers: { "x-org-id": orgId },
        body: {},
      },
    );
    expect(prodPlanRes.status).toBe(200);
    const prodPlan = (await prodPlanRes.json()) as {
      blockers: Array<{ code: string; message: string; remediation: string }>;
    };
    expect(
      prodPlan.blockers.some(
        (b) => b.code === "PRODUCTION_IDENTITY_STUB_FORBIDDEN",
      ),
    ).toBe(true);

    // Attempting to deploy to production while identity === "stub" returns HTTP 422
    const prodDeployRes = await callStudio(
      `/api/projects/${projectId}/environments/production/deploy`,
      {
        token: ownerSessionToken,
        headers: { "x-org-id": orgId },
        body: {},
      },
    );
    expect(prodDeployRes.status).toBe(422);
    const prodDeployErr = (await prodDeployRes.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(prodDeployErr.ok).toBe(false);
    expect(prodDeployErr.error.code).toBe(
      "PRODUCTION_IDENTITY_STUB_FORBIDDEN",
    );
  });

  it("flags destructive SQL migrations, blocks deploy without confirmDestructive: true (HTTP 422), and succeeds when confirmed", async () => {
    const projectId = "plan-diff-destructive";
    await seedProjectAndConnectCloudflare(projectId, "core-auth");

    // Deploy initial schema to preview
    const firstDeployRes = await callStudio(
      `/api/projects/${projectId}/environments/preview/deploy`,
      {
        token: ownerSessionToken,
        headers: { "x-org-id": orgId },
        body: {},
      },
    );
    expect(firstDeployRes.status).toBe(200);

    // Drop column `legacy_note` and narrow `amount` from text -> number on `invoices` entity
    const mutateEntityRes = await callStudio(`/api/projects/${projectId}/ops`, {
      token: ownerSessionToken,
      headers: { "x-org-id": orgId },
      body: {
        summary: "Drop legacy_note and narrow amount to number on invoices",
        ops: [
          {
            opId: "op_upd_invoices",
            type: "update_entity",
            entity: {
              name: "invoices",
              workspaceScoped: true,
              fields: [{ name: "amount", type: "number", required: true }],
            },
          },
        ],
      },
    });
    expect(mutateEntityRes.status).toBe(200);

    // Plan on preview now includes destructiveWarnings for drop_column and type_narrowing
    const destructivePlanRes = await callStudio(
      `/api/projects/${projectId}/environments/preview/plan`,
      {
        token: ownerSessionToken,
        headers: { "x-org-id": orgId },
        body: {},
      },
    );
    expect(destructivePlanRes.status).toBe(200);
    const destructivePlan = (await destructivePlanRes.json()) as {
      d1: {
        destructiveWarnings: Array<{
          migrationName: string;
          kind: string;
          affectedTable: string;
          affectedColumn?: string;
        }>;
      };
    };
    expect(
      destructivePlan.d1.destructiveWarnings.length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      destructivePlan.d1.destructiveWarnings.some(
        (w) =>
          w.kind === "drop_column" &&
          w.affectedTable === "invoices" &&
          w.affectedColumn === "legacy_note",
      ),
    ).toBe(true);
    expect(
      destructivePlan.d1.destructiveWarnings.some(
        (w) =>
          w.kind === "type_narrowing" &&
          w.affectedTable === "invoices" &&
          w.affectedColumn === "amount",
      ),
    ).toBe(true);

    // Deploy without confirmDestructive: true -> HTTP 422 DESTRUCTIVE_MIGRATION_CONFIRMATION_REQUIRED
    const unconfirmedDeployRes = await callStudio(
      `/api/projects/${projectId}/environments/preview/deploy`,
      {
        token: ownerSessionToken,
        headers: { "x-org-id": orgId },
        body: {},
      },
    );
    expect(unconfirmedDeployRes.status).toBe(422);
    const unconfirmedBody = (await unconfirmedDeployRes.json()) as {
      ok: boolean;
      error: {
        code: string;
        requiredMigrationNames: string[];
      };
    };
    expect(unconfirmedBody.ok).toBe(false);
    expect(unconfirmedBody.error.code).toBe(
      "DESTRUCTIVE_MIGRATION_CONFIRMATION_REQUIRED",
    );

    // Deploy with confirmDestructive: true and matching confirmedMigrationNames -> HTTP 200
    const confirmedDeployRes = await callStudio(
      `/api/projects/${projectId}/environments/preview/deploy`,
      {
        token: ownerSessionToken,
        headers: { "x-org-id": orgId },
        body: {
          confirmDestructive: true,
          confirmedMigrationNames: unconfirmedBody.error.requiredMigrationNames,
        },
      },
    );
    expect(confirmedDeployRes.status).toBe(200);
    const confirmedBody = (await confirmedDeployRes.json()) as { ok: boolean };
    expect(confirmedBody.ok).toBe(true);
  });
});
