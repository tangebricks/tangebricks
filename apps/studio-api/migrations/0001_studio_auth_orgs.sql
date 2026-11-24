-- Studio control-plane Better Auth + Organizations + RBAC + MCP Tokens + Audit Log schema for Cloudflare D1 (SQLite)

CREATE TABLE IF NOT EXISTS "user" (
  "id" text NOT NULL PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" integer NOT NULL DEFAULT 0,
  "image" text,
  "createdAt" date NOT NULL,
  "updatedAt" date NOT NULL
);

CREATE TABLE IF NOT EXISTS "session" (
  "id" text NOT NULL PRIMARY KEY,
  "expiresAt" date NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" date NOT NULL,
  "updatedAt" date NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "account" (
  "id" text NOT NULL PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" date,
  "refreshTokenExpiresAt" date,
  "scope" text,
  "password" text,
  "createdAt" date NOT NULL,
  "updatedAt" date NOT NULL
);

CREATE TABLE IF NOT EXISTS "verification" (
  "id" text NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" date NOT NULL,
  "createdAt" date NOT NULL,
  "updatedAt" date NOT NULL
);

CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId");
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId");
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier");

CREATE TABLE IF NOT EXISTS studio_orgs (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS studio_org_members (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'builder', 'viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS studio_mcp_tokens (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  scopes TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS studio_audit_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'org_default',
  current_revision INTEGER NOT NULL DEFAULT 0,
  semantic_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS studio_builds (
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  build_hash TEXT NOT NULL,
  semantic_hash TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  byte_count INTEGER NOT NULL,
  files_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, revision)
);

CREATE INDEX IF NOT EXISTS studio_builds_hash_idx ON studio_builds(project_id, build_hash);
CREATE INDEX IF NOT EXISTS studio_projects_org_idx ON projects(org_id);
CREATE INDEX IF NOT EXISTS studio_audit_log_org_idx ON studio_audit_log(org_id, created_at);

CREATE TABLE IF NOT EXISTS studio_onboarding_events (
  event_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT,
  actor_id TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN (
    'signup_completed',
    'project_created',
    'first_blueprint_edit',
    'first_test_step_run',
    'connect_cf_wizard_opened',
    'connect_cf_token_link_clicked',
    'connect_cf_token_submitted',
    'connect_cf_permission_check_failed',
    'connect_cf_verified',
    'first_preview_deploy_started',
    'first_preview_deploy_succeeded',
    'first_production_deploy_succeeded'
  )),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS studio_onboarding_events_org_step_idx ON studio_onboarding_events(org_id, step, created_at);
CREATE INDEX IF NOT EXISTS studio_onboarding_events_actor_idx ON studio_onboarding_events(actor_id, step, created_at);

CREATE TABLE IF NOT EXISTS studio_audit_logs (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  org_id TEXT NOT NULL,
  project_id TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'succeeded',
  target_ref TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  details_json TEXT,
  ip_hash TEXT NOT NULL DEFAULT 'sha256:local',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS studio_audit_logs_org_idx ON studio_audit_logs(org_id, ts DESC);
CREATE INDEX IF NOT EXISTS studio_audit_logs_project_idx ON studio_audit_logs(project_id, ts DESC);

CREATE TABLE IF NOT EXISTS project_retention_settings (
  project_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  env_name TEXT NOT NULL DEFAULT 'default' CHECK (env_name IN ('default', 'preview', 'production')),
  run_retention_days INTEGER NOT NULL DEFAULT 14 CHECK (run_retention_days >= 1 AND run_retention_days <= 90),
  telemetry_retention_days INTEGER NOT NULL DEFAULT 7 CHECK (telemetry_retention_days >= 1 AND telemetry_retention_days <= 30),
  capture_step_io_in_prod INTEGER NOT NULL DEFAULT 1,
  additional_redact_keys_json TEXT NOT NULL DEFAULT '[]',
  updated_by TEXT NOT NULL DEFAULT 'system',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, env_name)
);
CREATE INDEX IF NOT EXISTS project_retention_settings_org_idx ON project_retention_settings(org_id, project_id);


