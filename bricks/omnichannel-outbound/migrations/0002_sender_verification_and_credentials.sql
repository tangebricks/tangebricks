-- omnichannel-outbound 0002 (story 2.4, PROPOSED-9): sender ownership, sealed channel credentials, send attempts and
-- delivery status.
--
-- msg_channels gains:
--   verified                 0 until the sender is proven to belong to the channel (B8); sending needs 1.
--   credentials_ciphertext   the channel's secrets, AES-GCM sealed with associated data workspace_id:channel_id (B9).
--   verify_code_hash         SHA-256 of a pending one-time sender code; the code itself is never stored.
--   verify_code_expires_at   when that code stops working (15 minutes after it was sent).
--   verify_code_attempts     confirmations tried against that code (at most 5).
--   verify_code_sends        codes sent in the current one-hour window (at most 5).
--   verify_code_window_start when that window started.
--   workflow_send_allowed    1 when an owner/admin lets workflow runs send through this channel (default 0).
--
-- msg_dispatches is rebuilt to add `attempts` and the status `read` (a webhook can move sent -> delivered -> read).
-- SQLite cannot change a CHECK in place, so the table is created as msg_dispatches_v2, every row copied, the old table
-- dropped and the new one renamed; every other column, type, default and CHECK of 0001 is kept as it was.

ALTER TABLE msg_channels ADD COLUMN verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1));
ALTER TABLE msg_channels ADD COLUMN credentials_ciphertext TEXT CHECK (credentials_ciphertext IS NULL OR length(credentials_ciphertext) <= 16384);
ALTER TABLE msg_channels ADD COLUMN verify_code_hash TEXT CHECK (verify_code_hash IS NULL OR length(verify_code_hash) = 64);
ALTER TABLE msg_channels ADD COLUMN verify_code_expires_at TEXT;
ALTER TABLE msg_channels ADD COLUMN verify_code_attempts INTEGER NOT NULL DEFAULT 0 CHECK (verify_code_attempts >= 0);
ALTER TABLE msg_channels ADD COLUMN verify_code_sends INTEGER NOT NULL DEFAULT 0 CHECK (verify_code_sends >= 0);
ALTER TABLE msg_channels ADD COLUMN verify_code_window_start TEXT;
ALTER TABLE msg_channels ADD COLUMN workflow_send_allowed INTEGER NOT NULL DEFAULT 0 CHECK (workflow_send_allowed IN (0, 1));

CREATE TABLE IF NOT EXISTS msg_dispatches_v2 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  recipient TEXT NOT NULL CHECK (length(recipient) BETWEEN 1 AND 255),
  subject TEXT CHECK (subject IS NULL OR length(subject) <= 255),
  body_text TEXT NOT NULL CHECK (length(body_text) <= 65536),
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed')),
  external_id TEXT CHECK (external_id IS NULL OR length(external_id) <= 255),
  error_text TEXT CHECK (error_text IS NULL OR length(error_text) <= 2048),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  FOREIGN KEY (channel_id) REFERENCES msg_channels(id) ON DELETE CASCADE
);

INSERT INTO msg_dispatches_v2 (id, workspace_id, channel_id, recipient, subject, body_text, status, external_id, error_text, created_at, sent_at, attempts)
SELECT id, workspace_id, channel_id, recipient, subject, body_text, status, external_id, error_text, created_at, sent_at,
  CASE WHEN status = 'queued' THEN 0 ELSE 1 END
FROM msg_dispatches
ORDER BY rowid;

DROP TABLE msg_dispatches;

ALTER TABLE msg_dispatches_v2 RENAME TO msg_dispatches;

CREATE INDEX IF NOT EXISTS msg_dispatches_workspace_idx ON msg_dispatches(workspace_id);
CREATE INDEX IF NOT EXISTS msg_dispatches_status_idx ON msg_dispatches(status);
CREATE INDEX IF NOT EXISTS msg_dispatches_external_idx ON msg_dispatches(channel_id, external_id);
