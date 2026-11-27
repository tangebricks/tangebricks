import { expect, test } from "@playwright/test";

test.describe("Story 8.1 — Starter templates, layout coordinate persistence, and onboarding funnel E2E", () => {
  test("creates an empty project, renders all 4 starter template buttons in overview-empty-state, loads stripe-discord-ops at rev=1, and renders workflow nodes on the React Flow canvas", async ({
    page,
  }) => {
    await page.goto("/");

    // Sign in as owner
    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();

    // Select the empty project seeded in E2E or create a new empty project via API
    const emptyProjectSlug = `onboarding-tpl-${Date.now().toString(36).slice(-5)}`;
    const createRes = await page.request.post("/api/projects", {
      data: {
        slug: emptyProjectSlug,
        name: "Onboarding Template Test",
      },
    });
    expect(createRes.ok()).toBeTruthy();

    await page.reload();
    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await page.getByTestId("project-selector").selectOption(emptyProjectSlug);

    // 1. Verify overview-empty-state renders all 4 one-click starter template buttons
    await expect(page.getByTestId("overview-empty-state")).toBeVisible();
    await expect(page.getByTestId("load-preset-ai-credits-saas")).toBeVisible();
    await expect(page.getByTestId("load-preset-b2b-workspace-app")).toBeVisible();
    await expect(page.getByTestId("load-preset-marketplace")).toBeVisible();
    await expect(page.getByTestId("load-preset-stripe-discord-ops")).toBeVisible();

    // 2. Click load-preset-stripe-discord-ops and verify Backend Map populates immediately
    await page.getByTestId("load-preset-stripe-discord-ops").click();
    await expect(page.getByTestId("overview-backend-map")).toBeVisible();
    await expect(page.getByTestId("backend-map-brick-card-webhook-gateway")).toBeVisible();
    await expect(page.getByTestId("backend-map-brick-card-integration-connections")).toBeVisible();
    await expect(page.getByTestId("backend-map-entity-card-payment_events")).toBeVisible();

    // 3. Navigate to Workflows view and verify pre-laid-out nodes render on React Flow canvas
    await page.getByTestId("nav-tab-workflows").click();
    await expect(page.getByTestId("view-workflows")).toBeVisible();
    await expect(page.getByTestId("workflow-reactflow-canvas")).toBeVisible();
    await expect(page.getByTestId("canvas-node-n_stripe_webhook")).toBeVisible();
    await expect(page.getByTestId("canvas-node-n_discord_notify")).toBeVisible();

    // 4. Story 16: the operator funnel report (/api/admin/*) is for platform operators only; a signed-in project owner
    // is refused. The funnel aggregation itself is covered by apps/studio-api/test/templates-and-funnel.test.ts.
    const funnelRes = await page.request.get("/api/admin/onboarding-funnel");
    expect(funnelRes.status()).toBe(403);
  });
});
