import { expect, test } from "@playwright/test";

test.describe("Test Workflow Trigger & Live Canvas Node Highlighting (Real Backend E2E)", () => {
  test("triggers a branching 4-node workflow from Studio against the real preview backend and transitions canvas nodes through Succeeded / Skipped / Failed with edge item counts", async ({
    page,
  }) => {
    await page.goto("/");

    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();

    // Seed a branching 4-node workflow (wf-branching-e2e) on acme-saas via the real Studio API
    await page.evaluate(async () => {
      await fetch("/api/projects/acme-saas/ops", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          author: { type: "human", id: "alice" },
          summary: "Add branching 4-node workflow for live telemetry E2E",
          ops: [
            {
              opId: "e2e-enable-notif",
              type: "enable_brick",
              brickId: "in-app-notifications",
              config: {},
            },
            {
              opId: "e2e-add-branch-wf",
              type: "add_workflow",
              workflow: {
                id: "wf-branching-e2e",
                name: "VIP Order Branching Flow",
                nodes: [
                  {
                    id: "node_trigger",
                    type: "core.webhook",
                    label: "Order Webhook",
                    data: { method: "post" },
                  },
                  {
                    id: "node_if",
                    type: "core.if",
                    label: "Check VIP Tier",
                    data: { field: "tier", operator: "eq", value: "vip" },
                  },
                  {
                    id: "node_debit_true",
                    type: "credit-wallet.debit",
                    label: "Debit VIP Wallet",
                    data: { amount: 20 },
                  },
                  {
                    id: "node_notify_false",
                    type: "in-app-notifications.send",
                    label: "Standard Tier Notice",
                    data: {},
                  },
                ],
                edges: [
                  {
                    id: "e_trig_if",
                    source: "node_trigger",
                    target: "node_if",
                    sourceHandle: "out",
                    targetHandle: "in",
                  },
                  {
                    id: "e_if_true",
                    source: "node_if",
                    target: "node_debit_true",
                    sourceHandle: "true",
                    targetHandle: "in",
                  },
                  {
                    id: "e_if_false",
                    source: "node_if",
                    target: "node_notify_false",
                    sourceHandle: "false",
                    targetHandle: "in",
                  },
                ],
              },
            },
          ],
        }),
      });
    });

    // Navigate to Workflows view and select wf-branching-e2e
    await page.getByTestId("nav-tab-workflows").click();
    await expect(page.getByTestId("view-workflows")).toBeVisible();
    await page.getByTestId("workflow-selector-card-wf-branching-e2e").click();

    // Open Test Workflow Payload drawer and supply a VIP payload with sufficient balance
    await page.getByTestId("toggle-test-workflow-payload-button").click();
    const payloadInput = page.getByTestId("test-workflow-payload-input");
    await payloadInput.fill(
      JSON.stringify(
        {
          tier: "vip",
          balance: 120,
          workspaceId: "ws_e2e_live",
        },
        null,
        2,
      ),
    );

    // Click Test workflow button
    await page.getByTestId("test-workflow-button").click();

    // Assert within 2 seconds that active nodes transition to Succeeded and the false branch transitions to Skipped
    await expect(page.getByTestId("node-telemetry-badge-node_trigger")).toHaveAttribute(
      "data-status",
      "succeeded",
      { timeout: 2000 },
    );
    await expect(page.getByTestId("node-telemetry-badge-node_if")).toHaveAttribute(
      "data-status",
      "succeeded",
      { timeout: 2000 },
    );
    await expect(
      page.getByTestId("node-telemetry-badge-node_debit_true"),
    ).toHaveAttribute("data-status", "succeeded", { timeout: 2000 });
    await expect(
      page.getByTestId("node-telemetry-badge-node_debit_true"),
    ).toContainText("✓");
    await expect(
      page.getByTestId("node-telemetry-badge-node_debit_true"),
    ).toContainText("Succeeded");

    // Verify compiled Tailwind styles on the succeeded badge via getComputedStyle
    const badgeStyles = await page
      .getByTestId("node-telemetry-badge-node_debit_true")
      .evaluate((el) => {
        const s = window.getComputedStyle(el);
        return {
          display: s.display,
          fontWeight: s.fontWeight,
          borderRadius: s.borderRadius,
        };
      });
    expect(badgeStyles.display).toBe("flex");
    expect(Number(badgeStyles.fontWeight)).toBeGreaterThanOrEqual(600);

    await expect(
      page.getByTestId("node-telemetry-badge-node_notify_false"),
    ).toHaveAttribute("data-status", "skipped", { timeout: 2000 });
    await expect(
      page.getByTestId("node-telemetry-badge-node_notify_false"),
    ).toContainText("—");
    await expect(
      page.getByTestId("node-telemetry-badge-node_notify_false"),
    ).toContainText("Skipped");

    // Verify traversed edge item-count pills
    await expect(page.getByTestId("edge-item-count-e_trig_if")).toContainText(
      "1 item",
    );
    await expect(page.getByTestId("edge-item-count-e_if_true")).toContainText(
      "1 item",
    );
    await expect(page.getByTestId("edge-item-count-e_if_false")).toHaveCount(0);

    // Trigger a failing branch run (balance: 3 < amount: 20) and assert Failed badge within 2 seconds
    await payloadInput.fill(
      JSON.stringify(
        {
          tier: "vip",
          balance: 3,
          workspaceId: "ws_e2e_live",
        },
        null,
        2,
      ),
    );
    await page.getByTestId("test-workflow-button").click();

    await expect(
      page.getByTestId("node-telemetry-badge-node_debit_true"),
    ).toHaveAttribute("data-status", "failed", { timeout: 2000 });
    await expect(
      page.getByTestId("node-telemetry-badge-node_debit_true"),
    ).toContainText("✕");
    await expect(
      page.getByTestId("node-telemetry-badge-node_debit_true"),
    ).toContainText("Failed");
    await expect(
      page.getByTestId("node-telemetry-error-node_debit_true"),
    ).toContainText("insufficient balance");
  });
});
