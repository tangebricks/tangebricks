-- Admin Console & User Impersonation Migration
-- Schema prefix: adm_

CREATE TABLE IF NOT EXISTS adm_super_admins (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('super_admin', 'support_agent', 'auditor')) DEFAULT 'support_agent',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS adm_tenant_overrides (
  workspace_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('active', 'suspended', 'read_only')) DEFAULT 'active',
  reason TEXT,
  custom_limits_json TEXT NOT NULL DEFAULT '{}',
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS adm_impersonation_sessions (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES adm_super_admins(user_id),
  impersonated_user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  session_token TEXT UNIQUE NOT NULL,
  reason TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  ended_at INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_adm_imp_token ON adm_impersonation_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_adm_imp_admin ON adm_impersonation_sessions(admin_user_id, impersonated_user_id);
CREATE INDEX IF NOT EXISTS idx_adm_imp_ws ON adm_impersonation_sessions(workspace_id);
