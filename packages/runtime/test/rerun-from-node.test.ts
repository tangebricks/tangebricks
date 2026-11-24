import { describe, expect, test } from "vitest";
import type { D1Like, D1Statement, Executor, Executors } from "@poc/sdk";
import {
  TELEMETRY_SIGNATURE_HEADER,
  insertStepEvent,
  listStepEventsForRun,
  signTelemetryPayload,
  upsertRunRecord,
} from "@poc/telemetry";
import {
  buildExecutorsFromCatalog,
  buildRegistryFromCatalog,
  executeWorkflowRun,
  handleWorkflowRerunRequest,
} from "../src/index.ts";

function createInMemoryTelemetryDb(): D1Like {
  const runs = new Map<string, Record<string, unknown>>();
  const stepEvents: Array<Record<string, unknown>> = [];

  const createStatement = (sql: string, bound: unknown[] = []): D1Statement => {
    const trimmed = sql.trim();
    return {
      bind(...values: unknown[]) {
        return createStatement(sql, values);
      },
      async run() {
        if (trimmed.startsWith("INSERT INTO px_runs")) {
          const [
            runId,
            workflowId,
            revision,
            triggerType,
            workspaceId,
            status,
            durationMs,
            retries,
            retryOfRunId,
            errorStack,
            startedAt,
            endedAt,
          ] = bound;
          runs.set(String(runId), {
            run_id: String(runId),
            workflow_id: String(workflowId),
            revision: Number(revision ?? 1),
            trigger_type: String(triggerType ?? "manual"),
            workspace_id: String(workspaceId ?? "default"),
            status: String(status),
            duration_ms: Number(durationMs ?? 0),
            retries: Number(retries ?? 0),
            retry_of_run_id: retryOfRunId ?? null,
            error_stack: errorStack ?? null,
            started_at: String(startedAt),
            ended_at: endedAt ?? null,
          });
        } else if (trimmed.startsWith("INSERT INTO px_step_events")) {
          const [
            eventId,
            runId,
            workflowId,
            revision,
            nodeId,
            status,
            durationMs,
            retries,
            inputPreview,
            outputPreview,
            errorStack,
            createdAt,
          ] = bound;
          const idx = stepEvents.findIndex(
            (e) => e.event_id === String(eventId),
          );
          const row = {
            seq: idx >= 0 ? (stepEvents[idx]!.seq as number) : stepEvents.length + 1,
            event_id: String(eventId),
            run_id: String(runId),
            workflow_id: String(workflowId),
            revision: Number(revision ?? 1),
            node_id: String(nodeId),
            status: String(status),
            duration_ms: Number(durationMs ?? 0),
            retries: Number(retries ?? 0),
            input_preview: String(inputPreview ?? "{}"),
            output_preview: String(outputPreview ?? "{}"),
            error_stack: errorStack ?? null,
            created_at: String(createdAt),
          };
          if (idx >= 0) {
            stepEvents[idx] = row;
          } else {
            stepEvents.push(row);
          }
        }
        return { success: true, results: [], meta: { changes: 1 } };
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        if (trimmed.includes("FROM px_runs WHERE run_id = ?")) {
          const runId = String(bound[0] ?? "");
          return (runs.get(runId) as T | undefined) ?? null;
        }
        if (trimmed.includes("FROM px_runs WHERE retry_of_run_id = ?")) {
          const sourceRunId = String(bound[0] ?? "");
          const matches = [...runs.values()].filter(
            (r) =>
              r.retry_of_run_id === sourceRunId && r.status === "succeeded",
          );
          const latest = matches[matches.length - 1];
          return latest ? ({ run_id: latest.run_id } as unknown as T) : null;
        }
        return null;
      },
      async all<T = Record<string, unknown>>() {
        if (trimmed.includes("FROM px_step_events")) {
          const runId = String(bound[0] ?? "");
          const matches = stepEvents.filter((e) => e.run_id === runId) as T[];
          return { success: true, results: matches, meta: { changes: 0 } };
        }
        return { success: true, results: [], meta: { changes: 0 } };
      },
    };
  };

  return {
    prepare(sql: string) {
      return createStatement(sql);
    },
    async batch(statements) {
      const out = [];
      for (const stmt of statements) {
        out.push(await stmt.run());
      }
      return out;
    },
    async exec() {
      return { count: 0, duration: 0 };
    },
  };
}

