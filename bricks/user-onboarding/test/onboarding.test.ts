import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_user_onboarding.sql?raw";
import {
  UserOnboardingService,
  createOnboardingRoutes,
} from "../src/index.ts";
import type { OnboardingEnv } from "../src/middleware.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_onb_alpha";
const WS_BETA = "ws_onb_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS onb_user_progress").run();
  await db.prepare("DROP TABLE IF EXISTS onb_flows").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("User Onboarding Core Service", () => {
  it("creates flows, tracks step completions, and calculates TTFV analytics", async () => {
    const service = new UserOnboardingService(db);

    // 1. Create Onboarding Flow
    const flow = await service.createFlow({
      workspaceId: WS_ALPHA,
      key: "activation_checklist",
      title: "Get Started with CloudEdge",
      description: "Complete these steps to set up your edge environment",
      steps: [
        { stepKey: "create_project", title: "Create your first project" },
        { stepKey: "invite_colleague", title: "Invite a team member" },
        { stepKey: "deploy_worker", title: "Deploy your first worker" },
        { stepKey: "connect_custom_domain", title: "Connect custom domain", isOptional: true },
      ],
    });

    expect(flow.id).toMatch(/^flow_[a-f0-9]{32}$/);
    expect(flow.steps).toHaveLength(4);

    // 2. Initial progress for user
    const p0 = await service.getUserProgress(WS_ALPHA, "activation_checklist", "usr_alice");
    expect(p0.completed_steps).toHaveLength(0);
    expect(p0.percent_complete).toBe(0);
    expect(p0.is_completed).toBe(false);

    // 3. Complete Step 1
    const p1 = await service.completeStep(WS_ALPHA, "activation_checklist", "usr_alice", "create_project");
    expect(p1.completed_steps).toEqual(["create_project"]);
    expect(p1.percent_complete).toBe(25);
    expect(p1.is_completed).toBe(false);

    // 4. Complete Step 2
    const p2 = await service.completeStep(WS_ALPHA, "activation_checklist", "usr_alice", "invite_colleague");
    expect(p2.percent_complete).toBe(50);

    // 5. Complete Step 3 (all required steps done!)
    const p3 = await service.completeStep(WS_ALPHA, "activation_checklist", "usr_alice", "deploy_worker");
    expect(p3.percent_complete).toBe(75);
    expect(p3.is_completed).toBe(true);
    expect(p3.completed_at).not.toBeNull();

    // 6. Dismiss flow
    const pDismiss = await service.dismissFlow(WS_ALPHA, "activation_checklist", "usr_alice");
    expect(pDismiss.is_dismissed).toBe(true);

    // 7. Reset flow
    const pReset = await service.resetFlowProgress(WS_ALPHA, "activation_checklist", "usr_alice");
    expect(pReset.completed_steps).toHaveLength(0);
    expect(pReset.is_completed).toBe(false);
    expect(pReset.is_dismissed).toBe(false);

    // 8. Analytics
    const analytics = await service.getFlowAnalytics(WS_ALPHA, "activation_checklist");
    expect(analytics.total_started).toBe(1);
  });

  it("enforces multi-tenant workspace isolation for onboarding flows", async () => {
    const service = new UserOnboardingService(db);

    await service.createFlow({
      workspaceId: WS_ALPHA,
      key: "team_tour",
      title: "Team Tour Alpha",
      steps: [{ stepKey: "step1", title: "Step 1" }],
    });

    const betaFlows = await service.listFlows(WS_BETA);
    expect(betaFlows).toHaveLength(0);

    const crossGet = await service.getFlow(WS_BETA, "team_tour");
    expect(crossGet).toBeNull();
  });
});

describe("User Onboarding REST API", () => {
  function createApp(workspaceId: string = WS_ALPHA, userId: string = "usr_tester_1") {
    const app = new Hono<OnboardingEnv>();
    app.use("*", async (c, next) => {
      c.set("workspace", { id: workspaceId, role: "admin" });
      c.set("ctx", Object.freeze({ userId, workspaceId, role: "admin" }));
      c.set("user", { uid: userId, email: "user@test.com" });
      await next();
    });
    app.route("/", createOnboardingRoutes());
    return app;
  }

  it("registers flow, advances steps, and retrieves analytics via HTTP", async () => {
    const app = createApp();

    // 1. Create flow
    const createRes = await app.request(
      "http://localhost/onboarding/flows",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "quickstart",
          title: "Quickstart Checklist",
          steps: [
            { stepKey: "step_profile", title: "Set up profile" },
            { stepKey: "step_api_key", title: "Generate API key" },
          ],
        }),
      },
      { DB: db }
    );
    expect(createRes.status).toBe(201);
    const flow = (await createRes.json()) as any;
    expect(flow.key).toBe("quickstart");

    // 2. Fetch progress
    const progRes = await app.request(
      "http://localhost/onboarding/flows/quickstart/progress",
      { method: "GET" },
      { DB: db }
    );
    expect(progRes.status).toBe(200);
    const progJson = (await progRes.json()) as any;
    expect(progJson.percent_complete).toBe(0);

    // 3. Complete step
    const stepRes = await app.request(
      "http://localhost/onboarding/flows/quickstart/steps/step_profile/complete",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) },
      { DB: db }
    );
    expect(stepRes.status).toBe(200);
    const stepJson = (await stepRes.json()) as any;
    expect(stepJson.percent_complete).toBe(50);

    // 4. Complete second step -> completes flow
    const step2Res = await app.request(
      "http://localhost/onboarding/flows/quickstart/steps/step_api_key/complete",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) },
      { DB: db }
    );
    expect(step2Res.status).toBe(200);
    const step2Json = (await step2Res.json()) as any;
    expect(step2Json.is_completed).toBe(true);
    expect(step2Json.percent_complete).toBe(100);

    // 5. Analytics
    const analyticsRes = await app.request(
      "http://localhost/onboarding/flows/quickstart/analytics",
      { method: "GET" },
      { DB: db }
    );
    expect(analyticsRes.status).toBe(200);
    const analyticsJson = (await analyticsRes.json()) as any;
    expect(analyticsJson.total_completed).toBe(1);
    expect(analyticsJson.completion_rate_percent).toBe(100);
  });
});
