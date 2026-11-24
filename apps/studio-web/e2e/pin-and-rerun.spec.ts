import { expect, test } from "@playwright/test";
import { e2eProjectToken } from "./project-token.ts";

test.describe("Pin Step Output & Re-Run From Node (Real Workerd Backend)", () => {
  test("pins node output in Inspector, displays Pinned badge on canvas, re-runs a failed run from a specific step, and displays Resolved by retry badge", async ({
    page,
    request,
  }) => {
    const project = `e2e-pin-rerun-${Date.now().toString(36)}`;

    // Story 0.15: an MCP token is bound to one project; this spec's project gets its own.
    const authHeaders = {
      authorization: `Bearer ${await e2eProjectToken(project)}`,
      "content-type": "application/json",
    };

    // 1. Create workflow with 2 nodes: step_trigger -> step_divide (core.math: a / b, configured with b = 0 so it fails).
    // Story 0.9: Studio runs no brick action without a real executor (credit-wallet.debit fails NOT_CONFIGURED whatever
    // its config), so the step that fails on a bad config and is fixed by a config change is the real core.math node.
    const opsRes = await request.post(`/api/projects/${project}/ops`, {
      headers: authHeaders,
      data: {
        author: { type: "human", id: "alice" },
        ops: [
          {
            opId: "op-mw",
            type: "enable_brick",
            brickId: "multi-workspace",
          },
          {
            opId: "op-wf",
            type: "add_workflow",
            workflow: {
              id: "wf_pin_e2e",
              name: "Pin and Rerun E2E Flow",
              trigger: "core.webhook",
              nodes: [
                {
                  id: "step_trigger",
                  type: "core.webhook",
                  label: "Webhook Trigger",
                  data: { method: "post" },
                },
                {
                  id: "step_divide",
                  type: "core.math",
                  label: "Split Order Amount",
                  data: { operation: "div", b: 0 },
                },
              ],
              edges: [
                {
                  id: "e1",
                  source: "step_trigger",
                  sourceHandle: "out",
                  target: "step_divide",
                  targetHandle: "in",
                },
              ],
            },
          },
        ],
      },
    });
    expect(opsRes.ok()).toBe(true);

    // 2. Execute run 1 with a = 500 -> step_trigger succeeds, step_divide fails with division by zero
    const failRunRes = await request.post(
      `/api/projects/${project}/workflows/wf_pin_e2e/runs`,
      {
        headers: authHeaders,
        data: {
          runId: "run_e2e_failed_1",
          triggerType: "manual",
          triggerPayload: {
            orderId: "ord_e2e_99",
            a: 500,
            workspaceId: "ws_e2e",
          },
        },
      },
    );
    expect(failRunRes.ok()).toBe(true);
    const failRunBody = (await failRunRes.json()) as { runStatus: string; failed: Record<string, string> };
    expect(failRunBody.runStatus).toBe("failed");
    expect(failRunBody.failed.step_divide).toContain("division by zero");

    // 3. Fix step_divide config in r2 so b = 4 (a = 500 still comes from step_trigger's recorded output)
    const fixOpsRes = await request.post(`/api/projects/${project}/ops`, {
      headers: authHeaders,
      data: {
        baseRevision: 1,
        author: { type: "human", id: "alice" },
        ops: [
          {
            opId: "op-fix-divide",
            type: "update_node",
            workflowId: "wf_pin_e2e",
            nodeId: "step_divide",
            label: "Split Order Amount",
            data: { operation: "div", b: 4 },
          },
        ],
      },
    });
    expect(fixOpsRes.ok()).toBe(true);

    // 4. Open Studio UI in browser, sign in as Alice, and open Workflows canvas
    await page.goto(`/?project=${encodeURIComponent(project)}`);
    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await page.getByTestId("project-selector").selectOption(project);
    await page.getByTestId("nav-tab-workflows").click();
    await expect(page.getByTestId("view-workflows")).toBeVisible();

    // 5. Open Run History drawer, replay `run_e2e_failed_1`, pin `step_trigger`'s output, and re-run from `step_divide`
    await page.getByTestId("toggle-run-history-drawer").click();
    await expect(page.getByTestId("run-row-run_e2e_failed_1")).toBeVisible();
    await page.getByTestId("replay-run-button-run_e2e_failed_1").click();

    await expect(page.getByTestId("inspector-run-replay-panel")).toBeVisible();

    // Click `step_trigger` and pin its output as test data
    await page.getByTestId("canvas-node-step_trigger").click();
    await page.getByTestId("pin-node-output-button").click();
    const pinnedBadge = page.getByTestId("node-pinned-badge-step_trigger");
    await expect(pinnedBadge).toBeVisible();
    const pinnedBadgeStyles = await pinnedBadge.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        display: cs.display,
        borderRadius: cs.borderRadius,
        backgroundColor: cs.backgroundColor,
      };
    });
    expect(pinnedBadgeStyles.display).not.toBe("none");
    expect(Number.parseFloat(pinnedBadgeStyles.borderRadius)).toBeGreaterThan(0);
    expect(pinnedBadgeStyles.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

    // Click `step_divide` and click `Re-run from this step`
    await page.getByTestId("canvas-node-step_divide").click();
    await page.getByTestId("rerun-from-node-button").click();

    // 6. Verify `Resolved by retry` badge + computed styles on `run_e2e_failed_1` in Run History drawer
    const resolvedBadge = page.getByTestId(
      "run-resolved-by-retry-badge-run_e2e_failed_1",
    );
    await expect(resolvedBadge).toBeVisible();
    const resolvedBadgeStyles = await resolvedBadge.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        display: cs.display,
        borderRadius: cs.borderRadius,
        backgroundColor: cs.backgroundColor,
      };
    });
    expect(resolvedBadgeStyles.display).not.toBe("none");
    expect(Number.parseFloat(resolvedBadgeStyles.borderRadius)).toBeGreaterThan(0);
    expect(resolvedBadgeStyles.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

    // 7. Verify F5 reload persistence of Pinned badge on canvas and Resolved by retry badge in Run History
    await page.reload();
    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await page.getByTestId("project-selector").selectOption(project);
    await page.getByTestId("nav-tab-workflows").click();
    await expect(
      page.getByTestId("node-pinned-badge-step_trigger"),
    ).toBeVisible();
    await page.getByTestId("toggle-run-history-drawer").click();
    await expect(
      page.getByTestId("run-resolved-by-retry-badge-run_e2e_failed_1"),
    ).toBeVisible();
  });
});
