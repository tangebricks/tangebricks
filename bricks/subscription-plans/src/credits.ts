import type { D1Like } from "@poc/sdk";
import { scoped } from "@poc/sdk";

/**
 * Story 1.20: plan credits. A plan (tier) grants a number of whole credits to the workspace's wallet once per credit
 * period. The wallet is reached only through credit-wallet's `walletCharger`, handed to this brick by the assembler
 * (`$capability: credit-wallet.walletCharger`), so this brick never imports credit-wallet or reads its tables.
 *
 * Once per period is the ledger's guarantee: each grant uses the per-workspace idempotency key
 * `plan-credits:<plan_id>:<period index>`, so a retry, a concurrent read or a sweep that grants the same period again
 * adds nothing. `sub_subscriptions.credits_granted_period` only spares the sweep from rescanning.
 */

/** The part of credit-wallet's `walletCharger` this brick uses (structurally typed: no import of credit-wallet). */
export interface PlanCreditCharger {
  grant(
    db: D1Like,
    workspaceId: string,
    milli: number,
    idempotencyKey: string,
    reason: string,
    userId?: string,
  ): Promise<{ ok: true; duplicate: boolean } | { ok: false; code: string }>;
}

export type CreditPeriod = "month" | "year";

export interface PlanCreditsConfig {
  /** credit-wallet's walletCharger; with none, nothing is granted. */
  charger?: PlanCreditCharger;
  /** The `planCredits` setting: `"free:100,pro:1000"` (tier:whole credits, up to 20 entries); empty grants nothing. */
  planCredits?: string;
  /** The `creditPeriod` setting. Default "month". */
  creditPeriod?: CreditPeriod;
}

/** The `planCredits` setting's format (the manifest declares the same pattern). */
export const PLAN_CREDITS_PATTERN = /^(|[a-z0-9][a-z0-9_.-]{0,63}:[0-9]{1,9}(,[a-z0-9][a-z0-9_.-]{0,63}:[0-9]{1,9}){0,19})$/;

/** Parses the `planCredits` setting into whole credits by tier. The first entry for a tier wins. */
export function parsePlanCredits(spec: string | undefined): ReadonlyMap<string, number> {
  const credits = new Map<string, number>();
  if (spec === undefined || spec === "") return credits;
  if (!PLAN_CREDITS_PATTERN.test(spec)) throw new RangeError(`planCredits: "${spec.slice(0, 80)}" is not tier:credits[,tier:credits] (for example free:100,pro:1000)`);
  for (const entry of spec.split(",")) {
    const colon = entry.lastIndexOf(":");
    const tier = entry.slice(0, colon);
    if (!credits.has(tier)) credits.set(tier, Number(entry.slice(colon + 1)));
  }
  return credits;
}

/** A stored timestamp (ISO 8601 or SQLite's `YYYY-MM-DD HH:MM:SS`, both UTC) as epoch milliseconds, or NaN. */
export function parseUtc(value: string): number {
  const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value);
  return Date.parse(sqlite ? `${value.replace(" ", "T")}Z` : value);
}

/**
 * The credit period `nowMs` falls in, counted from the subscription's `created_at` (UTC): whole months (or years)
 * elapsed. Period 0 starts at created_at; period 1 at the same day and time one month (year) later. A month that has no
 * such day starts the period on the next month's first day. A plan billed `one_time` always stays in period 0.
 */
export function creditPeriodIndex(createdAt: string, nowMs: number, period: CreditPeriod, billingInterval?: string): number {
  if (billingInterval === "one_time") return 0;
  const created = new Date(parseUtc(createdAt));
  const now = new Date(nowMs);
  if (Number.isNaN(created.getTime()) || Number.isNaN(now.getTime())) return 0;
  const msOfDay = (d: Date) => ((d.getUTCHours() * 60 + d.getUTCMinutes()) * 60 + d.getUTCSeconds()) * 1000 + d.getUTCMilliseconds();
  const inMonth = (d: Date) => d.getUTCDate() * 86_400_000 + msOfDay(d);
  let elapsed: number;
  if (period === "year") {
    elapsed = now.getUTCFullYear() - created.getUTCFullYear();
    const inYear = (d: Date) => d.getUTCMonth() * 32 * 86_400_000 + inMonth(d);
    if (inYear(now) < inYear(created)) elapsed -= 1;
  } else {
    elapsed = (now.getUTCFullYear() - created.getUTCFullYear()) * 12 + (now.getUTCMonth() - created.getUTCMonth());
    if (inMonth(now) < inMonth(created)) elapsed -= 1;
  }
  return Math.max(0, elapsed);
}

