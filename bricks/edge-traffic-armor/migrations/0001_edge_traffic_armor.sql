-- edge-traffic-armor 0001: IP access rules, rate limit windows, and blocked incidents
-- Modular: No cross-brick foreign key on workspace_id.
-- Prefixed with arm_ to avoid schema collision.

CREATE TABLE IF NOT EXISTS arm_ip_rules (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  ip_or_cidr TEXT NOT NULL CHECK (length(ip_or_cidr) BETWEEN 3 AND 45),
  action TEXT NOT NULL CHECK (action IN ('allow', 'block', 'challenge')),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 255),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, ip_or_cidr)
);

CREATE INDEX IF NOT EXISTS arm_ip_rules_ws_idx ON arm_ip_rules(workspace_id, action);

CREATE TABLE IF NOT EXISTS arm_rate_limits (
  key TEXT NOT NULL CHECK (length(key) <= 128),
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE IF NOT EXISTS arm_blocked_requests (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT,
  ip_address TEXT NOT NULL CHECK (length(ip_address) <= 45),
  path TEXT NOT NULL CHECK (length(path) <= 255),
  block_reason TEXT NOT NULL CHECK (block_reason IN ('ip_block', 'rate_limit', 'bot_detected', 'waf_rule')),
  user_agent TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 512),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS arm_blocked_ws_idx ON arm_blocked_requests(workspace_id, created_at DESC);
