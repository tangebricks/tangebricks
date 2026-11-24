-- checkout-gateway 0001: Checkout sessions, tax calculation, and invoices
-- Modular: No cross-brick foreign key on workspace_id.
-- Prefixed with pay_ to avoid schema collision.

CREATE TABLE IF NOT EXISTS pay_checkout_sessions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  gateway TEXT NOT NULL CHECK (gateway IN ('stripe', 'lemonsqueezy', 'cashfree', 'paddle', 'custom')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (length(currency) = 3),
  tax_cents INTEGER NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents INTEGER NOT NULL CHECK (total_cents >= amount_cents),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'expired', 'canceled')),
  customer_email TEXT CHECK (customer_email IS NULL OR length(customer_email) <= 255),
  checkout_url TEXT NOT NULL CHECK (length(checkout_url) <= 512),
  metadata_json TEXT CHECK (metadata_json IS NULL OR length(metadata_json) <= 2048),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS pay_checkout_sessions_ws_idx ON pay_checkout_sessions(workspace_id, status);

CREATE TABLE IF NOT EXISTS pay_invoices (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  session_id TEXT REFERENCES pay_checkout_sessions(id) ON DELETE SET NULL,
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  invoice_number TEXT UNIQUE NOT NULL CHECK (length(invoice_number) BETWEEN 1 AND 64),
  subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  tax_cents INTEGER NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents INTEGER NOT NULL CHECK (total_cents >= subtotal_cents),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (length(currency) = 3),
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  billing_details_json TEXT CHECK (billing_details_json IS NULL OR length(billing_details_json) <= 2048),
  line_items_json TEXT NOT NULL CHECK (length(line_items_json) <= 4096),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS pay_invoices_ws_idx ON pay_invoices(workspace_id, created_at);
