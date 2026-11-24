CREATE TABLE IF NOT EXISTS studio_secret_vault (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('api_key', 'webhook_secret', 'brick_secret')),
  label TEXT NOT NULL,
  app_or_brick TEXT NOT NULL,
  env_scope TEXT NOT NULL DEFAULT 'all',
  ciphertext_b64 TEXT NOT NULL,
  iv_b64 TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'valid',
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, ref)
);

CREATE INDEX IF NOT EXISTS studio_secret_vault_project_idx ON studio_secret_vault(project_id, org_id);
