import { encode } from "gpt-tokenizer/encoding/o200k_base";
import type { Catalog } from "@poc/assembler";
import type { D1Like } from "@poc/sdk";
import { createStaticTokenVerifier } from "./auth.ts";
import { createMcpApp } from "./mcp.ts";
import { createInMemoryBlueprintClient } from "./store.ts";
import type { InMemoryClientSources } from "./store.ts";

/**
 * Fixed proposal ids and clock for a measured session (H9, the token budget): the proposal answer then has the same
 * text, and so the same token count, on every run. Harness only; Studio and the standalone server keep random ids and
 * the wall clock.
 */
export function deterministicMeasurementSources(prefix = "prop_measured"): InMemoryClientSources {
  let n = 0;
  return {
    newProposalId: () => `${prefix}_${String((n += 1)).padStart(4, "0")}`,
    nowIso: () => "2026-01-01T00:00:00.000Z",
  };
}
import { TOOLS, toolDescriptions } from "./tools.ts";
import type { Tool } from "./tools.ts";

/** Exact H9 tokenizer preserved per Owner Decision D9. */
export const BUDGET_TOKENIZER = "gpt-tokenizer 4.1.0, o200k_base";

export function countBudgetTokens(text: string): number {
  return encode(text).length;
}

export const PER_PAGE_TOKEN_CEILING = 400;
export const SESSION_A_MAX_CALLS = 5;
export const SESSION_A_MAX_RATIO_PCT = 15.0;
export const SESSION_B_MAX_TOTAL_TOKENS = 8000;
export const SINGLE_TOOL_DEF_TOKEN_CEILING = 500;

export const TEN_SCALE_BRICKS = [
  "multi-workspace",
  "credit-wallet",
  "dynamic-entities",
  "core-auth",
  "audit-trail",
  "feature-flags",
  "checkout-gateway",
  "binary-assets",
  "public-api-keys",
  "rbac-policy",
] as const;

export const H9_INVOICES_ENTITY = {
  name: "invoices",
  fields: [
    { name: "client_name", type: "text", required: true },
    { name: "amount", type: "number" },
    { name: "status", type: "enum", values: ["draft", "paid", "overdue"] },
    { name: "pdf_r2_url", type: "text" },
  ],
};

export interface PerPageToolSummary {
  tool: string;
  pagesChecked: number;
  maxPageTokens: number;
  maxItemsOnPage: number;
  ceiling: number;
  passed: boolean;
}

export interface TokenBudgetViolation {
  gate: "tool_definition_bloat" | "per_page_ceiling" | "session_a_calls" | "session_a_ratio" | "session_b_total";
  tool: string;
  measured: number;
  limit: number;
  message: string;
}

export interface McpTokenBudgetReport {
  suite: "mcp-token-budget";
  story: "story-ci-token-budget-enforcement";
  tokenizer: string;
  ok: boolean;
  toolsListTokens: number;
  perToolDefTokens: Record<string, number>;
  perPageMaxTokens: number;
  perPageCeiling: number;
  perPageByTool: Record<string, PerPageToolSummary>;
  sessionA: {
    calls: number;
    maxCalls: number;
    tokens: number;
    emittedTokens: number;
    ratioPct: number;
    maxRatioPct: number;
    passed: boolean;
  };
  sessionB: {
    calls: number;
    toolDefTokens: number;
    ioTokens: number;
    totalTokens: number;
    maxTotalTokens: number;
    passed: boolean;
    byCall: Array<{
      tool: string;
      requestTokens: number;
      responseTokens: number;
      totalTokens: number;
    }>;
  };
  violations: TokenBudgetViolation[];
}

export interface McpTokenBudgetOptions {
  db: D1Like;
  catalog: Catalog;
  tools?: ReadonlyArray<Tool>;
  /** Exact firstPartySource denominator computed from disk in Node CLI (`test/support/tokens.ts`). */
  /**
   * The first-party source tokens of the H9 3-brick project (the Session A denominator). Required: it is measured, never
   * a stored number (test/support/h9-emitted-source.ts; workerd tests read it from out/h9-emitted-source.json).
   */
  sessionAEmittedTokens: number;
  perPageCeiling?: number;
  sessionAMaxCalls?: number;
  sessionAMaxRatioPct?: number;
  sessionBMaxTotalTokens?: number;
  maxSingleToolDefTokens?: number;
}

