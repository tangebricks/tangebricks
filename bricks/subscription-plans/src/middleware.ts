import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { PlanService } from "./plans.ts";
import type { SubscriptionRecord } from "./plans.ts";
import type { PlanCreditsConfig } from "./credits.ts";

export interface PlanContext {
  subscription: SubscriptionRecord;
  hasFeature: (key: string) => Promise<boolean>;
  getQuota: (key: string) => Promise<number | null>;
}

export interface PlanEnv {
  Bindings: { DB: D1Like; PX_PLATFORM_OPERATORS?: string };
  Variables: {
    user?: { uid: string; email?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified request context set by the workspace middleware; the only source of the caller's role. */
    ctx?: RequestContext;
    plan?: PlanContext;
  };
}

/**
 * Attaches the subscription and plan entitlement context to the Hono request. Story 1.20: built with the brick's
 * default tier and plan credit settings, so the read that provisions a workspace's subscription also grants its credits.
 */
export function createPlanEntitlementMiddleware(defaultTier?: string, credits?: PlanCreditsConfig): MiddlewareHandler<PlanEnv> {
  return async (c, next) => {
    const workspace = c.get("workspace");
    if (workspace) {
      const service = new PlanService(c.env.DB, defaultTier, credits);
      const sub = await service.getSubscription(workspace.id);
      c.set("plan", {
        subscription: sub,
        hasFeature: (key: string) => service.hasFeature(workspace.id, key),
        getQuota: (key: string) => service.getQuota(workspace.id, key),
      });
    }
    await next();
  };
}

/**
 * Attaches the subscription and plan entitlement context to the Hono request (default tier "free", no plan credits).
 */
export const planEntitlementMiddleware: MiddlewareHandler<PlanEnv> = async (c, next) => {
  const workspace = c.get("workspace");
  if (workspace) {
    const service = new PlanService(c.env.DB);
    const sub = await service.getSubscription(workspace.id);
    c.set("plan", {
      subscription: sub,
      hasFeature: (key: string) => service.hasFeature(workspace.id, key),
      getQuota: (key: string) => service.getQuota(workspace.id, key),
    });
  }
  await next();
};

/**
 * Guards a route: requires that the workspace's plan has the specified feature enabled.
 */
export function requireFeature(featureKey: string): MiddlewareHandler<PlanEnv> {
  return async (c, next) => {
    const workspace = c.get("workspace");
    if (!workspace) {
      return c.json({ error: "Missing workspace context" }, 400);
    }

    const service = new PlanService(c.env.DB);
    const allowed = await service.hasFeature(workspace.id, featureKey);
    if (!allowed) {
      return c.json(
        {
          error: "Feature not available on current plan",
          requiredFeature: featureKey,
        },
        403,
      );
    }

    await next();
  };
}
