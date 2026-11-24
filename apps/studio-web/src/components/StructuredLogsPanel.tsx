import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchEnvironmentLogs } from "../api.ts";
import type { StructuredLogEntryPayload } from "../api.ts";
import { useStudioStore } from "../store.ts";

export type LogLevelFilter = "all" | "error" | "warn" | "info" | "debug";

export interface StructuredLogsFilterState {
  env: "preview" | "production";
  level: LogLevelFilter;
  workspaceId: string;
  brickId: string;
  workflowId: string;
  runId: string;
  nodeId: string;
  q: string;
  liveTail: boolean;
}

const STORAGE_PREFIX = "px_studio_structured_logs_state:";

function readInitialLogsState(project: string): StructuredLogsFilterState {
  const defaults: StructuredLogsFilterState = {
    env: "preview",
    level: "all",
    workspaceId: "",
    brickId: "",
    workflowId: "",
    runId: "",
    nodeId: "",
    q: "",
    liveTail: true,
  };

  if (typeof window === "undefined") {
    return defaults;
  }

  let stored: Partial<StructuredLogsFilterState> = {};
  try {
    const raw = window.sessionStorage.getItem(`${STORAGE_PREFIX}${project}`);
    if (raw) {
      stored = JSON.parse(raw) as Partial<StructuredLogsFilterState>;
    }
  } catch {
    // Ignore storage parse errors
  }

  const params = new URLSearchParams(window.location.search);
  const urlEnv = params.get("logEnv");
  const urlLevel = params.get("logLevel");
  const urlWs = params.get("logWs");
  const urlBrick = params.get("logBrick");
  const urlWf = params.get("logWf");
  const urlRun = params.get("logRunId");
  const urlNode = params.get("logNodeId");
  const urlQ = params.get("logQ");
  const urlLiveTail = params.get("liveTail");

  const resolvedEnv =
    urlEnv === "production" || urlEnv === "preview"
      ? urlEnv
      : stored.env === "production"
        ? "production"
        : "preview";

  const validLevels: LogLevelFilter[] = ["all", "error", "warn", "info", "debug"];
  const resolvedLevel: LogLevelFilter =
    urlLevel && validLevels.includes(urlLevel as LogLevelFilter)
      ? (urlLevel as LogLevelFilter)
      : stored.level && validLevels.includes(stored.level)
        ? stored.level
        : "all";

  return {
    env: resolvedEnv,
    level: resolvedLevel,
    workspaceId: urlWs !== null ? urlWs : (stored.workspaceId ?? ""),
    brickId: urlBrick !== null ? urlBrick : (stored.brickId ?? ""),
    workflowId: urlWf !== null ? urlWf : (stored.workflowId ?? ""),
    runId: urlRun !== null ? urlRun : (stored.runId ?? ""),
    nodeId: urlNode !== null ? urlNode : (stored.nodeId ?? ""),
    q: urlQ !== null ? urlQ : (stored.q ?? ""),
    liveTail:
      urlLiveTail !== null
        ? urlLiveTail !== "0" && urlLiveTail !== "false"
        : (stored.liveTail ?? true),
  };
}

function persistLogsState(project: string, state: StructuredLogsFilterState): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      `${STORAGE_PREFIX}${project}`,
      JSON.stringify(state),
    );
  } catch {
    // Ignore storage write errors
  }

  try {
    const url = new URL(window.location.href);
    url.searchParams.set("drawer", "logs");
    url.searchParams.set("logEnv", state.env);
    if (state.level !== "all") {
      url.searchParams.set("logLevel", state.level);
    } else {
      url.searchParams.delete("logLevel");
    }
    if (state.workspaceId.trim()) {
      url.searchParams.set("logWs", state.workspaceId.trim());
    } else {
      url.searchParams.delete("logWs");
    }
    if (state.brickId.trim()) {
      url.searchParams.set("logBrick", state.brickId.trim());
    } else {
      url.searchParams.delete("logBrick");
    }
    if (state.workflowId.trim()) {
      url.searchParams.set("logWf", state.workflowId.trim());
    } else {
      url.searchParams.delete("logWf");
    }
    if (state.runId.trim()) {
      url.searchParams.set("logRunId", state.runId.trim());
    } else {
      url.searchParams.delete("logRunId");
    }
    if (state.nodeId.trim()) {
      url.searchParams.set("logNodeId", state.nodeId.trim());
    } else {
      url.searchParams.delete("logNodeId");
    }
    if (state.q.trim()) {
      url.searchParams.set("logQ", state.q.trim());
    } else {
      url.searchParams.delete("logQ");
    }
    url.searchParams.set("liveTail", state.liveTail ? "1" : "0");
    window.history.replaceState({}, "", url.toString());
  } catch {
    // Ignore URL replaceState errors
  }
}

