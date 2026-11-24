import { describe, expect, test } from "vitest";
import { catalog } from "@poc/assembler/catalog";
import {
  applyOps,
  createEmptyBlueprint,
  evaluateProposalSelection,
  summarizeProposalOps,
} from "../src/index.ts";
import type { Op } from "../src/index.ts";

describe("Story 7.2 — Draft Proposal Evaluation & Per-Op Selection (AC 1, AC 2)", () => {
  const buildBaseState = () => {
    const empty = createEmptyBlueprint("proposal-unit-proj");
    const step = applyOps(
      empty,
      [
        { opId: "base-1", type: "enable_brick", brickId: "multi-workspace" },
        { opId: "base-2", type: "enable_brick", brickId: "dynamic-entities" },
        {
          opId: "base-3",
          type: "add_entity",
          entity: {
            name: "invoices",
            fields: [
              { name: "amount", type: "number", required: true },
              { name: "legacy_note", type: "text", required: false, maxLength: 100 },
            ],
          },
        },
        {
          opId: "base-4",
          type: "add_workflow",
          workflow: {
            id: "wf-billing",
            name: "Billing Flow",
            nodes: [
              { id: "n_trigger", type: "trigger.manual", data: {} },
              { id: "n_transform", type: "transform.pick", data: { path: "invoice" } },
              { id: "n_legacy", type: "transform.pick", data: { path: "legacy" } },
            ],
            edges: [
              {
                id: "e_base",
                source: "n_trigger",
                target: "n_transform",
                sourceHandle: "out",
                targetHandle: "in",
              },
              {
                id: "e_legacy",
                source: "n_transform",
                target: "n_legacy",
                sourceHandle: "out",
                targetHandle: "in",
              },
            ],
          },
        },
      ],
      catalog,
    );
    expect(step.ok).toBe(true);
    if (!step.ok) throw new Error("Failed to construct base state");
    return step.state;
  };

  const proposalOps: Op[] = [
    {
      opId: "prop-add-node",
      type: "add_node",
      workflowId: "wf-billing",
      node: { id: "n_added", type: "transform.pick", data: { path: "invoice.total" } },
    },
    {
      opId: "prop-update-node",
      type: "update_node",
      workflowId: "wf-billing",
      nodeId: "n_transform",
      data: { path: "invoice.updated" },
    },
    {
      opId: "prop-remove-node",
      type: "remove_node",
      workflowId: "wf-billing",
      nodeId: "n_legacy",
    },
    {
      opId: "prop-add-edge",
      type: "connect_edges",
      workflowId: "wf-billing",
      edges: [
        {
          id: "e_added",
          source: "n_transform",
          target: "n_added",
          sourceHandle: "out",
          targetHandle: "in",
        },
      ],
    },
  ];

  test("summarizeProposalOps builds a concise human-readable summary of the batch", () => {
    const summary = summarizeProposalOps(proposalOps);
    expect(summary).toContain("Add node n_added");
    expect(summary).toContain("+3 more ops");
  });

  test("evaluateProposalSelection succeeds with isPartial=false when all ops are selected", () => {
    const baseState = buildBaseState();
    const evaluation = evaluateProposalSelection(baseState, proposalOps, undefined, catalog);
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) return;
    expect(evaluation.isPartial).toBe(false);
    expect(evaluation.selectedOps).toHaveLength(4);

    const wf = evaluation.state.workflows.find((w) => w.id === "wf-billing")!;
    expect(wf.nodes.map((n) => n.id)).toEqual(["n_added", "n_transform", "n_trigger"]);
    expect(wf.edges.map((e) => e.id)).toEqual(["e_added", "e_base"]);

    const wfDiff = evaluation.diff.workflows.updated.find((w) => w.id === "wf-billing")!;
    expect(wfDiff.nodesAdded.map((n) => n.id)).toEqual(["n_added"]);
    expect(wfDiff.nodesRemoved.map((n) => n.id)).toEqual(["n_legacy"]);
    expect(wfDiff.nodesUpdated.map((u) => u.id)).toEqual(["n_transform"]);
    expect(wfDiff.edgesAdded.map((e) => e.id)).toEqual(["e_added"]);
  });

  test("evaluateProposalSelection succeeds with isPartial=true when independent ops are deselected", () => {
    const baseState = buildBaseState();
    // Deselect `prop-remove-node` (keep `n_legacy`), accept the other 3 ops in original order
    const evaluation = evaluateProposalSelection(
      baseState,
      proposalOps,
      ["prop-add-edge", "prop-add-node", "prop-update-node"], // out-of-order opIds are applied in original batch order
      catalog,
    );
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) return;
    expect(evaluation.isPartial).toBe(true);
    expect(evaluation.selectedOpIds).toEqual([
      "prop-add-node",
      "prop-update-node",
      "prop-add-edge",
    ]);

    const wf = evaluation.state.workflows.find((w) => w.id === "wf-billing")!;
    expect(wf.nodes.map((n) => n.id)).toContain("n_legacy");
    expect(wf.nodes.map((n) => n.id)).toContain("n_added");
    expect(wf.edges.map((e) => e.id)).toContain("e_added");
  });

  test("evaluateProposalSelection fails cleanly before commit when deselecting add_node leaves a dependent connect_edges op invalid", () => {
    const baseState = buildBaseState();
    // Deselect `prop-add-node` while keeping `prop-add-edge` (which connects `n_transform` -> `n_added`)
    const evaluation = evaluateProposalSelection(
      baseState,
      proposalOps,
      ["prop-update-node", "prop-remove-node", "prop-add-edge"],
      catalog,
    );
    expect(evaluation.ok).toBe(false);
    if (evaluation.ok) return;
    expect(evaluation.status).toBe(422);
    expect(evaluation.error.code).toBe("VALIDATION_FAILED");
    expect(evaluation.error.issues.length).toBeGreaterThan(0);
    expect(evaluation.error.issues[0]?.code).toBe("MISSING_EDGE_ENDPOINT");
    expect(evaluation.error.issues[0]?.message).toContain("n_added");
  });

  test("evaluateProposalSelection rejects cross-op readiness regressions when a required edge is deselected leaving an orphan node", () => {
    const baseState = buildBaseState();
    // Select `prop-add-node` without `prop-add-edge`: `n_added` has no connected edges -> orphan_node readiness error
    const evaluation = evaluateProposalSelection(
      baseState,
      proposalOps,
      ["prop-add-node"],
      catalog,
    );
    expect(evaluation.ok).toBe(false);
    if (evaluation.ok) return;
    expect(evaluation.status).toBe(422);
    expect(evaluation.error.issues.some((i) => i.code === "orphan_node")).toBe(true);
  });
});
