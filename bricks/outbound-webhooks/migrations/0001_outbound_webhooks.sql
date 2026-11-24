-- outbound-webhooks 0001: Developer webhook endpoints, HMAC secrets, and delivery logs
-- Modular: No cross-brick foreign key on workspace_id.
-- Prefixed with owh_ to avoid schema collision.

CREATE TABLE IF NOT EXISTS owh_endpoints (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  target_url TEXT NOT NULL CHECK (length(target_url) BETWEEN 8 AND 512),
  description TEXT CHECK (description IS NULL OR length(description) <= 255),
  events_json TEXT NOT NULL CHECK (length(events_json) <= 2048),
  secret TEXT NOT NULL CHECK (length(secret) BETWEEN 16 AND 128),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS owh_endpoints_ws_idx ON owh_endpoints(workspace_id, is_active);

CREATE TABLE IF NOT EXISTS owh_deliveries (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  endpoint_id TEXT NOT NULL REFERENCES owh_endpoints(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 64),
  payload_json TEXT NOT NULL CHECK (length(payload_json) <= 16384),
  status_code INTEGER,
  response_body TEXT CHECK (response_body IS NULL OR length(response_body) <= 2048),
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (attempt_number >= 1),
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS owh_deliveries_ep_time_idx ON owh_deliveries(endpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS owh_deliveries_ws_time_idx ON owh_deliveries(workspace_id, created_at DESC);
