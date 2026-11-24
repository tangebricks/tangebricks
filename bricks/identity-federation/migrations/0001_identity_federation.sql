-- identity-federation 0001: SSO connections, federated identities, and SCIM directory sync
-- Modular: No cross-brick foreign key on workspace_id or user_id.
-- Prefixed with sso_ to avoid schema collision.

CREATE TABLE IF NOT EXISTS sso_connections (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  domain TEXT NOT NULL CHECK (length(domain) BETWEEN 3 AND 255),
  provider_type TEXT NOT NULL CHECK (provider_type IN ('oidc', 'saml', 'google', 'github', 'microsoft', 'apple')),
  display_name TEXT NOT NULL CHECK (length(display_name) <= 100),
  client_id TEXT NOT NULL CHECK (length(client_id) <= 255),
  client_secret TEXT CHECK (client_secret IS NULL OR length(client_secret) <= 512),
  issuer_url TEXT NOT NULL CHECK (length(issuer_url) <= 512),
  authorization_endpoint TEXT CHECK (authorization_endpoint IS NULL OR length(authorization_endpoint) <= 512),
  token_endpoint TEXT CHECK (token_endpoint IS NULL OR length(token_endpoint) <= 512),
  userinfo_endpoint TEXT CHECK (userinfo_endpoint IS NULL OR length(userinfo_endpoint) <= 512),
  scim_token TEXT CHECK (scim_token IS NULL OR length(scim_token) <= 255),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, domain)
);

CREATE INDEX IF NOT EXISTS sso_conn_domain_idx ON sso_connections(domain);

CREATE TABLE IF NOT EXISTS sso_federated_identities (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  connection_id TEXT NOT NULL REFERENCES sso_connections(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  external_subject_id TEXT NOT NULL CHECK (length(external_subject_id) <= 255),
  email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 255),
  display_name TEXT CHECK (display_name IS NULL OR length(display_name) <= 100),
  user_id TEXT CHECK (user_id IS NULL OR length(user_id) <= 128),
  last_login_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(connection_id, external_subject_id)
);

CREATE INDEX IF NOT EXISTS sso_fid_email_idx ON sso_federated_identities(workspace_id, email);
