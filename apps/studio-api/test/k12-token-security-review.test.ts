import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { ensureTelemetryTables } from "@poc/telemetry";
import studioAuthOrgsSql from "../migrations/0001_studio_auth_orgs.sql?raw";
import studioSecretVaultSql from "../migrations/0002_studio_secret_vault.sql?raw";
import cp5DeployTokensSql from "../migrations/0003_cp5_deploy_tokens.sql?raw";
import {
  app as studioApp,
  createStudioTokenResolver,
  decryptToken,
  ensureStudioD1Schema,
  getStudioControlPlane,
  listDeployTokenAuditLog,
  resetStudioDeployTestState,
} from "../src/index.ts";
import type { StudioApiEnv } from "../src/index.ts";
import { createByocProvisioner } from "../../../packages/deploy/src/target.ts";
import type { DeployTarget } from "../../../packages/deploy/src/target.ts";

const rawEnv = env as unknown as StudioApiEnv;
const studioDb = rawEnv.STUDIO_DB as D1Like;

const CANARY_CF_TOKEN = "cf_canary_secret_token_9f8e7d6c5b4a";

const TEST_ENV: StudioApiEnv = {
  ...rawEnv,
  BETTER_AUTH_SECRET: "studio-test-better-auth-secret-0123456789abcdef",
  PX_VAULT_KEY: "studio-test-aes-gcm-256-vault-master-key-99887766",
  PX_TOKEN_KEK: "studio-cp5-test-master-kek-v1-256bit-key-material-0001",
  PX_TOKEN_KEK_VERSION: "1",
  PX_TELEMETRY_SECRET: "studio-cp5-k12-telemetry-hmac-secret",
  GITHUB_CLIENT_ID: "studio-gh-test-client-id",
  GITHUB_CLIENT_SECRET: "studio-gh-test-client-secret",
};

function buildCanaryVariants(canary: string): string[] {
  const b64 = btoa(canary);
  const b64NoPad = b64.replace(/=+$/g, "");
  const b64Url = b64NoPad.replace(/\+/g, "-").replace(/\//g, "_");
  const urlEncoded = encodeURIComponent(canary);
  return Array.from(new Set([canary, b64, b64NoPad, b64Url, urlEncoded]));
}

const CANARY_VARIANTS = buildCanaryVariants(CANARY_CF_TOKEN);

function assertZeroCanaryLeakage(
  surfaceName: string,
  payloadText: string,
  extraForbiddenStrings: string[] = [],
): void {
  for (const variant of CANARY_VARIANTS) {
    expect(
      payloadText.includes(variant),
      `[K12 SECURITY LEAK] Surface "${surfaceName}" leaked canary token variant "${variant}"`,
    ).toBe(false);
  }
  for (const extra of extraForbiddenStrings) {
    if (!extra) continue;
    expect(
      payloadText.includes(extra),
      `[K12 SECURITY LEAK] Surface "${surfaceName}" leaked internal ciphertext/key material "${extra}"`,
    ).toBe(false);
  }
}

interface CallOptions {
  method?: string;
  token?: string;
  orgId?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

const recordedHttpResponses: Array<{ label: string; status: number; text: string }> = [];

async function callStudio(
  path: string,
  options: CallOptions = {},
  recordLabel?: string,
): Promise<{ status: number; text: string; json: <T = unknown>() => T; headers: Headers }> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.orgId) headers.set("x-org-id", options.orgId);

  let rawBody: string | undefined;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    rawBody = JSON.stringify(options.body);
  }

  const method = options.method ?? (rawBody !== undefined ? "POST" : "GET");
  const res = await studioApp.fetch(
    new Request(`https://example.test${path}`, {
      method,
      headers,
      body: rawBody,
    }),
    TEST_ENV,
  );
  const text = await res.text();
  recordedHttpResponses.push({
    label: recordLabel ?? `${method} ${path}`,
    status: res.status,
    text,
  });
  return {
    status: res.status,
    text,
    json: <T = unknown>() => JSON.parse(text) as T,
    headers: res.headers,
  };
}

