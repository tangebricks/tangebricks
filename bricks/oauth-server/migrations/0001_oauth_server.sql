-- OAuth 2.0 Authorization Server Migration
-- Schema prefix: oauth_

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_secret_hash TEXT,
  redirect_uris_json TEXT NOT NULL,
  allowed_scopes_json TEXT NOT NULL,
  is_confidential INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_clients_ws ON oauth_clients(workspace_id);

CREATE TABLE IF NOT EXISTS oauth_auth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  code_challenge TEXT,
  code_challenge_method TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_client ON oauth_auth_codes(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_exp ON oauth_auth_codes(expires_at);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  access_token TEXT PRIMARY KEY,
  refresh_token TEXT UNIQUE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id TEXT,
  workspace_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  token_type TEXT NOT NULL DEFAULT 'Bearer',
  access_token_expires_at INTEGER NOT NULL,
  refresh_token_expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_rt ON oauth_tokens(refresh_token);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_ws ON oauth_tokens(workspace_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id);