// Story 0.15: tokens are bound to one project each, so the budget harness holds one per project it measures.
const BUDGET_SESSION_PROJECT = "invoice-flow";
const BUDGET_SCALE_PROJECT = "scale-10b-20n";
const BUDGET_MCP_TOKENS: Readonly<Record<string, string>> = {
  [BUDGET_SESSION_PROJECT]: "budget-token-0123456789abcdef",
  [BUDGET_SCALE_PROJECT]: "budget-token-scale-0123456789abcdef",
};
const BUDGET_MCP_TOKEN = BUDGET_MCP_TOKENS[BUDGET_SESSION_PROJECT]!;
const budgetTokenVerifier = createStaticTokenVerifier(
  Object.entries(BUDGET_MCP_TOKENS).map(([projectId, token]) => ({
    token,
    userId: "user:mcp-budget",
    projectId,
    scopes: ["read", "edit"],
    tokenId: `mcp-budget:${projectId}`,
    clientName: "mcp-budget",
  })),
);
const budgetTokenFor = (params?: Record<string, unknown>): string => {
  const args = params?.arguments;
  const project = typeof args === "object" && args !== null ? (args as { project?: unknown }).project : undefined;
  return (typeof project === "string" ? BUDGET_MCP_TOKENS[project] : undefined) ?? BUDGET_MCP_TOKEN;
};

function round(n: number, places = 1): number {
  return Math.round(n * 10 ** places) / 10 ** places;
}

function buildTwentyNodeWorkflow(workflowId: string) {
  const nodes: Array<{
    id: string;
    type: string;
    label: string;
    data: Record<string, unknown>;
  }> = [
    {
      id: "t_1",
      type: "core.webhook",
      label: "Inbound Webhook",
      data: { method: "post" },
    },
  ];
  const edges: Array<{
    id: string;
    source: string;
    target: string;
    sourceHandle: string;
    targetHandle: string;
  }> = [];

  for (let i = 1; i <= 19; i += 1) {
    const nodeId = `n_${String(i).padStart(2, "0")}`;
    const prevId = i === 1 ? "t_1" : `n_${String(i - 1).padStart(2, "0")}`;
    nodes.push({
      id: nodeId,
      type: "core.noop",
      label: `Step ${i}`,
      data: {},
    });
    edges.push({
      id: `e_${i}`,
      source: prevId,
      target: nodeId,
      sourceHandle: "out",
      targetHandle: "in",
    });
  }

  return {
    id: workflowId,
    name: "Scale 20-Node Pipeline",
    trigger: { kind: "webhook", path: "/webhooks/scale" },
    nodes,
    edges,
  };
}

