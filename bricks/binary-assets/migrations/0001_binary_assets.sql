-- binary-assets 0001: R2 object references and uploaded file metadata.
-- Hardened: content_type and filename bounded, size strictly capped at 100MB.
-- Prefixed with asset_ to prevent collisions.

CREATE TABLE IF NOT EXISTS asset_files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  content_type TEXT NOT NULL CHECK (length(content_type) BETWEEN 1 AND 128),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 104857600),
  r2_key TEXT NOT NULL UNIQUE CHECK (length(r2_key) <= 512),
  public_url TEXT CHECK (public_url IS NULL OR length(public_url) <= 1024),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS asset_files_workspace_idx ON asset_files(workspace_id);
