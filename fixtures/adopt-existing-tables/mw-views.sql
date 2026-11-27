-- Adoption: the multi-workspace brick's three tables as views over the app's own tables, so the brick reads and writes
-- the app's rows in place. Nothing is copied. Apply this instead of the brick's migrations (never both: the views take
-- the tables' names). See docs/adopting-existing-tables.md.
--
-- One nullable column is added to the app's invite table, because the brick records who used an invite.

ALTER TABLE team_invites ADD COLUMN accepted_by TEXT;

-- ===== mw_workspaces over teams =====
CREATE VIEW IF NOT EXISTS mw_workspaces AS
  SELECT id, title AS name, owner_user AS owner_id, is_suspended AS suspended, suspend_note AS suspended_reason, created AS created_at
  FROM teams;

CREATE TRIGGER IF NOT EXISTS mw_workspaces_insert INSTEAD OF INSERT ON mw_workspaces
BEGIN
  INSERT INTO teams (id, title, owner_user, is_suspended, suspend_note, created)
  VALUES (NEW.id, NEW.name, NEW.owner_id, COALESCE(NEW.suspended, 0), NEW.suspended_reason, COALESCE(NEW.created_at, datetime('now')));
END;

CREATE TRIGGER IF NOT EXISTS mw_workspaces_update INSTEAD OF UPDATE ON mw_workspaces
BEGIN
  UPDATE teams SET title = NEW.name, owner_user = NEW.owner_id, is_suspended = NEW.suspended, suspend_note = NEW.suspended_reason
  WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS mw_workspaces_delete INSTEAD OF DELETE ON mw_workspaces
BEGIN
  DELETE FROM teams WHERE id = OLD.id;
END;

-- ===== mw_members over team_users (lead/manager/staff <-> owner/admin/member) =====
CREATE VIEW IF NOT EXISTS mw_members AS
  SELECT team_id AS workspace_id, user_ref AS user_id,
    CASE access WHEN 'lead' THEN 'owner' WHEN 'manager' THEN 'admin' ELSE 'member' END AS role,
    added AS joined_at
  FROM team_users;

CREATE TRIGGER IF NOT EXISTS mw_members_insert INSTEAD OF INSERT ON mw_members
BEGIN
  INSERT INTO team_users (team_id, user_ref, access, added)
  VALUES (NEW.workspace_id, NEW.user_id,
    CASE NEW.role WHEN 'owner' THEN 'lead' WHEN 'admin' THEN 'manager' WHEN 'member' THEN 'staff' END,
    COALESCE(NEW.joined_at, datetime('now')));
END;

CREATE TRIGGER IF NOT EXISTS mw_members_update INSTEAD OF UPDATE ON mw_members
BEGIN
  UPDATE team_users SET access = CASE NEW.role WHEN 'owner' THEN 'lead' WHEN 'admin' THEN 'manager' WHEN 'member' THEN 'staff' END
  WHERE team_id = OLD.workspace_id AND user_ref = OLD.user_id;
END;

CREATE TRIGGER IF NOT EXISTS mw_members_delete INSTEAD OF DELETE ON mw_members
BEGIN
  DELETE FROM team_users WHERE team_id = OLD.workspace_id AND user_ref = OLD.user_id;
END;

-- ===== mw_invites over team_invites (expiry: epoch milliseconds <-> ISO-8601 UTC) =====
CREATE VIEW IF NOT EXISTS mw_invites AS
  SELECT invite_code AS token, team_id AS workspace_id,
    CASE access WHEN 'lead' THEN 'owner' WHEN 'manager' THEN 'admin' ELSE 'member' END AS role,
    inviter AS created_by,
    CASE WHEN accepted_at IS NULL THEN 0 ELSE 1 END AS used,
    accepted_by AS used_by,
    created AS created_at,
    sent_to AS email,
    CASE WHEN expires_ms IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', expires_ms / 1000.0, 'unixepoch') END AS expires_at
  FROM team_invites;

CREATE TRIGGER IF NOT EXISTS mw_invites_insert INSTEAD OF INSERT ON mw_invites
BEGIN
  INSERT INTO team_invites (id, team_id, invite_code, access, sent_to, inviter, expires_ms, created)
  VALUES (lower(hex(randomblob(16))), NEW.workspace_id, NEW.token,
    CASE NEW.role WHEN 'owner' THEN 'lead' WHEN 'admin' THEN 'manager' WHEN 'member' THEN 'staff' END,
    NEW.email, NEW.created_by,
    CASE WHEN NEW.expires_at IS NULL THEN NULL ELSE CAST(round((julianday(NEW.expires_at) - 2440587.5) * 86400000.0) AS INTEGER) END,
    COALESCE(NEW.created_at, datetime('now')));
END;

CREATE TRIGGER IF NOT EXISTS mw_invites_update INSTEAD OF UPDATE ON mw_invites
BEGIN
  UPDATE team_invites SET
    accepted_at = CASE WHEN NEW.used = 1 AND OLD.used = 0 THEN datetime('now') WHEN NEW.used = 0 THEN NULL ELSE accepted_at END,
    accepted_by = NEW.used_by
  WHERE invite_code = OLD.token;
END;

CREATE TRIGGER IF NOT EXISTS mw_invites_delete INSTEAD OF DELETE ON mw_invites
BEGIN
  DELETE FROM team_invites WHERE invite_code = OLD.token;
END;
