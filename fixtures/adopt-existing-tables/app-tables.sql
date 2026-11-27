-- The app's own tables, as they were before it adopted any brick. Nothing in them changes for the adoption:
-- different table and column names, its own role words, and invite expiry in epoch milliseconds.

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  owner_user TEXT NOT NULL,
  is_suspended INTEGER NOT NULL DEFAULT 0,
  suspend_note TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  created TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS team_users (
  team_id TEXT NOT NULL,
  user_ref TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('lead', 'manager', 'staff')),
  added TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (team_id, user_ref)
);

CREATE TABLE IF NOT EXISTS team_invites (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  access TEXT NOT NULL CHECK (access IN ('lead', 'manager', 'staff')),
  sent_to TEXT,
  inviter TEXT,
  expires_ms INTEGER,
  accepted_at TEXT,
  created TEXT NOT NULL DEFAULT (datetime('now'))
);
