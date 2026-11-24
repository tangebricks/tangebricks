-- cron-alarms 0001: Recurring cron schedules, next run timestamps, and execution history.
-- Hardened: cron expression bounded, response summary capped to prevent D1 growth runaway.
-- Prefixed with cron_ to prevent collisions.

CREATE TABLE IF NOT EXISTS cron_schedules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_workflow_id TEXT,
  target_url TEXT CHECK (target_url IS NULL OR length(target_url) <= 1024),
  cron_expression TEXT NOT NULL CHECK (length(cron_expression) BETWEEN 9 AND 100),
  timezone TEXT NOT NULL DEFAULT 'UTC' CHECK (length(timezone) <= 64),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS cron_schedules_next_run_idx ON cron_schedules(active, next_run_at);
CREATE INDEX IF NOT EXISTS cron_schedules_workspace_idx ON cron_schedules(workspace_id);

CREATE TABLE IF NOT EXISTS cron_history (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  scheduled_time TEXT NOT NULL,
  actual_start_time TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  status TEXT NOT NULL CHECK (status IN ('success', 'failure', 'missed')),
  response_summary TEXT CHECK (response_summary IS NULL OR length(response_summary) <= 2048),
  FOREIGN KEY (schedule_id) REFERENCES cron_schedules(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cron_history_schedule_idx ON cron_history(schedule_id);
CREATE INDEX IF NOT EXISTS cron_history_workspace_idx ON cron_history(workspace_id);
