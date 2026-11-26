import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_agent_sandbox.sql?raw";
import {
  AgentSandboxService,
  createAgentSandboxRoutes,
} from "../src/index.ts";
import type { AgentEnv } from "../src/middleware.ts";
import { stubWorkspaceContext } from "../../multi-workspace/test/support/stub-workspace-context.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_mcp_alpha";
const WS_BETA = "ws_mcp_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS mcp_tool_invocations").run();
  await db.prepare("DROP TABLE IF EXISTS mcp_agent_sessions").run();
  await db.prepare("DROP TABLE IF EXISTS mcp_tools").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Agent Sandbox & MCP Tool Registry Core Logic", () => {
  it("registers tools and lists them formatted for MCP / LLM consumption", async () => {
    const service = new AgentSandboxService(db);

    const calcTool = await service.registerTool(
      WS_ALPHA,
      "calculator",
      "Performs arithmetic operations",
      {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["add", "subtract", "multiply", "divide"] },
          a: { type: "number" },
          b: { type: "number" },
        },
        required: ["operation", "a", "b"],
      },
      "built_in",
      "calculator"
    );

    expect(calcTool.name).toBe("calculator");
    expect(calcTool.is_enabled).toBe(true);

    const tools = await service.listTools(WS_ALPHA);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("calculator");
    expect(tools[0]?.parameters_schema).toEqual({
      type: "object",
      properties: {
        operation: { type: "string", enum: ["add", "subtract", "multiply", "divide"] },
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["operation", "a", "b"],
    });
  });

  it("validates required schema fields before executing tools", async () => {
    const service = new AgentSandboxService(db);
    await service.registerTool(
      WS_ALPHA,
      "math",
      "Math tool",
      { type: "object", required: ["operation", "a", "b"] },
      "built_in",
      "calculator"
    );

    // Call missing 'b' parameter
    const failRes = await service.callTool(WS_ALPHA, "math", { operation: "add", a: 5 });
    expect(failRes.ok).toBe(false);
    expect(failRes.error).toContain("Missing required argument 'b'");

    // Call with valid parameters
    const okRes = await service.callTool(WS_ALPHA, "math", { operation: "multiply", a: 6, b: 7 });
    expect(okRes.ok).toBe(true);
    expect(okRes.output).toBe(42);
    expect(okRes.durationMs).toBeGreaterThanOrEqual(0);

    // Verify invocation log recorded in D1
    const logs = await service.listInvocations(WS_ALPHA, "math");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.status).toBe("success");
    expect(logs[0]?.output).toBe(42);
  });

  it("maintains stateful agent multi-turn sessions", async () => {
    const service = new AgentSandboxService(db);
    const session = await service.createSession(WS_ALPHA, "SupportBot", { stage: "greeting", turn: 1 });

    expect(session.id).toMatch(/^sess_[a-f0-9]{32}$/);
    expect(session.state).toEqual({ stage: "greeting", turn: 1 });

    // Update state after agent turn
    const updated = await service.updateSessionState(WS_ALPHA, session.id, { stage: "checkout", turn: 2, cartTotal: 150 });
    expect(updated?.state).toEqual({ stage: "checkout", turn: 2, cartTotal: 150 });

    // Another workspace cannot read or change this session by its id (story 0.7: mcp_agent_sessions is no longer a
    // declared global table).
    expect(await service.updateSessionState(WS_BETA, session.id, { stage: "hijacked" })).toBeNull();
    expect((await service.updateSessionState(WS_ALPHA, session.id, {}))?.state).toEqual({ stage: "checkout", turn: 2, cartTotal: 150 });
  });

  it("strictly isolates tool definitions between workspaces", async () => {
    const service = new AgentSandboxService(db);
    await service.registerTool(WS_ALPHA, "custom_secret_tool", "Secret", {});

    const alphaTools = await service.listTools(WS_ALPHA);
    const betaTools = await service.listTools(WS_BETA);

    expect(alphaTools).toHaveLength(1);
    expect(betaTools).toHaveLength(0);

    // Calling alpha tool from beta workspace fails
    const failRes = await service.callTool(WS_BETA, "custom_secret_tool", {});
    expect(failRes.ok).toBe(false);
    expect(failRes.error).toContain("not found in workspace");
  });
});

