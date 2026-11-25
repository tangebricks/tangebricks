-- llm-gateway 0002 (story 1.13): each generation log row says what happened to its money. A call first reserves its
-- maximum cost from the workspace wallet (key ai:<log id>), writes its row as 'reserved', generates, then refunds what
-- it did not use (key ai:<log id>:refund) and updates the row.
--   reserved        the maximum is held and the call has not finished. Still 'reserved' well after the request time
--                   limit means a cancelled or crashed call whose cost_credits are held: reconcile it;
--   charged         the text was returned; cost_credits is the actual cost, the rest was refunded;
--   refund_failed   the text was returned but the refund failed; cost_credits is the whole reservation, still held;
--   refunded        every provider failed and the whole reservation was refunded; cost_credits is 0;
--   billing_failed  no text, and credits may still be held (the refund failed, or it is unknown whether the reservation
--                   was taken); cost_credits is what is held as far as is known;
--   not_billed      the app runs with billing "none", and every row written before 1.13 (nothing was ever charged then).

ALTER TABLE ai_generation_logs ADD COLUMN billing_status TEXT NOT NULL DEFAULT 'not_billed' CHECK (billing_status IN ('reserved', 'charged', 'refund_failed', 'refunded', 'billing_failed', 'not_billed'));
