import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StudioApp } from "../src/App.tsx";
import { computeDeterministicDagLayout, createSynthetic200NodeBlueprint } from "../src/components/WorkflowCanvasView.tsx";
import { useStudioStore } from "../src/store.ts";
import type { BlueprintState } from "../src/types.ts";

const multiWorkflowBlueprint: BlueprintState = {
  schemaVersion: 2,
  project: "workflow-canvas-demo",
  identity: "core-auth",
  bricks: [
    { id: "core-auth", config: {} },
    { id: "multi-workspace", config: {} },
    { id: "credit-wallet", config: {} },
    { id: "in-app-notifications", config: {} },
  ],
  entities: [],
  workflows: [
    {
      id: "wf-billing",
      name: "Billing Credit Topup",
      trigger: { kind: "webhook", path: "/webhooks/stripe" },
      nodes: [
        { id: "n-start", type: "trigger.manual", label: "Webhook Received", data: { source: "stripe" } },
        { id: "n-transform", type: "transform.pick", label: "Extract Amount", data: { path: "amount" } },
        {
          id: "n-credit",
          type: "credit-wallet.credit",
          label: "Add Wallet Credits",
          data: { currency: "USD", lastAuthor: "agent:claude-desktop" },
        },
      ],
      edges: [
        { id: "e1", source: "n-start", target: "n-transform", sourceHandle: "out", targetHandle: "in" },
        { id: "e2", source: "n-transform", target: "n-credit", sourceHandle: "out", targetHandle: "in" },
      ],
    },
    {
      id: "wf-digest",
      name: "Nightly Digest Schedule",
      trigger: { kind: "schedule", cron: "0 2 * * *" },
      nodes: [
        { id: "n-cron", type: "trigger.manual", label: "2AM Cron Trigger", data: {} },
        { id: "n-send", type: "in-app-notifications.send", label: "Send Digest", data: {} },
      ],
      edges: [{ id: "e-digest-1", source: "n-cron", target: "n-send" }],
    },
  ],
  secretRefs: [],
};

describe("Story 2.5: Read-only @xyflow/react Workflow Canvas", () => {
  beforeEach(() => {
    useStudioStore.getState().resetStore();
  });

  afterEach(() => {
    cleanup();
  });

  it("1. computes deterministic layered DAG auto-layout when metadata.layout is missing without mutating the blueprint (AC 2)", () => {
    const wf = multiWorkflowBlueprint.workflows[0]!;
    const layoutA = computeDeterministicDagLayout(wf.nodes, wf.edges);
    const layoutB = computeDeterministicDagLayout(wf.nodes, wf.edges);

    expect(layoutA).toEqual(layoutB);
    expect(layoutA["n-start"]!.x).toBeLessThan(layoutA["n-transform"]!.x);
    expect(layoutA["n-transform"]!.x).toBeLessThan(layoutA["n-credit"]!.x);
    expect(multiWorkflowBlueprint.metadata).toBeUndefined();

    const synthetic200 = createSynthetic200NodeBlueprint();
    expect(synthetic200.workflows[0]!.nodes).toHaveLength(200);
    expect(synthetic200.workflows[0]!.edges).toHaveLength(240);
  });

  it("2. renders workflow selector, custom node cards with role icons, typed port handles, author chips, and switches workflows (AC 1, AC 2)", () => {
    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "asha@example.com", name: "Asha" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      projectState: multiWorkflowBlueprint,
      activeNav: "workflows",
    });

    render(<StudioApp />);

    expect(screen.getByTestId("workflow-selector")).toBeDefined();
    expect(screen.getByTestId("workflow-selector-card-wf-billing")).toBeDefined();
    expect(screen.getByTestId("workflow-selector-card-wf-digest")).toBeDefined();

    // Custom nodes in wf-billing render with typed ports and author badge
    expect(screen.getByTestId("canvas-node-n-start")).toBeDefined();
    expect(screen.getByTestId("canvas-node-n-transform")).toBeDefined();
    expect(screen.getByTestId("canvas-node-n-credit")).toBeDefined();
    expect(screen.getByTestId("node-port-in-n-credit").textContent).toContain("col:record");
    expect(screen.getByTestId("node-port-out-n-credit").textContent).toContain("res:record");
    expect(screen.getByTestId("node-author-badge-n-credit").textContent).toContain("agent:claude-desktop");

    // Switch to wf-digest via selector card
    fireEvent.click(screen.getByTestId("workflow-selector-card-wf-digest"));
    expect(screen.getByTestId("canvas-node-n-cron")).toBeDefined();
    expect(screen.getByTestId("canvas-node-n-send")).toBeDefined();
  });

  it("3. opens the Right Dock Node Inspector on node click or Enter key and toggles Accessible Outline View (AC 3)", () => {
    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "asha@example.com", name: "Asha" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      projectState: multiWorkflowBlueprint,
      activeNav: "workflows",
    });

    render(<StudioApp />);

    // Press Enter on focused node n-transform -> opens Node Inspector with incoming & outgoing edges
    const transformNode = screen.getByTestId("canvas-node-n-transform");
    fireEvent.keyDown(transformNode, { key: "Enter" });

    expect(screen.getByTestId("inspector-node-detail")).toBeDefined();
    expect(screen.getByTestId("inspector-node-id").textContent).toBe("n-transform");
    expect(screen.getByTestId("inspector-node-type").textContent).toBe("transform.pick");
    expect(screen.getByTestId("inspector-node-incoming").textContent).toContain("n-start.out → in");
    expect(screen.getByTestId("inspector-node-outgoing").textContent).toContain("out → n-credit.in");

    // Toggle Accessible Outline View
    fireEvent.click(screen.getByTestId("workflow-outline-toggle"));
    const outline = screen.getByRole("region", { name: "Workflow Outline" });
    expect(outline).toBeDefined();
    expect(screen.getByTestId("workflow-outline-step-n-transform").textContent).toContain("Upstream: n-start · Downstream: n-credit");
  });
});
