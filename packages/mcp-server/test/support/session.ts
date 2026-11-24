import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { catalog } from "@poc/assembler/catalog";
import { applyMigration } from "@poc/sdk";
import { countTokens } from "../../../../test/support/tokens.ts";
import { createSqliteD1 } from "../../../../bricks/credit-wallet/client/test/support/sqlite-d1.ts";
import migration from "../../migrations/0001_mcp_server.sql?raw";
import { createMcpApp } from "../../src/index.ts";
import { projectOf, testToken, testTokenVerifier } from "./test-verifier.ts";

// Runs a scripted session with the official MCP client against this server, and records every HTTP exchange so the
// conversation can be counted. The script is what a model would do (find out the bricks, enable them, declare the table,
// build); nothing here is a real model.

export interface Step {
  tool: string;
  args: unknown;
}
export interface Exchange {
  httpMethod: string;
  /** The JSON-RPC method, for a POST. */
  rpc?: string;
  /** The tool name, for tools/call. */
  tool?: string;
  status: number;
  requestBody: string;
  responseBody: string;
  requestTokens: number;
  responseTokens: number;
}
export interface SessionResult {
  exchanges: Exchange[];
  /** What each tool call returned: the text a model would read. */
  answers: Array<{ tool: string; args: unknown; text: string; isError: boolean }>;
  tools: unknown[];
  instructions: string;
  /** Files the build stored, by path. */
  stored: Record<string, string>;
  /** What build_project said. */
  summary: Record<string, unknown> | null;
  /** Total of every request and response body, counted with the one tokenizer. */
  rawTokens: number;
  /** What a model reads and writes: the tool definitions, the instructions, each call's name and arguments, and each answer. */
  modelVisibleTokens: number;
  toolCalls: number;
}

export async function runSession(steps: Step[]): Promise<SessionResult> {
  const db = createSqliteD1();
  try {
    await applyMigration(db, migration);
    const app = createMcpApp({ catalog, verifyToken: testTokenVerifier });
    // Story 0.15: a session's token is bound to the one project its steps build.
    const sessionProject =
      steps.map((step) => projectOf({ params: { arguments: step.args } })).find((p) => p !== undefined) ?? "session";
    const TOKEN = testToken(sessionProject);
    const exchanges: Exchange[] = [];

    const recordingFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const requestBody = await request.clone().text();
      const response = await app.fetch(request, { DB: db });
      const responseBody = await response.clone().text();
      let rpc: string | undefined;
      let tool: string | undefined;
      try {
        const parsed = JSON.parse(requestBody) as { method?: string; params?: { name?: string } };
        rpc = parsed.method;
        tool = parsed.method === "tools/call" ? parsed.params?.name : undefined;
      } catch {
        // a GET or DELETE has no body
      }
      exchanges.push({ httpMethod: request.method, rpc, tool, status: response.status, requestBody, responseBody, requestTokens: countTokens(requestBody), responseTokens: countTokens(responseBody) });
      return response;
    };

    const client = new Client({ name: "h9-session", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), { fetch: recordingFetch, requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
    const instructions = client.getInstructions() ?? "";
    const { tools } = await client.listTools();

    const answers: SessionResult["answers"] = [];
    for (const step of steps) {
      const result = await client.callTool({ name: step.tool, arguments: step.args as Record<string, unknown> });
      const text = (result.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");
      answers.push({ tool: step.tool, args: step.args, text, isError: result.isError === true });
    }
    await client.close();

    const rows = (await db.prepare("SELECT path, content FROM mcp_files ORDER BY path").all<{ path: string; content: string }>()).results;
    const built = answers.filter((a) => a.tool === "build_project" && !a.isError).at(-1);
    const rawTokens = exchanges.reduce((sum, e) => sum + e.requestTokens + e.responseTokens, 0);
    const modelVisibleTokens =
      countTokens(JSON.stringify(tools)) +
      countTokens(instructions) +
      answers.reduce((sum, a) => sum + countTokens(JSON.stringify({ name: a.tool, arguments: a.args })) + countTokens(a.text), 0);

    return {
      exchanges,
      answers,
      tools,
      instructions,
      stored: Object.fromEntries(rows.map((r) => [r.path, r.content])),
      summary: built ? (JSON.parse(built.text) as Record<string, unknown>) : null,
      rawTokens,
      modelVisibleTokens,
      toolCalls: exchanges.filter((e) => e.rpc === "tools/call").length,
    };
  } finally {
    db.close();
  }
}

/** The table a model would declare, written the way a model would: only what it has to say, the rest left to defaults. */
export const INVOICES = {
  name: "invoices",
  fields: [
    { name: "client_name", type: "text", required: true },
    { name: "amount", type: "number" },
    { name: "status", type: "enum", values: ["draft", "paid", "overdue"] },
    { name: "pdf_r2_url", type: "text" },
  ],
};

/** The scored session: the whole invoices project (workspaces, wallet, entities), four tool calls: look, enable the bricks, declare the table, build. */
export const FULL_SESSION: Step[] = [
  { tool: "list_bricks", args: {} },
  { tool: "enable_brick", args: { project: "invoice-flow", bricks: ["multi-workspace", "credit-wallet", "dynamic-entities"] } },
  { tool: "define_entity", args: { project: "invoice-flow", entities: [INVOICES] } },
  { tool: "build_project", args: { project: "invoice-flow" } },
];

/** For information, not scored: workspaces and invoices without the wallet, in the same four calls. */
export const SMALL_SESSION: Step[] = [
  { tool: "list_bricks", args: {} },
  { tool: "enable_brick", args: { project: "invoice-lite", bricks: ["multi-workspace", "dynamic-entities"] } },
  { tool: "define_entity", args: { project: "invoice-lite", entities: [INVOICES] } },
  { tool: "build_project", args: { project: "invoice-lite" } },
];

/**
 * The same project as FULL_SESSION built the way the first version of the tools required: one brick per call. Kept so the
 * difference between the two ways of calling is measured rather than remembered. For information, not scored.
 */
export const ONE_AT_A_TIME_SESSION: Step[] = [
  { tool: "list_bricks", args: {} },
  { tool: "enable_brick", args: { project: "invoice-flow", bricks: ["multi-workspace"] } },
  { tool: "enable_brick", args: { project: "invoice-flow", bricks: ["credit-wallet"] } },
  { tool: "enable_brick", args: { project: "invoice-flow", bricks: ["dynamic-entities"] } },
  { tool: "define_entity", args: { project: "invoice-flow", entities: [INVOICES] } },
  { tool: "build_project", args: { project: "invoice-flow" } },
];
