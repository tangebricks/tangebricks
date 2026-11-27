import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import {
  app as studioApp,
  createSandboxDispatcher,
  ensureStudioD1Schema,
  getProjectAssembleCount,
  getStudioSandboxPlatform,
  resetStudioDeployTestState,
} from "../src/index.ts";
import type { StudioApiEnv, StudioSandboxSummary } from "../src/index.ts";

const studioEnv = env as unknown as StudioApiEnv;

async function createZeroCredentialUser(
  suffix: string,
  targetEnv: StudioApiEnv = studioEnv,
): Promise<{
  userId: string;
  orgId: string;
  req: (path: string, init?: RequestInit) => Promise<Response>;
}> {
  const email = `sbx-byoc-${suffix}-${Date.now()}@example.test`;
  const regRes = await studioApp.request(
    "/api/auth/signup",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "Password12345!",
        name: `Zero Cred User ${suffix}`,
      }),
    },
    targetEnv,
  );
  expect(regRes.status).toBe(201);
  const setCookie = regRes.headers.get("set-cookie") ?? "";
  const regBody = (await regRes.json()) as {
    token: string;
    user: { id: string };
  };
  const cookieHeader = setCookie.split(";")[0] ?? "";
  const authHeader = `Bearer ${regBody.token}`;

  const req = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (cookieHeader && !headers.has("cookie")) {
      headers.set("cookie", cookieHeader);
      // Story 0.14: a cookie-authenticated write must come from an allowed Origin (CSRF guard); this is the same origin.
      if (!headers.has("origin")) headers.set("origin", "http://localhost");
    }
    if (!headers.has("authorization")) {
      headers.set("authorization", authHeader);
    }
    return studioApp.request(path, { ...init, headers }, targetEnv);
  };

  const orgsRes = await req("/api/orgs");
  expect(orgsRes.status).toBe(200);
  const orgsBody = (await orgsRes.json()) as {
    orgs: Array<{ id: string }>;
  };
  const orgId = orgsBody.orgs[0]?.id ?? "org_default";

  return {
    userId: regBody.user.id,
    orgId,
    req,
  };
}

