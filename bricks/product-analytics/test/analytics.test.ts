import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_product_analytics.sql?raw";
import {
  ProductAnalyticsService,
  createProductAnalyticsRoutes,
} from "../src/index.ts";
import type { AnalyticsEnv } from "../src/middleware.ts";
import { stubWorkspaceContext } from "../../multi-workspace/test/support/stub-workspace-context.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_ana_alpha";
const WS_BETA = "ws_ana_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS evt_funnels").run();
  await db.prepare("DROP TABLE IF EXISTS evt_analytics_events").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Product Analytics Core Telemetry & Funnel Logic", () => {
  it("tracks clickstream events and aggregates counts by event name", async () => {
    const service = new ProductAnalyticsService(db);

    await service.track({
      workspaceId: WS_ALPHA,
      anonymousId: "anon_1",
      eventName: "page_view",
      properties: { path: "/pricing" },
    });

    await service.track({
      workspaceId: WS_ALPHA,
      anonymousId: "anon_2",
      eventName: "page_view",
      properties: { path: "/docs" },
    });

    await service.track({
      workspaceId: WS_ALPHA,
      anonymousId: "anon_1",
      eventName: "button_clicked",
      properties: { id: "cta_signup" },
    });

    const counts = await service.getEventCounts(WS_ALPHA);
    expect(counts["page_view"]).toBe(2);
    expect(counts["button_clicked"]).toBe(1);
  });

  it("aliases anonymous session history to authenticated user ID retroactively", async () => {
    const service = new ProductAnalyticsService(db);

    // Initial anonymous tracking
    await service.track({
      workspaceId: WS_ALPHA,
      anonymousId: "anon_device_xyz",
      eventName: "homepage_viewed",
    });

    await service.track({
      workspaceId: WS_ALPHA,
      anonymousId: "anon_device_xyz",
      eventName: "signup_started",
    });

    // User logs in / signs up
    const res = await service.identify(WS_ALPHA, "anon_device_xyz", "usr_john_doe");
    expect(res.updatedCount).toBe(2);

    // Subsequent event directly with user ID
    await service.track({
      workspaceId: WS_ALPHA,
      userId: "usr_john_doe",
      anonymousId: "anon_device_xyz",
      eventName: "dashboard_loaded",
    });

    // Verify all 3 events are now associated with usr_john_doe
    interface CountRow {
      count: number;
    }
    const count = await db.prepare(
      "SELECT COUNT(*) as count FROM evt_analytics_events WHERE workspace_id = ? AND user_id = ?"
    ).bind(WS_ALPHA, "usr_john_doe").first<CountRow>();

    expect(count?.count).toBe(3);
  });

  it("computes conversion funnel dropoff rates accurately", async () => {
    const service = new ProductAnalyticsService(db);
    const funnel = await service.createFunnel(
      WS_ALPHA,
      "Self-Serve Onboarding",
      ["visit", "signup", "checkout"]
    );

    // 10 users visit
    for (let i = 1; i <= 10; i++) {
      await service.track({ workspaceId: WS_ALPHA, anonymousId: `user_${i}`, eventName: "visit" });
    }

    // 6 users complete signup (users 1..6)
    for (let i = 1; i <= 6; i++) {
      await service.track({ workspaceId: WS_ALPHA, anonymousId: `user_${i}`, eventName: "signup" });
    }

    // 3 users checkout (users 1..3)
    for (let i = 1; i <= 3; i++) {
      await service.track({ workspaceId: WS_ALPHA, anonymousId: `user_${i}`, eventName: "checkout" });
    }

    const report = await service.calculateFunnel(WS_ALPHA, funnel.id);
    expect(report).not.toBeNull();
    expect(report?.funnelName).toBe("Self-Serve Onboarding");
    expect(report?.steps).toHaveLength(3);

    // Step 1: visit
    expect(report?.steps[0]?.count).toBe(10);
    expect(report?.steps[0]?.conversionRate).toBe(1.0);

    // Step 2: signup
    expect(report?.steps[1]?.count).toBe(6);
    expect(report?.steps[1]?.conversionRate).toBe(0.6); // 6/10
    expect(report?.steps[1]?.dropoffRate).toBe(0.4);

    // Step 3: checkout
    expect(report?.steps[2]?.count).toBe(3);
    expect(report?.steps[2]?.conversionRate).toBe(0.5); // 3/6

    // Overall conversion
    expect(report?.overallConversion).toBe(0.3); // 3/10
  });

  it("strictly isolates events and funnels between workspaces", async () => {
    const service = new ProductAnalyticsService(db);
    await service.track({ workspaceId: WS_ALPHA, anonymousId: "a1", eventName: "alpha_event" });
    await service.track({ workspaceId: WS_BETA, anonymousId: "b1", eventName: "beta_event" });

    const countsAlpha = await service.getEventCounts(WS_ALPHA);
    const countsBeta = await service.getEventCounts(WS_BETA);

    expect(countsAlpha["alpha_event"]).toBe(1);
    expect(countsAlpha["beta_event"]).toBeUndefined();
    expect(countsBeta["beta_event"]).toBe(1);
  });
});

describe("Product Analytics HTTP API", () => {
  it("provides full HTTP workflow for tracking, counts, funnels, and reports", async () => {
    const app = new Hono<AnalyticsEnv>();
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createProductAnalyticsRoutes());

    // 1. POST /analytics/track
    const trackRes = await app.request("/api/analytics/track", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({
        anonymousId: "device_test_1",
        eventName: "product_viewed",
        properties: { sku: "WIDGET-99" },
      }),
    }, { DB: db });
    expect(trackRes.status).toBe(201);

    // 2. GET /analytics/counts
    const countsRes = await app.request("/api/analytics/counts", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(countsRes.status).toBe(200);
    const countsJson = (await countsRes.json()) as { counts: Record<string, number> };
    expect(countsJson.counts["product_viewed"]).toBe(1);

    // 3. POST /analytics/identify
    const identRes = await app.request("/api/analytics/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({
        anonymousId: "device_test_1",
        userId: "usr_alice",
      }),
    }, { DB: db });
    expect(identRes.status).toBe(200);

    // 4. POST /analytics/funnels
    const fnlRes = await app.request("/api/analytics/funnels", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({
        name: "Viewer to Buyer",
        steps: ["product_viewed", "purchase_made"],
      }),
    }, { DB: db });
    expect(fnlRes.status).toBe(201);
    const fnlJson = (await fnlRes.json()) as { funnel: { id: string } };
    const funnelId = fnlJson.funnel.id;

    // 5. GET /analytics/funnels/:id/report
    const repRes = await app.request(`/api/analytics/funnels/${funnelId}/report`, { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(repRes.status).toBe(200);
    const repJson = (await repRes.json()) as { report: { funnelName: string; steps: unknown[] } };
    expect(repJson.report.funnelName).toBe("Viewer to Buyer");
    expect(repJson.report.steps).toHaveLength(2);
  });
});
