-- metered-usage 0001: Metered usage, event counters, and windowed aggregation
-- Modular: No cross-brick foreign key on workspace_id.
-- Prefixed with meter_ to avoid schema collision.

CREATE TABLE IF NOT EXISTS meter_definitions (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  aggregation TEXT NOT NULL CHECK (aggregation IN ('sum', 'count', 'max', 'last')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meter_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  meter_key TEXT NOT NULL REFERENCES meter_definitions(key) ON DELETE CASCADE,
  value REAL NOT NULL DEFAULT 1.0,
  idempotency_key TEXT UNIQUE CHECK (idempotency_key IS NULL OR length(idempotency_key) <= 128),
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  metadata_json TEXT CHECK (metadata_json IS NULL OR length(metadata_json) <= 1024)
);

CREATE INDEX IF NOT EXISTS meter_events_ws_time_idx ON meter_events(workspace_id, meter_key, timestamp);

CREATE TABLE IF NOT EXISTS meter_aggregates (
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  meter_key TEXT NOT NULL REFERENCES meter_definitions(key) ON DELETE CASCADE,
  window_period TEXT NOT NULL CHECK (length(window_period) BETWEEN 4 AND 32),
  total_value REAL NOT NULL DEFAULT 0.0,
  event_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, meter_key, window_period)
);

CREATE INDEX IF NOT EXISTS meter_aggregates_ws_idx ON meter_aggregates(workspace_id, window_period);
