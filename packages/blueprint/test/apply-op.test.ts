import { describe, expect, test, vi } from "vitest";
import { assemble, hashFiles, sha256Hex } from "@poc/assembler";
import { catalog } from "../../assembler/catalog.generated.ts";
import { toyRegistry } from "@poc/sdk";
import {
  BlueprintStateSchema,
  EntityDefinitionSchema,
  OP_TYPES,
  OpSchema,
  applyOp,
  applyOps,
  collectBlueprintActionableIssues,
  computeReadiness,
  createEmptyBlueprint,
  semanticHash,
  sha256HexSync,
  targetKey,
  toAssemblerBlueprint,
  toSdkEntity,
} from "../src/index.ts";
import type { BlueprintState, Op } from "../src/index.ts";

function applyExpectOk(state: BlueprintState, op: Op) {
  const res = applyOp(state, op, catalog, toyRegistry);
  if (!res.ok) {
    throw new Error(`Expected op ${op.type} (${op.opId}) to succeed, got: ${JSON.stringify(res.errors)}`);
  }
  return res;
}

function assertInverseRestoresSemanticHash(stateBefore: BlueprintState, op: Op): BlueprintState {
  const hashBefore = semanticHash(stateBefore);
  const forward = applyExpectOk(stateBefore, op);
  const backward = applyOps(forward.state, forward.inverseOps, catalog, toyRegistry);
  if (!backward.ok) {
    throw new Error(
      `Expected inverse of ${op.type} to succeed, got: ${JSON.stringify(backward.errors)}`,
    );
  }
  expect(semanticHash(backward.state)).toBe(hashBefore);
  expect(backward.state.bricks).toEqual(stateBefore.bricks);
  expect(backward.state.identity).toEqual(stateBefore.identity);
  expect(backward.state.entities).toEqual(stateBefore.entities);
  expect(backward.state.workflows).toEqual(stateBefore.workflows);
  expect(backward.state.secretRefs).toEqual(stateBefore.secretRefs);
  return forward.state;
}

describe("BlueprintStateSchema v2 & sha256HexSync", () => {
  test("validates canonical v2 state and normalizes sorted arrays", () => {
    const empty = createEmptyBlueprint("acme-saas");
    const parsed = BlueprintStateSchema.safeParse(empty);
    expect(parsed.success).toBe(true);
    expect(empty).toEqual({
      project: "acme-saas",
      identity: "stub",
      bricks: [],
      entities: [],
      workflows: [],
      secretRefs: [],
      metadata: {},
    });
  });

  test("sha256HexSync matches WebCrypto sha256Hex across ASCII, UTF-8, and JSON payloads", async () => {
    const samples = [
      "",
      "abc",
      "The quick brown fox jumps over the lazy dog",
      "🚀 ProjectX Studio — Clean-Room SHA-256 Verification ✓",
      JSON.stringify(createEmptyBlueprint("invoice-flow")),
      "x".repeat(2048),
    ];
    for (const sample of samples) {
      expect(sha256HexSync(sample)).toBe(await sha256Hex(sample));
    }
  });
});