function getLevelBadgeMeta(level: StructuredLogEntryPayload["level"]): {
  icon: string;
  label: string;
  style: React.CSSProperties;
  className: string;
} {
  switch (level) {
    case "error":
      return {
        icon: "✕",
        label: "ERROR",
        style: {
          color: "rgb(254, 205, 211)",
          backgroundColor: "rgba(244, 63, 94, 0.22)",
          borderColor: "rgb(244, 63, 94)",
        },
        className: "bg-rose-500/20 border-rose-500 text-rose-200",
      };
    case "warn":
      return {
        icon: "⚠",
        label: "WARN",
        style: {
          color: "rgb(253, 230, 138)",
          backgroundColor: "rgba(245, 158, 11, 0.22)",
          borderColor: "rgb(245, 158, 11)",
        },
        className: "bg-amber-500/20 border-amber-500 text-amber-200",
      };
    case "info":
      return {
        icon: "ℹ",
        label: "INFO",
        style: {
          color: "rgb(186, 230, 253)",
          backgroundColor: "rgba(14, 165, 233, 0.22)",
          borderColor: "rgb(56, 189, 248)",
        },
        className: "bg-sky-500/20 border-sky-400 text-sky-200",
      };
    case "debug":
    default:
      return {
        icon: "⚙",
        label: "DEBUG",
        style: {
          color: "rgb(203, 213, 225)",
          backgroundColor: "rgba(100, 116, 139, 0.22)",
          borderColor: "rgb(148, 163, 184)",
        },
        className: "bg-slate-500/20 border-slate-400 text-slate-300",
      };
  }
}

function matchesClientFilter(
  entry: StructuredLogEntryPayload,
  filters: StructuredLogsFilterState,
): boolean {
  if (filters.level !== "all" && entry.level !== filters.level) {
    return false;
  }
  if (
    filters.workspaceId.trim() &&
    entry.workspaceId !== filters.workspaceId.trim()
  ) {
    return false;
  }
  if (filters.brickId.trim() && entry.brickId !== filters.brickId.trim()) {
    return false;
  }
  if (
    filters.workflowId.trim() &&
    entry.workflowId !== filters.workflowId.trim()
  ) {
    return false;
  }
  if (filters.runId.trim() && entry.runId !== filters.runId.trim()) {
    return false;
  }
  if (filters.nodeId.trim() && entry.nodeId !== filters.nodeId.trim()) {
    return false;
  }
  if (filters.q.trim()) {
    const needle = filters.q.trim().toLowerCase();
    const hay = `${entry.message} ${entry.fieldsJson ?? ""} ${entry.errorStack ?? ""} ${entry.nodeId ?? ""} ${entry.runId ?? ""} ${entry.brickId ?? ""} ${entry.workspaceId ?? ""}`.toLowerCase();
    if (!hay.includes(needle)) {
      return false;
    }
  }
  return true;
}

export interface StructuredLogsPanelProps {
  project?: string;
}

