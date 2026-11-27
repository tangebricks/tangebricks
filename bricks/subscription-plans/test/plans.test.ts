import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_subscription_plans.sql?raw";
import { createPlanRoutes, PlanService, requireFeature } from "../src/index.ts";
import type { PlanEnv } from "../src/middleware.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_alpha_123";
const WS_BETA = "ws_beta_456";

async function resetDb(): Promise<void> {
  for (const table of ["sub_subscriptions", "sub_plans"]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Subscription Plans & Feature Entitlements Core Engine", () => {
  it("defines plans with pricing, interval, and custom feature flags", async () => {
    const service = new PlanService(db);
    const plan = await service.createPlan("pro", "Pro Tier", 2900, "month", {
      advanced_ai: true,
      max_members: 20,
      storage_gb: 100,
    });

    expect(plan.id).toBe("pro");
    expect(plan.price_cents).toBe(2900);
    expect(plan.features.advanced_ai).toBe(true);

    const retrieved = await service.getPlan("pro");
    expect(retrieved?.name).toBe("Pro Tier");
    expect(retrieved?.features.max_members).toBe(20);
  });

  it("automatically provisions default free subscription for new workspace", async () => {
    const service = new PlanService(db, "free");
    await service.createPlan("free", "Free Tier", 0, "month", {
      max_members: 3,
      advanced_ai: false,
    });

    const sub = await service.getSubscription(WS_ALPHA);
    expect(sub.workspace_id).toBe(WS_ALPHA);
    expect(sub.plan_id).toBe("free");
    expect(sub.status).toBe("active");

    // Check entitlements
    expect(await service.hasFeature(WS_ALPHA, "advanced_ai")).toBe(false);
    expect(await service.getQuota(WS_ALPHA, "max_members")).toBe(3);
  });

  it("upgrades workspace to Pro plan and unlocks premium features", async () => {
    const service = new PlanService(db, "free");
    await service.createPlan("free", "Free Tier", 0, "month", { advanced_ai: false, storage_gb: 5 });
    await service.createPlan("pro", "Pro Tier", 2900, "month", { advanced_ai: true, storage_gb: 100 });

    // Initially Free
    expect(await service.hasFeature(WS_ALPHA, "advanced_ai")).toBe(false);

    // Upgrade to Pro
    const upgraded = await service.subscribe(WS_ALPHA, "pro");
    expect(upgraded.plan_id).toBe("pro");
    expect(upgraded.status).toBe("active");

    // Features updated
    expect(await service.hasFeature(WS_ALPHA, "advanced_ai")).toBe(true);
    expect(await service.getQuota(WS_ALPHA, "storage_gb")).toBe(100);
  });

  it("enforces multi-tenant isolation: upgrading Workspace A leaves Workspace B on Free", async () => {
    const service = new PlanService(db, "free");
    await service.createPlan("free", "Free Tier", 0, "month", { export_pdf: false });
    await service.createPlan("enterprise", "Enterprise Tier", 9900, "month", { export_pdf: true });

    // Upgrade Workspace Alpha only
    await service.subscribe(WS_ALPHA, "enterprise");

    // Workspace Alpha has feature
    expect(await service.hasFeature(WS_ALPHA, "export_pdf")).toBe(true);

    // Workspace Beta MUST NOT have feature
    expect(await service.hasFeature(WS_BETA, "export_pdf")).toBe(false);
  });

  it("cancels subscription gracefully at period end or immediately", async () => {
    const service = new PlanService(db);
    await service.subscribe(WS_ALPHA, "pro");

    // Cancel at period end
    await service.cancelSubscription(WS_ALPHA, false);
    let sub = await service.getSubscription(WS_ALPHA);
    expect(sub.cancel_at_period_end).toBe(true);
    expect(sub.status).toBe("active"); // Still active until period ends

    // Cancel immediately
    await service.cancelSubscription(WS_ALPHA, true);
    sub = await service.getSubscription(WS_ALPHA);
    expect(sub.status).toBe("canceled");
    expect(await service.hasFeature(WS_ALPHA, "pro_feature")).toBe(false);
  });
});

