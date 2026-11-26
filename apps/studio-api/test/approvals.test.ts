// AD-V8 / R56: agent changes are proposals by default; destructive actions an MCP agent asks for need a Studio approval.
//
// Every row of the story's I/O matrix, on the Studio surface (HTTP routes and the Studio-hosted MCP endpoint):
//   MCP edit, default            -> a pending proposal; the blueprint is unchanged
//   MCP preview-safe apply       -> applied as before
//   MCP apply on a risky op      -> PROPOSAL_REQUIRED (money brick, destructive op, catalogVersion, live production)
//   legacy enable_brick          -> same rules as apply_ops mode "apply"
//   MCP deploy / revert / rollback without approvalId -> 403 APPROVAL_REQUIRED, pending request (identical one reused)
//   approved retry               -> runs once; the approval is consumed
//   reused / rejected / expired  -> APPROVAL_USED / APPROVAL_REJECTED / APPROVAL_EXPIRED
//   stale (blueprint changed)    -> APPROVAL_STALE
//   cross-project approvalId     -> 404 APPROVAL_NOT_FOUND
//   MCP self-approve / accept    -> 403 APPROVAL_SESSION_REQUIRED
//   viewer approves              -> 403 FORBIDDEN_ROLE
//   Studio user deploys          -> ungated
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import studioAuthOrgsSql from "../migrations/0001_studio_auth_orgs.sql?raw";
import studioSecretVaultSql from "../migrations/0002_studio_secret_vault.sql?raw";
import cp5DeployTokensSql from "../migrations/0003_cp5_deploy_tokens.sql?raw";
import approvalsSql from "../migrations/0006_approval_requests.sql?raw";
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

const VALID_CF_TOKEN = "cf_scoped_valid_token_story53_least_privilege";

async function call(
  path: string,
  options: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  let rawBody: string | undefined;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    rawBody = JSON.stringify(options.body);
  }
  const res = await studioApp.fetch(
    new Request(`https://example.test${path}`, {
      method: options.method ?? (rawBody !== undefined ? "POST" : "GET"),
      headers,
      body: rawBody,
    }),
    TEST_ENV,
  );
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

let rpcId = 1;
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const res = await call("/mcp", {
    token,
    body: { jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const result = res.body.result as { isError?: boolean; content: Array<{ text: string }> };
  const text = result.content[0]?.text ?? "";
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    json = {};
  }
  return { isError: result.isError === true, text, json };
}

let counter = 0;
interface World {
  project: string;
  orgId: string;
  owner: { token: string; userId: string };
  agent: { token: string; id: string };
}

async function signUp(label: string): Promise<{ token: string; userId: string }> {
  const res = await call("/api/auth/signup", {
    body: { email: `${label}-${counter}-${crypto.randomUUID().slice(0, 6)}@example.com`, password: "OwnerPassword123!", displayName: label },
  });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, userId: (res.body.user as { id: string }).id };
}

/** An org with a project (multi-workspace, core-auth, dynamic-entities, an entity), a connected (fake) Cloudflare target
 * and an MCP token for the owner bound to the project with every scope. */
