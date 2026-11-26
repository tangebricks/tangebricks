import { scoped, type D1Like } from "@poc/sdk";

export type HandlerType = "inline_js" | "http_webhook" | "workflow_call" | "built_in";

export interface McpTool {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  parameters_schema: Record<string, unknown>;
  handler_type: HandlerType;
  handler_target: string;
  is_enabled: boolean;
  created_at: string;
}

export interface AgentSession {
  id: string;
  workspace_id: string;
  agent_name: string;
  state: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ToolInvocation {
  id: string;
  session_id: string | null;
  workspace_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  status: "success" | "error" | "timeout";
  output: unknown;
  duration_ms: number;
  created_at: string;
}

interface RawToolRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  parameters_schema_json: string;
  handler_type: HandlerType;
  handler_target: string;
  is_enabled: number;
  created_at: string;
}

interface RawSessionRow {
  id: string;
  workspace_id: string;
  agent_name: string;
  state_json: string;
  created_at: string;
  updated_at: string;
}

interface RawInvocationRow {
  id: string;
  session_id: string | null;
  workspace_id: string;
  tool_name: string;
  arguments_json: string;
  status: "success" | "error" | "timeout";
  output_json: string | null;
  duration_ms: number;
  created_at: string;
}

export class AgentSandboxService {
  constructor(private readonly db: D1Like) {}

  /**
   * Registers a new tool in the workspace tool registry.
   */
  async registerTool(
    workspaceId: string,
    nameRaw: string,
    description: string,
    parametersSchema: Record<string, unknown>,
    handlerType: HandlerType = "built_in",
    handlerTarget = "echo"
  ): Promise<McpTool> {
    const id = `tool_${crypto.randomUUID().replace(/-/g, "")}`;
    const name = nameRaw.trim().toLowerCase();
    const now = new Date().toISOString();

    const existing = await scoped(this.db, workspaceId).first<{ id: string }>(
      "mcp_tools",
      "name = ?",
      [name]
    );

    if (existing) {
      await scoped(this.db, workspaceId).update(
        "mcp_tools",
        {
          description: description.trim().slice(0, 1024),
          parameters_schema_json: JSON.stringify(parametersSchema),
          handler_type: handlerType,
          handler_target: handlerTarget.slice(0, 1024),
          is_enabled: 1,
        },
        "name = ?",
        [name]
      );
    } else {
      await scoped(this.db, workspaceId).insert("mcp_tools", {
        id,
        name,
        description: description.trim().slice(0, 1024),
        parameters_schema_json: JSON.stringify(parametersSchema),
        handler_type: handlerType,
        handler_target: handlerTarget.slice(0, 1024),
        is_enabled: 1,
        created_at: now,
      });
    }

    const toolId = existing?.id || id;

    return {
      id: toolId,
      workspace_id: workspaceId,
      name,
      description: description.trim().slice(0, 1024),
      parameters_schema: parametersSchema,
      handler_type: handlerType,
      handler_target: handlerTarget,
      is_enabled: true,
      created_at: now,
    };
  }

  /**
   * Retrieves a tool by name in a workspace.
   */
  async getTool(workspaceId: string, nameRaw: string): Promise<McpTool | null> {
    const name = nameRaw.trim().toLowerCase();
    const row = await scoped(this.db, workspaceId).first<RawToolRow>(
      "mcp_tools",
      "name = ?",
      [name]
    );

    if (!row) return null;

    return {
      ...row,
      parameters_schema: JSON.parse(row.parameters_schema_json || "{}"),
      is_enabled: row.is_enabled === 1,
    };
  }

  /**
   * Lists all enabled MCP tools in the workspace formatted for LLMs.
   */
  async listTools(workspaceId: string): Promise<McpTool[]> {
    const rows = await scoped(this.db, workspaceId).select<RawToolRow>(
      "mcp_tools",
      "is_enabled = 1",
      [],
      { orderBy: "name ASC" }
    );

    return rows.map((r) => ({
      ...r,
      parameters_schema: JSON.parse(r.parameters_schema_json || "{}"),
      is_enabled: true,
    }));
  }

  /**
   * Executes a built-in sandboxed handler safely.
   */
  private executeBuiltin(target: string, args: Record<string, unknown>): unknown {
    switch (target) {
      case "echo":
        return args;
      case "calculator": {
        const op = String(args.operation || "add").toLowerCase();
        const a = Number(args.a ?? 0);
        const b = Number(args.b ?? 0);
        if (op === "add") return a + b;
        if (op === "subtract") return a - b;
        if (op === "multiply") return a * b;
        if (op === "divide") {
          if (b === 0) throw new Error("Division by zero");
          return a / b;
        }
        throw new Error(`Unsupported operation '${op}'`);
      }
      case "now":
        return { iso: new Date().toISOString(), timestamp: Date.now() };
      case "string_transform": {
        const str = String(args.text || "");
        const transform = String(args.action || "upper").toLowerCase();
        if (transform === "upper") return str.toUpperCase();
        if (transform === "lower") return str.toLowerCase();
        if (transform === "reverse") return str.split("").reverse().join("");
        return str;
      }
      default:
        throw new Error(`Unknown built-in tool target '${target}'`);
    }
  }

