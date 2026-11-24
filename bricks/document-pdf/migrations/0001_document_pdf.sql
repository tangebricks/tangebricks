-- document-pdf 0001: Document templates, PDF rendering metadata, and digital hashes
-- Modular: No cross-brick foreign key on workspace_id.
-- Prefixed with doc_ to avoid schema collision.

CREATE TABLE IF NOT EXISTS doc_templates (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (length(name) <= 100),
  template_html TEXT NOT NULL CHECK (length(template_html) <= 32768),
  default_metadata_json TEXT CHECK (default_metadata_json IS NULL OR length(default_metadata_json) <= 2048),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, name)
);

CREATE INDEX IF NOT EXISTS doc_templates_ws_idx ON doc_templates(workspace_id, name);

CREATE TABLE IF NOT EXISTS doc_renders (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  template_id TEXT REFERENCES doc_templates(id) ON DELETE SET NULL,
  title TEXT NOT NULL CHECK (length(title) <= 255),
  variables_json TEXT NOT NULL CHECK (length(variables_json) <= 16384),
  pdf_sha256 TEXT NOT NULL CHECK (length(pdf_sha256) = 64),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS doc_renders_ws_idx ON doc_renders(workspace_id, created_at DESC);
