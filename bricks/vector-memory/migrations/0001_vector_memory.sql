-- vector-memory 0001: Vector indexes, chunked documents, and embeddings
-- Modular: No cross-brick foreign key on workspace_id.
-- Prefixed with vec_ to avoid schema collision.

CREATE TABLE IF NOT EXISTS vec_indexes (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  metric TEXT NOT NULL DEFAULT 'cosine' CHECK (metric IN ('cosine', 'euclidean', 'dot')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS vec_indexes_ws_idx ON vec_indexes(workspace_id, name);

CREATE TABLE IF NOT EXISTS vec_documents (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  index_id TEXT NOT NULL REFERENCES vec_indexes(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  text_content TEXT NOT NULL CHECK (length(text_content) <= 8192),
  embedding_json TEXT NOT NULL,
  metadata_json TEXT CHECK (metadata_json IS NULL OR length(metadata_json) <= 2048),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS vec_documents_index_idx ON vec_documents(index_id, workspace_id);
