import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { HistoryAndLedgerView } from "../src/components/HistoryAndLedgerView.tsx";
import { RightDock } from "../src/components/RightDock.tsx";
import { useStudioStore } from "../src/store.ts";
import { PRESET_BLUEPRINTS } from "../src/types.ts";
import type { RevisionSummary } from "../src/types.ts";

const SAMPLE_REVISIONS: RevisionSummary[] = [
  {
    revision: 3,
    parentRevision: 2,
    author: {
      type: "agent",
      id: "agent:claude-code",
      client: "claude-code",
    },
    summary: "Extend workflow with transform node and update customers entity",
    semanticHash: "hash_r3",
    createdAt: "2026-10-28T12:10:00.000Z",
    ops: [
      {
        opId: "op-3a",
        type: "configure_brick",
        brickId: "credit-wallet",
        config: { creditsPerUnit: 25 },
      },
      {
        opId: "op-3b",
        type: "update_entity",
        entity: {
          name: "customers",
          fields: [
            { name: "email", type: "text", required: true, maxLength: 255 },
            { name: "tier", type: "enum", required: true, values: ["free", "pro"] },
          ],
        },
      },
      {
        opId: "op-3c",
        type: "add_node",
        workflowId: "wf-main",
        node: {
          id: "node-enrich",
          type: "transform.pick",
          label: "Enrich Customer",
          data: { path: "customer" },
        },
      },
    ],
  },
  {
    revision: 2,
    parentRevision: 1,
    author: {
      type: "agent",
      id: "agent:cursor",
      client: "cursor",
    },
    summary: "Add initial workflow wf-main and customers entity",
    semanticHash: "hash_r2",
    createdAt: "2026-10-28T12:05:00.000Z",
    ops: [
      {
        opId: "op-2a",
        type: "add_entity",
        entity: {
          name: "customers",
          fields: [
            { name: "email", type: "text", required: true, maxLength: 100 },
            { name: "legacy_flag", type: "boolean", required: false },
          ],
        },
      },
      {
        opId: "op-2b",
        type: "add_workflow",
        workflow: {
          id: "wf-main",
          name: "Customer Onboarding",
          nodes: [
            { id: "node-start", type: "trigger.manual", label: "Start", data: {} },
          ],
          edges: [],
        },
      },
    ],
  },
  {
    revision: 1,
    parentRevision: 0,
    author: {
      type: "human",
      id: "alice",
    },
    summary: "Enable multi-workspace, credit-wallet, and dynamic-entities bricks",
    semanticHash: "hash_r1",
    createdAt: "2026-10-28T12:00:00.000Z",
    ops: [
      { opId: "op-1a", type: "enable_brick", brickId: "multi-workspace" },
      {
        opId: "op-1b",
        type: "enable_brick",
        brickId: "credit-wallet",
        config: { creditsPerUnit: 10 },
      },
      { opId: "op-1c", type: "enable_brick", brickId: "dynamic-entities" },
    ],
  },
];

