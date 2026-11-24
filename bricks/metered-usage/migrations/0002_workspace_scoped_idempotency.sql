-- metered-usage 0002: usage idempotency keys are unique per workspace, not across the platform (AD-V2, story 0.7).
--
-- 0001 declared `meter_events.idempotency_key TEXT UNIQUE`, so a key one workspace used made another workspace's
-- event with the same key a "duplicate" and its usage was never recorded. The key is now unique per
-- (workspace_id, idempotency_key).
--
-- SQLite cannot drop a column-level UNIQUE, so the table is rebuilt: create the new table, copy every row, drop the
-- old table, rename, and recreate its index. Every column, type, default, CHECK and the foreign key of 0001 is kept;
-- 0001 defines no triggers on this table. meter_definitions and meter_aggregates are not touched.

CREATE TABLE IF NOT EXISTS meter_events_v2 (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  meter_key TEXT NOT NULL REFERENCES meter_definitions(key) ON DELETE CASCADE,
  value REAL NOT NULL DEFAULT 1.0,
  idempotency_key TEXT CHECK (idempotency_key IS NULL OR length(idempotency_key) <= 128),
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  metadata_json TEXT CHECK (metadata_json IS NULL OR length(metadata_json) <= 1024),
  UNIQUE (workspace_id, idempotency_key)
);

INSERT INTO meter_events_v2 (id, workspace_id, meter_key, value, idempotency_key, timestamp, metadata_json)
SELECT id, workspace_id, meter_key, value, idempotency_key, timestamp, metadata_json
FROM meter_events
ORDER BY rowid;

DROP TABLE meter_events;

ALTER TABLE meter_events_v2 RENAME TO meter_events;

CREATE INDEX IF NOT EXISTS meter_events_ws_time_idx ON meter_events(workspace_id, meter_key, timestamp);
