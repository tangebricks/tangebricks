import { Hono } from "hono";
import { z } from "zod";
import { UserOnboardingService } from "./onboarding.ts";
import { onboardingMiddleware, type OnboardingEnv } from "./middleware.ts";

const StepSchema = z.object({
  stepKey: z.string().min(1).max(64),
  title: z.string().min(1).max(128),
  description: z.string().max(500).optional(),
  actionUrl: z.string().optional(),
  isOptional: z.boolean().optional(),
});

const CreateFlowSchema = z.object({
  key: z.string().min(1).max(64),
  title: z.string().min(1).max(128),
  description: z.string().max(500).optional(),
  steps: z.array(StepSchema).min(1),
  isActive: z.boolean().optional(),
});

export function createOnboardingRoutes(): Hono<OnboardingEnv> {
  const app = new Hono<OnboardingEnv>();

  app.use("*", onboardingMiddleware);

  // POST /onboarding/flows - Register or update flow
  app.post("/onboarding/flows", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateFlowSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("onboardingService") || new UserOnboardingService(c.env.DB);
    const flow = await service.createFlow({
      workspaceId,
      key: parsed.data.key,
      title: parsed.data.title,
      description: parsed.data.description,
      steps: parsed.data.steps,
      isActive: parsed.data.isActive,
    });

    return c.json(flow, 201);
  });

  // GET /onboarding/flows - List flows
  app.get("/onboarding/flows", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const service = c.get("onboardingService") || new UserOnboardingService(c.env.DB);
    const flows = await service.listFlows(workspaceId);
    return c.json({ flows });
  });

  // GET /onboarding/flows/:key - Get flow definition
  app.get("/onboarding/flows/:key", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const key = c.req.param("key");
    const service = c.get("onboardingService") || new UserOnboardingService(c.env.DB);
    const flow = await service.getFlow(workspaceId, key);
    if (!flow) {
      return c.json({ error: "Flow not found" }, 404);
    }

    return c.json(flow);
  });

  // GET /onboarding/flows/:key/progress - Get user progress
  app.get("/onboarding/flows/:key/progress", async (c) => {
    const user = c.get("user");
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;
    const userId = c.req.query("userId") || user?.uid;

    if (!userId) {
      return c.json({ error: "userId is required" }, 400);
    }

    const key = c.req.param("key");
    const service = c.get("onboardingService") || new UserOnboardingService(c.env.DB);
    try {
      const progress = await service.getUserProgress(workspaceId, key, userId);
      return c.json(progress);
    } catch (e: any) {
      return c.json({ error: e.message || "Progress retrieval failed" }, 404);
    }
  });

  // POST /onboarding/flows/:key/steps/:stepKey/complete - Complete step
  app.post("/onboarding/flows/:key/steps/:stepKey/complete", async (c) => {
    const user = c.get("user");
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);

    let body: { userId?: string } = {};
    try {
      body = (await c.req.json()) || {};
    } catch {
      // Body optional
    }

    const workspaceId = ctx.workspaceId;
    const userId = body.userId || c.req.query("userId") || user?.uid;

    if (!userId) {
      return c.json({ error: "userId is required" }, 400);
    }

    const key = c.req.param("key");
    const stepKey = c.req.param("stepKey");
    const service = c.get("onboardingService") || new UserOnboardingService(c.env.DB);

    try {
      const updated = await service.completeStep(workspaceId, key, userId, stepKey);
      return c.json(updated);
    } catch (e: any) {
      return c.json({ error: e.message || "Failed to complete step" }, 400);
    }
  });

  // POST /onboarding/flows/:key/dismiss - Dismiss flow
  app.post("/onboarding/flows/:key/dismiss", async (c) => {
    const user = c.get("user");
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);

    let body: { userId?: string } = {};
    try {
      body = (await c.req.json()) || {};
    } catch {
      // Body optional
    }

    const workspaceId = ctx.workspaceId;
    const userId = body.userId || c.req.query("userId") || user?.uid;

    if (!userId) {
      return c.json({ error: "userId is required" }, 400);
    }

    const key = c.req.param("key");
    const service = c.get("onboardingService") || new UserOnboardingService(c.env.DB);

    try {
      const dismissed = await service.dismissFlow(workspaceId, key, userId);
      return c.json(dismissed);
    } catch (e: any) {
      return c.json({ error: e.message || "Failed to dismiss flow" }, 404);
    }
  });

  // POST /onboarding/flows/:key/reset - Reset progress
  app.post("/onboarding/flows/:key/reset", async (c) => {
    const user = c.get("user");
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);

    let body: { userId?: string } = {};
    try {
      body = (await c.req.json()) || {};
    } catch {
      // Body optional
    }

    const workspaceId = ctx.workspaceId;
    const userId = body.userId || c.req.query("userId") || user?.uid;

    if (!userId) {
      return c.json({ error: "userId is required" }, 400);
    }

    const key = c.req.param("key");
    const service = c.get("onboardingService") || new UserOnboardingService(c.env.DB);

    try {
      const reset = await service.resetFlowProgress(workspaceId, key, userId);
      return c.json(reset);
    } catch (e: any) {
      return c.json({ error: e.message || "Failed to reset flow" }, 404);
    }
  });

  // GET /onboarding/flows/:key/analytics - Get TTFV & activation metrics
  app.get("/onboarding/flows/:key/analytics", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const key = c.req.param("key");
    const service = c.get("onboardingService") || new UserOnboardingService(c.env.DB);
    try {
      const metrics = await service.getFlowAnalytics(workspaceId, key);
      return c.json(metrics);
    } catch (e: any) {
      return c.json({ error: e.message || "Failed to calculate analytics" }, 404);
    }
  });

  return app;
}
