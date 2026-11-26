import type { D1Like } from "@poc/sdk";
import { scoped } from "@poc/sdk";
import { grantPlanCredits } from "./credits.ts";
import type { PlanCreditsConfig } from "./credits.ts";

export interface PlanFeatures {
  [key: string]: boolean | number | string;
}

export interface PlanRecord {
  id: string;
  name: string;
  price_cents: number;
  billing_interval: "month" | "year" | "one_time";
  features: PlanFeatures;
  created_at: string;
}

export interface SubscriptionRecord {
  workspace_id: string;
  plan_id: string;
  status: "active" | "past_due" | "canceled" | "trialing";
  current_period_end: string;
  cancel_at_period_end: boolean;
  plan?: PlanRecord;
  created_at: string;
  updated_at: string;
}

export class PlanService {
  /**
   * `credits` (story 1.20): the plan credit settings and credit-wallet's charger. With them, reading or creating a
   * subscription grants the current period's plan credits once (see credits.ts); without them nothing is granted.
   */
  constructor(
    private readonly db: D1Like,
    private readonly defaultTier = "free",
    private readonly credits: PlanCreditsConfig = {},
  ) {}

  /** Story 1.20: clears the sweep's marker when plan credits are on (with them off nothing reads or writes it). */
  private resetCreditsMarker(): { credits_granted_period?: null } {
    return this.credits.charger && this.credits.planCredits ? { credits_granted_period: null } : {};
  }

  /**
   * Story 1.20: grants the current period's plan credits for the workspace's subscription, if any are due. Never fails
   * the caller: a grant that cannot be made is logged and retried by the next read or the schedule sweep.
   */
  private async grantCurrentPeriod(sub: { workspace_id: string; plan_id: string; status: string; created_at: string; plan?: PlanRecord | null; credits_granted_period?: number | null }): Promise<void> {
    if (!this.credits.charger || !this.credits.planCredits) return;
    try {
      await grantPlanCredits(this.db, this.credits, { ...sub, billing_interval: sub.plan?.billing_interval ?? null }, Date.now());
    } catch (error) {
      console.error(JSON.stringify({ brick: "subscription-plans", event: "plan_credit_grant_error", message: error instanceof Error ? error.message : String(error) }));
    }
  }

  /**
   * Defines a subscription plan with pricing and feature flags.
   */
  async createPlan(
    id: string,
    name: string,
    priceCents: number,
    billingInterval: "month" | "year" | "one_time",
    features: PlanFeatures = {}
  ): Promise<PlanRecord> {
    const planId = id.trim().toLowerCase();
    const planName = name.trim();
    const featuresJson = JSON.stringify(features);

    await this.db.prepare(`
      INSERT INTO sub_plans (id, name, price_cents, billing_interval, features_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name,
        price_cents = excluded.price_cents,
        billing_interval = excluded.billing_interval,
        features_json = excluded.features_json
    `).bind(planId, planName, priceCents, billingInterval, featuresJson).run();

    return {
      id: planId,
      name: planName,
      price_cents: priceCents,
      billing_interval: billingInterval,
      features,
      created_at: new Date().toISOString(),
    };
  }