describe("Every op kind happy path and round-trip inverse (AC 3, AC 4, AC 7)", () => {
  test("covers all 17 op kinds in OpSchema with exact inverse restoration of semanticHash", () => {
    expect(OP_TYPES).toHaveLength(17);

    let state = createEmptyBlueprint("studio-contract");

    // 1. enable_brick (multi-workspace)
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-1",
      type: "enable_brick",
      brickId: "multi-workspace",
    });

    // 2. enable_brick (credit-wallet with initial config)
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-2",
      type: "enable_brick",
      brickId: "credit-wallet",
      config: { creditsPerUnit: 5 },
    });

    // 2b. enable_brick on an already-enabled brick updates config and its inverse restores old config
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-2b",
      type: "enable_brick",
      brickId: "credit-wallet",
      config: { creditsPerUnit: 10 },
    });

    // 3. configure_brick
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-3",
      type: "configure_brick",
      brickId: "credit-wallet",
      config: { minOrderAmount: 50 },
    });
    expect(state.bricks.find((b) => b.id === "credit-wallet")?.config).toEqual({
      creditsPerUnit: 10,
      minOrderAmount: 50,
    });

    // 4. enable core-auth anddynamic-entities so we can test set_identity and entity ops
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-4a",
      type: "enable_brick",
      brickId: "core-auth",
    });
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-4b",
      type: "enable_brick",
      brickId: "dynamic-entities",
    });

    // 5. set_identity
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-5",
      type: "set_identity",
      identity: "core-auth",
    });
    expect(state.identity).toBe("core-auth");

    // 6. add_entity
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-6",
      type: "add_entity",
      entity: {
        name: "invoices",
        workspaceScoped: true,
        fields: [
          { name: "title", type: "text", required: true, maxLength: 200 },
          { name: "amount_cents", type: "number", required: true, min: 0 },
        ],
      },
    });
    expect(state.entities.map((e) => e.name)).toEqual(["invoices"]);

    // 7. update_entity
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-7",
      type: "update_entity",
      entity: {
        name: "invoices",
        workspaceScoped: true,
        fields: [
          { name: "title", type: "text", required: true, maxLength: 300 },
          { name: "amount_cents", type: "number", required: true, min: 100 },
          { name: "status", type: "enum", required: true, values: ["draft", "paid"] },
        ],
      },
    });
    expect(state.entities[0]?.fields).toHaveLength(3);

    // 8. remove_entity
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-8",
      type: "remove_entity",
      name: "invoices",
    });
    expect(state.entities).toEqual([]);

    // Re-add entity for subsequent state
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-8b",
      type: "add_entity",
      entity: {
        name: "customers",
        workspaceScoped: true,
        fields: [{ name: "email", type: "text", required: true, maxLength: 255 }],
      },
    });

    // 9. add_workflow
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-9",
      type: "add_workflow",
      workflow: {
        id: "wf-onboarding",
        name: "Customer Onboarding",
        trigger: { kind: "manual" },
        nodes: [],
        edges: [],
      },
    });
    expect(state.workflows.map((w) => w.id)).toEqual(["wf-onboarding"]);

    // 10. add_node (trigger + 2 transform nodes)
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-10a",
      type: "add_node",
      workflowId: "wf-onboarding",
      node: { id: "t1", type: "trigger.manual", label: "Start", data: {} },
    });
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-10b",
      type: "add_node",
      workflowId: "wf-onboarding",
      node: { id: "p1", type: "transform.pick", label: "Pick User", data: { path: "user" } },
    });
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-10c",
      type: "add_node",
      workflowId: "wf-onboarding",
      node: {
        id: "p2",
        type: "transform.pick",
        label: "Pick Email",
        data: { path: "{{$node.t1.email}}" },
      },
    });

    // 11. update_node
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-11",
      type: "update_node",
      workflowId: "wf-onboarding",
      nodeId: "p1",
      patch: {
        label: "Pick Account",
        data: { path: "account.id" },
      },
    });
    expect(
      state.workflows[0]?.nodes.find((n) => n.id === "p1")?.data,
    ).toEqual({ path: "account.id" });

    // 12. connect_edges
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-12",
      type: "connect_edges",
      workflowId: "wf-onboarding",
      edges: [
        { id: "e-t1-p1", source: "t1", target: "p1", sourceHandle: "out", targetHandle: "in" },
        { id: "e-p1-p2", source: "p1", target: "p2", sourceHandle: "out", targetHandle: "in" },
      ],
    });
    expect(state.workflows[0]?.edges).toHaveLength(2);

    // 13. disconnect_edge
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-13",
      type: "disconnect_edge",
      workflowId: "wf-onboarding",
      edgeId: "e-p1-p2",
    });
    expect(state.workflows[0]?.edges.map((e) => e.id)).toEqual(["e-t1-p1"]);

    // Reconnect edge e-p1-p2 so remove_node tests removing incident edges too
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-13b",
      type: "connect_edges",
      workflowId: "wf-onboarding",
      edges: [
        { id: "e-p1-p2", source: "p1", target: "p2", sourceHandle: "out", targetHandle: "in" },
      ],
    });

    // 14. remove_node (with incident edge e-p1-p2 restored by inverse!)
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-14",
      type: "remove_node",
      workflowId: "wf-onboarding",
      nodeId: "p2",
    });
    expect(state.workflows[0]?.nodes.map((n) => n.id)).toEqual(["p1", "t1"]);
    expect(state.workflows[0]?.edges.map((e) => e.id)).toEqual(["e-t1-p1"]);

    // 15. remove_workflow
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-15",
      type: "remove_workflow",
      workflowId: "wf-onboarding",
    });
    expect(state.workflows).toEqual([]);

    // 16. bind_secret_ref (new binding, update binding, and unbind_secret_ref)
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-16a",
      type: "bind_secret_ref",
      ref: "sec_better_auth_secret",
      targetKind: "brick",
      targetId: "core-auth",
      secretName: "BETTER_AUTH_SECRET",
    });
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-16b",
      type: "bind_secret_ref",
      ref: "sec_better_auth_secret_v2",
      targetKind: "brick",
      targetId: "core-auth",
      secretName: "BETTER_AUTH_SECRET",
    });
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-16c",
      type: "unbind_secret_ref",
      targetKind: "brick",
      targetId: "core-auth",
      secretName: "BETTER_AUTH_SECRET",
    });
    expect(state.secretRefs).toEqual([]);

    // 17. remove_brick
    state = assertInverseRestoresSemanticHash(state, {
      opId: "op-17",
      type: "remove_brick",
      brickId: "credit-wallet",
    });
    expect(state.bricks.some((b) => b.id === "credit-wallet")).toBe(false);

    // 18. set_metadata (and inverse restoring metadata)
    const beforeMeta = structuredClone(state);
    const metaForward = applyExpectOk(beforeMeta, {
      opId: "op-18",
      type: "set_metadata",
      metadata: {
        displayName: "Studio Contract Project",
        layout: { t1: { x: 120, y: 240 } },
        viewport: { x: 0, y: 0, zoom: 1.25 },
      },
    });
    expect(metaForward.state.metadata.displayName).toBe("Studio Contract Project");
    const metaBackward = applyOps(metaForward.state, metaForward.inverseOps, catalog, toyRegistry);
    expect(metaBackward.ok).toBe(true);
    if (metaBackward.ok) {
      expect(metaBackward.state.metadata).toEqual(beforeMeta.metadata);
    }
  });

  test("multi-op batch applyOps and batch inverseOps restore initial state semanticHash", () => {
    const initial = createEmptyBlueprint("batch-test");
    const batch: Op[] = [
      { opId: "b-1", type: "enable_brick", brickId: "multi-workspace" },
      { opId: "b-2", type: "enable_brick", brickId: "credit-wallet", config: { creditsPerUnit: 10 } },
      { opId: "b-3", type: "enable_brick", brickId: "dynamic-entities" },
      {
        opId: "b-4",
        type: "add_entity",
        entity: {
          name: "tasks",
          workspaceScoped: true,
          fields: [{ name: "title", type: "text", required: true, maxLength: 100 }],
        },
      },
      {
        opId: "b-5",
        type: "add_workflow",
        workflow: {
          id: "wf-main",
          name: "Main Flow",
          nodes: [
            { id: "t", type: "trigger.manual", data: {} },
            { id: "p", type: "transform.pick", data: { path: "title" } },
          ],
          edges: [{ id: "e1", source: "t", target: "p", sourceHandle: "out", targetHandle: "in" }],
        },
      },
    ];

    const applied = applyOps(initial, batch, catalog, toyRegistry);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    expect(semanticHash(applied.state)).not.toBe(semanticHash(initial));

    const reverted = applyOps(applied.state, applied.inverseOps, catalog, toyRegistry);
    expect(reverted.ok).toBe(true);
    if (!reverted.ok) return;

    expect(semanticHash(reverted.state)).toBe(semanticHash(initial));
    expect(reverted.state).toEqual(initial);
  });
});

