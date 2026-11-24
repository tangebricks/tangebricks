-- webhook-gateway 0001: Webhook ingress endpoints, signing secrets, and delivery logs.
-- Hardened against DoS: payload_text capped at 16KB to prevent D1 row exhaustion.
-- Prefixed with wh_ to prevent collisions.

CREATE TABLE IF NOT EXISTS wh_endpoints (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 64),
  signing_secret TEXT NOT NULL CHECK (length(signing_secret) >= 32),
  previous_secret TEXT,
  previous_secret_expires_at TEXT,
  target_workflow_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS wh_endpoints_slug_idx ON wh_endpoints(slug);
CREATE INDEX IF NOT EXISTS wh_endpoints_workspace_idx ON wh_endpoints(workspace_id);

CREATE TABLE IF NOT EXISTS wh_deliveries (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  headers_json TEXT,
  payload_text TEXT CHECK (payload_text IS NULL OR length(payload_text) <= 16384),
  payload_truncated INTEGER NOT NULL DEFAULT 0 CHECK (payload_truncated IN (0, 1)),
  signature_verified INTEGER NOT NULL CHECK (signature_verified IN (0, 1)),
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  duration_ms INTEGER NOT NULL,
  FOREIGN KEY (endpoint_id) REFERENCES wh_endpoints(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS wh_deliveries_endpoint_idx ON wh_deliveries(endpoint_id);
CREATE INDEX IF NOT EXISTS wh_deliveries_workspace_idx ON wh_deliveries(workspace_id);

CREATE TABLE IF NOT EXISTS wh_subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  workflow_id TEXT NOT NULL,
  connection_ref TEXT,
  app TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  verifier TEXT NOT NULL CHECK (verifier IN ('hmac-sha256', 'stripe-signature', 'shared-secret', 'ed25519', 'none')),
  signature_header TEXT NOT NULL DEFAULT 'X-Webhook-Signature',
  event_id_path TEXT,
  signing_secret TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS wh_subscriptions_workspace_idx ON wh_subscriptions(workspace_id, workflow_id);

CREATE TABLE IF NOT EXISTS px_webhook_deliveries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  subscription_id TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  run_id TEXT,
  status TEXT NOT NULL DEFAULT 'processed',
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (subscription_id, provider_event_id)
);

CREATE INDEX IF NOT EXISTS px_webhook_deliveries_sub_idx ON px_webhook_deliveries(subscription_id, provider_event_id);

CREATE TABLE IF NOT EXISTS px_connections (
  ref TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT 'default',
  env_name TEXT NOT NULL DEFAULT 'preview',
  workspace_id TEXT NOT NULL DEFAULT 'default',
  app TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'apiKey',
  label TEXT NOT NULL DEFAULT '',
  scopes_json TEXT NOT NULL DEFAULT '[]',
  ciphertext_b64 TEXT NOT NULL,
  iv_b64 TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  expires_at INTEGER,
  refresh_lock_until INTEGER,
  last_checked_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS px_connections_app_idx ON px_connections(project_id, env_name, app);
CREATE INDEX IF NOT EXISTS px_connections_ws_idx ON px_connections(workspace_id, app);

