import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { catalog } from "@poc/assembler/catalog";
import {
  PLACEHOLDER_BRICK_EXECUTOR_MODULES,
  buildExecutorsFromCatalog,
  buildRegistryFromCatalog,
  handleWorkflowRunRequest,
} from "@poc/runtime";
import type { WorkflowRunResponse } from "@poc/runtime";
import type { D1Like } from "@poc/sdk";
import {
  TELEMETRY_SIGNATURE_HEADER,
  listStepEventsForRun,
  signTelemetryPayload,
} from "@poc/telemetry";
import type { TelemetryWsFrame } from "@poc/telemetry";
import { ensureStudioD1Schema } from "../src/index.ts";
import { appWithPlaceholderExecutors as app } from "./placeholder-executors.ts";
import type { StudioApiEnv } from "../src/index.ts";
import { ensureTestProjectToken } from "./project-token.ts";

const rawEnv = env as unknown as StudioApiEnv;
const studioDb = rawEnv.STUDIO_DB as D1Like;

const TEST_ENV: StudioApiEnv = {
  ...rawEnv,
  PX_TELEMETRY_SECRET: "px-studio-workflow-runs-secret-2026",
  BETTER_AUTH_SECRET: "studio-test-better-auth-secret-0123456789abcdef",
  PX_VAULT_KEY: "studio-test-aes-gcm-256-vault-master-key-99887766",
};

