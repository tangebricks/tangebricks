import React, { useCallback, useEffect, useState } from "react";
import { fetchEnvironmentHealth, type EnvironmentHealthSummaryPayload, type HealthWindowPayload } from "../api.ts";
import { useStudioStore } from "../store.ts";

export interface BackendHealthPanelProps {
  project: string;
  onHealthLoaded?: (summary: EnvironmentHealthSummaryPayload) => void;
}

interface PersistedHealthFilterState {
  env: "preview" | "production";
  window: HealthWindowPayload;
}

function getStorageKey(project: string): string {
  return `px_studio_health_state:${project}`;
}

function loadInitialHealthState(project: string): PersistedHealthFilterState {
  const defaults: PersistedHealthFilterState = {
    env: "preview",
    window: "1h",
  };
  if (typeof window === "undefined") return defaults;

  let fromStorage: Partial<PersistedHealthFilterState> = {};
  try {
    const raw = window.sessionStorage.getItem(getStorageKey(project));
    if (raw) {
      fromStorage = JSON.parse(raw) as Partial<PersistedHealthFilterState>;
    }
  } catch {
    fromStorage = {};
  }

  const params = new URLSearchParams(window.location.search);
  const envParam = params.get("healthEnv") ?? fromStorage.env ?? defaults.env;
  const winParam = params.get("healthWindow") ?? fromStorage.window ?? defaults.window;

  return {
    env: envParam === "production" ? "production" : "preview",
    window: winParam === "24h" || winParam === "7d" || winParam === "1h" ? winParam : "1h",
  };
}

function persistHealthState(project: string, state: PersistedHealthFilterState): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(getStorageKey(project), JSON.stringify(state));
  } catch {
    // ignore storage errors
  }
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("healthEnv", state.env);
    url.searchParams.set("healthWindow", state.window);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // ignore history errors
  }
}

export function drillDownToErrorLogs(options: {
  project: string;
  env: "preview" | "production";
  brickId?: string;
  setActiveNav: (nav: "workflows") => void;
  setRunHistoryDrawerOpen: (open: boolean) => void;
}): void {
  const { project, env, brickId, setActiveNav, setRunHistoryDrawerOpen } = options;
  if (typeof window !== "undefined") {
    try {
      const logState = {
        env,
        level: "error",
        workspaceId: "",
        brickId: brickId && brickId !== "all" ? brickId : "",
        workflowId: "",
        runId: "",
        nodeId: "",
        q: "",
        liveTail: true,
      };
      window.sessionStorage.setItem(`px_studio_structured_logs_state:${project}`, JSON.stringify(logState));
      window.sessionStorage.setItem("studio:runsDrawerSubTab", "logs");
    } catch {
      // ignore storage errors
    }
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("nav", "workflows");
      url.searchParams.set("drawer", "logs");
      url.searchParams.set("logEnv", env);
      url.searchParams.set("logLevel", "error");
      if (brickId && brickId !== "all") {
        url.searchParams.set("logBrick", brickId);
      } else {
        url.searchParams.delete("logBrick");
      }
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // ignore history errors
    }
  }
  setRunHistoryDrawerOpen(true);
  setActiveNav("workflows");
}

export function drillDownToFailedWorkflowRuns(options: {
  env: "preview" | "production";
  workflowId?: string;
  lastFailedRunId?: string | null;
  setActiveNav: (nav: "workflows") => void;
  setRunHistoryDrawerOpen: (open: boolean) => void;
  setRunsFilters: (filters: { env: "preview" | "production"; status: "failed"; workflowId: string }) => void;
  loadProjectRuns: (filters?: { env?: "preview" | "production"; status?: "failed"; workflowId?: string }) => Promise<unknown>;
  startRunReplay?: (runId: string, env?: "preview" | "production") => Promise<unknown>;
}): void {
  const { env, workflowId, lastFailedRunId, setActiveNav, setRunHistoryDrawerOpen, setRunsFilters, loadProjectRuns, startRunReplay } = options;
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem("studio:runsDrawerSubTab", "runs");
    } catch {
      // ignore
    }
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("nav", "workflows");
      url.searchParams.set("drawer", "runs");
      url.searchParams.set("runsEnv", env);
      url.searchParams.set("runsStatus", "failed");
      if (workflowId && workflowId !== "all") {
        url.searchParams.set("runsWf", workflowId);
      } else {
        url.searchParams.delete("runsWf");
      }
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // ignore
    }
  }
  const targetWf = workflowId ?? "all";
  setRunsFilters({
    env,
    status: "failed",
    workflowId: targetWf,
  });
  setRunHistoryDrawerOpen(true);
  setActiveNav("workflows");
  void loadProjectRuns({
    env,
    status: "failed",
    workflowId: targetWf,
  });
  if (lastFailedRunId && startRunReplay) {
    void startRunReplay(lastFailedRunId, env);
  }
}

