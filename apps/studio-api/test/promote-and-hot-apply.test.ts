import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import studioAuthOrgsSql from "../migrations/0001_studio_auth_orgs.sql?raw";
import studioSecretVaultSql from "../migrations/0002_studio_secret_vault.sql?raw";
import cp5DeployTokensSql from "../migrations/0003_cp5_deploy_tokens.sql?raw";
import { getProjectAssembleCount, resetStudioDeployTestState } from "../src/index.ts";
import { appWithPlaceholderExecutors as studioApp } from "./placeholder-executors.ts";
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

describe("Story 5.4 — Content-Addressed Build Cache, Preview-to-Production Promotion, Idempotent Re-Deploy & Graph-Only Hot-Apply (apps/studio-api)", () => {
  const VALID_CF_TOKEN = "cf_scoped_valid_token_story54_least_privilege";
  let ownerSessionToken = "";
  let orgId = "";
  let testCounter = 0;

  beforeEach(async () => {
    testCounter += 1;
    resetStudioDeployTestState();
    await applyMigration(studioDb, studioAuthOrgsSql);
    await applyMigration(studioDb, studioSecretVaultSql);
    await applyMigration(studioDb, cp5DeployTokensSql);
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
        email: `owner-s54-${testCounter}@example.com`,
        password: "OwnerPassword123!",
        displayName: "Owner S54",
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
        name: "Acme Promote Hot-Apply Org",
        slug: `acme-s54-${testCounter}`,
      },
    });
    const orgData = (await createOrgRes.json()) as { id: string };
    orgId = orgData.id;
  });

  it("deploys rev to preview, caches build in builds table, promotes identical buildHash to production without calling assemble() a second time, hot-applies workflow-only edit in D1 without uploading Worker script, and executes updated graph on /run", async () => {
    const projectId = `s54-promote-hot-${testCounter}`;

    await callStudio(`/api/orgs/${orgId}/projects`, {
      token: ownerSessionToken,
      body: { project: projectId },
    });

    const connectRes = await callStudio(`/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, {
      token: ownerSessionToken,
      body: {
        token: VALID_CF_TOKEN,
        projectId,
      },
    });
    expect(connectRes.status).toBe(201);

    // Seed core-auth, dynamic-entities, workflow-engine, and an initial workflow
    const ops1Res = await callStudio(`/api/projects/${projectId}/ops`, {
      token: ownerSessionToken,
      headers: { "x-org-id": orgId },
      body: {
        summary: "Seed blueprint with workflow v1",
        ops: [
          {
            opId: "op_brick_ws",
            type: "enable_brick",
            brickId: "multi-workspace",
            config: {},
          },
          {
            opId: "op_brick_auth",
            type: "enable_brick",
            brickId: "core-auth",
            config: {},
          },
          {
            opId: "op_brick_ent",
            type: "enable_brick",
            brickId: "dynamic-entities",
            config: {},
          },
          {
            opId: "op_brick_wallet",
            type: "enable_brick",
            brickId: "credit-wallet",
            config: {},
          },
          {
            opId: "op_brick_notif",
            type: "enable_brick",
            brickId: "in-app-notifications",
            config: {},
          },
          { opId: "op_id_mode", type: "set_identity", identity: "core-auth" },
          {
            opId: "op_ent_orders",
            type: "add_entity",
            entity: {
              name: "orders",
              workspaceScoped: true,
              fields: [{ name: "total", type: "text", required: true }],
            },
          },
          {
            opId: "op_wf_order_notify",
            type: "add_workflow",
            workflow: {
              id: "wf-order-notify",
              name: "Order Notify Workflow",
              nodes: [
                {
                  id: "n_trigger",
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
                  source: "n_trigger",
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
    expect(ops1Res.status).toBe(200);

    for (const secName of ["BETTER_AUTH_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]) {
      const secretRes = await callStudio(`/api/projects/${projectId}/secrets`, {
        token: ownerSessionToken,
        headers: { "x-org-id": orgId },
        body: {
          ref: `sec_${secName.toLowerCase()}`,
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

    // 1. Deploy initial revision to preview -> calls assemble() once and caches in `builds` table
    const previewDeploy1Res = await callStudio(`/api/projects/${projectId}/environments/preview/deploy`, {
      token: ownerSessionToken,
      headers: { "x-org-id": orgId },
      body: {},
    });
    expect(previewDeploy1Res.status).toBe(200);
    const previewDeploy1 = (await previewDeploy1Res.json()) as {
      ok: true;
      deployId: string;
      revision: number;
      buildHash: string;
      codeHash: string;
      graphHash: string;
      action: string;
      statusMessage: string;
      reusedCachedBuild: boolean;
      assembleCount: number;
      liveWithoutRedeploy: boolean;
      noChanges: boolean;
      mutatingCallCount: number;
      scriptUploadCount: number;
      steps: Array<{ stepName: string; action: string }>;
      deployment: { versionId: string };
    };

    expect(previewDeploy1.ok).toBe(true);
    expect(previewDeploy1.action).toBe("create");
    expect(previewDeploy1.reusedCachedBuild).toBe(false);
    expect(previewDeploy1.assembleCount).toBe(1);
    expect(getProjectAssembleCount(projectId, previewDeploy1.revision)).toBe(1);
    expect(previewDeploy1.mutatingCallCount).toBeGreaterThan(0);
    expect(previewDeploy1.scriptUploadCount).toBe(1);
    expect(previewDeploy1.steps.length).toBeGreaterThanOrEqual(4);

    // Verify `builds`, `deployments`, and `deployment_steps` tables in STUDIO_DB
    const cachedBuildRow = await studioDb
      .prepare("SELECT build_hash, code_hash, graph_hash, assemble_count FROM builds WHERE build_hash = ?")
      .bind(previewDeploy1.buildHash)
      .first<{
        build_hash: string;
        code_hash: string;
        graph_hash: string;
        assemble_count: number;
      }>();
    expect(cachedBuildRow?.build_hash).toBe(previewDeploy1.buildHash);
    expect(cachedBuildRow?.code_hash).toBe(previewDeploy1.codeHash);
    expect(cachedBuildRow?.graph_hash).toBe(previewDeploy1.graphHash);
    expect(Number(cachedBuildRow?.assemble_count)).toBe(1);

    const ledgerStepsRows = await studioDb
      .prepare("SELECT step_name, action FROM deployment_steps WHERE deploy_id = ? ORDER BY step_order ASC")
      .bind(previewDeploy1.deployId)
      .all<{ step_name: string; action: string }>();
    expect((ledgerStepsRows.results ?? []).length).toBeGreaterThanOrEqual(4);

    // 2. Idempotent re-deploy of the same revision to preview -> action: "noop", 0 mutating calls, "No changes"
    const previewRedeployRes = await callStudio(`/api/projects/${projectId}/environments/preview/deploy`, {
      token: ownerSessionToken,
      headers: { "x-org-id": orgId },
      body: {},
    });
    expect(previewRedeployRes.status).toBe(200);
    const previewRedeploy = (await previewRedeployRes.json()) as typeof previewDeploy1;
    expect(previewRedeploy.action).toBe("noop");
    expect(previewRedeploy.noChanges).toBe(true);
    expect(previewRedeploy.statusMessage).toBe("No changes");
    expect(previewRedeploy.mutatingCallCount).toBe(0);
    expect(previewRedeploy.reusedCachedBuild).toBe(true);
    expect(previewRedeploy.assembleCount).toBe(1);
    expect(previewRedeploy.scriptUploadCount).toBe(1);

    // 3. Promote from preview to production via POST /api/projects/:project/environments/production/promote
    // Asserts identical buildHash and 0 second assemble() invocation
    const promoteRes = await callStudio(`/api/projects/${projectId}/environments/production/promote`, {
      token: ownerSessionToken,
      headers: { "x-org-id": orgId },
      body: {},
    });
    expect(promoteRes.status).toBe(200);
    const promoteBody = (await promoteRes.json()) as typeof previewDeploy1 & {
      promotedFromEnv?: string;
    };
    expect(promoteBody.ok).toBe(true);
    expect(promoteBody.buildHash).toBe(previewDeploy1.buildHash);
    expect(promoteBody.codeHash).toBe(previewDeploy1.codeHash);
    expect(promoteBody.graphHash).toBe(previewDeploy1.graphHash);
    expect(promoteBody.reusedCachedBuild).toBe(true);
    expect(promoteBody.promotedFromEnv).toBe("preview");
    expect(promoteBody.assembleCount).toBe(1);
    expect(getProjectAssembleCount(projectId, previewDeploy1.revision)).toBe(1);
    // Total Worker script uploads across preview + production is now 2 (1 for preview, 1 for production)
    expect(promoteBody.scriptUploadCount).toBe(2);

    // Verify workflow run before graph edit debits amount: 15 (balance 100 -> 85)
    const runV1Res = await callStudio(`/api/projects/${projectId}/workflows/wf-order-notify/run`, {
      token: ownerSessionToken,
      headers: { "x-org-id": orgId },
      body: {
        env: "preview",
        useDeployedGraph: true,
        triggerPayload: { orderId: "ord_1", balance: 100 },
      },
    });
    expect(runV1Res.status).toBe(200);
    const runV1Body = (await runV1Res.json()) as {
      ok: boolean;
      outputs: Record<string, Record<string, unknown>>;
    };
    expect(runV1Body.ok).toBe(true);
    expect((runV1Body.outputs.n_debit?.out as { debited?: number } | undefined)?.debited).toBe(15);

    // 4. Edit ONLY the workflow node in the next revision -> codeHash stays identical, graphHash changes
    const ops2Res = await callStudio(`/api/projects/${projectId}/ops`, {
      token: ownerSessionToken,
      headers: { "x-org-id": orgId },
      body: {
        summary: "Update workflow debit node amount to 40",
        ops: [
          {
            opId: "op_update_wf_v2",
            type: "update_node",
            workflowId: "wf-order-notify",
            nodeId: "n_debit",
            data: {
              amount: 40,
            },
          },
        ],
      },
    });
    expect(ops2Res.status).toBe(200);

    // Verify preview plan shows action === "hot_apply_graphs" and liveWithoutRedeploy === true
    const hotPlanRes = await callStudio(`/api/projects/${projectId}/environments/preview/plan`, {
      token: ownerSessionToken,
      headers: { "x-org-id": orgId },
      body: {},
    });
    expect(hotPlanRes.status).toBe(200);
    const hotPlan = (await hotPlanRes.json()) as {
      action: string;
      codeHash: string;
      graphHash: string;
      liveWithoutRedeploy: boolean;
      worker: { changed: boolean };
    };
    expect(hotPlan.codeHash).toBe(previewDeploy1.codeHash);
    expect(hotPlan.graphHash).not.toBe(previewDeploy1.graphHash);
    expect(hotPlan.action).toBe("hot_apply_graphs");
    expect(hotPlan.liveWithoutRedeploy).toBe(true);
    expect(hotPlan.worker.changed).toBe(false);

    // Execute hot-apply deploy on preview -> 0 additional Worker script uploads, versionId unchanged
    const hotApplyRes = await callStudio(`/api/projects/${projectId}/environments/preview/deploy`, {
      token: ownerSessionToken,
      headers: { "x-org-id": orgId },
      body: {},
    });
    expect(hotApplyRes.status).toBe(200);
    const hotApplyBody = (await hotApplyRes.json()) as typeof previewDeploy1;
    expect(hotApplyBody.action).toBe("hot_apply_graphs");
    expect(hotApplyBody.liveWithoutRedeploy).toBe(true);
    expect(hotApplyBody.statusMessage).toBe("Live without redeploy");
    expect(hotApplyBody.codeHash).toBe(previewDeploy1.codeHash);
    expect(hotApplyBody.graphHash).toBe(hotPlan.graphHash);
    expect(hotApplyBody.deployment.versionId).toBe(previewDeploy1.deployment.versionId);
    // Still 2 total script uploads (1 preview + 1 production; 0 added by hot-apply!)
    expect(hotApplyBody.scriptUploadCount).toBe(2);

    // 5. Next /run call executes the hot-applied v2 graph (debits 40 instead of 15)
    const runV2Res = await callStudio(`/api/projects/${projectId}/workflows/wf-order-notify/run`, {
      token: ownerSessionToken,
      headers: { "x-org-id": orgId },
      body: {
        env: "preview",
        useDeployedGraph: true,
        triggerPayload: { orderId: "ord_2", balance: 100 },
      },
    });
    expect(runV2Res.status).toBe(200);
    const runV2Body = (await runV2Res.json()) as {
      ok: boolean;
      outputs: Record<string, Record<string, unknown>>;
    };
    expect(runV2Body.ok).toBe(true);
    expect((runV2Body.outputs.n_debit?.out as { debited?: number } | undefined)?.debited).toBe(40);
  });
});
