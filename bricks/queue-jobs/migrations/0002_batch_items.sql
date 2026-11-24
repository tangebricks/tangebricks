-- queue-jobs 0002: Batch chunk item records with per-item idempotency and dead-letter isolation (UC7.5)
-- Modular: No cross-brick foreign key on workspace_id.
-- Prefixed with job_ to avoid schema collision.

CREATE TABLE IF NOT EXISTS job_batch_items (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  job_id TEXT NOT NULL CHECK (length(job_id) BETWEEN 1 AND 128),
  item_index INTEGER NOT NULL CHECK (item_index >= 0),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  status TEXT NOT NULL DEFAULT 'succeeded' CHECK (status IN ('succeeded', 'failed', 'dead_letter')),
  result_json TEXT CHECK (result_json IS NULL OR length(result_json) <= 16384),
  error_message TEXT CHECK (error_message IS NULL OR length(error_message) <= 2048),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (job_id, item_index)
);

CREATE INDEX IF NOT EXISTS job_batch_items_ws_job_idx ON job_batch_items(workspace_id, job_id);
CREATE INDEX IF NOT EXISTS job_batch_items_key_idx ON job_batch_items(idempotency_key);
