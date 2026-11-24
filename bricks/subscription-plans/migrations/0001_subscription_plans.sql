-- subscription-plans 0001: Plans, features, and workspace subscriptions.
-- Hardened: features_json length bounded, workspace_id keyed cleanly without external FK.
-- Prefixed with sub_ to prevent collisions.

CREATE TABLE IF NOT EXISTS sub_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('month', 'year', 'one_time')),
  features_json TEXT NOT NULL DEFAULT '{}' CHECK (length(features_json) <= 8192),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sub_subscriptions (
  workspace_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'past_due', 'canceled', 'trialing')),
  current_period_end TEXT NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (plan_id) REFERENCES sub_plans(id)
);

CREATE INDEX IF NOT EXISTS sub_subscriptions_plan_idx ON sub_subscriptions(plan_id);
