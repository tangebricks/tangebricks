-- tabular-engine 0001: Tabular import jobs, field mappings, and data grid views
-- Modular: No cross-brick foreign key on workspace_id.
-- Prefixed with tab_ to avoid schema collision.

CREATE TABLE IF NOT EXISTS tab_import_jobs (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  target_entity_type TEXT NOT NULL CHECK (length(target_entity_type) BETWEEN 1 AND 64),
  filename TEXT NOT NULL CHECK (length(filename) <= 255),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'mapping', 'validating', 'processing', 'completed', 'failed')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  processed_rows INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  mapping_config_json TEXT CHECK (mapping_config_json IS NULL OR length(mapping_config_json) <= 4096),
  error_log_json TEXT CHECK (error_log_json IS NULL OR length(error_log_json) <= 16384),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS tab_import_jobs_ws_idx ON tab_import_jobs(workspace_id, status);

CREATE TABLE IF NOT EXISTS tab_grid_views (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  entity_type TEXT NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 64),
  columns_json TEXT NOT NULL CHECK (length(columns_json) <= 4096),
  filters_json TEXT NOT NULL DEFAULT '[]' CHECK (length(filters_json) <= 4096),
  sort_json TEXT NOT NULL DEFAULT '[]' CHECK (length(sort_json) <= 1024),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS tab_grid_views_ws_idx ON tab_grid_views(workspace_id, entity_type);