describe("Story 2.6: Revision History, Semantic Diff Viewer, and AI Change Ledger Drawer", () => {
  beforeEach(() => {
    useStudioStore.getState().resetStore({
      user: { id: "usr_alice", email: "alice@example.com", name: "Alice" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme Org", role: "owner" }],
      activeOrgId: "org_1",
      activeProjectId: "ai-credits-saas",
      projectState: PRESET_BLUEPRINTS["ai-credits-saas"]!,
      revisions: SAMPLE_REVISIONS,
      rightDockOpen: true,
      rightDockTab: "ledger",
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("1. filters revisions by All, Humans, AI Agents, and specific agent:<client> (human vs agent:claude-code) (AC 1, AC 4)", () => {
    render(<HistoryAndLedgerView />);

    // Initially All 3 revisions are visible
    expect(screen.getByTestId("ledger-entry-3")).toBeTruthy();
    expect(screen.getByTestId("ledger-entry-2")).toBeTruthy();
    expect(screen.getByTestId("ledger-entry-1")).toBeTruthy();

    // Check revision badges & author badges
    expect(screen.getByTestId("ledger-rev-badge-3").textContent).toBe("r3");
    expect(screen.getByTestId("ledger-author-badge-3").textContent).toContain(
      "agent:claude-code",
    );
    expect(screen.getByTestId("ledger-author-badge-1").textContent).toContain(
      "human:alice",
    );

    // Filter by Humans only
    fireEvent.click(screen.getByTestId("ledger-filter-humans"));
    expect(screen.getByTestId("ledger-entry-1")).toBeTruthy();
    expect(screen.queryByTestId("ledger-entry-3")).toBeNull();
    expect(screen.queryByTestId("ledger-entry-2")).toBeNull();

    // Filter by AI Agents
    fireEvent.click(screen.getByTestId("ledger-filter-agents"));
    expect(screen.getByTestId("ledger-entry-3")).toBeTruthy();
    expect(screen.getByTestId("ledger-entry-2")).toBeTruthy();
    expect(screen.queryByTestId("ledger-entry-1")).toBeNull();

    // Filter by distinct agent pill: agent:claude-code
    fireEvent.click(screen.getByTestId("ledger-filter-agent:claude-code"));
    expect(screen.getByTestId("ledger-entry-3")).toBeTruthy();
    expect(screen.queryByTestId("ledger-entry-2")).toBeNull();
    expect(screen.queryByTestId("ledger-entry-1")).toBeNull();

    // Reset to All
    fireEvent.click(screen.getByTestId("ledger-filter-all"));
    expect(screen.getByTestId("ledger-entry-3")).toBeTruthy();
    expect(screen.getByTestId("ledger-entry-2")).toBeTruthy();
    expect(screen.getByTestId("ledger-entry-1")).toBeTruthy();
  });

  test("2. clicking affected brick, entity, or workflow node chips navigates to the target view and focuses the object in the Inspector (AC 2, AC 4)", () => {
    const onFocusObject = vi.fn();
    render(<HistoryAndLedgerView onFocusObject={onFocusObject} />);

    // Click affected brick chip "credit-wallet" in revision 3
    const brickChips = screen.getAllByTestId("ledger-target-brick-credit-wallet");
    fireEvent.click(brickChips[0]!);
    expect(useStudioStore.getState().activeNav).toBe("bricks");
    expect(useStudioStore.getState().selection).toEqual({
      kind: "brick",
      id: "credit-wallet",
    });
    expect(onFocusObject).toHaveBeenCalledWith(
      { kind: "brick", id: "credit-wallet" },
      "bricks",
    );

    // Click affected entity chip "customers"
    const entityChips = screen.getAllByTestId("ledger-target-entity-customers");
    fireEvent.click(entityChips[0]!);
    expect(useStudioStore.getState().activeNav).toBe("data");
    expect(useStudioStore.getState().selection).toEqual({
      kind: "entity",
      id: "customers",
    });
    expect(onFocusObject).toHaveBeenCalledWith(
      { kind: "entity", id: "customers" },
      "data",
    );

    // Click affected workflow node chip "node-enrich"
    fireEvent.click(screen.getByTestId("ledger-target-node-node-enrich"));
    expect(useStudioStore.getState().activeNav).toBe("workflows");
    expect(useStudioStore.getState().activeWorkflowId).toBe("wf-main");
    expect(useStudioStore.getState().workflowNodeSearch).toBe("node-enrich");
    expect(useStudioStore.getState().selection).toEqual({
      kind: "node",
      id: "node-enrich",
      workflowId: "wf-main",
    });
    expect(onFocusObject).toHaveBeenCalledWith(
      { kind: "node", id: "node-enrich", workflowId: "wf-main" },
      "workflows",
    );
  });

  test("3. renders Semantic Diff Viewer on 'View diff' or arbitrary revision pair comparison, showing added/removed/updated bricks, entities, and workflow nodes (AC 3, AC 4)", async () => {
    render(
      <div>
        <HistoryAndLedgerView />
        <RightDock />
      </div>,
    );

    // Click "View diff" on revision 3 (compares r2 -> r3)
    const viewDiffButtons = screen.getAllByTestId("view-diff-rev-3");
    fireEvent.click(viewDiffButtons[0]!);

    await waitFor(() => {
      expect(screen.getByTestId("semantic-diff-viewer")).toBeTruthy();
    });

    expect(screen.getByTestId("semantic-diff-range").textContent).toBe("r2 → r3");
    // Updated brick credit-wallet (10 -> 25)
    expect(screen.getByTestId("diff-brick-updated-credit-wallet").textContent).toContain(
      "creditsPerUnit",
    );
    // Updated entity customers (+ tier, - legacy_flag, ~ email)
    const entityDiff = screen.getByTestId("diff-entity-updated-customers");
    expect(entityDiff.textContent).toContain("+ Field tier");
    expect(entityDiff.textContent).toContain("- Field legacy_flag");
    expect(entityDiff.textContent).toContain("~ Field email");
    // Updated workflow wf-main (+ Node node-enrich)
    expect(screen.getByTestId("diff-node-added-node-enrich").textContent).toContain(
      "Enrich Customer",
    );

    // Compare r0 -> r2 using the History revision selector
    fireEvent.change(screen.getByTestId("diff-from-select"), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByTestId("diff-to-select"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByTestId("diff-compare-button"));

    await waitFor(() => {
      expect(screen.getByTestId("semantic-diff-range").textContent).toBe("r0 → r2");
    });

    expect(screen.getByTestId("diff-brick-added-multi-workspace")).toBeTruthy();
    expect(screen.getByTestId("diff-brick-added-credit-wallet")).toBeTruthy();
    expect(screen.getByTestId("diff-entity-added-customers")).toBeTruthy();
    expect(screen.getByTestId("diff-workflow-added-wf-main")).toBeTruthy();
  });
});
