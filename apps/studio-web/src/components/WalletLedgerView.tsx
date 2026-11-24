import { useCallback, useEffect, useState } from "react";
import {
  fetchDataBrowserWorkspaces,
  fetchWorkspaceLedger,
  isDataStoreNotConfiguredError,
} from "../api.ts";
import type {
  WorkspaceLedgerEntryPayload,
  WorkspaceUsageSummaryItemPayload,
} from "../api.ts";
import { getActiveOrg, useStudioStore } from "../store.ts";

const STORAGE_KEY_PREFIX = "px_studio_data_browser_";

function readPersistedValue(key: string, fallback: string): string {
  try {
    const val = window.localStorage.getItem(key);
    return val && val.trim().length > 0 ? val : fallback;
  } catch {
    return fallback;
  }
}

function writePersistedValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage quota errors
  }
}

export function WalletLedgerView() {
  const activeProjectId = useStudioStore((s) => s.activeProjectId);
  const projectState = useStudioStore((s) => s.projectState);
  const orgs = useStudioStore((s) => s.orgs);
  const activeOrgId = useStudioStore((s) => s.activeOrgId);
  const startRunReplay = useStudioStore((s) => s.startRunReplay);

  const activeProject =
    activeProjectId ?? projectState?.project ?? "acme-saas";
  const activeOrg = getActiveOrg({ orgs, activeOrgId });
  const orgId = activeOrg?.id;

  const [envName, setEnvName] = useState<"preview" | "production">(() => {
    const saved = readPersistedValue(
      `${STORAGE_KEY_PREFIX}env_${activeProject}`,
      "preview",
    );
    return saved === "production" ? "production" : "preview";
  });

  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>(() =>
    readPersistedValue(`${STORAGE_KEY_PREFIX}ws_${activeProject}`, ""),
  );

  const [balance, setBalance] = useState<number>(0);
  const [currencyOrUnit, setCurrencyOrUnit] = useState<string>("credits");
  const [netChange30d, setNetChange30d] = useState<number>(0);
  const [updatedAt, setUpdatedAt] = useState<string>("");
  const [usageSummary, setUsageSummary] = useState<
    WorkspaceUsageSummaryItemPayload[]
  >([]);
  const [journalEntries, setJournalEntries] = useState<
    WorkspaceLedgerEntryPayload[]
  >([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  // Story 17: set when the environment has no data store (503 NOT_CONFIGURED).
  const [noDataStore, setNoDataStore] = useState(false);

  const loadWorkspacesAndLedger = useCallback(
    async (targetEnv: "preview" | "production", preferredWs?: string) => {
      setLoading(true);
      setErrorBanner(null);
      setNoDataStore(false);
      try {
        const wsRes = await fetchDataBrowserWorkspaces(
          activeProject,
          targetEnv,
          orgId,
        );
        const wsList =
          wsRes.workspaces.length > 0 ? wsRes.workspaces : ["ws_default"];
        setWorkspaces(wsList);

        const persistedWs = readPersistedValue(
          `${STORAGE_KEY_PREFIX}ws_${activeProject}`,
          "",
        );
        const effectiveWs =
          preferredWs && wsList.includes(preferredWs)
            ? preferredWs
            : persistedWs && wsList.includes(persistedWs)
              ? persistedWs
              : wsList[0]!;

        setSelectedWorkspace(effectiveWs);
        writePersistedValue(
          `${STORAGE_KEY_PREFIX}ws_${activeProject}`,
          effectiveWs,
        );

        const ledgerRes = await fetchWorkspaceLedger(activeProject, targetEnv, {
          workspaceId: effectiveWs,
          limit: 50,
          orgId,
        });
        setBalance(ledgerRes.wallet?.balance ?? 0);
        setCurrencyOrUnit(ledgerRes.wallet?.currencyOrUnit ?? "credits");
        setNetChange30d(ledgerRes.wallet?.netChange30d ?? 0);
        setUpdatedAt(ledgerRes.wallet?.updatedAt ?? "");
        setUsageSummary(ledgerRes.usageSummary ?? []);
        setJournalEntries(ledgerRes.journalEntries ?? []);
      } catch (err) {
        if (isDataStoreNotConfiguredError(err)) {
          setNoDataStore(true);
          setUsageSummary([]);
          setJournalEntries([]);
          return;
        }
        setErrorBanner(
          err instanceof Error
            ? err.message
            : "Failed to load workspace wallet & usage ledger",
        );
      } finally {
        setLoading(false);
      }
    },
    [activeProject, orgId],
  );

  useEffect(() => {
    void loadWorkspacesAndLedger(envName);
  }, [envName, loadWorkspacesAndLedger]);

  const handleSelectEnv = (nextEnv: "preview" | "production") => {
    setEnvName(nextEnv);
    writePersistedValue(`${STORAGE_KEY_PREFIX}env_${activeProject}`, nextEnv);
  };

  const handleSelectWorkspace = (nextWs: string) => {
    setSelectedWorkspace(nextWs);
    writePersistedValue(`${STORAGE_KEY_PREFIX}ws_${activeProject}`, nextWs);
    void loadWorkspacesAndLedger(envName, nextWs);
  };

  const formattedNetChange =
    netChange30d > 0 ? `+${netChange30d}` : `${netChange30d}`;

  return (
    <div
      data-testid="wallet-ledger-view"
      className="flex flex-col gap-4"
      style={{ display: "flex" }}
    >
      {/* Top Bar: Environment Toggle, Mandatory Workspace Selector, and Permanent Immutable Badge */}
      <div
        data-testid="wallet-ledger-header"
        style={{
          display: "flex",
          backgroundColor: "rgb(15, 23, 42)",
          borderColor: "rgb(51, 65, 85)",
        }}
        className="p-4 rounded-lg bg-surface-raised border border-border flex flex-wrap items-center justify-between gap-4"
      >
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h2 className="text-base font-bold text-text-primary">
              Credit Wallet &amp; Usage Ledger
            </h2>
            <p className="text-xs text-text-secondary">
              Strictly workspace-scoped (<code className="font-mono">WHERE workspace_id = ?1</code>)
              read-only financial &amp; usage journal. Direct mutations are refused in all environments.
            </p>
          </div>

          <div
            role="group"
            aria-label="Ledger Environment"
            className="inline-flex rounded-lg bg-surface-base p-0.5 border border-border"
          >
            <button
              type="button"
              data-testid="ledger-env-preview"
              onClick={() => handleSelectEnv("preview")}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition ${
                envName === "preview"
                  ? "bg-accent text-slate-950 font-bold"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              preview
            </button>
            <button
              type="button"
              data-testid="ledger-env-production"
              onClick={() => handleSelectEnv("production")}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition ${
                envName === "production"
                  ? "bg-amber-400 text-slate-950 font-bold"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              production
            </button>
          </div>

          <span
            data-testid="ledger-immutable-badge"
            style={{
              backgroundColor: "rgba(16, 185, 129, 0.15)",
              borderColor: "rgba(16, 185, 129, 0.45)",
              color: "rgb(110, 231, 183)",
            }}
            className="px-2.5 py-1 rounded border text-xs font-bold inline-flex items-center gap-1.5"
          >
            🔒 Immutable Ledger (Read-only)
          </span>
        </div>

        {/* Mandatory Workspace Selector */}
        <div className="flex items-center gap-2">
          <label
            htmlFor="ledger-workspace-select"
            className="text-xs font-bold uppercase tracking-wider text-text-muted"
          >
            Workspace:
          </label>
          <select
            id="ledger-workspace-select"
            aria-label="Ledger workspace selector"
            data-testid="ledger-workspace-select"
            value={selectedWorkspace}
            onChange={(e) => handleSelectWorkspace(e.target.value)}
            style={{
              backgroundColor: "rgb(30, 41, 59)",
              borderColor: "rgb(71, 85, 105)",
            }}
            className="px-3 py-1.5 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary font-semibold"
          >
            {workspaces.map((ws) => (
              <option key={ws} value={ws}>
                {ws}
              </option>
            ))}
          </select>
        </div>
      </div>

      {noDataStore && (
        <div
          role="status"
          data-testid="ledger-no-data-store"
          className="p-4 rounded-lg bg-surface-base border border-border text-text-secondary text-xs flex flex-col gap-1"
        >
          <span className="font-semibold text-text-primary">
            No data store for this environment
          </span>
          <span>
            {envName === "production"
              ? "Studio cannot reach production data. Browse data in a preview sandbox instead."
              : "Deploy a preview sandbox to browse and seed this project's data."}
          </span>
        </div>
      )}

      {errorBanner && (
        <div
          role="alert"
          data-testid="ledger-error-alert"
          className="p-3 rounded-lg bg-rose-500/15 border border-rose-500/40 text-rose-200 text-xs"
        >
          ⚠ {errorBanner}
        </div>
      )}

      {/* Summary Cards: Current Credit Balance, 30-Day Net Change, Period Usage Totals */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div
          data-testid="ledger-current-balance"
          style={{
            backgroundColor: "rgb(15, 23, 42)",
            borderColor: "rgb(51, 65, 85)",
          }}
          className="p-4 rounded-lg bg-surface-raised border border-border space-y-1"
        >
          <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Current Credit Balance ({selectedWorkspace})
          </div>
          <div
            data-testid="ledger-current-balance-value"
            className="text-2xl font-bold font-mono text-emerald-400"
          >
            {balance} <span className="text-xs font-normal text-text-secondary">{currencyOrUnit}</span>
          </div>
          {updatedAt && (
            <div className="text-[11px] font-mono text-text-muted">
              Updated: {updatedAt}
            </div>
          )}
        </div>

        <div
          data-testid="ledger-net-change-30d"
          style={{
            backgroundColor: "rgb(15, 23, 42)",
            borderColor: "rgb(51, 65, 85)",
          }}
          className="p-4 rounded-lg bg-surface-raised border border-border space-y-1"
        >
          <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
            30-Day Net Change
          </div>
          <div
            data-testid="ledger-net-change-30d-value"
            className={`text-2xl font-bold font-mono ${
              netChange30d >= 0 ? "text-emerald-400" : "text-slate-300"
            }`}
          >
            {formattedNetChange}{" "}
            <span className="text-xs font-normal text-text-secondary">
              {currencyOrUnit}
            </span>
          </div>
          <div className="text-[11px] text-text-muted">
            Across {journalEntries.length} immutable journal{" "}
            {journalEntries.length === 1 ? "entry" : "entries"}
          </div>
        </div>

        <div
          data-testid="ledger-usage-summary"
          style={{
            backgroundColor: "rgb(15, 23, 42)",
            borderColor: "rgb(51, 65, 85)",
          }}
          className="p-4 rounded-lg bg-surface-raised border border-border space-y-1.5"
        >
          <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Period Usage Totals
          </div>
          {usageSummary.length === 0 ? (
            <div className="text-xs text-text-muted py-1">
              0 metered events in current period
            </div>
          ) : (
            <div className="space-y-1">
              {usageSummary.map((u) => (
                <div
                  key={`${u.metricKey}-${u.periodStart}`}
                  data-testid={`ledger-usage-metric-${u.metricKey}`}
                  className="flex items-center justify-between text-xs font-mono"
                >
                  <span className="text-text-secondary">{u.metricKey}</span>
                  <span className="font-bold text-sky-300">
                    {u.totalQuantity}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Chronological Immutable Journal Table */}
      <div className="p-4 rounded-lg bg-surface-raised border border-border space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-text-primary">
            Immutable Journal Entries ({journalEntries.length})
          </h3>
          <span className="text-[11px] font-mono text-text-muted">
            Single-statement atomic D1 batch ledger · Read-only in {envName}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table
            data-testid="ledger-journal-table"
            className="w-full text-left border-collapse text-xs"
          >
            <thead>
              <tr className="border-b border-border text-[11px] uppercase tracking-wider text-text-muted">
                <th className="py-2 px-2.5">Timestamp</th>
                <th className="py-2 px-2.5">Delta</th>
                <th className="py-2 px-2.5">Balance After</th>
                <th className="py-2 px-2.5">Reason</th>
                <th className="py-2 px-2.5">Idempotency Key</th>
                <th className="py-2 px-2.5">Run / Node</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border font-mono">
              {loading ? (
                <tr>
                  <td
                    colSpan={6}
                    className="py-6 text-center text-text-muted font-sans"
                  >
                    Loading immutable ledger entries for {selectedWorkspace}…
                  </td>
                </tr>
              ) : journalEntries.length === 0 ? (
                <tr data-testid="ledger-empty-rows">
                  <td
                    colSpan={6}
                    className="py-6 text-center text-text-muted font-sans"
                  >
                    No ledger entries recorded for workspace{" "}
                    <span className="font-mono text-text-primary">
                      {selectedWorkspace}
                    </span>
                    .
                  </td>
                </tr>
              ) : (
                journalEntries.map((entry) => {
                  const isPositive = entry.delta >= 0;
                  const formattedDelta = isPositive
                    ? `+${entry.delta}`
                    : `${entry.delta}`;
                  return (
                    <tr
                      key={entry.entryId}
                      data-testid={`ledger-entry-row-${entry.entryId}`}
                      className="hover:bg-surface-base/40"
                    >
                      <td className="py-2 px-2.5 text-text-secondary">
                        {entry.createdAt}
                      </td>
                      <td
                        data-testid={`ledger-entry-delta-${entry.entryId}`}
                        style={{
                          color: isPositive
                            ? "rgb(52, 211, 153)"
                            : "rgb(203, 213, 225)",
                        }}
                        className={`py-2 px-2.5 font-bold ${
                          isPositive ? "text-emerald-400" : "text-slate-300"
                        }`}
                      >
                        {formattedDelta}
                      </td>
                      <td
                        data-testid={`ledger-entry-balance-${entry.entryId}`}
                        className="py-2 px-2.5 text-text-primary font-semibold"
                      >
                        {entry.balanceAfter}
                      </td>
                      <td className="py-2 px-2.5 font-sans text-text-primary">
                        {entry.reason}
                      </td>
                      <td className="py-2 px-2.5 text-text-muted">
                        {entry.idempotencyKey ?? "—"}
                      </td>
                      <td className="py-2 px-2.5">
                        {entry.runId ? (
                          <button
                            type="button"
                            data-testid={`ledger-jump-run-${entry.entryId}`}
                            data-run-id={entry.runId}
                            data-node-id={entry.nodeId ?? ""}
                            onClick={() =>
                              void startRunReplay(
                                entry.runId!,
                                envName,
                                entry.nodeId ?? null,
                              )
                            }
                            className="px-2 py-0.5 rounded bg-sky-500/15 border border-sky-500/40 text-sky-300 hover:bg-sky-500/25 text-[11px] font-mono inline-flex items-center gap-1"
                          >
                            <span>↪ {entry.runId}</span>
                            {entry.nodeId && (
                              <span className="text-text-muted">
                                / {entry.nodeId}
                              </span>
                            )}
                          </button>
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