export async function runMcpTokenBudgetSuite(options: McpTokenBudgetOptions): Promise<McpTokenBudgetReport> {
  const {
    db,
    catalog,
    tools = TOOLS,
    sessionAEmittedTokens,
    perPageCeiling = PER_PAGE_TOKEN_CEILING,
    sessionAMaxCalls = SESSION_A_MAX_CALLS,
    sessionAMaxRatioPct = SESSION_A_MAX_RATIO_PCT,
    sessionBMaxTotalTokens = SESSION_B_MAX_TOTAL_TOKENS,
    maxSingleToolDefTokens = SINGLE_TOOL_DEF_TOKEN_CEILING,
  } = options;

  // AD-V8: an agent's apply_ops is a proposal; the harness keeps the blueprint client so it can accept each one as the
  // Studio reviewer would. The review is not an MCP call and adds no tokens to the sessions.
  const blueprintClient = createInMemoryBlueprintClient(catalog, undefined, deterministicMeasurementSources());
  const app = createMcpApp({
    catalog,
    tools,
    blueprintClient,
    callsPerMinute: 10_000,
    verifyToken: budgetTokenVerifier,
    // Standalone runs record an explicit, verified workspace (story 1.4); the budget harness names its own.
    standaloneWorkspaceId: "ws_budget",
  });

  const violations: TokenBudgetViolation[] = [];
  let rpcId = 1;

  const sendRpc = async (method: string, params?: Record<string, unknown>) => {
    const requestBody = JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method,
      ...(params !== undefined ? { params } : {}),
    });
    const res = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${budgetTokenFor(params)}`,
        },
        body: requestBody,
      }),
      { DB: db },
    );
    const responseBody = await res.text();
    const parsed = responseBody
      ? (JSON.parse(responseBody) as {
          result?: {
            tools?: unknown[];
            isError?: boolean;
            content?: Array<{ type: string; text: string }>;
          };
          error?: { code: number; message: string };
        })
      : {};
    const toolText = parsed.result?.content?.[0]?.text ?? "";
    if (method === "tools/call" && params?.name === "apply_ops" && !parsed.error && !parsed.result?.isError) {
      const answer = JSON.parse(toolText) as { project?: string; proposalId?: string; status?: string };
      if (answer.status === "pending" && answer.proposalId && answer.project) {
        const accepted = await blueprintClient.acceptProposal!({
          project: answer.project,
          proposalId: answer.proposalId,
          reviewer: { type: "human", id: "budget:studio-reviewer" },
        });
        if (!accepted.ok) throw new Error(`the reviewer could not accept ${answer.proposalId}: ${accepted.error.message}`);
      }
    }
    return {
      requestBody,
      responseBody,
      requestTokens: countBudgetTokens(requestBody),
      responseTokens: countBudgetTokens(responseBody),
      toolText,
      toolTextTokens: countBudgetTokens(toolText),
      isError: Boolean(parsed.error || parsed.result?.isError),
      parsed,
    };
  };

  // 1. Measure tools/list & individual tool definitions
  const descriptions = toolDescriptions(tools);
  const toolsListTokens = countBudgetTokens(JSON.stringify(descriptions));
  const perToolDefTokens: Record<string, number> = {};
  for (const desc of descriptions) {
    const defTokens = countBudgetTokens(JSON.stringify(desc));
    perToolDefTokens[desc.name] = defTokens;
    if (defTokens > maxSingleToolDefTokens) {
      violations.push({
        gate: "tool_definition_bloat",
        tool: desc.name,
        measured: defTokens,
        limit: maxSingleToolDefTokens,
        message: `Tool "${desc.name}" definition uses ${defTokens} tokens (exceeds single-tool ceiling of ${maxSingleToolDefTokens} tokens; check description/inputSchema bloat).`,
      });
    }
  }

  // 2. Gate 2: Session A (3-brick H9 reference session: <= 5 calls, <= 15.0% of emitted source tokens)
  const sessionAExchanges: Array<{
    requestTokens: number;
    responseTokens: number;
    tool?: string;
  }> = [];

  // Handshake (initialize + notifications/initialized + tools/list)
  const initExchange = await sendRpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "h9-session", version: "1.0.0" },
  });
  sessionAExchanges.push({
    requestTokens: initExchange.requestTokens,
    responseTokens: initExchange.responseTokens,
  });

  const notifBody = JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  const notifRes = await app.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${BUDGET_MCP_TOKEN}`,
      },
      body: notifBody,
    }),
    { DB: db },
  );
  const notifResText = await notifRes.text();
  sessionAExchanges.push({
    requestTokens: countBudgetTokens(notifBody),
    responseTokens: countBudgetTokens(notifResText),
  });

  const listToolsExchange = await sendRpc("tools/list", {});
  sessionAExchanges.push({
    requestTokens: listToolsExchange.requestTokens,
    responseTokens: listToolsExchange.responseTokens,
  });

  const sessionASteps: Array<{ tool: string; args: Record<string, unknown> }> = [
    { tool: "list_bricks", args: {} },
    // AD-V8: the bricks (one of them a money brick) are proposed; the harness accepts the proposal as the reviewer.
    {
      tool: "apply_ops",
      args: {
        project: "invoice-flow",
        ops: ["multi-workspace", "credit-wallet", "dynamic-entities"].map((brickId) => ({
          opId: `enable-${brickId}`,
          type: "enable_brick",
          brickId,
        })),
      },
    },
    {
      tool: "define_entity",
      args: {
        project: "invoice-flow",
        entities: [H9_INVOICES_ENTITY],
      },
    },
    {
      tool: "build_project",
      args: {
        project: "invoice-flow",
      },
    },
  ];

  for (const step of sessionASteps) {
    const ex = await sendRpc("tools/call", {
      name: step.tool,
      arguments: step.args,
    });
    sessionAExchanges.push({
      requestTokens: ex.requestTokens,
      responseTokens: ex.responseTokens,
      tool: step.tool,
    });
  }

  const sessionACalls = sessionASteps.length;
  const sessionATokens = sessionAExchanges.reduce((sum, e) => sum + e.requestTokens + e.responseTokens, 0);
  const sessionARatioPct = round((sessionATokens / sessionAEmittedTokens) * 100, 1);
  const sessionAPassed = sessionACalls <= sessionAMaxCalls && sessionARatioPct <= sessionAMaxRatioPct;

  if (sessionACalls > sessionAMaxCalls) {
    violations.push({
      gate: "session_a_calls",
      tool: "sessionA",
      measured: sessionACalls,
      limit: sessionAMaxCalls,
      message: `Session A used ${sessionACalls} tool calls (limit: <= ${sessionAMaxCalls}).`,
    });
  }
  if (sessionARatioPct > sessionAMaxRatioPct) {
    const largestDef = Object.entries(perToolDefTokens).sort((a, b) => b[1] - a[1])[0];
    violations.push({
      gate: "session_a_ratio",
      tool: largestDef?.[0] ?? "tools/list",
      measured: sessionARatioPct,
      limit: sessionAMaxRatioPct,
      message: `Session A H9 token ratio is ${sessionARatioPct}% (${sessionATokens} / ${sessionAEmittedTokens} tokens), exceeding the ${sessionAMaxRatioPct}% limit (largest tool definition: ${largestDef?.[0] ?? "unknown"} at ${largestDef?.[1] ?? 0} tokens).`,
    });
  }

  // 3. Gate 3: Session B (10-brick + 20-node scale session: totalTokens <= 8,000)
  const scaleProject = BUDGET_SCALE_PROJECT;
  const twentyNodeWf = buildTwentyNodeWorkflow("wf_scale_20");
  const sessionBSteps: Array<{ tool: string; args: Record<string, unknown> }> = [
    { tool: "search_bricks", args: { query: "workspace" } },
    { tool: "search_nodes", args: { role: "action" } },
    {
      tool: "apply_ops",
      args: {
        project: scaleProject,
        ops: [
          ...TEN_SCALE_BRICKS.map((brickId, idx) => ({
            opId: `op-enable-${idx + 1}`,
            type: "enable_brick",
            brickId,
          })),
          {
            opId: "op-entity-invoices",
            type: "add_entity",
            entity: H9_INVOICES_ENTITY,
          },
          {
            opId: "op-wf-20",
            type: "add_workflow",
            workflow: twentyNodeWf,
          },
        ],
      },
    },
    { tool: "get_blueprint_summary", args: { project: scaleProject } },
    {
      tool: "get_blueprint_slice",
      args: { project: scaleProject, workflowId: "wf_scale_20" },
    },
    { tool: "validate_blueprint", args: { project: scaleProject } },
    {
      tool: "test_workflow",
      args: {
        project: scaleProject,
        workflowId: "wf_scale_20",
        input: { orderId: "ord_1" },
      },
    },
  ];

  const sessionBByCall: McpTokenBudgetReport["sessionB"]["byCall"] = [];
  for (const step of sessionBSteps) {
    const ex = await sendRpc("tools/call", {
      name: step.tool,
      arguments: step.args,
    });
    const reqTok = countBudgetTokens(JSON.stringify({ name: step.tool, arguments: step.args }));
    const resTok = ex.toolTextTokens;
    sessionBByCall.push({
      tool: step.tool,
      requestTokens: reqTok,
      responseTokens: resTok,
      totalTokens: reqTok + resTok,
    });
  }

  const sessionBIoTokens = sessionBByCall.reduce((sum, c) => sum + c.totalTokens, 0);
  const sessionBTotalTokens = toolsListTokens + sessionBIoTokens;
  const sessionBPassed = sessionBTotalTokens <= sessionBMaxTotalTokens;

  if (!sessionBPassed) {
    const biggestCall = [...sessionBByCall].sort((a, b) => b.totalTokens - a.totalTokens)[0];
    const largestDef = Object.entries(perToolDefTokens).sort((a, b) => b[1] - a[1])[0];
    const culprit = (largestDef?.[1] ?? 0) > (biggestCall?.totalTokens ?? 0) ? (largestDef?.[0] ?? "tools/list") : (biggestCall?.tool ?? "apply_ops");
    violations.push({
      gate: "session_b_total",
      tool: culprit,
      measured: sessionBTotalTokens,
      limit: sessionBMaxTotalTokens,
      message: `Session B (10-brick + 20-node) total tokens is ${sessionBTotalTokens} (toolDefTokens=${toolsListTokens} + ioTokens=${sessionBIoTokens}), exceeding the ${sessionBMaxTotalTokens} token limit (top contributor: "${culprit}").`,
    });
  }

  // Seed additional runs for scaleProject so list_runs and query_logs have >= 10 items on their default page
  for (let i = 2; i <= 10; i += 1) {
    await sendRpc("tools/call", {
      name: "test_workflow",
      arguments: {
        project: scaleProject,
        workflowId: "wf_scale_20",
        input: { orderId: `ord_${i}` },
      },
    });
  }

  // 4. Gate 1: Per-page ceiling (<= 400 tokens) across search_bricks, search_nodes, list_runs, query_logs, and get_blueprint_summary
  const perPageByTool: Record<string, PerPageToolSummary> = {};

  const checkPagedTool = async (toolName: "search_bricks" | "search_nodes" | "list_runs" | "query_logs", baseArgs: Record<string, unknown>, maxPages = 20) => {
    let cursor: string | undefined;
    let pagesChecked = 0;
    let maxPageTokens = 0;
    let maxItemsOnPage = 0;

    do {
      const ex = await sendRpc("tools/call", {
        name: toolName,
        arguments: {
          ...baseArgs,
          ...(cursor ? { cursor } : {}),
        },
      });
      pagesChecked += 1;
      const pageTokens = ex.toolTextTokens;
      if (pageTokens > maxPageTokens) maxPageTokens = pageTokens;

      let nextCursor: string | null = null;
      let itemsLen = 0;
      try {
        const body = JSON.parse(ex.toolText) as {
          items?: unknown[];
          nextCursor?: string | null;
        };
        itemsLen = Array.isArray(body.items) ? body.items.length : 0;
        nextCursor = typeof body.nextCursor === "string" && body.nextCursor.length > 0 ? body.nextCursor : null;
      } catch {
        nextCursor = null;
      }
      if (itemsLen > maxItemsOnPage) maxItemsOnPage = itemsLen;

      if (pageTokens > perPageCeiling || itemsLen > 10) {
        violations.push({
          gate: "per_page_ceiling",
          tool: toolName,
          measured: pageTokens,
          limit: perPageCeiling,
          message: `Tool "${toolName}" page ${pagesChecked} returned ${pageTokens} tokens and ${itemsLen} items (ceiling: <= ${perPageCeiling} tokens, <= 10 items per page).`,
        });
      }

      cursor = nextCursor ?? undefined;
    } while (cursor && pagesChecked < maxPages);

    perPageByTool[toolName] = {
      tool: toolName,
      pagesChecked,
      maxPageTokens,
      maxItemsOnPage,
      ceiling: perPageCeiling,
      passed: maxPageTokens <= perPageCeiling && maxItemsOnPage <= 10,
    };
  };

  await checkPagedTool("search_bricks", {});
  await checkPagedTool("search_nodes", {});
  await checkPagedTool("list_runs", { project: scaleProject }, 1);
  await checkPagedTool("query_logs", { project: scaleProject }, 1);

  // Check get_blueprint_summary on the 10-brick + 20-node project
  {
    const sumEx = await sendRpc("tools/call", {
      name: "get_blueprint_summary",
      arguments: { project: scaleProject },
    });
    const sumTokens = sumEx.toolTextTokens;
    if (sumTokens > perPageCeiling) {
      violations.push({
        gate: "per_page_ceiling",
        tool: "get_blueprint_summary",
        measured: sumTokens,
        limit: perPageCeiling,
        message: `Tool "get_blueprint_summary" returned ${sumTokens} tokens (ceiling: <= ${perPageCeiling} tokens).`,
      });
    }
    perPageByTool["get_blueprint_summary"] = {
      tool: "get_blueprint_summary",
      pagesChecked: 1,
      maxPageTokens: sumTokens,
      maxItemsOnPage: 1,
      ceiling: perPageCeiling,
      passed: sumTokens <= perPageCeiling,
    };
  }

  const perPageMaxTokens = Math.max(0, ...Object.values(perPageByTool).map((s) => s.maxPageTokens));

  return {
    suite: "mcp-token-budget",
    story: "story-ci-token-budget-enforcement",
    tokenizer: BUDGET_TOKENIZER,
    ok: violations.length === 0,
    toolsListTokens,
    perToolDefTokens,
    perPageMaxTokens,
    perPageCeiling,
    perPageByTool,
    sessionA: {
      calls: sessionACalls,
      maxCalls: sessionAMaxCalls,
      tokens: sessionATokens,
      emittedTokens: sessionAEmittedTokens,
      ratioPct: sessionARatioPct,
      maxRatioPct: sessionAMaxRatioPct,
      passed: sessionAPassed,
    },
    sessionB: {
      calls: sessionBSteps.length,
      toolDefTokens: toolsListTokens,
      ioTokens: sessionBIoTokens,
      totalTokens: sessionBTotalTokens,
      maxTotalTokens: sessionBMaxTotalTokens,
      passed: sessionBPassed,
      byCall: sessionBByCall,
    },
    violations,
  };
}