describe("Subscription Route Handlers & requireFeature Guard", () => {
  const createApp = (wsId = WS_ALPHA, role: string | null = "owner", userId = "usr_plans") => {
    const app = new Hono<PlanEnv>();

    // Mock workspace context (role null = nobody signed in)
    app.use("*", async (c, next) => {
      if (role) {
        c.set("user", { uid: userId });
        c.set("workspace", { id: wsId, role });
        c.set("ctx", Object.freeze({ userId, workspaceId: wsId, role }));
      }
      await next();
    });

    app.route("/api", createPlanRoutes());

    // Protected feature endpoint
    app.get("/api/ai/deep-analysis", requireFeature("deep_ai"), (c) => c.json({ result: "deep_ai_analysis_complete" }, 200));

    return app;
  };

  it("blocks requests with 403 Forbidden when workspace lacks required feature", async () => {
    const service = new PlanService(db, "free");
    await service.createPlan("free", "Free", 0, "month", { deep_ai: false });
    await service.subscribe(WS_ALPHA, "free");

    const app = createApp(WS_ALPHA);
    const res = await app.fetch(new Request("http://localhost/api/ai/deep-analysis"), { DB: db });

    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string; requiredFeature: string };
    expect(json.error).toBe("Feature not available on current plan");
    expect(json.requiredFeature).toBe("deep_ai");
  });

  it("allows access with 200 OK after upgrading to a plan containing the feature", async () => {
    const service = new PlanService(db, "free");
    await service.createPlan("free", "Free", 0, "month", { deep_ai: false });
    await service.createPlan("ai_pro", "AI Pro", 4900, "month", { deep_ai: true });
    await service.createPlan("business", "Business", 9900, "month", { deep_ai: false });
    // Story 0.9: a switch to a priced plan needs a paid state and may not cost more than the current plan
    // (an upgrade needs a payment, Phase 2). The workspace is on paid Business and moves to AI Pro.
    await service.subscribe(WS_ALPHA, "business");

    const app = createApp(WS_ALPHA);

    // Upgrade via POST /api/subscriptions/change
    const upgradeRes = await app.fetch(
      new Request("http://localhost/api/subscriptions/change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: "ai_pro" }),
      }),
      { DB: db },
    );
    expect(upgradeRes.status).toBe(200);

    // Call protected endpoint now -> 200 OK
    const res = await app.fetch(new Request("http://localhost/api/ai/deep-analysis"), { DB: db });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result: string };
    expect(json.result).toBe("deep_ai_analysis_complete");
  });

  describe("authorisation (story 0.6, audit risk 14)", () => {
    const post = (path: string, body: string) =>
      new Request(`http://localhost/api/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    const planBody = JSON.stringify({ id: "pro", name: "Pro", priceCents: 1, billingInterval: "month" });

    it("POST /plans: OPERATOR_WRITE 201; NON_OPERATOR_WRITE (owner) 403; NO_OPERATORS_CONFIGURED 403; UNAUTH 401", async () => {
      const service = new PlanService(db, "free");
      const ops = { DB: db, PX_PLATFORM_OPERATORS: "usr_op" };
      expect((await createApp(WS_ALPHA, null).fetch(post("plans", planBody), ops)).status).toBe(401);
      expect((await createApp(WS_ALPHA, "owner", "usr_owner").fetch(post("plans", planBody), ops)).status).toBe(403);
      expect((await createApp(WS_ALPHA, "owner", "usr_owner").fetch(post("plans", "{bad"), ops)).status).toBe(403);
      expect((await createApp(WS_ALPHA, "owner", "usr_op").fetch(post("plans", planBody), { DB: db })).status).toBe(403);
      // (The default free plan is provisioned by the entitlement middleware; only the written plan matters here.)
      expect((await service.listPlans()).map((p) => p.id)).not.toContain("pro");
      expect((await createApp(WS_ALPHA, "member", "usr_op").fetch(post("plans", planBody), ops)).status).toBe(201);
      expect((await service.listPlans()).find((p) => p.id === "pro")?.price_cents).toBe(1);
    });

    it("POST /subscriptions/change: UNAUTH 401, MEMBER 403 (before validation), ADMIN 200", async () => {
      const service = new PlanService(db, "free");
      await service.createPlan("free", "Free", 0, "month", {});
      await service.createPlan("starter", "Starter", 900, "month", {});
      await service.createPlan("pro", "Pro", 4900, "month", {});
      // A paid state on a dearer plan (story 0.9) so the role checks are what decides here.
      await service.subscribe(WS_ALPHA, "pro");
      const change = JSON.stringify({ planId: "starter" });
      expect((await createApp(WS_ALPHA, null).fetch(post("subscriptions/change", change), { DB: db })).status).toBe(401);
      expect((await createApp(WS_ALPHA, "member").fetch(post("subscriptions/change", change), { DB: db })).status).toBe(403);
      expect((await createApp(WS_ALPHA, "member").fetch(post("subscriptions/change", "{bad"), { DB: db })).status).toBe(403);
      expect((await service.getSubscription(WS_ALPHA)).plan_id).toBe("pro");
      expect((await createApp(WS_ALPHA, "admin").fetch(post("subscriptions/change", change), { DB: db })).status).toBe(200);
      expect((await service.getSubscription(WS_ALPHA)).plan_id).toBe("starter");
    });

    it("POST /subscriptions/cancel: UNAUTH 401, MEMBER 403, ADMIN 200", async () => {
      const service = new PlanService(db, "free");
      await service.createPlan("free", "Free", 0, "month", {});
      await service.createPlan("pro", "Pro", 4900, "month", {});
      await service.subscribe(WS_ALPHA, "pro");
      const cancel = JSON.stringify({ immediately: true });
      expect((await createApp(WS_ALPHA, null).fetch(post("subscriptions/cancel", cancel), { DB: db })).status).toBe(401);
      expect((await createApp(WS_ALPHA, "member").fetch(post("subscriptions/cancel", cancel), { DB: db })).status).toBe(403);
      expect((await service.getSubscription(WS_ALPHA)).status).toBe("active");
      expect((await createApp(WS_ALPHA, "admin").fetch(post("subscriptions/cancel", cancel), { DB: db })).status).toBe(200);
    });
  });

  describe("payment gating (story 0.9, audit risk 14)", () => {
    const post = (body: string) =>
      new Request("http://localhost/api/subscriptions/change", { method: "POST", headers: { "Content-Type": "application/json" }, body });

    it("SUB_CHANGE_UNPAID: a workspace on the default free plan cannot switch to a priced plan (402, plan unchanged)", async () => {
      const service = new PlanService(db, "free");
      await service.createPlan("free", "Free", 0, "month", {});
      await service.createPlan("pro", "Pro", 4900, "month", { deep_ai: true });
      await service.subscribe(WS_ALPHA, "free");
      const res = await createApp(WS_ALPHA, "owner").fetch(post(JSON.stringify({ planId: "pro" })), { DB: db });
      expect(res.status).toBe(402);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe("PAYMENT_REQUIRED");
      expect(body.error).toMatch(/needs an active paid subscription/);
      expect((await service.getSubscription(WS_ALPHA)).plan_id).toBe("free");
      expect(await service.hasFeature(WS_ALPHA, "deep_ai")).toBe(false);
    });

    it("SUB_CHANGE_UNPAID: a canceled paid subscription is not a paid state (402)", async () => {
      const service = new PlanService(db, "free");
      await service.createPlan("starter", "Starter", 900, "month", {});
      await service.createPlan("pro", "Pro", 4900, "month", {});
      await service.subscribe(WS_ALPHA, "starter");
      await service.cancelSubscription(WS_ALPHA, true);
      const res = await createApp(WS_ALPHA, "owner").fetch(post(JSON.stringify({ planId: "pro" })), { DB: db });
      expect(res.status).toBe(402);
      expect((await service.getSubscription(WS_ALPHA)).plan_id).toBe("starter");
    });

    it("SUB_CHANGE_UNPAID: a lapsed paid subscription (period ended) is not a paid state (402)", async () => {
      const service = new PlanService(db, "free");
      await service.createPlan("starter", "Starter", 900, "month", {});
      await service.createPlan("pro", "Pro", 4900, "month", {});
      await service.subscribe(WS_ALPHA, "pro");
      await db
        .prepare("UPDATE sub_subscriptions SET current_period_end = ? WHERE workspace_id = ?")
        .bind(new Date(Date.now() - 1000).toISOString(), WS_ALPHA)
        .run();
      expect(await service.isPaid(WS_ALPHA)).toBe(false);
      const res = await createApp(WS_ALPHA, "owner").fetch(post(JSON.stringify({ planId: "starter" })), { DB: db });
      expect(res.status).toBe(402);
      expect((await service.getSubscription(WS_ALPHA)).plan_id).toBe("pro");
    });

    it("SUB_CHANGE_UNPAID: a subscription scheduled to cancel is not a paid state (402)", async () => {
      const service = new PlanService(db, "free");
      await service.createPlan("starter", "Starter", 900, "month", {});
      await service.createPlan("pro", "Pro", 4900, "month", {});
      await service.subscribe(WS_ALPHA, "pro");
      await service.cancelSubscription(WS_ALPHA, false);
      expect(await service.isPaid(WS_ALPHA)).toBe(false);
      const res = await createApp(WS_ALPHA, "owner").fetch(post(JSON.stringify({ planId: "starter" })), { DB: db });
      expect(res.status).toBe(402);
    });

    it("SUB_CHANGE_UNPAID: an upgrade to a dearer plan needs a payment (402), even from a paid state", async () => {
      const service = new PlanService(db, "free");
      await service.createPlan("starter", "Starter", 900, "month", {});
      await service.createPlan("pro", "Pro", 4900, "month", {});
      await service.subscribe(WS_ALPHA, "starter");
      expect(await service.isPaid(WS_ALPHA)).toBe(true);
      const res = await createApp(WS_ALPHA, "owner").fetch(post(JSON.stringify({ planId: "pro" })), { DB: db });
      expect(res.status).toBe(402);
      expect(((await res.json()) as { code: string }).code).toBe("PAYMENT_REQUIRED");
      expect((await service.getSubscription(WS_ALPHA)).plan_id).toBe("starter");
    });

    it("SUB_CHANGE_PAID: a paid workspace can switch to a same- or lower-priced plan, and the period is not extended", async () => {
      const service = new PlanService(db, "free");
      await service.createPlan("starter", "Starter", 900, "month", {});
      await service.createPlan("starter_b", "Starter B", 900, "month", {});
      await service.createPlan("pro", "Pro", 4900, "month", {});
      await service.subscribe(WS_ALPHA, "pro");
      const periodEnd = new Date(Date.now() + 5 * 86400 * 1000).toISOString();
      await db.prepare("UPDATE sub_subscriptions SET current_period_end = ? WHERE workspace_id = ?").bind(periodEnd, WS_ALPHA).run();

      for (const planId of ["starter", "starter_b", "starter_b"]) {
        const res = await createApp(WS_ALPHA, "owner").fetch(post(JSON.stringify({ planId })), { DB: db });
        expect(res.status, planId).toBe(200);
        const sub = await service.getSubscription(WS_ALPHA);
        expect(sub.plan_id).toBe(planId);
        expect(sub.current_period_end).toBe(periodEnd);
        expect(sub.cancel_at_period_end).toBe(false);
        expect(sub.status).toBe("active");
      }
    });
  });
});