describe("Re-Run From Node & Pinned Step Output Short-Circuiting (@poc/runtime)", () => {
  const registry = buildRegistryFromCatalog();

  test("executes a 3-node workflow A -> B -> C where A has a side-effect counter and B fails on run 1; re-running from B executes B and C, succeeds, and leaves A's side-effect count at 1", async () => {
    const db = createInMemoryTelemetryDb();
    const secret = "px-rerun-test-secret-2026";

    let nodeASideEffects = 0;
    let nodeBAttempts = 0;
    let shouldFailNodeB = true;
    let nodeCReceivedFromB: unknown = null;

    const executors: Executors = new Map<string, Executor>(
      buildExecutorsFromCatalog(),
    );
    (executors as Map<string, Executor>).set("core.webhook", async (ctx) => {
      nodeASideEffects += 1;
      const payload = (ctx.payload ?? {}) as Record<string, unknown>;
      return {
        out: {
          orderId: payload.orderId ?? "ord_default",
          sideEffectSeq: nodeASideEffects,
          valueFromA: "minted-once-by-A",
        },
      };
    });
    (executors as Map<string, Executor>).set(
      "credit-wallet.debit",
      async (ctx) => {
        nodeBAttempts += 1;
        if (shouldFailNodeB) {
          throw new Error("Node B transient failure on run 1");
        }
        const upstream = (ctx.inputs.in ?? {}) as Record<string, unknown>;
        return {
          out: {
            ...upstream,
            processedByB: true,
            debitedAmount: Number(ctx.data.amount ?? 40),
          },
        };
      },
    );
    (executors as Map<string, Executor>).set("core.noop", async (ctx) => {
      const upstream = (ctx.inputs.in ?? {}) as Record<string, unknown>;
      nodeCReceivedFromB = upstream;
      return {
        out: {
          completed: true,
          finalOrderId: upstream.orderId,
          valueFromA: upstream.valueFromA,
          sideEffectSeq: upstream.sideEffectSeq,
        },
      };
    });

    const graph = {
      nodes: [
        { id: "node_a", type: "core.webhook", data: { method: "post" } },
        { id: "node_b", type: "credit-wallet.debit", data: { amount: 40 } },
        { id: "node_c", type: "core.noop", data: {} },
      ],
      edges: [
        {
          id: "e_ab",
          source: "node_a",
          sourceHandle: "out",
          target: "node_b",
          targetHandle: "in",
        },
        {
          id: "e_bc",
          source: "node_b",
          sourceHandle: "out",
          target: "node_c",
          targetHandle: "in",
        },
      ],
    };

    // Run 1: A succeeds (sideEffectSeq = 1), B fails, C is skipped
    const run1 = await executeWorkflowRun(
      {
        runId: "run_1_failed",
        workflowId: "wf_abc",
        revision: 1,
        triggerType: "manual",
        triggerPayload: { orderId: "ord_500" },
        workspaceId: "ws_test",
        graph,
      },
      {
        registry,
        executors,
        db,
      },
    );

    expect(run1.runStatus).toBe("failed");
    expect(run1.failed.node_b).toContain("Node B transient failure on run 1");
    expect(nodeASideEffects).toBe(1);
    expect(nodeBAttempts).toBe(1);
    expect(nodeCReceivedFromB).toBeNull();

    // Fix B and re-run from node_b using POST /__px/runs/rerun handler
    shouldFailNodeB = false;

    const rerunPayload = JSON.stringify({
      runId: "run_2_retry_from_b",
      sourceRunId: "run_1_failed",
      fromNodeId: "node_b",
      workflowId: "wf_abc",
      revision: 2,
      workspaceId: "ws_test",
      graph: {
        nodes: [
          { id: "node_a", type: "core.webhook", data: { method: "post" } },
          { id: "node_b", type: "credit-wallet.debit", data: { amount: 25 } },
          { id: "node_c", type: "core.noop", data: {} },
        ],
        edges: graph.edges,
      },
    });
    const sig = await signTelemetryPayload(rerunPayload, secret);

    const rerunReq = new Request("http://runtime.internal/__px/runs/rerun", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TELEMETRY_SIGNATURE_HEADER]: sig,
      },
      body: rerunPayload,
    });

    const rerunRes = await handleWorkflowRerunRequest(rerunReq, {
      registry,
      executors,
      db,
      telemetrySecret: secret,
    });

    expect(rerunRes).not.toBeNull();
    expect(rerunRes!.status).toBe(200);
    const rerunBody = (await rerunRes!.json()) as {
      runId: string;
      retryOfRunId: string;
      runStatus: string;
      outputs: Record<string, Record<string, unknown>>;
      stepEvents: Array<{ nodeId: string; status: string; reused?: boolean }>;
    };

    expect(rerunBody.runId).toBe("run_2_retry_from_b");
    expect(rerunBody.retryOfRunId).toBe("run_1_failed");
    expect(rerunBody.runStatus).toBe("succeeded");

    // Proof that node_a was NOT re-executed (side-effect count stays strictly at 1!)
    expect(nodeASideEffects).toBe(1);
    expect(nodeBAttempts).toBe(2);
    expect(nodeCReceivedFromB).toMatchObject({
      orderId: "ord_500",
      sideEffectSeq: 1,
      valueFromA: "minted-once-by-A",
      processedByB: true,
      debitedAmount: 25,
    });

    const reusedNodeAEvent = rerunBody.stepEvents.find(
      (ev) => ev.nodeId === "node_a" && ev.status === "succeeded",
    );
    expect(reusedNodeAEvent?.reused).toBe(true);

    const retryEvents = await listStepEventsForRun(db, "run_2_retry_from_b");
    expect(
      retryEvents.some(
        (ev) => ev.nodeId === "node_b" && ev.status === "succeeded",
      ),
    ).toBe(true);
    expect(
      retryEvents.some(
        (ev) => ev.nodeId === "node_c" && ev.status === "succeeded",
      ),
    ).toBe(true);
  });

  test("refuses partial re-run with HTTP 422 UPSTREAM_OUTPUT_UNAVAILABLE when an upstream ancestor output is missing or truncated past 16 KB", async () => {
    const db = createInMemoryTelemetryDb();
    const secret = "px-rerun-trunc-secret";
    const executors = buildExecutorsFromCatalog();

    await upsertRunRecord(db, {
      runId: "run_truncated_upstream",
      workflowId: "wf_trunc",
      revision: 1,
      triggerType: "manual",
      workspaceId: "ws_test",
      status: "failed",
      durationMs: 45,
      retries: 0,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });

    await insertStepEvent(db, {
      eventId: "ev_trunc_a",
      runId: "run_truncated_upstream",
      workflowId: "wf_trunc",
      revision: 1,
      nodeId: "node_a",
      status: "succeeded",
      durationMs: 10,
      retries: 0,
      inputPreview: "{}",
      outputPreview: JSON.stringify({
        __truncated: true,
        originalBytes: 24576,
        preview: "truncated...",
      }),
      createdAt: new Date().toISOString(),
    });

    const payload = JSON.stringify({
      sourceRunId: "run_truncated_upstream",
      fromNodeId: "node_b",
      workflowId: "wf_trunc",
      graph: {
        nodes: [
          { id: "node_a", type: "core.webhook", data: { method: "post" } },
          { id: "node_b", type: "core.noop", data: {} },
        ],
        edges: [
          {
            id: "e1",
            source: "node_a",
            sourceHandle: "out",
            target: "node_b",
            targetHandle: "in",
          },
        ],
      },
    });
    const sig = await signTelemetryPayload(payload, secret);

    const req = new Request("http://runtime.internal/__px/runs/rerun", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TELEMETRY_SIGNATURE_HEADER]: sig,
      },
      body: payload,
    });

    const res = await handleWorkflowRerunRequest(req, {
      registry,
      executors,
      db,
      telemetrySecret: secret,
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(422);
    const body = (await res!.json()) as {
      error: { code: string; nodeId: string; reason: string };
    };
    expect(body.error.code).toBe("UPSTREAM_OUTPUT_UNAVAILABLE");
    expect(body.error.nodeId).toBe("node_a");
    expect(body.error.reason).toBe("output_truncated_16kb");
  });

  test("short-circuits pinned nodes in preview rehearsal runs (status: succeeded, durationMs: 0, fromPinned: true) without invoking their executor", async () => {
    let triggerExecCount = 0;
    const executors = new Map<string, Executor>(buildExecutorsFromCatalog());
    executors.set("core.webhook", async () => {
      triggerExecCount += 1;
      return { out: { amount: 10 } };
    });

    const res = await executeWorkflowRun(
      {
        workflowId: "wf_pinned_preview",
        usePinnedOutputs: true,
        pinnedOutputs: {
          step_1: { orderId: "pinned_999", amount: 777 },
        },
        graph: {
          nodes: [
            { id: "step_1", type: "core.webhook", data: { method: "post" } },
            { id: "step_2", type: "core.noop", data: {} },
          ],
          edges: [
            {
              id: "e1",
              source: "step_1",
              sourceHandle: "out",
              target: "step_2",
              targetHandle: "in",
            },
          ],
        },
      },
      {
        registry,
        executors,
      },
    );

    expect(res.runStatus).toBe("succeeded");
    expect(triggerExecCount).toBe(0);
    expect(res.outputs.step_2).toEqual({
      out: { orderId: "pinned_999", amount: 777 },
    });
    const pinnedEvent = res.stepEvents.find(
      (ev) => ev.nodeId === "step_1" && ev.status === "succeeded",
    );
    expect(pinnedEvent).toBeDefined();
    expect(pinnedEvent?.durationMs).toBe(0);
    expect(pinnedEvent?.fromPinned).toBe(true);
  });
});
