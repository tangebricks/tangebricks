-- mcp-server 0001: the blueprints the tools edit, the files a build produced, and a counter that limits how often tools run.
-- The endpoint holds no state of its own: everything a later call needs is in these tables, keyed by project name.

CREATE TABLE IF NOT EXISTS mcp_projects (
  project TEXT PRIMARY KEY,
  blueprint TEXT NOT NULL,
  -- Bumped on every change. A change is written only if the version it was computed from is still current, so two
  -- calls at once cannot overwrite each other.
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mcp_files (
  project TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (project, path)
);

CREATE TABLE IF NOT EXISTS mcp_builds (
  project TEXT PRIMARY KEY,
  project_hash TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  byte_count INTEGER NOT NULL,
  built_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mcp_rate (
  window TEXT PRIMARY KEY,
  calls INTEGER NOT NULL
);
