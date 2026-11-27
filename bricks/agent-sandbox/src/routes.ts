import { Hono } from "hono";
import { z } from "zod";
import { AgentSandboxService, type HandlerType } from "./agent.ts";
import { agentSandboxMiddleware, type AgentEnv } from "./middleware.ts";

const RegisterToolSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(1024),
  parametersSchema: z.record(z.string(), z.unknown()).default({}),
  handlerType: z.enum(["inline_js", "http_webhook", "workflow_call", "built_in"]).default("built_in"),
  handlerTarget: z.string().min(1).max(1024).default("echo"),
});

const CallToolSchema = z.object({
  arguments: z.record(z.string(), z.unknown()).default({}),
  sessionId: z.string().optional(),
});

const CreateSessionSchema = z.object({
  agentName: z.string().min(1).max(64),
  initialState: z.record(z.string(), z.unknown()).optional(),
});

export function createAgentSandboxRoutes(): Hono<AgentEnv> {
  const app = new Hono<AgentEnv>();

  app.use("*", agentSandboxMiddleware);

  // GET /mcp/tools - list MCP tools for workspace
  app.get("/mcp/tools", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const service = c.get("agentSandbox") || new AgentSandboxService(c.env.DB);
    const tools = await service.listTools(workspaceId);

    // Format into standard MCP tools array
    const mcpFormatted = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters_schema,
    }));

    return c.json({ tools: mcpFormatted }, 200);
  });

  // POST /mcp/tools - register a tool
  app.post("/mcp/tools", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = RegisterToolSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("agentSandbox") || new AgentSandboxService(c.env.DB);
    const tool = await service.registerTool(
      workspaceId,
      parsed.data.name,
      parsed.data.description,
      parsed.data.parametersSchema,
      parsed.data.handlerType as HandlerType,
      parsed.data.handlerTarget,
    );

    return c.json({ tool }, 201);
  });

  // POST /mcp/tools/:name/call - execute a tool
  app.post("/mcp/tools/:name/call", async (c) => {
    const toolName = c.req.param("name");
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CallToolSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("agentSandbox") || new AgentSandboxService(c.env.DB);
    const result = await service.callTool(workspaceId, toolName, parsed.data.arguments, parsed.data.sessionId);

    if (!result.ok) {
      return c.json({ error: result.error, durationMs: result.durationMs }, 400);
    }

    return c.json(result, 200);
  });

  // POST /mcp/sessions - create agent session
  app.post("/mcp/sessions", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateSessionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("agentSandbox") || new AgentSandboxService(c.env.DB);
    const session = await service.createSession(workspaceId, parsed.data.agentName, parsed.data.initialState);

    return c.json({ session }, 201);
  });

  // GET /mcp/invocations - query invocation logs
  app.get("/mcp/invocations", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;
    const toolName = c.req.query("toolName");

    const service = c.get("agentSandbox") || new AgentSandboxService(c.env.DB);
    const logs = await service.listInvocations(workspaceId, toolName || undefined);

    return c.json({ invocations: logs }, 200);
  });

  return app;
}