describe("Agent Sandbox HTTP API", () => {
  it("provides full HTTP workflow for MCP tools, execution, and sessions", async () => {
    const app = new Hono<AgentEnv>();
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createAgentSandboxRoutes());

    // 1. POST /mcp/tools
    const regRes = await app.request("/api/mcp/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({
        name: "text_modifier",
        description: "Modifies text case",
        parametersSchema: {
          type: "object",
          required: ["text", "action"],
        },
        handlerType: "built_in",
        handlerTarget: "string_transform",
      }),
    }, { DB: db });
    expect(regRes.status).toBe(201);

    // 2. GET /mcp/tools
    const listRes = await app.request("/api/mcp/tools", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { tools: Array<{ name: string; inputSchema: unknown }> };
    expect(listJson.tools).toHaveLength(1);
    expect(listJson.tools[0]?.name).toBe("text_modifier");

    // 3. POST /mcp/tools/:name/call
    const callRes = await app.request("/api/mcp/tools/text_modifier/call", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({
        arguments: { text: "hello edge world", action: "upper" },
      }),
    }, { DB: db });
    expect(callRes.status).toBe(200);
    const callJson = (await callRes.json()) as { ok: boolean; output: string };
    expect(callJson.ok).toBe(true);
    expect(callJson.output).toBe("HELLO EDGE WORLD");

    // 4. POST /mcp/sessions
    const sessRes = await app.request("/api/mcp/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({
        agentName: "CodeAssistant",
        initialState: { model: "claude-3-5-sonnet" },
      }),
    }, { DB: db });
    expect(sessRes.status).toBe(201);

    // 5. GET /mcp/invocations
    const invRes = await app.request("/api/mcp/invocations?toolName=text_modifier", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(invRes.status).toBe(200);
    const invJson = (await invRes.json()) as { invocations: unknown[] };
    expect(invJson.invocations).toHaveLength(1);
  });
});

describe("Agent Sandbox HTTP API: the workspace comes from the verified context only", () => {
  const createApp = () => {
    const app = new Hono<AgentEnv>();
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createAgentSandboxRoutes());
    return app;
  };

  it("refuses a request whose workspace is named only in the query string (QUERY_ONLY)", async () => {
    const res = await createApp().request(`/api/mcp/tools?workspaceId=${WS_ALPHA}`, {}, { DB: db });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Missing workspace context");
  });

  it("header A with ?workspaceId=B reads A only (HEADER_A_QUERY_B)", async () => {
    const service = new AgentSandboxService(db);
    await service.registerTool(WS_ALPHA, "alpha_tool", "alpha", {}, "built_in", "echo");
    await service.registerTool(WS_BETA, "beta_tool", "beta", {}, "built_in", "echo");

    const res = await createApp().request(`/api/mcp/tools?workspaceId=${WS_BETA}`, { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(res.status).toBe(200);
    const names = ((await res.json()) as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toEqual(["alpha_tool"]);
  });

  it("header A with body workspaceId B writes to A only; B's rows are untouched (HEADER_A_BODY_B)", async () => {
    const service = new AgentSandboxService(db);
    await service.registerTool(WS_BETA, "beta_tool", "beta", {}, "built_in", "echo");

    const res = await createApp().request(
      "/api/mcp/tools",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
        body: JSON.stringify({ workspaceId: WS_BETA, name: "planted", description: "aimed at beta" }),
      },
      { DB: db },
    );
    expect(res.status).toBe(201);
    expect((await service.listTools(WS_ALPHA)).map((t) => t.name)).toEqual(["planted"]);
    expect((await service.listTools(WS_BETA)).map((t) => t.name)).toEqual(["beta_tool"]);
  });
});

describe("story 0.9: non-built-in tools are not faked", () => {
  it("an http_webhook tool fails NOT_CONFIGURED and its invocation is recorded as an error, not executed", async () => {
    const service = new AgentSandboxService(db);
    await service.registerTool(WS_ALPHA, "ext_tool", "External", {}, "http_webhook", "https://hooks.example.com/x");
    const res = await service.callTool(WS_ALPHA, "ext_tool", { a: 1 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^NOT_CONFIGURED: no handler is configured for http_webhook tool 'ext_tool'/);
    expect(JSON.stringify(res.output)).not.toContain("executed");
    const row = await db
      .prepare("SELECT status FROM mcp_tool_invocations WHERE workspace_id = ? AND tool_name = 'ext_tool'")
      .bind(WS_ALPHA)
      .first<{ status: string }>();
    expect(row?.status).toBe("error");
  });
});
