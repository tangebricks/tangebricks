-- in-app-notifications 0001: Bell icon alerts, badges, and read status
-- Modular: No cross-brick foreign key on user_id or workspace_id.
-- Prefixed with notif_ to avoid schema collision.

CREATE TABLE IF NOT EXISTS notif_notifications (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT CHECK (workspace_id IS NULL OR length(workspace_id) <= 128),
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 128),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  body TEXT NOT NULL CHECK (length(body) <= 1024),
  type TEXT NOT NULL DEFAULT 'info' CHECK (type IN ('info', 'success', 'warning', 'error', 'action_required')),
  action_url TEXT CHECK (action_url IS NULL OR length(action_url) <= 512),
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  read_at TEXT,
  metadata_json TEXT CHECK (metadata_json IS NULL OR length(metadata_json) <= 2048),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS notif_user_unread_idx ON notif_notifications(user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS notif_user_time_idx ON notif_notifications(user_id, created_at DESC);
