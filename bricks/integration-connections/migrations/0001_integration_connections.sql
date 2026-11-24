-- Workspace Integration Connections (Case B Multi-Tenant OAuth2)
-- Schema prefix: int_

CREATE TABLE IF NOT EXISTS int_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_account_id TEXT,
  account_label TEXT,
  sealed_credentials TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'expired', 'revoked', 'error')),
  expires_at INTEGER,
  refresh_lock_until INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_int_connections_ws_provider ON int_connections(workspace_id, provider);

CREATE TABLE IF NOT EXISTS int_oauth_states (
  state TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  code_verifier TEXT,
  redirect_uri TEXT,
  scopes TEXT NOT NULL DEFAULT '[]',
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_int_oauth_states_ws_provider ON int_oauth_states(workspace_id, provider);
