import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RightDock } from "../src/components/RightDock.tsx";
import { WorkflowCanvasView } from "../src/components/WorkflowCanvasView.tsx";
import { useStudioStore } from "../src/store.ts";
import { DEFAULT_CATALOG } from "../src/types.ts";
import type { BlueprintState } from "../src/types.ts";

const SAMPLE_BLUEPRINT: BlueprintState = {
  schemaVersion: 2,
  project: "acme-pin-rerun",
  identity: "stub",
  bricks: [
    { id: "multi-workspace", config: {} },
    { id: "credit-wallet", config: { creditsPerUnit: 1, minOrderAmount: 1 } },
  ],
  entities: [],
  workflows: [
    {
      id: "wf_orders",
      name: "Order Billing Flow",
      nodes: [
        {
          id: "step_trigger",
          type: "core.webhook",
          label: "Webhook Trigger",
          data: { method: "post" },
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
          target: "step_debit",
          sourceHandle: "out",
          targetHandle: "in",
        },
      ],
    },
  ],
  secretRefs: [],
};

describe("Pin Step Output, Use Pinned Data Toggle & Re-Run From Node UI", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    useStudioStore.getState().resetStore({
      user: { id: "u_alice", email: "alice@example.com", name: "Alice" },
      orgs: [{ id: "org_default", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_default",
      activeProjectId: "acme-pin-rerun",
      currentRevision: 1,
      projectState: structuredClone(SAMPLE_BLUEPRINT),
      catalog: DEFAULT_CATALOG,
      activeNav: "workflows",
      activeWorkflowId: "wf_orders",
      selection: { kind: "node", id: "step_trigger", workflowId: "wf_orders" },
      rightDockOpen: true,
      rightDockTab: "inspector",
    });
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("pins and unpins node output from Inspector, renders canvas Pinned badge, toggles Use pinned data, re-runs from node in Run Replay Inspector, and displays Resolved by retry badge", async () => {
    let isTriggerPinned = false;
    let rerunTriggered = false;

    const failedRunSummary = {
      runId: "run_failed_101",
      workflowId: "wf_orders",
      revision: 1,
      triggerType: "webhook",
      workspaceId: "ws_acme",
      status: "failed" as const,
      durationMs: 92,
      retries: 1,
      errorStack: "Error: Debit service timeout",
      startedAt: "2026-10-30T14:00:00.000Z",
      endedAt: "2026-10-30T14:00:00.092Z",
      failedNodeId: "step_debit",
      stepCount: 2,
      get resolvedByRunId() {
        return rerunTriggered ? "run_retry_202" : null;
      },
    };

    const retryRunSummary = {
      runId: "run_retry_202",
      workflowId: "wf_orders",
      revision: 1,
      triggerType: "manual",
      workspaceId: "ws_acme",
      status: "succeeded" as const,
      durationMs: 18,
      retries: 0,
      retryOfRunId: "run_failed_101",
      startedAt: "2026-10-30T14:01:00.000Z",
      endedAt: "2026-10-30T14:01:00.018Z",
      failedNodeId: null,
      stepCount: 1,
    };

    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.endsWith("/workflows/wf_orders/pins") && method === "GET") {
        return new Response(
          JSON.stringify({
            project: "acme-pin-rerun",
            workflowId: "wf_orders",
            pinnedOutputs: isTriggerPinned
              ? {
                  step_trigger: {
                    output: { orderId: "ord_pinned_ui", amount: 40 },
                    pinnedAt: "2026-10-30T14:00:00.000Z",
                  },
                }
              : {},
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.endsWith("/workflows/wf_orders/nodes/step_trigger/pin") && method === "PUT") {
        isTriggerPinned = true;
        return new Response(
          JSON.stringify({
            project: "acme-pin-rerun",
            workflowId: "wf_orders",
            nodeId: "step_trigger",
            pin: {
              output: { orderId: "ord_pinned_ui", amount: 40 },
              pinnedAt: "2026-10-30T14:00:00.000Z",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.endsWith("/workflows/wf_orders/nodes/step_trigger/pin") && method === "DELETE") {
        isTriggerPinned = false;
        return new Response(
          JSON.stringify({
            project: "acme-pin-rerun",
            workflowId: "wf_orders",
            nodeId: "step_trigger",
            removed: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.includes("/runs/run_failed_101/rerun") && method === "POST") {
        rerunTriggered = true;
        return new Response(
          JSON.stringify({
            runId: "run_retry_202",
            retryOfRunId: "run_failed_101",
            fromNodeId: "step_debit",
            workflowId: "wf_orders",
            revision: 1,
            env: "preview",
            status: "succeeded",
            durationMs: 18,
            failedNodeId: null,
            reusedNodeIds: ["step_trigger"],
            outputs: {
              step_trigger: { out: { orderId: "ord_pinned_ui", amount: 40 } },
              step_debit: { out: { debited: 40, remainingBalance: 160 } },
            },
            frames: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.includes("/runs/run_failed_101")) {
        return new Response(
          JSON.stringify({
            project: "acme-pin-rerun",
            env: "preview",
            run: {
              ...failedRunSummary,
              resolvedByRunId: rerunTriggered ? "run_retry_202" : null,
            },
            currentRevision: 1,
            historicalRevision: 1,
            isHistoricalRevision: false,
            historicalState: SAMPLE_BLUEPRINT,
            historicalWorkflow: SAMPLE_BLUEPRINT.workflows[0],
            stepEvents: [
              {
                eventId: "ev_trig",
                runId: "run_failed_101",
                workflowId: "wf_orders",
                revision: 1,
                nodeId: "step_trigger",
                status: "succeeded",
                durationMs: 4,
                retries: 0,
                inputPreview: "{}",
                outputPreview: '{"out":{"orderId":"ord_pinned_ui","amount":40}}',
                createdAt: "2026-10-30T14:00:00.004Z",
              },
              {
                eventId: "ev_debit",
                runId: "run_failed_101",
                workflowId: "wf_orders",
                revision: 1,
                nodeId: "step_debit",
                status: "failed",
                durationMs: 88,
                retries: 1,
                inputPreview: '{"amount":40}',
                outputPreview: "{}",
                errorStack: "Error: Debit service timeout",
                createdAt: "2026-10-30T14:00:00.092Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.includes("/runs/run_retry_202")) {
        return new Response(
          JSON.stringify({
            project: "acme-pin-rerun",
            env: "preview",
            run: retryRunSummary,
            currentRevision: 1,
            historicalRevision: 1,
            isHistoricalRevision: false,
            historicalState: SAMPLE_BLUEPRINT,
            historicalWorkflow: SAMPLE_BLUEPRINT.workflows[0],
            stepEvents: [
              {
                eventId: "ev_retry_debit",
                runId: "run_retry_202",
                workflowId: "wf_orders",
                revision: 1,
                nodeId: "step_debit",
                status: "succeeded",
                durationMs: 18,
                retries: 0,
                inputPreview: '{"amount":40}',
                outputPreview: '{"out":{"debited":40,"remainingBalance":160}}',
                createdAt: "2026-10-30T14:01:00.018Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.includes("/runs")) {
        return new Response(
          JSON.stringify({
            project: "acme-pin-rerun",
            env: "preview",
            runs: rerunTriggered
              ? [
                  retryRunSummary,
                  {
                    ...failedRunSummary,
                    resolvedByRunId: "run_retry_202",
                  },
                ]
              : [failedRunSummary],
            nextCursor: null,
            hasMore: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    render(
      <div>
        <WorkflowCanvasView />
        <RightDock />
      </div>,
    );

    // 1. Switch Node Inspector to `I/O & Test Step` tab and click `pin-node-output-button`
    fireEvent.click(screen.getByTestId("inspector-node-tab-io"));
    fireEvent.change(screen.getByTestId("test-step-input-editor"), {
      target: { value: '{"orderId":"ord_pinned_ui","amount":40}' },
    });
    fireEvent.click(screen.getByTestId("pin-node-output-button"));

    await waitFor(() => {
      expect(screen.getByTestId("node-pinned-badge-step_trigger")).toBeTruthy();
      expect(screen.getByTestId("unpin-node-output-button")).toBeTruthy();
    });

    // 2. Select downstream node `step_debit` -> verify test step input defaults to pinned output from `step_trigger`
    fireEvent.click(screen.getByTestId("canvas-node-step_debit"));
    await waitFor(() => {
      expect(screen.getByTestId("test-step-input-source-badge").textContent).toContain("Pinned output from step_trigger");
    });

    // 3. Toggle `use-pinned-data-toggle` on canvas toolbar
    const usePinnedCheckbox = screen.getByTestId("use-pinned-data-toggle") as HTMLInputElement;
    expect(usePinnedCheckbox.checked).toBe(true);
    fireEvent.click(usePinnedCheckbox);
    expect(usePinnedCheckbox.checked).toBe(false);
    fireEvent.click(usePinnedCheckbox);
    expect(usePinnedCheckbox.checked).toBe(true);

    // 4. Select `step_trigger` and click `unpin-node-output-button`
    fireEvent.click(screen.getByTestId("canvas-node-step_trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("unpin-node-output-button")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("unpin-node-output-button"));
    await waitFor(() => {
      expect(screen.queryByTestId("node-pinned-badge-step_trigger")).toBeNull();
    });

    // 5. Open Run History drawer, replay `run_failed_101`, and click `rerun-from-node-button` on `step_debit`
    fireEvent.click(screen.getByTestId("toggle-run-history-drawer"));
    await waitFor(() => {
      expect(screen.getByTestId("run-row-run_failed_101")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("replay-run-button-run_failed_101"));

    await waitFor(() => {
      expect(screen.getByTestId("inspector-run-replay-panel")).toBeTruthy();
      expect(screen.getByTestId("rerun-from-node-button")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("rerun-from-node-button"));

    // 6. Verify `run-resolved-by-retry-badge-run_failed_101` appears on the original failed run in Run History
    await waitFor(() => {
      expect(screen.getByTestId("run-resolved-by-retry-badge-run_failed_101")).toBeTruthy();
    });
    expect(screen.getByTestId("run-resolved-by-retry-badge-run_failed_101").textContent).toContain("Resolved by retry (run_retry_202)");
  });
});