describe("Validation error fixtures — one per error class without mutating state (AC 4, AC 7)", () => {
  test("1. rejects unknown brick id", () => {
    const state = Object.freeze(createEmptyBlueprint("err-test"));
    const res = applyOp(
      state,
      { opId: "e-brick", type: "enable_brick", brickId: "non-existent-brick" },
      catalog,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]?.code).toBe("UNKNOWN_BRICK");
      expect(res.errors[0]?.path).toBe("bricks.non-existent-brick");
      expect(res.errors[0]?.suggestedFix).toBeDefined();
    }
  });

  test("2. rejects invalid brick setting key, type, and out-of-range value (checkBrickConfig)", () => {
    const base = applyExpectOk(createEmptyBlueprint("err-test"), {
      opId: "init-1",
      type: "enable_brick",
      brickId: "credit-wallet",
    }).state;

    // Out of range integer setting
    const badRange = applyOp(
      base,
      {
        opId: "e-setting-range",
        type: "configure_brick",
        brickId: "credit-wallet",
        config: { creditsPerUnit: 0 },
      },
      catalog,
    );
    expect(badRange.ok).toBe(false);
    if (!badRange.ok) {
      expect(badRange.errors[0]?.code).toBe("INVALID_BRICK_CONFIG");
      expect(badRange.errors[0]?.message).toMatch(/creditsPerUnit/);
    }

    // Unknown setting key
    const badKey = applyOp(
      base,
      {
        opId: "e-setting-key",
        type: "configure_brick",
        brickId: "credit-wallet",
        config: { unknownSettingKey: 42 },
      },
      catalog,
    );
    expect(badKey.ok).toBe(false);
    if (!badKey.ok) {
      expect(badKey.errors[0]?.code).toBe("INVALID_BRICK_CONFIG");
      expect(badKey.errors[0]?.message).toMatch(/unknown setting "unknownSettingKey"/);
    }
  });

  test("3. rejects declared brick conflict (conflicts)", () => {
    const withDocParsing = applyExpectOk(createEmptyBlueprint("err-test"), {
      opId: "c-1",
      type: "enable_brick",
      brickId: "document-parsing",
    }).state;

    const conflictRes = applyOp(
      withDocParsing,
      {
        opId: "c-2",
        type: "enable_brick",
        brickId: "document-pdf",
      },
      catalog,
    );
    expect(conflictRes.ok).toBe(false);
    if (!conflictRes.ok) {
      expect(conflictRes.errors[0]?.code).toBe("BRICK_CONFLICT");
      expect(conflictRes.errors[0]?.message).toContain("conflict: document-parsing × document-pdf");
    }
  });

  test("4. rejects invalid identity brick (does not provide user-identity)", () => {
    const state = createEmptyBlueprint("err-test");
    const res = applyOp(
      state,
      {
        opId: "id-1",
        type: "set_identity",
        identity: "multi-workspace",
      },
      catalog,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]?.code).toBe("INVALID_IDENTITY_BRICK");
    }
  });

  test("5. rejects duplicate entity and invalid entity/field schema (parseEntities)", () => {
    const state = applyExpectOk(createEmptyBlueprint("err-test"), {
      opId: "ent-1",
      type: "add_entity",
      entity: {
        name: "orders",
        workspaceScoped: true,
        fields: [{ name: "total", type: "number", required: true, min: 0, max: 1000 }],
      },
    }).state;

    // Duplicate entity
    const dupRes = applyOp(
      state,
      {
        opId: "ent-dup",
        type: "add_entity",
        entity: {
          name: "orders",
          workspaceScoped: true,
          fields: [{ name: "total", type: "number", required: true }],
        },
      },
      catalog,
    );
    expect(dupRes.ok).toBe(false);
    if (!dupRes.ok) {
      expect(dupRes.errors[0]?.code).toBe("DUPLICATE_ENTITY");
    }

    // Invalid field schema (reserved field name "id" and min > max)
    const badSchemaRes = applyOp(
      state,
      {
        opId: "ent-bad-schema",
        type: "add_entity",
        entity: {
          name: "items",
          workspaceScoped: true,
          fields: [
            { name: "id", type: "text", required: true },
            { name: "qty", type: "number", required: true, min: 50, max: 10 },
          ],
        },
      },
      catalog,
    );
    expect(badSchemaRes.ok).toBe(false);
    if (!badSchemaRes.ok) {
      expect(badSchemaRes.errors[0]?.code).toBe("INVALID_ENTITY_SCHEMA");
    }
  });

  test("6. rejects entity route collision with catalog routePrefixes", () => {
    const state = createEmptyBlueprint("err-test");
    const clashRes = applyOp(
      state,
      {
        opId: "ent-clash",
        type: "add_entity",
        entity: {
          name: "wallet",
          workspaceScoped: true,
          fields: [{ name: "note", type: "text", required: false }],
        },
      },
      catalog,
    );
    expect(clashRes.ok).toBe(false);
    if (!clashRes.ok) {
      expect(clashRes.errors[0]?.code).toBe("ENTITY_ROUTE_COLLISION");
      expect(clashRes.errors[0]?.message).toMatch(/routes already use/);
    }
  });

  test("7. rejects unknown workflow, unknown node, and unknown edge ids", () => {
    const state = applyExpectOk(createEmptyBlueprint("err-test"), {
      opId: "wf-init",
      type: "add_workflow",
      workflow: { id: "wf-1", name: "WF 1", nodes: [], edges: [] },
    }).state;

    const unknownWf = applyOp(
      state,
      {
        opId: "u-wf",
        type: "add_node",
        workflowId: "wf-missing",
        node: { id: "t", type: "trigger.manual", data: {} },
      },
      catalog,
      toyRegistry,
    );
    expect(unknownWf.ok).toBe(false);
    if (!unknownWf.ok) expect(unknownWf.errors[0]?.code).toBe("UNKNOWN_WORKFLOW");

    const unknownNode = applyOp(
      state,
      {
        opId: "u-node",
        type: "update_node",
        workflowId: "wf-1",
        nodeId: "node-missing",
        data: {},
      },
      catalog,
      toyRegistry,
    );
    expect(unknownNode.ok).toBe(false);
    if (!unknownNode.ok) expect(unknownNode.errors[0]?.code).toBe("UNKNOWN_NODE");

    const unknownEdge = applyOp(
      state,
      {
        opId: "u-edge",
        type: "disconnect_edge",
        workflowId: "wf-1",
        edgeId: "edge-missing",
      },
      catalog,
      toyRegistry,
    );
    expect(unknownEdge.ok).toBe(false);
    if (!unknownEdge.ok) expect(unknownEdge.errors[0]?.code).toBe("UNKNOWN_EDGE");
  });

  test("8. rejects all graph validator error classes (no_trigger, multi_trigger, cycle, orphan_node, unknown_brick, invalid_config, bad_ref, incompatible_wire, duplicate_node, self_loop, missing_endpoint)", () => {
    const empty = createEmptyBlueprint("graph-errors");

    // 8a. no_trigger
    const noTrigger = applyOp(
      empty,
      {
        opId: "g-no-trigger",
        type: "add_workflow",
        workflow: {
          id: "wf",
          name: "No Trigger",
          nodes: [
            { id: "p1", type: "transform.pick", data: { path: "a" } },
            { id: "p2", type: "transform.pick", data: { path: "b" } },
          ],
          edges: [{ id: "e1", source: "p1", target: "p2", sourceHandle: "out", targetHandle: "in" }],
        },
      },
      catalog,
      toyRegistry,
    );
    expect(noTrigger.ok).toBe(false);
    if (!noTrigger.ok) expect(noTrigger.errors.map((e) => e.code)).toContain("no_trigger");

    // 8b. multi_trigger
    const multiTrigger = applyOp(
      empty,
      {
        opId: "g-multi-trigger",
        type: "add_workflow",
        workflow: {
          id: "wf",
          name: "Multi Trigger",
          nodes: [
            { id: "t1", type: "trigger.manual", data: {} },
            { id: "t2", type: "trigger.manual", data: {} },
            { id: "p1", type: "transform.pick", data: { path: "a" } },
          ],
          edges: [
            { id: "e1", source: "t1", target: "p1", sourceHandle: "out", targetHandle: "in" },
            { id: "e2", source: "t2", target: "p1", sourceHandle: "out", targetHandle: "in" },
          ],
        },
      },
      catalog,
      toyRegistry,
    );
    expect(multiTrigger.ok).toBe(false);
    if (!multiTrigger.ok) expect(multiTrigger.errors.map((e) => e.code)).toContain("multi_trigger");

    // 8c. cycle
    const cycle = applyOp(
      empty,
      {
        opId: "g-cycle",
        type: "add_workflow",
        workflow: {
          id: "wf",
          name: "Cycle",
          nodes: [
            { id: "t", type: "trigger.manual", data: {} },
            { id: "p1", type: "transform.pick", data: { path: "a" } },
            { id: "p2", type: "transform.pick", data: { path: "b" } },
          ],
          edges: [
            { id: "e1", source: "t", target: "p1", sourceHandle: "out", targetHandle: "in" },
            { id: "e2", source: "p1", target: "p2", sourceHandle: "out", targetHandle: "in" },
            { id: "e3", source: "p2", target: "p1", sourceHandle: "out", targetHandle: "in" },
          ],
        },
      },
      catalog,
      toyRegistry,
    );
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.errors.map((e) => e.code)).toContain("cycle");

    // 8d. orphan_node
    const orphan = applyOp(
      empty,
      {
        opId: "g-orphan",
        type: "add_workflow",
        workflow: {
          id: "wf",
          name: "Orphan",
          nodes: [
            { id: "t", type: "trigger.manual", data: {} },
            { id: "p1", type: "transform.pick", data: { path: "a" } },
            { id: "lonely", type: "transform.pick", data: { path: "b" } },
          ],
          edges: [{ id: "e1", source: "t", target: "p1", sourceHandle: "out", targetHandle: "in" }],
        },
      },
      catalog,
      toyRegistry,
    );
    expect(orphan.ok).toBe(false);
    if (!orphan.ok) expect(orphan.errors.map((e) => e.code)).toContain("orphan_node");

    // 8e. unknown_brick (unknown node type)
    const unknownNodeType = applyOp(
      empty,
      {
        opId: "g-unknown-node",
        type: "add_workflow",
        workflow: {
          id: "wf",
          name: "Unknown Node",
          nodes: [
            { id: "t", type: "trigger.manual", data: {} },
            { id: "x", type: "does.not.exist", data: {} },
          ],
          edges: [{ id: "e1", source: "t", target: "x", sourceHandle: "out", targetHandle: "in" }],
        },
      },
      catalog,
      toyRegistry,
    );
    expect(unknownNodeType.ok).toBe(false);
    if (!unknownNodeType.ok) {
      expect(unknownNodeType.errors.map((e) => e.code)).toContain("unknown_brick");
    }

    // 8f. invalid_config
    const invalidNodeConfig = applyOp(
      empty,
      {
        opId: "g-invalid-config",
        type: "add_workflow",
        workflow: {
          id: "wf",
          name: "Invalid Config",
          nodes: [
            { id: "t", type: "trigger.manual", data: {} },
            { id: "p1", type: "transform.pick", data: { path: "" } },
          ],
          edges: [{ id: "e1", source: "t", target: "p1", sourceHandle: "out", targetHandle: "in" }],
        },
      },
      catalog,
      toyRegistry,
    );
    expect(invalidNodeConfig.ok).toBe(false);
    if (!invalidNodeConfig.ok) {
      expect(invalidNodeConfig.errors.map((e) => e.code)).toContain("invalid_config");
    }

    // 8g. bad_ref
    const badRef = applyOp(
      empty,
      {
        opId: "g-bad-ref",
        type: "add_workflow",
        workflow: {
          id: "wf",
          name: "Bad Ref",
          nodes: [
            { id: "t", type: "trigger.manual", data: {} },
            { id: "p1", type: "transform.pick", data: { path: "{{$node.p2.value}}" } },
            { id: "p2", type: "transform.pick", data: { path: "a" } },
          ],
          edges: [
            { id: "e1", source: "t", target: "p1", sourceHandle: "out", targetHandle: "in" },
            { id: "e2", source: "p1", target: "p2", sourceHandle: "out", targetHandle: "in" },
          ],
        },
      },
      catalog,
      toyRegistry,
    );
    expect(badRef.ok).toBe(false);
    if (!badRef.ok) expect(badRef.errors.map((e) => e.code)).toContain("bad_ref");

    // 8h. incompatible_wire (port dataType mismatch: json -> text)
    const incompatibleWire = applyOp(
      empty,
      {
        opId: "g-incompatible-wire",
        type: "add_workflow",
        workflow: {
          id: "wf",
          name: "Incompatible Wire",
          nodes: [
            { id: "t", type: "trigger.manual", data: {} },
            { id: "s", type: "sink.text", data: {} },
          ],
          edges: [{ id: "e1", source: "t", target: "s", sourceHandle: "out", targetHandle: "in" }],
        },
      },
      catalog,
      toyRegistry,
    );
    expect(incompatibleWire.ok).toBe(false);
    if (!incompatibleWire.ok) {
      expect(incompatibleWire.errors.map((e) => e.code)).toContain("incompatible_wire");
    }

    // 8i. duplicate_node
    const dupNode = applyOp(
      empty,
      {
        opId: "g-dup-node",
        type: "add_workflow",
        workflow: {
          id: "wf",
          name: "Duplicate Node",
          nodes: [
            { id: "t", type: "trigger.manual", data: {} },
            { id: "p1", type: "transform.pick", data: { path: "a" } },
            { id: "p1", type: "transform.pick", data: { path: "b" } },
          ],
          edges: [{ id: "e1", source: "t", target: "p1", sourceHandle: "out", targetHandle: "in" }],
        },
      },
      catalog,
      toyRegistry,
    );
    expect(dupNode.ok).toBe(false);
    if (!dupNode.ok) expect(dupNode.errors.map((e) => e.code)).toContain("duplicate_node");

    // 8j. self-loop edge and missing source/target node or port via connect_edges
    const wfWithNodes = applyOps(
      empty,
      [
        {
          opId: "s-1",
          type: "add_workflow",
          workflow: { id: "wf-1", name: "WF 1", nodes: [], edges: [] },
        },
        {
          opId: "s-2",
          type: "add_node",
          workflowId: "wf-1",
          node: { id: "t", type: "trigger.manual", data: {} },
        },
        {
          opId: "s-3",
          type: "add_node",
          workflowId: "wf-1",
          node: { id: "p1", type: "transform.pick", data: { path: "a" } },
        },
      ],
      catalog,
      toyRegistry,
    );
    expect(wfWithNodes.ok).toBe(true);
    if (!wfWithNodes.ok) return;

    const selfLoop = applyOp(
      wfWithNodes.state,
      {
        opId: "s-loop",
        type: "connect_edges",
        workflowId: "wf-1",
        edges: [{ id: "e-loop", source: "p1", target: "p1", sourceHandle: "out", targetHandle: "in" }],
      },
      catalog,
      toyRegistry,
    );
    expect(selfLoop.ok).toBe(false);
    if (!selfLoop.ok) expect(selfLoop.errors.map((e) => e.code)).toContain("SELF_LOOP");

    const missingEndpoint = applyOp(
      wfWithNodes.state,
      {
        opId: "s-missing-node",
        type: "connect_edges",
        workflowId: "wf-1",
        edges: [{ id: "e-ghost", source: "t", target: "ghost", sourceHandle: "out", targetHandle: "in" }],
      },
      catalog,
      toyRegistry,
    );
    expect(missingEndpoint.ok).toBe(false);
    if (!missingEndpoint.ok) {
      expect(missingEndpoint.errors.map((e) => e.code)).toContain("MISSING_EDGE_ENDPOINT");
    }

    const unknownPort = applyOp(
      wfWithNodes.state,
      {
        opId: "s-unknown-port",
        type: "connect_edges",
        workflowId: "wf-1",
        edges: [
          {
            id: "e-bad-port",
            source: "t",
            target: "p1",
            sourceHandle: "nonexistent_port",
            targetHandle: "in",
          },
        ],
      },
      catalog,
      toyRegistry,
    );
    expect(unknownPort.ok).toBe(false);
    if (!unknownPort.ok) {
      expect(unknownPort.errors.map((e) => e.code)).toContain("incompatible_wire");
    }
  });

  test("9. rejects raw secret values passed into bind_secret_ref", () => {
    const state = applyExpectOk(createEmptyBlueprint("sec-test"), {
      opId: "sec-init",
      type: "enable_brick",
      brickId: "core-auth",
    }).state;

    const rawSecrets = [
      "sk_" + "live_51Nabc1234567890",
      "whsec_abcdef123456789",
      "ghp" + "_1234567890abcdefghijklmnop",
      "Bearer my-secret-jwt-token",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0",
      "my raw secret with spaces",
      "postgres://user:pass@localhost:5432/db",
    ];

    for (const badRef of rawSecrets) {
      const res = applyOp(
        state,
        {
          opId: `sec-bad-${badRef.slice(0, 6)}`,
          type: "bind_secret_ref",
          ref: badRef,
          targetKind: "brick",
          targetId: "core-auth",
          secretName: "BETTER_AUTH_SECRET",
        },
        catalog,
      );
      expect(res.ok, `Expected "${badRef}" to be rejected`).toBe(false);
      if (!res.ok) {
        expect(res.errors[0]?.code).toBe("INVALID_SECRET_REF");
      }
    }
  });
});