/** The ledger idempotency key for a plan's grant in a period (scoped to the workspace by the ledger). */
export function planCreditKey(planId: string, periodIndex: number): string {
  return `plan-credits:${planId}:${periodIndex}`;
}

/** What `grantPlanCredits` did. */
export type PlanCreditOutcome =
  | { status: "granted" | "already_granted"; period: number; milli: number }
  | { status: "skipped"; reason: "credits_off" | "not_active" | "no_credits_for_plan" }
  | { status: "wallet_not_found"; period: number };

export interface SubscriptionForCredits {
  workspace_id: string;
  plan_id: string;
  status: string;
  created_at: string;
  billing_interval?: string | null;
  /** The period last granted for this plan (the marker); a grant for that same period is skipped without a charger call. */
  credits_granted_period?: number | null;
}

/**
 * Grants the subscription's plan credits for the period `nowMs` falls in, once. Only `active` and `trialing`
 * subscriptions are granted; a plan with no credits (or 0) in `planCredits` gets nothing. The grant always targets
 * `sub.workspace_id`, which callers take from the guard's resolved workspace or from the row being swept.
 *
 * A retry of a period already granted (`duplicate`) and a key already used with another amount (the setting changed
 * mid-period: `IDEMPOTENCY_KEY_REUSED`) both count as already granted, never as an error. Neither ever takes credits
 * away.
 */
export async function grantPlanCredits(
  db: D1Like,
  config: PlanCreditsConfig,
  sub: SubscriptionForCredits,
  nowMs: number,
): Promise<PlanCreditOutcome> {
  if (!config.charger || !config.planCredits) return { status: "skipped", reason: "credits_off" };
  if (sub.status !== "active" && sub.status !== "trialing") return { status: "skipped", reason: "not_active" };
  const credits = parsePlanCredits(config.planCredits).get(sub.plan_id) ?? 0;
  if (credits <= 0) return { status: "skipped", reason: "no_credits_for_plan" };
  const period = creditPeriodIndex(sub.created_at, nowMs, config.creditPeriod ?? "month", sub.billing_interval ?? undefined);
  const milli = credits * 1000;
  // The marker is only set after a real grant (or a duplicate of one) for this plan and period: nothing to do.
  if (sub.credits_granted_period === period) return { status: "already_granted", period, milli };
  const result = await config.charger.grant(db, sub.workspace_id, milli, planCreditKey(sub.plan_id, period), `plan credits: ${sub.plan_id} period ${period}`, "system");
  if (!result.ok && result.code !== "IDEMPOTENCY_KEY_REUSED") return { status: "wallet_not_found", period };
  await markGranted(db, sub.workspace_id, sub.plan_id, period);
  return { status: result.ok && !result.duplicate ? "granted" : "already_granted", period, milli };
}

/**
 * Records that `period` is granted for the workspace's current plan, and clears any retry delay. Conditional, so a read
 * that finds the marker already there writes nothing.
 */
async function markGranted(db: D1Like, workspaceId: string, planId: string, period: number): Promise<void> {
  await scoped(db, workspaceId).update(
    "sub_subscriptions",
    { credits_granted_period: period, credits_retry_after: null },
    "plan_id = ? AND (credits_granted_period IS NOT ? OR credits_retry_after IS NOT NULL)",
    [planId, period],
  );
}

/** How long the sweep leaves a workspace whose grant failed before it tries again. */
export const PLAN_CREDIT_RETRY_DELAY_MS = 60 * 60 * 1000;

/** The sweep handles at most this many workspaces per run. */
export const PLAN_CREDIT_SWEEP_LIMIT = 50;

export interface PlanCreditSweepContext {
  controller?: { scheduledTime?: number; cron?: string };
  env: { DB: D1Like; [key: string]: unknown };
  ctx?: unknown;
  dueRows?: unknown[];
  /** The schedule's options, resolved by the assembler (story 1.20): the same settings and charger the routes get. */
  options?: PlanCreditsConfig;
}

export interface PlanCreditSweepResult {
  scanned: number;
  granted: number;
  alreadyGranted: number;
  failed: number;
}

