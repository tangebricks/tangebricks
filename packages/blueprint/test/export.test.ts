import { describe, expect, test } from "vitest";
import { catalog } from "@poc/assembler/catalog";
import {
  BlueprintExportError,
  applyOps,
  createEmptyBlueprint,
  exportBlueprintBundle,
  parseBlueprintBundle,
  semanticHash,
  serializeBlueprintBundle,
} from "../src/index.ts";
import type { BlueprintState } from "../src/index.ts";

describe("Story 1.6 — exportBlueprintBundle & parseBlueprintBundle (AC 1, AC 2, AC 4)", () => {
  test("exportBlueprintBundle produces deterministic canonical saas.blueprint.json with schemaVersion 2 and exportedRevision", () => {
    const empty = createEmptyBlueprint("export-canon");
    const applied = applyOps(
      empty,
      [
        { opId: "e-1", type: "enable_brick", brickId: "multi-workspace" },
        { opId: "e-2", type: "enable_brick", brickId: "core-auth" },
        { opId: "e-3", type: "set_identity", identity: "core-auth" },
        {
          opId: "e-4",
          type: "enable_brick",
          brickId: "credit-wallet",
          config: { minOrderAmount: 100, creditsPerUnit: 20 },
        },
        { opId: "e-5", type: "enable_brick", brickId: "dynamic-entities" },
        {
          opId: "e-6",
          type: "add_entity",
          entity: {
            name: "invoices",
            fields: [
              { name: "title", type: "text", required: true, maxLength: 100 },
              { name: "amount_cents", type: "number", required: true, min: 0 },
            ],
          },
        },
        {
          opId: "e-7",
          type: "add_workflow",
          workflow: {
            id: "wf-main",
            name: "Main Flow",
            nodes: [
              { id: "t1", type: "trigger.manual", label: "Trigger", data: {} },
              { id: "n1", type: "transform.pick", label: "Pick Title", data: { path: "title" } },
            ],
            edges: [{ id: "e1", source: "t1", target: "n1", sourceHandle: "out", targetHandle: "in" }],
          },
        },
        {
          opId: "e-8",
          type: "bind_secret_ref",
          ref: "sec_wallet_handle",
          targetKind: "brick",
          targetId: "credit-wallet",
          secretName: "WALLET_SECRET",
        },
        {
          opId: "e-9",
          type: "set_metadata",
          metadata: {
            displayName: "Canonical Export Project",
            layout: { t1: { x: 100, y: 100 }, n1: { x: 320, y: 100 } },
          },
        },
      ],
      catalog,
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const bundle = exportBlueprintBundle(applied.state, { revision: 9 });
    expect(Object.keys(bundle)).toEqual([
      "schemaVersion",
      "project",
      "identity",
      "bricks",
      "entities",
      "workflows",
      "secretRefs",
      "metadata",
      "exportedRevision",
    ]);
    expect(bundle.schemaVersion).toBe(2);
    expect(bundle.project).toBe("export-canon");
    expect(bundle.identity).toBe("core-auth");
    expect(bundle.exportedRevision).toEqual({
      revision: 9,
      semanticHash: semanticHash(applied.state),
    });

    // Round-trip through serializeBlueprintBundle -> parseBlueprintBundle
    const jsonText = serializeBlueprintBundle(applied.state, { revision: 9 });
    const parsed = parseBlueprintBundle(jsonText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.semanticHash).toBe(semanticHash(applied.state));
    expect(parsed.state).toEqual(applied.state);
  });

  test("rejects planted raw secret values in secretRefs, brick settings, or workflow node data", () => {
    const base = createEmptyBlueprint("secret-scan");

    const taintedSecretRef: BlueprintState = {
      ...base,
      bricks: [{ id: "credit-wallet", config: {} }],
      secretRefs: [
        {
          ref: "sk_" + "live_51Nabc1234567890secret",
          targetKind: "brick",
          targetId: "credit-wallet",
          secretName: "STRIPE_KEY",
        },
      ],
    };
    expect(() => exportBlueprintBundle(taintedSecretRef)).toThrow(BlueprintExportError);
    const parsedRef = parseBlueprintBundle(taintedSecretRef);
    expect(parsedRef.ok).toBe(false);
    if (!parsedRef.ok) {
      expect(parsedRef.errors[0]?.code).toBe("INVALID_SECRET_REF");
    }

    const taintedBrickSetting: BlueprintState = {
      ...base,
      bricks: [
        {
          id: "credit-wallet",
          config: { apiKey: "ghp" + "_1234567890abcdefghijklmnopqrstuvwx" },
        },
      ],
    };
    expect(() => exportBlueprintBundle(taintedBrickSetting)).toThrow(BlueprintExportError);
    const parsedBrick = parseBlueprintBundle(taintedBrickSetting);
    expect(parsedBrick.ok).toBe(false);
    if (!parsedBrick.ok) {
      expect(parsedBrick.errors[0]?.code).toBe("INVALID_SECRET_REF");
    }

    const taintedNodeData: BlueprintState = {
      ...base,
      workflows: [
        {
          id: "wf-1",
          name: "Flow",
          nodes: [
            {
              id: "t1",
              type: "trigger.manual",
              data: { authHeader: "Bearer super-secret-raw-token-value" },
            },
          ],
          edges: [],
        },
      ],
    };
    expect(() => exportBlueprintBundle(taintedNodeData)).toThrow(BlueprintExportError);
  });
});
