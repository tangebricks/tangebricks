import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BackendHealthPanel } from "../src/components/BackendHealthPanel.tsx";
import { useStudioStore } from "../src/store.ts";
import type { EnvironmentHealthSummaryPayload } from "../src/api.ts";

function buildMockHealthSummary(
  window: "1h" | "24h" | "7d",
  env: "preview" | "production" = "preview",
): EnvironmentHealthSummaryPayload {
  const multiplier = window === "1h" ? 1 : window === "24h" ? 5 : 10;
  return {
    ok: true,
    project: "proj-health-ui",
    envName: env,
    env,
    window,
    generatedAt: "2026-06-20T18:00:00.000Z",
    requestCount: 20 * multiplier,
    requestsPerMinute: Number(((20 * multiplier) / 60).toFixed(2)),
    error4xxCount: 1 * multiplier,
    error5xxCount: 2 * multiplier,
    errorRatePercent: 10,
    latencyP50Ms: 28.5,
    latencyP95Ms: 185.2,
    latencyP99Ms: 310.4,
    d1: {
      queryCount: 48 * multiplier,
      p50Ms: 4.2,
      p95Ms: 9.8,
      errorCount: 1,
    },
    workflows: {
      totalRuns: 4 * multiplier,
      succeededRuns: 3 * multiplier,
      failedRuns: 1 * multiplier,
      successRatePercent: 75,
      topFailingWorkflows: [
        {
          workflowId: "wf_wallet_settlement",
          failedCount: 1 * multiplier,
          lastFailedRunId: "run_failed_settlement_99",
        },
      ],
    },
    queues: [
      {
        queueName: "px-outbound-queue",
        depth: 14,
        dlqCount: 2,
        updatedAt: "2026-06-20T17:58:00.000Z",
      },
    ],
    perBrick: [
      {
        brickId: "credit-wallet",
        routePrefix: "/api/wallet/debit",
        requestCount: 8 * multiplier,
        error4xxCount: 1 * multiplier,
        error5xxCount: 1 * multiplier,
        errorRatePercent: 12.5,
        p50Ms: 42,
        p95Ms: 210,
        p99Ms: 310.4,
      },
      {
        brickId: "webhook-gateway",
        routePrefix: "/webhooks/stripe",
        requestCount: 12 * multiplier,
        error4xxCount: 0,
        error5xxCount: 1 * multiplier,
        errorRatePercent: 8.33,
        p50Ms: 18,
        p95Ms: 95,
        p99Ms: 140,
      },
    ],
    series: Array.from({ length: 12 }, (_, idx) => ({
      bucketTs: new Date(
        Date.parse("2026-06-20T17:00:00.000Z") + idx * 5 * 60_000,
      ).toISOString(),
      requestCount: 2 * multiplier,
      error5xxCount: idx === 10 ? 1 : 0,
      p95Ms: 120 + idx * 5,
      failedRuns: idx === 10 ? 1 : 0,
    })),
    analyticsReconciliation: {
      source: "cloudflare-graphql+d1",
      cloudflareRequests: 20 * multiplier,
      cloudflareErrors: 2 * multiplier,
      cloudflareP95Ms: 185.2,
      deltaPercent: 0,
    },
  };
}

describe("Story 6.4 — BackendHealthPanel UI & Drill-down Navigation", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/?nav=overview");
    useStudioStore.setState({
      activeNav: "overview",
      runHistoryDrawerOpen: false,
      runsFilters: {
        env: "preview",
        workflowId: "all",
        status: "all",
        trigger: "all",
        timeRange: "all",
        from: "",
        to: "",
      },
      loadProjectRuns: vi.fn().mockResolvedValue(undefined),
      startRunReplay: vi.fn().mockResolvedValue(undefined),
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const urlStr =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const u = new URL(urlStr, "http://localhost");
      const win = (u.searchParams.get("window") ?? "1h") as "1h" | "24h" | "7d";
      const env = u.pathname.includes("/environments/production/")
        ? "production"
        : "preview";
      return new Response(
        JSON.stringify(buildMockHealthSummary(win, env)),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
  });

  test("renders 1h/24h/7d metrics, latency quantiles, queue DLQ depth, and persists window/env selection", async () => {
    render(<BackendHealthPanel project="proj-health-ui" />);

    await waitFor(() => {
      expect(
        screen.getByTestId("health-metric-request-count").textContent,
      ).toBe("20");
    });

    expect(screen.getByTestId("health-metric-error-rate").textContent).toBe(
      "10%",
    );
    expect(screen.getByTestId("health-metric-5xx-count").textContent).toContain(
      "2 5xx",
    );
    expect(screen.getByTestId("health-metric-p50").textContent).toBe("28.5ms");
    expect(screen.getByTestId("health-metric-p95").textContent).toBe("185.2ms");
    expect(screen.getByTestId("health-metric-p99").textContent).toBe("310.4ms");
    expect(screen.getByTestId("health-metric-failed-runs").textContent).toBe(
      "1 failed",
    );
    expect(screen.getByTestId("health-metric-queue-depth").textContent).toBe(
      "14 pending",
    );
    expect(screen.getByTestId("health-metric-dlq-count").textContent).toBe(
      "2 DLQ messages",
    );
    expect(screen.getByTestId("health-metric-d1-queries").textContent).toBe(
      "48",
    );
    expect(screen.getAllByTestId("health-sparkline-bar")).toHaveLength(12);

    // Switch to 24h window
    fireEvent.click(screen.getByTestId("health-window-24h"));
    await waitFor(() => {
      expect(
        screen.getByTestId("health-metric-request-count").textContent,
      ).toBe("100");
    });
    expect(window.location.search).toContain("healthWindow=24h");

    // Switch to 7d window
    fireEvent.click(screen.getByTestId("health-window-7d"));
    await waitFor(() => {
      expect(
        screen.getByTestId("health-metric-request-count").textContent,
      ).toBe("200");
    });
    expect(window.location.search).toContain("healthWindow=7d");
  });

  test("clicking 5xx Error Rate card or brick 5xx badge drills down to Structured Logs filtered to level=error", async () => {
    render(<BackendHealthPanel project="proj-health-ui" />);

    await waitFor(() => {
      expect(
        screen.getByTestId("health-drilldown-logs-credit-wallet"),
      ).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("health-drilldown-logs-credit-wallet"));

    const store = useStudioStore.getState();
    expect(store.activeNav).toBe("workflows");
    expect(store.runHistoryDrawerOpen).toBe(true);
    expect(window.sessionStorage.getItem("studio:runsDrawerSubTab")).toBe(
      "logs",
    );
    expect(window.location.search).toContain("drawer=logs");
    expect(window.location.search).toContain("logLevel=error");
    expect(window.location.search).toContain("logBrick=credit-wallet");
  });

  test("clicking Workflow Failures or top failing workflow drills down to Run History filtered to status=failed", async () => {
    render(<BackendHealthPanel project="proj-health-ui" />);

    await waitFor(() => {
      expect(
        screen.getByTestId("health-drilldown-workflow-wf_wallet_settlement"),
      ).toBeTruthy();
    });

    fireEvent.click(
      screen.getByTestId("health-drilldown-workflow-wf_wallet_settlement"),
    );

    const store = useStudioStore.getState();
    expect(store.activeNav).toBe("workflows");
    expect(store.runHistoryDrawerOpen).toBe(true);
    expect(store.runsFilters.status).toBe("failed");
    expect(store.runsFilters.workflowId).toBe("wf_wallet_settlement");
    expect(store.loadProjectRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        env: "preview",
        status: "failed",
        workflowId: "wf_wallet_settlement",
      }),
    );
  });
});
