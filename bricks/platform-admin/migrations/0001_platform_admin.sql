-- platform-admin 0001: the opt-in user approval gate (story 2.6).
-- One row per signed-in user the gate has seen or an operator has decided on. Platform-wide by design: approval is a
-- decision about a person, not about any one workspace, so the table has no workspace_id.
-- Prefixed with pa_ so it can never collide with another brick's table.

CREATE TABLE IF NOT EXISTS pa_user_approvals (
  user_id TEXT PRIMARY KEY CHECK (length(user_id) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by TEXT CHECK (decided_by IS NULL OR length(decided_by) <= 200),
  decided_at TEXT,
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS pa_user_approvals_status_idx ON pa_user_approvals(status, user_id);
