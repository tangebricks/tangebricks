-- multi-workspace 0002: invites addressed to an email and invites that expire (version 1.1.0).
--
-- Both columns are nullable and added, never back-filled: an invite made before this migration (or without the new
-- fields) is an open invite that never expires, exactly as before.
--   * email: stored lower-cased. Only a caller whose verified email matches (ignoring case) can accept the invite, and
--     it is listed in that caller's pending invites.
--   * expires_at: ISO-8601 in UTC (for example 2026-12-04T09:30:00.000Z). An invite past it is refused on accept.

ALTER TABLE mw_invites ADD COLUMN email TEXT CHECK (email IS NULL OR length(email) BETWEEN 3 AND 254);
ALTER TABLE mw_invites ADD COLUMN expires_at TEXT;

CREATE INDEX IF NOT EXISTS mw_invites_email_idx ON mw_invites(email);
