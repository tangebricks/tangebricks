-- agent-sandbox 0001: MCP tool registry, agent sessions, and invocation logs
-- Modular: No cross-brick foreign key on workspace_id.
-- Prefixed with mcp_ to avoid schema collision.

CREATE TABLE IF NOT EXISTS mcp_tools (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  description TEXT NOT NULL CHECK (length(description) <= 1024),
  parameters_schema_json TEXT NOT NULL CHECK (length(parameters_schema_json) <= 4096),
  handler_type TEXT NOT NULL CHECK (handler_type IN ('inline_js', 'http_webhook', 'workflow_call', 'built_in')),
  handler_target TEXT NOT NULL CHECK (length(handler_target) <= 1024),
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, name)
);

CREATE INDEX IF NOT EXISTS mcp_tools_ws_name_idx ON mcp_tools(workspace_id, name);

CREATE TABLE IF NOT EXISTS mcp_agent_sessions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  agent_name TEXT NOT NULL CHECK (length(agent_name) <= 64),
  state_json TEXT NOT NULL DEFAULT '{}' CHECK (length(state_json) <= 8192),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS mcp_sessions_ws_idx ON mcp_agent_sessions(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mcp_tool_invocations (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  session_id TEXT REFERENCES mcp_agent_sessions(id) ON DELETE SET NULL,
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  tool_name TEXT NOT NULL CHECK (length(tool_name) <= 64),
  arguments_json TEXT NOT NULL CHECK (length(arguments_json) <= 8192),
  status TEXT NOT NULL CHECK (status IN ('success', 'error', 'timeout')),
  output_json TEXT CHECK (output_json IS NULL OR length(output_json) <= 16384),
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS mcp_invocations_ws_tool_idx ON mcp_tool_invocations(workspace_id, tool_name, created_at DESC);
