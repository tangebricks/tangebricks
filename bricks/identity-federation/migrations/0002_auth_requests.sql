-- identity-federation 0002: Transient SSO authorization requests for PKCE, nonce, and state tracking
-- 10-minute TTL

CREATE TABLE IF NOT EXISTS sso_auth_requests (
  state TEXT PRIMARY KEY CHECK (length(state) BETWEEN 1 AND 256),
  connection_id TEXT NOT NULL REFERENCES sso_connections(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  redirect_uri TEXT NOT NULL CHECK (length(redirect_uri) <= 1024),
  nonce TEXT NOT NULL CHECK (length(nonce) BETWEEN 1 AND 256),
  code_verifier TEXT CHECK (code_verifier IS NULL OR length(code_verifier) <= 256),
  code_challenge TEXT NOT NULL CHECK (length(code_challenge) <= 256),
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS sso_auth_req_exp_idx ON sso_auth_requests(expires_at);
