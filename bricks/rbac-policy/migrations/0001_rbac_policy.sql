-- rbac-policy 0001: Roles, permission matrix, and role assignments.
-- Hardened: zero foreign keys to external bricks (user_id is plain ID for modular independence).
-- Prefixed with rbac_ to prevent collisions.

CREATE TABLE IF NOT EXISTS rbac_roles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  description TEXT CHECK (description IS NULL OR length(description) <= 255),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS rbac_roles_workspace_idx ON rbac_roles(workspace_id);

CREATE TABLE IF NOT EXISTS rbac_permissions (
  role_id TEXT NOT NULL,
  resource TEXT NOT NULL CHECK (length(resource) BETWEEN 1 AND 64),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
  PRIMARY KEY (role_id, resource, action),
  FOREIGN KEY (role_id) REFERENCES rbac_roles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rbac_role_assignments (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, user_id, role_id),
  FOREIGN KEY (role_id) REFERENCES rbac_roles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS rbac_assignments_user_idx ON rbac_role_assignments(workspace_id, user_id);
