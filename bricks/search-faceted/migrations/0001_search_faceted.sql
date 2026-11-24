-- search-faceted 0001: Inverted full-text indexes and faceted attributes
-- Modular: No cross-brick foreign key on workspace_id.
-- Prefixed with search_ to avoid schema collision.

CREATE TABLE IF NOT EXISTS search_documents (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  entity_type TEXT NOT NULL CHECK (length(entity_type) <= 64),
  entity_id TEXT NOT NULL CHECK (length(entity_id) <= 128),
  title TEXT NOT NULL CHECK (length(title) <= 255),
  body TEXT NOT NULL CHECK (length(body) <= 16384),
  facets_json TEXT NOT NULL DEFAULT '{}' CHECK (length(facets_json) <= 4096),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS search_docs_ws_type_idx ON search_documents(workspace_id, entity_type);

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  id UNINDEXED,
  workspace_id UNINDEXED,
  title,
  body,
  tokenize='porter unicode61'
);