describe("Layout and metadata invariance on semanticHash and assemble() buildHash (AC 6, AC 7)", () => {
  test("set_metadata layout/viewport/displayName changes leave semanticHash and assemble() output byte-for-byte identical", async () => {
    const built = applyOps(
      createEmptyBlueprint("layout-invariance"),
      [
        { opId: "l-1", type: "enable_brick", brickId: "multi-workspace" },
        { opId: "l-2", type: "enable_brick", brickId: "credit-wallet", config: { creditsPerUnit: 5 } },
      ],
      catalog,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const stateBefore = built.state;
    const semHashBefore = semanticHash(stateBefore);
    const assembledBefore = assemble(toAssemblerBlueprint(stateBefore), catalog);
    expect(assembledBefore.ok).toBe(true);
    if (!assembledBefore.ok) return;
    const filesHashBefore = await hashFiles(assembledBefore.files);

    const withLayout = applyExpectOk(stateBefore, {
      opId: "l-3",
      type: "set_metadata",
      metadata: {
        displayName: "Dragged Canvas",
        description: "Updated layout coordinates",
        catalogVersion: "v2-test",
        layout: {
          "multi-workspace": { x: 150, y: 300 },
          "credit-wallet": { x: 480, y: 320 },
        },
        viewport: { x: -50, y: 120, zoom: 0.85 },
      },
    }).state;

    expect(semanticHash(withLayout)).toBe(semHashBefore);

    const assembledAfter = assemble(withLayout, catalog);
    expect(assembledAfter.ok).toBe(true);
    if (!assembledAfter.ok) return;
    const filesHashAfter = await hashFiles(assembledAfter.files);
    expect(filesHashAfter).toEqual(filesHashBefore);
  });
});

describe("computeReadiness whole-project projection (AC 5)", () => {
  test("reports missing capability provider, missing identity brick, unbound brick secrets, and becomes ready when satisfied", () => {
    // 1. Empty project -> NO_BRICKS_ENABLED
    const empty = createEmptyBlueprint("readiness-test");
    const r0 = computeReadiness(empty, catalog);
    expect(r0.ready).toBe(false);
    expect(r0.needs.map((n) => n.code)).toContain("NO_BRICKS_ENABLED");

    // 2. Enable credit-wallet without multi-workspace, and set identity to core-auth without enabling core-auth
    const partial = applyOps(
      empty,
      [
        { opId: "r-1", type: "enable_brick", brickId: "credit-wallet" },
        { opId: "r-2", type: "set_identity", identity: "core-auth" },
      ],
      catalog,
    );
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;

    const r1 = computeReadiness(partial.state, catalog);
    expect(r1.ready).toBe(false);
    expect(r1.needs.map((n) => n.code)).toContain("MISSING_CAPABILITY_PROVIDER");
    expect(r1.needs.map((n) => n.code)).toContain("MISSING_IDENTITY_BRICK");

    // 3. Enable multi-workspace and core-auth -> now needs core-auth's 3 declared secrets
    const withAuth = applyOps(
      partial.state,
      [
        { opId: "r-3", type: "enable_brick", brickId: "multi-workspace" },
        { opId: "r-4", type: "enable_brick", brickId: "core-auth" },
      ],
      catalog,
    );
    expect(withAuth.ok).toBe(true);
    if (!withAuth.ok) return;

    const r2 = computeReadiness(withAuth.state, catalog);
    expect(r2.ready).toBe(false);
    expect(r2.needs.map((n) => n.code)).toEqual([
      "UNBOUND_BRICK_SECRET",
      "UNBOUND_BRICK_SECRET",
      "UNBOUND_BRICK_SECRET",
    ]);

    // 4. Bind the 3 required secrets for core-auth -> ready === true!
    const allBound = applyOps(
      withAuth.state,
      [
        {
          opId: "r-5",
          type: "bind_secret_ref",
          ref: "sec_better_auth",
          targetKind: "brick",
          targetId: "core-auth",
          secretName: "BETTER_AUTH_SECRET",
        },
        {
          opId: "r-6",
          type: "bind_secret_ref",
          ref: "sec_github_id",
          targetKind: "brick",
          targetId: "core-auth",
          secretName: "GITHUB_CLIENT_ID",
        },
        {
          opId: "r-7",
          type: "bind_secret_ref",
          ref: "sec_github_secret",
          targetKind: "brick",
          targetId: "core-auth",
          secretName: "GITHUB_CLIENT_SECRET",
        },
      ],
      catalog,
    );
    expect(allBound.ok).toBe(true);
    if (!allBound.ok) return;

    const r3 = computeReadiness(allBound.state, catalog);
    expect(r3.ready).toBe(true);
    expect(r3.needs).toEqual([]);
  });
});

describe("Purity and targetKey extraction", () => {
  test("applyOp, computeReadiness, and semanticHash read no clock or random source", () => {
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Date.now() called inside pure blueprint package");
    });
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random() called inside pure blueprint package");
    });
    const uuid = vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
      throw new Error("crypto.randomUUID() called inside pure blueprint package");
    });

    try {
      const state = createEmptyBlueprint("pure-check");
      const res = applyOps(
        state,
        [
          { opId: "p-1", type: "enable_brick", brickId: "multi-workspace" },
          { opId: "p-2", type: "enable_brick", brickId: "credit-wallet" },
        ],
        catalog,
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(computeReadiness(res.state, catalog).ready).toBe(true);
        expect(semanticHash(res.state)).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      now.mockRestore();
      random.mockRestore();
      uuid.mockRestore();
    }
  });

  test("targetKey extracts deterministic logical targets for ops", () => {
    expect(targetKey({ opId: "1", type: "enable_brick", brickId: "credit-wallet" })).toEqual([
      "brick:credit-wallet",
    ]);
    expect(targetKey({ opId: "2", type: "set_identity", identity: "core-auth" })).toEqual([
      "identity",
    ]);
    expect(
      targetKey({
        opId: "3",
        type: "add_entity",
        entity: { name: "orders", fields: [{ name: "title", type: "text", required: true, maxLength: 100 }] },
      }),
    ).toEqual(["entity:orders"]);
    expect(
      targetKey({
        opId: "4",
        type: "add_node",
        workflowId: "wf-1",
        node: { id: "node-a", type: "trigger.manual", data: {} },
      }),
    ).toEqual(["workflow:wf-1:node:node-a"]);
    expect(
      targetKey({
        opId: "5",
        type: "set_metadata",
        metadata: { layout: { "node-a": { x: 10, y: 20 } } },
      }),
    ).toEqual(["layout:node-a"]);
    expect(OpSchema.safeParse({ opId: "x", type: "unknown_op" }).success).toBe(false);
  });

  test("toAssemblerBlueprint includes canonical workflows and secretRefs when non-empty and omits them when empty", () => {
    const empty = createEmptyBlueprint("wf-asm");
    const emptyAsm = toAssemblerBlueprint(empty);
    expect(emptyAsm.workflows).toBeUndefined();
    expect(emptyAsm.secretRefs).toBeUndefined();

    const populated = applyOps(
      empty,
      [
        { opId: "w-1", type: "enable_brick", brickId: "multi-workspace" },
        { opId: "w-2", type: "enable_brick", brickId: "credit-wallet" },
        { opId: "w-2b", type: "enable_brick", brickId: "core-auth" },
        {
          opId: "w-3",
          type: "bind_secret_ref",
          ref: "sec_better_auth_secret",
          targetKind: "brick",
          targetId: "core-auth",
          secretName: "BETTER_AUTH_SECRET",
        },
        {
          opId: "w-4",
          type: "add_workflow",
          workflow: {
            id: "wf-main",
            name: "Main Flow",
            nodes: [
              { id: "n1", type: "trigger.manual", data: {} },
              { id: "n2", type: "transform.pick", data: { path: "amount" } },
            ],
            edges: [{ id: "e1", source: "n1", target: "n2", sourceHandle: "out", targetHandle: "in" }],
          },
        },
        {
          opId: "w-5",
          type: "set_metadata",
          metadata: { layout: { n1: { x: 200, y: 100 } } },
        },
      ],
      catalog,
      toyRegistry,
    );
    expect(populated.ok).toBe(true);
    if (!populated.ok) return;

    const asm = toAssemblerBlueprint(populated.state);
    expect(asm.secretRefs).toEqual([
      {
        ref: "sec_better_auth_secret",
        targetKind: "brick",
        targetId: "core-auth",
        secretName: "BETTER_AUTH_SECRET",
      },
    ]);
    expect(asm.workflows).toEqual([
      {
        id: "wf-main",
        name: "Main Flow",
        nodes: [
          { id: "n1", type: "trigger.manual", data: {} },
          { id: "n2", type: "transform.pick", data: { path: "amount" } },
        ],
        edges: [{ id: "e1", source: "n1", target: "n2", sourceHandle: "out", targetHandle: "in" }],
      },
    ]);
  });
});

