# Changelog

## Unreleased (story 1.20: plan credits)

- Two settings: `planCredits` (`"free:100,pro:1000"`: a plan id and whole credits, up to 20 entries, default `""`) and
  `creditPeriod` (`month` | `year`, default `month`).
- With `planCredits` set, a plan grants its credits once per credit period (whole months or years since the
  subscription's `created_at`, UTC) through credit-wallet's `walletCharger.grant`, which the assembler hands the brick as
  the `charger` route and schedule option. The ledger key `plan-credits:<plan_id>:<period>` makes each grant happen
  once; a duplicate or a key used with another amount counts as already granted. `one_time` plans stay in period 0.
- Grants happen when a subscription is read or created (`getSubscription`, `subscribe`, `changePlan`), and from the
  per-minute schedule `runPlanCreditSweep` (at most 50 workspaces a run, never-granted first; only real grants are
  marked). Only `active` and
  `trialing` subscriptions are granted; nothing is ever taken back on a downgrade or cancel.
- Migration 0002 adds two nullable columns to `sub_subscriptions`, `credits_granted_period` (the period last granted;
  a read for that period makes no grant call) and `credits_retry_after` (the sweep retries a failed grant after an
  hour), and an index.
- With `planCredits` empty, the only change to an assembled app is that additive migration: no charger, no schedule, no
  credit-wallet needed, and nothing reads or writes the new columns. With it set, credit-wallet must be enabled; the
  assembler refuses the blueprint otherwise.
- `POST /subscriptions/change` refuses a plan id with no plan row (404 `PLAN_NOT_FOUND`) unless it is the default tier;
  only a platform operator creates plans. Before, the switch created the plan at price 0.

## 1.0.0 — initial versioned release