async function world(identity: "stub" | "core-auth" = "stub"): Promise<World> {
  counter += 1;
  const owner = await signUp("owner");
  const org = await call("/api/orgs", { token: owner.token, body: { name: "Approvals Org", slug: `approvals-${counter}-${crypto.randomUUID().slice(0, 6)}` } });
  const orgId = org.body.id as string;
  const project = `appr-${counter}-${crypto.randomUUID().slice(0, 6)}`;
  expect((await call(`/api/orgs/${orgId}/projects`, { token: owner.token, body: { project } })).status).toBe(201);
  const connected = await call(`/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, {
    token: owner.token,
    body: { token: VALID_CF_TOKEN, projectId: project },
  });
  expect(connected.status).toBe(201);
  const seeded = await call(`/api/projects/${project}/ops`, {
    token: owner.token,
    headers: { "x-org-id": orgId },
    body: {
      ops: [
        { opId: "s-ws", type: "enable_brick", brickId: "multi-workspace", config: {} },
        { opId: "s-auth", type: "enable_brick", brickId: "core-auth", config: {} },
        { opId: "s-ent", type: "enable_brick", brickId: "dynamic-entities", config: {} },
        { opId: "s-id", type: "set_identity", identity },
        {
          opId: "s-inv",
          type: "add_entity",
          entity: { name: "invoices", workspaceScoped: true, fields: [{ name: "amount", type: "text", required: true }] },
        },
      ],
    },
  });
  expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
  for (const secName of ["BETTER_AUTH_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]) {
    const secret = await call(`/api/projects/${project}/secrets`, {
      token: owner.token,
      headers: { "x-org-id": orgId },
      body: {
        ref: `sec_${project.replace(/-/g, "_")}_${secName.toLowerCase()}`,
        kind: "brick_secret",
        label: secName,
        appOrBrick: "core-auth",
        value: `super_secret_${secName.toLowerCase()}_value_12345`,
        bindTarget: { targetKind: "brick", targetId: "core-auth", secretName: secName },
      },
    });
    expect(secret.status).toBe(200);
  }
  const issued = await call(`/api/orgs/${orgId}/mcp-tokens`, {
    token: owner.token,
    body: { clientName: "claude-code", projectId: project, scopes: ["read", "edit", "deploy", "connect"] },
  });
  expect(issued.status).toBe(201);
  return { project, orgId, owner, agent: { token: issued.body.token as string, id: issued.body.id as string } };
}

async function revision(w: World): Promise<number> {
  return (await call(`/api/projects/${w.project}`, { token: w.owner.token })).body.revision as number;
}

async function auditActions(w: World): Promise<string[]> {
  const rows = await studioDb
    .prepare("SELECT action, status FROM studio_audit_logs WHERE project_id = ? AND action LIKE 'project.approval.%' ORDER BY ts, rowid")
    .bind(w.project)
    .all<{ action: string; status: string }>();
  return (rows.results ?? []).map((r) => `${r.action}:${r.status}`);
}

beforeEach(async () => {
  await applyMigration(studioDb, studioAuthOrgsSql);
  await applyMigration(studioDb, studioSecretVaultSql);
  await applyMigration(studioDb, cp5DeployTokensSql);
  await applyMigration(studioDb, approvalsSql);
});

describe("AD-V8: MCP edits are proposals by default", () => {
  it("an MCP edit without a mode is a pending proposal and the blueprint is unchanged until an editor accepts it", async () => {
    const w = await world();
    const before = await revision(w);
    const proposed = await tool(w.agent.token, "apply_ops", {
      project: w.project,
      ops: [{ opId: "p-name", type: "set_metadata", metadata: { displayName: "Proposed name" } }],
    });
    expect(proposed.isError, proposed.text).toBe(false);
    expect(proposed.json).toMatchObject({ mode: "propose", status: "pending", revision: before });
    expect(proposed.json.proposalId).toMatch(/.+/);
    expect(await revision(w)).toBe(before);

    const listed = await call(`/api/projects/${w.project}/proposals?status=pending`, { token: w.owner.token });
    expect(listed.body.proposals.map((p: { proposalId: string }) => p.proposalId)).toContain(proposed.json.proposalId);

    const accepted = await call(`/api/projects/${w.project}/proposals/${proposed.json.proposalId}/accept`, {
      token: w.owner.token,
      body: {},
    });
    expect(accepted.status).toBe(200);
    expect(await revision(w)).toBe(before + 1);
    expect(accepted.body.state.metadata.displayName).toBe("Proposed name");
  });

  it("POST /ops with an MCP token and no mode is a proposal too; a session user's POST /ops applies as before", async () => {
    const w = await world();
    const before = await revision(w);
    const viaToken = await call(`/api/projects/${w.project}/ops`, {
      token: w.agent.token,
      body: { ops: [{ opId: "t-name", type: "set_metadata", metadata: { displayName: "Token" } }] },
    });
    expect(viaToken.status).toBe(200);
    expect(viaToken.body.status).toBe("pending");
    expect(await revision(w)).toBe(before);
    const viaSession = await call(`/api/projects/${w.project}/ops`, {
      token: w.owner.token,
      body: { ops: [{ opId: "h-name", type: "set_metadata", metadata: { displayName: "Human" } }] },
    });
    expect(viaSession.status).toBe(200);
    expect(viaSession.body.revision).toBe(before + 1);
  });

  it("a preview-safe edit with mode apply is applied directly", async () => {
    const w = await world();
    const before = await revision(w);
    const applied = await tool(w.agent.token, "apply_ops", {
      project: w.project,
      mode: "apply",
      ops: [{ opId: "a-name", type: "set_metadata", metadata: { displayName: "Applied" } }],
    });
    expect(applied.isError, applied.text).toBe(false);
    expect(applied.json.revision).toBe(before + 1);
  });

  it.each([
    ["a money brick", [{ opId: "r-money", type: "enable_brick", brickId: "credit-wallet" }], /money setting: enable_brick:credit-wallet/],
    ["a destructive op", [{ opId: "r-del", type: "remove_entity", name: "invoices" }], /destructive: remove_entity/],
    ["a brick upgrade (catalogVersion)", [{ opId: "r-up", type: "set_metadata", metadata: { catalogVersion: "2.0.0" } }], /brick upgrade: set_metadata\.catalogVersion/],
  ])("mode apply with %s is refused with PROPOSAL_REQUIRED and nothing is applied, over MCP and over HTTP", async (_label, ops, reason) => {
    const w = await world();
    const before = await revision(w);
    const viaMcp = await tool(w.agent.token, "apply_ops", { project: w.project, mode: "apply", ops });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.json.error.code).toBe("PROPOSAL_REQUIRED");
    expect(viaMcp.json.error.remediation).toMatch(/mode "propose"/);
    expect(viaMcp.json.error.reasons.join(";")).toMatch(reason);
    const viaHttp = await call(`/api/projects/${w.project}/ops`, { token: w.agent.token, body: { mode: "apply", ops } });
    expect(viaHttp.status).toBe(403);
    expect(viaHttp.body.error.code).toBe("PROPOSAL_REQUIRED");
    expect(await revision(w)).toBe(before);
  });

  it("the legacy enable_brick follows mode apply's rules: a money brick is refused, a plain brick applies", async () => {
    const w = await world();
    const before = await revision(w);
    const refused = await tool(w.agent.token, "enable_brick", { project: w.project, bricks: ["credit-wallet"] });
    expect(refused.isError).toBe(true);
    expect(refused.json.error.code).toBe("PROPOSAL_REQUIRED");
    expect(await revision(w)).toBe(before);
    const plain = await tool(w.agent.token, "enable_brick", { project: w.project, bricks: ["feature-flags"] });
    expect(plain.isError, plain.text).toBe(false);
    expect(await revision(w)).toBe(before + 1);
  });

  it("once production is live, any direct agent edit is refused (AD-S10 hot path), and a session user still applies", async () => {
    const w = await world("core-auth");
    const deployed = await call(`/api/projects/${w.project}/environments/production/deploy`, {
      token: w.owner.token,
      headers: { "x-org-id": w.orgId },
      body: {},
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const before = await revision(w);
    const refused = await tool(w.agent.token, "apply_ops", {
      project: w.project,
      mode: "apply",
      ops: [{ opId: "prod-name", type: "set_metadata", metadata: { displayName: "Live edit" } }],
    });
    expect(refused.isError).toBe(true);
    expect(refused.json.error.code).toBe("PROPOSAL_REQUIRED");
    expect(refused.json.error.reasons.join(";")).toMatch(/live production deployment/);
    const proposed = await tool(w.agent.token, "apply_ops", {
      project: w.project,
      ops: [{ opId: "prod-name", type: "set_metadata", metadata: { displayName: "Live edit" } }],
    });
    expect(proposed.json.status).toBe("pending");
    expect(await revision(w)).toBe(before);
  });

  it("an MCP token cannot accept or reject a proposal, whatever its scopes (APPROVAL_SESSION_REQUIRED)", async () => {
    const w = await world();
    const proposed = await tool(w.agent.token, "apply_ops", {
      project: w.project,
      ops: [{ opId: "self", type: "set_metadata", metadata: { displayName: "Self" } }],
    });
    for (const action of ["accept", "reject"]) {
      const res = await call(`/api/projects/${w.project}/proposals/${proposed.json.proposalId}/${action}`, {
        token: w.agent.token,
        body: {},
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("APPROVAL_SESSION_REQUIRED");
      expect(res.body.error.remediation).toMatch(/Studio/);
    }
    const still = await call(`/api/projects/${w.project}/proposals?proposalId=${proposed.json.proposalId}`, { token: w.owner.token });
    expect(still.body.proposal.status).toBe("pending");
  });
});

describe("AD-V8: destructive actions need a Studio approval", () => {
  it("an MCP deploy is refused with APPROVAL_REQUIRED and nothing is deployed; after approval the retry deploys once; reuse is refused", async () => {
    const w = await world();
    const first = await tool(w.agent.token, "deploy_apply", { project: w.project, env: "preview" });
    expect(first.isError).toBe(true);
    expect(first.json.error.code).toBe("APPROVAL_REQUIRED");
    expect(first.json.error.remediation).toMatch(/approve .* in Studio.*approvalId/);
    const approvalId = first.json.error.approvalId as string;
    expect(approvalId).toMatch(/^apr_/);
    const deploys = await studioDb.prepare("SELECT COUNT(*) AS n FROM deployments WHERE project_id = ?").bind(w.project).first<{ n: number }>();
    expect(deploys?.n ?? 0).toBe(0);

    // The same request again reuses the pending approval.
    const again = await tool(w.agent.token, "deploy_apply", { project: w.project, env: "preview" });
    expect(again.json.error.approvalId).toBe(approvalId);
    const listed = await call(`/api/projects/${w.project}/approvals?status=pending`, { token: w.owner.token });
    expect(listed.status).toBe(200);
    expect(listed.body.approvals).toHaveLength(1);
    expect(listed.body.approvals[0]).toMatchObject({ approvalId, action: "deploy", env: "preview", status: "pending" });
    expect(listed.body.approvals[0].requestedBy).toMatchObject({ tokenId: w.agent.id, clientName: "claude-code" });

    // Not yet approved: the retry is refused.
    const early = await tool(w.agent.token, "deploy_apply", { project: w.project, env: "preview", approvalId });
    expect(early.json.error.code).toBe("APPROVAL_PENDING");

    // The agent cannot approve its own request.
    const selfApprove = await call(`/api/projects/${w.project}/approvals/${approvalId}/approve`, { token: w.agent.token, body: {} });
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.error.code).toBe("APPROVAL_SESSION_REQUIRED");

    const approved = await call(`/api/projects/${w.project}/approvals/${approvalId}/approve`, { token: w.owner.token, body: {} });
    expect(approved.status).toBe(200);
    expect(approved.body.approval).toMatchObject({ approvalId, status: "approved", decidedBy: w.owner.userId });

    const retried = await tool(w.agent.token, "deploy_apply", { project: w.project, env: "preview", approvalId });
    expect(retried.isError, retried.text).toBe(false);
    expect(retried.json.status).toMatch(/.+/);
    const after = await studioDb.prepare("SELECT COUNT(*) AS n FROM deployments WHERE project_id = ?").bind(w.project).first<{ n: number }>();
    expect(after?.n).toBe(1);

    const reused = await tool(w.agent.token, "deploy_apply", { project: w.project, env: "preview", approvalId });
    expect(reused.isError).toBe(true);
    expect(reused.json.error.code).toBe("APPROVAL_USED");
    const final = await studioDb.prepare("SELECT COUNT(*) AS n FROM deployments WHERE project_id = ?").bind(w.project).first<{ n: number }>();
    expect(final?.n).toBe(1);

    expect(await auditActions(w)).toEqual([
      "project.approval.request:pending",
      "project.approval.request:pending",
      "project.approval.consume:refused",
      "project.approval.approve:forbidden",
      "project.approval.approve:succeeded",
      "project.approval.consume:succeeded",
      "project.approval.consume:refused",
    ]);
  });

  it("a Studio session user deploys without any approval", async () => {
    const w = await world();
    const res = await call(`/api/projects/${w.project}/environments/preview/deploy`, {
      token: w.owner.token,
      headers: { "x-org-id": w.orgId },
      body: {},
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("an approval is stale once the blueprint changes, and an approval for another action or project is refused", async () => {
    const w = await world();
    const first = await call(`/api/projects/${w.project}/environments/preview/deploy`, { token: w.agent.token, body: {} });
    expect(first.status).toBe(403);
    const approvalId = first.body.error.approvalId as string;
    expect((await call(`/api/projects/${w.project}/approvals/${approvalId}/approve`, { token: w.owner.token, body: {} })).status).toBe(200);

    // A revert is a different action: the deploy approval does not cover it.
    const otherAction = await call(`/api/projects/${w.project}/revert`, { token: w.agent.token, body: { targetRevision: 0, approvalId } });
    expect(otherAction.status).toBe(409);
    expect(otherAction.body.error.code).toBe("APPROVAL_STALE");

    // Another project's token and approval id: not found, nothing about the approval leaks.
    const other = await world();
    const cross = await call(`/api/projects/${other.project}/environments/preview/deploy`, { token: other.agent.token, body: { approvalId } });
    expect(cross.status).toBe(404);
    expect(cross.body.error.code).toBe("APPROVAL_NOT_FOUND");
    expect(JSON.stringify(cross.body)).not.toContain(w.project);

    // The blueprint changes after approval: the plan and revision no longer match what was approved.
    expect((await call(`/api/projects/${w.project}/ops`, { token: w.owner.token, body: { ops: [{ opId: "chg", type: "set_metadata", metadata: { displayName: "Changed" } }] } })).status).toBe(200);
    const stale = await call(`/api/projects/${w.project}/environments/preview/deploy`, { token: w.agent.token, body: { approvalId } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("APPROVAL_STALE");
  });

  it("a rejected approval and an expired one are refused with their own codes", async () => {
    const w = await world();
    const reqRej = await call(`/api/projects/${w.project}/revert`, { token: w.agent.token, body: { targetRevision: 0 } });
    expect(reqRej.status).toBe(403);
    expect(reqRej.body.error.code).toBe("APPROVAL_REQUIRED");
    const rejectedId = reqRej.body.error.approvalId as string;
    expect((await call(`/api/projects/${w.project}/approvals/${rejectedId}/reject`, { token: w.owner.token, body: {} })).status).toBe(200);
    const afterReject = await call(`/api/projects/${w.project}/revert`, { token: w.agent.token, body: { targetRevision: 0, approvalId: rejectedId } });
    expect(afterReject.status).toBe(403);
    expect(afterReject.body.error.code).toBe("APPROVAL_REJECTED");

    const reqExp = await call(`/api/projects/${w.project}/revert`, { token: w.agent.token, body: { targetRevision: 0 } });
    const expiredId = reqExp.body.error.approvalId as string;
    expect(expiredId).not.toBe(rejectedId);
    expect((await call(`/api/projects/${w.project}/approvals/${expiredId}/approve`, { token: w.owner.token, body: {} })).status).toBe(200);
    await studioDb
      .prepare("UPDATE studio_approval_requests SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), expiredId)
      .run();
    const afterExpiry = await call(`/api/projects/${w.project}/revert`, { token: w.agent.token, body: { targetRevision: 0, approvalId: expiredId } });
    expect(afterExpiry.status).toBe(403);
    expect(afterExpiry.body.error.code).toBe("APPROVAL_EXPIRED");
  });

  it("the MCP revert (and the apply_ops revertTo alias) needs an approval; the approved retry reverts once", async () => {
    const w = await world();
    const before = await revision(w);
    const first = await tool(w.agent.token, "revert_to_revision", { project: w.project, targetRevision: 0 });
    expect(first.isError).toBe(true);
    expect(first.json.error.code).toBe("APPROVAL_REQUIRED");
    const alias = await tool(w.agent.token, "apply_ops", { project: w.project, revertTo: 0 });
    expect(alias.json.error.code).toBe("APPROVAL_REQUIRED");
    expect(alias.json.error.approvalId).toBe(first.json.error.approvalId);
    expect(await revision(w)).toBe(before);
    expect((await call(`/api/projects/${w.project}/approvals/${first.json.error.approvalId}/approve`, { token: w.owner.token, body: {} })).status).toBe(200);
    const reverted = await tool(w.agent.token, "apply_ops", { project: w.project, revertTo: 0, approvalId: first.json.error.approvalId });
    expect(reverted.isError, reverted.text).toBe(false);
    expect(await revision(w)).toBe(before + 1);
    const again = await tool(w.agent.token, "revert_to_revision", { project: w.project, targetRevision: 0, approvalId: first.json.error.approvalId });
    expect(again.json.error.code).toBe("APPROVAL_USED");
  });

  it("an MCP rollback needs an approval too", async () => {
    const w = await world();
    const deployed = await call(`/api/projects/${w.project}/environments/preview/deploy`, { token: w.owner.token, headers: { "x-org-id": w.orgId }, body: {} });
    expect(deployed.status).toBe(200);
    const deployId = deployed.body.deployId ?? deployed.body.deploymentId ?? deployed.body.environment?.lastDeploymentId;
    expect(typeof deployId).toBe("string");
    const res = await call(`/api/projects/${w.project}/environments/preview/rollback`, { token: w.agent.token, body: { targetDeploymentId: deployId } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("APPROVAL_REQUIRED");
  });

  it("a viewer cannot approve (existing role error), and an approval cannot be decided twice", async () => {
    const w = await world();
    const req = await call(`/api/projects/${w.project}/revert`, { token: w.agent.token, body: { targetRevision: 0 } });
    const approvalId = req.body.error.approvalId as string;
    const viewer = await signUp("viewer");
    await studioDb
      .prepare("INSERT OR REPLACE INTO studio_org_members (org_id, user_id, role, created_at) VALUES (?, ?, 'viewer', ?)")
      .bind(w.orgId, viewer.userId, new Date().toISOString())
      .run();
    const byViewer = await call(`/api/projects/${w.project}/approvals/${approvalId}/approve`, { token: viewer.token, body: {} });
    expect(byViewer.status).toBe(403);
    expect(byViewer.body.error.code).toBe("FORBIDDEN_ROLE");
    expect((await call(`/api/projects/${w.project}/approvals/${approvalId}/approve`, { token: w.owner.token, body: {} })).status).toBe(200);
    const twice = await call(`/api/projects/${w.project}/approvals/${approvalId}/reject`, { token: w.owner.token, body: {} });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("APPROVAL_ALREADY_DECIDED");
  });
});

describe("AD-V8: approval binding, release on failure, and the other gated routes", () => {
  const approve = async (w: World, id: string) =>
    expect((await call(`/api/projects/${w.project}/approvals/${id}/approve`, { token: w.owner.token, body: {} })).status).toBe(200);
  const approvalRow = async (w: World, id: string) =>
    ((await call(`/api/projects/${w.project}/approvals`, { token: w.owner.token })).body.approvals as Array<Record<string, any>>).find(
      (a) => a.approvalId === id,
    );

  it("an approved action that fails gives the approval back for the same retry; a successful one consumes it", async () => {
    const w = await world();
    const first = await call(`/api/projects/${w.project}/revert`, { token: w.agent.token, body: { targetRevision: 999 } });
    expect(first.body.error.code).toBe("APPROVAL_REQUIRED");
    const id = first.body.error.approvalId as string;
    await approve(w, id);
    const failed = await call(`/api/projects/${w.project}/revert`, { token: w.agent.token, body: { targetRevision: 999, approvalId: id } });
    expect(failed.status).toBe(422);
    expect(await approvalRow(w, id)).toMatchObject({ status: "approved", consumedAt: null });
    const again = await call(`/api/projects/${w.project}/revert`, { token: w.agent.token, body: { targetRevision: 999, approvalId: id } });
    expect(again.status).toBe(422); // the same bound retry runs again; it is not APPROVAL_USED
    const actions = await auditActions(w);
    expect(actions.filter((a) => a === "project.approval.release:succeeded")).toHaveLength(2);

    const ok = await call(`/api/projects/${w.project}/revert`, { token: w.agent.token, body: { targetRevision: 0 } });
    const okId = ok.body.error.approvalId as string;
    await approve(w, okId);
    expect((await call(`/api/projects/${w.project}/revert`, { token: w.agent.token, body: { targetRevision: 0, approvalId: okId } })).status).toBe(200);
    expect((await approvalRow(w, okId))?.status).toBe("consumed");
    const reused = await call(`/api/projects/${w.project}/revert`, { token: w.agent.token, body: { targetRevision: 0, approvalId: okId } });
    expect(reused.body.error.code).toBe("APPROVAL_USED");
  });

  it("a revert request shows the reviewer what would change (a semantic diff to the target)", async () => {
    const w = await world();
    const res = await call(`/api/projects/${w.project}/revert`, { token: w.agent.token, body: { targetRevision: 0 } });
    const row = await approvalRow(w, res.body.error.approvalId as string);
    expect(row?.summary.diff.bricks.removed).toEqual(expect.arrayContaining(["multi-workspace", "core-auth", "dynamic-entities"]));
    expect(row?.summary.diff.entities.removed).toEqual(["invoices"]);
  });

  it("a deploy approval is bound to each migration's SQL: the same name with other SQL is stale", async () => {
    const w = await world();
    const migration = (sql: string) => [{ name: "9001_custom.sql", sql }];
    const first = await call(`/api/projects/${w.project}/environments/preview/deploy`, {
      token: w.agent.token,
      body: { migrations: migration("CREATE TABLE IF NOT EXISTS extra_a (id TEXT PRIMARY KEY)") },
    });
    expect(first.body.error?.code, JSON.stringify(first.body)).toBe("APPROVAL_REQUIRED");
    const id = first.body.error.approvalId as string;
    const row = await approvalRow(w, id);
    const custom = (row?.summary.migrations as Array<{ name: string; sha256: string; bytes: number; destructive: boolean }>).find(
      (m) => m.name === "9001_custom.sql",
    );
    expect(custom).toMatchObject({ destructive: false });
    expect(custom!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(custom!.bytes).toBeGreaterThan(0);
    await approve(w, id);
    const swapped = await call(`/api/projects/${w.project}/environments/preview/deploy`, {
      token: w.agent.token,
      body: { migrations: migration("CREATE TABLE IF NOT EXISTS extra_b (id TEXT PRIMARY KEY)"), approvalId: id },
    });
    expect(swapped.status).toBe(409);
    expect(swapped.body.error.code).toBe("APPROVAL_STALE");
  });

  it("an MCP promotion needs an approval; the approved retry promotes once", async () => {
    const w = await world("core-auth");
    expect((await call(`/api/projects/${w.project}/environments/preview/deploy`, { token: w.owner.token, headers: { "x-org-id": w.orgId }, body: {} })).status).toBe(200);
    const first = await call(`/api/projects/${w.project}/environments/production/promote`, { token: w.agent.token, body: {} });
    expect(first.status, JSON.stringify(first.body)).toBe(403);
    expect(first.body.error.code).toBe("APPROVAL_REQUIRED");
    const id = first.body.error.approvalId as string;
    await approve(w, id);
    const promoted = await call(`/api/projects/${w.project}/environments/production/promote`, { token: w.agent.token, body: { approvalId: id } });
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
    const reused = await call(`/api/projects/${w.project}/environments/production/promote`, { token: w.agent.token, body: { approvalId: id } });
    expect(reused.body.error.code).toBe("APPROVAL_USED");
  });

  it("an MCP rollback's approved retry rolls back once and consumes the approval", async () => {
    const w = await world();
    const d1 = await call(`/api/projects/${w.project}/environments/preview/deploy`, { token: w.owner.token, headers: { "x-org-id": w.orgId }, body: {} });
    expect(d1.status).toBe(200);
    const firstDeployId = d1.body.deployId ?? d1.body.deploymentId ?? d1.body.environment?.lastDeploymentId;
    await call(`/api/projects/${w.project}/ops`, { token: w.owner.token, body: { ops: [{ opId: "rb-1", type: "enable_brick", brickId: "feature-flags" }] } });
    expect((await call(`/api/projects/${w.project}/environments/preview/deploy`, { token: w.owner.token, headers: { "x-org-id": w.orgId }, body: {} })).status).toBe(200);
    const body = { targetDeploymentId: firstDeployId, confirmDestructive: true };
    const first = await call(`/api/projects/${w.project}/environments/preview/rollback`, { token: w.agent.token, body });
    expect(first.body.error?.code, JSON.stringify(first.body)).toBe("APPROVAL_REQUIRED");
    const id = first.body.error.approvalId as string;
    const row = await approvalRow(w, id);
    expect(row?.summary.to).toMatchObject({ deploymentId: firstDeployId });
    expect(row?.summary.from.codeHash).toMatch(/.+/);
    await approve(w, id);
    const rolled = await call(`/api/projects/${w.project}/environments/preview/rollback`, { token: w.agent.token, body: { ...body, approvalId: id } });
    expect(rolled.status, JSON.stringify(rolled.body)).toBe(200);
    expect((await approvalRow(w, id))?.status).toBe("consumed");
    const reused = await call(`/api/projects/${w.project}/environments/preview/rollback`, { token: w.agent.token, body: { ...body, approvalId: id } });
    expect(reused.body.error.code).toBe("APPROVAL_USED");
  });

  it("an approval for a code-only MCP rollback is stale for the same rollback with restoreData (story 1.3)", async () => {
    const w = await world();
    const d1 = await call(`/api/projects/${w.project}/environments/preview/deploy`, { token: w.owner.token, headers: { "x-org-id": w.orgId }, body: {} });
    expect(d1.status).toBe(200);
    const firstDeployId = d1.body.deployId as string;
    await call(`/api/projects/${w.project}/ops`, { token: w.owner.token, body: { ops: [{ opId: "rd-1", type: "enable_brick", brickId: "feature-flags" }] } });
    const d2 = await call(`/api/projects/${w.project}/environments/preview/deploy`, {
      token: w.owner.token,
      headers: { "x-org-id": w.orgId },
      body: { migrations: [{ name: "0009_restore_gate.sql", sql: "CREATE TABLE restore_gate (id TEXT PRIMARY KEY);" }] },
    });
    expect(d2.status, JSON.stringify(d2.body)).toBe(200);
    const body = { targetDeploymentId: firstDeployId, confirmDestructive: true };
    const first = await call(`/api/projects/${w.project}/environments/preview/rollback`, { token: w.agent.token, body });
    expect(first.body.error?.code, JSON.stringify(first.body)).toBe("APPROVAL_REQUIRED");
    const id = first.body.error.approvalId as string;
    await approve(w, id);
    const withRestore = await call(`/api/projects/${w.project}/environments/preview/rollback`, {
      token: w.agent.token,
      body: { ...body, restoreData: true, approvalId: id },
    });
    expect(withRestore.body.error?.code, JSON.stringify(withRestore.body)).toBe("APPROVAL_STALE");
    // nothing ran: no rollback deployment, and the approval is still unused
    expect((await approvalRow(w, id))?.status).toBe("approved");
    const rows = await studioDb.prepare("SELECT COUNT(*) AS n FROM deployments WHERE project_id = ? AND action = 'rollback'").bind(w.project).first<{ n: number }>();
    expect(Number(rows?.n)).toBe(0);
  });

  it("an MCP sandbox deploy and promotion to BYOC need approvals; promotion is bound to the destination account and token", async () => {
    const w = await world();
    // Validation first: with no sandbox, the promotion is refused and no approval request is created.
    const noSandbox = await call(`/api/projects/${w.project}/sandbox/promote-to-byoc`, { token: w.agent.token, body: {} });
    expect(noSandbox.status).toBe(404);
    expect((await call(`/api/projects/${w.project}/approvals`, { token: w.owner.token })).body.approvals).toEqual([]);

    const sbx = await call(`/api/projects/${w.project}/sandbox/deploy`, { token: w.agent.token, body: {} });
    expect(sbx.status, JSON.stringify(sbx.body)).toBe(403);
    expect(sbx.body.error.code).toBe("APPROVAL_REQUIRED");
    const sbxId = sbx.body.error.approvalId as string;
    expect((await approvalRow(w, sbxId))?.summary).toMatchObject({ secretNames: [], expiresAt: expect.stringMatching(/default/) });
    await approve(w, sbxId);
    const deployed = await call(`/api/projects/${w.project}/sandbox/deploy`, { token: w.agent.token, body: { approvalId: sbxId } });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    expect((await call(`/api/projects/${w.project}/sandbox/deploy`, { token: w.agent.token, body: { approvalId: sbxId } })).body.error.code).toBe("APPROVAL_USED");

    const account = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const promoteBody = { token: "cf_valid_token_promote_sbx_to_byoc_0123456789", accountId: account };
    const first = await call(`/api/projects/${w.project}/sandbox/promote-to-byoc`, { token: w.agent.token, body: promoteBody });
    expect(first.status, JSON.stringify(first.body)).toBe(403);
    expect(first.body.error.code).toBe("APPROVAL_REQUIRED");
    const id = first.body.error.approvalId as string;
    const row = await approvalRow(w, id);
    expect(row?.summary).toMatchObject({ accountId: account, deployProduction: false });
    expect(JSON.stringify(row)).not.toContain(promoteBody.token);
    await approve(w, id);
    const otherToken = await call(`/api/projects/${w.project}/sandbox/promote-to-byoc`, {
      token: w.agent.token,
      body: { ...promoteBody, token: "cf_valid_token_promote_sbx_to_byoc_9999999999", approvalId: id },
    });
    expect(otherToken.status).toBe(409);
    expect(otherToken.body.error.code).toBe("APPROVAL_STALE");
    const promoted = await call(`/api/projects/${w.project}/sandbox/promote-to-byoc`, { token: w.agent.token, body: { ...promoteBody, approvalId: id } });
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
  });

  it("an MCP import needs an approval and shows the diff; a session user imports ungated", async () => {
    const w = await world();
    const exported = await call(`/api/projects/${w.project}/export`, { token: w.owner.token });
    expect(exported.status).toBe(200);
    const other = await world();
    const first = await call(`/api/projects/${other.project}/import`, { token: other.agent.token, body: { bundle: exported.body, mode: "replace" } });
    expect(first.status, JSON.stringify(first.body)).toBe(403);
    expect(first.body.error.code).toBe("APPROVAL_REQUIRED");
    const id = first.body.error.approvalId as string;
    const row = await approvalRow(other, id);
    expect(row).toMatchObject({ action: "import" });
    expect(row?.summary.diff).toBeDefined();
    await approve(other, id);
    const imported = await call(`/api/projects/${other.project}/import`, { token: other.agent.token, body: { bundle: exported.body, mode: "replace", approvalId: id } });
    expect(imported.status, JSON.stringify(imported.body)).toBe(200);
    const bySession = await call(`/api/projects/${other.project}/import`, { token: other.owner.token, body: { bundle: exported.body, mode: "replace" } });
    expect(bySession.status).toBe(200);
  });

  it("an MCP token cannot reject an approval request (APPROVAL_SESSION_REQUIRED)", async () => {
    const w = await world();
    const req = await call(`/api/projects/${w.project}/revert`, { token: w.agent.token, body: { targetRevision: 0 } });
    const res = await call(`/api/projects/${w.project}/approvals/${req.body.error.approvalId}/reject`, { token: w.agent.token, body: {} });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("APPROVAL_SESSION_REQUIRED");
  });

  it("set_metadata with replace on a project that pins a catalogVersion is a brick upgrade (PROPOSAL_REQUIRED)", async () => {
    const w = await world();
    const pinned = await call(`/api/projects/${w.project}/ops`, {
      token: w.owner.token,
      body: { ops: [{ opId: "pin-cat", type: "set_metadata", metadata: { catalogVersion: "1.0.0" } }] },
    });
    expect(pinned.status).toBe(200);
    const ops = [{ opId: "replace-meta", type: "set_metadata", metadata: { displayName: "x" }, replace: true }];
    const viaHttp = await call(`/api/projects/${w.project}/ops`, { token: w.agent.token, body: { mode: "apply", ops } });
    expect(viaHttp.status).toBe(403);
    expect(viaHttp.body.error.reasons.join(";")).toMatch(/replace drops catalogVersion/);
    const viaMcp = await tool(w.agent.token, "apply_ops", { project: w.project, mode: "apply", ops });
    expect(viaMcp.json.error.code).toBe("PROPOSAL_REQUIRED");
  });
});

describe("AD-V8: an approval belongs to the token that asked for it", () => {
  it("another MCP token on the project cannot reuse or consume it, and gets its own request", async () => {
    const w = await world();
    const issued = await call(`/api/orgs/${w.orgId}/mcp-tokens`, {
      token: w.owner.token,
      body: { clientName: "other-agent", projectId: w.project, scopes: ["read", "edit", "deploy"] },
    });
    expect(issued.status).toBe(201);
    const otherToken = issued.body.token as string;

    const mine = await call(`/api/projects/${w.project}/revert`, { token: w.agent.token, body: { targetRevision: 0 } });
    const theirs = await call(`/api/projects/${w.project}/revert`, { token: otherToken, body: { targetRevision: 0 } });
    expect(mine.body.error.code).toBe("APPROVAL_REQUIRED");
    expect(theirs.body.error.code).toBe("APPROVAL_REQUIRED");
    expect(theirs.body.error.approvalId).not.toBe(mine.body.error.approvalId);

    const id = mine.body.error.approvalId as string;
    expect((await call(`/api/projects/${w.project}/approvals/${id}/approve`, { token: w.owner.token, body: {} })).status).toBe(200);
    const stolen = await call(`/api/projects/${w.project}/revert`, { token: otherToken, body: { targetRevision: 0, approvalId: id } });
    expect(stolen.status).toBe(404);
    expect(stolen.body.error.code).toBe("APPROVAL_NOT_FOUND");
    const used = await call(`/api/projects/${w.project}/revert`, { token: w.agent.token, body: { targetRevision: 0, approvalId: id } });
    expect(used.status).toBe(200);
  });

  it("listing by status filters before the limit (an older pending request is still listed)", async () => {
    const w = await world();
    const first = await call(`/api/projects/${w.project}/revert`, { token: w.agent.token, body: { targetRevision: 0 } });
    const firstId = first.body.error.approvalId as string;
    // 200 newer rejected rows would push the pending one past the limit if the filter ran after it.
    const stmts = Array.from({ length: 201 }, (_, i) =>
      studioDb
        .prepare(
          `INSERT INTO studio_approval_requests (id, org_id, project_id, action, env, target, blueprint_rev, plan_fingerprint, status,
             requested_by_token, summary_json, created_at, expires_at)
           VALUES (?, ?, ?, 'revert', '', '0', 0, '', 'rejected', 'x', '{}', ?, ?)`,
        )
        .bind(`apr_fill_${w.project}_${i}`, w.orgId, w.project, new Date(Date.now() + 1000 + i).toISOString(), new Date(Date.now() + 86_400_000).toISOString()),
    );
    await studioDb.batch(stmts);
    const pending = await call(`/api/projects/${w.project}/approvals?status=pending`, { token: w.owner.token });
    expect((pending.body.approvals as Array<{ approvalId: string }>).map((a) => a.approvalId)).toEqual([firstId]);
  });
});
