-- feature-flags 0001: Flags, rules, and workspace overrides.
-- Hardened: key length bounded, percentage strictly 0..100.
-- Prefixed with flag_ to prevent collisions.

CREATE TABLE IF NOT EXISTS flag_definitions (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64),
  description TEXT CHECK (description IS NULL OR length(description) <= 255),
  enabled_default INTEGER NOT NULL DEFAULT 0 CHECK (enabled_default IN (0, 1)),
  percentage_rollout INTEGER NOT NULL DEFAULT 100 CHECK (percentage_rollout BETWEEN 0 AND 100),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS flag_overrides (
  flag_key TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (flag_key, workspace_id),
  FOREIGN KEY (flag_key) REFERENCES flag_definitions(key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS flag_overrides_workspace_idx ON flag_overrides(workspace_id);
