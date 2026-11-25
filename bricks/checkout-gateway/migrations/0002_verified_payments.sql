-- checkout-gateway 0002: what a verified provider payment is checked against, and one invoice per session (story 2.3).
--
-- customer_id: the caller a provider order was created for (NULL for a session made without a gateway).
-- payment_session_id: the provider's session id returned to the client instead of a placeholder URL.
-- provider_ref: the provider's own reference for the order, which the order is fetched by.
-- line_items_json: the session's line items, copied onto the invoice the verified webhook issues (gateway sessions only).
-- The unique index makes a second invoice for one session impossible to commit.

ALTER TABLE pay_checkout_sessions ADD COLUMN customer_id TEXT CHECK (customer_id IS NULL OR length(customer_id) BETWEEN 1 AND 200);
ALTER TABLE pay_checkout_sessions ADD COLUMN payment_session_id TEXT CHECK (payment_session_id IS NULL OR length(payment_session_id) <= 512);
ALTER TABLE pay_checkout_sessions ADD COLUMN provider_ref TEXT CHECK (provider_ref IS NULL OR length(provider_ref) BETWEEN 1 AND 255);
ALTER TABLE pay_checkout_sessions ADD COLUMN line_items_json TEXT CHECK (line_items_json IS NULL OR length(line_items_json) <= 4096);

CREATE UNIQUE INDEX IF NOT EXISTS pay_invoices_session_uidx ON pay_invoices(session_id) WHERE session_id IS NOT NULL;
