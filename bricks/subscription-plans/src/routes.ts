import { Hono } from "hono";
import { z } from "zod";
import { WORKSPACE_ADMIN_ROLES, platformOperatorRefusal, workspaceRoleRefusal } from "@poc/sdk";
import { PlanService } from "./plans.ts";
import { createPlanEntitlementMiddleware } from "./middleware.ts";
import type { PlanEnv } from "./middleware.ts";
import type { CreditPeriod, PlanCreditCharger, PlanCreditsConfig } from "./credits.ts";

export interface PlanRouteOptions {
  defaultTier?: "free" | "pro" | "enterprise";
  /**
   * Story 1.20: the `planCredits` setting ("free:100,pro:1000"). The assembler passes it, with `creditPeriod` and
   * credit-wallet's `walletCharger` as `charger`, only while it is set; then reading or creating a workspace's
   * subscription grants that plan's credits once per period.
   */
  planCredits?: string;
  creditPeriod?: CreditPeriod;
  charger?: PlanCreditCharger;
}

const ChangePlanSchema = z.object({
  planId: z.string().min(1).max(64),
});

const CancelPlanSchema = z.object({
  immediately: z.boolean().default(false),
});

const CreatePlanSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  priceCents: z.number().int().min(0),
  billingInterval: z.enum(["month", "year", "one_time"]),
  features: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])).default({}),
});

export function createPlanRoutes(options: PlanRouteOptions = {}): Hono<PlanEnv> {
  const app = new Hono<PlanEnv>();
  const credits: PlanCreditsConfig = {
    ...(options.charger ? { charger: options.charger } : {}),
    ...(options.planCredits ? { planCredits: options.planCredits } : {}),
    ...(options.creditPeriod ? { creditPeriod: options.creditPeriod } : {}),
  };
  const planService = (db: PlanEnv["Bindings"]["DB"]) => new PlanService(db, options.defaultTier, credits);

  app.use("*", createPlanEntitlementMiddleware(options.defaultTier, credits));

  // List public plans
  app.get("/plans", async (c) => {
    const service = planService(c.env.DB);
    const plans = await service.listPlans();
    return c.json({ plans }, 200);
  });

  // Create or update a plan definition. Plans and their prices are global (every tenant buys from them), so only a
  // platform operator may write them; no workspace role is enough (audit risk 14).
  app.post("/plans", async (c) => {
    const denied = await platformOperatorRefusal(c.env, c.get("user"), c.get("ctx"));
    if (denied) return c.json(denied.body, denied.status);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreatePlanSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const service = planService(c.env.DB);
    const plan = await service.createPlan(
      parsed.data.id,
      parsed.data.name,
      parsed.data.priceCents,
      parsed.data.billingInterval,
      parsed.data.features
    );

    return c.json({ plan }, 201);
  });

  // Get active subscription for caller's workspace
  app.get("/subscriptions/current", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const service = planService(c.env.DB);
    const sub = await service.getSubscription(workspace.id);
    return c.json({ subscription: sub }, 200);
  });

  // Upgrade or switch plan. Owner/admin only (audit risk 14); a priced plan needs a paid state (story 0.9).
  app.post("/subscriptions/change", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = ChangePlanSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid planId" }, 400);
    }

    const service = planService(c.env.DB);
    const changed = await service.changePlan(workspace.id, parsed.data.planId);
    if (!changed.ok) {
      return c.json({ error: changed.error, code: changed.code }, changed.status);
    }
    return c.json({ subscription: changed.subscription }, 200);
  });

  // Cancel subscription. Owner/admin only (story 0.6).
  app.post("/subscriptions/cancel", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      // Body is optional
    }

    const parsed = CancelPlanSchema.safeParse(body);
    const immediately = parsed.success ? parsed.data.immediately : false;

    const service = planService(c.env.DB);
    const success = await service.cancelSubscription(workspace.id, immediately);
    return c.json({ success }, 200);
  });

  return app;
}
