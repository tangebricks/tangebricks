import { describe, expect, it } from "vitest";
import { catalog } from "../../assembler/catalog.generated.ts";
import {
  ActionableIssueSchema,
  DOCUMENTED_ERROR_CODES,
  applyOp,
  buildCatalogNodeRegistry,
  buildConflictActionableIssues,
  buildDeployBlockerActionableIssue,
  buildRuntimeStepActionableIssue,
  collectBlueprintActionableIssues,
  createEmptyBlueprint,
  toActionableIssue,
  toJsonPointerPath,
} from "../src/index.ts";

describe("Story 7.3 — ActionableIssueSchema & Structured Error Remediation (AC 1, AC 3)", () => {
  const registry = buildCatalogNodeRegistry(catalog);

  it("converts dot-delimited and bracketed paths into RFC 6901 JSON pointers", () => {
    expect(toJsonPointerPath("bricks.credit-wallet")).toBe("/bricks/credit-wallet");
    expect(toJsonPointerPath("workflows.wf_1.nodes.n_2.data.amount")).toBe("/workflows/wf_1/nodes/n_2/data/amount");
    expect(toJsonPointerPath("/entities/invoices/fields/0")).toBe("/entities/invoices/fields/0");
  });

  it("maps all 8+ graph validator error classes, blueprint capability/conflict/setting/entity rules, connection rules, stale baseRev, runtime failures, and deploy blockers to ActionableIssueSchema", () => {
    // 1. MISSING_CAPABILITY_PROVIDER
    const missingCapState = createEmptyBlueprint("test-missing-cap", {
      bricks: [{ id: "credit-wallet", config: { creditsPerUnit: 10 } }],
    });
    const missingCapIssues = collectBlueprintActionableIssues(missingCapState, {
      catalog,
      nodeRegistry: registry,
    });
    const missingCap = missingCapIssues.find((i) => i.code === "MISSING_CAPABILITY_PROVIDER");
    expect(missingCap).toBeDefined();
    expect(ActionableIssueSchema.safeParse(missingCap).success).toBe(true);
    expect(missingCap?.path).toBe("/bricks/credit-wallet");
    expect(missingCap?.remediationOp).toEqual({
      kind: "enable_brick",
      payloadExample: { brickId: "multi-workspace" },
    });

    // 2. BRICK_CONFLICT
    const conflictState = createEmptyBlueprint("test-conflict", {
      bricks: [
        { id: "multi-workspace", config: {} },
        { id: "document-parsing", config: {} },
        { id: "document-pdf", config: {} },
      ],
    });
    const conflictIssues = collectBlueprintActionableIssues(conflictState, {
      catalog,
      nodeRegistry: registry,
    });
    const conflict = conflictIssues.find((i) => i.code === "BRICK_CONFLICT");
    expect(conflict).toBeDefined();
    expect(ActionableIssueSchema.safeParse(conflict).success).toBe(true);
    expect(conflict?.path).toBe("/bricks/document-pdf");
    expect(conflict?.remediationOp?.kind).toBe("remove_brick");

    // 3. PORT_TYPE_MISMATCH (incompatible_wire: string -> number)
    const wireState = createEmptyBlueprint("test-wire", {
      bricks: [{ id: "multi-workspace", config: {} }],
      workflows: [
        {
          id: "wf_1",
          name: "Wire WF",
          trigger: { kind: "manual" },
          nodes: [
            { id: "t_1", type: "core.webhook", data: {} },
            {
              id: "n_str",
              type: "core.format_template",
              data: { template: "hi" },
            },
            {
              id: "n_math",
              type: "core.math",
              data: { operation: "add", operand: 2 },
            },
          ],
          edges: [
            {
              id: "e_1",
              source: "t_1",
              target: "n_str",
              sourceHandle: "out",
              targetHandle: "in",
            },
            {
              id: "e_bad",
              source: "n_str",
              target: "n_math",
              sourceHandle: "out",
              targetHandle: "number",
            },
          ],
        },
      ],
    });
    const wireIssues = collectBlueprintActionableIssues(wireState, {
      catalog,
      nodeRegistry: registry,
    });
    const wireMismatch = wireIssues.find((i) => i.code === "PORT_TYPE_MISMATCH");
    expect(wireMismatch).toBeDefined();
    expect(ActionableIssueSchema.safeParse(wireMismatch).success).toBe(true);
    expect(wireMismatch?.path).toBe("/workflows/wf_1/edges/e_bad");
    expect(wireMismatch?.remediationOp).toEqual({
      kind: "disconnect_edge",
      payloadExample: { workflowId: "wf_1", edgeId: "e_bad" },
    });

    // 4. GRAPH_CYCLE
    const cycleState = createEmptyBlueprint("test-cycle", {
      bricks: [{ id: "multi-workspace", config: {} }],
      workflows: [
        {
          id: "wf_1",
          name: "Cycle WF",
          trigger: { kind: "manual" },
          nodes: [
            { id: "t_1", type: "trigger.manual", data: {} },
            { id: "n_1", type: "core.noop", data: {} },
            { id: "n_2", type: "core.noop", data: {} },
          ],
          edges: [
            {
              id: "e_1",
              source: "t_1",
              target: "n_1",
              sourceHandle: "out",
              targetHandle: "in",
            },
            {
              id: "e_2",
              source: "n_1",
              target: "n_2",
              sourceHandle: "out",
              targetHandle: "in",
            },
            {
              id: "e_back",
              source: "n_2",
              target: "n_1",
              sourceHandle: "out",
              targetHandle: "in",
            },
          ],
        },
      ],
    });
    const cycleIssues = collectBlueprintActionableIssues(cycleState, {
      catalog,
      nodeRegistry: registry,
    });
    const cycleIssue = cycleIssues.find((i) => i.code === "GRAPH_CYCLE");
    expect(cycleIssue).toBeDefined();
    expect(ActionableIssueSchema.safeParse(cycleIssue).success).toBe(true);
    expect(cycleIssue?.path).toBe("/workflows/wf_1/edges/e_back");
    expect(cycleIssue?.remediationOp).toEqual({
      kind: "disconnect_edge",
      payloadExample: { workflowId: "wf_1", edgeId: "e_back" },
    });

    // 5. UNREACHABLE_NODE (orphan_node)
    const orphanState = createEmptyBlueprint("test-orphan", {
      bricks: [{ id: "multi-workspace", config: {} }],
      workflows: [
        {
          id: "wf_1",
          name: "Orphan WF",
          trigger: { kind: "manual" },
          nodes: [
            { id: "t_1", type: "trigger.manual", data: {} },
            { id: "n_orphan", type: "core.noop", data: {} },
          ],
          edges: [],
        },
      ],
    });
    const orphanIssues = collectBlueprintActionableIssues(orphanState, {
      catalog,
      nodeRegistry: registry,
    });
    const orphanIssue = orphanIssues.find((i) => i.code === "UNREACHABLE_NODE");
    expect(orphanIssue).toBeDefined();
    expect(ActionableIssueSchema.safeParse(orphanIssue).success).toBe(true);
    expect(orphanIssue?.path).toBe("/workflows/wf_1/nodes/n_orphan");
    expect(orphanIssue?.remediationOp?.kind).toBe("connect_edges");

    // 6. UNBOUND_CONNECTION
    const unboundState = createEmptyBlueprint("test-unbound", {
      bricks: [{ id: "multi-workspace", config: {} }],
      workflows: [
        {
          id: "wf_1",
          name: "Unbound WF",
          trigger: { kind: "manual" },
          nodes: [
            { id: "t_1", type: "trigger.manual", data: {} },
            {
              id: "n_2",
              type: "core.noop",
              data: { connectionRef: "sec_missing_conn" },
            },
          ],
          edges: [
            {
              id: "e_1",
              source: "t_1",
              target: "n_2",
              sourceHandle: "out",
              targetHandle: "in",
            },
          ],
        },
      ],
    });
    const unboundIssues = collectBlueprintActionableIssues(unboundState, {
      catalog,
      nodeRegistry: registry,
      boundConnectionIds: ["sec_stripe_valid"],
      availableConnectionIds: ["sec_stripe_valid"],
    });
    const unboundIssue = unboundIssues.find((i) => i.code === "UNBOUND_CONNECTION");
    expect(unboundIssue).toBeDefined();
    expect(ActionableIssueSchema.safeParse(unboundIssue).success).toBe(true);
    expect(unboundIssue?.path).toBe("/workflows/wf_1/nodes/n_2/data/connectionRef");
    expect(unboundIssue?.remediationOp).toEqual({
      kind: "update_node",
      payloadExample: {
        workflowId: "wf_1",
        nodeId: "n_2",
        patch: { data: { connectionRef: "sec_stripe_valid" } },
      },
    });

    // 7. INVALID_SETTING_VALUE (brick config & node config)
    const invalidBrickCfgState = createEmptyBlueprint("test-bad-setting", {
      bricks: [
        { id: "multi-workspace", config: {} },
        { id: "credit-wallet", config: { creditsPerUnit: 0 } },
      ],
    });
    const settingIssues = collectBlueprintActionableIssues(invalidBrickCfgState, {
      catalog,
      nodeRegistry: registry,
    });
    const settingIssue = settingIssues.find((i) => i.code === "INVALID_SETTING_VALUE");
    expect(settingIssue).toBeDefined();
    expect(ActionableIssueSchema.safeParse(settingIssue).success).toBe(true);
    expect(settingIssue?.path).toBe("/bricks/credit-wallet/config/creditsPerUnit");
    expect(settingIssue?.remediationOp?.kind).toBe("configure_brick");

    // 8. Remaining graph validator codes: no_trigger, multi_trigger, duplicate_node, unknown_brick, bad_ref
    for (const rawGraphErr of [
      {
        code: "no_trigger",
        path: "workflows.wf_1",
        message: "add a trigger brick to start the graph",
      },
      {
        code: "multi_trigger",
        path: "workflows.wf_1.nodes.t_2",
        message: "only one trigger is allowed",
      },
      {
        code: "duplicate_node",
        path: "workflows.wf_1.nodes.n_dup",
        message: "another node has this id",
      },
      {
        code: "unknown_brick",
        path: "workflows.wf_1.nodes.n_unknown",
        message: "unknown brick type",
      },
      {
        code: "bad_ref",
        path: "workflows.wf_1.nodes.n_2",
        message: "node references non-ancestor",
      },
    ]) {
      const enriched = toActionableIssue(rawGraphErr, { catalog });
      expect(ActionableIssueSchema.safeParse(enriched).success).toBe(true);
      expect(DOCUMENTED_ERROR_CODES).toContain(enriched.code);
      expect(enriched.remediationOp).toBeDefined();
    }

    // 9. Entity validation error via applyOp -> toActionableIssue
    const badEntityRes = applyOp(
      createEmptyBlueprint("test-entity"),
      {
        opId: "ent-bad",
        type: "add_entity",
        entity: {
          name: "wallet",
          workspaceScoped: true,
          fields: [{ name: "note", type: "text", required: false }],
        },
      },
      catalog,
    );
    expect(badEntityRes.ok).toBe(false);
    if (!badEntityRes.ok) {
      const entityIssue = toActionableIssue(badEntityRes.errors[0]!, {
        catalog,
      });
      expect(ActionableIssueSchema.safeParse(entityIssue).success).toBe(true);
    }

    // 10. STALE_BASE_REV
    const conflictActionable = buildConflictActionableIssues({
      baseRev: 1,
      currentRev: 2,
      conflictingOps: [
        {
          opId: "op-stale",
          type: "update_node",
          targetKey: "workflow:wf_1:node:n_2",
        },
      ],
      failedOp: {
        type: "update_node",
        workflowId: "wf_1",
        nodeId: "n_2",
        patch: { data: { amount: 50 } },
      },
    })[0]!;
    expect(ActionableIssueSchema.safeParse(conflictActionable).success).toBe(true);
    expect(conflictActionable.code).toBe("STALE_BASE_REV");
    expect(conflictActionable.path).toBe("/workflow/wf_1/node/n_2");
    expect(conflictActionable.remediationOp?.payloadExample.baseRev).toBe(2);

    // 11. RUN_STEP_MISSING_INPUT
    const runtimeMissingInput = buildRuntimeStepActionableIssue({
      workflowId: "wf_1",
      nodeId: "n_2",
      errorMessage:
        'RUN_STEP_MISSING_INPUT: Step "n_2" field "customerId" mapped to "{{steps.t_1.output.bad_id}}", but field "bad_id" does not exist on upstream node "t_1" output (available fields: customer_id, email)',
      nodeData: { customerId: "{{steps.t_1.output.bad_id}}" },
    });
    expect(ActionableIssueSchema.safeParse(runtimeMissingInput).success).toBe(true);
    expect(runtimeMissingInput.code).toBe("RUN_STEP_MISSING_INPUT");
    expect(runtimeMissingInput.path).toBe("/workflows/wf_1/nodes/n_2/data/customerId");
    expect(runtimeMissingInput.remediationOp).toEqual({
      kind: "update_node",
      payloadExample: {
        workflowId: "wf_1",
        nodeId: "n_2",
        patch: {
          data: {
            customerId: "{{steps.t_1.output.customer_id}}",
          },
        },
      },
    });

    // 12. DEPLOY_STUB_IDENTITY_REFUSED
    const deployBlocker = buildDeployBlockerActionableIssue("Production deployments cannot use stub identity; enable core-auth and set identity to core-auth.");
    expect(ActionableIssueSchema.safeParse(deployBlocker).success).toBe(true);
    expect(deployBlocker.code).toBe("DEPLOY_STUB_IDENTITY_REFUSED");
    expect(deployBlocker.path).toBe("/identity");
    expect(deployBlocker.remediationOp).toEqual({
      kind: "set_identity",
      payloadExample: { identity: "core-auth" },
    });
  });
});
