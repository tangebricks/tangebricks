-- audit-trail 0001: Immutable audit events and compliance ledger
-- Modular: No cross-brick foreign key on workspace_id.
-- Prefixed with audit_ to avoid schema collision.

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  actor_id TEXT NOT NULL CHECK (length(actor_id) <= 128),
  actor_type TEXT NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'api_key', 'system', 'support_impersonator')),
  actor_email TEXT CHECK (actor_email IS NULL OR length(actor_email) <= 255),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  target_type TEXT NOT NULL CHECK (length(target_type) <= 64),
  target_id TEXT NOT NULL CHECK (length(target_id) <= 128),
  ip_address TEXT CHECK (ip_address IS NULL OR length(ip_address) <= 45),
  user_agent TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 512),
  metadata_json TEXT CHECK (metadata_json IS NULL OR length(metadata_json) <= 4096),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS audit_events_ws_time_idx ON audit_events(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_ws_action_idx ON audit_events(workspace_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_ws_actor_idx ON audit_events(workspace_id, actor_id, created_at DESC);
