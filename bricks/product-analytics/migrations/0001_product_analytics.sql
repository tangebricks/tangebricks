-- product-analytics 0001: Clickstream events, identity aliasing, and funnels
-- Modular: No cross-brick foreign key on workspace_id.
-- Prefixed with evt_ to avoid schema collision.

CREATE TABLE IF NOT EXISTS evt_analytics_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  user_id TEXT CHECK (user_id IS NULL OR length(user_id) <= 128),
  anonymous_id TEXT NOT NULL CHECK (length(anonymous_id) <= 128),
  event_name TEXT NOT NULL CHECK (length(event_name) BETWEEN 1 AND 64),
  session_id TEXT CHECK (session_id IS NULL OR length(session_id) <= 128),
  properties_json TEXT CHECK (properties_json IS NULL OR length(properties_json) <= 4096),
  context_json TEXT CHECK (context_json IS NULL OR length(context_json) <= 2048),
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS evt_events_ws_time_idx ON evt_analytics_events(workspace_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS evt_events_name_idx ON evt_analytics_events(workspace_id, event_name, timestamp DESC);
CREATE INDEX IF NOT EXISTS evt_events_user_idx ON evt_analytics_events(workspace_id, user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS evt_events_anon_idx ON evt_analytics_events(workspace_id, anonymous_id);

CREATE TABLE IF NOT EXISTS evt_funnels (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (length(name) <= 100),
  steps_json TEXT NOT NULL CHECK (length(steps_json) <= 2048),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS evt_funnels_ws_idx ON evt_funnels(workspace_id, name);
