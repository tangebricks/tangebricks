-- 0001_leaky.sql: fixture migration for leaky brick
CREATE TABLE IF NOT EXISTS leaky_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  val INTEGER NOT NULL DEFAULT 0
);
