-- Data Privacy & GDPR Toolkit Migration
-- Schema prefix: dpr_

CREATE TABLE IF NOT EXISTS dpr_consents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('necessary', 'analytics', 'marketing', 'preferences')),
  granted INTEGER NOT NULL DEFAULT 0,
  ip_address TEXT,
  user_agent TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, user_id, category)
);

CREATE INDEX IF NOT EXISTS idx_dpr_consents_user ON dpr_consents(workspace_id, user_id);

CREATE TABLE IF NOT EXISTS dpr_erasure_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed', 'rejected')) DEFAULT 'pending',
  reason TEXT,
  deleted_records_count INTEGER NOT NULL DEFAULT 0,
  requested_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_dpr_erasure_status ON dpr_erasure_requests(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_dpr_erasure_user ON dpr_erasure_requests(workspace_id, user_id);

CREATE TABLE IF NOT EXISTS dpr_export_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')) DEFAULT 'pending',
  export_data_json TEXT,
  download_url TEXT,
  requested_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_dpr_export_user ON dpr_export_requests(workspace_id, user_id);