describe("relations and the date, money and longtext types (story 1.18)", () => {
  const customer = { name: "customer", workspaceScoped: true, fields: [{ name: "label", type: "text" }] };
  const invoice = {
    name: "invoice",
    workspaceScoped: true,
    fields: [
      { name: "customer_id", type: "relation", relation: "customer.id", required: true },
      { name: "due_on", type: "date" },
      { name: "total", type: "money", currencies: ["INR"] },
      { name: "notes", type: "longtext" },
    ],
  };
  const add = (entity: unknown, opId: string): Op => ({ opId, type: "add_entity", entity }) as Op;

  test("toSdkEntity carries the relation target (the entity part of entity.field) and the new types 1:1", () => {
    const res = applyOps(createEmptyBlueprint("rel"), [add(customer, "c"), add(invoice, "i")], catalog, toyRegistry);
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    const sdk = toSdkEntity(res.state.entities.find((e) => e.name === "invoice")!);
    expect(sdk.fields).toEqual([
      { name: "customer_id", type: "relation", required: true, relation: "customer" },
      { name: "due_on", type: "date", required: false },
      { name: "total", type: "money", required: false, currencies: ["INR"] },
      { name: "notes", type: "longtext", required: false, maxLength: 20_000 },
    ]);
  });

  test("blueprint-only types keep their old SDK mapping", () => {
    const legacy = EntityDefinitionSchema.parse({
      name: "legacy",
      fields: [
        { name: "a", type: "string" },
        { name: "b", type: "integer", min: 1 },
        { name: "c", type: "json" },
        { name: "d", type: "datetime" },
      ],
    });
    expect(toSdkEntity(legacy).fields).toEqual([
      { name: "a", type: "text", required: false, maxLength: 500 },
      { name: "b", type: "number", required: false, min: 1 },
      { name: "c", type: "text", required: false, maxLength: 5000 },
      { name: "d", type: "text", required: false, maxLength: 64 },
    ]);
  });

  test("a batch may add an entity before the entity it relates to, or two that relate to each other", () => {
    const a = { name: "a_things", fields: [{ name: "b_id", type: "relation", relation: "b_things" }] };
    const b = { name: "b_things", fields: [{ name: "a_id", type: "relation", relation: "a_things" }] };
    expect(applyOps(createEmptyBlueprint("rel"), [add(invoice, "i"), add(customer, "c")], catalog, toyRegistry).ok).toBe(true);
    expect(applyOps(createEmptyBlueprint("rel"), [add(a, "a"), add(b, "b")], catalog, toyRegistry).ok).toBe(true);
  });

  test("a relation to an entity the project does not declare is refused, naming the field and the entity", () => {
    const single = applyOp(createEmptyBlueprint("rel"), add(invoice, "i"), catalog, toyRegistry);
    expect(single.ok).toBe(false);
    if (!single.ok) expect(single.errors[0]?.message).toMatch(/field "customer_id" relates to entity "customer", which is not declared/);
    const batch = applyOps(createEmptyBlueprint("rel"), [add(invoice, "i")], catalog, toyRegistry);
    expect(batch.ok).toBe(false);
    if (!batch.ok) expect(batch.errors[0]?.message).toMatch(/field "customer_id" relates to entity "customer"/);
  });

  test("a relation field without the relation key is refused", () => {
    const res = applyOp(createEmptyBlueprint("rel"), add({ name: "invoice", fields: [{ name: "customer_id", type: "relation" }] }, "i"), catalog, toyRegistry);
    expect(res.ok).toBe(false);
  });

  test.each(["target", "entity", "to", "references", "targetEntity"])("the wrong key %s gets an actionable pointer to relation", (key) => {
    const res = applyOps(
      createEmptyBlueprint("rel"),
      [add(customer, "c"), add({ name: "invoice", fields: [{ name: "customer_id", type: "text", [key]: "customer" }] }, "i")],
      catalog,
      toyRegistry,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]?.code).toBe("INVALID_ENTITY_SCHEMA");
      expect(res.errors[0]?.message).toMatch(new RegExp(`"${key}" is not a field key: .*"relation" key`));
      expect(res.errors[0]?.suggestedFix).toMatch(/"relation"/);
    }
  });

  test("removing an entity another one relates to is refused; removing both in one batch is fine", () => {
    const res = applyOps(createEmptyBlueprint("rel"), [add(customer, "c"), add(invoice, "i")], catalog, toyRegistry);
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    const removeCustomer = { opId: "rm-c", type: "remove_entity", name: "customer" } as Op;
    expect(applyOp(res.state, removeCustomer, catalog, toyRegistry).ok).toBe(false);
    expect(applyOps(res.state, [removeCustomer], catalog, toyRegistry).ok).toBe(false);
    expect(applyOps(res.state, [removeCustomer, { opId: "rm-i", type: "remove_entity", name: "invoice" } as Op], catalog, toyRegistry).ok).toBe(true);
  });

  test("a money field and a field named after its currency column are refused", () => {
    const res = applyOp(
      createEmptyBlueprint("rel"),
      add({ name: "things", fields: [{ name: "total", type: "money", currencies: ["INR"] }, { name: "total__currency", type: "text" }] }, "t"),
      catalog,
      toyRegistry,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.map((e) => e.message).join(" ")).toMatch(/currency column of money field "total"/);
  });
});

