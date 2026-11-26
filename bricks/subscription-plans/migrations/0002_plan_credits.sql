-- subscription-plans 0002 (story 1.20): plan credits.
-- credits_granted_period is the last credit period (0, 1, 2, ... whole months or years since the subscription's
-- created_at) whose plan credits were granted. It only spares the per-minute sweep from rescanning a workspace; the
-- credit ledger's per-workspace idempotency key (plan-credits:<plan_id>:<period>) is what makes a grant happen once.
ALTER TABLE sub_subscriptions ADD COLUMN credits_granted_period INTEGER CHECK (credits_granted_period IS NULL OR credits_granted_period >= 0);
-- credits_retry_after: when the sweep may try again after a failed grant (ISO 8601 UTC); NULL when nothing failed.
ALTER TABLE sub_subscriptions ADD COLUMN credits_retry_after TEXT;

CREATE INDEX IF NOT EXISTS sub_subscriptions_credits_idx ON sub_subscriptions(status, credits_granted_period);
