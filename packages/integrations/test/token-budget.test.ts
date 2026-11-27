import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { catalog } from "@poc/assembler/catalog";
import { createMcpApp, createStaticTokenVerifier } from "@poc/mcp-server";
import { countBudgetTokens, runMcpTokenBudgetSuite } from "../../mcp-server/src/token-budget.ts";
import mcpMigrationSql from "../../mcp-server/migrations/0001_mcp_server.sql?raw";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { measureIntegrationTokenMetrics } from "../src/index.ts";

// Story 7.4: Session A's denominator, measured by the global setup (test/support/h9-emitted-source.ts).
const H9_EMITTED_SOURCE_TOKENS = (
  Object.values(import.meta.glob("../../../out/h9-emitted-source.json", { eager: true, import: "default" }))[0] as { tokens: number }
).tokens;

const MCP_TOKEN = "pack-v1-budget-token-0123456789";

describe("Story 10.4 — Curated Integration Pack v1 Token Budget Compliance (AC 5)", () => {
  const db = env.DB as unknown as D1Like;
  // Story 0.15: a token bound to one project; these calls read the catalog only, so any project will do.
  const app = createMcpApp({
    catalog,
    callsPerMinute: 10_000,
    verifyToken: createStaticTokenVerifier([{ token: MCP_TOKEN, userId: "user:pack-v1", projectId: "pack-v1-budget", scopes: ["read"] }]),
  });

  beforeAll(async () => {
    await applyMigration(db, mcpMigrationSql);
  });

  async function callMcpTool(name: string, args: Record<string, unknown>) {
    const res = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${MCP_TOKEN}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
      { DB: db },
    );
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: Array<{ type: string; text: string }> };
    };
    const text = body.result?.content?.[0]?.text ?? "";
    return {
      isError: Boolean(body.result?.isError),
      text,
      tokens: countBudgetTokens(text),
      json: () => JSON.parse(text),
    };
  }

  it("keeps per-app compact summary <= 600 tokens, every search_nodes page <= 400 tokens, and every get_node operation detail <= 250 tokens across all 5 apps (>= 50 operations)", async () => {
    const integrations = catalog.integrations ?? {};
    const appNames = Object.keys(integrations).sort();
    expect(appNames).toEqual(["discord", "github", "google", "slack", "stripe"]);

    let totalOperations = 0;

    for (const appName of appNames) {
      const entry = integrations[appName]!;
      totalOperations += entry.manifest.operations.length;

      // 1. Per-app compact summary <= 600 tokens
      const metrics = measureIntegrationTokenMetrics(entry.manifest);
      expect(metrics.compactSummaryTokens, `${appName} compact summary (${metrics.compactSummaryTokens} tokens) must be <= 600`).toBeLessThanOrEqual(600);
      expect(metrics.maxSearchPageTokens, `${appName} search page (${metrics.maxSearchPageTokens} tokens) must be <= 400`).toBeLessThanOrEqual(400);
      expect(
        metrics.maxOperationDetailTokens,
        `${appName} max operation detail (${metrics.maxOperationDetailTokens} tokens) must be <= 250`,
      ).toBeLessThanOrEqual(250);

      // 2. Every get_node call via MCP server <= 250 tokens
      for (const op of entry.manifest.operations) {
        const nodeType = `int:${appName}.${op.operationId}`;
        const detail = await callMcpTool("get_node", { type: nodeType });
        expect(detail.isError, `get_node(${nodeType}) should succeed`).toBe(false);
        expect(detail.tokens, `get_node(${nodeType}) used ${detail.tokens} tokens (limit <= 250)`).toBeLessThanOrEqual(250);
      }

      // 3. Paged search_nodes filtered by app <= 400 tokens
      let cursor: string | undefined;
      do {
        const page = await callMcpTool("search_nodes", {
          source: "integration",
          app: appName,
          ...(cursor ? { cursor } : {}),
        });
        expect(page.isError).toBe(false);
        expect(page.tokens, `search_nodes(app=${appName}) page used ${page.tokens} tokens (limit <= 400)`).toBeLessThanOrEqual(400);
        const parsed = page.json() as { nextCursor?: string | null };
        cursor = parsed.nextCursor ?? undefined;
      } while (cursor);
    }

    expect(totalOperations).toBeGreaterThanOrEqual(50);

    // 4. Walk every page of search_nodes(source="integration") across all apps combined
    let allIntCursor: string | undefined;
    let totalIntItemsSeen = 0;
    do {
      const page = await callMcpTool("search_nodes", {
        source: "integration",
        ...(allIntCursor ? { cursor: allIntCursor } : {}),
      });
      expect(page.isError).toBe(false);
      expect(page.tokens).toBeLessThanOrEqual(400);
      const parsed = page.json() as { items: unknown[]; nextCursor?: string | null };
      totalIntItemsSeen += parsed.items.length;
      allIntCursor = parsed.nextCursor ?? undefined;
    } while (allIntCursor);

    expect(totalIntItemsSeen).toBe(totalOperations);
  });

  it("keeps full MCP token budget suite (Session A <= 15% H9 ratio, Session B <= 8,000 tokens, per-page <= 400 tokens) passing with all 5 apps in catalog", async () => {
    const report = await runMcpTokenBudgetSuite({
      db,
      catalog,
      sessionAEmittedTokens: H9_EMITTED_SOURCE_TOKENS,
    });
    expect(report.ok, JSON.stringify(report.violations, null, 2)).toBe(true);
    expect(report.perPageMaxTokens).toBeLessThanOrEqual(400);
    expect(report.sessionA.passed).toBe(true);
    expect(report.sessionB.passed).toBe(true);
  });
});
