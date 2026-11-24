import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RightDock } from "../src/components/RightDock.tsx";
import { useStudioStore } from "../src/store.ts";
import { DEFAULT_CATALOG } from "../src/types.ts";
import type { BlueprintState } from "../src/types.ts";

const TEST_BLUEPRINT: BlueprintState = {
  schemaVersion: 2,
  project: "acme-saas",
  identity: "stub",
  bricks: [
    { id: "multi-workspace", config: {} },
    { id: "credit-wallet", config: { creditsPerUnit: 10, minOrderAmount: 100 } },
    { id: "dynamic-entities", config: {} },
  ],
  entities: [
    {
      name: "orders",
      workspaceScoped: true,
      fields: [{ name: "total", type: "number", required: true }],
    },
  ],
  workflows: [
    {
      id: "wf_order_created",
      name: "Order Created Flow",
      nodes: [
        {
          id: "step_trigger",
          type: "dynamic-entities.record_created",
          label: "Order Created",
          data: { entity: "orders" },
        },
        {
          id: "step_debit",
          type: "credit-wallet.debit",
          label: "Debit Wallet",
          data: { amount: 10 },
        },
      ],
      edges: [
        {
          id: "edge_1",
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

describe("RightDock Inspector — I/O & Test Step tab", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    useStudioStore.getState().resetStore({
      user: { id: "u_alice", email: "alice@example.com", name: "Alice" },
      orgs: [{ id: "org_default", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_default",
      activeProjectId: "acme-saas",
      currentRevision: 3,
      projectState: structuredClone(TEST_BLUEPRINT),
      catalog: DEFAULT_CATALOG,
      rightDockOpen: true,
      rightDockTab: "inspector",
      activeWorkflowId: "wf_order_created",
      selection: {
        kind: "node",
        id: "step_debit",
        workflowId: "wf_order_created",
      },
    });
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("defaults JSON input to upstream node output or pinned data, runs Test step, toggles JSON and Table/Tree views, and shows duration + Succeeded status chip", async () => {
    // Seed upstream node's last output in store so step_debit defaults to it
    useStudioStore.getState().setStepTestResult("wf_order_created", "step_trigger", {
      ok: true,
      runId: "rehearsal:upstream-1",
      workflowId: "wf_order_created",
      revision: 3,
      nodeId: "step_trigger",
      nodeType: "dynamic-entities.record_created",
      status: "succeeded",
      durationMs: 4,
      inputPreview: "{}",
      outputPreview: '{"out":{"balance":200,"workspaceId":"ws_acme"}}',
      output: {
        out: {
          balance: 200,
          workspaceId: "ws_acme",
        },
      },
    });

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      expect(url).toContain(
        "/api/projects/acme-saas/workflows/wf_order_created/nodes/step_debit/test-step",
      );
      const reqBody = JSON.parse(String(init?.body ?? "{}")) as {
        input: { balance: number; workspaceId: string };
      };
      return new Response(
        JSON.stringify({
          ok: true,
          runId: "rehearsal:debit-1",
          workflowId: "wf_order_created",
          revision: 3,
          nodeId: "step_debit",
          nodeType: "credit-wallet.debit",
          status: "succeeded",
          durationMs: 11,
          inputPreview: JSON.stringify(reqBody.input),
          outputPreview: JSON.stringify({
            out: {
              operation: "debit",
              debited: 10,
              balanceAfter: reqBody.input.balance - 10,
              workspaceId: reqBody.input.workspaceId,
            },
          }),
          output: {
            out: {
              operation: "debit",
              debited: 10,
              balanceAfter: reqBody.input.balance - 10,
              workspaceId: reqBody.input.workspaceId,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    render(<RightDock />);

    // Switch to I/O & Test Step tab
    const ioTab = screen.getByTestId("inspector-node-tab-io");
    fireEvent.click(ioTab);

    expect(screen.getByTestId("inspector-test-step-panel")).toBeDefined();
    expect(screen.getByTestId("test-step-input-source-badge").textContent).toContain(
      "Last output from step_trigger",
    );

    const editor = screen.getByTestId("test-step-input-editor") as HTMLTextAreaElement;
    expect(JSON.parse(editor.value)).toEqual({
      balance: 200,
      workspaceId: "ws_acme",
    });

    // Edit input JSON to balance: 300
    fireEvent.change(editor, {
      target: { value: JSON.stringify({ balance: 300, workspaceId: "ws_custom" }, null, 2) },
    });

    // Click Test step button
    fireEvent.click(screen.getByTestId("run-test-step-button"));

    await waitFor(() => {
      expect(screen.getByTestId("test-step-status-badge").textContent).toContain(
        "✓ Succeeded",
      );
    });

    expect(screen.getByTestId("test-step-duration-badge").textContent).toContain(
      "11 ms",
    );

    const jsonOutput = screen.getByTestId("test-step-output-json");
    expect(JSON.parse(jsonOutput.textContent ?? "{}")).toEqual({
      out: {
        operation: "debit",
        debited: 10,
        balanceAfter: 290,
        workspaceId: "ws_custom",
      },
    });

    // Switch to Table / Tree view
    fireEvent.click(screen.getByTestId("test-step-view-mode-table"));
    const tableOutput = screen.getByTestId("test-step-output-table");
    expect(tableOutput.textContent).toContain("out.balanceAfter");
    expect(tableOutput.textContent).toContain("290");
    expect(tableOutput.textContent).toContain("ws_custom");
  });

  test("renders structured error details (what happened -> why -> what to do) on step failure and focuses offending field in Params tab", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          runId: "rehearsal:debit-fail-1",
          workflowId: "wf_order_created",
          revision: 3,
          nodeId: "step_debit",
          nodeType: "credit-wallet.debit",
          status: "failed",
          durationMs: 7,
          inputPreview: '{"balance":2}',
          outputPreview: "{}",
          output: {},
          error: {
            message: "credit-wallet.debit (step_debit): insufficient balance (2 < 10)",
            whatHappened: 'Step "step_debit" (credit-wallet.debit) failed during rehearsal.',
            why: "credit-wallet.debit (step_debit): insufficient balance (2 < 10)",
            whatToDo:
              'Increase the input "balance" value or lower the configured "amount" setting in the Params tab.',
            field: "amount",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    render(<RightDock />);
    fireEvent.click(screen.getByTestId("inspector-node-tab-io"));

    // Trigger via Ctrl+Enter keyboard shortcut on editor
    const editor = screen.getByTestId("test-step-input-editor");
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });

    await waitFor(() => {
      expect(screen.getByTestId("test-step-status-badge").textContent).toContain(
        "✕ Failed",
      );
    });

    const errCard = screen.getByTestId("test-step-error-card");
    expect(errCard).toBeDefined();
    expect(screen.getByTestId("test-step-error-what").textContent).toContain(
      'Step "step_debit" (credit-wallet.debit) failed during rehearsal.',
    );
    expect(screen.getByTestId("test-step-error-why").textContent).toContain(
      "insufficient balance (2 < 10)",
    );
    expect(screen.getByTestId("test-step-error-todo").textContent).toContain(
      'lower the configured "amount" setting in the Params tab',
    );

    // Click Focus field button to jump to Params tab and highlight "amount"
    fireEvent.click(screen.getByTestId("test-step-error-focus-field"));
    expect(useStudioStore.getState().highlightedInspectorField).toBe("amount");
    expect(
      screen.getByTestId("inspector-highlighted-field").getAttribute("data-field-key"),
    ).toBe("amount");
  });
});
