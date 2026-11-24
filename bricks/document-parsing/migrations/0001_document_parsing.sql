-- Document Parsing & Structured Extraction Migration
-- Schema prefix: docp_

CREATE TABLE IF NOT EXISTS docp_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('uploaded', 'processing', 'completed', 'failed')) DEFAULT 'uploaded',
  error_message TEXT,
  raw_content TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_docp_docs_ws_status ON docp_documents(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_docp_docs_created ON docp_documents(created_at);

CREATE TABLE IF NOT EXISTS docp_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES docp_documents(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  heading TEXT,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_docp_chunks_doc ON docp_chunks(document_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_docp_chunks_ws ON docp_chunks(workspace_id);

CREATE TABLE IF NOT EXISTS docp_extractions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES docp_documents(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  schema_name TEXT NOT NULL,
  extracted_data_json TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_docp_ext_doc ON docp_extractions(document_id);
CREATE INDEX IF NOT EXISTS idx_docp_ext_ws_schema ON docp_extractions(workspace_id, schema_name);
