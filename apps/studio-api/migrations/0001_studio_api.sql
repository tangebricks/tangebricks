CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'org_default',
  current_revision INTEGER NOT NULL DEFAULT 0,
  semantic_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS studio_builds (
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  build_hash TEXT NOT NULL,
  semantic_hash TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  byte_count INTEGER NOT NULL,
  files_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, revision)
);

CREATE INDEX IF NOT EXISTS studio_builds_hash_idx ON studio_builds(project_id, build_hash);