export function StructuredLogsPanel({ project: propProject }: StructuredLogsPanelProps) {
  const activeProjectId = useStudioStore((s) => s.activeProjectId);
  const projectState = useStudioStore((s) => s.projectState);
  const activeOrgId = useStudioStore((s) => s.activeOrgId);
  const startRunReplay = useStudioStore((s) => s.startRunReplay);

  const project =
    propProject ?? projectState?.project ?? activeProjectId ?? "default";

  const [filters, setFilters] = useState<StructuredLogsFilterState>(() =>
    readInitialLogsState(project),
  );
  const [logs, setLogs] = useState<StructuredLogEntryPayload[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pausedByScroll, setPausedByScroll] = useState(false);
  const [expandedLogIds, setExpandedLogIds] = useState<Record<string, boolean>>(
    {},
  );

  const nextCursorRef = useRef<number>(0);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    persistLogsState(project, filters);
  }, [project, filters]);

  const updateFilter = useCallback(
    (patch: Partial<StructuredLogsFilterState>) => {
      setFilters((prev) => ({ ...prev, ...patch }));
    },
    [],
  );

  const loadLogs = useCallback(
    async (currentFilters: StructuredLogsFilterState) => {
      if (!project) return;
      setLoading(true);
      setError(null);
      try {
        const res = await fetchEnvironmentLogs(project, currentFilters.env, {
          orgId: activeOrgId ?? undefined,
          level:
            currentFilters.level === "all" ? undefined : currentFilters.level,
          workspaceId: currentFilters.workspaceId.trim() || undefined,
          brickId: currentFilters.brickId.trim() || undefined,
          workflowId: currentFilters.workflowId.trim() || undefined,
          runId: currentFilters.runId.trim() || undefined,
          nodeId: currentFilters.nodeId.trim() || undefined,
          q: currentFilters.q.trim() || undefined,
          limit: 200,
        });
        const entries = Array.isArray(res.logs) ? res.logs : [];
        setLogs(entries);
        const maxSeq = entries.reduce(
          (acc, item) => Math.max(acc, item.seq ?? 0),
          res.nextCursor ?? 0,
        );
        nextCursorRef.current = maxSeq;
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load structured logs",
        );
      } finally {
        setLoading(false);
      }
    },
    [project, activeOrgId],
  );

  useEffect(() => {
    void loadLogs(filters);
  }, [
    loadLogs,
    filters.env,
    filters.level,
    filters.workspaceId,
    filters.brickId,
    filters.workflowId,
    filters.runId,
    filters.nodeId,
    filters.q,
  ]);

  // Listen for live WebSocket log frames
  useEffect(() => {
    if (!filters.liveTail || pausedByScroll) return;

    const handleWsLog = (ev: Event) => {
      const customEv = ev as CustomEvent<{
        type: "log";
        project?: string;
        envName?: "preview" | "production";
        entry?: StructuredLogEntryPayload;
      }>;
      const detail = customEv.detail;
      if (!detail?.entry) return;
      if (detail.project && detail.project !== project) return;
      if (detail.envName && detail.envName !== filters.env) return;

      const entry = detail.entry;
      if (typeof entry.seq === "number" && entry.seq > nextCursorRef.current) {
        nextCursorRef.current = entry.seq;
      }
      setLogs((prev) => {
        if (prev.some((existing) => existing.logId === entry.logId)) {
          return prev;
        }
        return [...prev, entry];
      });
    };

    window.addEventListener("px-studio-log-frame", handleWsLog);
    return () => {
      window.removeEventListener("px-studio-log-frame", handleWsLog);
    };
  }, [project, filters.env, filters.liveTail, pausedByScroll]);

  const filteredLogs = useMemo(
    () => logs.filter((entry) => matchesClientFilter(entry, filters)),
    [logs, filters],
  );

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el || !filters.liveTail) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > 48) {
      setPausedByScroll(true);
    } else if (pausedByScroll && distanceFromBottom <= 16) {
      setPausedByScroll(false);
    }
  }, [filters.liveTail, pausedByScroll]);

  const handleJumpToReplay = useCallback(
    async (entry: StructuredLogEntryPayload) => {
      if (!entry.runId) return;
      await startRunReplay(
        entry.runId,
        filters.env,
        entry.nodeId ?? null,
      );
    },
    [startRunReplay, filters.env],
  );

  const toggleExpandRow = useCallback((logId: string) => {
    setExpandedLogIds((prev) => ({
      ...prev,
      [logId]: !prev[logId],
    }));
  }, []);

  const workflows = projectState?.workflows ?? [];
  const enabledBricks = projectState?.bricks ?? [];

  return (
    <div
      data-testid="structured-logs-panel"
      className="space-y-3 text-xs"
    >
      {/* Header + Live Tail + Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-bold text-text-primary">
            ▤ Structured Logs &amp; Errors ({filteredLogs.length})
          </span>
          <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 font-mono text-[10px] text-emerald-300">
            Redaction: active ([REDACTED])
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Environment selector */}
          <select
            aria-label="Log environment"
            data-testid="logs-filter-env"
            value={filters.env}
            onChange={(e) =>
              updateFilter({
                env: e.target.value === "production" ? "production" : "preview",
              })
            }
            className="px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary"
          >
            <option value="preview">env: preview</option>
            <option value="production">env: production</option>
          </select>

          {/* Live Tail toggle */}
          <button
            type="button"
            data-testid="logs-live-tail-toggle"
            aria-pressed={filters.liveTail && !pausedByScroll}
            onClick={() => {
              if (pausedByScroll) {
                setPausedByScroll(false);
                updateFilter({ liveTail: true });
              } else {
                updateFilter({ liveTail: !filters.liveTail });
              }
            }}
            className={`px-2.5 py-1 rounded border font-mono text-[11px] font-semibold transition flex items-center gap-1.5 ${
              filters.liveTail && !pausedByScroll
                ? "bg-emerald-500/20 border-emerald-400 text-emerald-200"
                : "bg-surface-control border-border-strong text-text-secondary"
            }`}
          >
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                filters.liveTail && !pausedByScroll
                  ? "bg-emerald-400 animate-pulse"
                  : "bg-slate-500"
              }`}
            />
            {filters.liveTail
              ? pausedByScroll
                ? "Live Tail (Paused on scroll)"
                : "Live Tail: ON"
              : "Live Tail: OFF"}
          </button>

          {pausedByScroll && (
            <button
              type="button"
              data-testid="logs-resume-live-tail-button"
              onClick={() => {
                setPausedByScroll(false);
                const el = scrollContainerRef.current;
                if (el) {
                  el.scrollTop = el.scrollHeight;
                }
              }}
              className="px-2 py-1 rounded bg-amber-500/20 border border-amber-400 text-amber-200 font-semibold text-[11px]"
            >
              ↓ Resume Live Tail
            </button>
          )}

          <button
            type="button"
            data-testid="logs-refresh-button"
            onClick={() => void loadLogs(filters)}
            className="px-2.5 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-[11px] font-semibold text-text-secondary"
          >
            {loading ? "Loading…" : "↻ Refresh"}
          </button>
        </div>
      </div>

      {/* Filter Bar: Level Pills + Facet Controls */}
      <div className="flex flex-wrap items-center gap-2 p-2.5 rounded bg-surface-base border border-border">
        {/* Level Pills */}
        <div
          role="group"
          aria-label="Filter logs by level"
          className="flex items-center gap-1"
        >
          {(["all", "error", "warn", "info", "debug"] as const).map((lvl) => {
            const active = filters.level === lvl;
            return (
              <button
                key={lvl}
                type="button"
                data-testid={`logs-level-pill-${lvl}`}
                aria-pressed={active}
                onClick={() => updateFilter({ level: lvl })}
                className={`px-2 py-0.5 rounded font-mono text-[10px] font-bold uppercase border transition ${
                  active
                    ? "bg-accent/20 border-accent text-accent"
                    : "bg-surface-control border-border text-text-muted hover:text-text-primary"
                }`}
              >
                {lvl}
              </button>
            );
          })}
        </div>

        {/* Select fallback for level */}
        <select
          aria-label="Filter by log level"
          data-testid="logs-filter-level"
          value={filters.level}
          onChange={(e) =>
            updateFilter({ level: e.target.value as LogLevelFilter })
          }
          className="px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary"
        >
          <option value="all">All levels</option>
          <option value="error">error</option>
          <option value="warn">warn</option>
          <option value="info">info</option>
          <option value="debug">debug</option>
        </select>

        {/* Workspace filter */}
        <input
          type="text"
          aria-label="Filter by workspaceId"
          data-testid="logs-filter-workspace"
          placeholder="workspaceId (e.g. ws_alpha)"
          value={filters.workspaceId}
          onChange={(e) => updateFilter({ workspaceId: e.target.value })}
          className="px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary w-36"
        />

        {/* Brick filter */}
        <input
          type="text"
          aria-label="Filter by brickId"
          data-testid="logs-filter-brick"
          list="logs-brick-options"
          placeholder="brickId (e.g. credit-wallet)"
          value={filters.brickId}
          onChange={(e) => updateFilter({ brickId: e.target.value })}
          className="px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary w-36"
        />
        <datalist id="logs-brick-options">
          {enabledBricks.map((b) => (
            <option key={b.id} value={b.id} />
          ))}
        </datalist>

        {/* Workflow filter */}
        <input
          type="text"
          aria-label="Filter by workflowId"
          data-testid="logs-filter-workflow"
          list="logs-workflow-options"
          placeholder="workflowId"
          value={filters.workflowId}
          onChange={(e) => updateFilter({ workflowId: e.target.value })}
          className="px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary w-32"
        />
        <datalist id="logs-workflow-options">
          {workflows.map((wf) => (
            <option key={wf.id} value={wf.id} />
          ))}
        </datalist>

        {/* Run ID filter */}
        <input
          type="text"
          aria-label="Filter by runId"
          data-testid="logs-filter-run"
          placeholder="runId"
          value={filters.runId}
          onChange={(e) => updateFilter({ runId: e.target.value })}
          className="px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary w-36"
        />

        {/* Node ID filter */}
        <input
          type="text"
          aria-label="Filter by nodeId"
          data-testid="logs-filter-node"
          placeholder="nodeId"
          value={filters.nodeId}
          onChange={(e) => updateFilter({ nodeId: e.target.value })}
          className="px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary w-36"
        />

        {/* Free-text search */}
        <input
          type="search"
          aria-label="Search logs"
          data-testid="logs-filter-search"
          placeholder="Search message, fields, stack…"
          value={filters.q}
          onChange={(e) => updateFilter({ q: e.target.value })}
          className="px-2.5 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary flex-1 min-w-[160px]"
        />

        {(filters.level !== "all" ||
          filters.workspaceId ||
          filters.brickId ||
          filters.workflowId ||
          filters.runId ||
          filters.nodeId ||
          filters.q) && (
          <button
            type="button"
            data-testid="logs-clear-filters-button"
            onClick={() =>
              updateFilter({
                level: "all",
                workspaceId: "",
                brickId: "",
                workflowId: "",
                runId: "",
                nodeId: "",
                q: "",
              })
            }
            className="px-2 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border text-[10px] font-semibold text-text-muted hover:text-text-primary"
          >
            Clear Filters ✕
          </button>
        )}
      </div>

      {error && (
        <div
          role="alert"
          data-testid="logs-error-banner"
          className="p-2.5 rounded bg-rose-500/15 border border-rose-500/40 text-rose-200 font-mono text-[11px]"
        >
          {error}
        </div>
      )}

      {/* Monospace Structured Log Rows */}
      {filteredLogs.length === 0 ? (
        <div
          data-testid="logs-empty-state"
          className="p-4 rounded bg-surface-base border border-border text-text-muted text-center font-mono text-[11px]"
        >
          {loading
            ? "Loading structured logs…"
            : "No structured log entries match the active filters."}
        </div>
      ) : (
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          data-testid="logs-scroll-container"
          className="space-y-1.5 max-h-72 overflow-y-auto font-mono"
        >
          {filteredLogs.map((entry) => {
            const badge = getLevelBadgeMeta(entry.level);
            const isExpanded = Boolean(expandedLogIds[entry.logId]);
            const hasDetails =
              Boolean(entry.errorStack) ||
              (entry.fields && Object.keys(entry.fields).length > 0) ||
              (entry.fieldsJson && entry.fieldsJson !== "{}");

            return (
              <div
                key={entry.logId}
                data-testid={`log-row-${entry.logId}`}
                data-log-id={entry.logId}
                data-level={entry.level}
                className="p-2 rounded bg-slate-950/90 border border-border hover:border-border-strong transition space-y-1.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                    {/* Timestamp */}
                    <span
                      data-testid={`log-ts-${entry.logId}`}
                      className="text-[10px] text-text-muted shrink-0"
                    >
                      {entry.ts}
                    </span>

                    {/* Level Badge (icon + text, distinct computed style) */}
                    <span
                      data-testid={`log-level-badge-${entry.logId}`}
                      data-level={entry.level}
                      style={badge.style}
                      className={`px-1.5 py-0.5 rounded border font-bold text-[10px] inline-flex items-center gap-1 shrink-0 ${badge.className}`}
                    >
                      <span aria-hidden="true">{badge.icon}</span>
                      <span>{badge.label}</span>
                    </span>

                    {/* Correlation Chips */}
                    {entry.runId && (
                      <button
                        type="button"
                        data-testid={`log-chip-run-${entry.logId}`}
                        title={`Jump to Run Replay for ${entry.runId}`}
                        onClick={() => void handleJumpToReplay(entry)}
                        className="px-1.5 py-0.5 rounded bg-sky-500/15 hover:bg-sky-500/30 border border-sky-400/50 text-sky-200 text-[10px] font-semibold cursor-pointer"
                      >
                        run:{entry.runId.slice(0, 14)}
                      </button>
                    )}

                    {entry.nodeId && (
                      <button
                        type="button"
                        data-testid={`log-chip-node-${entry.logId}`}
                        title={
                          entry.runId
                            ? `Jump to node ${entry.nodeId} in Run Replay`
                            : `Filter by node ${entry.nodeId}`
                        }
                        onClick={() => {
                          if (entry.runId) {
                            void handleJumpToReplay(entry);
                          } else {
                            updateFilter({ nodeId: entry.nodeId ?? "" });
                          }
                        }}
                        className="px-1.5 py-0.5 rounded bg-amber-500/15 hover:bg-amber-500/30 border border-amber-400/50 text-amber-200 text-[10px] font-semibold cursor-pointer"
                      >
                        node:{entry.nodeId}
                      </button>
                    )}

                    {entry.brickId && (
                      <button
                        type="button"
                        data-testid={`log-chip-brick-${entry.logId}`}
                        onClick={() =>
                          updateFilter({ brickId: entry.brickId ?? "" })
                        }
                        className="px-1.5 py-0.5 rounded bg-purple-500/15 hover:bg-purple-500/25 border border-purple-400/40 text-purple-200 text-[10px]"
                      >
                        brick:{entry.brickId}
                      </button>
                    )}

                    {entry.workspaceId && (
                      <button
                        type="button"
                        data-testid={`log-chip-workspace-${entry.logId}`}
                        onClick={() =>
                          updateFilter({ workspaceId: entry.workspaceId ?? "" })
                        }
                        className="px-1.5 py-0.5 rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/40 text-emerald-200 text-[10px]"
                      >
                        ws:{entry.workspaceId}
                      </button>
                    )}

                    {/* Log Message */}
                    <span
                      data-testid={`log-message-${entry.logId}`}
                      className="text-[11px] text-text-primary break-all"
                    >
                      {entry.message}
                    </span>
                  </div>

                  {/* Right Actions: Open in Replay + Expand JSON/Stack */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {entry.runId && (
                      <button
                        type="button"
                        data-testid={`log-open-replay-${entry.logId}`}
                        onClick={() => void handleJumpToReplay(entry)}
                        className="px-2 py-0.5 rounded bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/50 text-sky-200 font-sans font-semibold text-[10px]"
                      >
                        ⏮ Open in Replay
                      </button>
                    )}

                    {hasDetails && (
                      <button
                        type="button"
                        data-testid={`log-expand-button-${entry.logId}`}
                        aria-expanded={isExpanded}
                        onClick={() => toggleExpandRow(entry.logId)}
                        className="px-2 py-0.5 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-[10px] text-text-secondary"
                      >
                        {isExpanded ? "▾ Hide Details" : "▸ Details"}
                      </button>
                    )}
                  </div>
                </div>

                {isExpanded && hasDetails && (
                  <div
                    data-testid={`log-details-${entry.logId}`}
                    className="p-2 rounded bg-slate-900/90 border border-border space-y-1.5 text-[11px]"
                  >
                    {entry.fields && Object.keys(entry.fields).length > 0 && (
                      <div>
                        <div className="text-[10px] text-text-muted mb-0.5">
                          Structured Fields (JSON):
                        </div>
                        <pre
                          data-testid={`log-fields-json-${entry.logId}`}
                          className="p-1.5 rounded bg-slate-950 border border-border overflow-x-auto text-[10px] text-emerald-200"
                        >
                          {JSON.stringify(entry.fields, null, 2)}
                        </pre>
                      </div>
                    )}
                    {entry.errorStack && (
                      <div>
                        <div className="text-[10px] text-rose-300 mb-0.5">
                          Error Stack Trace:
                        </div>
                        <pre
                          data-testid={`log-error-stack-${entry.logId}`}
                          className="p-1.5 rounded bg-rose-950/40 border border-rose-500/40 overflow-x-auto text-[10px] text-rose-200 whitespace-pre-wrap"
                        >
                          {entry.errorStack}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
