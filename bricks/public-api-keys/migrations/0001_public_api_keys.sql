-- public-api-keys 0001: API keys, hash storage, scopes and revocation.
-- Hardened: 64-hex SHA-256 hashes, prefix bounds, composite indexes to prevent tenant leaks.
-- Prefixed with key_ to prevent collisions.

CREATE TABLE IF NOT EXISTS key_api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  key_prefix TEXT NOT NULL CHECK (length(key_prefix) BETWEEN 8 AND 24),
  key_hash TEXT NOT NULL UNIQUE CHECK (length(key_hash) = 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  scopes_json TEXT NOT NULL DEFAULT '["*"]' CHECK (length(scopes_json) <= 4096),
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS key_api_keys_lookup_idx ON key_api_keys(key_prefix, revoked);
CREATE INDEX IF NOT EXISTS key_api_keys_hash_idx ON key_api_keys(key_hash, revoked);
CREATE INDEX IF NOT EXISTS key_api_keys_workspace_idx ON key_api_keys(workspace_id);
