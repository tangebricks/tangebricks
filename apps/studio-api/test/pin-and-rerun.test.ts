import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import type { D1Like } from "@poc/sdk";
import {
  insertStepEvent,
  listStepEventsForRun,
  upsertRunRecord,
} from "@poc/telemetry";
import {
  ensureStudioD1Schema,
} from "../src/index.ts";
import { appWithPlaceholderExecutors as app } from "./placeholder-executors.ts";
import type { StudioApiEnv } from "../src/index.ts";
import { ensureTestProjectToken } from "./project-token.ts";

const rawEnv = env as unknown as StudioApiEnv;
const studioDb = rawEnv.STUDIO_DB as D1Like;

const TEST_ENV: StudioApiEnv = {
  ...rawEnv,
  PX_TELEMETRY_SECRET: "px-studio-pin-and-rerun-secret-2026",
  BETTER_AUTH_SECRET: "studio-test-better-auth-secret-0123456789abcdef",
  PX_VAULT_KEY: "studio-test-aes-gcm-256-vault-master-key-99887766",
};

describe("Pin Step Output & Re-Run From Node API", () => {
  beforeEach(async () => {
    await ensureStudioD1Schema(studioDb);
    await studioDb.batch([
      studioDb.prepare("DELETE FROM px_step_events"),
      studioDb.prepare("DELETE FROM px_runs"),
    ]);
  });

  test("pins and unpins node output with secret redaction, preserves semanticHash and buildHash unchanged, feeds pinned output to downstream rehearse and preview runs, and re-runs failed runs from a specific node marking original run as Resolved by retry", async () => {
    const project = "pin-and-rerun-proj";
    const { headers: ownerHeaders } = await ensureTestProjectToken(TEST_ENV, project);

    // 1. Create workflow with 3 nodes: step_trigger -> step_transform -> step_debit
    const opsRes = await app.fetch(
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
                id: "wf_orders",
                name: "Order Billing Flow",
                trigger: "core.webhook",
                nodes: [
                  {
                    id: "step_trigger",
                    type: "core.webhook",
                    label: "Webhook Trigger",
                    data: { method: "post" },
                  },
                  {
                    id: "step_transform",
                    type: "core.noop",
                    label: "Normalize Payload",
                    data: {},
                  },
                  {
                    id: "step_debit",
                    type: "credit-wallet.debit",
                    label: "Debit Wallet",
                    data: { amount: 25 },
                  },
                ],
                edges: [
                  {
                    id: "e1",
                    source: "step_trigger",
                    sourceHandle: "out",
                    target: "step_transform",
                    targetHandle: "in",
                  },
                  {
                    id: "e2",
                    source: "step_transform",
                    sourceHandle: "out",
                    target: "step_debit",
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
    expect(opsRes.status).toBe(200);
    const opsBody = (await opsRes.json()) as {
      revision: number;
      semanticHash: string;
    };
    const initialSemanticHash = opsBody.semanticHash;

    // Measure buildHash before pinning
    const buildBeforeRes = await app.fetch(
      new Request(`http://localhost/api/projects/${project}/build`, {
        method: "POST",
        headers: ownerHeaders,
      }),
      TEST_ENV,
    );
    expect(buildBeforeRes.status).toBe(200);
    const buildBeforeBody = (await buildBeforeRes.json()) as {
      buildHash: string;
      semanticHash: string;
    };
    expect(buildBeforeBody.semanticHash).toBe(initialSemanticHash);

    // 2. Pin output on `step_trigger` containing a raw secret -> must be redacted via redactTelemetryPayload()
    const pinRes = await app.fetch(
      new Request(
        `http://localhost/api/projects/${project}/workflows/wf_orders/nodes/step_trigger/pin`,
        {
          method: "PUT",
          headers: {
            ...ownerHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            output: {
              orderId: "ord_pinned_42",
              amount: 25,
              balance: 500,
              apiKey: "sk-live-secret-should-be-redacted",
            },
            sourceRunId: "run_seed_01",
          }),
        },
      ),
      TEST_ENV,
    );
    expect(pinRes.status).toBe(200);
    const pinBody = (await pinRes.json()) as {
      pin: {
        output: {
          orderId: string;
          amount: number;
          balance: number;
          apiKey: string;
        };
        sourceRunId?: string;
        pinnedAt: string;
      };
    };
    expect(pinBody.pin.output.orderId).toBe("ord_pinned_42");
    expect(pinBody.pin.output.apiKey).toBe("[REDACTED]");
    expect(pinBody.pin.sourceRunId).toBe("run_seed_01");

    // 3. Verify GET /api/projects/:project/workflows/:workflowId/pins returns the redacted pin
    const listPinsRes = await app.fetch(
      new Request(
        `http://localhost/api/projects/${project}/workflows/wf_orders/pins`,
        {
          method: "GET",
          headers: ownerHeaders,
        },
      ),
      TEST_ENV,
    );
    expect(listPinsRes.status).toBe(200);
    const listPinsBody = (await listPinsRes.json()) as {
      pinnedOutputs: Record<string, { output: Record<string, unknown> }>;
    };
    expect(listPinsBody.pinnedOutputs.step_trigger?.output.orderId).toBe(
      "ord_pinned_42",
    );
    expect(listPinsBody.pinnedOutputs.step_trigger?.output.apiKey).toBe(
      "[REDACTED]",
    );

    // 4. Verify semanticHash and buildHash are 100% unchanged after pinning (non-semantic storage C2 / AD-S4)
    const buildAfterPinRes = await app.fetch(
      new Request(`http://localhost/api/projects/${project}/build`, {
        method: "POST",
        headers: ownerHeaders,
      }),
      TEST_ENV,
    );
    expect(buildAfterPinRes.status).toBe(200);
    const buildAfterPinBody = (await buildAfterPinRes.json()) as {
      buildHash: string;
      semanticHash: string;
    };
    expect(buildAfterPinBody.semanticHash).toBe(initialSemanticHash);
    expect(buildAfterPinBody.buildHash).toBe(buildBeforeBody.buildHash);

    // 5. Run single-step rehearsal on downstream `step_transform` WITHOUT explicit input -> resolves from pinned `step_trigger`
    const rehearseRes = await app.fetch(
      new Request(
        `http://localhost/api/projects/${project}/workflows/wf_orders/nodes/step_transform/test-step`,
        {
          method: "POST",
          headers: {
            ...ownerHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        },
      ),
      TEST_ENV,
    );
    expect(rehearseRes.status).toBe(200);
    const rehearseBody = (await rehearseRes.json()) as {
      status: string;
      output: { out: { orderId: string; amount: number } };
    };
    expect(rehearseBody.status).toBe("succeeded");
    expect(rehearseBody.output.out.orderId).toBe("ord_pinned_42");

    // 6. Run preview workflow with `usePinnedOutputs: true` -> `step_trigger` short-circuits with `durationMs: 0` and feeds `ord_pinned_42` downstream
    const previewRunRes = await app.fetch(
      new Request(
        `http://localhost/api/projects/${project}/workflows/wf_orders/runs`,
        {
          method: "POST",
          headers: {
            ...ownerHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            runId: "run_with_pinned_data",
            env: "preview",
            usePinnedOutputs: true,
            triggerPayload: { orderId: "ignored_live_payload", amount: 999 },
          }),
        },
      ),
      TEST_ENV,
    );
    expect(previewRunRes.status).toBe(200);
    const previewRunBody = (await previewRunRes.json()) as {
      runStatus: string;
      outputs: Record<string, { out?: Record<string, unknown> }>;
    };
    expect(previewRunBody.runStatus).toBe("succeeded");
    expect(previewRunBody.outputs.step_transform?.out?.orderId).toBe(
      "ord_pinned_42",
    );

    const pinnedRunEvents = await listStepEventsForRun(
      studioDb,
      "run_with_pinned_data",
    );
    const triggerEvent = pinnedRunEvents.find(
      (ev) => ev.nodeId === "step_trigger" && ev.status === "succeeded",
    );
    expect(triggerEvent?.durationMs).toBe(0);

    // 7. Unpin `step_trigger` via DELETE .../pin
    const unpinRes = await app.fetch(
      new Request(
        `http://localhost/api/projects/${project}/workflows/wf_orders/nodes/step_trigger/pin`,
        {
          method: "DELETE",
          headers: ownerHeaders,
        },
      ),
      TEST_ENV,
    );
    expect(unpinRes.status).toBe(200);

    // 8. Seed a failed run `run_failed_01` where `step_trigger` and `step_transform` succeeded, and `step_debit` failed
    await upsertRunRecord(studioDb, {
      runId: "run_failed_01",
      workflowId: "wf_orders",
      revision: 1,
      triggerType: "webhook",
      workspaceId: "ws_acme",
      status: "failed",
      durationMs: 85,
      retries: 1,
      errorStack: "Error: Temporary debit gateway failure",
      startedAt: "2026-10-30T12:00:00.000Z",
      endedAt: "2026-10-30T12:00:00.085Z",
    });
    await insertStepEvent(studioDb, {
      eventId: "ev_fail01_trig",
      runId: "run_failed_01",
      workflowId: "wf_orders",
      revision: 1,
      nodeId: "step_trigger",
      status: "succeeded",
      durationMs: 4,
      retries: 0,
      inputPreview: "{}",
      outputPreview: JSON.stringify({
        out: { orderId: "ord_retry_88", amount: 25, balance: 300 },
      }),
      createdAt: "2026-10-30T12:00:00.004Z",
    });
    await insertStepEvent(studioDb, {
      eventId: "ev_fail01_tx",
      runId: "run_failed_01",
      workflowId: "wf_orders",
      revision: 1,
      nodeId: "step_transform",
      status: "succeeded",
      durationMs: 6,
      retries: 0,
      inputPreview: "{}",
      outputPreview: JSON.stringify({
        out: { orderId: "ord_retry_88", amount: 25, balance: 300 },
      }),
      createdAt: "2026-10-30T12:00:00.010Z",
    });
    await insertStepEvent(studioDb, {
      eventId: "ev_fail01_debit",
      runId: "run_failed_01",
      workflowId: "wf_orders",
      revision: 1,
      nodeId: "step_debit",
      status: "failed",
      durationMs: 75,
      retries: 1,
      inputPreview: '{"amount":25}',
      outputPreview: "{}",
      errorStack: "Error: Temporary debit gateway failure",
      createdAt: "2026-10-30T12:00:00.085Z",
    });

    // 9. Call POST /api/projects/:project/runs/run_failed_01/rerun from `step_debit`
    const rerunRes = await app.fetch(
      new Request(
        `http://localhost/api/projects/${project}/runs/run_failed_01/rerun`,
        {
          method: "POST",
          headers: {
            ...ownerHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            fromNodeId: "step_debit",
            useCurrentDraftRev: true,
          }),
        },
      ),
      TEST_ENV,
    );
    expect(rerunRes.status).toBe(200);
    const rerunBody = (await rerunRes.json()) as {
      runId: string;
      retryOfRunId: string;
      fromNodeId: string;
      runStatus: string;
      stepEvents: Array<{ nodeId: string; reused?: boolean }>;
    };
    expect(rerunBody.retryOfRunId).toBe("run_failed_01");
    expect(rerunBody.fromNodeId).toBe("step_debit");
    expect(rerunBody.runStatus).toBe("succeeded");
    expect(
      rerunBody.stepEvents
        .filter((ev) => ev.reused)
        .map((ev) => ev.nodeId)
        .sort(),
    ).toEqual(["step_transform", "step_trigger"]);

    // 10. Query GET /api/projects/:project/runs -> original `run_failed_01` has `resolvedByRunId` pointing to `rerunBody.runId`
    const runsRes = await app.fetch(
      new Request(`http://localhost/api/projects/${project}/runs`, {
        method: "GET",
        headers: ownerHeaders,
      }),
      TEST_ENV,
    );
    expect(runsRes.status).toBe(200);
    const runsBody = (await runsRes.json()) as {
      runs: Array<{
        runId: string;
        retryOfRunId?: string | null;
        resolvedByRunId?: string | null;
      }>;
    };
    const originalFailedRun = runsBody.runs.find(
      (r) => r.runId === "run_failed_01",
    );
    expect(originalFailedRun?.resolvedByRunId).toBe(rerunBody.runId);
  });
});
