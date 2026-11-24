import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import {
  SANDBOX_TTL_MS,
  app as studioApp,
  ensureStudioD1Schema,
  getStudioSandboxPlatform,
  pruneExpiredSandboxes,
} from "../src/index.ts";
import type {
  ProjectStatePayload,
  PruneExpiredSandboxesResult,
  StudioApiEnv,
  StudioSandboxSummary,
} from "../src/index.ts";

const studioEnv = env as unknown as StudioApiEnv;

async function createHumanSession(
  emailSuffix: string,
  targetEnv: StudioApiEnv = studioEnv,
): Promise<{
  userId: string;
  orgId: string;
  req: (path: string, init?: RequestInit, envOverride?: Partial<StudioApiEnv>) => Promise<Response>;
}> {
  const email = `reaper-${emailSuffix}-${Date.now()}@example.test`;
  const regRes = await studioApp.request(
    "/api/auth/signup",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "Password12345!",
        name: `Reaper User ${emailSuffix}`,
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

  const req = async (
    path: string,
    init: RequestInit = {},
    envOverride: Partial<StudioApiEnv> = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (cookieHeader && !headers.has("cookie")) {
      headers.set("cookie", cookieHeader);
      // Story 0.14: a cookie-authenticated write must come from an allowed Origin (CSRF guard); this is the same origin.
      if (!headers.has("origin")) headers.set("origin", "http://localhost");
    }
    if (!headers.has("authorization")) {
      headers.set("authorization", authHeader);
    }
    return studioApp.request(path, { ...init, headers }, { ...targetEnv, ...envOverride });
  };

  const orgsRes = await req("/api/orgs");
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

describe("Story 9.2 — Sandbox 7-day TTL reaper & studio-api live-payment guardrail", () => {
  beforeEach(async () => {
    await ensureStudioD1Schema(studioEnv.STUDIO_DB);
  });

  test("AC 3: pruneExpiredSandboxes destroys expired dispatch Worker + sandbox D1 after 7 days while preserving BlueprintDO project state and revision history", async () => {
    const { req, orgId, userId } = await createHumanSession("ac3");
    const project = `sbx-reaper-proj-${Date.now()}`;

    // 1. Create a project from ai-credits-saas starter template and apply an op so revision history > 1
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

    const opRes = await req(`/api/projects/${project}/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: 1,
        ops: [
          {
            opId: "op_reaper_check_1",
            type: "add_entity",
            entity: {
              name: "reaper_check_items",
              workspaceScoped: true,
              fields: [
                {
                  name: "title",
                  type: "text",
                  required: true,
                },
              ],
            },
          },
        ],
      }),
    });
    expect(opRes.status).toBe(200);

    // 2. Deploy project to zero-credential hosted sandbox
    const deployRes = await req(`/api/projects/${project}/sandbox/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId }),
    });
    expect(deployRes.status).toBe(200);
    const deployBody = (await deployRes.json()) as {
      ok: boolean;
      sandboxId: string;
      dispatchNamespace: string;
      previewUrl: string;
      buildHash: string;
      sandbox: StudioSandboxSummary;
    };
    expect(deployBody.ok).toBe(true);
    expect(deployBody.sandbox.status).toBe("active");
    expect(deployBody.sandbox.remainingDays).toBe(7);

    const sandboxId = deployBody.sandboxId;
    const dispatchNamespace = deployBody.dispatchNamespace;
    const platform = getStudioSandboxPlatform();
    expect(platform.getWorker(dispatchNamespace, sandboxId)).not.toBeNull();
    expect(platform.getDatabase(sandboxId)).not.toBeNull();

    // 3. Before 7-day TTL: pruneExpiredSandboxes leaves active sandbox untouched
    const earlyPrune = await pruneExpiredSandboxes(studioEnv.STUDIO_DB, {
      now: Date.now() + 2 * 24 * 60 * 60 * 1000,
      platform,
    });
    expect(earlyPrune.prunedSandboxIds).not.toContain(sandboxId);
    expect(platform.getWorker(dispatchNamespace, sandboxId)).not.toBeNull();

    // 4. Advance simulated clock past 7 days and run prune via POST /api/admin/sandboxes/prune
    const futureNowMs = Date.now() + SANDBOX_TTL_MS + 60_000;
    // Story 16: /api/admin/* is for platform operators only; a signed-in non-operator is refused and nothing is pruned.
    const refusedPrune = await req("/api/admin/sandboxes/prune", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ now: futureNowMs }),
    });
    expect(refusedPrune.status).toBe(403);
    expect(platform.getWorker(dispatchNamespace, sandboxId)).not.toBeNull();
    const pruneRes = await req(
      "/api/admin/sandboxes/prune",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ now: futureNowMs }),
      },
      { PX_PLATFORM_OPERATORS: userId },
    );
    expect(pruneRes.status).toBe(200);
    const pruneBody = (await pruneRes.json()) as PruneExpiredSandboxesResult;
    expect(pruneBody.ok).toBe(true);
    expect(pruneBody.prunedSandboxIds).toContain(sandboxId);
    expect(pruneBody.prunedCount).toBeGreaterThanOrEqual(1);

    // 5. Verify dispatch Worker and sandbox D1 were torn down and studio_sandboxes status is 'expired'
    expect(platform.getWorker(dispatchNamespace, sandboxId)).toBeNull();
    expect(platform.getDatabase(sandboxId)).toBeNull();

    const sbxStatusRes = await req(`/api/projects/${project}/sandbox`);
    expect(sbxStatusRes.status).toBe(200);
    const sbxStatusBody = (await sbxStatusRes.json()) as {
      sandbox: StudioSandboxSummary;
    };
    expect(sbxStatusBody.sandbox.status).toBe("expired");

    // 6. Verify BlueprintDO.getSummary() and GET /api/projects/:project + revisions remain 100% intact!
    const doId = studioEnv.BLUEPRINT_DO.idFromName(project);
    const doStub = studioEnv.BLUEPRINT_DO.get(doId);
    const summaryRes = await doStub.fetch(
      new Request(
        `https://do.internal/summary?project=${encodeURIComponent(project)}`,
      ),
    );
    expect(summaryRes.status).toBe(200);
    const summary = (await summaryRes.json()) as {
      project: string;
      revision: number;
      brickCount: number;
      entityCount: number;
      workflowCount: number;
    };
    expect(summary.project).toBe(project);
    expect(summary.revision).toBe(2);
    expect(summary.brickCount).toBeGreaterThanOrEqual(5);

    const projRes = await req(`/api/projects/${project}`);
    expect(projRes.status).toBe(200);
    const projState = (await projRes.json()) as ProjectStatePayload;
    expect(projState.revision).toBe(2);
    expect(
      projState.state.entities.some((e) => e.name === "reaper_check_items"),
    ).toBe(true);

    const revsRes = await req(`/api/projects/${project}/revisions`);
    expect(revsRes.status).toBe(200);
    const revsBody = (await revsRes.json()) as {
      revisions: Array<{ revision: number }>;
    };
    expect(revsBody.revisions.length).toBeGreaterThanOrEqual(2);
  });

  test("AC 5: studio-api blocks live-mode payment credentials (sk_live_*) on sandbox projects with 403 SANDBOX_LIVE_PAYMENTS_BLOCKED while allowing test-mode credentials (sk_test_*)", async () => {
    const { req, orgId } = await createHumanSession("ac5");
    const project = `sbx-livepay-proj-${Date.now()}`;

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

    // Provision active sandbox for the project
    const deployRes = await req(`/api/projects/${project}/sandbox/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId }),
    });
    expect(deployRes.status).toBe(200);

    // 1. Attempting to bind sk_live_12345 via POST /api/projects/:project/secrets fails with 403 SANDBOX_LIVE_PAYMENTS_BLOCKED
    const liveSecretRes = await req(`/api/projects/${project}/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: "sec_stripe_default",
        label: "Stripe Secret Key",
        appOrBrick: "stripe",
        value: "sk_live_12345",
      }),
    });
    expect(liveSecretRes.status).toBe(403);
    const liveSecretBody = (await liveSecretRes.json()) as {
      error: { code: string; message: string };
    };
    expect(liveSecretBody.error.code).toBe("SANDBOX_LIVE_PAYMENTS_BLOCKED");

    // 2. Attempting to bind sk_live_12345 via POST /api/projects/:project/connections also fails with 403 SANDBOX_LIVE_PAYMENTS_BLOCKED
    const liveConnRes = await req(`/api/projects/${project}/connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: "sec_stripe_default",
        app: "stripe",
        authType: "apiKey",
        value: "sk_live_12345",
      }),
    });
    expect(liveConnRes.status).toBe(403);
    const liveConnBody = (await liveConnRes.json()) as {
      error: { code: string; message: string };
    };
    expect(liveConnBody.error.code).toBe("SANDBOX_LIVE_PAYMENTS_BLOCKED");

    // 3. Binding sk_test_12345 succeeds with 200 OK
    const testSecretRes = await req(`/api/projects/${project}/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: "sec_stripe_default",
        label: "Stripe Test Secret Key",
        appOrBrick: "stripe",
        value: "sk_test_12345",
      }),
    });
    expect(testSecretRes.status).toBe(200);
  });
});
