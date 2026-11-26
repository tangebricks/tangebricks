-- AD-V8 / R56: approval requests for destructive actions an MCP agent asks for (deploy, promote, rollback, revert,
-- sandbox deploy, promote-to-BYOC). A Studio session user with editor+ approves or rejects; the agent retries with the
-- approval id, which is consumed once by a conditional UPDATE (status = 'approved' AND consumed_at IS NULL).
-- Rows are keyed by org_id and project_id; the org always comes from the verified project authorisation.

CREATE TABLE IF NOT EXISTS studio_approval_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  action TEXT NOT NULL,
  env TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL DEFAULT '',
  blueprint_rev INTEGER NOT NULL,
  plan_fingerprint TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'consumed')),
  requested_by_token TEXT NOT NULL,
  decided_by_user TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  decided_at TEXT,
  consumed_at TEXT,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS studio_approval_requests_project_idx
  ON studio_approval_requests(org_id, project_id, status, created_at);
