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

    // 1. Create workflow with 2 nodes: step_trigger -> step_debit (requires amount <= balance; minOrderAmount = 50 so amount=10 fails initially)
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
            opId: "op-cw",
            type: "enable_brick",
            brickId: "credit-wallet",
            config: { creditsPerUnit: 1, minOrderAmount: 1 },
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
                  id: "step_debit",
                  type: "credit-wallet.debit",
                  label: "Debit Wallet",
                  data: { amount: 500 },
                },
              ],
              edges: [
                {
                  id: "e1",
                  source: "step_trigger",
                  sourceHandle: "out",
                  target: "step_debit",
                  targetHandle: "in",
                },
              ],
            },
          },
        ],
      },
    });
    expect(opsRes.ok()).toBe(true);

    // 2. Execute run 1 where balance=100 and amount=500 -> step_trigger succeeds, step_debit fails with insufficient balance
    const failRunRes = await request.post(
      `/api/projects/${project}/workflows/wf_pin_e2e/runs`,
      {
        headers: authHeaders,
        data: {
          runId: "run_e2e_failed_1",
          triggerType: "manual",
          triggerPayload: {
            orderId: "ord_e2e_99",
            amount: 500,
            balance: 100,
            workspaceId: "ws_e2e",
          },
        },
      },
    );
    expect(failRunRes.ok()).toBe(true);
    const failRunBody = (await failRunRes.json()) as { runStatus: string };
    expect(failRunBody.runStatus).toBe("failed");

    // 3. Fix step_debit config in r2 so amount = 40 (which is <= balance 100 from step_trigger's recorded output!)
    const fixOpsRes = await request.post(`/api/projects/${project}/ops`, {
      headers: authHeaders,
      data: {
        baseRevision: 1,
        author: { type: "human", id: "alice" },
        ops: [
          {
            opId: "op-fix-debit",
            type: "update_node",
            workflowId: "wf_pin_e2e",
            nodeId: "step_debit",
            label: "Debit Wallet",
            data: { amount: 40 },
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

    // 5. Open Run History drawer, replay `run_e2e_failed_1`, pin `step_trigger`'s output, and re-run from `step_debit`
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

    // Click `step_debit` and click `Re-run from this step`
    await page.getByTestId("canvas-node-step_debit").click();
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
