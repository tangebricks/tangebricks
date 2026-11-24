-- Custom Domain & SSL Provisioning Migration
-- Schema prefix: dom_

CREATE TABLE IF NOT EXISTS dom_domains (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  hostname TEXT NOT NULL UNIQUE,
  target_cname TEXT NOT NULL,
  verification_type TEXT NOT NULL CHECK(verification_type IN ('cname', 'txt')) DEFAULT 'cname',
  verification_token TEXT NOT NULL,
  dns_status TEXT NOT NULL CHECK(dns_status IN ('pending', 'verified', 'failed')) DEFAULT 'pending',
  ssl_status TEXT NOT NULL CHECK(ssl_status IN ('pending', 'issuing', 'active', 'failed')) DEFAULT 'pending',
  ssl_error TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dom_domains_ws ON dom_domains(workspace_id);
CREATE INDEX IF NOT EXISTS idx_dom_domains_host ON dom_domains(hostname);
