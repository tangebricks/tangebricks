import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { StudioApp } from "../src/App.tsx";
import { useStudioStore } from "../src/store.ts";
import { createEmptyBlueprintState } from "../src/types.ts";

describe("Story 2.7: Live WebSocket Sync Store Reconciliation, Follow AI, and Highlights", () => {
  beforeEach(() => {
    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "alice@example.com", name: "Alice" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      activeProjectId: "live-unit-proj",
      projectState: createEmptyBlueprintState("live-unit-proj"),
      followAi: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  test("reconciles incoming revision & catchup frames, highlights touched bricks/entities/nodes with author badges, updates aria-live announcer, and follows AI navigation (AC 1, AC 2)", () => {
    render(<StudioApp />);

    // Apply catchup revisions r1 (enable brick) and r2 (define entity)
    act(() => {
      useStudioStore.getState().applyIncomingCatchup([
        {
          revision: 1,
          parentRevision: 0,
          author: { type: "agent", id: "claude-1", client: "Claude Desktop" },
          summary: "Enable credit-wallet brick",
          ops: [
            {
              opId: "u-1",
              type: "enable_brick",
              brickId: "credit-wallet",
              config: { creditsPerUnit: 20 },
            },
          ],
        },
        {
          revision: 2,
          parentRevision: 1,
          author: { type: "agent", id: "claude-1", client: "Claude Desktop" },
          summary: "Define invoices entity",
          ops: [
            {
              opId: "u-2",
              type: "add_entity",
              entity: {
                name: "invoices",
                workspaceScoped: true,
                fields: [{ name: "title", type: "text", required: true, maxLength: 120 }],
              },
            },
          ],
        },
      ]);
    });

    expect(useStudioStore.getState().currentRevision).toBe(2);
    // Follow AI navigated to Data view for the latest entity mutation
    expect(useStudioStore.getState().activeNav).toBe("data");
    expect(screen.getByTestId("entity-list-item-invoices").getAttribute("data-highlighted")).toBe("true");
    expect(screen.getByTestId("entity-author-badge-invoices").textContent).toContain("agent:Claude Desktop");
    expect(screen.getByTestId("live-sync-announcer").textContent).toContain("agent:Claude Desktop made 1 change in revision r2");

    // Apply revision r3 adding a workflow node -> Follow AI switches to Workflows canvas and highlights the node
    act(() => {
      useStudioStore.getState().applyIncomingRevision({
        revision: 3,
        parentRevision: 2,
        author: { type: "agent", id: "claude-1", client: "Claude Desktop" },
        summary: "Add billing workflow with trigger",
        ops: [
          {
            opId: "u-3",
            type: "add_workflow",
            workflow: {
              id: "wf-unit",
              name: "Unit Billing Flow",
              nodes: [{ id: "node-t1", type: "trigger.manual", label: "Trigger", data: {} }],
              edges: [],
            },
          },
        ],
      });
    });

    expect(useStudioStore.getState().currentRevision).toBe(3);
    expect(useStudioStore.getState().activeNav).toBe("workflows");
    expect(screen.getByTestId("canvas-node-node-t1").getAttribute("data-highlighted")).toBe("true");
    expect(screen.getByTestId("node-author-badge-node-t1").textContent).toContain("agent:Claude Desktop");
  });
});
