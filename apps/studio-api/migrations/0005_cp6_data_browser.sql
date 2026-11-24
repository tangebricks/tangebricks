-- Studio control-plane CP6 Workspace-Scoped Data Browser Audit Log schema for Cloudflare D1 (SQLite)

CREATE TABLE IF NOT EXISTS data_browser_audit_log (
  audit_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  env_name TEXT NOT NULL CHECK (env_name IN ('preview', 'production')),
  workspace_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('insert', 'update', 'delete')),
  actor TEXT NOT NULL,
  before_snapshot TEXT,
  after_snapshot TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS data_browser_audit_log_project_env_idx
  ON data_browser_audit_log(project_id, env_name, workspace_id, created_at DESC);