export const BackendHealthPanel: React.FC<BackendHealthPanelProps> = ({ project, onHealthLoaded }) => {
  const setActiveNav = useStudioStore((s) => s.setActiveNav);
  const setRunHistoryDrawerOpen = useStudioStore((s) => s.setRunHistoryDrawerOpen);
  const setRunsFilters = useStudioStore((s) => s.setRunsFilters);
  const loadProjectRuns = useStudioStore((s) => s.loadProjectRuns);
  const startRunReplay = useStudioStore((s) => s.startRunReplay);

  const [filterState, setFilterState] = useState<PersistedHealthFilterState>(() => loadInitialHealthState(project));
  const [summary, setSummary] = useState<EnvironmentHealthSummaryPayload | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    persistHealthState(project, filterState);
  }, [project, filterState]);

  const loadHealth = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchEnvironmentHealth(project, filterState.env, {
        window: filterState.window,
      });
      if (res && typeof res.requestCount === "number" && res.workflows && res.d1) {
        setSummary(res);
        onHealthLoaded?.(res);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load backend health metrics");
    } finally {
      setLoading(false);
    }
  }, [project, filterState.env, filterState.window, onHealthLoaded]);

  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  const totalQueueDepth = (summary?.queues ?? []).reduce((acc, q) => acc + q.depth, 0);
  const totalDlqCount = (summary?.queues ?? []).reduce((acc, q) => acc + q.dlqCount, 0);
  const maxSeriesRequests = Math.max(1, ...(summary?.series ?? []).map((b) => b.requestCount));

  return (
    <section
      data-testid="backend-health-panel"
      style={{
        background: "#131722",
        border: "1px solid #1e2433",
        borderRadius: 10,
        padding: 16,
        marginTop: 18,
        color: "#e2e8f0",
      }}
    >
      {/* Header & Controls */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 14,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "#f8fafc",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span>Backend Health & Metrics</span>
            <span
              style={{
                fontSize: 10,
                padding: "2px 7px",
                borderRadius: 999,
                background:
                  (summary?.error5xxCount ?? 0) > 0 || (summary?.workflows.failedRuns ?? 0) > 0 ? "rgba(239, 68, 68, 0.16)" : "rgba(34, 197, 94, 0.16)",
                color: (summary?.error5xxCount ?? 0) > 0 || (summary?.workflows.failedRuns ?? 0) > 0 ? "#fca5a5" : "#86efac",
                fontWeight: 700,
              }}
            >
              {(summary?.error5xxCount ?? 0) > 0 || (summary?.workflows.failedRuns ?? 0) > 0 ? "Degraded / Errors Detected" : "Healthy"}
            </span>
          </div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
            Request rate, 5xx error rate, HTTP p50/p95/p99 latency, workflow failures, queue backlog/DLQ depth, and D1 query performance.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <select
            data-testid="health-env-select"
            aria-label="Health environment"
            value={filterState.env}
            onChange={(e) =>
              setFilterState((prev) => ({
                ...prev,
                env: e.target.value === "production" ? "production" : "preview",
              }))
            }
            style={{
              background: "#0b0d12",
              color: "#e2e8f0",
              border: "1px solid #334155",
              borderRadius: 6,
              padding: "4px 8px",
              fontSize: 11,
            }}
          >
            <option value="preview">Env: Preview</option>
            <option value="production">Env: Production</option>
          </select>

          <div
            style={{
              display: "inline-flex",
              background: "#0b0d12",
              border: "1px solid #334155",
              borderRadius: 6,
              overflow: "hidden",
            }}
          >
            {(["1h", "24h", "7d"] as const).map((win) => {
              const active = filterState.window === win;
              return (
                <button
                  key={win}
                  type="button"
                  data-testid={`health-window-${win}`}
                  onClick={() => setFilterState((prev) => ({ ...prev, window: win }))}
                  style={{
                    padding: "4px 10px",
                    fontSize: 11,
                    fontWeight: 700,
                    background: active ? "#1d4ed8" : "transparent",
                    color: active ? "#ffffff" : "#94a3b8",
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  {win}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            data-testid="health-refresh-btn"
            onClick={() => void loadHealth()}
            style={{
              padding: "4px 10px",
              fontSize: 11,
              fontWeight: 600,
              background: "#1e293b",
              color: "#e2e8f0",
              border: "1px solid #334155",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div
          data-testid="health-error-banner"
          style={{
            padding: "8px 12px",
            marginBottom: 12,
            borderRadius: 6,
            background: "rgba(239, 68, 68, 0.14)",
            border: "1px solid rgba(239, 68, 68, 0.35)",
            color: "#fca5a5",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      {/* 6 Summary Metric Cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(195px, 1fr))",
          gap: 10,
          marginBottom: 14,
        }}
      >
        {/* 1. Request Rate */}
        <div
          data-testid="health-card-requests"
          style={{
            background: "#0d111a",
            border: "1px solid #1e293b",
            borderRadius: 8,
            padding: 12,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase",
              color: "#94a3b8",
            }}
          >
            HTTP Requests ({filterState.window})
          </div>
          <div
            data-testid="health-metric-request-count"
            style={{
              fontSize: 20,
              fontWeight: 800,
              color: "#f8fafc",
              marginTop: 4,
            }}
          >
            {summary?.requestCount ?? 0}
          </div>
          <div data-testid="health-metric-rpm" style={{ fontSize: 11, color: "#60a5fa", marginTop: 2 }}>
            {summary?.requestsPerMinute ?? 0} req/min
          </div>
          {/* Sparkline */}
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: 2,
              height: 22,
              marginTop: 8,
            }}
          >
            {(summary?.series ?? []).map((b, idx) => {
              const pct = Math.max(15, Math.round((b.requestCount / maxSeriesRequests) * 100));
              return (
                <div
                  key={b.bucketTs || idx}
                  data-testid="health-sparkline-bar"
                  style={{
                    flex: 1,
                    height: `${pct}%`,
                    background: b.error5xxCount > 0 ? "#ef4444" : "#3b82f6",
                    borderRadius: 2,
                  }}
                />
              );
            })}
          </div>
        </div>

        {/* 2. Error Rate (5xx %) — Clickable drill-down to Structured Logs */}
        <button
          type="button"
          data-testid="health-card-error-rate"
          onClick={() =>
            drillDownToErrorLogs({
              project,
              env: filterState.env,
              setActiveNav,
              setRunHistoryDrawerOpen,
            })
          }
          style={{
            textAlign: "left",
            background: "#0d111a",
            border: (summary?.error5xxCount ?? 0) > 0 ? "1px solid rgba(239, 68, 68, 0.5)" : "1px solid #1e293b",
            borderRadius: 8,
            padding: 12,
            cursor: "pointer",
            color: "#e2e8f0",
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase",
              color: "#94a3b8",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>5xx Error Rate</span>
            <span style={{ color: "#93c5fd" }}>Logs ↗</span>
          </div>
          <div
            data-testid="health-metric-error-rate"
            style={{
              fontSize: 20,
              fontWeight: 800,
              color: (summary?.error5xxCount ?? 0) > 0 ? "#fca5a5" : "#86efac",
              marginTop: 4,
            }}
          >
            {summary?.errorRatePercent ?? 0}%
          </div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
            <span data-testid="health-metric-5xx-count">{summary?.error5xxCount ?? 0} 5xx</span> ·{" "}
            <span data-testid="health-metric-4xx-count">{summary?.error4xxCount ?? 0} 4xx</span>
          </div>
        </button>

        {/* 3. HTTP Latency Quantiles (p50 / p95 / p99) */}
        <div
          data-testid="health-card-latency"
          style={{
            background: "#0d111a",
            border: "1px solid #1e293b",
            borderRadius: 8,
            padding: 12,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase",
              color: "#94a3b8",
            }}
          >
            HTTP Latency (p50 / p95 / p99)
          </div>
          <div
            style={{
              fontSize: 16,
              fontWeight: 800,
              color: "#f8fafc",
              marginTop: 6,
              fontFamily: "monospace",
            }}
          >
            <span data-testid="health-metric-p50">{summary?.latencyP50Ms ?? 0}ms</span> /{" "}
            <span data-testid="health-metric-p95" style={{ color: "#fbbf24" }}>
              {summary?.latencyP95Ms ?? 0}ms
            </span>{" "}
            /{" "}
            <span data-testid="health-metric-p99" style={{ color: "#f87171" }}>
              {summary?.latencyP99Ms ?? 0}ms
            </span>
          </div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>Quantiles across {filterState.window} rollups</div>
        </div>

        {/* 4. Workflow Failures — Clickable drill-down to Failed Runs */}
        <button
          type="button"
          data-testid="health-card-workflows"
          onClick={() =>
            drillDownToFailedWorkflowRuns({
              env: filterState.env,
              setActiveNav,
              setRunHistoryDrawerOpen,
              setRunsFilters,
              loadProjectRuns,
              startRunReplay,
            })
          }
          style={{
            textAlign: "left",
            background: "#0d111a",
            border: (summary?.workflows.failedRuns ?? 0) > 0 ? "1px solid rgba(239, 68, 68, 0.5)" : "1px solid #1e293b",
            borderRadius: 8,
            padding: 12,
            cursor: "pointer",
            color: "#e2e8f0",
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase",
              color: "#94a3b8",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>Workflow Failures</span>
            <span style={{ color: "#93c5fd" }}>Runs ↗</span>
          </div>
          <div
            data-testid="health-metric-failed-runs"
            style={{
              fontSize: 20,
              fontWeight: 800,
              color: (summary?.workflows.failedRuns ?? 0) > 0 ? "#fca5a5" : "#86efac",
              marginTop: 4,
            }}
          >
            {summary?.workflows.failedRuns ?? 0} failed
          </div>
          <div data-testid="health-metric-workflow-success" style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
            {summary?.workflows.successRatePercent ?? 100}% success ({summary?.workflows.totalRuns ?? 0} total)
          </div>
        </button>

        {/* 5. Queue Backlog & DLQ Depth */}
        <div
          data-testid="health-card-queues"
          style={{
            background: "#0d111a",
            border: totalDlqCount > 0 ? "1px solid rgba(245, 158, 11, 0.5)" : "1px solid #1e293b",
            borderRadius: 8,
            padding: 12,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase",
              color: "#94a3b8",
            }}
          >
            Queue Backlog / DLQ
          </div>
          <div
            data-testid="health-metric-queue-depth"
            style={{
              fontSize: 20,
              fontWeight: 800,
              color: "#f8fafc",
              marginTop: 4,
            }}
          >
            {totalQueueDepth} pending
          </div>
          <div
            data-testid="health-metric-dlq-count"
            style={{
              fontSize: 11,
              color: totalDlqCount > 0 ? "#fbbf24" : "#94a3b8",
              marginTop: 2,
            }}
          >
            {totalDlqCount} DLQ messages
          </div>
        </div>

        {/* 6. D1 Query Performance */}
        <div
          data-testid="health-card-d1"
          style={{
            background: "#0d111a",
            border: "1px solid #1e293b",
            borderRadius: 8,
            padding: 12,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase",
              color: "#94a3b8",
            }}
          >
            D1 Database Queries
          </div>
          <div
            data-testid="health-metric-d1-queries"
            style={{
              fontSize: 20,
              fontWeight: 800,
              color: "#f8fafc",
              marginTop: 4,
            }}
          >
            {summary?.d1.queryCount ?? 0}
          </div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
            p50 {summary?.d1.p50Ms ?? 0}ms · p95 {summary?.d1.p95Ms ?? 0}ms · {summary?.d1.errorCount ?? 0} errors
          </div>
        </div>
      </div>

      {/* Per-Brick Route Health & Queue / Workflow Breakdown */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 12,
        }}
      >
        {/* Per-Brick Route Table */}
        <div
          style={{
            background: "#0d111a",
            border: "1px solid #1e293b",
            borderRadius: 8,
            padding: 12,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              color: "#94a3b8",
              marginBottom: 8,
            }}
          >
            Per-Brick HTTP Route Rollups
          </div>
          {(summary?.perBrick ?? []).length === 0 ? (
            <div style={{ fontSize: 12, color: "#94a3b8" }}>No HTTP route rollups recorded in this window.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {(summary?.perBrick ?? []).map((b) => (
                <div
                  key={`${b.brickId}:${b.routePrefix}`}
                  data-testid={`health-brick-row-${b.brickId}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    padding: "6px 8px",
                    background: "#131722",
                    borderRadius: 6,
                    border: "1px solid #1e293b",
                    fontSize: 11,
                  }}
                >
                  <div>
                    <span style={{ fontWeight: 700, color: "#f8fafc" }}>{b.brickId}</span>{" "}
                    <span style={{ color: "#94a3b8", fontFamily: "monospace" }}>{b.routePrefix}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: "#cbd5e1" }}>{b.requestCount} req</span>
                    <span style={{ color: "#94a3b8", fontFamily: "monospace" }}>p95 {b.p95Ms}ms</span>
                    <button
                      type="button"
                      data-testid={`health-drilldown-logs-${b.brickId}`}
                      onClick={() =>
                        drillDownToErrorLogs({
                          project,
                          env: filterState.env,
                          brickId: b.brickId,
                          setActiveNav,
                          setRunHistoryDrawerOpen,
                        })
                      }
                      style={{
                        padding: "2px 7px",
                        fontSize: 10,
                        fontWeight: 700,
                        borderRadius: 4,
                        background: b.error5xxCount > 0 ? "rgba(239, 68, 68, 0.2)" : "rgba(59, 130, 246, 0.14)",
                        color: b.error5xxCount > 0 ? "#fca5a5" : "#93c5fd",
                        border: "1px solid rgba(239, 68, 68, 0.35)",
                        cursor: "pointer",
                      }}
                    >
                      {b.error5xxCount} 5xx ({b.errorRatePercent}%) ↗
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Failing Workflows & Queues / DLQ */}
        <div
          style={{
            background: "#0d111a",
            border: "1px solid #1e293b",
            borderRadius: 8,
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                color: "#94a3b8",
                marginBottom: 6,
              }}
            >
              Top Failing Workflows
            </div>
            {(summary?.workflows.topFailingWorkflows ?? []).length === 0 ? (
              <div style={{ fontSize: 12, color: "#94a3b8" }}>Zero workflow failures in this window.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(summary?.workflows.topFailingWorkflows ?? []).map((wf) => (
                  <div
                    key={wf.workflowId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "6px 8px",
                      background: "#131722",
                      borderRadius: 6,
                      border: "1px solid rgba(239, 68, 68, 0.3)",
                      fontSize: 11,
                    }}
                  >
                    <span style={{ fontWeight: 700, color: "#f8fafc" }}>{wf.workflowId}</span>
                    <button
                      type="button"
                      data-testid={`health-drilldown-workflow-${wf.workflowId}`}
                      onClick={() =>
                        drillDownToFailedWorkflowRuns({
                          env: filterState.env,
                          workflowId: wf.workflowId,
                          lastFailedRunId: wf.lastFailedRunId,
                          setActiveNav,
                          setRunHistoryDrawerOpen,
                          setRunsFilters,
                          loadProjectRuns,
                          startRunReplay,
                        })
                      }
                      style={{
                        padding: "2px 8px",
                        fontSize: 10,
                        fontWeight: 700,
                        borderRadius: 4,
                        background: "rgba(239, 68, 68, 0.2)",
                        color: "#fca5a5",
                        border: "1px solid rgba(239, 68, 68, 0.4)",
                        cursor: "pointer",
                      }}
                    >
                      {wf.failedCount} failed · Inspect Runs ↗
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                color: "#94a3b8",
                marginBottom: 6,
              }}
            >
              Queues & Dead-Letter Queues (DLQ)
            </div>
            {(summary?.queues ?? []).length === 0 ? (
              <div style={{ fontSize: 12, color: "#94a3b8" }}>No queue backlog or DLQ activity recorded.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(summary?.queues ?? []).map((q) => (
                  <div
                    key={q.queueName}
                    data-testid={`health-queue-row-${q.queueName}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "6px 8px",
                      background: "#131722",
                      borderRadius: 6,
                      border: "1px solid #1e293b",
                      fontSize: 11,
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 700,
                        color: "#f8fafc",
                        fontFamily: "monospace",
                      }}
                    >
                      {q.queueName}
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ color: "#cbd5e1" }}>{q.depth} pending</span>
                      <button
                        type="button"
                        data-testid={`health-drilldown-dlq-${q.queueName}`}
                        onClick={() =>
                          drillDownToFailedWorkflowRuns({
                            env: filterState.env,
                            setActiveNav,
                            setRunHistoryDrawerOpen,
                            setRunsFilters,
                            loadProjectRuns,
                            startRunReplay,
                          })
                        }
                        style={{
                          padding: "2px 7px",
                          fontSize: 10,
                          fontWeight: 700,
                          borderRadius: 4,
                          background: q.dlqCount > 0 ? "rgba(245, 158, 11, 0.2)" : "rgba(51, 65, 85, 0.4)",
                          color: q.dlqCount > 0 ? "#fcd34d" : "#94a3b8",
                          border: "1px solid rgba(245, 158, 11, 0.35)",
                          cursor: "pointer",
                        }}
                      >
                        DLQ: {q.dlqCount} ↗
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};
