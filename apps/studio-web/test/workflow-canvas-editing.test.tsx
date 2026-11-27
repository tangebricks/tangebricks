import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioApp } from "../src/App.tsx";
import { useStudioStore } from "../src/store.ts";
import { applyStudioOps, semanticHash } from "../src/types.ts";
import type { BlueprintState } from "../src/types.ts";

const emptyWorkflowBlueprint: BlueprintState = {
  schemaVersion: 2,
  project: "wf-editing-demo",
  identity: "core-auth",
  bricks: [
    { id: "core-auth", config: { sessionDuration: 7200 } },
    { id: "multi-workspace", config: {} },
    { id: "in-app-notifications", config: {} },
  ],
  entities: [],
  workflows: [],
  secretRefs: [],
};

function installBackendFetchHandler() {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/ops") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        baseRevision: number;
        ops: Array<Record<string, unknown>>;
        summary?: string;
      };
      const currentState = useStudioStore.getState().projectState!;
      const nextState = applyStudioOps(currentState, body.ops);
      const nextRev = (body.baseRevision ?? 0) + 1;
      const hash = semanticHash(nextState);
      return new Response(
        JSON.stringify({
          revision: nextRev,
          semanticHash: hash,
          state: nextState,
          author: { type: "human", id: "usr_1" },
          summary: body.summary ?? `Revision r${nextRev}`,
          createdAt: new Date().toISOString(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: "unexpected request" }), { status: 404 });
  });
  return fetchSpy;
}

