import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import type { D1Like } from "@poc/sdk";
import { upsertRunRecord, insertStepEvent } from "@poc/telemetry";
import { app, ensureStudioD1Schema } from "../src/index.ts";
import type { StudioApiEnv } from "../src/index.ts";
import { signInTestHuman } from "./human-session.ts";
import { ensureTestProjectToken } from "./project-token.ts";

const rawEnv = env as unknown as StudioApiEnv;
const studioDb = rawEnv.STUDIO_DB as D1Like;

const TEST_ENV: StudioApiEnv = {
  ...rawEnv,
  PX_TELEMETRY_SECRET: "px-studio-run-history-secret-2026",
  BETTER_AUTH_SECRET: "studio-test-better-auth-secret-0123456789abcdef",
  PX_VAULT_KEY: "studio-test-aes-gcm-256-vault-master-key-99887766",
};

describe("GET /api/projects/:projectId/runs and GET /api/projects/:projectId/runs/:runId", () => {
  beforeEach(async () => {
    await ensureStudioD1Schema(studioDb);
    await studioDb.batch([
      studioDb.prepare("DELETE FROM px_step_events"),
      studioDb.prepare("DELETE FROM px_runs"),
    ]);
  });

  test("replays a historical run at r1 with its original workflow graph even after a node is deleted in r2, and supports filtering and pruning", async () => {
    const project = "run-history-replay-proj";
    const { headers: ownerHeaders } = await ensureTestProjectToken(TEST_ENV, project);

    // 1. Create r1 workflow with 3 nodes: step_trigger -> step_removed_in_r2 -> step_debit
    const r1Res = await app.fetch(
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
              opId: "op-r1-1",
              type: "enable_brick",
              brickId: "multi-workspace",
            },
            {
              opId: "op-r1-2",
              type: "enable_brick",
              brickId: "credit-wallet",
              config: { creditsPerUnit: 1, minOrderAmount: 1 },
            },
            {
              opId: "op-r1-3",
              type: "add_workflow",
              workflow: {
                id: "wf_checkout",
                name: "Checkout Flow",
                trigger: "core.webhook",
                nodes: [
                  {
                    id: "step_trigger",
                    type: "core.webhook",
                    label: "Webhook Trigger",
                    data: { method: "post" },
                  },
                  {
                    id: "step_removed_in_r2",
                    type: "core.noop",
                    label: "Legacy Audit Step (r1 only)",
                    data: {},
                  },
                  {
                    id: "step_debit",
                    type: "credit-wallet.debit",
                    label: "Debit Wallet",
                    data: { amount: 40 },
                  },
                ],
                edges: [
                  {
                    id: "e1",
                    source: "step_trigger",
                    sourceHandle: "out",
                    target: "step_removed_in_r2",
                    targetHandle: "in",
                  },
                  {
                    id: "e2",
                    source: "step_removed_in_r2",
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
    expect(r1Res.status).toBe(200);
    const r1Body = (await r1Res.json()) as { revision: number };
    expect(r1Body.revision).toBe(1);

    // 2. Execute workflow at r1 (creates run_r1_exec in D1 with revision = 1)
    const execR1Res = await app.fetch(
      new Request(
        `http://localhost/api/projects/${project}/workflows/wf_checkout/runs`,
        {
          method: "POST",
          headers: {
            ...ownerHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            runId: "run_r1_historical",
            triggerType: "manual",
            triggerPayload: { orderId: "ord_101", amount: 40, balance: 200 },
          }),
        },
      ),
      TEST_ENV,
    );
    expect(execR1Res.status).toBe(200);

    // 3. Advance blueprint to r2 by removing `step_removed_in_r2` and rewiring `step_trigger -> step_debit`
    const r2Res = await app.fetch(
      new Request(`http://localhost/api/projects/${project}/ops`, {
        method: "POST",
        headers: {
          ...ownerHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          baseRevision: 1,
          author: { type: "human", id: "alice" },
          ops: [
            {
              opId: "op-r2-rm-node",
              type: "remove_node",
              workflowId: "wf_checkout",
              nodeId: "step_removed_in_r2",
            },
            {
              opId: "op-r2-connect",
              type: "connect_edges",
              workflowId: "wf_checkout",
              edges: [
                {
                  id: "e3",
                  source: "step_trigger",
                  sourceHandle: "out",
                  target: "step_debit",
                  targetHandle: "in",
                },
              ],
            },
          ],
        }),
      }),
      TEST_ENV,
    );
    expect(r2Res.status).toBe(200);
    const r2Body = (await r2Res.json()) as { revision: number };
    expect(r2Body.revision).toBe(2);

    // 4. Seed a failed run at r2 with retries=2 and an expired run (20 days old)
    await upsertRunRecord(studioDb, {
      runId: "run_r2_failed",
      workflowId: "wf_checkout",
      revision: 2,
      triggerType: "webhook",
      workspaceId: "ws_default",
      status: "failed",
      durationMs: 112,
      retries: 2,
      errorStack: "Error: Insufficient wallet credits\n    at debitWallet (wallet.ts:42:11)",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    }, { projectId: project });
    await insertStepEvent(studioDb, {
      workspaceId: "ws_default",
      eventId: "ev_r2_fail_debit",
      runId: "run_r2_failed",
      workflowId: "wf_checkout",
      revision: 2,
      nodeId: "step_debit",
      status: "failed",
      durationMs: 112,
      retries: 2,
      inputPreview: '{"amount":9999}',
      outputPreview: "{}",
      errorStack: "Error: Insufficient wallet credits\n    at debitWallet (wallet.ts:42:11)",
      createdAt: new Date().toISOString(),
    }, { projectId: project });

    const expiredDate = new Date(Date.now() - 20 * 86_400_000).toISOString();
    await upsertRunRecord(studioDb, {
      runId: "run_expired_20d",
      workflowId: "wf_checkout",
      revision: 1,
      triggerType: "schedule",
      workspaceId: "ws_default",
      status: "succeeded",
      durationMs: 15,
      retries: 0,
      startedAt: expiredDate,
      endedAt: expiredDate,
    }, { projectId: project });

    // 5. Query GET /api/projects/:project/runs with filters
    const listFailedRes = await app.fetch(
      new Request(
        `http://localhost/api/projects/${project}/runs?env=preview&workflowId=wf_checkout&status=failed&trigger=webhook`,
        {
          method: "GET",
          headers: ownerHeaders,
        },
      ),
      TEST_ENV,
    );
    expect(listFailedRes.status).toBe(200);
    const listFailedBody = (await listFailedRes.json()) as {
      runs: Array<{ runId: string; failedNodeId: string | null; retries: number }>;
    };
    expect(listFailedBody.runs.map((r) => r.runId)).toEqual(["run_r2_failed"]);
    expect(listFailedBody.runs[0]?.failedNodeId).toBe("step_debit");
    expect(listFailedBody.runs[0]?.retries).toBe(2);

    // 6. Query GET /api/projects/:project/runs/run_r1_historical -> must return historicalWorkflow from r1 containing step_removed_in_r2!
    const detailR1Res = await app.fetch(
      new Request(
        `http://localhost/api/projects/${project}/runs/run_r1_historical?env=preview`,
        {
          method: "GET",
          headers: ownerHeaders,
        },
      ),
      TEST_ENV,
    );
    expect(detailR1Res.status).toBe(200);
    const detailR1 = (await detailR1Res.json()) as {
      run: { runId: string; revision: number };
      currentRevision: number;
      historicalRevision: number;
      isHistoricalRevision: boolean;
      historicalWorkflow: {
        id: string;
        nodes: Array<{ id: string }>;
      };
      stepEvents: Array<{ nodeId: string; status: string }>;
    };
    expect(detailR1.run.revision).toBe(1);
    expect(detailR1.currentRevision).toBe(2);
    expect(detailR1.historicalRevision).toBe(1);
    expect(detailR1.isHistoricalRevision).toBe(true);
    expect(
      detailR1.historicalWorkflow.nodes.map((n) => n.id),
    ).toContain("step_removed_in_r2");
    expect(
      detailR1.stepEvents.some(
        (e) => e.nodeId === "step_removed_in_r2" && e.status === "succeeded",
      ),
    ).toBe(true);

    // 7. Prune expired runs via POST /api/projects/:project/runs/prune. Story 16: px_runs has no project column, so the
    // prune spans every org and only a platform operator may run it; the project's own token is refused and nothing goes.
    const refusedPrune = await app.fetch(
      new Request(`http://localhost/api/projects/${project}/runs/prune`, {
        method: "POST",
        headers: { ...ownerHeaders, "content-type": "application/json" },
        body: JSON.stringify({ retentionDays: 14 }),
      }),
      TEST_ENV,
    );
    expect(refusedPrune.status).toBe(403);
    const operator = await signInTestHuman(TEST_ENV, "run-prune-operator", "owner");
    const pruneRes = await app.fetch(
      new Request(`http://localhost/api/projects/${project}/runs/prune`, {
        method: "POST",
        headers: {
          ...operator.headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({ retentionDays: 14 }),
      }),
      { ...TEST_ENV, PX_PLATFORM_OPERATORS: operator.userId },
    );
    expect(pruneRes.status).toBe(200);
    const pruneBody = (await pruneRes.json()) as {
      deletedRuns: number;
      retentionDays: number;
    };
    expect(pruneBody.retentionDays).toBe(14);
    expect(pruneBody.deletedRuns).toBe(1);
  });
});
