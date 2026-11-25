-- audit-trail 0002 (story 2.6): rows written through the declared auditRecorder capability.
-- via_capability marks a row written by another brick through the capability (always 1 there); the public
-- POST /audit/events route never writes it, so readers that must trust a row (a pending operator grant, an outcome)
-- ignore anything a workspace member posted. dedupe_key lets the capability write at most one row per key in a
-- workspace, so concurrent first attempts of one operation share one row. Additive only: existing rows get 0 and NULL.

ALTER TABLE audit_events ADD COLUMN via_capability INTEGER NOT NULL DEFAULT 0 CHECK (via_capability IN (0, 1));
ALTER TABLE audit_events ADD COLUMN dedupe_key TEXT CHECK (dedupe_key IS NULL OR length(dedupe_key) <= 200);

CREATE UNIQUE INDEX IF NOT EXISTS audit_events_ws_dedupe_idx ON audit_events(workspace_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_events_capability_idx ON audit_events(via_capability, action, target_id);
