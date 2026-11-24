-- user-profile 0001: User Profile, Localization & Preferences
-- Independent: No cross-brick foreign key on user_id to ensure clean brick modularity.
-- Prefixed with profile_ to avoid schema collision.

CREATE TABLE IF NOT EXISTS profile_users (
  user_id TEXT PRIMARY KEY CHECK (length(user_id) BETWEEN 1 AND 128),
  display_name TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 100),
  avatar_url TEXT CHECK (avatar_url IS NULL OR length(avatar_url) <= 512),
  bio TEXT CHECK (bio IS NULL OR length(bio) <= 500),
  locale TEXT NOT NULL DEFAULT 'en' CHECK (length(locale) BETWEEN 2 AND 10),
  timezone TEXT NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 64),
  theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('light', 'dark', 'system')),
  preferences_json TEXT NOT NULL DEFAULT '{}' CHECK (length(preferences_json) <= 4096),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS profile_users_updated_idx ON profile_users(updated_at);
