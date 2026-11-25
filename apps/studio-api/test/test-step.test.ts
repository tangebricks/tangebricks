import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import type { D1Like } from "@poc/sdk";
import { listStepEventsForRun } from "@poc/telemetry";
import { ensureStudioD1Schema } from "../src/index.ts";
import { appWithPlaceholderExecutors as app } from "./placeholder-executors.ts";
import type { StudioApiEnv } from "../src/index.ts";
import { ensureTestProjectToken } from "./project-token.ts";
import { seedPreviewWorkspace } from "./preview-workspace-seed.ts";

const rawEnv = env as unknown as StudioApiEnv;
const studioDb = rawEnv.STUDIO_DB as D1Like;

const TEST_ENV: StudioApiEnv = {
  ...rawEnv,
  PX_TELEMETRY_SECRET: "px-studio-test-step-secret-2026",
  BETTER_AUTH_SECRET: "studio-test-better-auth-secret-0123456789abcdef",
  PX_VAULT_KEY: "studio-test-aes-gcm-256-vault-master-key-99887766",
};

const CANARY_VAULT_SECRET = "sk_live_canary_vault_test_step_991122";

describe("POST /api/projects/:projectId/workflows/:workflowId/nodes/:nodeId/test-step", () => {
  beforeEach(async () => {
    await ensureStudioD1Schema(studioDb);
    await studioDb.batch([
      studioDb.prepare("DELETE FROM px_step_events"),
      studioDb.prepare("DELETE FROM px_runs"),
    ]);
  });

  test("executes single workflow node against preview, enforces role >= editor, rejects production env with 403, and scrubs secrets", async () => {
    const project = "test-step-studio-proj";
    const { headers: ownerHeaders } = await ensureTestProjectToken(TEST_ENV, project);

    // Seed project with credit-wallet brick and a workflow containing credit-wallet.debit & core.http_request
    const setupRes = await app.fetch(
      new Request(`http://localhost/api/projects/${project}/ops`, {
        method: "POST",
        headers: {
          ...ownerHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          author: { type: "human", id: "alice" },
          ops: [
            {
              opId: "op-1",
              type: "enable_brick",
              brickId: "multi-workspace",
            },
            {
              opId: "op-2",
              type: "enable_brick",
              brickId: "credit-wallet",
              config: { creditsPerUnit: 1, minOrderAmount: 1 },
            },
            {
              opId: "op-3",
              type: "add_workflow",
              workflow: {
                id: "wf_checkout",
                name: "Checkout Flow",
                trigger: "core.webhook",
                nodes: [
                  {
                    id: "step_webhook",
                    type: "core.webhook",
                    label: "Incoming Order",
                    data: { path: "/orders", method: "post" },
                  },
                  {
                    id: "step_debit",
                    type: "credit-wallet.debit",
                    label: "Debit Wallet",
                    data: { amount: 25 },
                  },
                  {
                    id: "step_http",
                    type: "core.http_request",
                    label: "Call Partner API",
                    data: { method: "post", url: "http://fixture.local/partner/hook", timeoutMs: 2000 },
                  },
                ],
                edges: [
                  {
                    id: "e1",
                    source: "step_webhook",
                    sourceHandle: "out",
                    target: "step_debit",
                    targetHandle: "in",
                  },
                  {
                    id: "e2",
                    source: "step_debit",
                    sourceHandle: "out",
                    target: "step_http",
                    targetHandle: "in",
                  },
                ],
              },
            },
          ],
        }),
      }),
      TEST_ENV,
    );
    expect(setupRes.status).toBe(200);

    // Create a human Better Auth session so we can seal a canary secret in the project vault
    const signUpRes = await app.fetch(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Alice Test Step",
          email: "alice-test-step@example.com",
          password: "password12345",
        }),
      }),
      TEST_ENV,
    );
    const signUpBody = (await signUpRes.json()) as {
      token: string;
      user: { id: string };
    };
    await studioDb
      .prepare(
        "INSERT OR REPLACE INTO studio_org_members (org_id, user_id, role, created_at) VALUES ('org_default', ?, 'owner', datetime('now'))",
      )
      .bind(signUpBody.user.id)
      .run();

    // Seal a canary secret in the project vault and bind it to step_http
    const secretRes = await app.fetch(
      new Request(`http://localhost/api/projects/${project}/secrets`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${signUpBody.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ref: "sec_partner_api_key",
          kind: "api_key",
          label: "Partner API Key",
          appOrBrick: "core.http_request",
          value: CANARY_VAULT_SECRET,
          bindTarget: {
            targetKind: "node",
            targetId: "step_http",
            secretName: "AUTHORIZATION_BEARER",
          },
        }),
      }),
      TEST_ENV,
    );
    expect(secretRes.status).toBe(200);

    // 1. Rejects env === "production" with HTTP 403
    const prodRes = await app.fetch(
      new Request(
        `http://localhost/api/projects/${project}/workflows/wf_checkout/nodes/step_debit/test-step`,
        {
          method: "POST",
          headers: {
            ...ownerHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            env: "production",
            input: { balance: 100, workspaceId: "ws_1" },
          }),
        },
      ),
      TEST_ENV,
    );
    expect(prodRes.status).toBe(403);

    // 2. Rejects viewer role with HTTP 403
    const viewerSignUpRes = await app.fetch(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Viewer Test Step",
          email: "viewer-test-step@example.com",
          password: "password12345",
        }),
      }),
      TEST_ENV,
    );
    const viewerSignUpBody = (await viewerSignUpRes.json()) as {
      token: string;
      user: { id: string };
    };
    await studioDb
      .prepare(
        "INSERT OR REPLACE INTO studio_org_members (org_id, user_id, role, created_at) VALUES ('org_default', ?, 'viewer', datetime('now'))",
      )
      .bind(viewerSignUpBody.user.id)
      .run();

    const viewerRes = await app.fetch(
      new Request(
        `http://localhost/api/projects/${project}/workflows/wf_checkout/nodes/step_debit/test-step`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${viewerSignUpBody.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: { balance: 100, workspaceId: "ws_1" },
          }),
        },
      ),
      TEST_ENV,
    );
    expect(viewerRes.status).toBe(403);

    // Story 1.17: a workspace outside the project's preview data is refused 403 before anything is signed or run.
    const eventsBefore = Number(
      (await studioDb.prepare("SELECT COUNT(*) AS c FROM px_step_events").first<{ c: number }>())?.c ?? 0,
    );
    const foreignRes = await app.fetch(
      new Request(`http://localhost/api/projects/${project}/workflows/wf_checkout/nodes/step_debit/test-step`, {
        method: "POST",
        headers: { ...ownerHeaders, "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws_preview_1", input: { balance: 120 } }),
      }),
      TEST_ENV,
    );
    expect(foreignRes.status).toBe(403);
    expect(((await foreignRes.json()) as { error: { code: string } }).error.code).toBe("WORKSPACE_NOT_IN_PROJECT");
    expect(Number((await studioDb.prepare("SELECT COUNT(*) AS c FROM px_step_events").first<{ c: number }>())?.c ?? 0)).toBe(eventsBefore);

    // 3. Executes step_debit in preview mode and returns redacted result + writes rehearsal px_step_events row. Story
    // 1.17: the named workspace is one of the project's own preview workspaces (an earlier run of the project names it).
    await seedPreviewWorkspace(studioDb, project, "ws_preview_1");
    const previewRes = await app.fetch(
      new Request(
        `http://localhost/api/projects/${project}/workflows/wf_checkout/nodes/step_debit/test-step`,
        {
          method: "POST",
          headers: {
            ...ownerHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            // the workspace is the request's (Studio names it), not the input's (story 1.1)
            workspaceId: "ws_preview_1",
            input: { balance: 120, workspaceId: "ws_preview_1" },
          }),
        },
      ),
      TEST_ENV,
    );
    expect(previewRes.status).toBe(200);
    const previewBody = (await previewRes.json()) as {
      ok: boolean;
      runId: string;
      status: string;
      durationMs: number;
      output: { out: { debited: number; balanceAfter: number } };
    };
    expect(previewBody.ok).toBe(true);
    expect(previewBody.runId.startsWith("rehearsal:")).toBe(true);
    expect(previewBody.status).toBe("succeeded");
    expect(previewBody.output.out).toEqual({
      operation: "debit",
      debited: 25,
      balanceAfter: 95,
      workspaceId: "ws_preview_1",
    });

    const d1Events = await listStepEventsForRun(studioDb, previewBody.runId, { projectId: project });
    expect(d1Events).toHaveLength(1);
    expect(d1Events[0]?.nodeId).toBe("step_debit");

    // 4. Executes step_http where input contains the sealed canary secret and verifies it is scrubbed from response and D1.
    // Story 0.9: core.http_request has no fabricated 200, so the test injects the http://fixture.local fixture: a
    // fetch stub that echoes the request body back, as a partner API that reflects secrets would.
    const originalFetch = globalThis.fetch;
    const fixtureCalls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("http://fixture.local/")) return originalFetch(input, init);
      fixtureCalls.push(url);
      return new Response(typeof init?.body === "string" ? init.body : "{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    let secretLeakCheckRes: Response;
    try {
      secretLeakCheckRes = await app.fetch(
      new Request(
        `http://localhost/api/projects/${project}/workflows/wf_checkout/nodes/step_http/test-step`,
        {
          method: "POST",
          headers: {
            ...ownerHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: {
              body: {
                secretEcho: CANARY_VAULT_SECRET,
                b64Echo: btoa(CANARY_VAULT_SECRET),
                Authorization: `Bearer ${CANARY_VAULT_SECRET}`,
              },
            },
          }),
        },
      ),
      TEST_ENV,
    );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(secretLeakCheckRes.status).toBe(200);
    const rawLeakCheckText = await secretLeakCheckRes.text();
    // The node really ran against the fixture and succeeded; the scrubbing below is of its echoed output.
    expect(fixtureCalls).toHaveLength(1);
    expect((JSON.parse(rawLeakCheckText) as { status: string }).status).toBe("succeeded");
    expect(rawLeakCheckText).not.toContain(CANARY_VAULT_SECRET);
    expect(rawLeakCheckText).not.toContain(btoa(CANARY_VAULT_SECRET));
    expect(rawLeakCheckText).toContain("[REDACTED]");

    // Story 0.9: with PX_ENVIRONMENT=production the injected placeholder executors are refused (503 NOT_CONFIGURED).
    const prodEnvRes = await app.fetch(
      new Request(
        `http://localhost/api/projects/${project}/workflows/wf_checkout/nodes/step_debit/test-step`,
        {
          method: "POST",
          headers: { ...ownerHeaders, "content-type": "application/json" },
          body: JSON.stringify({ input: { balance: 120, workspaceId: "ws_preview_1" } }),
        },
      ),
      { ...TEST_ENV, PX_ENVIRONMENT: "production" },
    );
    expect(prodEnvRes.status).toBe(503);
    const prodEnvBody = (await prodEnvRes.json()) as { error: { code: string; message: string } };
    expect(prodEnvBody.error.code).toBe("NOT_CONFIGURED");
    expect(prodEnvBody.error.message).toMatch(/placeholder executor for .* refused/);
  });
});