describe("POST /__px/runs and POST /api/projects/:projectId/workflows/:workflowId/runs", () => {
  beforeEach(async () => {
    await ensureStudioD1Schema(studioDb);
    await studioDb.batch([
      studioDb.prepare("DELETE FROM px_step_events"),
      studioDb.prepare("DELETE FROM px_runs"),
    ]);
  });

  test("POST /__px/runs enforces HMAC signature and executes GraphWorkflow identically to a trigger", async () => {
    const registry = buildRegistryFromCatalog(catalog);
    const executors = buildExecutorsFromCatalog(catalog, PLACEHOLDER_BRICK_EXECUTOR_MODULES);

    const payload = {
      runId: "run_worker_shell_1",
      workflowId: "wf_worker_direct",
      revision: 4,
      triggerPayload: { tier: "pro", balance: 120, workspaceId: "ws_direct" },
      workspaceId: "ws_direct",
      graph: {
        nodes: [
          { id: "n_trig", type: "core.webhook", data: { method: "post" } },
          {
            id: "n_if",
            type: "core.if",
            data: { field: "tier", operator: "eq", value: "pro" },
          },
          { id: "n_debit", type: "credit-wallet.debit", data: { amount: 20 } },
          { id: "n_notify", type: "in-app-notifications.send", data: {} },
        ],
        edges: [
          { id: "e1", source: "n_trig", target: "n_if", sourceHandle: "out", targetHandle: "in" },
          {
            id: "e2",
            source: "n_if",
            target: "n_debit",
            sourceHandle: "true",
            targetHandle: "in",
          },
          {
            id: "e3",
            source: "n_if",
            target: "n_notify",
            sourceHandle: "false",
            targetHandle: "in",
          },
        ],
      },
    };
    const rawBody = JSON.stringify(payload);

    // 1. Forged signature -> 401
    const badRes = await handleWorkflowRunRequest(
      new Request("http://preview.worker/__px/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TELEMETRY_SIGNATURE_HEADER]: "0000000000000000000000000000000000000000000000000000000000000000",
        },
        body: rawBody,
      }),
      {
        registry,
        executors,
        db: studioDb,
        telemetrySecret: TEST_ENV.PX_TELEMETRY_SECRET,
      },
    );
    expect(badRes?.status).toBe(401);

    // 2. Valid signature -> 200
    const sig = await signTelemetryPayload(rawBody, TEST_ENV.PX_TELEMETRY_SECRET!);
    const okRes = await handleWorkflowRunRequest(
      new Request("http://preview.worker/__px/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TELEMETRY_SIGNATURE_HEADER]: sig,
        },
        body: rawBody,
      }),
      {
        registry,
        executors,
        db: studioDb,
        telemetrySecret: TEST_ENV.PX_TELEMETRY_SECRET,
      },
    );
    expect(okRes?.status).toBe(200);
    const body = (await okRes!.json()) as WorkflowRunResponse;
    expect(body.ok).toBe(true);
    expect(body.status).toBe("queued");
    expect(body.runStatus).toBe("succeeded");
    expect(body.skipped).toEqual(["n_notify"]);
    expect(body.outputs.n_debit).toEqual({
      out: {
        operation: "debit",
        debited: 20,
        balanceAfter: 100,
        workspaceId: "ws_direct",
      },
    });
  });

  test("story 1.1: a signed POST /__px/runs naming a malformed workspace is 400, and nothing runs", async () => {
    const registry = buildRegistryFromCatalog(catalog);
    const executors = buildExecutorsFromCatalog(catalog, PLACEHOLDER_BRICK_EXECUTOR_MODULES);
    for (const [workspaceId, code] of [["ws a", "BAD_WORKSPACE"], ["__app__", "BAD_WORKSPACE"], [undefined, "NO_WORKSPACE"]] as const) {
      const rawBody = JSON.stringify({
        runId: `run_bad_ws_${code}`,
        workflowId: "wf_bad_ws",
        ...(workspaceId === undefined ? {} : { workspaceId }),
        graph: { nodes: [{ id: "n_trig", type: "core.webhook", data: { method: "post" } }], edges: [] },
      });
      const res = await handleWorkflowRunRequest(
        new Request("http://preview.worker/__px/runs", {
          method: "POST",
          headers: { "content-type": "application/json", [TELEMETRY_SIGNATURE_HEADER]: await signTelemetryPayload(rawBody, TEST_ENV.PX_TELEMETRY_SECRET!) },
          body: rawBody,
        }),
        { registry, executors, db: studioDb, telemetrySecret: TEST_ENV.PX_TELEMETRY_SECRET },
      );
      expect(res?.status, String(workspaceId)).toBe(400);
      expect(((await res!.json()) as { error: { code: string } }).error.code).toBe(code);
    }
  });

  test("POST /api/projects/:projectId/workflows/:workflowId/runs enforces role >= editor, broadcasts live WebSocket telemetry (queued -> running -> succeeded/skipped/failed), and persists run events", async () => {
    const project = "wf-runs-studio-proj";
    const { headers: ownerHeaders } = await ensureTestProjectToken(TEST_ENV, project);

    // Seed branching 4-node workflow on project
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
            { opId: "op-1", type: "enable_brick", brickId: "multi-workspace" },
            {
              opId: "op-2",
              type: "enable_brick",
              brickId: "credit-wallet",
              config: { creditsPerUnit: 1, minOrderAmount: 1 },
            },
            { opId: "op-3", type: "enable_brick", brickId: "in-app-notifications" },
            {
              opId: "op-4",
              type: "add_workflow",
              workflow: {
                id: "wf_branching",
                name: "Branching Checkout Flow",
                nodes: [
                  {
                    id: "step_trigger",
                    type: "core.webhook",
                    label: "Order Webhook",
                    data: { method: "post" },
                  },
                  {
                    id: "step_if",
                    type: "core.if",
                    label: "Is VIP Order",
                    data: { field: "tier", operator: "eq", value: "vip" },
                  },
                  {
                    id: "step_debit",
                    type: "credit-wallet.debit",
                    label: "Debit VIP Wallet",
                    data: { amount: 25 },
                  },
                  {
                    id: "step_notify",
                    type: "in-app-notifications.send",
                    label: "Standard Tier Notice",
                    data: {},
                  },
                ],
                edges: [
                  {
                    id: "e_trig_if",
                    source: "step_trigger",
                    target: "step_if",
                    sourceHandle: "out",
                    targetHandle: "in",
                  },
                  {
                    id: "e_if_true",
                    source: "step_if",
                    target: "step_debit",
                    sourceHandle: "true",
                    targetHandle: "in",
                  },
                  {
                    id: "e_if_false",
                    source: "step_if",
                    target: "step_notify",
                    sourceHandle: "false",
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

    // 1. Viewer role is rejected with HTTP 403
    const viewerSignUp = await app.fetch(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Viewer Run Caller",
          email: "viewer-wf-runs@example.com",
          password: "password12345",
        }),
      }),
      TEST_ENV,
    );
    const viewerAuth = (await viewerSignUp.json()) as {
      token: string;
      user: { id: string };
    };
    await studioDb
      .prepare(
        "INSERT OR REPLACE INTO studio_org_members (org_id, user_id, role, created_at) VALUES ('org_default', ?, 'viewer', datetime('now'))",
      )
      .bind(viewerAuth.user.id)
      .run();

    const viewerRunRes = await app.fetch(
      new Request(
        `http://localhost/api/projects/${project}/workflows/wf_branching/runs`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${viewerAuth.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            triggerPayload: { tier: "vip", balance: 100 },
          }),
        },
      ),
      TEST_ENV,
    );
    expect(viewerRunRes.status).toBe(403);

    // 2. Connect a WebSocket client to BlueprintDO to observe live telemetry frames
    const wsUpgradeRes = await app.fetch(
      new Request(`http://localhost/api/projects/${project}/ws`, {
        headers: {
          ...ownerHeaders,
          upgrade: "websocket",
        },
      }),
      TEST_ENV,
    );
    expect(wsUpgradeRes.status).toBe(101);
    const wsClient = wsUpgradeRes.webSocket!;
    wsClient.accept();
    const receivedTelemetryFrames: TelemetryWsFrame[] = [];
    wsClient.addEventListener("message", (ev) => {
      try {
        const parsed = JSON.parse(String(ev.data)) as { type?: string };
        if (parsed.type === "telemetry") {
          receivedTelemetryFrames.push(parsed as TelemetryWsFrame);
        }
      } catch {
        // Ignore non-JSON frames
      }
    });

    // 3. Trigger successful branching run (tier === "vip" -> step_debit succeeds, step_notify skipped)
    const runRes = await app.fetch(
      new Request(
        `http://localhost/api/projects/${project}/workflows/wf_branching/runs`,
        {
          method: "POST",
          headers: {
            ...ownerHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            // the workspace is the request's (Studio names it), not the payload's (story 1.1)
            workspaceId: "ws_vip_1",
            triggerPayload: {
              tier: "vip",
              balance: 100,
              workspaceId: "ws_vip_1",
            },
          }),
        },
      ),
      TEST_ENV,
    );
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as WorkflowRunResponse;
    expect(runBody.ok).toBe(true);
    expect(runBody.status).toBe("queued");
    expect(runBody.runStatus).toBe("succeeded");
    expect(runBody.skipped).toEqual(["step_notify"]);
    expect(runBody.outputs.step_debit).toEqual({
      out: {
        operation: "debit",
        debited: 25,
        balanceAfter: 75,
        workspaceId: "ws_vip_1",
      },
    });

    // Verify WebSocket received queued -> running -> succeeded for active nodes and queued -> skipped for untaken branch
    const run1Frames = receivedTelemetryFrames.filter((f) => f.runId === runBody.runId);
    const statusesFor = (nodeId: string) =>
      run1Frames.filter((f) => f.nodeId === nodeId).map((f) => f.status);

    expect(statusesFor("step_trigger")).toEqual(["queued", "running", "succeeded"]);
    expect(statusesFor("step_if")).toEqual(["queued", "running", "succeeded"]);
    expect(statusesFor("step_debit")).toEqual(["queued", "running", "succeeded"]);
    expect(statusesFor("step_notify")).toEqual(["queued", "skipped"]);

    // Verify D1 px_step_events persisted all 11 events (4 queued + 3 running + 3 succeeded + 1 skipped)
    const persistedEvents = await listStepEventsForRun(studioDb, runBody.runId, { projectId: project });
    expect(persistedEvents.length).toBe(11);

    // 4. Trigger failing branch run (tier === "vip", balance: 5 < 25 -> step_debit transitions to failed)
    const failRunRes = await app.fetch(
      new Request(
        `http://localhost/api/projects/${project}/workflows/wf_branching/runs`,
        {
          method: "POST",
          headers: {
            ...ownerHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            triggerPayload: {
              tier: "vip",
              balance: 5,
              workspaceId: "ws_vip_1",
            },
          }),
        },
      ),
      TEST_ENV,
    );
    expect(failRunRes.status).toBe(200);
    const failRunBody = (await failRunRes.json()) as WorkflowRunResponse;
    expect(failRunBody.ok).toBe(false);
    expect(failRunBody.runStatus).toBe("failed");
    expect(failRunBody.failed.step_debit).toContain("insufficient balance");

    const run2Frames = receivedTelemetryFrames.filter(
      (f) => f.runId === failRunBody.runId,
    );
    const run2StatusesFor = (nodeId: string) =>
      run2Frames.filter((f) => f.nodeId === nodeId).map((f) => f.status);

    expect(run2StatusesFor("step_debit")).toEqual(["queued", "running", "failed"]);
    expect(run2StatusesFor("step_notify")).toEqual(["queued", "skipped"]);

    // story 1.1: a Studio test run naming a malformed workspace is refused 400 before anything runs
    const badWsRes = await app.fetch(
      new Request(`http://localhost/api/projects/${project}/workflows/wf_branching/runs`, {
        method: "POST",
        headers: { ...ownerHeaders, "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws a", triggerPayload: { tier: "vip", balance: 100 } }),
      }),
      TEST_ENV,
    );
    expect(badWsRes.status).toBe(400);
    expect(((await badWsRes.json()) as { error: { code: string } }).error.code).toBe("BAD_WORKSPACE");

    wsClient.close();
  });
});
