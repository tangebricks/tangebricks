import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RightDock } from "../src/components/RightDock.tsx";
import { WorkflowCanvasView } from "../src/components/WorkflowCanvasView.tsx";
import { useStudioStore } from "../src/store.ts";
import { DEFAULT_CATALOG } from "../src/types.ts";
import type { BlueprintState } from "../src/types.ts";

const CURRENT_R2_BLUEPRINT: BlueprintState = {
  schemaVersion: 2,
  project: "acme-saas",
  identity: "stub",
  bricks: [
    { id: "multi-workspace", config: {} },
    { id: "credit-wallet", config: { creditsPerUnit: 1, minOrderAmount: 1 } },
  ],
  entities: [],
  workflows: [
    {
      id: "wf_checkout",
      name: "Checkout Flow",
      nodes: [
        {
          id: "step_trigger",
          type: "core.manual",
          label: "Manual Trigger",
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
          id: "e_r2",
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

const HISTORICAL_R1_BLUEPRINT: BlueprintState = {
  ...CURRENT_R2_BLUEPRINT,
  workflows: [
    {
      id: "wf_checkout",
      name: "Checkout Flow",
      nodes: [
        {
          id: "step_trigger",
          type: "core.manual",
          label: "Manual Trigger",
          data: {},
        },
        {
          id: "step_removed_in_r2",
          type: "core.format_template",
          label: "Legacy Audit Step (r1 only)",
          data: { template: "Order={{steps.step_trigger.out.orderId}}" },
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
          target: "step_removed_in_r2",
          sourceHandle: "out",
          targetHandle: "in",
        },
        {
          id: "e2",
          source: "step_removed_in_r2",
          target: "step_debit",
          sourceHandle: "out",
          targetHandle: "in",
        },
      ],
    },
  ],
};

describe("Run History Drawer, Historical Revision Replay & Run Replay Inspector", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    useStudioStore.getState().resetStore({
      user: { id: "u_alice", email: "alice@example.com", name: "Alice" },
      orgs: [{ id: "org_default", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_default",
      activeProjectId: "acme-saas",
      currentRevision: 2,
      projectState: structuredClone(CURRENT_R2_BLUEPRINT),
      catalog: DEFAULT_CATALOG,
      activeNav: "workflows",
      activeWorkflowId: "wf_checkout",
      rightDockOpen: true,
      rightDockTab: "inspector",
    });
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("filters runs in the Run History drawer, enters Run Replay on historical r1 graph (rendering deleted node step_removed_in_r2), and inspects retries, 16 KB truncation notice, and errorStack in RightDock", async () => {
    const sampleRuns = [
      {
        runId: "run_r1_hist",
        workflowId: "wf_checkout",
        revision: 1,
        triggerType: "manual",
        workspaceId: "ws_acme",
        status: "failed" as const,
        durationMs: 145,
        retries: 2,
        errorStack: "Error: Wallet debit failed after 2 retries\n    at debitWallet (wallet.ts:88:9)",
        startedAt: "2026-10-30T10:15:00.000Z",
        endedAt: "2026-10-30T10:15:00.145Z",
        failedNodeId: "step_debit",
        stepCount: 3,
      },
      {
        runId: "run_r2_ok",
        workflowId: "wf_checkout",
        revision: 2,
        triggerType: "webhook",
        workspaceId: "ws_acme",
        status: "succeeded" as const,
        durationMs: 28,
        retries: 0,
        startedAt: "2026-10-30T11:00:00.000Z",
        endedAt: "2026-10-30T11:00:00.028Z",
        failedNodeId: null,
        stepCount: 2,
      },
    ];

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/runs/run_r1_hist")) {
        return new Response(
          JSON.stringify({
            project: "acme-saas",
            env: "preview",
            run: sampleRuns[0],
            currentRevision: 2,
            historicalRevision: 1,
            isHistoricalRevision: true,
            historicalState: HISTORICAL_R1_BLUEPRINT,
            historicalWorkflow: HISTORICAL_R1_BLUEPRINT.workflows[0],
            stepEvents: [
              {
                eventId: "ev_1",
                runId: "run_r1_hist",
                workflowId: "wf_checkout",
                revision: 1,
                nodeId: "step_trigger",
                status: "succeeded",
                durationMs: 5,
                retries: 0,
                inputPreview: '{"orderId":"ord_77"}',
                outputPreview: '{"out":{"orderId":"ord_77"}}',
                createdAt: "2026-10-30T10:15:00.005Z",
              },
              {
                eventId: "ev_2",
                runId: "run_r1_hist",
                workflowId: "wf_checkout",
                revision: 1,
                nodeId: "step_removed_in_r2",
                status: "succeeded",
                durationMs: 12,
                retries: 0,
                inputPreview: '{"orderId":"ord_77"}',
                outputPreview:
                  '{"__truncated":true,"originalBytes":24576,"preview":"Order=ord_77_large_payload"}',
                createdAt: "2026-10-30T10:15:00.017Z",
              },
              {
                eventId: "ev_3",
                runId: "run_r1_hist",
                workflowId: "wf_checkout",
                revision: 1,
                nodeId: "step_debit",
                status: "failed",
                durationMs: 128,
                retries: 2,
                inputPreview: '{"amount":40,"apiKey":"[REDACTED]"}',
                outputPreview: "{}",
                errorStack:
                  "Error: Wallet debit failed after 2 retries\n    at debitWallet (wallet.ts:88:9)",
                createdAt: "2026-10-30T10:15:00.145Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          project: "acme-saas",
          env: "preview",
          runs: sampleRuns,
          nextCursor: null,
          hasMore: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    render(
      <div>
        <WorkflowCanvasView />
        <RightDock />
      </div>,
    );

    // Initially at r2: `step_removed_in_r2` is NOT on the canvas
    expect(screen.queryByTestId("canvas-node-step_removed_in_r2")).toBeNull();

    // Open Run History drawer
    fireEvent.click(screen.getByTestId("toggle-run-history-drawer"));
    await waitFor(() => {
      expect(screen.getByTestId("run-history-drawer")).toBeTruthy();
      expect(screen.getByTestId("run-row-run_r1_hist")).toBeTruthy();
      expect(screen.getByTestId("run-row-run_r2_ok")).toBeTruthy();
    });

    // Filter by status = failed
    fireEvent.change(screen.getByTestId("runs-filter-status"), {
      target: { value: "failed" },
    });
    expect(screen.getByTestId("run-row-run_r1_hist")).toBeTruthy();
    expect(screen.queryByTestId("run-row-run_r2_ok")).toBeNull();

    // Click Replay on canvas for `run_r1_hist`
    fireEvent.click(screen.getByTestId("replay-run-button-run_r1_hist"));

    await waitFor(() => {
      expect(screen.getByTestId("run-replay-banner")).toBeTruthy();
      expect(screen.getByTestId("run-replay-historical-rev-badge")).toBeTruthy();
    });

    expect(screen.getByTestId("run-replay-banner").textContent).toContain(
      "Revision r1",
    );
    expect(
      screen.getByTestId("run-replay-historical-rev-badge").textContent,
    ).toContain("Historical graph at r1");

    // Historical node `step_removed_in_r2` is now rendered on the replay canvas!
    expect(screen.getByTestId("canvas-node-step_removed_in_r2")).toBeTruthy();
    expect(
      screen
        .getByTestId("node-telemetry-badge-step_removed_in_r2")
        .getAttribute("data-status"),
    ).toBe("succeeded");
    expect(
      screen
        .getByTestId("node-telemetry-badge-step_debit")
        .getAttribute("data-status"),
    ).toBe("failed");

    // Failed node `step_debit` is selected automatically -> Run Replay Inspector shows retries=2 and errorStack
    expect(screen.getByTestId("inspector-run-replay-panel")).toBeTruthy();
    expect(screen.getByTestId("replay-node-retries").textContent).toContain(
      "2 retries",
    );
    expect(screen.getByTestId("replay-node-duration").textContent).toContain(
      "128 ms",
    );
    expect(screen.getByTestId("replay-node-error-stack").textContent).toContain(
      "Wallet debit failed after 2 retries",
    );
    expect(
      screen.getByTestId("replay-node-input-preview").textContent,
    ).toContain("[REDACTED]");

    // Click `step_removed_in_r2` on the canvas -> Inspector shows 16 KB truncation notice badge
    fireEvent.click(screen.getByTestId("canvas-node-step_removed_in_r2"));
    await waitFor(() => {
      expect(screen.getByTestId("replay-preview-truncated-notice")).toBeTruthy();
    });
    expect(
      screen.getByTestId("replay-preview-truncated-notice").textContent,
    ).toContain("truncated at 16 KB");

    // Exit Replay -> restores current r2 graph without `step_removed_in_r2`
    fireEvent.click(screen.getByTestId("exit-run-replay-button"));
    await waitFor(() => {
      expect(screen.queryByTestId("run-replay-banner")).toBeNull();
      expect(screen.queryByTestId("canvas-node-step_removed_in_r2")).toBeNull();
    });
  });
});
