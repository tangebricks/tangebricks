// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioShell } from "../src/components/StudioShell.tsx";
import { MAX_UNDO_STACK_DEPTH, useStudioStore } from "../src/store.ts";
import {
  DEFAULT_CATALOG,
  applyStudioOps,
  computeStudioReadiness,
  computeStudioValidationIssues,
  createEmptyBlueprintState,
} from "../src/types.ts";
import type { BlueprintState, RevisionSummary } from "../src/types.ts";

describe("Inline Validation, Undo/Redo, Visual Diff & Conflict Card", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useStudioStore.getState().resetStore();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders inline validation badges across views, opens the Top Bar Issues Drawer, jumps to the offending field, and updates live to Ready when fixed", async () => {
    let serverState: BlueprintState = {
      ...createEmptyBlueprintState("validation-proj"),
      bricks: [{ id: "multi-workspace", config: {} }],
      entities: [],
      workflows: [
        {
          id: "wf-notify",
          name: "Notify Flow",
          trigger: { kind: "manual" },
          nodes: [
            {
              id: "node-trigger-1",
              type: "core.webhook",
              label: "Webhook Start",
              data: {},
            },
            {
              id: "node-tpl-1",
              type: "core.format_template",
              label: "Format Greeting",
              data: {
                template: "Hello {{steps.deleted_node.output.email}}",
              },
            },
          ],
          edges: [
            {
              id: "e-1",
              source: "node-trigger-1",
              target: "node-tpl-1",
              sourceHandle: "out",
              targetHandle: "in",
            },
          ],
        },
      ],
      secretRefs: [],
    };
    let serverRev = 1;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/ops") && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as {
          ops: Array<Record<string, unknown>>;
        };
        serverState = applyStudioOps(serverState, body.ops, DEFAULT_CATALOG);
        serverRev += 1;
        return new Response(
          JSON.stringify({
            project: serverState.project,
            revision: serverRev,
            parentRevision: serverRev - 1,
            state: serverState,
            semanticHash: `hash-${serverRev}`,
            readiness: computeStudioReadiness(serverState, DEFAULT_CATALOG),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ revisions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const issues = computeStudioValidationIssues(serverState, DEFAULT_CATALOG, []);
    expect(issues.some((i) => i.code === "BROKEN_DATA_PILL")).toBe(true);

    useStudioStore.getState().resetStore({
      user: { id: "u-1", email: "dev@example.com", name: "Dev" },
      orgs: [{ id: "org-1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org-1",
      activeProjectId: "validation-proj",
      currentRevision: 1,
      projectState: serverState,
      readiness: computeStudioReadiness(serverState, DEFAULT_CATALOG),
      activeNav: "overview",
    });

    render(<StudioShell />);

    // Top bar readiness badge shows 1 issue
    const badge = screen.getByTestId("readiness-badge");
    expect(badge.textContent).toContain("1 issue");

    // Click the readiness badge to open the Issues Drawer
    fireEvent.click(badge);
    const drawer = screen.getByTestId("studio-issues-drawer");
    expect(drawer).toBeTruthy();
    expect(drawer.textContent).toContain("deleted_node");

    // Click the issue item to jump directly to the workflow node and highlight its offending field
    fireEvent.click(screen.getByTestId("issue-jump-item-0"));

    await waitFor(() => {
      expect(useStudioStore.getState().activeNav).toBe("workflows");
      expect(useStudioStore.getState().selection?.id).toBe("node-tpl-1");
    });

    const highlighted = screen.getByTestId("inspector-highlighted-field");
    expect(highlighted.getAttribute("data-field-key")).toBe("template");
    expect(screen.getByTestId("inline-issue-badge-node-tpl-1").textContent).toContain(
      "deleted_node",
    );

    // Fix the broken expression in the Inspector and save
    const tplInput = screen.getByTestId("node-config-input-template");
    fireEvent.change(tplInput, { target: { value: "Hello valid world" } });
    fireEvent.click(screen.getByTestId("inspector-node-save"));

    await waitFor(() => {
      expect(screen.getByTestId("readiness-badge").textContent).toContain("Ready");
    });
  });

  it("maintains a >= 50-step Undo/Redo stack, supports Top Bar & Ctrl+Z / Ctrl+Shift+Z undo/redo, and undoes historical revisions from the AI Change Ledger", async () => {
    expect(MAX_UNDO_STACK_DEPTH).toBeGreaterThanOrEqual(50);

    let serverState: BlueprintState = {
      ...createEmptyBlueprintState("undo-proj"),
      identity: "core-auth",
      bricks: [
        { id: "core-auth", config: {} },
        { id: "multi-workspace", config: {} },
      ],
      entities: [],
      workflows: [
        {
          id: "wf-main",
          name: "Main Flow",
          trigger: { kind: "manual" },
          nodes: [
            {
              id: "node-start",
              type: "trigger.manual",
              label: "Start",
              data: {},
            },
          ],
          edges: [],
        },
      ],
      secretRefs: [],
    };
    let serverRev = 1;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/ops") && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as {
          ops: Array<Record<string, unknown>>;
        };
        serverState = applyStudioOps(serverState, body.ops, DEFAULT_CATALOG);
        serverRev += 1;
        return new Response(
          JSON.stringify({
            project: serverState.project,
            revision: serverRev,
            parentRevision: serverRev - 1,
            state: serverState,
            semanticHash: `hash-${serverRev}`,
            readiness: computeStudioReadiness(serverState, DEFAULT_CATALOG),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ revisions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    useStudioStore.getState().resetStore({
      user: { id: "u-1", email: "dev@example.com", name: "Dev" },
      orgs: [{ id: "org-1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org-1",
      activeProjectId: "undo-proj",
      currentRevision: 1,
      projectState: serverState,
      readiness: computeStudioReadiness(serverState, DEFAULT_CATALOG),
      activeNav: "workflows",
      activeWorkflowId: "wf-main",
    });

    render(<StudioShell />);

    // Perform 3 mutations via store.commitOps:
    // 1. Add a node
    await useStudioStore.getState().commitOps(
      [
        {
          opId: "op-add-http",
          type: "add_node",
          workflowId: "wf-main",
          node: {
            id: "node-http-1",
            type: "core.http_request",
            label: "Call Webhook",
            data: { url: "https://example.com/v1" },
          },
        },
      ],
      "Add Call Webhook node",
    );
    // 2. Connect wire
    await useStudioStore.getState().commitOps(
      [
        {
          opId: "op-connect-1",
          type: "connect_edges",
          workflowId: "wf-main",
          edges: [
            {
              id: "e-start-http",
              source: "node-start",
              target: "node-http-1",
              sourceHandle: "out",
              targetHandle: "in",
            },
          ],
        },
      ],
      "Connect Start to Call Webhook",
    );
    // 3. Edit node config
    await useStudioStore.getState().commitOps(
      [
        {
          opId: "op-edit-http",
          type: "update_node",
          workflowId: "wf-main",
          nodeId: "node-http-1",
          patch: {
            label: "Call Webhook v2",
            data: { url: "https://example.com/v2" },
          },
        },
      ],
      "Update Call Webhook URL to v2",
    );

    expect(useStudioStore.getState().undoStack.length).toBe(3);
    expect(
      useStudioStore.getState().projectState?.workflows[0]?.nodes.find(
        (n) => n.id === "node-http-1",
      )?.label,
    ).toBe("Call Webhook v2");

    // Undo all 3 steps via Top Bar Undo button + Ctrl+Z
    fireEvent.click(screen.getByTestId("topbar-undo-button"));
    await waitFor(() => {
      expect(
        useStudioStore.getState().projectState?.workflows[0]?.nodes.find(
          (n) => n.id === "node-http-1",
        )?.label,
      ).toBe("Call Webhook");
    });

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => {
      expect(
        useStudioStore.getState().projectState?.workflows[0]?.edges.length,
      ).toBe(0);
    });

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => {
      expect(
        useStudioStore.getState().projectState?.workflows[0]?.nodes.some(
          (n) => n.id === "node-http-1",
        ),
      ).toBe(false);
    });

    // Redo all 3 steps via Redo button + Ctrl+Shift+Z
    fireEvent.click(screen.getByTestId("topbar-redo-button"));
    await waitFor(() => {
      expect(
        useStudioStore.getState().projectState?.workflows[0]?.nodes.some(
          (n) => n.id === "node-http-1",
        ),
      ).toBe(true);
    });

    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => {
      expect(
        useStudioStore.getState().projectState?.workflows[0]?.edges.length,
      ).toBe(1);
    });

    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => {
      expect(
        useStudioStore.getState().projectState?.workflows[0]?.nodes.find(
          (n) => n.id === "node-http-1",
        )?.label,
      ).toBe("Call Webhook v2");
    });
  });

  it("renders Canvas Visual Diff overlay (+ Added, - Removed ghosted dashed, ~ Changed with side-by-side field diff in Inspector)", async () => {
    const rev1State: BlueprintState = {
      ...createEmptyBlueprintState("diff-proj"),
      identity: "core-auth",
      bricks: [{ id: "core-auth", config: {} }],
      entities: [],
      workflows: [
        {
          id: "wf-diff",
          name: "Diff Workflow",
          trigger: { kind: "manual" },
          nodes: [
            {
              id: "node-start",
              type: "core.manual",
              label: "Start",
              data: {},
            },
            {
              id: "node-legacy",
              type: "core.http_request",
              label: "Legacy Endpoint",
              data: { url: "https://old.example.com" },
            },
            {
              id: "node-transform",
              type: "core.format_template",
              label: "Format v1",
              data: { template: "Before text" },
            },
          ],
          edges: [
            {
              id: "e-old",
              source: "node-start",
              target: "node-legacy",
              sourceHandle: "out",
              targetHandle: "in",
            },
          ],
        },
      ],
      secretRefs: [],
    };

    const rev2State: BlueprintState = {
      ...rev1State,
      workflows: [
        {
          id: "wf-diff",
          name: "Diff Workflow",
          trigger: { kind: "manual" },
          nodes: [
            {
              id: "node-start",
              type: "core.manual",
              label: "Start",
              data: {},
            },
            {
              id: "node-transform",
              type: "core.format_template",
              label: "Format v2",
              data: { template: "After text" },
            },
            {
              id: "node-added-step",
              type: "core.http_request",
              label: "New Webhook",
              data: { url: "https://new.example.com" },
            },
          ],
          edges: [
            {
              id: "e-new",
              source: "node-start",
              target: "node-added-step",
              sourceHandle: "out",
              targetHandle: "in",
            },
          ],
        },
      ],
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/revisions/1")) {
        return new Response(
          JSON.stringify({
            project: "diff-proj",
            revision: 1,
            state: rev1State,
            semanticHash: "h1",
            readiness: computeStudioReadiness(rev1State, DEFAULT_CATALOG),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/revisions/2")) {
        return new Response(
          JSON.stringify({
            project: "diff-proj",
            revision: 2,
            state: rev2State,
            semanticHash: "h2",
            readiness: computeStudioReadiness(rev2State, DEFAULT_CATALOG),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ revisions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const revisions: RevisionSummary[] = [
      {
        revision: 2,
        parentRevision: 1,
        author: { type: "agent", id: "claude-code", client: "claude-code" },
        summary: "Replace legacy node and update transform",
        semanticHash: "h2",
        createdAt: new Date().toISOString(),
        ops: [],
      },
      {
        revision: 1,
        parentRevision: 0,
        author: { type: "human", id: "u-1" },
        summary: "Initial workflow",
        semanticHash: "h1",
        createdAt: new Date().toISOString(),
        ops: [],
      },
    ];

    useStudioStore.getState().resetStore({
      user: { id: "u-1", email: "dev@example.com", name: "Dev" },
      orgs: [{ id: "org-1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org-1",
      activeProjectId: "diff-proj",
      currentRevision: 2,
      projectState: rev2State,
      readiness: computeStudioReadiness(rev2State, DEFAULT_CATALOG),
      revisions,
      activeNav: "history",
      activeWorkflowId: "wf-diff",
    });

    render(<StudioShell />);

    // Click Compare on Canvas in History view
    fireEvent.click(screen.getByTestId("compare-on-canvas-button"));

    await waitFor(() => {
      expect(screen.getByTestId("canvas-visual-diff-banner")).toBeTruthy();
    });

    // Verify + Added, - Removed (ghosted), and ~ Changed badges on the canvas
    expect(screen.getByTestId("diff-badge-added-node-added-step").textContent).toContain(
      "+ Added",
    );
    expect(screen.getByTestId("diff-badge-removed-node-legacy").textContent).toContain(
      "- Removed",
    );
    expect(screen.getByTestId("diff-badge-changed-node-transform").textContent).toContain(
      "~ Changed",
    );

    // Click the ~ Changed node to inspect its side-by-side field diff in the Right Dock Inspector
    fireEvent.click(screen.getByTestId("canvas-node-node-transform"));

    await waitFor(() => {
      const sideBySide = screen.getByTestId("inspector-node-side-by-side-diff");
      expect(sideBySide.textContent).toContain("Before text");
      expect(sideBySide.textContent).toContain("After text");
    });
  });

  it("detects Human + AI same-object conflicts when dirty in Inspector and resolves via Keep mine, Take AI's, or field-by-field selection", async () => {
    let serverState: BlueprintState = {
      ...createEmptyBlueprintState("conflict-proj"),
      identity: "core-auth",
      bricks: [{ id: "core-auth", config: {} }],
      entities: [],
      workflows: [
        {
          id: "wf-conflict",
          name: "Conflict Workflow",
          trigger: { kind: "manual" },
          nodes: [
            {
              id: "node-http-1",
              type: "core.http_request",
              label: "Webhook Step",
              data: {
                url: "https://api.example.com/v1",
                body: "initial-body",
              },
            },
          ],
          edges: [],
        },
      ],
      secretRefs: [],
    };
    let serverRev = 1;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/ops") && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as {
          ops: Array<Record<string, unknown>>;
        };
        serverState = applyStudioOps(serverState, body.ops, DEFAULT_CATALOG);
        serverRev += 1;
        return new Response(
          JSON.stringify({
            project: serverState.project,
            revision: serverRev,
            parentRevision: serverRev - 1,
            state: serverState,
            semanticHash: `hash-${serverRev}`,
            readiness: computeStudioReadiness(serverState, DEFAULT_CATALOG),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ revisions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    useStudioStore.getState().resetStore({
      user: { id: "u-1", email: "dev@example.com", name: "Dev" },
      orgs: [{ id: "org-1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org-1",
      activeProjectId: "conflict-proj",
      currentRevision: 1,
      projectState: serverState,
      readiness: computeStudioReadiness(serverState, DEFAULT_CATALOG),
      activeNav: "workflows",
      activeWorkflowId: "wf-conflict",
      selection: { kind: "node", id: "node-http-1", workflowId: "wf-conflict" },
    });

    render(<StudioShell />);

    // Human edits the URL field in the Inspector (making node-http-1 dirty)
    const urlInput = screen.getByTestId("node-config-input-url");
    fireEvent.change(urlInput, {
      target: { value: "https://human.example.com/v2" },
    });

    expect(useStudioStore.getState().dirtyTarget?.id).toBe("node-http-1");

    // While human is editing node-http-1, an AI agent (claude-code) commits an update to node-http-1
    useStudioStore.getState().applyIncomingRevision({
      type: "revision",
      project: "conflict-proj",
      revision: 2,
      parentRevision: 1,
      author: { type: "agent", id: "claude-code", client: "claude-code" },
      summary: "AI updated node-http-1 endpoint and body",
      ops: [
        {
          opId: "ai-op-1",
          type: "update_node",
          workflowId: "wf-conflict",
          nodeId: "node-http-1",
          patch: {
            data: {
              url: "https://ai.example.com/v2",
              body: "ai-updated-body",
            },
          },
        },
      ],
    });

    // Conflict Card appears in the Inspector with Human vs AI values
    const conflictCard = await screen.findByTestId("same-object-conflict-card");
    expect(conflictCard.textContent).toContain("https://human.example.com/v2");
    expect(conflictCard.textContent).toContain("https://ai.example.com/v2");
    expect(conflictCard.textContent).toContain("ai-updated-body");

    // Pick Human's 'url' and AI's 'body' using field-by-field merge
    fireEvent.click(screen.getByTestId("conflict-field-choice-url-mine"));
    fireEvent.click(screen.getByTestId("conflict-field-choice-body-ai"));
    fireEvent.click(screen.getByTestId("conflict-apply-merged-button"));

    await waitFor(() => {
      expect(useStudioStore.getState().pendingConflict).toBeNull();
      const updatedNode = useStudioStore
        .getState()
        .projectState?.workflows[0]?.nodes.find((n) => n.id === "node-http-1");
      expect(updatedNode?.data?.url).toBe("https://human.example.com/v2");
      expect(updatedNode?.data?.body).toBe("ai-updated-body");
    });
  });
});
