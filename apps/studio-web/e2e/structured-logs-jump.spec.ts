import { expect, test } from "@playwright/test";

test.describe("Story 6.3 — Structured Logs & Errors Correlated to Runs & Nodes (Real Backend)", () => {
  test("renders structured logs with distinct level badges, scrubs secrets to [REDACTED], filters by facets, persists filter/view state across F5 reload, and jumps from a log entry's correlation link to CP4 Run Replay selecting the failed node", async ({
    page,
  }) => {
    // A test-mode key: acme-saas has an active hosted sandbox preview (the data browser specs deploy one), and a hosted
    // sandbox refuses to hold live payment credentials (403 SANDBOX_LIVE_PAYMENTS_BLOCKED). The scrubbing under test is
    // the same for any sealed value.
    const CANARY_SECRET = "sk_test_e2e_canary_secret_778899";

    await page.goto("/");

    // 1. Sign in as Alice (Owner) against real Better Auth + STUDIO_DB
    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await expect(page.getByTestId("project-selector")).toHaveValue("acme-saas");

    // 2. Add a credit-wallet.debit node ("node-charge") to wf-billing via real BlueprintDO ops
    const addNodeRes = await page.request.post("/api/projects/acme-saas/ops", {
      data: {
        author: { type: "human", id: "alice" },
        summary: "Add credit-wallet.debit step node-charge to wf-billing",
        ops: [
          {
            opId: "op-add-node-charge-s63",
            type: "add_node",
            workflowId: "wf-billing",
            node: {
              id: "node-charge",
              type: "credit-wallet.debit",
              label: "Charge Workspace Wallet",
              data: { amount: 250 },
            },
          },
          {
            opId: "op-connect-node-charge-s63",
            type: "connect_edges",
            workflowId: "wf-billing",
            edges: [
              {
                id: "edge-charge-s63",
                source: "node-trigger",
                target: "node-charge",
                sourceHandle: "out",
                targetHandle: "in",
              },
            ],
          },
        ],
      },
    });
    expect(addNodeRes.status()).toBe(200);

    // 3. Seal canary secret in project vault so telemetry & log ingestion scrub it automatically
    const sealRes = await page.request.post("/api/projects/acme-saas/secrets", {
      data: {
        ref: "sec_gateway_e2e_s63",
        kind: "api_key",
        label: "E2E Gateway Key",
        appOrBrick: "credit-wallet",
        envScope: "all",
        value: CANARY_SECRET,
      },
    });
    expect([200, 201]).toContain(sealRes.status());

    // 4. Trigger a real failing workflow run on wf-billing (balance 40 < amount 250 on node-charge)
    const runRes = await page.request.post(
      "/api/projects/acme-saas/workflows/wf-billing/runs",
      {
        data: {
          env: "preview",
          runId: "run_e2e_charge_fail_01",
          workspaceId: "ws_alpha",
          triggerPayload: {
            title: "INV-101",
            balance: 40,
            workspaceId: "ws_alpha",
          },
        },
      },
    );
    expect(runRes.status()).toBe(200);
    const runBody = (await runRes.json()) as {
      ok: boolean;
      runId: string;
      runStatus: string;
    };
    expect(runBody.runId).toBe("run_e2e_charge_fail_01");
    expect(runBody.runStatus).toBe("failed");

    // 5. Ingest structured logs across debug, info, warn, and error (containing CANARY_SECRET)
    const ingestRes = await page.request.post(
      "/api/projects/acme-saas/environments/preview/logs",
      {
        data: {
          entries: [
            {
              logId: "log_e2e_debug_01",
              ts: "2026-10-31T12:00:00.001Z",
              level: "debug",
              message: "Parsed trigger payload for wf-billing",
              runId: "run_e2e_charge_fail_01",
              workflowId: "wf-billing",
              revision: 3,
              nodeId: "node-trigger",
              brickId: "trigger",
              workspaceId: "ws_alpha",
              fields: { payloadKeys: ["title", "balance", "workspaceId"] },
            },
            {
              logId: "log_e2e_info_01",
              ts: "2026-10-31T12:00:00.010Z",
              level: "info",
              message: "Checking credit wallet balance before debit",
              runId: "run_e2e_charge_fail_01",
              workflowId: "wf-billing",
              revision: 3,
              nodeId: "node-charge",
              brickId: "credit-wallet",
              workspaceId: "ws_alpha",
              fields: { requiredCredits: 250, availableCredits: 40 },
            },
            {
              logId: "log_e2e_warn_01",
              ts: "2026-10-31T12:00:00.020Z",
              level: "warn",
              message: "Workspace ws_beta approaching credit quota",
              runId: null,
              workflowId: null,
              revision: 3,
              nodeId: null,
              brickId: "credit-wallet",
              workspaceId: "ws_beta",
              fields: { remainingCredits: 25 },
            },
            {
              logId: "log_e2e_error_01",
              ts: "2026-10-31T12:00:00.035Z",
              level: "error",
              message: `Wallet debit failed using token ${CANARY_SECRET}: insufficient balance (40 < 250)`,
              runId: "run_e2e_charge_fail_01",
              workflowId: "wf-billing",
              revision: 3,
              nodeId: "node-charge",
              brickId: "credit-wallet",
              workspaceId: "ws_alpha",
              fields: {
                gatewaySecret: CANARY_SECRET,
                authorization: "Bearer eyJ_e2e_secret_bearer_token",
                amount: 250,
                balance: 40,
              },
              errorStack: `Error: insufficient balance (${CANARY_SECRET})\n    at executeWalletDebit (credit-wallet.ts:42:9)`,
            },
          ],
        },
      },
    );
    expect(ingestRes.status()).toBe(201);

    // 6. Navigate to Workflows -> Open "Logs & Errors" panel
    await page.getByTestId("nav-tab-workflows").click();
    await expect(page.getByTestId("workflow-reactflow-canvas")).toBeVisible();

    await page.getByTestId("open-structured-logs-button").click();
    await expect(page.getByTestId("structured-logs-panel")).toBeVisible();

    // 7. Verify all 4 log levels render with icon + text and distinct computed styles
    await expect(page.getByTestId("log-row-log_e2e_debug_01")).toBeVisible();
    await expect(page.getByTestId("log-row-log_e2e_info_01")).toBeVisible();
    await expect(page.getByTestId("log-row-log_e2e_warn_01")).toBeVisible();
    await expect(page.getByTestId("log-row-log_e2e_error_01")).toBeVisible();

    const badgeStyles = await page.evaluate(() => {
      const panel = document.querySelector(
        '[data-testid="structured-logs-panel"]',
      );
      const errBadge = document.querySelector(
        '[data-testid="log-level-badge-log_e2e_error_01"]',
      );
      const warnBadge = document.querySelector(
        '[data-testid="log-level-badge-log_e2e_warn_01"]',
      );
      const infoBadge = document.querySelector(
        '[data-testid="log-level-badge-log_e2e_info_01"]',
      );
      const debugBadge = document.querySelector(
        '[data-testid="log-level-badge-log_e2e_debug_01"]',
      );
      if (!panel || !errBadge || !warnBadge || !infoBadge || !debugBadge) {
        return null;
      }
      return {
        panelWidth: panel.getBoundingClientRect().width,
        errColor: window.getComputedStyle(errBadge).color,
        warnColor: window.getComputedStyle(warnBadge).color,
        infoColor: window.getComputedStyle(infoBadge).color,
        debugColor: window.getComputedStyle(debugBadge).color,
        errBg: window.getComputedStyle(errBadge).backgroundColor,
      };
    });
    expect(badgeStyles).not.toBeNull();
    expect(badgeStyles!.panelWidth).toBeGreaterThan(400);
    expect(
      new Set([
        badgeStyles!.errColor,
        badgeStyles!.warnColor,
        badgeStyles!.infoColor,
        badgeStyles!.debugColor,
      ]).size,
    ).toBe(4);
    expect(badgeStyles!.errBg).not.toBe("rgba(0, 0, 0, 0)");

    // 8. Verify secret redaction in row message and expanded JSON details / stack trace
    const errorRow = page.getByTestId("log-row-log_e2e_error_01");
    await expect(errorRow).toContainText("[REDACTED]");
    await expect(errorRow).not.toContainText(CANARY_SECRET);

    await page.getByTestId("log-expand-button-log_e2e_error_01").click();
    await expect(
      page.getByTestId("log-fields-json-log_e2e_error_01"),
    ).toContainText("[REDACTED]");
    await expect(
      page.getByTestId("log-fields-json-log_e2e_error_01"),
    ).not.toContainText(CANARY_SECRET);
    await expect(
      page.getByTestId("log-error-stack-log_e2e_error_01"),
    ).toContainText("[REDACTED]");
    await expect(
      page.getByTestId("log-error-stack-log_e2e_error_01"),
    ).not.toContainText(CANARY_SECRET);

    // 9. Apply facet filters (level=error, workspaceId=ws_alpha, brickId=credit-wallet)
    await page.getByTestId("logs-level-pill-error").click();
    await page.getByTestId("logs-filter-workspace").fill("ws_alpha");
    await page.getByTestId("logs-filter-brick").fill("credit-wallet");

    await expect(page.getByTestId("log-row-log_e2e_error_01")).toBeVisible();
    await expect(page.getByTestId("log-row-log_e2e_warn_01")).toHaveCount(0);
    await expect(page.getByTestId("log-row-log_e2e_info_01")).toHaveCount(0);

    // 10. Reload the page (F5) and verify the Structured Logs panel and filters persist
    await page.reload();
    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await expect(page.getByTestId("structured-logs-panel")).toBeVisible();
    await expect(page.getByTestId("logs-filter-workspace")).toHaveValue(
      "ws_alpha",
    );
    await expect(page.getByTestId("logs-filter-brick")).toHaveValue(
      "credit-wallet",
    );
    await expect(page.getByTestId("log-row-log_e2e_error_01")).toBeVisible();
    await expect(page.getByTestId("log-row-log_e2e_warn_01")).toHaveCount(0);

    // 11. Click the log entry's node correlation chip (`node:node-charge`) to jump to CP4 Run Replay
    await page.getByTestId("log-chip-node-log_e2e_error_01").click();

    // Verify CP4 Run Replay banner is active for run_e2e_charge_fail_01 and Inspector is open for node-charge
    await expect(page.getByTestId("run-replay-banner")).toBeVisible();
    await expect(page.getByTestId("run-replay-banner")).toContainText(
      "run_e2e_charge_f",
    );
    await expect(page.getByTestId("canvas-node-node-charge")).toBeVisible();
    await expect(page.getByTestId("right-dock")).toContainText("node-charge");
  });
});