describe("Editable Workflow Canvas, Searchable Node Palette, and Typed Port Validation", () => {
  beforeEach(() => {
    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "alice@example.com", name: "Alice" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      activeProjectId: "wf-editing-demo",
      projectState: structuredClone(emptyWorkflowBlueprint),
      activeNav: "workflows",
      currentRevision: 1,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("1. creates a workflow via add_workflow, searches the palette, enforces max 1 trigger per workflow, and prompts to enable disabled bricks from the palette", async () => {
    installBackendFetchHandler();
    render(<StudioApp />);

    // Create a new workflow
    fireEvent.click(screen.getByTestId("new-workflow-button"));
    const wfNameInput = screen.getByTestId("new-workflow-name-input");
    fireEvent.change(wfNameInput, { target: { value: "Invoice Alert Flow" } });
    fireEvent.click(screen.getByTestId("create-workflow-confirm"));

    await waitFor(() => {
      expect(useStudioStore.getState().projectState?.workflows).toHaveLength(1);
    });
    expect(useStudioStore.getState().projectState?.workflows[0]?.id).toBe("wf-invoice-alert-flow");

    // Search palette for "webhook" and add core.webhook trigger node
    const paletteSearch = screen.getByTestId("palette-search-input");
    fireEvent.change(paletteSearch, { target: { value: "webhook" } });
    fireEvent.click(screen.getByTestId("palette-add-node-core.webhook"));

    await waitFor(() => {
      expect(useStudioStore.getState().projectState?.workflows[0]?.nodes).toHaveLength(1);
    });

    // Verify trigger limit warning appears and second trigger is blocked
    expect(screen.getByTestId("palette-trigger-limit-warning")).toBeDefined();
    expect((screen.getByTestId("palette-add-node-core.webhook") as HTMLButtonElement).disabled).toBe(true);

    // Clear search and click a disabled brick action (credit-wallet.debit) -> opens Turn on Brick modal
    fireEvent.change(paletteSearch, { target: { value: "" } });
    fireEvent.click(screen.getByTestId("palette-disabled-brick-node-credit-wallet.debit"));

    expect(screen.getByTestId("palette-enable-brick-modal")).toBeDefined();
    fireEvent.click(screen.getByTestId("palette-confirm-enable-brick"));

    await waitFor(() => {
      const state = useStudioStore.getState().projectState!;
      expect(state.bricks.some((b) => b.id === "credit-wallet")).toBe(true);
      expect(state.workflows[0]?.nodes).toHaveLength(2);
    });
  });

  it("2. blocks incompatible port connections with reason banner ('Cannot connect number output to array input') and connects valid ports via connect_edges", async () => {
    installBackendFetchHandler();
    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "alice@example.com", name: "Alice" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      activeProjectId: "wf-editing-demo",
      projectState: {
        ...emptyWorkflowBlueprint,
        workflows: [
          {
            id: "wf-ports",
            name: "Port Validation Flow",
            trigger: { kind: "manual" },
            nodes: [
              {
                id: "node-webhook-1",
                type: "core.webhook",
                label: "Inbound Webhook",
                data: { method: "post" },
              },
              {
                id: "node-math-2",
                type: "core.math",
                label: "Math Expression",
                data: { operation: "add" },
              },
              {
                id: "node-loop-3",
                type: "core.loop",
                label: "Loop Over Items",
                data: { maxIterations: 100 },
              },
              {
                id: "node-field-map-4",
                type: "core.field_map",
                label: "Field Map",
                data: { includeUnmapped: false },
              },
            ],
            edges: [],
          },
        ],
      },
      activeNav: "workflows",
      currentRevision: 1,
    });

    render(<StudioApp />);

    // Attempt to connect core.math (out:number) -> core.loop (in:array)
    const srcSelect = screen.getByTestId("wire-source-select");
    const dstSelect = screen.getByTestId("wire-target-select");

    fireEvent.change(srcSelect, { target: { value: "node-math-2::out" } });
    fireEvent.change(dstSelect, { target: { value: "node-loop-3::in" } });

    const errorBanner = screen.getByTestId("port-validation-error-banner");
    expect(errorBanner.textContent).toContain("Cannot connect number output to array input");
    expect((screen.getByTestId("wire-connect-button") as HTMLButtonElement).disabled).toBe(true);

    // Now select a valid typed connection: core.webhook (out:object) -> core.field_map (in:object)
    fireEvent.change(srcSelect, { target: { value: "node-webhook-1::out" } });
    fireEvent.change(dstSelect, { target: { value: "node-field-map-4::in" } });

    expect(screen.queryByTestId("port-validation-error-banner")).toBeNull();
    const connectBtn = screen.getByTestId("wire-connect-button") as HTMLButtonElement;
    expect(connectBtn.disabled).toBe(false);

    fireEvent.click(connectBtn);
    await waitFor(() => {
      expect(useStudioStore.getState().projectState?.workflows[0]?.edges).toHaveLength(1);
    });
  });

  it("3. supports copy/paste with offset coordinates, delete with one-click Undo toast, and auto-layout preserving semanticHash", async () => {
    installBackendFetchHandler();
    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "alice@example.com", name: "Alice" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      activeProjectId: "wf-editing-demo",
      projectState: {
        ...emptyWorkflowBlueprint,
        workflows: [
          {
            id: "wf-ops",
            name: "Canvas Ops Flow",
            trigger: { kind: "manual" },
            nodes: [
              {
                id: "node-webhook-1",
                type: "core.webhook",
                label: "Webhook Trigger",
                data: { method: "post" },
              },
              {
                id: "node-math-2",
                type: "core.math",
                label: "Calculate Total",
                data: { operation: "add" },
              },
            ],
            edges: [
              {
                id: "e-1",
                source: "node-webhook-1",
                target: "node-math-2",
                sourceHandle: "out",
                targetHandle: "in",
              },
            ],
          },
        ],
      },
      activeNav: "workflows",
      currentRevision: 1,
    });

    render(<StudioApp />);

    // Select node-math-2, Copy, and Paste
    const mathNode = await screen.findByTestId("canvas-node-node-math-2");
    fireEvent.click(mathNode);
    const copyBtn = await screen.findByTestId("canvas-copy-button");
    fireEvent.click(copyBtn);
    const pasteBtn = await screen.findByTestId("canvas-paste-button");
    fireEvent.click(pasteBtn);

    await waitFor(() => {
      expect(useStudioStore.getState().projectState?.workflows[0]?.nodes).toHaveLength(3);
    });
    const pastedNode = useStudioStore.getState().projectState!.workflows[0]!.nodes.find((n) => n.id.startsWith("node-math-2-copy-"));
    expect(pastedNode).toBeDefined();

    // Delete the pasted node -> Undo toast appears -> Click Undo -> Node restored
    const deleteBtn = await screen.findByTestId("delete-selected-button");
    fireEvent.click(deleteBtn);
    await waitFor(() => {
      expect(useStudioStore.getState().projectState?.workflows[0]?.nodes).toHaveLength(2);
    });

    const undoToastButton = await screen.findByTestId("canvas-undo-toast-button");
    fireEvent.click(undoToastButton);

    await waitFor(() => {
      expect(useStudioStore.getState().projectState?.workflows[0]?.nodes).toHaveLength(3);
    });

    // Auto-Layout updates metadata.layout without changing semanticHash
    const hashBeforeAutoLayout = semanticHash(useStudioStore.getState().projectState!);
    fireEvent.click(screen.getByTestId("workflow-autolayout-button"));
    await waitFor(() => {
      expect(useStudioStore.getState().projectState?.metadata?.layout?.["node-webhook-1"]).toBeDefined();
    });
    const hashAfterAutoLayout = semanticHash(useStudioStore.getState().projectState!);
    expect(hashAfterAutoLayout).toBe(hashBeforeAutoLayout);
  });
});
