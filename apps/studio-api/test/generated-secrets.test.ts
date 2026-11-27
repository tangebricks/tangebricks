// Story 1.19: a safe secrets path for agent-built previews.
//
// Every row of the story's I/O matrix on the Studio surface (HTTP routes and the Studio-hosted MCP endpoint, fake Cloudflare):
//   preview, core-auth, MCP token -> APPROVAL_REQUIRED naming "generate BETTER_AUTH_SECRET"; the approved retry deploys; the
//                                    vault holds the generated row and the blueprint binds it; GitHub (optional) is not required
//   redeploy                       -> the stored value is reused, never regenerated; no generation in the next approval
//   production                     -> MISSING_REQUIRED_SECRETS naming the generate-secret; the owner binds or promotes
//   required, non-generated        -> refused before any approval, naming the secret and the owner's Studio step and URL
//   Studio session deploy          -> generates without an approval, as any session deploy runs
// and a scan of every response body and audit row in the test for the generated value (it must be in none).
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import studioAuthOrgsSql from "../migrations/0001_studio_auth_orgs.sql?raw";
import studioSecretVaultSql from "../migrations/0002_studio_secret_vault.sql?raw";
import cp5DeployTokensSql from "../migrations/0003_cp5_deploy_tokens.sql?raw";
import approvalsSql from "../migrations/0006_approval_requests.sql?raw";
import { app as defaultStudioApp, createStudioApiApp } from "../src/index.ts";
import type { StudioApiEnv } from "../src/index.ts";
import { decryptSecretValue } from "../src/secrets-vault.ts";
import { GENERATED_SECRET_KEY_HINT, generateSecretValue, generatedSecretRef } from "../src/generated-secrets.ts";

const rawEnv = env as unknown as StudioApiEnv;
const studioDb = rawEnv.STUDIO_DB as D1Like;

const TEST_ENV: StudioApiEnv = {
  ...rawEnv,
  BETTER_AUTH_SECRET: "studio-test-better-auth-secret-0123456789abcdef",
  PX_VAULT_KEY: "studio-test-aes-gcm-256-vault-master-key-99887766",
  PX_TOKEN_KEK: "studio-cp5-test-master-kek-v1-256bit-key-material-0001",
  PX_TOKEN_KEK_VERSION: "1",
};

const VALID_CF_TOKEN = "cf_scoped_valid_token_story53_least_privilege";

/** Every response body this file receives, so the generated value can be looked for in all of them. */
const seenBodies: string[] = [];

/** Runs between a deploy's approval gate and the bind of its generated secrets (the test seam); null does nothing. */
let betweenGateAndBind: (() => Promise<void>) | null = null;
const hookedApp = createStudioApiApp({
  deploy: {
    beforeGeneratedSecretBind: async () => {
      await betweenGateAndBind?.();
    },
  },
});
let studioApp: { fetch: (request: Request, env: StudioApiEnv) => Response | Promise<Response> } = defaultStudioApp;

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
    new Request(`https://example.test${path}`, { method: options.method ?? (rawBody !== undefined ? "POST" : "GET"), headers, body: rawBody }),
    TEST_ENV,
  );
  const text = await res.text();
  seenBodies.push(text);
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

let rpcId = 1;
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const res = await call("/mcp", { token, body: { jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } } });
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

/** An org and project with core-auth (no secret stored by anyone), a connected fake Cloudflare target, and an MCP token
 * with the default agent scopes (no `connect`). `extraBricks` adds bricks such as webhook-gateway. */