  /**
   * Lists all public plans.
   */
  async listPlans(): Promise<PlanRecord[]> {
    interface Row {
      id: string;
      name: string;
      price_cents: number;
      billing_interval: "month" | "year" | "one_time";
      features_json: string;
      created_at: string;
    }
    const rows = (await this.db.prepare(
      "SELECT id, name, price_cents, billing_interval, features_json, created_at FROM sub_plans ORDER BY price_cents ASC"
    ).all<Row>()).results;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      price_cents: r.price_cents,
      billing_interval: r.billing_interval,
      features: JSON.parse(r.features_json || "{}"),
      created_at: r.created_at,
    }));
  }

  /**
   * Retrieves plan details by ID.
   */
  async getPlan(planId: string): Promise<PlanRecord | null> {
    interface Row {
      id: string;
      name: string;
      price_cents: number;
      billing_interval: "month" | "year" | "one_time";
      features_json: string;
      created_at: string;
    }
    const row = await this.db.prepare(
      "SELECT id, name, price_cents, billing_interval, features_json, created_at FROM sub_plans WHERE id = ?"
    ).bind(planId.toLowerCase()).first<Row>();

    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      price_cents: row.price_cents,
      billing_interval: row.billing_interval,
      features: JSON.parse(row.features_json || "{}"),
      created_at: row.created_at,
    };
  }

  /**
   * Retrieves the current active subscription for a workspace, creating default free subscription if none exists.
   */
  async getSubscription(workspaceId: string): Promise<SubscriptionRecord> {
    interface SubRow {
      workspace_id: string;
      plan_id: string;
      status: "active" | "past_due" | "canceled" | "trialing";
      current_period_end: string;
      cancel_at_period_end: number;
      created_at: string;
      updated_at: string;
      credits_granted_period?: number | null;
    }

    const sub = await scoped(this.db, workspaceId).first<SubRow>("sub_subscriptions");

    if (sub) {
      const plan = await this.getPlan(sub.plan_id);
      await this.grantCurrentPeriod({ ...sub, plan });
      return {
        workspace_id: sub.workspace_id,
        plan_id: sub.plan_id,
        status: sub.status,
        current_period_end: sub.current_period_end,
        cancel_at_period_end: sub.cancel_at_period_end === 1,
        plan: plan || undefined,
        created_at: sub.created_at,
        updated_at: sub.updated_at,
      };
    }

    // Provision default subscription
    return this.subscribe(workspaceId, this.defaultTier, 3650); // 10 years free tier
  }

  /**
   * True when the workspace is in a paid state: a stored subscription that is `active`, not scheduled to
   * cancel, whose current period has not ended, on a plan priced above zero. A default free subscription,
   * a lapsed one or one set to cancel is not a paid state.
   */
  async isPaid(workspaceId: string): Promise<boolean> {
    return (await this.paidSubscription(workspaceId)) !== null;
  }

  private async paidSubscription(
    workspaceId: string,
  ): Promise<{ plan_id: string; price_cents: number } | null> {
    const sub = await scoped(this.db, workspaceId).first<{
      plan_id: string;
      status: string;
      current_period_end: string;
      cancel_at_period_end: number;
    }>("sub_subscriptions");
    if (!sub || sub.status !== "active" || sub.cancel_at_period_end === 1) return null;
    const periodEnd = Date.parse(sub.current_period_end);
    if (!Number.isFinite(periodEnd) || periodEnd <= Date.now()) return null;
    const plan = await this.getPlan(sub.plan_id);
    if (!plan || plan.price_cents <= 0) return null;
    return { plan_id: plan.id, price_cents: plan.price_cents };
  }

  /**
   * A caller-requested plan switch (story 0.9, audit risk 14). There is no payment path yet (Phase 2), so:
   * - a zero-price plan grants nothing paid and stays switchable;
   * - a priced plan needs a paid state, and may cost at most what the current paid plan costs (an upgrade
   *   would need a payment, so it is refused with 402);
   * - a switch between paid plans keeps the current period end and cancel flag: changing plan never renews.
   */
  async changePlan(
    workspaceId: string,
    planIdRaw: string,
  ): Promise<
    | { ok: true; subscription: SubscriptionRecord }
    | { ok: false; status: 402; code: "PAYMENT_REQUIRED"; error: string }
    | { ok: false; status: 404; code: "PLAN_NOT_FOUND"; error: string }
  > {
    const planId = planIdRaw.toLowerCase().trim();
    const target = await this.getPlan(planId);
    if (!target && planId !== this.defaultTier) {
      // Story 1.20: only a platform operator creates plans (POST /plans). A self-serve switch to a plan id that does not
      // exist would otherwise create it at price 0, and with plan credits on, grant that tier's credits.
      return {
        ok: false,
        status: 404,
        code: "PLAN_NOT_FOUND",
        error: `There is no plan "${planId}", so the plan was not changed.`,
      };
    }
    if (!target || target.price_cents <= 0) {
      return { ok: true, subscription: await this.subscribe(workspaceId, planId) };
    }
    const paid = await this.paidSubscription(workspaceId);
    if (!paid) {
      return {
        ok: false,
        status: 402,
        code: "PAYMENT_REQUIRED",
        error: `Switching to plan "${target.id}" needs an active paid subscription. This workspace has none, and no payment checkout is available yet, so the plan was not changed.`,
      };
    }
    if (target.price_cents > paid.price_cents) {
      return {
        ok: false,
        status: 402,
        code: "PAYMENT_REQUIRED",
        error: `Upgrading to plan "${target.id}" costs more than the current plan and needs a payment, which is not available yet, so the plan was not changed.`,
      };
    }
    await scoped(this.db, workspaceId).update("sub_subscriptions", {
      plan_id: target.id,
      // Story 1.20: the new plan's credits for this period are not granted yet (the ledger key still stops a repeat).
      ...this.resetCreditsMarker(),
      updated_at: new Date().toISOString(),
    });
    return { ok: true, subscription: await this.getSubscription(workspaceId) };
  }

  /**
   * Assigns or upgrades a workspace to a plan.
   */
  async subscribe(workspaceId: string, planIdRaw: string, durationDays = 30): Promise<SubscriptionRecord> {
    const planId = planIdRaw.toLowerCase().trim();
    let plan = await this.getPlan(planId);
    if (!plan) {
      // Auto-create stub if default plan doesn't exist yet
      plan = await this.createPlan(planId, planId.toUpperCase(), 0, "month", {});
    }

    const periodEnd = new Date(Date.now() + durationDays * 86400 * 1000).toISOString();
    const now = new Date().toISOString();

    const update = () =>
      scoped(this.db, workspaceId).update("sub_subscriptions", {
        plan_id: plan.id,
        status: "active",
        current_period_end: periodEnd,
        cancel_at_period_end: 0,
        // Story 1.20: the (possibly new) plan's credits for this period are not marked granted yet.
        ...this.resetCreditsMarker(),
        updated_at: now,
      });
    const existing = await scoped(this.db, workspaceId).first("sub_subscriptions");
    if (existing) {
      await update();
    } else {
      try {
        await scoped(this.db, workspaceId).insert("sub_subscriptions", {
          plan_id: plan.id,
          status: "active",
          current_period_end: periodEnd,
          cancel_at_period_end: 0,
          created_at: now,
          updated_at: now,
        });
      } catch (error) {
        // Two first reads of a workspace can both find no row; the one that loses the insert updates the row instead.
        if (!/UNIQUE|constraint/i.test(error instanceof Error ? error.message : String(error))) throw error;
        await update();
      }
    }

    // The period is counted from the row's own created_at, which an existing subscription keeps.
    const stored = await scoped(this.db, workspaceId).first<{ created_at: string }>("sub_subscriptions");
    const createdAt = stored?.created_at ?? now;
    await this.grantCurrentPeriod({ workspace_id: workspaceId, plan_id: plan.id, status: "active", created_at: createdAt, plan });

    return {
      workspace_id: workspaceId,
      plan_id: plan.id,
      status: "active",
      current_period_end: periodEnd,
      cancel_at_period_end: false,
      plan,
      created_at: createdAt,
      updated_at: now,
    };
  }

  /**
   * Cancels a workspace's subscription (at period end or immediately).
   */
  async cancelSubscription(workspaceId: string, immediately = false): Promise<boolean> {
    const now = new Date().toISOString();
    const result = immediately
      ? await scoped(this.db, workspaceId).update("sub_subscriptions", {
          status: "canceled",
          updated_at: now,
        })
      : await scoped(this.db, workspaceId).update("sub_subscriptions", {
          cancel_at_period_end: 1,
          updated_at: now,
        });

    return result.meta.changes > 0;
  }

  /**
   * Checks whether a specific feature is enabled for the workspace.
   */
  async hasFeature(workspaceId: string, featureKey: string): Promise<boolean> {
    const sub = await this.getSubscription(workspaceId);
    if (sub.status !== "active" && sub.status !== "trialing") return false;
    if (!sub.plan) return false;

    const val = sub.plan.features[featureKey];
    return val === true || (typeof val === "number" && val > 0);
  }

  /**
   * Retrieves numerical quota (e.g. max_members, storage_gb) for the workspace.
   */
  async getQuota(workspaceId: string, featureKey: string): Promise<number | null> {
    const sub = await this.getSubscription(workspaceId);
    if (!sub.plan) return null;
    const val = sub.plan.features[featureKey];
    return typeof val === "number" ? val : null;
  }
}