let mcpRpcId = 1;
async function callStudioMcp(
  toolName: string,
  args: Record<string, unknown>,
  token: string,
  orgId: string,
): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  const res = await callStudio(
    "/mcp",
    {
      method: "POST",
      token,
      orgId,
      body: {
        jsonrpc: "2.0",
        id: mcpRpcId++,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args,
        },
      },
    },
    `MCP tools/call ${toolName}`,
  );
  return {
    status: res.status,
    text: res.text,
    body: res.json<Record<string, unknown>>(),
  };
}

describe("Story 5.6 — K12 Cloudflare Token Custody Security Review & End-to-End Leak Scan", () => {
  beforeEach(async () => {
    recordedHttpResponses.length = 0;
    resetStudioDeployTestState();
    await applyMigration(studioDb, studioAuthOrgsSql);
    await applyMigration(studioDb, studioSecretVaultSql);
    await applyMigration(studioDb, cp5DeployTokensSql);
    await ensureStudioD1Schema(studioDb);
    await ensureTelemetryTables(studioDb);
    await studioDb.batch([
      studioDb.prepare("DELETE FROM px_step_events"),
      studioDb.prepare("DELETE FROM px_runs"),
      studioDb.prepare("DELETE FROM deployment_steps"),
      studioDb.prepare("DELETE FROM deployments"),
      studioDb.prepare("DELETE FROM builds"),
      studioDb.prepare("DELETE FROM studio_builds"),
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
  });

  test("plants cf_canary_secret_token_9f8e7d6c5b4a via Connect Cloudflare wizard, executes full CP5 deploy/promote/putGraph/drift/rollback/export/run/MCP lifecycle, proves 0 canary leakage across all SQLite/HTTP/WS/MCP surfaces, and enforces immediate TOKEN_REVOKED refusal with 0 outbound Cloudflare calls", async () => {
    const project = "cp5-k12-canary-sec";

    // 1. Sign up human Owner, create Org, create Project, and issue scoped MCP token
    const signupRes = await callStudio("/api/auth/signup", {
      body: {
        email: "security-reviewer@projectx.test",
        password: "K12ReviewerPassword123!",
        displayName: "K12 Security Reviewer",
      },
    });
    expect(signupRes.status).toBe(201);
    const ownerSession = signupRes.json<{
      token: string;
      user: { id: string };
    }>();
    const ownerToken = ownerSession.token;

    const orgRes = await callStudio("/api/orgs", {
      token: ownerToken,
      body: {
        name: "K12 Security Audit Org",
        slug: "k12-security-audit-org",
      },
    });
    expect(orgRes.status).toBe(201);
    const orgId = orgRes.json<{ id: string }>().id;

    const createProjRes = await callStudio(`/api/orgs/${orgId}/projects`, {
      token: ownerToken,
      orgId,
      body: { project },
    });
    expect(createProjRes.status).toBe(201);

    const mcpTokenRes = await callStudio(`/api/orgs/${orgId}/mcp-tokens`, {
      token: ownerToken,
      orgId,
      body: {
        userId: ownerSession.user.id,
        clientName: "k12-audit-agent",
        projectId: project,
        scopes: ["read", "edit", "connect"],
      },
    });
    expect(mcpTokenRes.status).toBe(201);
    const mcpToken = mcpTokenRes.json<{ token: string }>().token;

    // 2. Open WebSocket to BlueprintDO to record all real-time broadcast frames
    const wsUpgradeRes = await studioApp.fetch(
      new Request(`https://example.test/api/projects/${project}/ws`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${ownerToken}`,
          "x-org-id": orgId,
          Upgrade: "websocket",
        },
      }),
      TEST_ENV,
    );
    expect(wsUpgradeRes.status).toBe(101);
    const wsClient = (wsUpgradeRes as unknown as { webSocket: WebSocket }).webSocket;
    expect(wsClient).toBeDefined();
    wsClient.accept();

    const wsFrames: string[] = [];
    wsClient.addEventListener("message", (event) => {
      wsFrames.push(
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer),
      );
    });

    // 3. Seed Blueprint r1 with bricks, entity, and workflow + required brick secrets
    const seedOpsRes = await callStudio(`/api/projects/${project}/ops`, {
      token: ownerToken,
      orgId,
      body: {
        summary: "Seed K12 security review blueprint r1",
        ops: [
          {
            opId: "op_k12_ws",
            type: "enable_brick",
            brickId: "multi-workspace",
            config: {},
          },
          {
            opId: "op_k12_auth",
            type: "enable_brick",
            brickId: "core-auth",
            config: {},
          },
          {
            opId: "op_k12_ent",
            type: "enable_brick",
            brickId: "dynamic-entities",
            config: {},
          },
          {
            opId: "op_k12_wallet",
            type: "enable_brick",
            brickId: "credit-wallet",
            config: {},
          },
          {
            opId: "op_k12_notif",
            type: "enable_brick",
            brickId: "in-app-notifications",
            config: {},
          },
          {
            opId: "op_k12_identity",
            type: "set_identity",
            identity: "core-auth",
          },
          {
            opId: "op_k12_orders",
            type: "add_entity",
            entity: {
              name: "orders",
              workspaceScoped: true,
              fields: [{ name: "total", type: "text", required: true }],
            },
          },
          {
            opId: "op_k12_wf",
            type: "add_workflow",
            workflow: {
              id: "wf_k12_orders",
              name: "K12 Order Pipeline",
              nodes: [
                {
                  id: "n_webhook",
                  type: "core.webhook",
                  label: "Order Webhook",
                  data: { method: "post" },
                },
                {
                  id: "n_debit",
                  type: "credit-wallet.debit",
                  label: "Debit Credits",
                  data: { amount: 10 },
                },
              ],
              edges: [
                {
                  id: "e_webhook_debit",
                  source: "n_webhook",
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
    expect(seedOpsRes.status).toBe(200);

    for (const secName of [
      "BETTER_AUTH_SECRET",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
    ]) {
      const secRes = await callStudio(`/api/projects/${project}/secrets`, {
        token: ownerToken,
        orgId,
        body: {
          ref: `sec_${secName.toLowerCase()}`,
          kind: "brick_secret",
          label: secName,
          appOrBrick: "core-auth",
          value: `brick_secret_${secName.toLowerCase()}_val_9988`,
          bindTarget: {
            targetKind: "brick",
            targetId: "core-auth",
            secretName: secName,
          },
        },
      });
      expect(secRes.status).toBe(200);
    }

    // 4. Plant CANARY_CF_TOKEN (`cf_canary_secret_token_9f8e7d6c5b4a`) through the Connect Cloudflare wizard
    await callStudio(`/api/orgs/${orgId}/cloudflare-tokens/funnel-event`, {
      token: ownerToken,
      orgId,
      body: { step: "wizard_opened", projectId: project },
    });
    await callStudio(`/api/orgs/${orgId}/cloudflare-tokens/funnel-event`, {
      token: ownerToken,
      orgId,
      body: { step: "template_link_clicked", projectId: project },
    });

    const connectRes = await callStudio(
      `/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`,
      {
        token: ownerToken,
        orgId,
        body: {
          token: CANARY_CF_TOKEN,
          accountId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
          accountName: "K12 Canary BYOC Account",
          projectId: project,
        },
      },
    );
    expect(connectRes.status).toBe(201);
    const connectBody = connectRes.json<{
      ok: true;
      tokenRef: string;
      accountId: string;
      token: { tokenLast4: string; status: string; kekVersion: number };
    }>();
    const tokenRef = connectBody.tokenRef;
    const accountId = connectBody.accountId;
    expect(tokenRef).toMatch(/^tok_/);
    expect(connectBody.token.tokenLast4).toBe("5b4a");
    expect(connectBody.token.status).toBe("active");
    expect(connectBody.token.kekVersion).toBe(1);
    assertZeroCanaryLeakage("POST /cloudflare-tokens/verify-and-save", connectRes.text);

    // 5. Inspect deploy_tokens BEFORE revocation: only AES-256-GCM ciphertext & wrapped_dek exist, 0 plaintext occurrences
    const preRevokeTokenRow = await studioDb
      .prepare(
        "SELECT token_ref, org_id, account_id, token_last4, status, ciphertext, iv, wrapped_dek, dek_iv, kek_version, revoked_at FROM deploy_tokens WHERE token_ref = ?",
      )
      .bind(tokenRef)
      .first<{
        token_ref: string;
        org_id: string;
        account_id: string;
        token_last4: string;
        status: string;
        ciphertext: string | null;
        iv: string | null;
        wrapped_dek: string | null;
        dek_iv: string | null;
        kek_version: number;
        revoked_at: string | null;
      }>();
    expect(preRevokeTokenRow).not.toBeNull();
    expect(preRevokeTokenRow!.status).toBe("active");
    expect(preRevokeTokenRow!.ciphertext).toBeTruthy();
    expect(preRevokeTokenRow!.wrapped_dek).toBeTruthy();
    expect(atob(preRevokeTokenRow!.iv!).length).toBe(12);
    expect(atob(preRevokeTokenRow!.dek_iv!).length).toBe(12);
    expect(preRevokeTokenRow!.kek_version).toBe(1);
    expect(preRevokeTokenRow!.revoked_at).toBeNull();
    assertZeroCanaryLeakage(
      "D1 deploy_tokens row (active pre-revocation)",
      JSON.stringify(preRevokeTokenRow),
    );

    const activeCiphertext = preRevokeTokenRow!.ciphertext!;
    const activeWrappedDek = preRevokeTokenRow!.wrapped_dek!;

    // Verify decryptToken recovers CANARY_CF_TOKEN and writes an audit entry
    const unsealedInStep = await decryptToken(
      studioDb,
      tokenRef,
      {
        actor: ownerSession.user.id,
        deployId: "dep_k12_verify_step",
        action: "verify_step_decrypt",
      },
      TEST_ENV,
    );
    expect(unsealedInStep).toBe(CANARY_CF_TOKEN);

    // 6. Run Pre-deploy `plan` on preview
    const planRes = await callStudio(
      `/api/projects/${project}/environments/preview/plan`,
      {
        token: ownerToken,
        orgId,
        body: {},
      },
    );
    expect(planRes.status).toBe(200);
    assertZeroCanaryLeakage("POST /environments/preview/plan", planRes.text, [
      activeCiphertext,
      activeWrappedDek,
    ]);

    // 7. Run `deploy` to `preview` (v1)
    const deployPreviewV1Res = await callStudio(
      `/api/projects/${project}/environments/preview/deploy`,
      {
        token: ownerToken,
        orgId,
        body: {},
      },
    );
    expect(deployPreviewV1Res.status).toBe(200);
    const deployPreviewV1 = deployPreviewV1Res.json<{
      ok: true;
      deployId: string;
      buildHash: string;
      codeHash: string;
      graphHash: string;
    }>();
    expect(deployPreviewV1.ok).toBe(true);

    // 8. Run `promote` from `preview` to `production`
    const promoteProdRes = await callStudio(
      `/api/projects/${project}/environments/production/promote`,
      {
        token: ownerToken,
        orgId,
        body: {},
      },
    );
    expect(promoteProdRes.status).toBe(200);
    const promoteProd = promoteProdRes.json<{
      ok: true;
      buildHash: string;
      reusedCachedBuild: boolean;
    }>();
    expect(promoteProd.ok).toBe(true);
    expect(promoteProd.buildHash).toBe(deployPreviewV1.buildHash);
    expect(promoteProd.reusedCachedBuild).toBe(true);

    // 9. Run workflow-only edit + `putGraph` / hot-apply on `preview` (v2)
    const wfEditRes = await callStudio(`/api/projects/${project}/ops`, {
      token: ownerToken,
      orgId,
      body: {
        summary: "Update workflow debit amount for graph-only hot-apply",
        ops: [
          {
            opId: "op_k12_wf_hot_apply",
            type: "update_node",
            workflowId: "wf_k12_orders",
            nodeId: "n_debit",
            data: { amount: 25 },
          },
        ],
      },
    });
    expect(wfEditRes.status).toBe(200);

    const hotApplyRes = await callStudio(
      `/api/projects/${project}/environments/preview/deploy`,
      {
        token: ownerToken,
        orgId,
        body: {},
      },
    );
    expect(hotApplyRes.status).toBe(200);
    const hotApplyBody = hotApplyRes.json<{
      ok: true;
      deployId: string;
      action: string;
      liveWithoutRedeploy: boolean;
    }>();
    expect(hotApplyBody.action).toBe("hot_apply_graphs");
    expect(hotApplyBody.liveWithoutRedeploy).toBe(true);

    // Also invoke provisioner.putGraph directly to exercise the standalone putGraph entrypoint
    const controlPlane = getStudioControlPlane(accountId);
    const provisioner = createByocProvisioner({
      apiClient: controlPlane,
      resolveToken: createStudioTokenResolver(studioDb, TEST_ENV),
    });
    const previewTarget: DeployTarget = {
      type: "byoc",
      accountId,
      tokenRef,
      envName: "preview",
    };
    await provisioner.putGraph({
      target: previewTarget,
      project,
      actor: ownerSession.user.id,
      deployId: "dep_k12_direct_put_graph",
      graphHash: deployPreviewV1.graphHash,
      graphs: {
        wf_k12_orders: JSON.stringify({ id: "wf_k12_orders", amount: 25 }),
      },
    });

    // 10. Run `check-drift` on `preview`
    const checkDriftRes = await callStudio(
      `/api/projects/${project}/environments/preview/check-drift`,
      {
        token: ownerToken,
        orgId,
        body: {},
      },
    );
    expect(checkDriftRes.status).toBe(200);

    // 11. Run `rollback` on `preview` back to v1 deployment
    const rollbackRes = await callStudio(
      `/api/projects/${project}/environments/preview/rollback`,
      {
        token: ownerToken,
        orgId,
        body: {
          targetDeploymentId: deployPreviewV1.deployId,
        },
      },
    );
    expect(rollbackRes.status).toBe(200);
    const rollbackBody = rollbackRes.json<{
      ok: true;
      action: string;
      buildHash: string;
      reusedCachedBuild: boolean;
    }>();
    expect(rollbackBody.ok).toBe(true);
    expect(rollbackBody.action).toBe("rollback");
    expect(rollbackBody.buildHash).toBe(deployPreviewV1.buildHash);
    expect(rollbackBody.reusedCachedBuild).toBe(true);

    // 12. Run project `export` (`GET /api/projects/:project/export`)
    const exportRes = await callStudio(`/api/projects/${project}/export`, {
      method: "GET",
      token: ownerToken,
      orgId,
    });
    expect(exportRes.status).toBe(200);

    // 13. Execute a workflow run (`POST /api/projects/:project/workflows/:workflowId/runs`) to populate `px_runs` and `px_step_events`
    const runWorkflowRes = await callStudio(
      `/api/projects/${project}/workflows/wf_k12_orders/runs`,
      {
        token: ownerToken,
        orgId,
        body: {
          runId: "run_k12_canary_audit_1",
          triggerType: "manual",
          triggerPayload: { orderId: "ord_k12_100" },
        },
      },
    );
    expect(runWorkflowRes.status).toBe(200);

    const listRunsRes = await callStudio(`/api/projects/${project}/runs`, {
      method: "GET",
      token: ownerToken,
      orgId,
    });
    expect(listRunsRes.status).toBe(200);

    const runDetailRes = await callStudio(
      `/api/projects/${project}/runs/run_k12_canary_audit_1`,
      {
        method: "GET",
        token: ownerToken,
        orgId,
      },
    );
    expect(runDetailRes.status).toBe(200);

    // 14. Call MCP `get_project` and `get_history`
    const mcpGetProject = await callStudioMcp(
      "get_project",
      { project },
      mcpToken,
      orgId,
    );
    expect(mcpGetProject.status).toBe(200);
    assertZeroCanaryLeakage("MCP get_project", mcpGetProject.text, [
      activeCiphertext,
      activeWrappedDek,
    ]);

    const mcpGetHistory = await callStudioMcp(
      "get_history",
      { project },
      mcpToken,
      orgId,
    );
    expect(mcpGetHistory.status).toBe(200);
    assertZeroCanaryLeakage("MCP get_history", mcpGetHistory.text, [
      activeCiphertext,
      activeWrappedDek,
    ]);

    // Also inspect token metadata and audit log endpoints over HTTP
    const listTokensRes = await callStudio(
      `/api/orgs/${orgId}/cloudflare-tokens`,
      {
        method: "GET",
        token: ownerToken,
        orgId,
      },
    );
    expect(listTokensRes.status).toBe(200);

    const tokenAuditRes = await callStudio(
      `/api/orgs/${orgId}/cloudflare-tokens/${tokenRef}/audit`,
      {
        method: "GET",
        token: ownerToken,
        orgId,
      },
    );
    expect(tokenAuditRes.status).toBe(200);

    // 15. Revoke the token via `DELETE /api/orgs/:orgId/cloudflare-tokens/:tokenRef`
    const revokeRes = await callStudio(
      `/api/orgs/${orgId}/cloudflare-tokens/${tokenRef}`,
      {
        method: "DELETE",
        token: ownerToken,
        orgId,
      },
    );
    expect(revokeRes.status).toBe(200);
    const revokeBody = revokeRes.json<{
      ok: true;
      tokenRef: string;
      status: string;
      revokedAt: string;
    }>();
    expect(revokeBody.ok).toBe(true);
    expect(revokeBody.status).toBe("revoked");

    // 16. Assert #2: 0 occurrences of canary token in `deploy_tokens` and `ciphertext IS NULL AND wrapped_dek IS NULL` after revocation
    const postRevokeTokensDump = await studioDb
      .prepare("SELECT * FROM deploy_tokens")
      .all<Record<string, unknown>>();
    const deployTokenRows = postRevokeTokensDump.results ?? [];
    expect(deployTokenRows).toHaveLength(1);
    assertZeroCanaryLeakage(
      "D1 deploy_tokens (post-revocation dump)",
      JSON.stringify(deployTokenRows),
    );
    expect(deployTokenRows[0]).toMatchObject({
      token_ref: tokenRef,
      org_id: orgId,
      status: "revoked",
      ciphertext: null,
      iv: null,
      wrapped_dek: null,
      dek_iv: null,
    });

    // 17. Assert #1: 0 occurrences of `cf_canary_secret_token_9f8e7d6c5b4a` (raw, Base64, Base64URL, URL-encoded) in raw SQLite dumps
    const doId = TEST_ENV.BLUEPRINT_DO.idFromName(project);
    const doStub = TEST_ENV.BLUEPRINT_DO.get(doId);
    const doDumpRes = await doStub.fetch(
      `http://blueprint-do/sqlite-dump?project=${encodeURIComponent(project)}`,
      { method: "GET" },
    );
    expect(doDumpRes.status).toBe(200);
    const doSqliteDumpText = await doDumpRes.text();
    assertZeroCanaryLeakage("BlueprintDO raw SQLite dump", doSqliteDumpText, [
      activeCiphertext,
      activeWrappedDek,
    ]);

    const d1TablesToScan = [
      "builds",
      "studio_builds",
      "deployments",
      "project_deployments",
      "deployment_steps",
      "px_runs",
      "px_step_events",
      "onboarding_funnel_events",
      "deploy_token_audit_log",
      "studio_audit_log",
      "project_environments",
    ] as const;

    for (const tableName of d1TablesToScan) {
      const dump = await studioDb
        .prepare(`SELECT * FROM ${tableName}`)
        .all<Record<string, unknown>>();
      const rows = dump.results ?? [];
      expect(
        rows.length,
        `Expected table "${tableName}" to have been populated during the lifecycle test`,
      ).toBeGreaterThan(0);
      assertZeroCanaryLeakage(
        `D1 raw SQLite table "${tableName}"`,
        JSON.stringify(rows),
        [activeCiphertext, activeWrappedDek],
      );
    }

    // Verify deploy_token_audit_log recorded every token decrypt + the final revoke
    const auditEntries = await listDeployTokenAuditLog(studioDb, { tokenRef });
    expect(auditEntries.length).toBeGreaterThanOrEqual(5);
    expect(auditEntries.map((a) => a.action)).toContain("apply");
    expect(auditEntries.map((a) => a.action)).toContain("promote");
    expect(auditEntries.map((a) => a.action)).toContain("putGraph");
    expect(auditEntries.map((a) => a.action)).toContain("revoke");

    // 18. Assert #3: 0 occurrences of canary token across all HTTP responses from `studio-api`, WebSocket broadcast frames, and MCP tool responses
    expect(recordedHttpResponses.length).toBeGreaterThanOrEqual(15);
    for (const httpEntry of recordedHttpResponses) {
      assertZeroCanaryLeakage(
        `HTTP response (${httpEntry.label})`,
        httpEntry.text,
        [activeCiphertext, activeWrappedDek],
      );
    }

    expect(wsFrames.length).toBeGreaterThan(0);
    for (let i = 0; i < wsFrames.length; i += 1) {
      assertZeroCanaryLeakage(`WebSocket broadcast frame #${i + 1}`, wsFrames[i]!, [
        activeCiphertext,
        activeWrappedDek,
      ]);
    }

    // 19. Assert #4: After revocation, every call that requires the token (`plan`, `deploy`, `promote`, `check-drift`, `rollback`) immediately fails with `TOKEN_REVOKED` and makes `0` outbound calls to `CloudflareApiClient`
    controlPlane.clearCalls();

    const postRevokePlan = await callStudio(
      `/api/projects/${project}/environments/preview/plan`,
      {
        token: ownerToken,
        orgId,
        body: {},
      },
    );
    expect(postRevokePlan.status).toBe(422);
    expect(
      postRevokePlan.json<{ error: { code: string } }>().error.code,
    ).toBe("TOKEN_REVOKED");

    const postRevokeDeploy = await callStudio(
      `/api/projects/${project}/environments/preview/deploy`,
      {
        token: ownerToken,
        orgId,
        body: {},
      },
    );
    expect(postRevokeDeploy.status).toBe(422);
    expect(
      postRevokeDeploy.json<{ error: { code: string } }>().error.code,
    ).toBe("TOKEN_REVOKED");

    const postRevokePromote = await callStudio(
      `/api/projects/${project}/environments/production/promote`,
      {
        token: ownerToken,
        orgId,
        body: {},
      },
    );
    expect(postRevokePromote.status).toBe(422);
    expect(
      postRevokePromote.json<{ error: { code: string } }>().error.code,
    ).toBe("TOKEN_REVOKED");

    const postRevokeCheckDrift = await callStudio(
      `/api/projects/${project}/environments/preview/check-drift`,
      {
        token: ownerToken,
        orgId,
        body: {},
      },
    );
    expect(postRevokeCheckDrift.status).toBe(422);
    expect(
      postRevokeCheckDrift.json<{ error: { code: string } }>().error.code,
    ).toBe("TOKEN_REVOKED");

    const postRevokeRollback = await callStudio(
      `/api/projects/${project}/environments/preview/rollback`,
      {
        token: ownerToken,
        orgId,
        body: {
          targetDeploymentId: deployPreviewV1.deployId,
        },
      },
    );
    expect(postRevokeRollback.status).toBe(422);
    expect(
      postRevokeRollback.json<{ error: { code: string } }>().error.code,
    ).toBe("TOKEN_REVOKED");

    expect(controlPlane.calls).toHaveLength(0);

    try {
      wsClient.close();
    } catch {
      // Ignore close error
    }
  });
});
