-- Studio control-plane CP5 BYOC Cloudflare Token Vault, Audit Log, Project Environments & Onboarding Funnel schema for Cloudflare D1 (SQLite)

CREATE TABLE IF NOT EXISTS deploy_tokens (
  token_ref TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_name TEXT NOT NULL,
  token_last4 TEXT NOT NULL,
  scopes TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')) DEFAULT 'active',
  ciphertext TEXT,
  iv TEXT,
  wrapped_dek TEXT,
  dek_iv TEXT,
  kek_version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_verified_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS deploy_tokens_org_idx ON deploy_tokens(org_id, status);

CREATE TABLE IF NOT EXISTS deploy_token_audit_log (
  audit_id TEXT PRIMARY KEY,
  token_ref TEXT NOT NULL,
  org_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  deploy_id TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS deploy_token_audit_log_token_idx ON deploy_token_audit_log(token_ref, created_at);
CREATE INDEX IF NOT EXISTS deploy_token_audit_log_org_idx ON deploy_token_audit_log(org_id, created_at);

CREATE TABLE IF NOT EXISTS project_environments (
  project_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  env_name TEXT NOT NULL CHECK (env_name IN ('preview', 'production')),
  target_type TEXT NOT NULL DEFAULT 'byoc',
  account_id TEXT NOT NULL,
  account_name TEXT NOT NULL,
  token_ref TEXT NOT NULL,
  deployed_rev INTEGER,
  build_hash TEXT,
  code_hash TEXT,
  graph_hash TEXT,
  deployed_state_json TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, env_name)
);

CREATE INDEX IF NOT EXISTS project_environments_org_idx ON project_environments(org_id, token_ref);

CREATE TABLE IF NOT EXISTS project_deployments (
  deploy_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  env_name TEXT NOT NULL CHECK (env_name IN ('preview', 'production')),
  revision INTEGER NOT NULL,
  build_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  graph_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  worker_url TEXT NOT NULL,
  version_id TEXT NOT NULL,
  database_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS project_deployments_project_env_idx ON project_deployments(project_id, env_name, created_at);

CREATE TABLE IF NOT EXISTS builds (
  build_hash TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  semantic_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  graph_hash TEXT NOT NULL,
  catalog_version TEXT NOT NULL DEFAULT '1.0.0',
  bundle_code TEXT NOT NULL,
  bundle_sha256 TEXT NOT NULL,
  files_json TEXT NOT NULL,
  assemble_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS builds_project_rev_idx ON builds(project_id, revision);

CREATE TABLE IF NOT EXISTS deployments (
  deploy_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  env_name TEXT NOT NULL CHECK (env_name IN ('preview', 'production')),
  revision INTEGER NOT NULL,
  build_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  graph_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'succeeded',
  reused_cached_build INTEGER NOT NULL DEFAULT 0,
  live_without_redeploy INTEGER NOT NULL DEFAULT 0,
  no_changes INTEGER NOT NULL DEFAULT 0,
  rollback_from_deploy_id TEXT,
  worker_url TEXT NOT NULL,
  version_id TEXT NOT NULL,
  database_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS deployments_project_env_idx ON deployments(project_id, env_name, created_at);

CREATE TABLE IF NOT EXISTS deployment_steps (
  step_id TEXT PRIMARY KEY,
  deploy_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  env_name TEXT NOT NULL,
  step_order INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS deployment_steps_deploy_idx ON deployment_steps(deploy_id, step_order);

CREATE TABLE IF NOT EXISTS onboarding_funnel_events (
  event_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT,
  actor_id TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('wizard_opened', 'template_link_clicked', 'token_submitted', 'verification_failed', 'verification_succeeded', 'token_disconnected')),
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS onboarding_funnel_events_org_step_idx ON onboarding_funnel_events(org_id, step, created_at);
