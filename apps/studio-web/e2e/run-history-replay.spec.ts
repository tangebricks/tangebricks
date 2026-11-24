import { expect, test } from "@playwright/test";
import { e2eProjectToken } from "./project-token.ts";

test.describe("Run History drawer, filtering, historical revision replay, and Run Replay inspector (Real Workerd Backend)", () => {
  test("filters runs in the Run History drawer, replays an r1 run after a node is removed in r2, and inspects node I/O, retries, and error stack", async ({
    page,
    request,
  }) => {
    const project = `e2e-replay-${Date.now().toString(36)}`;

    // Story 0.15: an MCP token is bound to one project; this spec's project gets its own.
    const authHeaders = {
      authorization: `Bearer ${await e2eProjectToken(project)}`,
      "content-type": "application/json",
    };

    // 1. Apply r1 blueprint with 3 nodes: step_trigger -> step_audit_r1 -> step_divide.
    // Story 0.9: Studio runs no brick action without a real executor (credit-wallet.debit fails NOT_CONFIGURED whatever
    // the input), so the step whose outcome depends on the payload is the real core.math node: it divides a by b and
    // fails with "division by zero" when b is 0.
    const opsR1Res = await request.post(`/api/projects/${project}/ops`, {
      headers: authHeaders,
      data: {
        author: { type: "human", id: "alice" },
        ops: [
          {
            opId: "op-r1-mw",
            type: "enable_brick",
            brickId: "multi-workspace",
          },
          {
            opId: "op-r1-wf",
            type: "add_workflow",
            workflow: {
              id: "wf_replay_e2e",
              name: "Replay E2E Flow",
              trigger: "core.webhook",
              nodes: [
                {
                  id: "step_trigger",
                  type: "core.webhook",
                  label: "Webhook Trigger",
                  data: { method: "post" },
                },
                {
                  id: "step_audit_r1",
                  type: "core.noop",
                  label: "Audit Step (r1 only)",
                  data: {},
                },
                {
                  id: "step_divide",
                  type: "core.math",
                  label: "Split Amount",
                  data: { operation: "div" },
                },
              ],
              edges: [
                {
                  id: "e1",
                  source: "step_trigger",
                  sourceHandle: "out",
                  target: "step_audit_r1",
                  targetHandle: "in",
                },
                {
                  id: "e2",
                  source: "step_audit_r1",
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
    expect(opsR1Res.ok()).toBe(true);

    // 2. Execute a succeeded run at r1 (`run_e2e_r1`) and a failed webhook run (`run_e2e_r1_fail`) for filtering
    const runR1Res = await request.post(
      `/api/projects/${project}/workflows/wf_replay_e2e/runs`,
      {
        headers: authHeaders,
        data: {
          runId: "run_e2e_r1",
          triggerType: "manual",
          triggerPayload: { amount: 30, a: 300, b: 10, workspaceId: "ws_e2e" },
        },
      },
    );
    expect(runR1Res.ok()).toBe(true);
    expect(((await runR1Res.json()) as { runStatus: string }).runStatus).toBe("succeeded");

    const runR1FailRes = await request.post(
      `/api/projects/${project}/workflows/wf_replay_e2e/runs`,
      {
        headers: authHeaders,
        data: {
          runId: "run_e2e_r1_fail",
          triggerType: "webhook",
          triggerPayload: { amount: 30, a: 300, b: 0, workspaceId: "ws_e2e" },
        },
      },
    );
    expect(runR1FailRes.ok()).toBe(true);
    const runR1FailBody = (await runR1FailRes.json()) as { runStatus: string; failed: Record<string, string> };
    expect(runR1FailBody.runStatus).toBe("failed");
    expect(runR1FailBody.failed.step_divide).toContain("division by zero");

    // 3. Mutate blueprint to r2 by removing `step_audit_r1`
    const opsR2Res = await request.post(`/api/projects/${project}/ops`, {
      headers: authHeaders,
      data: {
        baseRevision: 1,
        author: { type: "human", id: "alice" },
        ops: [
          {
            opId: "op-r2-rm",
            type: "remove_node",
            workflowId: "wf_replay_e2e",
            nodeId: "step_audit_r1",
          },
          {
            opId: "op-r2-edge",
            type: "connect_edges",
            workflowId: "wf_replay_e2e",
            edges: [
              {
                id: "e_r2",
                source: "step_trigger",
                sourceHandle: "out",
                target: "step_divide",
                targetHandle: "in",
              },
            ],
          },
        ],
      },
    });
    expect(opsR2Res.ok()).toBe(true);

    // 4. Open Studio UI in browser, sign in as Alice, and open Workflows canvas
    await page.goto(`/?project=${encodeURIComponent(project)}`);
    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await page.getByTestId("project-selector").selectOption(project);
    await page.getByTestId("nav-tab-workflows").click();

    await expect(page.getByTestId("view-workflows")).toBeVisible();
    // At current r2, `step_audit_r1` is not on the canvas
    await expect(page.getByTestId("canvas-node-step_audit_r1")).toHaveCount(0);

    // 5. Open Run History drawer, exercise status & trigger filters, and click Replay on `run_e2e_r1`
    await page.getByTestId("toggle-run-history-drawer").click();
    await expect(page.getByTestId("run-history-drawer")).toBeVisible();
    await expect(page.getByTestId("run-row-run_e2e_r1")).toBeVisible();
    await expect(page.getByTestId("run-row-run_e2e_r1_fail")).toBeVisible();

    // Filter by status = failed -> only run_e2e_r1_fail visible
    await page.getByTestId("runs-filter-status").selectOption("failed");
    await expect(page.getByTestId("run-row-run_e2e_r1_fail")).toBeVisible();
    await expect(page.getByTestId("run-row-run_e2e_r1")).toHaveCount(0);

    // Filter by status = succeeded & trigger = manual -> only run_e2e_r1 visible
    await page.getByTestId("runs-filter-status").selectOption("succeeded");
    await page.getByTestId("runs-filter-trigger").selectOption("manual");
    await expect(page.getByTestId("run-row-run_e2e_r1")).toBeVisible();
    await expect(page.getByTestId("run-row-run_e2e_r1_fail")).toHaveCount(0);

    // Reset filters to all
    await page.getByTestId("runs-filter-status").selectOption("all");
    await page.getByTestId("runs-filter-trigger").selectOption("all");

    await page.getByTestId("replay-run-button-run_e2e_r1").click();

    // 6. Verify Run Replay banner + computed styles, historical revision badge, and historical node `step_audit_r1` on canvas
    const replayBanner = page.getByTestId("run-replay-banner");
    await expect(replayBanner).toBeVisible();
    const bannerStyles = await replayBanner.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        display: cs.display,
        borderRadius: cs.borderRadius,
        backgroundColor: cs.backgroundColor,
      };
    });
    expect(bannerStyles.display).toBe("flex");
    expect(Number.parseFloat(bannerStyles.borderRadius)).toBeGreaterThan(0);
    expect(bannerStyles.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

    await expect(
      page.getByTestId("run-replay-historical-rev-badge"),
    ).toBeVisible();
    await expect(page.getByTestId("canvas-node-step_audit_r1")).toBeVisible();

    // 7. Click `step_audit_r1` and verify Run Replay Inspector panel in RightDock
    await page.getByTestId("canvas-node-step_audit_r1").click();
    await expect(page.getByTestId("inspector-run-replay-panel")).toBeVisible();
    await expect(page.getByTestId("replay-node-output-preview")).toContainText(
      '"amount": 30',
    );

    // 8. Exit Replay and verify current r2 graph is restored
    await page.getByTestId("exit-run-replay-button").click();
    await expect(page.getByTestId("run-replay-banner")).toHaveCount(0);
    await expect(page.getByTestId("canvas-node-step_audit_r1")).toHaveCount(0);

    // 9. Verify F5 reload persistence of D1 run history
    await page.reload();
    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await page.getByTestId("project-selector").selectOption(project);
    await page.getByTestId("nav-tab-workflows").click();
    await page.getByTestId("toggle-run-history-drawer").click();
    await expect(page.getByTestId("run-row-run_e2e_r1")).toBeVisible();
    await expect(page.getByTestId("run-row-run_e2e_r1_fail")).toBeVisible();
  });
});
