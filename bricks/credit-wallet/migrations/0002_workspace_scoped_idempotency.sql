-- credit-wallet 0002: idempotency keys are unique per workspace, not across the platform (AD-V2, story 0.7).
--
-- 0001 declared `credit_ledger.idempotency_key TEXT UNIQUE`, so one workspace's key could collide with another's:
-- a second workspace that reused a key got the first workspace's "duplicate" answer (and its balance) without
-- being charged. The key is now unique per (workspace_id, idempotency_key).
--
-- SQLite cannot drop a column-level UNIQUE, so the table is rebuilt: create the new table, copy every row, drop the
-- old table, rename, and recreate its index. Every column, type, default and CHECK of 0001 is kept as it was
-- (CHECK (balance_after >= 0) is part of the overdraw refusal); 0001 defines no triggers on this table.
-- credit_wallets (CHECK (balance >= 0)) and credit_orders are not touched.

CREATE TABLE IF NOT EXISTS credit_ledger_v2 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('topup', 'deduction')),
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  reason TEXT NOT NULL,
  metadata TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workspace_id, idempotency_key)
);

INSERT INTO credit_ledger_v2 (id, workspace_id, user_id, type, amount, balance_after, reason, metadata, idempotency_key, created_at)
SELECT id, workspace_id, user_id, type, amount, balance_after, reason, metadata, idempotency_key, created_at
FROM credit_ledger
ORDER BY rowid;

DROP TABLE credit_ledger;

ALTER TABLE credit_ledger_v2 RENAME TO credit_ledger;

CREATE INDEX IF NOT EXISTS credit_ledger_workspace_idx ON credit_ledger(workspace_id);
