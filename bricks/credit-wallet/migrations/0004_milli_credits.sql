-- credit-wallet 0004: credits are held as whole thousandths ("milli-credits"), per-action costs, and transfers (story 2.5).
--
-- Apps charge fractional amounts (0.2 credits for an email, 0.5 for a message). Floating point cannot sum those
-- exactly, so every credit amount is now an INTEGER number of thousandths of a credit. Every existing value is
-- multiplied by 1000 here, in the same migration, so 7 credits becomes 7000 exactly.
--
-- The columns are renamed (balance -> balance_milli, amount -> amount_milli, balance_after -> balance_after_milli) so a
-- raw-SQL reader still written for whole credits fails loudly ("no such column") instead of misreading the units.
--
-- credit_wallets: RENAME COLUMN keeps the column's CHECK, rewritten to name the new column (balance_milli >= 0).
--
-- credit_ledger is rebuilt (the 0002 pattern), because the type CHECK gains the two transfer types and SQLite cannot
-- change a CHECK in place: create credit_ledger_v3, copy every row in order with its amounts x1000, drop the old
-- table, rename, and recreate its index. Every other column, default and constraint is kept: CHECK
-- (balance_after_milli >= 0) is part of the overdraw refusal, and UNIQUE (workspace_id, idempotency_key) is the
-- per-workspace idempotency of 0002. transfer_code links the two rows of one transfer; a transfer row must carry one
-- and no other row may.
--
-- credit_orders keeps its whole major-unit `amount` (money paid, not credits; story 2.3).
--
-- credit_action_costs is new: a workspace's price per named action, in thousandths.

ALTER TABLE credit_wallets RENAME COLUMN balance TO balance_milli;

UPDATE credit_wallets SET balance_milli = balance_milli * 1000;

CREATE TABLE IF NOT EXISTS credit_ledger_v3 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('topup', 'deduction', 'transfer_out', 'transfer_in')),
  amount_milli INTEGER NOT NULL,
  balance_after_milli INTEGER NOT NULL CHECK (balance_after_milli >= 0),
  reason TEXT NOT NULL,
  metadata TEXT,
  idempotency_key TEXT,
  transfer_code TEXT CHECK ((transfer_code IS NOT NULL) = (type IN ('transfer_out', 'transfer_in'))),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workspace_id, idempotency_key)
);

INSERT INTO credit_ledger_v3 (id, workspace_id, user_id, type, amount_milli, balance_after_milli, reason, metadata, idempotency_key, transfer_code, created_at)
SELECT id, workspace_id, user_id, type, amount * 1000, balance_after * 1000, reason, metadata, idempotency_key, NULL, created_at
FROM credit_ledger
ORDER BY rowid;

DROP TABLE credit_ledger;

ALTER TABLE credit_ledger_v3 RENAME TO credit_ledger;

CREATE INDEX IF NOT EXISTS credit_ledger_workspace_idx ON credit_ledger(workspace_id);

CREATE INDEX IF NOT EXISTS credit_ledger_transfer_idx ON credit_ledger(transfer_code);

CREATE TABLE IF NOT EXISTS credit_action_costs (
  workspace_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64 AND action GLOB '[a-z]*' AND action NOT GLOB '*[^a-z0-9_.:-]*'),
  cost_milli INTEGER NOT NULL CHECK (cost_milli >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, action)
);
