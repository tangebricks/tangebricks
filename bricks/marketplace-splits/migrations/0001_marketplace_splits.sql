-- marketplace-splits 0001: Revenue splits, escrow holds, and merchant payouts
-- Modular: No cross-brick foreign key on workspace_id or vendor_id.
-- Prefixed with split_ to avoid schema collision.

CREATE TABLE IF NOT EXISTS split_contracts (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  vendor_id TEXT NOT NULL CHECK (length(vendor_id) <= 128),
  platform_fee_percent REAL NOT NULL DEFAULT 10.0 CHECK (platform_fee_percent BETWEEN 0.0 AND 100.0),
  escrow_days INTEGER NOT NULL DEFAULT 7 CHECK (escrow_days >= 0),
  payout_method TEXT NOT NULL DEFAULT 'stripe_connect' CHECK (payout_method IN ('stripe_connect', 'wise', 'manual')),
  payout_destination TEXT CHECK (payout_destination IS NULL OR length(payout_destination) <= 255),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, vendor_id)
);

CREATE TABLE IF NOT EXISTS split_transactions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  vendor_id TEXT NOT NULL CHECK (length(vendor_id) <= 128),
  order_id TEXT NOT NULL CHECK (length(order_id) <= 128),
  gross_amount_cents INTEGER NOT NULL CHECK (gross_amount_cents >= 0),
  platform_fee_cents INTEGER NOT NULL CHECK (platform_fee_cents >= 0),
  vendor_amount_cents INTEGER NOT NULL CHECK (vendor_amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (length(currency) = 3),
  status TEXT NOT NULL DEFAULT 'in_escrow' CHECK (status IN ('in_escrow', 'available', 'paid_out', 'refunded')),
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS split_tx_vendor_status_idx ON split_transactions(workspace_id, vendor_id, status);

CREATE TABLE IF NOT EXISTS split_payouts (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  vendor_id TEXT NOT NULL CHECK (length(vendor_id) <= 128),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (length(currency) = 3),
  payout_method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'paid', 'failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS split_payouts_ws_vendor_idx ON split_payouts(workspace_id, vendor_id, created_at DESC);
