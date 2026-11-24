-- User Onboarding & Activation Tours Migration
-- Schema prefix: onb_

CREATE TABLE IF NOT EXISTS onb_flows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  steps_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, key)
);

CREATE INDEX IF NOT EXISTS idx_onb_flows_ws ON onb_flows(workspace_id);

CREATE TABLE IF NOT EXISTS onb_user_progress (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL REFERENCES onb_flows(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  completed_steps_json TEXT NOT NULL DEFAULT '[]',
  is_completed INTEGER NOT NULL DEFAULT 0,
  is_dismissed INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  dismissed_at TEXT,
  UNIQUE(flow_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_onb_prog_user ON onb_user_progress(workspace_id, user_id);
CREATE INDEX IF NOT EXISTS idx_onb_prog_flow ON onb_user_progress(flow_id);
