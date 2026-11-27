import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import studioAuthOrgsSql from "../migrations/0001_studio_auth_orgs.sql?raw";
import studioSecretVaultSql from "../migrations/0002_studio_secret_vault.sql?raw";
import { app as studioApp, decryptSecretValue } from "../src/index.ts";
import type { StudioApiEnv } from "../src/index.ts";

const rawEnv = env as unknown as StudioApiEnv;
const studioDb = rawEnv.STUDIO_DB as D1Like;

const TEST_ENV: StudioApiEnv = {
  ...rawEnv,
  BETTER_AUTH_SECRET: "studio-test-better-auth-secret-0123456789abcdef",
  PX_VAULT_KEY: "studio-test-aes-gcm-256-vault-master-key-99887766",
  GITHUB_CLIENT_ID: "studio-gh-test-client-id",
  GITHUB_CLIENT_SECRET: "studio-gh-test-client-secret",
};

const CANARY_SECRETS = ["px_canary_secret_alpha_99182", "sk_live_canary_beta_77341", "whsec_canary_gamma_55129"] as const;

interface CallOptions {
  method?: string;
  token?: string;
  cookie?: string;
  orgId?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

async function callStudio(path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.cookie) headers.set("cookie", options.cookie);
  // Story 0.14: a cookie-authenticated write must come from an allowed Origin (CSRF guard); this is the same origin.
  if (options.cookie && !headers.has("origin")) headers.set("origin", "https://example.test");
  if (options.orgId) headers.set("x-org-id", options.orgId);

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

let mcpRpcId = 1;
async function callStudioMcp(
  toolName: string,
  args: Record<string, unknown>,
  options: { token?: string; cookie?: string } = {},
): Promise<{ status: number; body: Record<string, unknown>; rawText: string }> {
  const res = await callStudio("/mcp", {
    method: "POST",
    ...(options.token ? { token: options.token } : {}),
    ...(options.cookie ? { cookie: options.cookie } : {}),
    body: {
      jsonrpc: "2.0",
      id: mcpRpcId++,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    },
  });
  const rawText = await res.text();
  const body = JSON.parse(rawText) as Record<string, unknown>;
  return { status: res.status, body, rawText };
}

function assertZeroCanaryLeakage(surfaceName: string, payloadText: string, extraForbiddenStrings: string[] = []) {
  for (const canary of CANARY_SECRETS) {
    expect(payloadText.includes(canary), `Surface "${surfaceName}" leaked canary secret "${canary}"`).toBe(false);
  }
  for (const extra of extraForbiddenStrings) {
    if (!extra) continue;
    expect(payloadText.includes(extra), `Surface "${surfaceName}" leaked ciphertext/internal value "${extra}"`).toBe(false);
  }
}

beforeEach(async () => {
  for (const table of [
    "studio_secret_vault",
    "studio_audit_log",
    "studio_mcp_tokens",
    "studio_org_members",
    "studio_orgs",
    "studio_builds",
    "projects",
    "session",
    "account",
    "verification",
    "user",
  ]) {
    await studioDb.prepare(`DROP TABLE IF EXISTS "${table}"`).run();
  }
  await applyMigration(studioDb, studioAuthOrgsSql);
  await applyMigration(studioDb, studioSecretVaultSql);
});

describe("AES-GCM Secret Vault, bind_secret_ref, RBAC/Agent Protection, and Zero-Leak Scan", () => {
  test("plants 3 canary secrets via AES-GCM vault, binds refs to bricks and workflow nodes, blocks MCP agent secret writes (403), and proves 0 canary occurrences across all 5 surfaces", async () => {
    // 1. Sign up & sign in owner (Alice) and viewer (Bob)
    await callStudio("/api/auth/sign-up/email", {
      body: {
        email: "alice@vault.test",
        password: "alice-strong-password-123",
        name: "Alice Owner",
      },
    });
    const aliceSignIn = await callStudio("/api/auth/sign-in/email", {
      body: {
        email: "alice@vault.test",
        password: "alice-strong-password-123",
      },
    });
    const aliceCookie = (aliceSignIn.headers.get("set-cookie") ?? "").split(";")[0]!;

    const bobSignUp = await callStudio("/api/auth/sign-up/email", {
      body: {
        email: "bob@vault.test",
        password: "bob-strong-password-123",
        name: "Bob Viewer",
      },
    });
    const bobUserId = ((await bobSignUp.json()) as { user: { id: string } }).user.id;
    const bobSignIn = await callStudio("/api/auth/sign-in/email", {
      body: {
        email: "bob@vault.test",
        password: "bob-strong-password-123",
      },
    });
    const bobCookie = (bobSignIn.headers.get("set-cookie") ?? "").split(";")[0]!;

    // 2. Create Org, add Bob as viewer, create MCP token, and create project
    const orgRes = await callStudio("/api/orgs", {
      cookie: aliceCookie,
      body: { name: "Vault Security Org", slug: "vault-sec-org" },
    });
    expect(orgRes.status).toBe(201);
    const orgId = ((await orgRes.json()) as { id: string }).id;

    await callStudio(`/api/orgs/${orgId}/members`, {
      cookie: aliceCookie,
      body: { userId: bobUserId, role: "viewer" },
    });

    const projectSlug = "vault-canary-proj";
    const createProjRes = await callStudio(`/api/orgs/${orgId}/projects`, {
      cookie: aliceCookie,
      body: { project: projectSlug },
    });
    expect(createProjRes.status).toBe(201);

    // Story 0.15: the MCP token is bound to this project.
    const tokenRes = await callStudio(`/api/orgs/${orgId}/mcp-tokens`, {
      cookie: aliceCookie,
      body: {
        clientName: "Claude Desktop",
        projectId: projectSlug,
        scopes: ["read", "edit"],
      },
    });
    expect(tokenRes.status).toBe(201);
    const mcpToken = ((await tokenRes.json()) as { token: string }).token;

    // 3. Seed project with bricks (`core-auth`, `multi-workspace`, `webhook-gateway`) and a workflow with `core.http_request`
    const seedOpsRes = await callStudio(`/api/projects/${projectSlug}/ops`, {
      cookie: aliceCookie,
      body: {
        baseRevision: 0,
        summary: "Enable bricks and add HTTP workflow step",
        ops: [
          { opId: "op-auth", type: "enable_brick", brickId: "core-auth", config: {} },
          { opId: "op-ws", type: "enable_brick", brickId: "multi-workspace", config: {} },
          { opId: "op-wh", type: "enable_brick", brickId: "webhook-gateway", config: {} },
          {
            opId: "op-wf",
            type: "add_workflow",
            workflow: {
              id: "wf-billing-sync",
              name: "Billing Webhook Sync",
              trigger: { kind: "webhook", path: "/webhooks/stripe" },
              nodes: [
                {
                  id: "node_trig_1",
                  type: "core.webhook",
                  label: "Stripe Webhook",
                  data: { method: "post" },
                },
                {
                  id: "node_http_1",
                  type: "core.http_request",
                  label: "Call Billing API",
                  data: { method: "post", timeoutMs: 5000 },
                },
              ],
              edges: [
                {
                  id: "e-trig-http",
                  source: "node_trig_1",
                  sourceHandle: "out",
                  target: "node_http_1",
                  targetHandle: "in",
                },
              ],
            },
          },
        ],
      },
    });
    expect(seedOpsRes.status).toBe(200);

    // 4. Verify MCP agent token and Viewer user are FORBIDDEN (403) from writing secrets
    const agentAttempt = await callStudio(`/api/projects/${projectSlug}/secrets`, {
      token: mcpToken,
      body: {
        ref: "sec_agent_attempt",
        kind: "api_key",
        label: "Agent Secret",
        appOrBrick: "stripe",
        value: CANARY_SECRETS[0],
      },
    });
    expect(agentAttempt.status).toBe(403);

    const viewerAttempt = await callStudio(`/api/projects/${projectSlug}/secrets`, {
      cookie: bobCookie,
      body: {
        ref: "sec_viewer_attempt",
        kind: "api_key",
        label: "Viewer Secret",
        appOrBrick: "stripe",
        value: CANARY_SECRETS[0],
      },
    });
    expect(viewerAttempt.status).toBe(403);

    // 5. Plant all 3 canary secrets as human Owner and bind them to bricks & workflow nodes
    const plant1 = await callStudio(`/api/projects/${projectSlug}/secrets`, {
      cookie: aliceCookie,
      body: {
        ref: "sec_webhook_alpha",
        kind: "webhook_secret",
        label: "Primary Webhook Signing Secret",
        appOrBrick: "webhook-gateway",
        value: CANARY_SECRETS[0],
        bindTarget: {
          targetKind: "brick",
          targetId: "webhook-gateway",
          secretName: "WEBHOOK_SIGNING_SECRET",
        },
      },
    });
    expect(plant1.status).toBe(200);
    const plant1Text = await plant1.text();
    assertZeroCanaryLeakage("POST /secrets #1 response", plant1Text);
    const plant1Json = JSON.parse(plant1Text) as {
      secret: { keyHint: string; ref: string };
    };
    expect(plant1Json.secret.keyHint).toBe("••••9182");

    const plant2 = await callStudio(`/api/projects/${projectSlug}/secrets`, {
      cookie: aliceCookie,
      body: {
        ref: "sec_billing_api_beta",
        kind: "api_key",
        label: "Live Billing API Key",
        appOrBrick: "core.http_request",
        value: CANARY_SECRETS[1],
        bindTarget: {
          targetKind: "node",
          targetId: "node_http_1",
          secretName: "AUTHORIZATION_BEARER",
        },
      },
    });
    expect(plant2.status).toBe(200);
    const plant2Text = await plant2.text();
    assertZeroCanaryLeakage("POST /secrets #2 response", plant2Text);

    const plant3 = await callStudio(`/api/projects/${projectSlug}/secrets`, {
      cookie: aliceCookie,
      body: {
        ref: "sec_secondary_wh_gamma",
        kind: "brick_secret",
        label: "Secondary Signing Secret",
        appOrBrick: "webhook-gateway",
        value: CANARY_SECRETS[2],
      },
    });
    expect(plant3.status).toBe(200);
    const plant3Text = await plant3.text();
    assertZeroCanaryLeakage("POST /secrets #3 response", plant3Text);

    // 6. Inspect raw D1 `studio_secret_vault` rows to verify AES-GCM encryption & decrypt round-trip
    const vaultRows = await studioDb
      .prepare("SELECT ref, ciphertext_b64, iv_b64, key_hint FROM studio_secret_vault WHERE project_id = ? ORDER BY ref ASC")
      .bind(projectSlug)
      .all<{
        ref: string;
        ciphertext_b64: string;
        iv_b64: string;
        key_hint: string;
      }>();
    const rawVaultRows = vaultRows.results ?? [];
    expect(rawVaultRows).toHaveLength(3);

    const ciphertexts = rawVaultRows.map((r) => r.ciphertext_b64);
    for (const row of rawVaultRows) {
      assertZeroCanaryLeakage(`D1 studio_secret_vault row ${row.ref}`, JSON.stringify(row));
      const decrypted = await decryptSecretValue(row.ciphertext_b64, row.iv_b64, TEST_ENV.PX_VAULT_KEY);
      if (row.ref === "sec_webhook_alpha") expect(decrypted).toBe(CANARY_SECRETS[0]);
      if (row.ref === "sec_billing_api_beta") expect(decrypted).toBe(CANARY_SECRETS[1]);
      if (row.ref === "sec_secondary_wh_gamma") expect(decrypted).toBe(CANARY_SECRETS[2]);
    }

    // 7. Scan Surface #1: GET /api/projects/:project blueprint response
    const projRes = await callStudio(`/api/projects/${projectSlug}`, {
      cookie: aliceCookie,
    });
    expect(projRes.status).toBe(200);
    const projText = await projRes.text();
    assertZeroCanaryLeakage("Surface #1: GET /api/projects/:project", projText, ciphertexts);
    expect(projText).toContain("sec_webhook_alpha");
    expect(projText).toContain("sec_billing_api_beta");

    // 8. Scan Surface #2: GET /api/projects/:project/revisions (ops_log & snapshots in BlueprintDO)
    const revRes = await callStudio(`/api/projects/${projectSlug}/revisions`, {
      cookie: aliceCookie,
    });
    expect(revRes.status).toBe(200);
    const revText = await revRes.text();
    assertZeroCanaryLeakage("Surface #2: GET /api/projects/:project/revisions", revText, ciphertexts);

    // 9. Scan Surface #3: GET /api/projects/:project/export bundle
    const exportRes = await callStudio(`/api/projects/${projectSlug}/export`, {
      cookie: aliceCookie,
    });
    expect(exportRes.status).toBe(200);
    const exportText = await exportRes.text();
    assertZeroCanaryLeakage("Surface #3: GET /api/projects/:project/export", exportText, ciphertexts);

    // 10. Scan Surface #4: GET /api/projects/:project/secrets response
    const listSecretsRes = await callStudio(`/api/projects/${projectSlug}/secrets`, {
      cookie: aliceCookie,
    });
    expect(listSecretsRes.status).toBe(200);
    const listSecretsText = await listSecretsRes.text();
    assertZeroCanaryLeakage("Surface #4: GET /api/projects/:project/secrets", listSecretsText, ciphertexts);
    const listSecretsBody = JSON.parse(listSecretsText) as {
      secrets: Array<{
        ref: string;
        keyHint: string;
        usedBy: Array<{ targetKind: string; targetId: string; secretName: string }>;
      }>;
    };
    expect(listSecretsBody.secrets).toHaveLength(3);
    const alphaMeta = listSecretsBody.secrets.find((s) => s.ref === "sec_webhook_alpha")!;
    expect(alphaMeta.keyHint).toBe("••••9182");
    expect(alphaMeta.usedBy).toEqual([
      {
        targetKind: "brick",
        targetId: "webhook-gateway",
        secretName: "WEBHOOK_SIGNING_SECRET",
      },
    ]);

    // 11. Scan Surface #5: All MCP tool responses (`get_project`, `list_bricks`, `build_project`, `apply_ops`)
    const mcpGet = await callStudioMcp("get_project", { project: projectSlug }, { token: mcpToken });
    expect(mcpGet.status).toBe(200);
    assertZeroCanaryLeakage("Surface #5a: MCP get_project", mcpGet.rawText, ciphertexts);

    const mcpList = await callStudioMcp("list_bricks", {}, { token: mcpToken });
    expect(mcpList.status).toBe(200);
    assertZeroCanaryLeakage("Surface #5b: MCP list_bricks", mcpList.rawText, ciphertexts);

    const mcpApply = await callStudioMcp(
      "apply_ops",
      {
        project: projectSlug,
        ops: [
          {
            opId: "op-mcp-meta",
            type: "set_metadata",
            metadata: { notes: "Scanned by MCP" },
          },
        ],
      },
      { token: mcpToken },
    );
    expect(mcpApply.status).toBe(200);
    assertZeroCanaryLeakage("Surface #5c: MCP apply_ops", mcpApply.rawText, ciphertexts);

    const mcpBuild = await callStudioMcp("build_project", { project: projectSlug }, { token: mcpToken });
    expect(mcpBuild.status).toBe(200);
    assertZeroCanaryLeakage("Surface #5d: MCP build_project", mcpBuild.rawText, ciphertexts);

    // Also scan `studio_audit_log` and `studio_builds` in D1
    const auditDump = await studioDb.prepare("SELECT * FROM studio_audit_log").all<Record<string, unknown>>();
    assertZeroCanaryLeakage("D1 studio_audit_log", JSON.stringify(auditDump.results ?? []), ciphertexts);

    const buildsDump = await studioDb.prepare("SELECT * FROM studio_builds").all<Record<string, unknown>>();
    assertZeroCanaryLeakage("D1 studio_builds", JSON.stringify(buildsDump.results ?? []), ciphertexts);

    // 12. Verify MCP agent is forbidden from DELETE /secrets/:ref (403), while Owner can delete + unbind
    const agentDel = await callStudio(`/api/projects/${projectSlug}/secrets/sec_webhook_alpha`, {
      method: "DELETE",
      token: mcpToken,
    });
    expect(agentDel.status).toBe(403);

    const ownerDel = await callStudio(`/api/projects/${projectSlug}/secrets/sec_webhook_alpha?unbind=true`, {
      method: "DELETE",
      cookie: aliceCookie,
    });
    expect(ownerDel.status).toBe(200);
  });
});