/** SQL: whole months (years) from created_at to the bound `now` (bound once per `?`), as SQLite computes them. */
const MONTHS_ELAPSED =
  "((CAST(strftime('%Y', ?) AS INTEGER) - CAST(strftime('%Y', s.created_at) AS INTEGER)) * 12" +
  " + (CAST(strftime('%m', ?) AS INTEGER) - CAST(strftime('%m', s.created_at) AS INTEGER))" +
  " - (strftime('%d%H%M%f', ?) < strftime('%d%H%M%f', s.created_at)))";
const YEARS_ELAPSED =
  "((CAST(strftime('%Y', ?) AS INTEGER) - CAST(strftime('%Y', s.created_at) AS INTEGER))" +
  " - (strftime('%m%d%H%M%f', ?) < strftime('%m%d%H%M%f', s.created_at)))";

/**
 * Story 1.20: the per-minute schedule. Grants the current period's plan credits to workspaces whose active or trialing
 * subscription, on a plan with credits, has not had them yet: at most PLAN_CREDIT_SWEEP_LIMIT per run, never granted
 * ones first, then the oldest subscriptions. It never creates a subscription (a workspace without one is provisioned,
 * and granted, the first time it is read). A workspace whose grant fails (credit-wallet opens no wallet for a workspace
 * that is not live) is left unmarked and skipped for PLAN_CREDIT_RETRY_DELAY_MS, then tried again.
 */
export async function runPlanCreditSweep(context: PlanCreditSweepContext): Promise<PlanCreditSweepResult> {
  const result: PlanCreditSweepResult = { scanned: 0, granted: 0, alreadyGranted: 0, failed: 0 };
  const config = context.options ?? {};
  const tiers = [...parsePlanCredits(config.planCredits)].filter(([, credits]) => credits > 0).map(([tier]) => tier);
  if (!config.charger || tiers.length === 0) return result;
  const db = context.env.DB;
  const nowMs = context.controller?.scheduledTime ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const yearly = config.creditPeriod === "year";
  const elapsed = yearly ? YEARS_ELAPSED : MONTHS_ELAPSED;
  const nowBinds = yearly ? [nowIso, nowIso] : [nowIso, nowIso, nowIso];
  const rows = (
    await db
      .prepare(
        // tenant-lint: allow the platform schedule finds every workspace whose plan credits are due; each grant and update is then scoped to that row's own workspace
        "SELECT s.workspace_id, s.plan_id, s.status, s.created_at, p.billing_interval FROM sub_subscriptions s LEFT JOIN sub_plans p ON p.id = s.plan_id " +
          `WHERE s.status IN ('active', 'trialing') AND s.plan_id IN (${tiers.map(() => "?").join(", ")}) ` +
          `AND (s.credits_granted_period IS NULL OR (COALESCE(p.billing_interval, 'month') <> 'one_time' AND s.credits_granted_period < ${elapsed})) ` +
          "AND (s.credits_retry_after IS NULL OR s.credits_retry_after <= ?) " +
          "ORDER BY COALESCE(s.credits_granted_period, -1) ASC, s.created_at ASC LIMIT ?",
      )
      .bind(...tiers, ...nowBinds, nowIso, PLAN_CREDIT_SWEEP_LIMIT)
      .all<SubscriptionForCredits>()
  ).results;
  const retryAt = new Date(nowMs + PLAN_CREDIT_RETRY_DELAY_MS).toISOString();
  // Only real grants are marked. A failed one (no wallet can be opened yet, or an error) is retried after a delay, so a
  // few such rows can never fill every run's window.
  const retryLater = (row: SubscriptionForCredits) => scoped(db, row.workspace_id).update("sub_subscriptions", { credits_retry_after: retryAt }, "plan_id = ?", [row.plan_id]);
  for (const row of rows) {
    result.scanned += 1;
    try {
      const outcome = await grantPlanCredits(db, config, row, nowMs);
      if (outcome.status === "granted") result.granted += 1;
      else if (outcome.status === "already_granted") result.alreadyGranted += 1;
      else {
        result.failed += 1;
        await retryLater(row);
      }
    } catch (error) {
      result.failed += 1;
      console.error(JSON.stringify({ brick: "subscription-plans", event: "plan_credit_sweep_error", message: error instanceof Error ? error.message : String(error) }));
      await retryLater(row).catch(() => {});
    }
  }
  return result;
}
