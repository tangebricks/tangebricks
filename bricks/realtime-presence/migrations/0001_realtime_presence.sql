-- realtime-presence 0001: Presence rooms, sessions, and live cursor tracking
-- Modular: No cross-brick foreign key on workspace_id or user_id.
-- Prefixed with pres_ to avoid schema collision.

CREATE TABLE IF NOT EXISTS pres_rooms (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (length(name) <= 100),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, name)
);

CREATE TABLE IF NOT EXISTS pres_sessions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  room_id TEXT NOT NULL REFERENCES pres_rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL CHECK (length(user_id) <= 128),
  user_name TEXT NOT NULL CHECK (length(user_name) <= 100),
  status TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'idle', 'away', 'offline')),
  cursor_json TEXT CHECK (cursor_json IS NULL OR length(cursor_json) <= 512),
  metadata_json TEXT CHECK (metadata_json IS NULL OR length(metadata_json) <= 1024),
  last_heartbeat_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(room_id, user_id)
);

CREATE INDEX IF NOT EXISTS pres_sessions_room_hb_idx ON pres_sessions(room_id, last_heartbeat_at DESC);
CREATE INDEX IF NOT EXISTS pres_sessions_ws_user_idx ON pres_sessions(workspace_id, user_id);
