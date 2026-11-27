import { describe, expect, test } from "vitest";
import { catalog } from "@poc/assembler/catalog";
import { applyOps, computeSemanticDiff, createEmptyBlueprint, semanticHash } from "../src/index.ts";
import type { BlueprintState } from "../src/index.ts";

describe("Story 1.5 — computeSemanticDiff (AC 1, AC 4)", () => {
  test("returns isEmpty: true for identical states or states differing only in metadata.layout / viewport", () => {
    const base = createEmptyBlueprint("diff-layout-test");
    const step1 = applyOps(
      base,
      [
        { opId: "op-1", type: "enable_brick", brickId: "multi-workspace" },
        {
          opId: "op-2",
          type: "add_workflow",
          workflow: {
            id: "wf-main",
            name: "Main Flow",
            nodes: [
              { id: "t1", type: "trigger.manual", data: {} },
              { id: "n1", type: "transform.pick", data: { path: "user" } },
            ],
            edges: [{ id: "e1", source: "t1", target: "n1", sourceHandle: "out", targetHandle: "in" }],
          },
        },
      ],
      catalog,
    );
    expect(step1.ok).toBe(true);
    if (!step1.ok) return;

    const layoutOnly = applyOps(
      step1.state,
      [
        {
          opId: "op-3",
          type: "set_metadata",
          metadata: {
            displayName: "Updated Display Name",
            layout: {
              t1: { x: 120, y: 80 },
              n1: { x: 420, y: 200 },
            },
            viewport: { x: 10, y: 20, zoom: 1.5 },
          },
        },
      ],
      catalog,
    );
    expect(layoutOnly.ok).toBe(true);
    if (!layoutOnly.ok) return;

    const diff = computeSemanticDiff(step1.state, layoutOnly.state);
    expect(diff.isEmpty).toBe(true);
    expect(diff).toEqual({
      identity: null,
      bricks: { added: [], removed: [], updated: [] },
      entities: { added: [], removed: [], updated: [] },
      workflows: { added: [], removed: [], updated: [] },
      secretRefs: { added: [], removed: [], updated: [] },
      isEmpty: true,
    });
    expect(semanticHash(step1.state)).toBe(semanticHash(layoutOnly.state));
  });

  test("reports exact added, removed, and updated identity, bricks, entity fields, workflow nodes/edges, and secretRefs", () => {
    const initial = createEmptyBlueprint("diff-full-test");
    const revA = applyOps(
      initial,
      [
        { opId: "a-1", type: "enable_brick", brickId: "multi-workspace" },
        {
          opId: "a-2",
          type: "enable_brick",
          brickId: "credit-wallet",
          config: { creditsPerUnit: 10, minOrderAmount: 100 },
        },
        { opId: "a-3", type: "enable_brick", brickId: "document-parsing" },
        { opId: "a-4", type: "enable_brick", brickId: "dynamic-entities" },
        {
          opId: "a-5",
          type: "add_entity",
          entity: {
            name: "customers",
            fields: [
              { name: "email", type: "text", required: true, maxLength: 120 },
              { name: "legacy_code", type: "text", required: false, maxLength: 40 },
            ],
          },
        },
        {
          opId: "a-6",
          type: "add_entity",
          entity: {
            name: "temp_logs",
            fields: [{ name: "msg", type: "text", required: true }],
          },
        },
        {
          opId: "a-7",
          type: "add_workflow",
          workflow: {
            id: "wf-billing",
            name: "Billing Flow",
            nodes: [
              { id: "t1", type: "trigger.manual", label: "Start", data: {} },
              { id: "n1", type: "transform.pick", label: "Pick Customer", data: { path: "customer" } },
              { id: "n2", type: "transform.pick", label: "Pick Old", data: { path: "old" } },
            ],
            edges: [
              { id: "e1", source: "t1", target: "n1", sourceHandle: "out", targetHandle: "in" },
              { id: "e2", source: "n1", target: "n2", sourceHandle: "out", targetHandle: "in" },
            ],
          },
        },
        {
          opId: "a-8",
          type: "add_workflow",
          workflow: {
            id: "wf-obsolete",
            name: "Obsolete Flow",
            nodes: [{ id: "t", type: "trigger.manual", data: {} }],
            edges: [],
          },
        },
        {
          opId: "a-9",
          type: "bind_secret_ref",
          ref: "sec_wallet_v1",
          targetKind: "brick",
          targetId: "credit-wallet",
          secretName: "WALLET_SECRET",
        },
        {
          opId: "a-10",
          type: "bind_secret_ref",
          ref: "sec_old_conn",
          targetKind: "connection",
          targetId: "legacy-conn",
          secretName: "API_TOKEN",
        },
      ],
      catalog,
    );
    expect(revA.ok).toBe(true);
    if (!revA.ok) return;

    const revB = applyOps(
      revA.state,
      [
        // Identity change: stub -> core-auth
        { opId: "b-1", type: "enable_brick", brickId: "core-auth" },
        { opId: "b-2", type: "set_identity", identity: "core-auth" },
        // Brick removed: document-parsing, Brick updated: credit-wallet
        { opId: "b-3", type: "remove_brick", brickId: "document-parsing" },
        {
          opId: "b-4",
          type: "configure_brick",
          brickId: "credit-wallet",
          config: { creditsPerUnit: 50, minOrderAmount: 100 },
          replace: true,
        },
        // Entity removed: temp_logs, Entity added: invoices, Entity updated: customers (field updated, field removed, field added)
        { opId: "b-5", type: "remove_entity", name: "temp_logs" },
        {
          opId: "b-6",
          type: "add_entity",
          entity: {
            name: "invoices",
            fields: [{ name: "total_cents", type: "number", required: true, min: 0 }],
          },
        },
        {
          opId: "b-7",
          type: "update_entity",
          entity: {
            name: "customers",
            fields: [
              { name: "email", type: "text", required: true, maxLength: 255 },
              { name: "tier", type: "enum", required: true, values: ["free", "pro"] },
            ],
          },
        },
        // Workflow removed: wf-obsolete, Workflow added: wf-audit, Workflow updated: wf-billing
        { opId: "b-8", type: "remove_workflow", workflowId: "wf-obsolete" },
        {
          opId: "b-9",
          type: "add_workflow",
          workflow: {
            id: "wf-audit",
            name: "Audit Flow",
            nodes: [{ id: "t-audit", type: "trigger.manual", data: {} }],
            edges: [],
          },
        },
        {
          opId: "b-10",
          type: "remove_node",
          workflowId: "wf-billing",
          nodeId: "n2",
        },
        {
          opId: "b-11",
          type: "update_node",
          workflowId: "wf-billing",
          nodeId: "n1",
          patch: { label: "Pick Updated Customer", data: { path: "account.customer" } },
        },
        {
          opId: "b-12",
          type: "add_node",
          workflowId: "wf-billing",
          node: { id: "n3", type: "transform.pick", label: "Pick Tier", data: { path: "tier" } },
        },
        {
          opId: "b-13",
          type: "connect_edges",
          workflowId: "wf-billing",
          edges: [{ id: "e3", source: "n1", target: "n3", sourceHandle: "out", targetHandle: "in" }],
        },
        // SecretRefs: update WALLET_SECRET, remove sec_old_conn, add sec_auth_key
        {
          opId: "b-14",
          type: "bind_secret_ref",
          ref: "sec_wallet_v2",
          targetKind: "brick",
          targetId: "credit-wallet",
          secretName: "WALLET_SECRET",
        },
        {
          opId: "b-15",
          type: "unbind_secret_ref",
          targetKind: "connection",
          targetId: "legacy-conn",
          secretName: "API_TOKEN",
        },
        {
          opId: "b-16",
          type: "bind_secret_ref",
          ref: "sec_auth_key",
          targetKind: "brick",
          targetId: "core-auth",
          secretName: "BETTER_AUTH_SECRET",
        },
      ],
      catalog,
    );
    expect(revB.ok).toBe(true);
    if (!revB.ok) return;

    const diff = computeSemanticDiff(revA.state, revB.state);
    expect(diff.isEmpty).toBe(false);

    // 1. Identity
    expect(diff.identity).toEqual({ from: "stub", to: "core-auth" });

    // 2. Bricks
    expect(diff.bricks.added.map((b) => b.id)).toEqual(["core-auth"]);
    expect(diff.bricks.removed.map((b) => b.id)).toEqual(["document-parsing"]);
    expect(diff.bricks.updated).toEqual([
      {
        id: "credit-wallet",
        before: { id: "credit-wallet", config: { creditsPerUnit: 10, minOrderAmount: 100 } },
        after: { id: "credit-wallet", config: { creditsPerUnit: 50, minOrderAmount: 100 } },
      },
    ]);

    // 3. Entities
    expect(diff.entities.added.map((e) => e.name)).toEqual(["invoices"]);
    expect(diff.entities.removed.map((e) => e.name)).toEqual(["temp_logs"]);
    expect(diff.entities.updated).toHaveLength(1);
    expect(diff.entities.updated[0]?.name).toBe("customers");
    expect(diff.entities.updated[0]?.fieldsAdded.map((f) => f.name)).toEqual(["tier"]);
    expect(diff.entities.updated[0]?.fieldsRemoved.map((f) => f.name)).toEqual(["legacy_code"]);
    expect(diff.entities.updated[0]?.fieldsUpdated.map((f) => f.name)).toEqual(["email"]);

    // 4. Workflows
    expect(diff.workflows.added.map((w) => w.id)).toEqual(["wf-audit"]);
    expect(diff.workflows.removed.map((w) => w.id)).toEqual(["wf-obsolete"]);
    expect(diff.workflows.updated).toHaveLength(1);
    const wfDiff = diff.workflows.updated[0]!;
    expect(wfDiff.id).toBe("wf-billing");
    expect(wfDiff.nodesAdded.map((n) => n.id)).toEqual(["n3"]);
    expect(wfDiff.nodesRemoved.map((n) => n.id)).toEqual(["n2"]);
    expect(wfDiff.nodesUpdated.map((n) => n.id)).toEqual(["n1"]);
    expect(wfDiff.edgesAdded.map((e) => e.id)).toEqual(["e3"]);
    expect(wfDiff.edgesRemoved.map((e) => e.id)).toEqual(["e2"]);

    // 5. SecretRefs
    expect(diff.secretRefs.added.map((s) => s.ref)).toEqual(["sec_auth_key"]);
    expect(diff.secretRefs.removed.map((s) => s.ref)).toEqual(["sec_old_conn"]);
    expect(diff.secretRefs.updated).toEqual([
      {
        ref: "sec_wallet_v2",
        before: {
          ref: "sec_wallet_v1",
          targetKind: "brick",
          targetId: "credit-wallet",
          secretName: "WALLET_SECRET",
        },
        after: {
          ref: "sec_wallet_v2",
          targetKind: "brick",
          targetId: "credit-wallet",
          secretName: "WALLET_SECRET",
        },
      },
    ]);
  });

  test("is deterministic regardless of input array ordering", () => {
    const s1 = createEmptyBlueprint("perm-test");
    const s2: BlueprintState = {
      ...s1,
      bricks: [
        { id: "multi-workspace", config: {} },
        { id: "credit-wallet", config: { minOrderAmount: 100, creditsPerUnit: 10 } },
      ],
    };
    const s2Permuted: BlueprintState = {
      ...s1,
      bricks: [
        { id: "credit-wallet", config: { creditsPerUnit: 10, minOrderAmount: 100 } },
        { id: "multi-workspace", config: {} },
      ],
    };

    expect(computeSemanticDiff(s2, s2Permuted).isEmpty).toBe(true);
    expect(computeSemanticDiff(s1, s2)).toEqual(computeSemanticDiff(s1, s2Permuted));
  });
});