async function world(options: { identity?: "stub" | "core-auth"; extraBricks?: string[] } = {}): Promise<World> {
  counter += 1;
  const signup = await call("/api/auth/signup", {
    body: { email: `gen-${counter}-${crypto.randomUUID().slice(0, 6)}@example.com`, password: "OwnerPassword123!", displayName: "Owner" },
  });
  expect(signup.status).toBe(201);
  const owner = { token: signup.body.token as string, userId: (signup.body.user as { id: string }).id };
  const org = await call("/api/orgs", {
    token: owner.token,
    body: { name: "Generated Secrets Org", slug: `gen-${counter}-${crypto.randomUUID().slice(0, 6)}` },
  });
  const orgId = org.body.id as string;
  const project = `gen-${counter}-${crypto.randomUUID().slice(0, 6)}`;
  expect((await call(`/api/orgs/${orgId}/projects`, { token: owner.token, body: { project } })).status).toBe(201);
  expect(
    (await call(`/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, { token: owner.token, body: { token: VALID_CF_TOKEN, projectId: project } })).status,
  ).toBe(201);
  const seeded = await call(`/api/projects/${project}/ops`, {
    token: owner.token,
    headers: { "x-org-id": orgId },
    body: {
      ops: [
        { opId: "s-ws", type: "enable_brick", brickId: "multi-workspace", config: {} },
        { opId: "s-auth", type: "enable_brick", brickId: "core-auth", config: {} },
        ...(options.extraBricks ?? []).map((brickId) => ({ opId: `s-${brickId}`, type: "enable_brick", brickId, config: {} })),
        { opId: "s-id", type: "set_identity", identity: options.identity ?? "stub" },
      ],
    },
  });
  expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
  const issued = await call(`/api/orgs/${orgId}/mcp-tokens`, {
    token: owner.token,
    body: { clientName: "claude-code", projectId: project, scopes: ["read", "edit", "deploy"] },
  });
  expect(issued.status).toBe(201);
  return { project, orgId, owner, agent: { token: issued.body.token as string, id: issued.body.id as string } };
}

async function vaultRow(project: string, ref: string) {
  return studioDb
    .prepare("SELECT ref, kind, label, app_or_brick, key_hint, ciphertext_b64, iv_b64 FROM studio_secret_vault WHERE project_id = ? AND ref = ?")
    .bind(project, ref)
    .first<{ ref: string; kind: string; label: string; app_or_brick: string; key_hint: string; ciphertext_b64: string; iv_b64: string }>();
}

async function auditText(project: string): Promise<string> {
  const rows = await studioDb.prepare("SELECT * FROM studio_audit_logs WHERE project_id = ?").bind(project).all<Record<string, unknown>>();
  return JSON.stringify(rows.results ?? []);
}

async function deployCount(project: string, envName: string): Promise<number> {
  const row = await studioDb
    .prepare("SELECT COUNT(*) AS n FROM deployments WHERE project_id = ? AND env_name = ?")
    .bind(project, envName)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** The MCP agent asks to deploy preview, the owner approves in Studio, the agent retries with the approval id. */
async function approvedAgentDeploy(w: World) {
  const first = await tool(w.agent.token, "deploy_apply", { project: w.project, env: "preview" });
  expect(first.json.error?.code, first.text).toBe("APPROVAL_REQUIRED");
  const approvalId = first.json.error.approvalId as string;
  const approved = await call(`/api/projects/${w.project}/approvals/${approvalId}/approve`, { token: w.owner.token, body: {} });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const retried = await tool(w.agent.token, "deploy_apply", { project: w.project, env: "preview", approvalId });
  return { first, approvalId, approval: approved.body.approval as Record<string, any>, retried };
}

beforeEach(async () => {
  seenBodies.length = 0;
  betweenGateAndBind = null;
  studioApp = defaultStudioApp;
  await applyMigration(studioDb, studioAuthOrgsSql);
  await applyMigration(studioDb, studioSecretVaultSql);
  await applyMigration(studioDb, cp5DeployTokensSql);
  await applyMigration(studioDb, approvalsSql);
});

describe("story 1.19: generated secrets on an approved preview deploy", () => {
  it("an MCP token's preview deploy of core-auth: one owner approval generates, stores and binds BETTER_AUTH_SECRET and deploys; GitHub is optional; no value anywhere", async () => {
    const w = await world();

    // the plan lists the generated secret and the optional ones; nothing blocks
    const plan = await tool(w.agent.token, "deploy_plan", { project: w.project, env: "preview" });
    expect(plan.isError, plan.text).toBe(false);
    expect(plan.json.blockers).toEqual([]);
    expect(plan.json.willGenerateSecrets).toEqual(["BETTER_AUTH_SECRET"]);
    expect(plan.json.optionalSecretsNotConfigured).toEqual(["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]);
    const httpPlan = await call(`/api/projects/${w.project}/environments/preview/plan`, { token: w.owner.token, body: {} });
    expect(httpPlan.body.secrets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "BETTER_AUTH_SECRET", status: "will_generate", generate: "random-32-bytes" }),
        expect.objectContaining({ name: "GITHUB_CLIENT_ID", status: "optional_missing", optional: true }),
        expect.objectContaining({ name: "GITHUB_CLIENT_SECRET", status: "optional_missing", optional: true }),
      ]),
    );
    expect(httpPlan.body.missingSecrets).toEqual([]);

    const { first, approvalId, approval, retried } = await approvedAgentDeploy(w);
    expect(first.json.error.message).toMatch(/generate BETTER_AUTH_SECRET/);
    expect(approval).toMatchObject({ approvalId, action: "deploy", env: "preview" });
    expect(approval.summary.generate).toEqual(["generate BETTER_AUTH_SECRET"]);
    expect(retried.isError, retried.text).toBe(false);
    expect(await deployCount(w.project, "preview")).toBe(1);

    // the vault holds the generated row (no value hint) and the blueprint binds its ref; GitHub stays unbound
    const ref = generatedSecretRef("BETTER_AUTH_SECRET");
    const row = await vaultRow(w.project, ref);
    expect(row).toMatchObject({ ref, kind: "brick_secret", label: "BETTER_AUTH_SECRET", app_or_brick: "core-auth", key_hint: GENERATED_SECRET_KEY_HINT });
    const value = await decryptSecretValue(row!.ciphertext_b64, row!.iv_b64, TEST_ENV.PX_VAULT_KEY);
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    const state = await call(`/api/projects/${w.project}`, { token: w.owner.token });
    const refs = state.body.state.secretRefs as Array<{ targetId: string; secretName: string; ref: string }>;
    expect(refs).toContainEqual(expect.objectContaining({ targetId: "core-auth", secretName: "BETTER_AUTH_SECRET", ref }));
    expect(refs.some((r) => r.secretName.startsWith("GITHUB_"))).toBe(false);
    const audit = await auditText(w.project);
    expect(audit).toContain("secret.generate");

    // no value in any response this test received, nor in any audit row
    for (const body of seenBodies) expect(body.includes(value)).toBe(false);
    expect(audit.includes(value)).toBe(false);
  });

  it("a redeploy reuses the stored value: nothing is generated again, and the next approval carries no generation", async () => {
    const w = await world();
    expect((await approvedAgentDeploy(w)).retried.isError).toBe(false);
    const ref = generatedSecretRef("BETTER_AUTH_SECRET");
    const before = await vaultRow(w.project, ref);

    const plan = await call(`/api/projects/${w.project}/environments/preview/plan`, { token: w.owner.token, body: {} });
    expect(plan.body.secrets).toContainEqual(expect.objectContaining({ name: "BETTER_AUTH_SECRET", status: "present", ref }));
    const again = await tool(w.agent.token, "deploy_apply", { project: w.project, env: "preview" });
    expect(again.json.error.code).toBe("APPROVAL_REQUIRED"); // every agent deploy is approved (AD-V8), but not for a secret
    expect(again.json.error.message).not.toMatch(/generate/);
    const approved = await call(`/api/projects/${w.project}/approvals/${again.json.error.approvalId}/approve`, { token: w.owner.token, body: {} });
    expect(approved.body.approval.summary.generateSecrets).toBeUndefined();
    const retried = await tool(w.agent.token, "deploy_apply", { project: w.project, env: "preview", approvalId: again.json.error.approvalId });
    expect(retried.isError, retried.text).toBe(false);

    const after = await vaultRow(w.project, ref);
    expect(after!.ciphertext_b64).toBe(before!.ciphertext_b64);
    expect(after!.iv_b64).toBe(before!.iv_b64);
    const generations = await studioDb
      .prepare("SELECT COUNT(*) AS n FROM studio_audit_logs WHERE project_id = ? AND action = 'secret.generate'")
      .bind(w.project)
      .first<{ n: number }>();
    expect(generations?.n).toBe(1);
  });

  it("production never generates: MISSING_REQUIRED_SECRETS names the secret, with the bind-or-promote remediation", async () => {
    const w = await world({ identity: "core-auth" });
    const plan = await call(`/api/projects/${w.project}/environments/production/plan`, { token: w.owner.token, body: {} });
    expect(plan.body.secrets).toContainEqual(expect.objectContaining({ name: "BETTER_AUTH_SECRET", status: "missing" }));
    const deployed = await call(`/api/projects/${w.project}/environments/production/deploy`, {
      token: w.owner.token,
      headers: { "x-org-id": w.orgId },
      body: {},
    });
    expect(deployed.status).toBe(422);
    expect(deployed.body.error.code).toBe("MISSING_REQUIRED_SECRETS");
    expect(deployed.body.error.message).toMatch(/BETTER_AUTH_SECRET/);
    expect(deployed.body.error.message).not.toMatch(/GITHUB/);
    expect(deployed.body.error.remediation).toMatch(/promote from preview/);
    expect(await vaultRow(w.project, generatedSecretRef("BETTER_AUTH_SECRET"))).toBeNull();
    expect(await deployCount(w.project, "production")).toBe(0);
  });

  it("a required, non-generated secret is refused before any approval, naming it and the owner's Studio step with its URL", async () => {
    const w = await world({ extraBricks: ["webhook-gateway"] });
    const refused = await tool(w.agent.token, "deploy_apply", { project: w.project, env: "preview" });
    expect(refused.isError).toBe(true);
    expect(refused.json.error.code).toBe("MISSING_REQUIRED_SECRETS");
    expect(refused.json.error.message).toMatch(/PX_CONN_KEY/);
    expect(refused.json.error.message).not.toMatch(/BETTER_AUTH_SECRET/); // generated on approval: never a blocker on preview
    expect(refused.json.error.remediation).toMatch(/owner provides PX_CONN_KEY in Studio \(Connections\/secrets\)/);
    expect(refused.json.error.remediation).toContain(`/?project=${w.project}&nav=connections`);
    const approvals = await call(`/api/projects/${w.project}/approvals?status=pending`, { token: w.owner.token });
    expect(approvals.body.approvals).toHaveLength(0);
    expect(await vaultRow(w.project, generatedSecretRef("BETTER_AUTH_SECRET"))).toBeNull();
    // the agent cannot store the value itself
    const stored = await call(`/api/projects/${w.project}/secrets`, {
      token: w.agent.token,
      body: { ref: "sec_px_conn_key", kind: "brick_secret", label: "PX_CONN_KEY", value: generateSecretValue() },
    });
    expect(stored.status).toBe(403);
    expect(stored.body.error.code).toBe("FORBIDDEN_AGENT_SECRET_ACCESS");
  });

  it("a Studio session deploy to preview generates the secret without an approval", async () => {
    const w = await world();
    const deployed = await call(`/api/projects/${w.project}/environments/preview/deploy`, { token: w.owner.token, headers: { "x-org-id": w.orgId }, body: {} });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const row = await vaultRow(w.project, generatedSecretRef("BETTER_AUTH_SECRET"));
    expect(row?.key_hint).toBe(GENERATED_SECRET_KEY_HINT);
    const value = await decryptSecretValue(row!.ciphertext_b64, row!.iv_b64, TEST_ENV.PX_VAULT_KEY);
    for (const body of seenBodies) expect(body.includes(value)).toBe(false);
    expect((await auditText(w.project)).includes(value)).toBe(false);
  });

  it("an op that lands between the approval gate and the deploy is never deployed under that approval: APPROVAL_STALE, nothing deployed", async () => {
    const w = await world();
    studioApp = hookedApp;
    betweenGateAndBind = async () => {
      betweenGateAndBind = null;
      const sneaked = await call(`/api/projects/${w.project}/ops`, {
        token: w.owner.token,
        headers: { "x-org-id": w.orgId },
        body: { ops: [{ opId: "sneak", type: "set_metadata", metadata: { displayName: "Sneaked in after the approval" } }] },
      });
      expect(sneaked.status, JSON.stringify(sneaked.body)).toBe(200);
    };
    const { retried } = await approvedAgentDeploy(w);
    expect(retried.isError).toBe(true);
    expect(retried.json.error.code).toBe("APPROVAL_STALE");
    expect(await deployCount(w.project, "preview")).toBe(0);
    // the generated secret is stored and bound, and is reused by the next approved deploy (no second generation)
    expect(await vaultRow(w.project, generatedSecretRef("BETTER_AUTH_SECRET"))).not.toBeNull();
    const again = await approvedAgentDeploy(w);
    expect(again.retried.isError, again.retried.text).toBe(false);
    expect(again.approval.summary.generateSecrets).toBeUndefined();
    expect(await deployCount(w.project, "preview")).toBe(1);
  });

  it("a recorded agent blueprint re-imported (its BETTER_AUTH_SECRET ref already bound, no vault row) deploys by session: the generation is not APPROVAL_STALE", async () => {
    // The shape a benchmark run exports after its approved preview deploy, and change-live-app imports into a fresh project:
    // the generated secret's ref is in the bundle, but the new project's vault holds no row for it.
    const w = await world();
    const ref = generatedSecretRef("BETTER_AUTH_SECRET");
    const bundle = {
      schemaVersion: 2,
      project: w.project,
      identity: "core-auth",
      bricks: [
        { id: "core-auth", config: {} },
        { id: "credit-wallet", config: {} },
        { id: "dynamic-entities", config: {} },
        { id: "multi-workspace", config: {} },
      ],
      entities: [
        {
          name: "invoices",
          fields: [
            { name: "customer_email", type: "text", required: true, maxLength: 255 },
            { name: "amount_cents", type: "number", required: true, min: 0 },
            { name: "status", type: "enum", required: true, values: ["draft", "sent", "paid"] },
          ],
        },
        { name: "customers", fields: [{ name: "email", type: "text", required: true, maxLength: 255 }] },
      ],
      workflows: [],
      secretRefs: [{ ref, targetKind: "brick", targetId: "core-auth", secretName: "BETTER_AUTH_SECRET" }],
      metadata: { displayName: "Recorded agent app" },
      exportedRevision: { revision: 7, semanticHash: "recorded" },
    };
    const imported = await call(`/api/projects/${w.project}/import`, {
      token: w.owner.token,
      headers: { "x-org-id": w.orgId },
      body: { bundle, mode: "replace" },
    });
    expect([200, 201], JSON.stringify(imported.body)).toContain(imported.status);
    const plan = await call(`/api/projects/${w.project}/environments/preview/plan`, { token: w.owner.token, headers: { "x-org-id": w.orgId }, body: {} });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    expect(plan.body.secrets).toContainEqual(expect.objectContaining({ name: "BETTER_AUTH_SECRET", status: "will_generate" }));
    const before = await call(`/api/projects/${w.project}`, { token: w.owner.token });

    const deployed = await call(`/api/projects/${w.project}/environments/preview/deploy`, { token: w.owner.token, headers: { "x-org-id": w.orgId }, body: {} });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    expect(deployed.body.ok).toBe(true);
    expect(await deployCount(w.project, "preview")).toBe(1);
    const row = await vaultRow(w.project, ref);
    expect(row?.key_hint).toBe(GENERATED_SECRET_KEY_HINT);
    // the ref was already bound, so nothing needed binding: the blueprint did not move
    const after = await call(`/api/projects/${w.project}`, { token: w.owner.token });
    expect(after.body.revision).toBe(before.body.revision);
    expect(after.body.state.secretRefs).toContainEqual(expect.objectContaining({ targetId: "core-auth", secretName: "BETTER_AUTH_SECRET", ref }));
    const value = await decryptSecretValue(row!.ciphertext_b64, row!.iv_b64, TEST_ENV.PX_VAULT_KEY);
    for (const body of seenBodies) expect(body.includes(value)).toBe(false);
  });

  it("the same re-imported blueprint deployed by an MCP token: one approval deploys it, and an op sneaked in after the approval is still refused", async () => {
    const w = await world();
    const ref = generatedSecretRef("BETTER_AUTH_SECRET");
    const imported = await call(`/api/projects/${w.project}/ops`, {
      token: w.owner.token,
      headers: { "x-org-id": w.orgId },
      body: {
        ops: [
          { opId: "r-wallet", type: "enable_brick", brickId: "credit-wallet", config: {} },
          { opId: "r-dyn", type: "enable_brick", brickId: "dynamic-entities", config: {} },
          { opId: "r-id", type: "set_identity", identity: "core-auth" },
          { opId: "r-bind", type: "bind_secret_ref", ref, targetKind: "brick", targetId: "core-auth", secretName: "BETTER_AUTH_SECRET" },
        ],
      },
    });
    expect(imported.status, JSON.stringify(imported.body)).toBe(200);

    studioApp = hookedApp;
    betweenGateAndBind = async () => {
      betweenGateAndBind = null;
      const sneaked = await call(`/api/projects/${w.project}/ops`, {
        token: w.owner.token,
        headers: { "x-org-id": w.orgId },
        body: { ops: [{ opId: "sneak", type: "set_metadata", metadata: { displayName: "Sneaked in after the approval" } }] },
      });
      expect(sneaked.status, JSON.stringify(sneaked.body)).toBe(200);
    };
    const stale = await approvedAgentDeploy(w);
    expect(stale.retried.json.error?.code, stale.retried.text).toBe("APPROVAL_STALE");
    expect(await deployCount(w.project, "preview")).toBe(0);

    // the row is stored now; a fresh project with the same pre-bound ref and no sneaked op deploys under one approval
    const w2 = await world();
    const seeded = await call(`/api/projects/${w2.project}/ops`, {
      token: w2.owner.token,
      headers: { "x-org-id": w2.orgId },
      body: { ops: [{ opId: "r-bind", type: "bind_secret_ref", ref, targetKind: "brick", targetId: "core-auth", secretName: "BETTER_AUTH_SECRET" }] },
    });
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
    studioApp = defaultStudioApp;
    const ok = await approvedAgentDeploy(w2);
    expect(ok.approval.summary.generate).toEqual(["generate BETTER_AUTH_SECRET"]);
    expect(ok.retried.isError, ok.retried.text).toBe(false);
    expect(await deployCount(w2.project, "preview")).toBe(1);
    expect(await vaultRow(w2.project, ref)).not.toBeNull();
  });

  it("a secret generated for preview never satisfies a direct production deploy: MISSING_REQUIRED_SECRETS names it", async () => {
    const w = await world({ identity: "core-auth" });
    const preview = await call(`/api/projects/${w.project}/environments/preview/deploy`, { token: w.owner.token, headers: { "x-org-id": w.orgId }, body: {} });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(await vaultRow(w.project, generatedSecretRef("BETTER_AUTH_SECRET"))).not.toBeNull();
    const production = await call(`/api/projects/${w.project}/environments/production/deploy`, {
      token: w.owner.token,
      headers: { "x-org-id": w.orgId },
      body: {},
    });
    expect(production.status).toBe(422);
    expect(production.body.error.code).toBe("MISSING_REQUIRED_SECRETS");
    expect(production.body.error.message).toMatch(/BETTER_AUTH_SECRET/);
    expect(await deployCount(w.project, "production")).toBe(0);
    // promoting from preview carries the generated secret over
    const promoted = await call(`/api/projects/${w.project}/environments/production/promote`, {
      token: w.owner.token,
      headers: { "x-org-id": w.orgId },
      body: {},
    });
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
  });

  it("generateSecretValue makes 32 random bytes, different each time", () => {
    const a = generateSecretValue();
    const b = generateSecretValue();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
});
