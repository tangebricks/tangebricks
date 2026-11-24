-- Scripting Sandbox Migration
-- Schema prefix: scr_

CREATE TABLE IF NOT EXISTS scr_scripts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  trigger_event TEXT NOT NULL,
  source_code TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  timeout_ms INTEGER NOT NULL DEFAULT 2000,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scr_scripts_ws ON scr_scripts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_scr_scripts_event ON scr_scripts(workspace_id, trigger_event);

CREATE TABLE IF NOT EXISTS scr_executions (
  id TEXT PRIMARY KEY,
  script_id TEXT NOT NULL REFERENCES scr_scripts(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  trigger_event TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('success', 'error', 'timeout')),
  duration_ms INTEGER NOT NULL DEFAULT 0,
  input_payload_json TEXT NOT NULL,
  output_payload_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scr_exec_script ON scr_executions(script_id);
CREATE INDEX IF NOT EXISTS idx_scr_exec_ws ON scr_executions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_scr_exec_created ON scr_executions(created_at);
