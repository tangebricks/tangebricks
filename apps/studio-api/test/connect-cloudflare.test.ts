import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
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
  cookie?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

async function callStudio(path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.cookie) headers.set("cookie", options.cookie);
  // Story 0.14: a cookie-authenticated write must come from an allowed Origin (CSRF guard); this is the same origin.
  if (options.cookie && !headers.has("origin")) headers.set("origin", "https://example.test");

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

describe("Story 5.2 — Connect Cloudflare API, Per-Permission Verifier, Environment Provisioning & Funnel Telemetry", () => {
  let ownerSessionToken = "";
  let viewerSessionToken = "";
  let mcpAgentToken = "";
  let orgId = "";

  beforeEach(async () => {
    await applyMigration(studioDb, studioAuthOrgsSql);
    await applyMigration(studioDb, studioSecretVaultSql);
    await applyMigration(studioDb, cp5DeployTokensSql);
    // Story 0.15: the MCP token below is bound to "acme-billing", which must belong to this run's org, so a row left by
    // an earlier run (in an org deleted below) is cleared first.
    await studioDb
      .prepare("DELETE FROM projects WHERE project_id = 'acme-billing'")
      .run()
      .catch(() => {});
    await studioDb.batch([
      studioDb.prepare("DELETE FROM onboarding_funnel_events"),
      studioDb.prepare("DELETE FROM project_environments"),
      studioDb.prepare("DELETE FROM deploy_token_audit_log"),
      studioDb.prepare("DELETE FROM deploy_tokens"),
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
        email: "owner-s52@example.com",
        password: "OwnerPassword123!",
        displayName: "Owner S52",
      },
    });
    const ownerData = (await ownerSignup.json()) as {
      token: string;
      user: { id: string };
    };
    ownerSessionToken = ownerData.token;

    const viewerSignup = await callStudio("/api/auth/signup", {
      body: {
        email: "viewer-s52@example.com",
        password: "ViewerPassword123!",
        displayName: "Viewer S52",
      },
    });
    const viewerData = (await viewerSignup.json()) as {
      token: string;
      user: { id: string };
    };
    viewerSessionToken = viewerData.token;

    const createOrgRes = await callStudio("/api/orgs", {
      token: ownerSessionToken,
      body: { name: "Acme BYOC Lab", slug: "acme-byoc-lab" },
    });
    const orgData = (await createOrgRes.json()) as { id: string };
    orgId = orgData.id;

    await callStudio(`/api/orgs/${orgId}/members`, {
      token: ownerSessionToken,
      body: { userId: viewerData.user.id, role: "viewer" },
    });

    const createProjRes = await callStudio(`/api/orgs/${orgId}/projects`, {
      token: ownerSessionToken,
      body: { project: "acme-billing" },
    });
    expect(createProjRes.status).toBe(201);

    const mcpTokenRes = await callStudio(`/api/orgs/${orgId}/mcp-tokens`, {
      token: ownerSessionToken,
      body: {
        userId: ownerData.user.id,
        clientName: "claude-desktop",
        projectId: "acme-billing",
        scopes: ["read", "edit", "connect"],
      },
    });
    expect(mcpTokenRes.status).toBe(201);
    const mcpData = (await mcpTokenRes.json()) as { token: string };
    mcpAgentToken = mcpData.token;
  });

  test("GET /api/orgs/:orgId/cloudflare-tokens/template-url returns pre-filled Cloudflare scoped token creation link and permission list", async () => {
    const res = await callStudio(`/api/orgs/${orgId}/cloudflare-tokens/template-url`, {
      method: "GET",
      token: ownerSessionToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      templateUrl: string;
      explanation: string;
      permissions: Array<{ id: string; label: string }>;
    };
    expect(body.templateUrl).toContain("https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=");
    expect(body.templateUrl).toContain("name=ProjectX+Studio+Deploy");
    expect(body.explanation).toBe("Your backend runs in your own Cloudflare account. We never host it.");
    expect(body.permissions.map((p) => p.label)).toEqual(["Account Settings: Read", "Workers Scripts: Edit", "D1: Edit", "Queues: Edit"]);
  });

  test("rejects MCP agent bearer token on verify-and-save with HTTP 403 HUMAN_CONSENT_REQUIRED (AD-S12)", async () => {
    const res = await callStudio(`/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, {
      method: "POST",
      token: mcpAgentToken,
      body: {
        token: "cf_valid_least_privilege_token_9988",
        projectId: "acme-billing",
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; studioUrl?: string };
    };
    expect(body.error.code).toBe("HUMAN_CONSENT_REQUIRED");
    expect(body.error.studioUrl).toContain("connect-cloudflare");

    const countRow = await studioDb.prepare("SELECT COUNT(*) as cnt FROM deploy_tokens WHERE org_id = ?").bind(orgId).first<{ cnt: number }>();
    expect(Number(countRow?.cnt ?? 0)).toBe(0);
  });

  test("rejects token missing Workers Scripts: Edit or D1: Edit with HTTP 422, exact missing permission name, remediation URL, and 0 rows stored in deploy_tokens", async () => {
    const missingWorkersRes = await callStudio(`/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, {
      method: "POST",
      token: ownerSessionToken,
      body: {
        token: "cf_missing_workers_edit_token_1234",
        projectId: "acme-billing",
      },
    });
    expect(missingWorkersRes.status).toBe(422);
    const missingWorkersBody = (await missingWorkersRes.json()) as {
      ok: boolean;
      missingPermissionLabels: string[];
      permissions: Array<{
        id: string;
        label: string;
        granted: boolean;
        remediationUrl: string;
        plainError?: string;
      }>;
      error: {
        code: string;
        remediationUrl: string;
      };
    };
    expect(missingWorkersBody.ok).toBe(false);
    expect(missingWorkersBody.error.code).toBe("MISSING_REQUIRED_PERMISSIONS");
    expect(missingWorkersBody.missingPermissionLabels).toContain("Workers Scripts: Edit");
    const workersRow = missingWorkersBody.permissions.find((p) => p.label === "Workers Scripts: Edit");
    expect(workersRow?.granted).toBe(false);
    expect(workersRow?.plainError).toContain("Workers Scripts: Edit missing ✕");
    expect(workersRow?.remediationUrl).toContain("https://dash.cloudflare.com/profile/api-tokens");

    const missingD1Res = await callStudio(`/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, {
      method: "POST",
      token: ownerSessionToken,
      body: {
        token: "cf_missing_d1_edit_token_1234",
        projectId: "acme-billing",
      },
    });
    expect(missingD1Res.status).toBe(422);
    const missingD1Body = (await missingD1Res.json()) as {
      missingPermissionLabels: string[];
    };
    expect(missingD1Body.missingPermissionLabels).toContain("D1: Edit");

    // Revoked / invalid token -> returns clear "Token is invalid or expired — Reconnect" diagnostic
    const revokedRes = await callStudio(`/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, {
      method: "POST",
      token: ownerSessionToken,
      body: {
        token: "cf_revoked_token_1234",
        projectId: "acme-billing",
      },
    });
    expect(revokedRes.status).toBe(422);
    const revokedBody = (await revokedRes.json()) as {
      summaryMessage: string;
      error: { code: string; message: string };
    };
    expect(revokedBody.summaryMessage).toContain("Token is invalid or expired — Reconnect");

    // Nothing stored in deploy_tokens
    const countRow = await studioDb.prepare("SELECT COUNT(*) as cnt FROM deploy_tokens WHERE org_id = ?").bind(orgId).first<{ cnt: number }>();
    expect(Number(countRow?.cnt ?? 0)).toBe(0);

    // Funnel telemetry recorded verification_failed with missing permission IDs
    const funnelRes = await callStudio(`/api/orgs/${orgId}/cloudflare-tokens/funnel-events?step=verification_failed`, {
      method: "GET",
      token: ownerSessionToken,
    });
    expect(funnelRes.status).toBe(200);
    const funnelBody = (await funnelRes.json()) as {
      events: Array<{
        step: string;
        metadata: { missingPermissionIds?: string[] };
      }>;
    };
    expect(funnelBody.events.length).toBeGreaterThanOrEqual(3);
    expect(funnelBody.events[0]?.metadata.missingPermissionIds).toContain("workers_scripts_edit");
    expect(funnelBody.events[1]?.metadata.missingPermissionIds).toContain("d1_edit");
  });

  test("valid least-privilege token -> all permissions green -> token sealed -> preview & production environments created -> recheck & funnel events recorded", async () => {
    // Record wizard_opened and template_link_clicked funnel events
    await callStudio(`/api/orgs/${orgId}/cloudflare-tokens/funnel-event`, {
      token: ownerSessionToken,
      body: { step: "wizard_opened", projectId: "acme-billing" },
    });
    await callStudio(`/api/orgs/${orgId}/cloudflare-tokens/funnel-event`, {
      token: ownerSessionToken,
      body: { step: "template_link_clicked", projectId: "acme-billing" },
    });

    const validToken = "cf_valid_least_privilege_token_5544";
    const verifySaveRes = await callStudio(`/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, {
      token: ownerSessionToken,
      body: {
        token: validToken,
        accountId: "abcdef0123456789abcdef0123456789",
        accountName: "Acme BYOC Production",
        projectId: "acme-billing",
      },
    });
    expect(verifySaveRes.status).toBe(201);
    const savedBody = (await verifySaveRes.json()) as {
      ok: boolean;
      tokenRef: string;
      accountId: string;
      accountName: string;
      token: {
        tokenRef: string;
        tokenLast4: string;
        status: string;
      };
      verification: {
        ok: boolean;
        permissions: Array<{ id: string; granted: boolean }>;
      };
      environments: Array<{
        projectId: string;
        envName: string;
        target: {
          type: string;
          accountId: string;
          tokenRef: string;
          envName: string;
        };
      }>;
    };

    expect(savedBody.ok).toBe(true);
    expect(savedBody.tokenRef).toMatch(/^tok_/);
    expect(savedBody.token.tokenLast4).toBe("5544");
    expect(savedBody.verification.ok).toBe(true);
    expect(savedBody.verification.permissions.every((p) => p.granted)).toBe(true);
    expect(JSON.stringify(savedBody)).not.toContain(validToken);

    const billingEnvs = savedBody.environments.filter((e) => e.projectId === "acme-billing");
    expect(billingEnvs.map((e) => e.envName).sort()).toEqual(["preview", "production"]);
    expect(billingEnvs[0]?.target).toEqual({
      type: "byoc",
      accountId: "abcdef0123456789abcdef0123456789",
      tokenRef: savedBody.tokenRef,
      envName: billingEnvs[0]?.envName,
    });

    // Re-check endpoint updates lastVerifiedAt or marks expired when simulated
    const recheckOkRes = await callStudio(`/api/orgs/${orgId}/cloudflare-tokens/${savedBody.tokenRef}/recheck`, {
      method: "POST",
      token: ownerSessionToken,
      body: {},
    });
    expect(recheckOkRes.status).toBe(200);
    const recheckOkBody = (await recheckOkRes.json()) as {
      ok: boolean;
      token: { status: string; lastVerifiedAt: string };
    };
    expect(recheckOkBody.ok).toBe(true);
    expect(recheckOkBody.token.status).toBe("active");

    const recheckExpiredRes = await callStudio(`/api/orgs/${orgId}/cloudflare-tokens/${savedBody.tokenRef}/recheck`, {
      method: "POST",
      token: ownerSessionToken,
      body: { simulatedStatus: "expired" },
    });
    expect(recheckExpiredRes.status).toBe(200);
    const recheckExpiredBody = (await recheckExpiredRes.json()) as {
      ok: boolean;
      token: { status: string };
      verification: { summaryMessage: string };
    };
    expect(recheckExpiredBody.ok).toBe(false);
    expect(recheckExpiredBody.token.status).toBe("expired");
    expect(recheckExpiredBody.verification.summaryMessage).toContain("Token is invalid or expired — Reconnect");

    // Disconnect token and verify full funnel sequence
    await callStudio(`/api/orgs/${orgId}/cloudflare-tokens/${savedBody.tokenRef}`, {
      method: "DELETE",
      token: ownerSessionToken,
    });

    const allFunnelRes = await callStudio(`/api/orgs/${orgId}/cloudflare-tokens/funnel-events`, {
      method: "GET",
      token: ownerSessionToken,
    });
    const allFunnelBody = (await allFunnelRes.json()) as {
      events: Array<{ step: string }>;
    };
    expect(allFunnelBody.events.map((e) => e.step)).toEqual([
      "wizard_opened",
      "template_link_clicked",
      "token_submitted",
      "verification_succeeded",
      "token_disconnected",
    ]);

    // Viewer cannot call verify-and-save
    const viewerRes = await callStudio(`/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, {
      token: viewerSessionToken,
      body: { token: validToken, projectId: "acme-billing" },
    });
    expect(viewerRes.status).toBe(403);
  });
});
