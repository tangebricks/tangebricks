import { expect, test } from "@playwright/test";

test.describe("Inspector I/O & Test Step Rehearsal (Real Backend E2E)", () => {
  test("executes single-node rehearsal from the Inspector I/O & Test Step tab, displays formatted JSON and Table/Tree views, timing badge, and structured error card", async ({
    page,
  }) => {
    await page.goto("/");

    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();

    // Add a credit-wallet.debit node (step_debit) to wf-billing via the real Studio API
    await page.evaluate(async () => {
      await fetch("/api/projects/acme-saas/ops", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          author: { type: "human", id: "alice" },
          summary: "Add Debit Wallet step for rehearsal",
          ops: [
            {
              opId: "e2e-add-debit-step",
              type: "add_node",
              workflowId: "wf-billing",
              node: {
                id: "step_debit",
                type: "credit-wallet.debit",
                label: "Debit Wallet",
                data: { amount: 10 },
              },
            },
            {
              opId: "e2e-connect-debit-step",
              type: "connect_edges",
              workflowId: "wf-billing",
              edges: [
                {
                  id: "edge-debit",
                  source: "node-pick",
                  target: "step_debit",
                  sourceHandle: "out",
                  targetHandle: "in",
                },
              ],
            },
          ],
        }),
      });
    });

    // Navigate to Workflows view on the seeded acme-saas project
    await page.getByTestId("nav-tab-workflows").click();
    await expect(page.getByTestId("view-workflows")).toBeVisible();

    // Select the Debit Wallet node (step_debit)
    await page.getByTestId("canvas-node-step_debit").click();
    await expect(page.getByTestId("inspector-node-detail")).toBeVisible();

    // Switch to I/O & Test Step tab in the Right Dock Inspector
    await page.getByTestId("inspector-node-tab-io").click();
    await expect(page.getByTestId("inspector-test-step-panel")).toBeVisible();

    // Supply custom test input JSON and click Test step
    const editor = page.getByTestId("test-step-input-editor");
    await editor.fill(JSON.stringify({ balance: 150, workspaceId: "ws_e2e_preview" }, null, 2));
    await page.getByTestId("run-test-step-button").click();

    // Verify Succeeded badge, duration badge, and JSON output
    const statusBadge = page.getByTestId("test-step-status-badge");
    await expect(statusBadge).toContainText("✓ Succeeded");
    const statusBadgeStyles = await statusBadge.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        display: cs.display,
        borderRadius: cs.borderRadius,
        fontWeight: cs.fontWeight,
      };
    });
    expect(statusBadgeStyles.display).not.toBe("none");
    expect(Number.parseFloat(statusBadgeStyles.borderRadius)).toBeGreaterThan(0);

    await expect(page.getByTestId("test-step-duration-badge")).toContainText("ms");
    await expect(page.getByTestId("test-step-output-json")).toContainText('"balanceAfter": 140');
    await expect(page.getByTestId("test-step-output-json")).toContainText('"ws_e2e_preview"');

    // Switch to Table / Tree view and verify structured rows
    await page.getByTestId("test-step-view-mode-table").click();
    await expect(page.getByTestId("test-step-output-table")).toContainText("out.balanceAfter");
    await expect(page.getByTestId("test-step-output-table")).toContainText("140");

    // Supply insufficient balance (balance: 2 < amount: 10) to trigger a structured rehearsal error
    await editor.fill(JSON.stringify({ balance: 2, workspaceId: "ws_e2e_preview" }, null, 2));
    await page.getByTestId("run-test-step-button").click();

    await expect(statusBadge).toContainText("✕ Failed");
    const errorCard = page.getByTestId("test-step-error-card");
    await expect(errorCard).toBeVisible();
    const errorCardStyles = await errorCard.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        borderRadius: cs.borderRadius,
        borderTopWidth: cs.borderTopWidth,
        backgroundColor: cs.backgroundColor,
      };
    });
    expect(Number.parseFloat(errorCardStyles.borderRadius)).toBeGreaterThan(0);
    expect(Number.parseFloat(errorCardStyles.borderTopWidth)).toBeGreaterThan(0);
    expect(errorCardStyles.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

    await expect(page.getByTestId("test-step-error-what")).toContainText("step_debit");
    await expect(page.getByTestId("test-step-error-why")).toContainText("insufficient balance");
    await expect(page.getByTestId("test-step-error-todo")).toContainText("amount");
  });
});
