-- queue-jobs 0001: Background job queues, exponential retries, and dead letter storage
-- Modular: No cross-brick foreign key on workspace_id.
-- Prefixed with job_ to avoid schema collision.

CREATE TABLE IF NOT EXISTS job_queues (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  queue_name TEXT NOT NULL CHECK (length(queue_name) BETWEEN 1 AND 64),
  task_type TEXT NOT NULL CHECK (length(task_type) BETWEEN 1 AND 64),
  payload_json TEXT NOT NULL CHECK (length(payload_json) <= 16384),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'dead_letter')),
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN -10 AND 10),
  max_retries INTEGER NOT NULL DEFAULT 3 CHECK (max_retries >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_run_at TEXT NOT NULL DEFAULT (datetime('now')),
  error_message TEXT CHECK (error_message IS NULL OR length(error_message) <= 2048),
  result_json TEXT CHECK (result_json IS NULL OR length(result_json) <= 16384),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS job_queues_poll_idx ON job_queues(queue_name, status, next_run_at, priority DESC);
CREATE INDEX IF NOT EXISTS job_queues_ws_idx ON job_queues(workspace_id, status);
