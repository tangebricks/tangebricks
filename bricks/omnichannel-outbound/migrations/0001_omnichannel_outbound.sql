-- omnichannel-outbound 0001: Messaging channels, credentials, and outbound dispatch records.
-- Hardened: message body capped at 64KB, sender/recipient bounded.
-- Prefixed with msg_ to prevent collisions.

CREATE TABLE IF NOT EXISTS msg_channels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('email', 'sms', 'whatsapp', 'slack', 'discord')),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  sender_address TEXT NOT NULL CHECK (length(sender_address) BETWEEN 1 AND 255),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (length(config_json) <= 4096),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS msg_channels_workspace_idx ON msg_channels(workspace_id);

CREATE TABLE IF NOT EXISTS msg_dispatches (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  recipient TEXT NOT NULL CHECK (length(recipient) BETWEEN 1 AND 255),
  subject TEXT CHECK (subject IS NULL OR length(subject) <= 255),
  body_text TEXT NOT NULL CHECK (length(body_text) <= 65536),
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'delivered', 'failed')),
  external_id TEXT CHECK (external_id IS NULL OR length(external_id) <= 255),
  error_text TEXT CHECK (error_text IS NULL OR length(error_text) <= 2048),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  FOREIGN KEY (channel_id) REFERENCES msg_channels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS msg_dispatches_workspace_idx ON msg_dispatches(workspace_id);
CREATE INDEX IF NOT EXISTS msg_dispatches_status_idx ON msg_dispatches(status);
