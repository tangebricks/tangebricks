-- projectx: phase=contract expands=migrations/0001_webhook_gateway.sql
-- webhook-gateway 0002: Declarative webhook signature scheme column and dropped verifier enum CHECK constraint (UC4.5)

CREATE TABLE IF NOT EXISTS wh_subscriptions_v2 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  workflow_id TEXT NOT NULL,
  connection_ref TEXT,
  app TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  verifier TEXT NOT NULL,
  signature_header TEXT NOT NULL DEFAULT 'X-Webhook-Signature',
  event_id_path TEXT,
  signing_secret TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  scheme_json TEXT NOT NULL,
  disabled_reason TEXT
);

INSERT INTO wh_subscriptions_v2 (
  id,
  workspace_id,
  workflow_id,
  connection_ref,
  app,
  trigger_id,
  verifier,
  signature_header,
  event_id_path,
  signing_secret,
  enabled,
  created_at,
  scheme_json,
  disabled_reason
)
SELECT
  id,
  workspace_id,
  workflow_id,
  connection_ref,
  app,
  trigger_id,
  verifier,
  signature_header,
  event_id_path,
  signing_secret,
  CASE
    WHEN verifier = 'none' THEN 0
    WHEN verifier = 'ed25519' THEN 0
    ELSE enabled
  END,
  created_at,
  CASE
    WHEN verifier = 'hmac-sha256' THEN
      CASE
        WHEN lower(signature_header) = 'x-hub-signature-256' THEN '{"preset":"github-hmac-sha256"}'
        ELSE json_object('preset', 'github-hmac-sha256', 'signatureHeader', signature_header)
      END
    WHEN verifier = 'stripe-signature' THEN
      CASE
        WHEN lower(signature_header) = 'stripe-signature' THEN '{"preset":"stripe-signature"}'
        ELSE json_object('preset', 'stripe-signature', 'signatureHeader', signature_header)
      END
    WHEN verifier = 'shared-secret' THEN
      CASE
        WHEN lower(signature_header) = 'x-webhook-secret' THEN '{"preset":"shared-secret"}'
        ELSE json_object('preset', 'shared-secret', 'signatureHeader', signature_header)
      END
    WHEN verifier = 'none' THEN '{"preset":"none"}'
    WHEN verifier = 'ed25519' THEN '{"preset":"discord-ed25519"}'
    ELSE json_object('preset', verifier)
  END,
  CASE
    WHEN verifier = 'none' THEN 'WEBHOOK_VERIFIER_NONE_FORBIDDEN'
    WHEN verifier = 'ed25519' THEN 'WEBHOOK_ED25519_PUBLIC_KEY_REQUIRED'
    ELSE NULL
  END
FROM wh_subscriptions;

DROP TABLE wh_subscriptions;

ALTER TABLE wh_subscriptions_v2 RENAME TO wh_subscriptions;

CREATE INDEX IF NOT EXISTS wh_subscriptions_workspace_idx ON wh_subscriptions(workspace_id, workflow_id);
