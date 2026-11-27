import { expect, test } from "@playwright/test";

test.describe("Story 6.4 — Backend Health & Metrics Panel (Real Backend)", () => {
  test("renders request/error/latency/workflow/queue/D1 health metrics on Project Overview, persists window across F5 reload, and drills down to filtered Error Logs and Failed Workflow Runs", async ({
    page,
  }) => {
    await page.goto("/");

    // 1. Sign in as Alice (Owner) against real Better Auth + STUDIO_DB
    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await expect(page.getByTestId("project-selector")).toHaveValue("acme-saas");

    // 2. Ensure wf-billing has a failing credit-wallet.debit step and trigger a real failing run
    const addNodeRes = await page.request.post("/api/projects/acme-saas/ops", {
      data: {
        author: { type: "human", id: "alice" },
        summary: "Add credit-wallet.debit step node-health-charge to wf-billing",
        ops: [
          {
            opId: "op-add-node-health-s64",
            type: "add_node",
            workflowId: "wf-billing",
            node: {
              id: "node-health-charge",
              type: "credit-wallet.debit",
              label: "Debit Workspace Credits",
              data: { amount: 500 },
            },
          },
          {
            opId: "op-connect-node-health-s64",
            type: "connect_edges",
            workflowId: "wf-billing",
            edges: [
              {
                id: "edge-health-s64",
                source: "node-trigger",
                target: "node-health-charge",
                sourceHandle: "out",
                targetHandle: "in",
              },
            ],
          },
        ],
      },
    });
    expect(addNodeRes.status()).toBe(200);

    const runRes = await page.request.post("/api/projects/acme-saas/workflows/wf-billing/runs", {
      data: {
        env: "preview",
        runId: "run_e2e_health_fail_01",
        workspaceId: "ws_alpha",
        triggerPayload: {
          title: "INV-604",
          balance: 25,
          workspaceId: "ws_alpha",
        },
      },
    });
    expect(runRes.status()).toBe(200);

    // 3. Seed deterministic HTTP request samples (1h + 24h), queue DLQ depth, and error log entry
    const nowMs = Date.now();
    const min5Ago = new Date(nowMs - 5 * 60_000).toISOString();
    const hours6Ago = new Date(nowMs - 6 * 3600_000).toISOString();

    // Story 0.16: `reset` wipes the health tables of every project in the environment, so only a platform operator may
    // send it. Alice owns acme-saas but is not an operator: the reset is refused and nothing is written.
    const resetRes = await page.request.post("/api/projects/acme-saas/environments/preview/health/seed", {
      data: {
        reset: true,
        window: "1h",
        samples: [{ ts: min5Ago, routePrefix: "/webhooks/stripe", brickId: "webhook-gateway", status: 200, latencyMs: 10 }],
      },
    });
    expect(resetRes.status()).toBe(403);
    const resetBody = (await resetRes.json()) as { error: { code: string } };
    expect(resetBody.error.code).toBe("FORBIDDEN_PLATFORM_OPERATOR");

    // The owner seeds the project's health data without a reset (the e2e database starts empty).
    const seedRes = await page.request.post("/api/projects/acme-saas/environments/preview/health/seed", {
      data: {
        // Story 1.4: seeded rows belong to one of the project's own workspaces (its preview workspace here).
        workspaceId: "ws_default",
        window: "1h",
        samples: [
          ...Array.from({ length: 12 }, (_, idx) => ({
            ts: min5Ago,
            routePrefix: "/webhooks/stripe",
            brickId: "webhook-gateway",
            status: idx === 0 ? 500 : 200,
            latencyMs: 14 + idx * 4,
            d1Queries: 2,
            d1LatencyMs: 3.5,
            d1Errors: 0,
          })),
          ...Array.from({ length: 8 }, (_, idx) => ({
            ts: min5Ago,
            routePrefix: "/api/wallet/debit",
            brickId: "credit-wallet",
            status: idx === 0 ? 503 : idx === 1 ? 422 : 200,
            latencyMs: 35 + idx * 20,
            d1Queries: 3,
            d1LatencyMs: 6.2,
            d1Errors: idx === 0 ? 1 : 0,
          })),
        ],
        rollups: [
          {
            bucketMinute: hours6Ago,
            routePrefix: "/api/entities/invoices",
            brickId: "dynamic-entities",
            requestCount: 80,
            error4xxCount: 2,
            error5xxCount: 3,
            latencySamplesMs: [16, 24, 42, 88, 150],
            d1QueryCount: 160,
            d1LatencyMs: 5.0,
            d1ErrorCount: 1,
          },
        ],
        queues: [
          {
            queueName: "px-outbound-queue",
            pendingCount: 18,
            dlqCount: 2,
            updatedAt: min5Ago,
          },
        ],
      },
    });
    expect(seedRes.status()).toBe(200);

    const logIngestRes = await page.request.post("/api/projects/acme-saas/environments/preview/logs", {
      data: {
        entries: [
          {
            logId: "log_e2e_health_err_01",
            level: "error",
            message: "HTTP 503 credit-wallet debit timeout on /api/wallet/debit",
            runId: "run_e2e_health_fail_01",
            workflowId: "wf-billing",
            nodeId: "node-health-charge",
            brickId: "credit-wallet",
            workspaceId: "ws_alpha",
            errorStack: "Error: D1 busy timeout during wallet debit",
          },
        ],
      },
    });
    expect(logIngestRes.status()).toBe(201);

    // 4. Refresh Backend Health & Metrics Panel on Project Overview (Backend Map)
    await page.getByTestId("nav-tab-overview").click();
    await expect(page.getByTestId("backend-health-panel")).toBeVisible();
    await page.getByTestId("health-refresh-btn").click();

    await expect(page.getByTestId("health-metric-request-count")).toHaveText("20");
    await expect(page.getByTestId("health-metric-error-rate")).toHaveText("10%");
    await expect(page.getByTestId("health-metric-5xx-count")).toContainText("2 5xx");
    await expect(page.getByTestId("health-metric-queue-depth")).toHaveText("18 pending");
    await expect(page.getByTestId("health-metric-dlq-count")).toHaveText("2 DLQ messages");
    await expect(page.getByTestId("health-metric-d1-queries")).toHaveText("48");

    // Verify per-brick health badge and workflow failure badge on Backend Map
    await expect(page.getByTestId("backend-map-brick-health-credit-wallet")).toContainText("8 req · 1 5xx (12.5%)");
    await expect(page.getByTestId("backend-map-workflow-health-wf-billing")).toContainText("failed");

    // Verify computed styles on panel and sparkline bars
    const panelDisplay = await page.getByTestId("backend-health-panel").evaluate((el) => window.getComputedStyle(el).display);
    expect(panelDisplay).toBe("block");

    const sparklineBg = await page
      .getByTestId("health-sparkline-bar")
      .first()
      .evaluate((el) => window.getComputedStyle(el).backgroundColor);
    expect(sparklineBg).not.toBe("rgba(0, 0, 0, 0)");

    // 5. Switch to 24h window and verify persistence across F5 reload
    await page.getByTestId("health-window-24h").click();
    await expect(page.getByTestId("health-metric-request-count")).toHaveText("100");

    await page.reload();
    await expect(page.getByTestId("backend-health-panel")).toBeVisible();
    await expect(page.getByTestId("health-metric-request-count")).toHaveText("100");

    // 6. Switch back to 1h and drill down from credit-wallet 5xx badge to Structured Logs & Errors
    await page.getByTestId("health-window-1h").click();
    await expect(page.getByTestId("health-metric-request-count")).toHaveText("20");

    await page.getByTestId("health-drilldown-logs-credit-wallet").click();
    await expect(page.getByTestId("structured-logs-panel")).toBeVisible();
    await expect(page.getByTestId("logs-filter-brick")).toHaveValue("credit-wallet");
    await expect(page.getByTestId("log-row-log_e2e_health_err_01")).toBeVisible();

    // 7. Return to Overview and drill down from failing workflow link to Failed Runs
    await page.getByTestId("nav-tab-overview").click();
    await expect(page.getByTestId("backend-health-panel")).toBeVisible();
    await page.getByTestId("health-drilldown-workflow-wf-billing").click();

    await expect(page.getByTestId("run-history-drawer")).toBeVisible();
    await expect(page.getByTestId("run-row-run_e2e_health_fail_01")).toBeVisible();
  });
});
