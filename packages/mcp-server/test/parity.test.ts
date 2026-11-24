import { describe, expect, it } from "vitest";
import { OP_TYPES } from "@poc/blueprint";
import {
  DESTRUCTIVE_OP_KINDS,
  MONEY_AFFECTING_BRICKS,
  OP_SAFETY_METADATA,
  TOOLS,
} from "../src/index.ts";
import {
  extractStudioApiRoutes,
  verifyMcpParity,
} from "../../../scripts/mcp-parity.ts";

describe("Story 7.1 — MCP Dual-Surface Parity Gate (AC 2, AC 4, AC 6)", () => {
  it("passes full parity across all Blueprint Op kinds, studio-api routes, and MCP tools (AC 4)", () => {
    const result = verifyMcpParity();
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.opCount).toBe(OP_TYPES.length);
    expect(result.mcpToolCount).toBe(16);
    expect(result.studioRouteCount).toBeGreaterThanOrEqual(30);
    expect(result.orphanOps).toEqual([]);
    expect(result.orphanStudioRoutes).toEqual([]);
    expect(result.orphanMcpTools).toEqual([]);
    expect(result.missingAnnotationTools).toEqual([]);
  });

  it("carries accurate MCP tool annotations on every tool and explicit safety metadata for destructive/money-affecting Op kinds (AC 2)", () => {
    for (const tool of TOOLS) {
      expect(tool.annotations).toEqual({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
      });
      expect(tool.annotations.readOnlyHint).toBe(tool.readOnly);
    }

    const applyOps = TOOLS.find((t) => t.name === "apply_ops")!;
    const deployApply = TOOLS.find((t) => t.name === "deploy_apply")!;
    expect(applyOps.annotations.destructiveHint).toBe(true);
    expect(deployApply.annotations.destructiveHint).toBe(true);

    for (const destructiveOp of DESTRUCTIVE_OP_KINDS) {
      expect(OP_SAFETY_METADATA[destructiveOp]?.destructiveHint).toBe(true);
    }
    expect(MONEY_AFFECTING_BRICKS).toContain("credit-wallet");
    expect(OP_SAFETY_METADATA.enable_brick.moneyAffectingHint).toBe(true);
    expect(OP_SAFETY_METADATA.configure_brick.moneyAffectingHint).toBe(true);
    expect(OP_SAFETY_METADATA.remove_brick.moneyAffectingHint).toBe(true);
  });

  it("fails parity (exits 1) and names the orphan capability when a synthetic UI-only mutation route is registered (AC 6)", () => {
    const baseRoutes = extractStudioApiRoutes();
    const orphanRoute = {
      method: "POST",
      path: "/api/projects/:project/ui-only-shadow-mutation",
    };

    const result = verifyMcpParity({
      studioRoutes: [...baseRoutes, orphanRoute],
    });

    expect(result.ok).toBe(false);
    expect(result.orphanStudioRoutes).toContain(
      "POST /api/projects/:project/ui-only-shadow-mutation",
    );
    expect(result.errors.join("\n")).toContain(
      'Orphan UI route "POST /api/projects/:project/ui-only-shadow-mutation"',
    );
  });

  it("fails parity (exits 1) and names the orphan Op kind when an unmapped Op kind is added to Blueprint (AC 6)", () => {
    const result = verifyMcpParity({
      opTypes: [...OP_TYPES, "orphan_drop_all_tables_op"],
    });

    expect(result.ok).toBe(false);
    expect(result.orphanOps).toContain("orphan_drop_all_tables_op");
    expect(result.errors.join("\n")).toContain(
      'Orphan Op kind "orphan_drop_all_tables_op"',
    );
  });

  it("fails parity (exits 1) and names the orphan MCP tool when an MCP-only mutation has no shared Op or studio-api command (AC 4, AC 6)", () => {
    const baseTools = TOOLS.map((t) => ({
      name: t.name,
      readOnly: t.readOnly,
      annotations: t.annotations,
    }));

    const result = verifyMcpParity({
      tools: [
        ...baseTools,
        {
          name: "mcp_only_unmapped_mutation",
          readOnly: false,
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
          },
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.orphanMcpTools).toContain("mcp_only_unmapped_mutation");
    expect(result.errors.join("\n")).toContain(
      'Orphan MCP tool "mcp_only_unmapped_mutation"',
    );
  });
});
