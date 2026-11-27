import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import studioAuthOrgsSql from "../migrations/0001_studio_auth_orgs.sql?raw";
import studioSecretVaultSql from "../migrations/0002_studio_secret_vault.sql?raw";
import cp5DeployTokensSql from "../migrations/0003_cp5_deploy_tokens.sql?raw";
import { app as studioApp, ensureStudioD1Schema, getProjectAssembleCount, getStudioFakeControlPlane, resetStudioDeployTestState } from "../src/index.ts";
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

let orgId = "";

async function callStudio(path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (orgId && !headers.has("x-org-id")) headers.set("x-org-id", orgId);

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

describe("Story 5.5 — Studio API Drift Detection & One-Click Rollback", () => {
  const VALID_CF_TOKEN = "cf_scoped_valid_token_story55_least_privilege";
  let ownerSessionToken = "";
  let testCounter = 0;

  beforeEach(async () => {
    testCounter += 1;
    resetStudioDeployTestState();
    await applyMigration(studioDb, studioAuthOrgsSql);
    await applyMigration(studioDb, studioSecretVaultSql);
    await applyMigration(studioDb, cp5DeployTokensSql);
    await ensureStudioD1Schema(studioDb);
    await studioDb.batch([
      studioDb.prepare("DELETE FROM deployment_steps"),
      studioDb.prepare("DELETE FROM deployments"),
      studioDb.prepare("DELETE FROM builds"),
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
        email: `owner-s55-${testCounter}@example.com`,
        password: "OwnerPassword123!",
        displayName: "Owner S55",
      },
    });
    const ownerData = (await ownerSignup.json()) as {
      token: string;
      user: { id: string };
    };
    ownerSessionToken = ownerData.token;

    const createOrgRes = await callStudio("/api/orgs", {
      token: ownerSessionToken,
      body: {
        name: "Acme Drift & Rollback Org",
        slug: `acme-s55-${testCounter}`,
      },
    });
    const orgData = (await createOrgRes.json()) as { id: string };
    orgId = orgData.id;
  });

  async function seedProjectRevision1(project: string) {
    await callStudio(`/api/orgs/${orgId}/projects`, {
      token: ownerSessionToken,
      body: { project },
    });

    const opsRes = await callStudio(`/api/projects/${project}/ops`, {
      token: ownerSessionToken,
      headers: { "x-org-id": orgId },
      body: {
        summary: "Seed r1 with core-auth, orders entity, and workflow v1",
        ops: [
          {
            opId: "op_brick_ws_55",
            type: "enable_brick",
            brickId: "multi-workspace",
            config: {},
          },
          {
            opId: "op_brick_auth_55",
            type: "enable_brick",
            brickId: "core-auth",
            config: {},
          },
          {
            opId: "op_brick_ent_55",
            type: "enable_brick",
            brickId: "dynamic-entities",
            config: {},
          },
          {
            opId: "op_brick_wallet_55",
            type: "enable_brick",
            brickId: "credit-wallet",
            config: {},
          },
          {
            opId: "op_brick_notif_55",
            type: "enable_brick",
            brickId: "in-app-notifications",
            config: {},
          },
          {
            opId: "op_id_mode_55",
            type: "set_identity",
            identity: "core-auth",
          },
          {
            opId: "op_ent_orders_55",
            type: "add_entity",
            entity: {
              name: "orders",
              workspaceScoped: true,
              fields: [{ name: "total", type: "text", required: true }],
            },
          },
          {
            opId: "op_wf_orders_55",
            type: "add_workflow",
            workflow: {
              id: "wf_orders",
              name: "Order Sync v1",
              nodes: [
                {
                  id: "n_sched",
                  type: "core.webhook",
                  label: "Order Webhook",
                  data: { method: "post" },
                },
                {
                  id: "n_debit",
                  type: "credit-wallet.debit",
                  label: "Debit Order Wallet",
                  data: { amount: 15 },
                },
              ],
              edges: [
                {
                  id: "e_1",
                  source: "n_sched",
                  target: "n_debit",
                  sourceHandle: "out",
                  targetHandle: "in",
                },
              ],
            },
          },
        ],
      },
    });
    expect(opsRes.status).toBe(200);

    for (const secName of ["BETTER_AUTH_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]) {
      const secretRes = await callStudio(`/api/projects/${project}/secrets`, {
        token: ownerSessionToken,
        headers: { "x-org-id": orgId },
        body: {
          // Story 16: px_connections refs are unique across projects, so each project uses its own ref.
          ref: `sec_${project}_${secName.toLowerCase()}`,
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

  async function connectCloudflareForOrg(project: string) {
    const res = await callStudio(`/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, {
      token: ownerSessionToken,
      body: {
        token: VALID_CF_TOKEN,
        projectId: project,
      },
    });
    expect(res.status).toBe(201);
    return (await res.json()) as {
      ok: true;
      accountId: string;
      tokenRef: string;
    };
  }

  it("returns enriched environment states with driftReport & deployments history and detects blueprint + out-of-band drift", async () => {
    const project = `cp5-drift-api-${testCounter}`;
    await seedProjectRevision1(project);
    await connectCloudflareForOrg(project);

    // Deploy r1 (v1) to preview
    const depV1Res = await callStudio(`/api/projects/${project}/environments/preview/deploy`, {
      token: ownerSessionToken,
      body: {},
    });
    expect(depV1Res.status).toBe(200);
    const depV1 = (await depV1Res.json()) as {
      deployId: string;
      revision: number;
      buildHash: string;
      codeHash: string;
      graphHash: string;
    };

    // GET /api/projects/:project/environments should report inSync: true for preview
    const envRes1 = await callStudio(`/api/projects/${project}/environments`, {
      token: ownerSessionToken,
    });
    expect(envRes1.status).toBe(200);
    const envData1 = (await envRes1.json()) as {
      currentRevision: number;
      environments: Array<{
        envName: string;
        deployedRev: number | null;
        buildHash: string | null;
        deployedAt: string | null;
        deployedBy: string | null;
        driftReport: {
          inSync: boolean;
          blueprintDrift: {
            hasCodeDrift: boolean;
            hasGraphDrift: boolean;
            deployedRev: number | null;
            currentRev: number;
          };
          outOfBandDrift: Array<{ resource: string; message: string }>;
        };
        deployments: Array<{
          deployId: string;
          versionLabel: string;
          revision: number;
        }>;
      }>;
    };

    const preview1 = envData1.environments.find((e) => e.envName === "preview")!;
    expect(preview1.deployedRev).toBe(depV1.revision);
    expect(preview1.driftReport.inSync).toBe(true);
    expect(preview1.deployments).toHaveLength(1);
    expect(preview1.deployments[0]?.versionLabel).toBe("v1");

    // Mutate workflow in r2 -> blueprintDrift.hasGraphDrift === true
    const opsR2 = await callStudio(`/api/projects/${project}/ops`, {
      token: ownerSessionToken,
      headers: { "x-org-id": orgId },
      body: {
        summary: "Update workflow debit node in r2",
        ops: [
          {
            opId: "op_wf_orders_update_r2",
            type: "update_node",
            workflowId: "wf_orders",
            nodeId: "n_debit",
            data: { amount: 25 },
          },
        ],
      },
    });
    expect(opsR2.status).toBe(200);

    // Check drift and simulate an out-of-band Worker script hash change
    const checkDriftRes = await callStudio(`/api/projects/${project}/environments/preview/check-drift`, {
      token: ownerSessionToken,
      body: {
        simulateOutOfBand: {
          workerHash: "tampered_cloudflare_script_hash",
        },
      },
    });
    expect(checkDriftRes.status).toBe(200);
    const checkDriftBody = (await checkDriftRes.json()) as {
      ok: boolean;
      driftReport: {
        inSync: boolean;
        blueprintDrift: {
          hasCodeDrift: boolean;
          hasGraphDrift: boolean;
          deployedRev: number;
          currentRev: number;
        };
        outOfBandDrift: Array<{
          resource: string;
          expected: string;
          actual: string | null;
        }>;
      };
    };

    expect(checkDriftBody.ok).toBe(true);
    expect(checkDriftBody.driftReport.inSync).toBe(false);
    expect(checkDriftBody.driftReport.blueprintDrift.hasCodeDrift).toBe(false);
    expect(checkDriftBody.driftReport.blueprintDrift.hasGraphDrift).toBe(true);
    expect(checkDriftBody.driftReport.blueprintDrift.deployedRev).toBe(depV1.revision);
    expect(checkDriftBody.driftReport.blueprintDrift.currentRev).toBe(depV1.revision + 1);
    expect(checkDriftBody.driftReport.outOfBandDrift).toEqual([
      expect.objectContaining({
        resource: "worker",
        expected: depV1.codeHash,
        actual: "tampered_cloudflare_script_hash",
      }),
    ]);
  });

  it("performs one-click rollback to historical v1 without rebuilding (reusedCachedBuild: true), restores D1 workflows & schedules, and guards destructive schema downgrades", async () => {
    const project = `cp5-rollback-api-${testCounter}`;
    await seedProjectRevision1(project);
    const conn = await connectCloudflareForOrg(project);

    // Deploy r1 (v1) to preview
    const depV1Res = await callStudio(`/api/projects/${project}/environments/preview/deploy`, {
      token: ownerSessionToken,
      body: {},
    });
    expect(depV1Res.status).toBe(200);
    const depV1 = (await depV1Res.json()) as {
      deployId: string;
      revision: number;
      buildHash: string;
      codeHash: string;
      graphHash: string;
    };

    // Advance to next revision with a new entity `invoices` and updated workflow node
    const opsR2 = await callStudio(`/api/projects/${project}/ops`, {
      token: ownerSessionToken,
      headers: { "x-org-id": orgId },
      body: {
        summary: "Add invoices entity and update workflow in r2",
        ops: [
          {
            opId: "op_add_invoices_r2",
            type: "add_entity",
            entity: {
              name: "invoices",
              workspaceScoped: true,
              fields: [{ name: "amount", type: "text", required: true }],
            },
          },
          {
            opId: "op_update_wf_orders_r2_rb",
            type: "update_node",
            workflowId: "wf_orders",
            nodeId: "n_debit",
            data: { amount: 30 },
          },
        ],
      },
    });
    expect(opsR2.status).toBe(200);

    // Deploy r2 (v2) to preview with a custom D1 migration
    const depV2Res = await callStudio(`/api/projects/${project}/environments/preview/deploy`, {
      token: ownerSessionToken,
      body: {
        migrations: [
          {
            name: "0002_create_invoices.sql",
            sql: "CREATE TABLE invoices (id TEXT PRIMARY KEY, amount REAL);",
          },
        ],
      },
    });
    expect(depV2Res.status).toBe(200);
    const depV2 = (await depV2Res.json()) as {
      deployId: string;
      buildHash: string;
      codeHash: string;
      graphHash: string;
    };
    expect(depV2.buildHash).not.toBe(depV1.buildHash);

    const assembleCountBeforeRollback = getProjectAssembleCount(project);

    // Attempt rollback from v2 -> v1 without confirmDestructive: should be blocked (422)
    const blockedRes = await callStudio(`/api/projects/${project}/environments/preview/rollback`, {
      token: ownerSessionToken,
      body: {
        targetDeploymentId: depV1.deployId,
      },
    });
    expect(blockedRes.status).toBe(422);
    const blockedBody = (await blockedRes.json()) as {
      ok: false;
      error: {
        code: string;
        destructiveWarnings: Array<{ migrationName: string; kind: string }>;
      };
    };
    expect(blockedBody.error.code).toBe("DESTRUCTIVE_MIGRATION_CONFIRMATION_REQUIRED");
    expect(blockedBody.error.destructiveWarnings.length).toBeGreaterThanOrEqual(1);

    // Confirm rollback from v2 -> v1 with confirmDestructive: true
    const rollbackRes = await callStudio(`/api/projects/${project}/environments/preview/rollback`, {
      token: ownerSessionToken,
      body: {
        targetDeploymentId: depV1.deployId,
        confirmDestructive: true,
      },
    });
    expect(rollbackRes.status).toBe(200);
    const rollbackBody = (await rollbackRes.json()) as {
      ok: true;
      deployId: string;
      rollbackFromDeploymentId: string;
      targetDeploymentId: string;
      revision: number;
      buildHash: string;
      codeHash: string;
      graphHash: string;
      action: string;
      reusedCachedBuild: boolean;
      environment: {
        deployedRev: number;
        buildHash: string;
        deployments: Array<{
          deployId: string;
          versionLabel: string;
          revision: number;
          buildHash: string;
          rollbackFromDeploymentId: string | null;
        }>;
      };
    };

    expect(rollbackBody.ok).toBe(true);
    expect(rollbackBody.action).toBe("rollback");
    expect(rollbackBody.reusedCachedBuild).toBe(true);
    expect(getProjectAssembleCount(project)).toBe(assembleCountBeforeRollback);
    expect(rollbackBody.revision).toBe(depV1.revision);
    expect(rollbackBody.buildHash).toBe(depV1.buildHash);
    expect(rollbackBody.rollbackFromDeploymentId).toBe(depV2.deployId);

    // Deployment history now has v3 (rolled back from v2), v2, v1
    expect(rollbackBody.environment.deployments).toHaveLength(3);
    expect(rollbackBody.environment.deployments[0]).toMatchObject({
      deployId: rollbackBody.deployId,
      versionLabel: "v3",
      revision: depV1.revision,
      buildHash: depV1.buildHash,
      rollbackFromDeploymentId: depV2.deployId,
    });

    // Verify D1 workflows & worker hash in MockCloudflareControlPlane were restored to v1
    const cp = getStudioFakeControlPlane(conn.accountId, TEST_ENV);
    const dbMeta = cp.inspectDatabase(conn.accountId, `px-${project}-preview`)!;
    const wfOrdersEntry = dbMeta.graphs.wf_orders!;
    const wfOrdersGraph = typeof wfOrdersEntry === "string" ? wfOrdersEntry : wfOrdersEntry.graph;
    expect(wfOrdersGraph).toContain('"amount":15');
    const workerMeta = cp.inspectWorker(conn.accountId, `px-${project}-preview`)!;
    expect(workerMeta.sha256).toBe(depV1.codeHash);
  });

  // Story 1.3: a deploy that applies a migration to an existing D1 records a Time Travel bookmark first; a rollback with
  // restoreData: true restores D1 to it and answers with previous_bookmark (the undo token).
  async function deployTwiceWithMigration(project: string) {
    await seedProjectRevision1(project);
    const conn = await connectCloudflareForOrg(project);
    const depV1Res = await callStudio(`/api/projects/${project}/environments/preview/deploy`, { token: ownerSessionToken, body: {} });
    expect(depV1Res.status).toBe(200);
    const depV1 = (await depV1Res.json()) as { deployId: string; revision: number; buildHash: string };
    const opsR2 = await callStudio(`/api/projects/${project}/ops`, {
      token: ownerSessionToken,
      headers: { "x-org-id": orgId },
      body: {
        summary: "Change the workflow in r2",
        ops: [{ opId: "op_update_wf_orders_r2_restore", type: "update_node", workflowId: "wf_orders", nodeId: "n_debit", data: { amount: 45 } }],
      },
    });
    expect(opsR2.status).toBe(200);
    const depV2Res = await callStudio(`/api/projects/${project}/environments/preview/deploy`, {
      token: ownerSessionToken,
      body: { migrations: [{ name: "0002_create_invoices.sql", sql: "CREATE TABLE invoices (id TEXT PRIMARY KEY, amount REAL);" }] },
    });
    expect(depV2Res.status).toBe(200);
    const depV2 = (await depV2Res.json()) as { deployId: string };
    // data written after the migration (a customer workspace's own row, which a code rollback keeps)
    const cp = getStudioFakeControlPlane(conn.accountId, TEST_ENV);
    await cp.putStoredGraph(
      conn.accountId,
      cp.findActiveTokenForAccount(conn.accountId)!,
      cp.inspectDatabase(conn.accountId, `px-${project}-preview`)!.uuid,
      "ws_customer",
      "written_after_v2",
      "{}",
    );
    expect(Object.keys(cp.inspectDatabase(conn.accountId, `px-${project}-preview`)!.graphs)).toContain("ws_customer:written_after_v2");
    return { conn, depV1, depV2 };
  }

  async function deploymentState(deployId: string): Promise<Record<string, unknown>> {
    const row = await studioDb.prepare("SELECT state_json FROM deployments WHERE deploy_id = ?").bind(deployId).first<{ state_json: string }>();
    return JSON.parse(row!.state_json) as Record<string, unknown>;
  }

  it("records a bookmark before a migration on an existing D1, none on a first deploy, and rollback with restoreData restores D1 to it", async () => {
    const project = `cp5-restore-data-${testCounter}`;
    const { conn, depV1, depV2 } = await deployTwiceWithMigration(project);
    const cp = getStudioFakeControlPlane(conn.accountId, TEST_ENV);
    const dbName = `px-${project}-preview`;

    // first deploy created the database: no restore point; the second applied 0002 to the existing one: a bookmark
    expect((await deploymentState(depV1.deployId)).preMigrationBookmark).toBeUndefined();
    const bookmark = (await deploymentState(depV2.deployId)).preMigrationBookmark;
    expect(typeof bookmark).toBe("string");
    expect(cp.inspectDatabase(conn.accountId, dbName)!.appliedMigrations.map((m) => m.name)).toContain("0002_create_invoices.sql");

    const dry = await callStudio(`/api/projects/${project}/environments/preview/rollback`, {
      token: ownerSessionToken,
      body: { targetDeploymentId: depV1.deployId, restoreData: true, dryRun: true },
    });
    expect(dry.status).toBe(200);
    expect(((await dry.json()) as { restoreData?: { fromDeploymentId: string } }).restoreData?.fromDeploymentId).toBe(depV2.deployId);

    const res = await callStudio(`/api/projects/${project}/environments/preview/rollback`, {
      token: ownerSessionToken,
      body: { targetDeploymentId: depV1.deployId, confirmDestructive: true, restoreData: true },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      buildHash: string;
      previous_bookmark?: string;
      restoreData?: { restored: boolean; fromDeploymentId: string; bookmark: string };
    };
    expect(body.ok).toBe(true);
    expect(body.buildHash).toBe(depV1.buildHash);
    expect(body.restoreData).toEqual({ restored: true, fromDeploymentId: depV2.deployId, bookmark });
    expect(typeof body.previous_bookmark).toBe("string");
    expect(body.previous_bookmark).not.toBe(bookmark);

    // the fake D1 is back at the pre-migration bookmark: the row written after it is gone
    expect(Object.keys(cp.inspectDatabase(conn.accountId, dbName)!.graphs)).not.toContain("ws_customer:written_after_v2");
    expect(cp.calls.some((call) => call.action === "restore_d1")).toBe(true);

    // the audit log names the restore, with the bookmark and the undo token
    const audit = await studioDb
      .prepare("SELECT details_json, metadata_json FROM studio_audit_logs WHERE project_id = ? AND action = 'environment.rollback' AND status = 'succeeded'")
      .bind(project)
      .all<{ details_json: string | null; metadata_json: string }>();
    const auditText = (audit.results ?? []).map((r) => `${r.details_json ?? ""} ${r.metadata_json}`).join("\n");
    expect(auditText).toContain('"restoreData":true');
    expect(auditText).toContain(String(bookmark));
    expect(auditText).toContain(String(body.previous_bookmark));
  });

  it("rollback without restoreData leaves D1 alone; restoreData with no later bookmark is 409 NO_RESTORE_POINT and changes nothing", async () => {
    const project = `cp5-restore-none-${testCounter}`;
    const { conn, depV1, depV2 } = await deployTwiceWithMigration(project);
    const cp = getStudioFakeControlPlane(conn.accountId, TEST_ENV);
    const dbName = `px-${project}-preview`;

    // no deployment after depV2 took a bookmark: nothing to restore to
    const refused = await callStudio(`/api/projects/${project}/environments/preview/rollback`, {
      token: ownerSessionToken,
      body: { targetDeploymentId: depV2.deployId, restoreData: true },
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("NO_RESTORE_POINT");
    const countRow = await studioDb.prepare("SELECT COUNT(*) AS n FROM deployments WHERE project_id = ?").bind(project).first<{ n: number }>();
    expect(Number(countRow!.n)).toBe(2);

    // code only: unchanged behaviour, D1 keeps the migration, no undo token
    const res = await callStudio(`/api/projects/${project}/environments/preview/rollback`, {
      token: ownerSessionToken,
      body: { targetDeploymentId: depV1.deployId, confirmDestructive: true },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { previous_bookmark?: string; restoreData?: unknown };
    expect(body.previous_bookmark).toBeUndefined();
    expect(body.restoreData).toBeUndefined();
    expect(Object.keys(cp.inspectDatabase(conn.accountId, dbName)!.graphs)).toContain("ws_customer:written_after_v2");
    expect(cp.calls.some((call) => call.action === "restore_d1")).toBe(false);
  });

  it("a deploy that migrates and then fails still leaves its restore point, and a later restoreData rollback uses it", async () => {
    const project = `cp5-restore-failed-${testCounter}`;
    await seedProjectRevision1(project);
    const conn = await connectCloudflareForOrg(project);
    const cp = getStudioFakeControlPlane(conn.accountId, TEST_ENV);
    const dbName = `px-${project}-preview`;
    const depV1Res = await callStudio(`/api/projects/${project}/environments/preview/deploy`, { token: ownerSessionToken, body: {} });
    expect(depV1Res.status).toBe(200);
    const depV1 = (await depV1Res.json()) as { deployId: string };
    const opsR2 = await callStudio(`/api/projects/${project}/ops`, {
      token: ownerSessionToken,
      headers: { "x-org-id": orgId },
      body: { summary: "r2", ops: [{ opId: "op_r2_failing", type: "update_node", workflowId: "wf_orders", nodeId: "n_debit", data: { amount: 60 } }] },
    });
    expect(opsR2.status).toBe(200);

    // every step after the migrations fails
    const patched = cp as unknown as Record<string, unknown>;
    const boom = async () => {
      throw new Error("simulated failure after the migration");
    };
    patched.putScript = boom;
    patched.putStoredGraph = boom;
    patched.putCronTriggers = boom;
    let failed: Response;
    try {
      failed = await callStudio(`/api/projects/${project}/environments/preview/deploy`, {
        token: ownerSessionToken,
        body: { migrations: [{ name: "0002_create_invoices.sql", sql: "CREATE TABLE invoices (id TEXT PRIMARY KEY, amount REAL);" }] },
      }).catch((e: unknown) => new Response(String(e), { status: 599 }));
    } finally {
      delete patched.putScript;
      delete patched.putStoredGraph;
      delete patched.putCronTriggers;
    }
    expect(failed.status).not.toBe(200);
    expect(cp.inspectDatabase(conn.accountId, dbName)!.appliedMigrations.map((m) => m.name)).toContain("0002_create_invoices.sql");
    // the failed deploy recorded no deployment, but its restore point is kept
    const points = await studioDb.prepare("SELECT deploy_id FROM deploy_restore_points WHERE project_id = ?").bind(project).all<{ deploy_id: string }>();
    expect(points.results).toHaveLength(1);
    const failedDeployId = points.results![0]!.deploy_id;
    expect(failedDeployId).not.toBe(depV1.deployId);

    await cp.putStoredGraph(
      conn.accountId,
      cp.findActiveTokenForAccount(conn.accountId)!,
      cp.inspectDatabase(conn.accountId, dbName)!.uuid,
      "ws_customer",
      "written_after_failed",
      "{}",
    );
    const res = await callStudio(`/api/projects/${project}/environments/preview/rollback`, {
      token: ownerSessionToken,
      body: { targetDeploymentId: depV1.deployId, confirmDestructive: true, restoreData: true },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { previous_bookmark?: string; restoreData?: { fromDeploymentId: string } };
    expect(body.restoreData?.fromDeploymentId).toBe(failedDeployId);
    expect(typeof body.previous_bookmark).toBe("string");
    expect(Object.keys(cp.inspectDatabase(conn.accountId, dbName)!.graphs)).not.toContain("ws_customer:written_after_failed");
  });

  it("when the restore fails after the code rollback, the code stays rolled back and the answer says the data was not restored", async () => {
    const project = `cp5-restore-fails-${testCounter}`;
    const { conn, depV1 } = await deployTwiceWithMigration(project);
    const cp = getStudioFakeControlPlane(conn.accountId, TEST_ENV);
    const dbName = `px-${project}-preview`;
    const patched = cp as unknown as Record<string, unknown>;
    patched.restoreD1 = async () => {
      throw new Error("time travel unavailable");
    };
    let res: Response;
    try {
      res = await callStudio(`/api/projects/${project}/environments/preview/rollback`, {
        token: ownerSessionToken,
        body: { targetDeploymentId: depV1.deployId, confirmDestructive: true, restoreData: true },
      });
    } finally {
      delete patched.restoreD1;
    }
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string; codeRolledBack: boolean; dataRestored: boolean; message: string; deployId: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error).toMatchObject({ code: "DATA_RESTORE_FAILED", codeRolledBack: true, dataRestored: false });
    expect(body.error.message).toMatch(/code was rolled back.*data was not restored/);

    // the code rollback happened and is recorded; the data is untouched
    const latest = await studioDb
      .prepare("SELECT deploy_id, action, build_hash FROM deployments WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .bind(project)
      .first<{ deploy_id: string; action: string; build_hash: string }>();
    expect(latest).toMatchObject({ deploy_id: body.error.deployId, action: "rollback", build_hash: depV1.buildHash });
    expect(Object.keys(cp.inspectDatabase(conn.accountId, dbName)!.graphs)).toContain("ws_customer:written_after_v2");
    const audit = await studioDb
      .prepare("SELECT status FROM studio_audit_logs WHERE project_id = ? AND action = 'environment.rollback.restore_data'")
      .bind(project)
      .all<{ status: string }>();
    expect((audit.results ?? []).map((r) => r.status)).toEqual(["failed"]);
  });
});
