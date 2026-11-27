import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { app as studioApp, ensureDefaultTestAuth, ensureStudioD1Schema } from "../src/index.ts";
import type { StudioApiEnv } from "../src/index.ts";
import { activateTestSandbox } from "./sandbox-data-store.ts";

const studioEnv = env as unknown as StudioApiEnv;

let activeSessionToken = "";
let activeOrgId = "org_default";

async function ensureHumanTestOwner(): Promise<void> {
  const email = `audit-owner-${Date.now().toString(36)}@example.com`;
  const res = await studioApp.request(
    "/api/auth/signup",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "Password123!",
        name: "Audit Owner",
      }),
    },
    studioEnv,
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { token: string; user: { id: string } };
  activeSessionToken = body.token;
  activeOrgId = `org_personal_${body.user.id}`;
}

async function studioReq(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${activeSessionToken}`);
  }
  if (!headers.has("x-org-id")) {
    headers.set("x-org-id", activeOrgId);
  }
  if (!headers.has("cf-connecting-ip")) {
    headers.set("cf-connecting-ip", "203.0.113.42");
  }
  return studioApp.request(path, { ...init, headers }, studioEnv);
}

describe("Story 8.2 — Immutable Audit Log & All 8 Privileged Action Categories (AC 2)", () => {
  beforeEach(async () => {
    await ensureStudioD1Schema(studioEnv.STUDIO_DB);
    await ensureDefaultTestAuth(studioEnv);
    await ensureHumanTestOwner();
  });

  test("All 8 privileged action categories write immutable rows to studio_audit_logs with actor, target_ref, metadata_json, and ip_hash", async () => {
    const suffix = Date.now().toString(36);
    const project = `audit-log-proj-${suffix}`;
    const orgId = activeOrgId;

    // Category 1: Blueprint ops (project.ops)
    const opsRes = await studioReq(`/api/projects/${project}/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: [
          { opId: "op-0", type: "enable_brick", brickId: "core-auth" },
          { opId: "op-00", type: "set_identity", identity: "core-auth" },
          { opId: "op-1", type: "enable_brick", brickId: "multi-workspace" },
          { opId: "op-2", type: "enable_brick", brickId: "dynamic-entities" },
          {
            opId: "op-3",
            type: "add_entity",
            entity: {
              name: "audit_items",
              fields: [{ name: "title", type: "text", required: true }],
            },
          },
        ],
      }),
    });
    expect(opsRes.status).toBe(200);

    // Seed core-auth secrets so preview deploy and production promotion pass readiness checks
    for (const secretName of ["BETTER_AUTH_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]) {
      const authSecretRes = await studioReq(`/api/projects/${project}/secrets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ref: `sec_${secretName.toLowerCase()}`,
          label: secretName,
          kind: "brick_secret",
          appOrBrick: "core-auth",
          value: `${secretName}-for-production-promote-0123456789`,
        }),
      });
      expect(authSecretRes.status).toBe(200);
    }

    // Category 2: Proposal accept & reject (proposal.accept, proposal.reject)
    const propAcceptCreate = await studioReq(`/api/projects/${project}/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        summary: "Agent proposal to accept",
        author: { type: "agent", id: "claude-code", client: "claude-code" },
        ops: [
          {
            opId: "prop-op-1",
            type: "configure_brick",
            brickId: "multi-workspace",
            config: {},
          },
        ],
      }),
    });
    expect(propAcceptCreate.status).toBe(200);
    const { proposalId: acceptPropId } = (await propAcceptCreate.json()) as {
      proposalId: string;
    };

    const acceptRes = await studioReq(`/api/projects/${project}/proposals/${acceptPropId}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(acceptRes.status).toBe(200);

    const propRejectCreate = await studioReq(`/api/projects/${project}/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        summary: "Agent proposal to reject",
        author: { type: "agent", id: "cursor", client: "cursor" },
        ops: [
          {
            opId: "prop-op-2",
            type: "configure_brick",
            brickId: "dynamic-entities",
            config: {},
          },
        ],
      }),
    });
    expect(propRejectCreate.status).toBe(200);
    const { proposalId: rejectPropId } = (await propRejectCreate.json()) as {
      proposalId: string;
    };

    const rejectRes = await studioReq(`/api/projects/${project}/proposals/${rejectPropId}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Not needed" }),
    });
    expect(rejectRes.status).toBe(200);

    // Category 4 (part 1): Cloudflare token create (cloudflare_token.create)
    const cfAccountId = "0123456789abcdef0123456789abcdef";
    const cfTokenRes = await studioReq(`/api/orgs/${orgId}/cloudflare-tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        apiToken: "cf_valid_token_audit_log_test_1234567890",
        accountId: cfAccountId,
        accountName: "Audit Test Cloudflare Account",
      }),
    });
    expect(cfTokenRes.status).toBe(201);
    const cfTokenData = (await cfTokenRes.json()) as {
      token: { tokenRef: string };
    };
    const tokenRef = cfTokenData.token.tokenRef;

    // Category 3 & Category 4 (part 2): Build, deploy, promote, rollback + cloudflare_token.use
    const buildRes = await studioReq(`/api/projects/${project}/build`, {
      method: "POST",
    });
    expect(buildRes.status).toBe(200);

    const deployRes1 = await studioReq(`/api/projects/${project}/environments/preview/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(deployRes1.status).toBe(200);
    const { deployId: firstDeployId } = (await deployRes1.json()) as {
      deployId: string;
    };
    expect(firstDeployId).toBeTruthy();

    // Apply a second op & deploy so rollback has 2 versions
    await studioReq(`/api/projects/${project}/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: [
          {
            opId: "op-4",
            type: "update_entity",
            entity: {
              name: "audit_items",
              fields: [
                { name: "title", type: "text", required: true },
                { name: "notes", type: "text", required: false },
              ],
            },
          },
        ],
      }),
    });
    const deployRes2 = await studioReq(`/api/projects/${project}/environments/preview/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(deployRes2.status).toBe(200);

    const promoteRes = await studioReq(`/api/projects/${project}/environments/production/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(promoteRes.status).toBe(200);

    const rollbackRes = await studioReq(`/api/projects/${project}/environments/preview/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetDeploymentId: firstDeployId,
        confirmDestructive: true,
      }),
    });
    expect(rollbackRes.status).toBe(200);

    // Category 4 (part 3): Cloudflare token revoke (cloudflare_token.revoke)
    const cfRevokeRes = await studioReq(`/api/orgs/${orgId}/cloudflare-tokens/${tokenRef}`, {
      method: "DELETE",
    });
    expect(cfRevokeRes.status).toBe(200);

    // Category 5: Connection create, reauthorize, delete
    const connCreateRes = await studioReq(`/api/projects/${project}/connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: "conn_slack_default",
        app: "slack",
        authType: "apiKey",
        value: "xox" + "b-audit-log-token-123456",
      }),
    });
    expect(connCreateRes.status).toBe(200);

    const connReauthRes = await studioReq(`/api/projects/${project}/connections/conn_slack_default/reauthorize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        app: "slack",
        authType: "apiKey",
        value: "xox" + "b-audit-log-token-rotated-789012",
      }),
    });
    expect(connReauthRes.status).toBe(200);

    const connDeleteRes = await studioReq(`/api/projects/${project}/connections/conn_slack_default?env=preview`, {
      method: "DELETE",
    });
    expect(connDeleteRes.status).toBe(200);

    // Category 6: MCP token issue & revoke (org.mcp_token.create, org.mcp_token.revoke)
    const mcpCreateRes = await studioReq(`/api/orgs/${orgId}/mcp-tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `audit-mcp-${suffix}`,
        projectId: project,
        scopes: ["read", "edit"],
      }),
    });
    expect(mcpCreateRes.status).toBe(201);
    const mcpCreated = (await mcpCreateRes.json()) as { id: string };

    const mcpRevokeRes = await studioReq(`/api/orgs/${orgId}/mcp-tokens/${mcpCreated.id}`, {
      method: "DELETE",
    });
    expect(mcpRevokeRes.status).toBe(200);

    // Category 7: Data Browser row insert, update, delete
    // Story 17: the Data Browser writes to the project's own data store (the active sandbox D1), never STUDIO_DB.
    // Activate a sandbox and create the ent_audit_items table there so Data Browser mutations succeed.
    const sandbox = await activateTestSandbox(studioEnv.STUDIO_DB, { project, orgId });
    await sandbox.rawD1.prepare(`CREATE TABLE IF NOT EXISTS ent_audit_items (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL);`).run();

    const rowInsertRes = await studioReq(`/api/projects/${project}/environments/preview/data/tables/audit_items/rows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "ws_default",
        confirmWrite: true,
        row: { id: `item_${suffix}`, title: "Initial Title" },
      }),
    });
    expect(rowInsertRes.status).toBe(201);

    const rowUpdateRes = await studioReq(`/api/projects/${project}/environments/preview/data/tables/audit_items/rows/item_${suffix}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "ws_default",
        confirmWrite: true,
        patch: { title: "Updated Title" },
      }),
    });
    expect(rowUpdateRes.status).toBe(200);

    const rowDeleteRes = await studioReq(`/api/projects/${project}/environments/preview/data/tables/audit_items/rows/item_${suffix}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "ws_default",
        confirmWrite: true,
      }),
    });
    expect(rowDeleteRes.status).toBe(200);

    // Category 8: Retention & privacy settings change (project.retention_settings.update)
    const retentionUpdateRes = await studioReq(`/api/projects/${project}/settings/retention`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runRetentionDays: 30,
        telemetryRetentionDays: 14,
        captureStepIoInProd: false,
        additionalRedactKeys: ["tax_id", "customer_pin"],
      }),
    });
    expect(retentionUpdateRes.status).toBe(200);

    // Verify studio_audit_logs rows in D1 across all 8 categories
    const rowsRes = await studioEnv.STUDIO_DB.prepare(
      `SELECT id, ts, org_id, project_id, actor, action, target_ref, metadata_json, ip_hash
       FROM studio_audit_logs
       WHERE org_id = ?1
       ORDER BY ts DESC, rowid DESC`,
    )
      .bind(orgId)
      .all<{
        id: string;
        ts: string;
        org_id: string;
        project_id: string | null;
        actor: string;
        action: string;
        target_ref: string | null;
        metadata_json: string;
        ip_hash: string;
      }>();

    const rows = rowsRes.results ?? [];
    const actions = new Set(rows.map((r) => r.action));

    const expectedActions = [
      // Category 1
      "project.ops",
      // Category 2
      "project.proposal.accept",
      "project.proposal.reject",
      // Category 3
      "project.build",
      "environment.deploy",
      "environment.promote",
      "environment.rollback",
      // Category 4
      "cloudflare_token.create",
      "cloudflare_token.use",
      "cloudflare_token.revoke",
      // Category 5
      "connection.upsert",
      "connection.reauthorize",
      "connection.delete",
      // Category 6
      "org.mcp_token.create",
      "org.mcp_token.revoke",
      // Category 7
      "data_browser.insert",
      "data_browser.update",
      "data_browser.delete",
      // Category 8
      "project.retention_settings.update",
    ];

    for (const expectedAction of expectedActions) {
      expect(actions.has(expectedAction), `Expected studio_audit_logs to contain action "${expectedAction}". Present: ${[...actions].join(", ")}`).toBe(true);
    }

    // Verify required columns on every row
    for (const row of rows) {
      expect(row.id).toMatch(/^audit_/);
      expect(row.ts).toBeTruthy();
      expect(row.org_id).toBe(orgId);
      expect(row.actor).toMatch(/^(user|agent|system):/);
      expect(row.ip_hash).toMatch(/^sha256:[0-9a-f]{16}$/);
      expect(() => JSON.parse(row.metadata_json)).not.toThrow();
    }

    // Verify GET /api/projects/:project/audit-logs and GET /api/orgs/:orgId/audit-logs
    const projAuditRes = await studioReq(`/api/projects/${project}/audit-logs`);
    expect(projAuditRes.status).toBe(200);
    const projAuditBody = (await projAuditRes.json()) as {
      auditLogs: Array<{ action: string; projectId: string }>;
    };
    expect(projAuditBody.auditLogs.length).toBeGreaterThanOrEqual(10);
    expect(projAuditBody.auditLogs.every((entry) => entry.projectId === project)).toBe(true);

    const orgAuditRes = await studioReq(`/api/orgs/${orgId}/audit-logs`);
    expect(orgAuditRes.status).toBe(200);
    const orgAuditBody = (await orgAuditRes.json()) as {
      auditLogs: Array<{ action: string; orgId: string }>;
    };
    expect(orgAuditBody.auditLogs.length).toBeGreaterThanOrEqual(expectedActions.length);
  });

  test("studio_audit_logs is strictly append-only: SQLite BEFORE UPDATE and BEFORE DELETE triggers reject mutations with AUDIT_LOG_IMMUTABLE", async () => {
    const project = `audit-immutable-${Date.now().toString(36)}`;
    const res = await studioReq(`/api/projects/${project}/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: [{ opId: "imm-1", type: "enable_brick", brickId: "multi-workspace" }],
      }),
    });
    expect(res.status).toBe(200);

    const latestRow = await studioEnv.STUDIO_DB.prepare(`SELECT id, action FROM studio_audit_logs WHERE project_id = ?1 LIMIT 1`)
      .bind(project)
      .first<{ id: string; action: string }>();
    expect(latestRow).toBeTruthy();

    await expect(
      studioEnv.STUDIO_DB.prepare(`UPDATE studio_audit_logs SET action = 'tampered.action' WHERE id = ?1`).bind(latestRow!.id).run(),
    ).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/);

    await expect(studioEnv.STUDIO_DB.prepare(`DELETE FROM studio_audit_logs WHERE id = ?1`).bind(latestRow!.id).run()).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/);

    // Verify the row remains untouched
    const verifyRow = await studioEnv.STUDIO_DB.prepare(`SELECT id, action FROM studio_audit_logs WHERE id = ?1`)
      .bind(latestRow!.id)
      .first<{ id: string; action: string }>();
    expect(verifyRow?.action).toBe(latestRow!.action);
  });
});
