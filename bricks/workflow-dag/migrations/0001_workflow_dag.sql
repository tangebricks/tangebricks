-- workflow-dag 0001: Workflow DAG definitions, runs, and step executions.
-- Hardened: graph_json capped at 512KB, input_json at 128KB, durations non-negative.
-- Prefixed with wf_ to prevent collisions.

CREATE TABLE IF NOT EXISTS wf_definitions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}' CHECK (length(graph_json) <= 524288),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS wf_definitions_workspace_idx ON wf_definitions(workspace_id);

CREATE TABLE IF NOT EXISTS wf_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'canceled')),
  trigger_type TEXT NOT NULL CHECK (length(trigger_type) <= 64),
  input_json TEXT NOT NULL DEFAULT '{}' CHECK (length(input_json) <= 131072),
  output_json TEXT CHECK (output_json IS NULL OR length(output_json) <= 524288),
  error_text TEXT CHECK (error_text IS NULL OR length(error_text) <= 4096),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workflow_id) REFERENCES wf_definitions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS wf_runs_workflow_idx ON wf_runs(workflow_id);
CREATE INDEX IF NOT EXISTS wf_runs_workspace_idx ON wf_runs(workspace_id);

CREATE TABLE IF NOT EXISTS wf_step_logs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL CHECK (length(node_id) <= 64),
  node_type TEXT NOT NULL CHECK (length(node_type) <= 64),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
  input_json TEXT CHECK (input_json IS NULL OR length(input_json) <= 65536),
  output_json TEXT CHECK (output_json IS NULL OR length(output_json) <= 65536),
  error_text TEXT CHECK (error_text IS NULL OR length(error_text) <= 4096),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  FOREIGN KEY (run_id) REFERENCES wf_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS wf_step_logs_run_idx ON wf_step_logs(run_id);
