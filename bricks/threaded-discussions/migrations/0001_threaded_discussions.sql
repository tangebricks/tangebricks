-- threaded-discussions 0001: Contextual threads and nested comments
-- Modular: No cross-brick foreign key on workspace_id or user_id.
-- Prefixed with cmt_ to avoid schema collision.

CREATE TABLE IF NOT EXISTS cmt_threads (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  target_type TEXT NOT NULL CHECK (length(target_type) <= 64),
  target_id TEXT NOT NULL CHECK (length(target_id) <= 128),
  title TEXT CHECK (title IS NULL OR length(title) <= 255),
  is_resolved INTEGER NOT NULL DEFAULT 0 CHECK (is_resolved IN (0, 1)),
  resolved_by TEXT CHECK (resolved_by IS NULL OR length(resolved_by) <= 128),
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS cmt_threads_target_idx ON cmt_threads(workspace_id, target_type, target_id);

CREATE TABLE IF NOT EXISTS cmt_comments (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  thread_id TEXT NOT NULL REFERENCES cmt_threads(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  parent_comment_id TEXT REFERENCES cmt_comments(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL CHECK (length(author_id) <= 128),
  author_name TEXT NOT NULL CHECK (length(author_name) <= 100),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8192),
  mentions_json TEXT NOT NULL DEFAULT '[]' CHECK (length(mentions_json) <= 1024),
  is_edited INTEGER NOT NULL DEFAULT 0 CHECK (is_edited IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS cmt_comments_thread_idx ON cmt_comments(thread_id, created_at ASC);
CREATE INDEX IF NOT EXISTS cmt_comments_parent_idx ON cmt_comments(parent_comment_id);