export function formatMcpTokenBudgetSummary(report: McpTokenBudgetReport): string {
  const lines: string[] = [
    `[mcp:budget] Tokenizer: ${report.tokenizer}`,
    `[mcp:budget] tools/list tokens: ${report.toolsListTokens}`,
    `[mcp:budget] Per-page ceiling: max ${report.perPageMaxTokens} / ${report.perPageCeiling} tokens`,
  ];
  for (const s of Object.values(report.perPageByTool)) {
    lines.push(
      `  [${s.passed ? "PASS" : "FAIL"}] ${s.tool.padEnd(22)} pages=${s.pagesChecked} maxTokens=${s.maxPageTokens}/${s.ceiling} maxItems=${s.maxItemsOnPage}`,
    );
  }
  lines.push(
    `[mcp:budget] Session A (3-brick H9): calls=${report.sessionA.calls}/${report.sessionA.maxCalls} tokens=${report.sessionA.tokens}/${report.sessionA.emittedTokens} ratio=${report.sessionA.ratioPct}% (limit <= ${report.sessionA.maxRatioPct}%) [${report.sessionA.passed ? "PASS" : "FAIL"}]`,
  );
  lines.push(
    `[mcp:budget] Session B (10-brick + 20-node): calls=${report.sessionB.calls} toolDefTokens=${report.sessionB.toolDefTokens} ioTokens=${report.sessionB.ioTokens} totalTokens=${report.sessionB.totalTokens}/${report.sessionB.maxTotalTokens} [${report.sessionB.passed ? "PASS" : "FAIL"}]`,
  );

  if (report.violations.length > 0) {
    lines.push(`[mcp:budget] OFFENDING TOOLS / BUDGET VIOLATIONS (${report.violations.length}):`);
    lines.push(`  ${"GATE".padEnd(24)} | ${"TOOL".padEnd(22)} | ${"MEASURED".padEnd(10)} | ${"LIMIT".padEnd(10)} | MESSAGE`);
    lines.push(`  ${"-".repeat(100)}`);
    for (const v of report.violations) {
      lines.push(`  ${v.gate.padEnd(24)} | ${v.tool.padEnd(22)} | ${String(v.measured).padEnd(10)} | ${String(v.limit).padEnd(10)} | ${v.message}`);
    }
  }
  return lines.join("\n");
}
