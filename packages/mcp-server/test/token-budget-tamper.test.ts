import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { catalog } from "@poc/assembler/catalog";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import {
  PER_PAGE_TOKEN_CEILING,
  SESSION_A_MAX_CALLS,
  SESSION_A_MAX_RATIO_PCT,
  SESSION_B_MAX_TOTAL_TOKENS,
  countBudgetTokens,
  formatMcpTokenBudgetSummary,
  runMcpTokenBudgetSuite,
} from "../src/token-budget.ts";
import { TOOLS, type Tool } from "../src/tools.ts";
import mcpMigrationSql from "../migrations/0001_mcp_server.sql?raw";

const db = (env as unknown as { DB: D1Like }).DB;

describe("Story 7.4 — CI Token Budget Enforcement & Negative Tamper Detection (AC 1, AC 2, AC 3, AC 4)", () => {
  beforeEach(async () => {
    await applyMigration(db, mcpMigrationSql);
  });

  it("passes all three hard gates (per-page <= 400, Session A <= 15% in <= 5 calls, Session B <= 8,000 tokens) on the unmodified MCP surface", async () => {
    const report = await runMcpTokenBudgetSuite({
      db,
      catalog,
    });

    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.perPageMaxTokens).toBeLessThanOrEqual(PER_PAGE_TOKEN_CEILING);
    for (const toolName of [
      "search_bricks",
      "search_nodes",
      "list_runs",
      "query_logs",
      "get_blueprint_summary",
    ]) {
      const entry = report.perPageByTool[toolName];
      expect(entry).toBeDefined();
      expect(entry?.passed).toBe(true);
      expect(entry?.maxPageTokens).toBeLessThanOrEqual(PER_PAGE_TOKEN_CEILING);
    }

    expect(report.sessionA.calls).toBeLessThanOrEqual(SESSION_A_MAX_CALLS);
    expect(report.sessionA.ratioPct).toBeLessThanOrEqual(SESSION_A_MAX_RATIO_PCT);
    expect(report.sessionA.passed).toBe(true);

    expect(report.sessionB.totalTokens).toBeLessThanOrEqual(
      SESSION_B_MAX_TOTAL_TOKENS,
    );
    expect(report.sessionB.passed).toBe(true);
  });

  it("fails and names both violations when a bloated tool description (+3,000 tokens) and an unpaged 40-item discovery response are injected (AC 4)", async () => {
    const bloatSuffix = " bloated_schema_doc_token".repeat(1600);
    expect(countBudgetTokens(bloatSuffix)).toBeGreaterThanOrEqual(3000);

    const allFortyBricks = Object.values(catalog.bricks).map((entry) => ({
      id: entry.manifest.id,
      summary:
        entry.manifest.ui?.summary ??
        `Full unpaged description for ${entry.manifest.id} with capabilities ${entry.manifest.provides.join(", ")}`,
      category: entry.manifest.ui?.category ?? "platform",
      maturity: entry.manifest.ui?.maturity ?? "production",
      provides: entry.manifest.provides,
      requires: entry.manifest.requires,
      routes: entry.manifest.routePrefixes,
    }));
    expect(allFortyBricks.length).toBeGreaterThanOrEqual(40);

    const tamperedTools: Tool[] = TOOLS.map((tool) => {
      if (tool.name === "apply_ops") {
        return {
          ...tool,
          description: `${tool.description} ${bloatSuffix}`,
        };
      }
      if (tool.name === "search_bricks") {
        return {
          ...tool,
          async run() {
            return {
              isError: false,
              text: JSON.stringify({
                items: allFortyBricks,
                nextCursor: null,
              }),
            };
          },
        };
      }
      return tool;
    });

    const report = await runMcpTokenBudgetSuite({
      db,
      catalog,
      tools: tamperedTools,
    });

    expect(report.ok).toBe(false);
    expect(report.violations.length).toBeGreaterThanOrEqual(2);

    const defBloatViolation = report.violations.find(
      (v) => v.gate === "tool_definition_bloat" && v.tool === "apply_ops",
    );
    expect(defBloatViolation).toBeDefined();
    expect(defBloatViolation?.measured).toBeGreaterThan(3000);

    const unpagedViolation = report.violations.find(
      (v) => v.gate === "per_page_ceiling" && v.tool === "search_bricks",
    );
    expect(unpagedViolation).toBeDefined();
    expect(unpagedViolation?.measured).toBeGreaterThan(PER_PAGE_TOKEN_CEILING);
    expect(report.perPageByTool["search_bricks"]?.maxItemsOnPage).toBe(
      allFortyBricks.length,
    );
    expect(report.perPageByTool["search_bricks"]?.passed).toBe(false);

    // Also verify Session A and Session B fail under the +3,000 token tool description bloat
    expect(report.sessionA.passed).toBe(false);
    expect(report.sessionA.ratioPct).toBeGreaterThan(SESSION_A_MAX_RATIO_PCT);

    const summaryTable = formatMcpTokenBudgetSummary(report);
    expect(summaryTable).toContain("OFFENDING TOOLS / BUDGET VIOLATIONS");
    expect(summaryTable).toContain("tool_definition_bloat");
    expect(summaryTable).toContain("apply_ops");
    expect(summaryTable).toContain("per_page_ceiling");
    expect(summaryTable).toContain("search_bricks");
  });
});