describe("Story 9.3 — Zero-credential sandbox preview (<= 2 min) & one-click Move to my Cloudflare account promotion", () => {
  beforeEach(async () => {
    await ensureStudioD1Schema(studioEnv.STUDIO_DB);
    resetStudioDeployTestState();
  });

  test("AC 1, AC 3, AC 4: zero-credential user launches ai-credits-saas sandbox preview in < 120s, inserts sample rows, and promotes to BYOC with identical buildHash, 0 extra assemble() calls, and destroyed sandbox (story 17: no sample-row copy)", async () => {
    const startTimeMs = Date.now();
    const { req, orgId } = await createZeroCredentialUser("full-flow");
    const project = `ai-sbx-byoc-${Date.now()}`;

    // Verify user has zero Cloudflare credentials connected
    const tokensRes = await req(`/api/orgs/${orgId}/cloudflare-tokens`);
    expect(tokensRes.status).toBe(200);
    const tokensBody = (await tokensRes.json()) as { tokens: unknown[] };
    expect(tokensBody.tokens).toHaveLength(0);

    // 1. Create project from ai-credits-saas starter template
    const createRes = await req("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project,
        orgId,
        templateId: "ai-credits-saas",
      }),
    });
    expect(createRes.status).toBe(201);

    // 2. Deploy to Instant Sandbox Preview (zero Cloudflare credentials)
    const sbxDeployRes = await req(`/api/projects/${project}/sandbox/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId }),
    });
    expect(sbxDeployRes.status).toBe(200);
    const sandboxDeploy = (await sbxDeployRes.json()) as {
      ok: boolean;
      sandboxId: string;
      dispatchNamespace: string;
      previewUrl: string;
      buildHash: string;
      codeHash: string;
      graphHash: string;
      revision: number;
      remainingDays: number;
      sandbox: StudioSandboxSummary;
    };
    expect(sandboxDeploy.ok).toBe(true);
    expect(sandboxDeploy.previewUrl).toBe(`https://${sandboxDeploy.sandboxId}.sandbox.projectx.dev`);
    expect(sandboxDeploy.remainingDays).toBe(7);

    // Verify live sandbox preview responds 200 OK
    const platform = getStudioSandboxPlatform();
    const dispatcher = createSandboxDispatcher({ platform });
    const liveHealthRes = await dispatcher.fetch(new Request(`${sandboxDeploy.previewUrl}/__px/health`));
    expect(liveHealthRes.status).toBe(200);
    const liveHealthBody = (await liveHealthRes.json()) as {
      ok: boolean;
      sandboxId: string;
      buildHash: string;
    };
    expect(liveHealthBody.ok).toBe(true);
    expect(liveHealthBody.buildHash).toBe(sandboxDeploy.buildHash);

    const timeToPreviewMs = Date.now() - startTimeMs;
    expect(timeToPreviewMs).toBeLessThan(120_000);

    // 3. Insert sample entity rows into usage_ledgers while on Sandbox Preview
    const insertViaDispatcherRes = await dispatcher.fetch(
      new Request(`${sandboxDeploy.previewUrl}/data/usage_ledgers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "sample_row_1",
          workspace_id: "ws_demo",
          title: "Sandbox Sample Ledger Row 1",
          status: "active",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      }),
    );
    expect(insertViaDispatcherRes.status).toBe(201);

    const insertViaDataBrowserRes = await req(`/api/projects/${project}/environments/preview/data/tables/usage_ledgers/rows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "ws_demo",
        confirmWrite: true,
        values: {
          id: "sample_row_2",
          title: "Sandbox Sample Ledger Row 2",
          status: "active",
        },
      }),
    });
    expect(insertViaDataBrowserRes.status).toBe(201);

    const assembleCountBeforePromote = getProjectAssembleCount(project);
    expect(assembleCountBeforePromote).toBe(1);

    // 4. Click "Move to my Cloudflare account" (promoteSandboxToByoc)
    const validByocToken = "cf_valid_token_promote_sbx_to_byoc_0123456789";
    const byocAccountId = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

    // Story 17: copySampleData copied unfiltered rows into STUDIO_DB; asking for it now fails loudly and the sandbox
    // is left untouched.
    const copyRes = await req(`/api/projects/${project}/sandbox/promote-to-byoc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orgId,
        token: validByocToken,
        accountId: byocAccountId,
        copySampleData: true,
      }),
    });
    expect(copyRes.status).toBe(400);
    const copyErr = (await copyRes.json()) as { error: { code: string } };
    expect(copyErr.error.code).toBe("COPY_SAMPLE_DATA_REMOVED");
    expect(platform.getDatabase(sandboxDeploy.sandboxId)).not.toBeNull();

    const promoteRes = await req(`/api/projects/${project}/sandbox/promote-to-byoc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orgId,
        token: validByocToken,
        accountId: byocAccountId,
        accountName: "Acme BYOC Production Account",
      }),
    });
    expect(promoteRes.status).toBe(200);
    const promoteBody = (await promoteRes.json()) as {
      ok: boolean;
      sandboxId: string;
      sandboxBuildHash: string;
      buildHash: string;
      buildHashMatched: boolean;
      reusedCachedBuild: boolean;
      assembleCalledDuringPromote: boolean;
      sandboxDestroyed: boolean;
      byocDeployment: {
        buildHash: string;
        codeHash: string;
        graphHash: string;
      };
      environments: Array<{ envName: string; buildHash: string | null }>;
    };

    const byocDeploy = promoteBody.byocDeployment;
    expect(promoteBody.ok).toBe(true);
    expect(byocDeploy.buildHash).toBe(sandboxDeploy.buildHash);
    expect(promoteBody.buildHash).toBe(sandboxDeploy.buildHash);
    expect(promoteBody.buildHashMatched).toBe(true);
    expect(promoteBody.reusedCachedBuild).toBe(true);
    expect(promoteBody.assembleCalledDuringPromote).toBe(false);
    expect(getProjectAssembleCount(project)).toBe(assembleCountBeforePromote);

    // Verify preview and production BYOC environments were created
    expect(promoteBody.environments.map((e) => e.envName).sort()).toEqual(["preview", "production"]);

    // Story 17: no sample rows are copied, and the response carries no copied counts
    for (const removed of ["copySampleData", "copiedSampleRows", "copiedRowsCount", "copiedTables"]) {
      expect(promoteBody).not.toHaveProperty(removed);
    }

    // With the sandbox gone, preview has no data store Studio can reach: NOT_CONFIGURED, never a STUDIO_DB fallback
    const byocRowsRes = await req(`/api/projects/${project}/environments/preview/data/tables/usage_ledgers/rows?workspaceId=ws_demo`);
    expect(byocRowsRes.status).toBe(503);
    const byocRowsErr = (await byocRowsRes.json()) as { error: { code: string } };
    expect(byocRowsErr.error.code).toBe("NOT_CONFIGURED");

    // Verify ephemeral HostedSandboxTarget resources were destroyed
    expect(promoteBody.sandboxDestroyed).toBe(true);
    expect(platform.getWorker(sandboxDeploy.dispatchNamespace, sandboxDeploy.sandboxId)).toBeNull();
    expect(platform.getDatabase(sandboxDeploy.sandboxId)).toBeNull();

    const sbxAfterRes = await req(`/api/projects/${project}/sandbox`);
    expect(sbxAfterRes.status).toBe(200);
    const sbxAfterBody = (await sbxAfterRes.json()) as {
      sandbox: StudioSandboxSummary;
    };
    expect(sbxAfterBody.sandbox.status).toBe("promoted");
  });

  test("AC 3: promoteSandboxToByoc without copySampleData preserves buildHash and copies no sample rows", async () => {
    const { req, orgId } = await createZeroCredentialUser("no-copy");
    const project = `ai-sbx-nocopy-${Date.now()}`;

    await req("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project,
        orgId,
        templateId: "ai-credits-saas",
      }),
    });

    const sbxDeployRes = await req(`/api/projects/${project}/sandbox/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId }),
    });
    expect(sbxDeployRes.status).toBe(200);
    const sandboxDeploy = (await sbxDeployRes.json()) as {
      sandboxId: string;
      previewUrl: string;
      buildHash: string;
    };

    const platform = getStudioSandboxPlatform();
    const dispatcher = createSandboxDispatcher({ platform });
    await dispatcher.fetch(
      new Request(`${sandboxDeploy.previewUrl}/data/usage_ledgers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "ephemeral_only_row",
          workspace_id: "ws_ephemeral",
          title: "Should Not Be Copied",
          status: "active",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      }),
    );

    const promoteRes = await req(`/api/projects/${project}/sandbox/promote-to-byoc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orgId,
        token: "cf_valid_token_nocopy_0123456789",
        accountId: "b2c3d4e5f60718293a4b5c6d7e8f90a1",
      }),
    });
    expect(promoteRes.status).toBe(200);
    const promoteBody = (await promoteRes.json()) as {
      buildHash: string;
      assembleCalledDuringPromote: boolean;
      sandboxDestroyed: boolean;
    };
    expect(promoteBody.buildHash).toBe(sandboxDeploy.buildHash);
    expect(promoteBody).not.toHaveProperty("copiedSampleRows");
    expect(promoteBody.assembleCalledDuringPromote).toBe(false);
    expect(promoteBody.sandboxDestroyed).toBe(true);

    const byocRowsRes = await req(`/api/projects/${project}/environments/preview/data/tables/usage_ledgers/rows?workspaceId=ws_ephemeral`);
    expect(byocRowsRes.status).toBe(503);
    const byocRowsErr = (await byocRowsRes.json()) as { error: { code: string } };
    expect(byocRowsErr.error.code).toBe("NOT_CONFIGURED");
    expect(JSON.stringify(byocRowsErr)).not.toContain("ephemeral_only_row");
  });
});
