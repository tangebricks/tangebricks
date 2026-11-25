-- credit-wallet 0003: each payment order remembers its currency and the provider's reference (story 2.3).
--
-- A provider's "PAID" answer is credited only if its currency is the order's own. The columns are added, never
-- back-filled: a row created before this migration has NULL currency, and confirmation holds it to the wallet's
-- configured currency instead. provider_ref is the provider's own id for the order (a payment intent id, for
-- example), which the order is fetched by. Nothing else in credit_orders changes.

ALTER TABLE credit_orders ADD COLUMN currency TEXT CHECK (currency IS NULL OR length(currency) = 3);
ALTER TABLE credit_orders ADD COLUMN provider_ref TEXT CHECK (provider_ref IS NULL OR length(provider_ref) BETWEEN 1 AND 255);
