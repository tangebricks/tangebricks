import { expect, test } from "@playwright/test";
import { E2E_MCP_TOKEN } from "./global-setup.ts";

test.describe("Story 2.7: Viewer Role Read-Only Enforcement & Live Sync", () => {
  test("viewer user can inspect all read-only views and receive live WebSocket updates, has all UI mutation controls disabled, and receives 403 Forbidden on direct POST /api/projects/:project/ops (AC 3)", async ({
    page,
    request,
  }) => {
    await page.goto("/");

    // Sign in as a viewer user
    await page.getByTestId("auth-email-input").fill("viewer@example.com");
    await page.getByTestId("auth-password-input").fill("viewerpass123");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();

    // Verify Viewer role badge and Read-only banner
    await expect(page.getByTestId("role-badge")).toHaveText("Viewer");
    await expect(page.getByTestId("viewer-readonly-banner")).toBeVisible();

    // Verify UI mutation buttons are disabled
    await expect(page.getByTestId("new-project-button")).toBeDisabled();
    await expect(page.getByTestId("deploy-button")).toBeDisabled();

    // Select acme-saas project and verify read-only navigation across all views
    await page.getByTestId("project-selector").selectOption("acme-saas");
    await expect(page.getByTestId("view-overview")).toBeVisible();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText(/^r\d+$/);

    await page.getByTestId("nav-tab-bricks").click();
    await expect(page.getByTestId("view-bricks")).toBeVisible();

    await page.getByTestId("nav-tab-data").click();
    await expect(page.getByTestId("view-data")).toBeVisible();

    await page.getByTestId("nav-tab-workflows").click();
    await expect(page.getByTestId("view-workflows")).toBeVisible();

    await page.getByTestId("nav-tab-history").click();
    await expect(page.getByTestId("view-history")).toBeVisible();

    // Verify viewer receives live WebSocket updates when an MCP agent commits a mutation
    const revBeforeText = await page.getByTestId("topbar-revision-badge").textContent();
    const revBefore = Number((revBeforeText ?? "r0").replace("r", ""));

    const mcpRes = await request.post("/mcp", {
      headers: {
        authorization: `Bearer ${E2E_MCP_TOKEN}`,
      },
      data: {
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: {
          name: "enable_brick",
          arguments: {
            project: "acme-saas",
            bricks: ["audit-trail"],
          },
        },
      },
    });
    expect(mcpRes.status()).toBe(200);

    await expect(page.getByTestId("topbar-revision-badge")).toHaveText(
      `r${revBefore + 1}`,
      { timeout: 2_000 },
    );

    // Verify direct POST /api/projects/acme-saas/ops from the viewer browser session returns 403 Forbidden
    const directMutateResult = await page.evaluate(async () => {
      const res = await fetch("/api/projects/acme-saas/ops", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          ops: [{ opId: "forged-1", type: "enable_brick", brickId: "live-chat" }],
        }),
      });
      const body = (await res.json()) as { error?: { code?: string } };
      return { status: res.status, code: body.error?.code };
    });

    expect(directMutateResult.status).toBe(403);
    expect(directMutateResult.code).toBe("FORBIDDEN_ROLE");
  });
});
