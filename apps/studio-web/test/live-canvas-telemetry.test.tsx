import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WorkflowCanvasView } from "../src/components/WorkflowCanvasView.tsx";
import { useStudioStore } from "../src/store.ts";
import { DEFAULT_CATALOG } from "../src/types.ts";
import type { BlueprintState } from "../src/types.ts";

const BRANCHING_BLUEPRINT: BlueprintState = {
  schemaVersion: 2,
  project: "acme-saas",
  identity: "stub",
  bricks: [
    { id: "multi-workspace", config: {} },
    { id: "credit-wallet", config: { creditsPerUnit: 10, minOrderAmount: 100 } },
    { id: "in-app-notifications", config: {} },
  ],
  entities: [],
  workflows: [
    {
      id: "wf_branching",
      name: "Branching Checkout DAG",
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
          label: "Check VIP Tier",
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
          label: "Send Standard Notice",
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
  ],
  secretRefs: [],
};

describe("WorkflowCanvasView — Live Telemetry Node Overlays, Edge Item Counts & Reduced Motion", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    useStudioStore.getState().resetStore({
      user: { id: "u_alice", email: "alice@example.com", name: "Alice" },
      orgs: [{ id: "org_default", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_default",
      activeProjectId: "acme-saas",
      currentRevision: 5,
      projectState: structuredClone(BRANCHING_BLUEPRINT),
      catalog: DEFAULT_CATALOG,
      activeNav: "workflows",
      activeWorkflowId: "wf_branching",
      prefersReducedMotion: false,
    });
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("renders live WebSocket telemetry transitions (queued -> running -> succeeded/skipped/failed), edge item counts, and respects prefers-reduced-motion: reduce", async () => {
    render(<WorkflowCanvasView />);

    // 1. Emit queued frames for all 4 nodes
    act(() => {
      for (const nodeId of ["step_trigger", "step_if", "step_debit", "step_notify"]) {
        useStudioStore.getState().applyIncomingTelemetryFrame({
          type: "telemetry",
          project: "acme-saas",
          rev: 5,
          runId: "run_live_1",
          workflowId: "wf_branching",
          nodeId,
          status: "queued",
          durationMs: 0,
          retries: 0,
          inputPreview: "{}",
          outputPreview: "{}",
          timestamp: "2026-10-30T12:00:00.000Z",
        });
      }
    });

    for (const nodeId of ["step_trigger", "step_if", "step_debit", "step_notify"]) {
      const badge = screen.getByTestId(`node-telemetry-badge-${nodeId}`);
      expect(badge.getAttribute("data-status")).toBe("queued");
      expect(badge.textContent).toContain("⏳");
      expect(badge.textContent).toContain("Queued");
    }

    // 2. Emit running frame for step_trigger (motion allowed vs prefers-reduced-motion: reduce)
    act(() => {
      useStudioStore.getState().applyIncomingTelemetryFrame({
        type: "telemetry",
        project: "acme-saas",
        rev: 5,
        runId: "run_live_1",
        workflowId: "wf_branching",
        nodeId: "step_trigger",
        status: "running",
        durationMs: 0,
        retries: 0,
        inputPreview: "{}",
        outputPreview: "{}",
        timestamp: "2026-10-30T12:00:00.050Z",
      });
    });

    const runningBadge = screen.getByTestId("node-telemetry-badge-step_trigger");
    expect(runningBadge.getAttribute("data-status")).toBe("running");
    expect(runningBadge.textContent).toContain("⟳");
    expect(runningBadge.textContent).toContain("Running");
    expect(runningBadge.className).toContain("animate-pulse");

    // Enable prefers-reduced-motion: reduce -> pulse animation class is removed
    act(() => {
      useStudioStore.getState().setPrefersReducedMotion(true);
    });
    expect(runningBadge.getAttribute("data-reduced-motion")).toBe("true");
    expect(runningBadge.className).not.toContain("animate-pulse");

    // 3. Emit succeeded frames for step_trigger, step_if, step_debit and skipped for step_notify
    act(() => {
      useStudioStore.getState().applyIncomingTelemetryFrame({
        type: "telemetry",
        project: "acme-saas",
        rev: 5,
        runId: "run_live_1",
        workflowId: "wf_branching",
        nodeId: "step_trigger",
        status: "succeeded",
        durationMs: 6,
        retries: 0,
        inputPreview: "{}",
        outputPreview: JSON.stringify({
          out: [{ orderId: "ord_1" }, { orderId: "ord_2" }, { orderId: "ord_3" }],
        }),
        timestamp: "2026-10-30T12:00:00.100Z",
      });
      useStudioStore.getState().applyIncomingTelemetryFrame({
        type: "telemetry",
        project: "acme-saas",
        rev: 5,
        runId: "run_live_1",
        workflowId: "wf_branching",
        nodeId: "step_if",
        status: "succeeded",
        durationMs: 4,
        retries: 0,
        inputPreview: "{}",
        outputPreview: JSON.stringify({
          out: { matched: true, branch: "true", value: { tier: "vip" } },
          true: { tier: "vip", balance: 100 },
          false: null,
        }),
        timestamp: "2026-10-30T12:00:00.150Z",
      });
      useStudioStore.getState().applyIncomingTelemetryFrame({
        type: "telemetry",
        project: "acme-saas",
        rev: 5,
        runId: "run_live_1",
        workflowId: "wf_branching",
        nodeId: "step_debit",
        status: "succeeded",
        durationMs: 14,
        retries: 0,
        inputPreview: "{}",
        outputPreview: JSON.stringify({
          out: { operation: "debit", debited: 25, balanceAfter: 75 },
        }),
        timestamp: "2026-10-30T12:00:00.200Z",
      });
      useStudioStore.getState().applyIncomingTelemetryFrame({
        type: "telemetry",
        project: "acme-saas",
        rev: 5,
        runId: "run_live_1",
        workflowId: "wf_branching",
        nodeId: "step_notify",
        status: "skipped",
        durationMs: 0,
        retries: 0,
        inputPreview: "{}",
        outputPreview: "{}",
        timestamp: "2026-10-30T12:00:00.210Z",
      });
    });

    const debitBadge = screen.getByTestId("node-telemetry-badge-step_debit");
    expect(debitBadge.getAttribute("data-status")).toBe("succeeded");
    expect(debitBadge.textContent).toContain("✓");
    expect(debitBadge.textContent).toContain("Succeeded");
    expect(debitBadge.textContent).toContain("14 ms");

    const skippedBadge = screen.getByTestId("node-telemetry-badge-step_notify");
    expect(skippedBadge.getAttribute("data-status")).toBe("skipped");
    expect(skippedBadge.textContent).toContain("—");
    expect(skippedBadge.textContent).toContain("Skipped");

    // Verify traversed edge item-count pills: e_trig_if has 3 items, e_if_true has 1 item, e_if_false is not traversed
    const edgeTrigIf = screen.getByTestId("edge-item-count-e_trig_if");
    expect(edgeTrigIf.textContent).toContain("3 items");
    const edgeIfTrue = screen.getByTestId("edge-item-count-e_if_true");
    expect(edgeIfTrue.textContent).toContain("1 item");
    expect(screen.queryByTestId("edge-item-count-e_if_false")).toBeNull();

    // 4. Click Test workflow button and verify failed step badge + error summary tooltip
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          runId: "run_live_fail_2",
          workflowId: "wf_branching",
          revision: 5,
          triggerType: "manual",
          workspaceId: "ws_preview",
          status: "queued",
          runStatus: "failed",
          durationMs: 19,
          outputs: {},
          failed: {
            step_debit: "credit-wallet.debit (step_debit): insufficient balance (2 < 25)",
          },
          skipped: ["step_notify"],
          stepEvents: [
            {
              eventId: "e1",
              runId: "run_live_fail_2",
              workflowId: "wf_branching",
              revision: 5,
              nodeId: "step_debit",
              status: "failed",
              durationMs: 9,
              retries: 0,
              inputPreview: '{"balance":2}',
              outputPreview: "{}",
              errorStack: "Error: credit-wallet.debit (step_debit): insufficient balance (2 < 25)",
              createdAt: "2026-10-30T12:01:00.000Z",
              cursor: 20,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    fireEvent.click(screen.getByTestId("test-workflow-button"));

    await waitFor(() => {
      const failedBadge = screen.getByTestId("node-telemetry-badge-step_debit");
      expect(failedBadge.getAttribute("data-status")).toBe("failed");
      expect(failedBadge.textContent).toContain("✕");
      expect(failedBadge.textContent).toContain("Failed");
    });

    const errSummary = screen.getByTestId("node-telemetry-error-step_debit");
    expect(errSummary.textContent).toContain("insufficient balance (2 < 25)");
  });
});
