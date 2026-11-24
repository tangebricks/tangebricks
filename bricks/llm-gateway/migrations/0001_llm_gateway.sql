-- llm-gateway 0001: Prompt templates, generation sessions, and token telemetry.
-- Hardened: template bounded to 64KB, cost and tokens checked non-negative.
-- Prefixed with ai_ to prevent collisions.

CREATE TABLE IF NOT EXISTS ai_prompt_templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  template_text TEXT NOT NULL CHECK (length(template_text) <= 65536),
  default_model TEXT NOT NULL CHECK (length(default_model) <= 64),
  temperature REAL NOT NULL DEFAULT 0.7 CHECK (temperature BETWEEN 0.0 AND 2.0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ai_prompt_workspace_idx ON ai_prompt_templates(workspace_id);

CREATE TABLE IF NOT EXISTS ai_generation_logs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (length(provider) <= 64),
  model TEXT NOT NULL CHECK (length(model) <= 64),
  prompt_tokens INTEGER NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens INTEGER NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  cost_credits INTEGER NOT NULL DEFAULT 0 CHECK (cost_credits >= 0),
  latency_ms INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ai_logs_workspace_idx ON ai_generation_logs(workspace_id);
