-- credit-wallet 0001: balances, ledger and payment orders.
-- Reference: cephlow apps/api-worker/schema.sql (workspaces.current_balance, ledgers, payment_orders).
--
-- Differences from cephlow, each on purpose:
--   * Credits are whole numbers (INTEGER). cephlow uses REAL, and sums of fractions such as its default 0.2
--     email cost are not exact in floating point.
--   * The balance lives in this brick's own table, keyed by workspace_id, so this brick never alters a table
--     that belongs to multi-workspace. There is no foreign key, so the bricks migrate independently.
--   * CHECK (balance >= 0): the database refuses an overdraw. A deduction that would overdraw raises, and D1
--     rolls its whole batch back, ledger row included.
--   * idempotency_key is UNIQUE: a payment order can be credited only once, because the ledger row that
--     records the credit carries the order's key, and a second one violates the constraint.
-- Table names carry the brick's prefix so two bricks can never collide.

CREATE TABLE IF NOT EXISTS credit_wallets (
  workspace_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('topup', 'deduction')),
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  reason TEXT NOT NULL,
  metadata TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS credit_ledger_workspace_idx ON credit_ledger(workspace_id);

CREATE TABLE IF NOT EXISTS credit_orders (
  order_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  processed INTEGER NOT NULL DEFAULT 0 CHECK (processed IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS credit_orders_workspace_idx ON credit_orders(workspace_id);
