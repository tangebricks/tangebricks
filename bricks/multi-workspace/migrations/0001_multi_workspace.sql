-- multi-workspace 0001: workspaces and who belongs to them.
-- Reference: cephlow apps/api-worker/schema.sql (workspaces, workspace_members).
--
-- Differences from cephlow, each on purpose:
--   * No balance, transfer code or per-action cost here. Those belong to the credit-wallet brick; this brick owns
--     only identity and membership, so either can be enabled without the other.
--   * Tables carry the brick's prefix (mw_), so two bricks can never collide.
--   * Membership is a primary key on (workspace_id, user_id), so a user cannot hold two roles in one workspace.

CREATE TABLE IF NOT EXISTS mw_workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
  suspended_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS mw_workspaces_owner_idx ON mw_workspaces(owner_id);

CREATE TABLE IF NOT EXISTS mw_members (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS mw_members_user_idx ON mw_members(user_id);

CREATE TABLE IF NOT EXISTS mw_invites (
  token TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_by TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1)),
  used_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS mw_invites_workspace_idx ON mw_invites(workspace_id);