  /**
   * Validates arguments against the parameters schema and executes the tool.
   */
  async callTool(
    workspaceId: string,
    toolNameRaw: string,
    args: Record<string, unknown>,
    sessionId?: string
  ): Promise<{ ok: boolean; output?: unknown; error?: string; durationMs: number }> {
    const startTime = Date.now();
    const tool = await this.getTool(workspaceId, toolNameRaw);

    if (!tool) {
      return { ok: false, error: `Tool '${toolNameRaw}' not found in workspace`, durationMs: 0 };
    }

    if (!tool.is_enabled) {
      return { ok: false, error: `Tool '${toolNameRaw}' is disabled`, durationMs: 0 };
    }

    // Schema Validation: Check required fields if defined
    const schema = tool.parameters_schema as { required?: string[] };
    if (Array.isArray(schema?.required)) {
      for (const reqField of schema.required) {
        if (args[reqField] === undefined || args[reqField] === null) {
          return {
            ok: false,
            error: `Missing required argument '${reqField}' for tool '${tool.name}'`,
            durationMs: 0,
          };
        }
      }
    }

    const invocationId = `invk_${crypto.randomUUID().replace(/-/g, "")}`;
    let status: "success" | "error" = "success";
    let output: unknown = null;
    let error: string | undefined = undefined;

    try {
      if (tool.handler_type === "built_in") {
        output = this.executeBuiltin(tool.handler_target, args);
      } else {
        // px-stub: inline_js, http_webhook and workflow_call tools have no runner (NOT_CONFIGURED); there is no isolate sandbox
        // Story 0.9: there is no runner for non-built-in tools. Fail NOT_CONFIGURED; never record a run that did not happen.
        throw new Error(
          `NOT_CONFIGURED: no handler is configured for ${tool.handler_type} tool '${tool.name}'; the tool was not run.`,
        );
      }
    } catch (err: unknown) {
      status = "error";
      error = err instanceof Error ? err.message : String(err);
      output = { error };
    }

    const durationMs = Date.now() - startTime;
    const now = new Date().toISOString();

    await scoped(this.db, workspaceId).insert("mcp_tool_invocations", {
      id: invocationId,
      session_id: sessionId || null,
      tool_name: tool.name,
      arguments_json: JSON.stringify(args),
      status,
      output_json: JSON.stringify(output),
      duration_ms: durationMs,
      created_at: now,
    });

    return {
      ok: status === "success",
      output,
      error,
      durationMs,
    };
  }

  /**
   * Initializes or updates an agent multi-turn session.
   */
  async createSession(
    workspaceId: string,
    agentName: string,
    initialState: Record<string, unknown> = {}
  ): Promise<AgentSession> {
    const id = `sess_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();

    await this.db.prepare(`
      INSERT INTO mcp_agent_sessions (id, workspace_id, agent_name, state_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id, workspaceId, agentName.trim(), JSON.stringify(initialState), now, now).run();

    return {
      id,
      workspace_id: workspaceId,
      agent_name: agentName.trim(),
      state: initialState,
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * Updates state variables for a session, in the given workspace only: another workspace's session id is "not
   * found" (null) and is left unchanged.
   */
  async updateSessionState(
    workspaceId: string,
    sessionId: string,
    stateUpdates: Record<string, unknown>
  ): Promise<AgentSession | null> {
    const row = await this.db.prepare(`
      SELECT id, workspace_id, agent_name, state_json, created_at, updated_at
      FROM mcp_agent_sessions WHERE id = ? AND workspace_id = ?
    `).bind(sessionId, workspaceId).first<RawSessionRow>();

    if (!row) return null;

    const current = JSON.parse(row.state_json || "{}");
    const merged = { ...current, ...stateUpdates };
    const now = new Date().toISOString();

    await this.db.prepare(`
      UPDATE mcp_agent_sessions
      SET state_json = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?
    `).bind(JSON.stringify(merged), now, sessionId, workspaceId).run();

    return {
      ...row,
      state: merged,
      updated_at: now,
    };
  }

  /**
   * Lists invocation history logs.
   */
  async listInvocations(workspaceId: string, toolName?: string): Promise<ToolInvocation[]> {
    const rows = await scoped(this.db, workspaceId).select<RawInvocationRow>(
      "mcp_tool_invocations",
      toolName ? "tool_name = ?" : undefined,
      toolName ? [toolName.trim().toLowerCase()] : [],
      { orderBy: "created_at DESC", limit: 50 }
    );

    return rows.map((r) => ({
      ...r,
      arguments: JSON.parse(r.arguments_json || "{}"),
      output: r.output_json ? JSON.parse(r.output_json) : null,
    }));
  }
}