describe("relation follow-ups (story 1.18 review)", () => {
  const add = (entity: unknown, opId: string): Op => ({ opId, type: "add_entity", entity }) as Op;
  const customer = { name: "customer", fields: [{ name: "label", type: "text" }] };
  // A stored blueprint whose relation already dangles (an older one relating to core-auth's users, say).
  const withDangling = (): BlueprintState => ({
    ...createEmptyBlueprint("rel"),
    entities: [EntityDefinitionSchema.parse({ name: "tickets", fields: [{ name: "owner_id", type: "relation", relation: "users.id" }] })],
  });

  test.each(["add_entity", "update_entity"])("%s refuses a relation key on a field that is not of type relation", (type) => {
    const base = applyOps(createEmptyBlueprint("rel"), [add(customer, "c"), add({ name: "invoice", fields: [{ name: "note", type: "text" }] }, "i")], catalog, toyRegistry);
    if (!base.ok) throw new Error(JSON.stringify(base.errors));
    const op = { opId: "x", type, entity: { name: type === "add_entity" ? "bill" : "invoice", fields: [{ name: "customer_id", type: "text", relation: "customer" }] } } as Op;
    const res = applyOps(base.state, [op], catalog, toyRegistry);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]?.code).toBe("INVALID_ENTITY_SCHEMA");
      expect(res.errors[0]?.message).toMatch(/field "customer_id" has type "text" but a "relation" key/);
      expect(res.errors[0]?.suggestedFix).toBe('use type: "relation" with relation: "customer"');
    }
  });

  test("a relation that already dangles in the stored state does not block unrelated entity ops", () => {
    const state = withDangling();
    expect(applyOp(state, add(customer, "c"), catalog, toyRegistry).ok).toBe(true);
    const batch = applyOps(state, [add(customer, "c")], catalog, toyRegistry);
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(applyOps(batch.state, [{ opId: "rm", type: "remove_entity", name: "customer" } as Op], catalog, toyRegistry).ok).toBe(true);
    // a new dangling relation is still refused
    const fresh = applyOps(state, [add({ name: "invoice", fields: [{ name: "x_id", type: "relation", relation: "ghost" }] }, "i")], catalog, toyRegistry);
    expect(fresh.ok).toBe(false);
    if (!fresh.ok) expect(fresh.errors.map((e) => e.message).join(" ")).toMatch(/"ghost"/);
  });

  test("validate's entity issues carry the relation fix for a relation to an undeclared entity", () => {
    const issues = collectBlueprintActionableIssues(withDangling(), { catalog });
    const issue = issues.find((i) => /relates to entity "users"/.test(i.message));
    expect(issue).toBeDefined();
    expect(issue!.suggestedFix).toMatch(/change its "relation" to an entity declared in this project/);
  });
});
