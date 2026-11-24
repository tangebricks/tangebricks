import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchDataBrowserAuditLog,
  fetchDataBrowserRows,
  fetchDataBrowserTables,
  fetchDataBrowserWorkspaces,
  isDataStoreNotConfiguredError,
  mutateDataBrowserRow,
} from "../api.ts";
import type {
  DataBrowserAuditEntryPayload,
  DataBrowserColumnPayload,
  DataBrowserTablePayload,
} from "../api.ts";
import { getActiveOrg, getActiveRole, useStudioStore } from "../store.ts";

interface PendingWriteAction {
  operation: "insert" | "update" | "delete";
  tableName: string;
  workspaceId: string;
  rowId?: string;
  row?: Record<string, unknown>;
  patch?: Record<string, unknown>;
}

function readSessionValue(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    return window.sessionStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeSessionValue(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Ignore storage errors
  }
}

export interface DataBrowserViewProps {
  project?: string;
  orgId?: string;
  initialEnv?: "preview" | "production";
}

export function DataBrowserView(props: DataBrowserViewProps = {}) {
  const projectState = useStudioStore((s) => s.projectState);
  const activeProjectId = useStudioStore((s) => s.activeProjectId);
  const orgs = useStudioStore((s) => s.orgs);
  const activeOrgId = useStudioStore((s) => s.activeOrgId);

  const activeOrg = getActiveOrg({ orgs, activeOrgId });
  const activeRole = getActiveRole({ orgs, activeOrgId });
  const isViewer = activeRole === "viewer";

  const project =
    props.project ??
    projectState?.project ??
    activeProjectId ??
    "default-project";
  const orgId = props.orgId ?? activeOrg?.id;

  const [envName, setEnvName] = useState<"preview" | "production">(() => {
    if (props.initialEnv) return props.initialEnv;
    const saved = readSessionValue("studio:dataBrowser:env", "preview");
    return saved === "production" ? "production" : "preview";
  });

  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>(() =>
    readSessionValue("studio:dataBrowser:workspace", ""),
  );

  const [tables, setTables] = useState<DataBrowserTablePayload[]>([]);
  const [selectedTableName, setSelectedTableName] = useState<string>(() =>
    readSessionValue("studio:dataBrowser:table", ""),
  );

  const [columns, setColumns] = useState<DataBrowserColumnPayload[]>([]);
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [compiledSql, setCompiledSql] = useState<string>("");

  const [sortCol, setSortCol] = useState<string>("id");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const [filterCol, setFilterCol] = useState<string>("");
  const [filterOp, setFilterOp] = useState<"eq" | "contains" | "gt" | "lt">("eq");
  const [filterVal, setFilterVal] = useState<string>("");
  const [appliedFilter, setAppliedFilter] = useState<{
    col: string;
    op: "eq" | "contains" | "gt" | "lt";
    val: string;
  } | null>(null);

  const [limit] = useState<number>(25);
  const [offset, setOffset] = useState<number>(0);

  const [loading, setLoading] = useState<boolean>(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  // Story 17: set when the environment has no data store (503 NOT_CONFIGURED).
  const [noDataStore, setNoDataStore] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  // Add row draft state
  const [addingRow, setAddingRow] = useState<boolean>(false);
  const [newRowDraft, setNewRowDraft] = useState<Record<string, string>>({});

  // Inline edit state
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editRowDraft, setEditRowDraft] = useState<Record<string, string>>({});

  // Confirmation modal state
  const [pendingWrite, setPendingWrite] = useState<PendingWriteAction | null>(
    null,
  );
  const [submittingWrite, setSubmittingWrite] = useState<boolean>(false);

  // Audit log entries
  const [auditEntries, setAuditEntries] = useState<
    DataBrowserAuditEntryPayload[]
  >([]);

  const catalogReqIdRef = useRef(0);
  const rowsReqIdRef = useRef(0);

  const handleSelectEnv = (nextEnv: "preview" | "production") => {
    setEnvName(nextEnv);
    writeSessionValue("studio:dataBrowser:env", nextEnv);
    setAddingRow(false);
    setEditingRowId(null);
    setPendingWrite(null);
    setErrorBanner(null);
  };

  const handleSelectWorkspace = (ws: string) => {
    setSelectedWorkspace(ws);
    writeSessionValue("studio:dataBrowser:workspace", ws);
    setOffset(0);
    setAddingRow(false);
    setEditingRowId(null);
    setErrorBanner(null);
  };

  const handleSelectTable = (tbl: string) => {
    setSelectedTableName(tbl);
    writeSessionValue("studio:dataBrowser:table", tbl);
    setOffset(0);
    setFilterCol("");
    setFilterVal("");
    setAppliedFilter(null);
    setAddingRow(false);
    setEditingRowId(null);
    setErrorBanner(null);
  };

  // Load workspaces and table catalog
  const loadCatalog = useCallback(async () => {
    if (!project) return;
    const reqId = ++catalogReqIdRef.current;
    try {
      const [wsRes, tblRes] = await Promise.all([
        fetchDataBrowserWorkspaces(project, envName, orgId),
        fetchDataBrowserTables(project, envName, {
          workspaceId: selectedWorkspace || undefined,
          orgId,
        }),
      ]);
      if (reqId !== catalogReqIdRef.current) return;
      setNoDataStore(false);

      const wsList = wsRes.workspaces ?? [];
      setWorkspaces(wsList);

      const savedWs = readSessionValue("studio:dataBrowser:workspace", "");
      const effectiveWs =
        selectedWorkspace && wsList.includes(selectedWorkspace)
          ? selectedWorkspace
          : savedWs && wsList.includes(savedWs)
            ? savedWs
            : (wsList[0] ?? "ws_default");

      if (effectiveWs !== selectedWorkspace) {
        setSelectedWorkspace(effectiveWs);
        writeSessionValue("studio:dataBrowser:workspace", effectiveWs);
      }

      const tblList = tblRes.tables ?? [];
      setTables(tblList);

      const savedTbl = readSessionValue("studio:dataBrowser:table", "");
      const effectiveTbl =
        selectedTableName && tblList.some((t) => t.name === selectedTableName)
          ? selectedTableName
          : savedTbl && tblList.some((t) => t.name === savedTbl)
            ? savedTbl
            : (tblList[0]?.name ?? "");

      if (effectiveTbl && effectiveTbl !== selectedTableName) {
        setSelectedTableName(effectiveTbl);
        writeSessionValue("studio:dataBrowser:table", effectiveTbl);
      }
    } catch (err) {
      if (reqId === catalogReqIdRef.current && isDataStoreNotConfiguredError(err)) {
        setNoDataStore(true);
        setWorkspaces([]);
        setTables([]);
        setRows([]);
        setTotalCount(0);
      } else if (reqId === catalogReqIdRef.current) {
        setErrorBanner(
          err instanceof Error ? err.message : "Failed to load Data Browser catalog",
        );
      }
    }
  }, [project, envName, orgId, selectedWorkspace, selectedTableName]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const activeTable = useMemo(
    () => tables.find((t) => t.name === selectedTableName) ?? tables[0] ?? null,
    [tables, selectedTableName],
  );

  // Load rows and audit log when workspace, table, sort, filter, or pagination changes
  const loadRowsAndAudit = useCallback(async () => {
    if (!project || !selectedWorkspace || !activeTable) return;
    const reqId = ++rowsReqIdRef.current;
    setLoading(true);
    try {
      const [rowsRes, auditRes] = await Promise.all([
        fetchDataBrowserRows(project, envName, activeTable.name, {
          workspaceId: selectedWorkspace,
          orgId,
          filterCol: appliedFilter?.col || undefined,
          filterOp: appliedFilter?.op,
          filterVal: appliedFilter?.val,
          sortCol,
          sortDir,
          limit,
          offset,
        }),
        fetchDataBrowserAuditLog(project, envName, {
          workspaceId: selectedWorkspace,
          tableName: activeTable.name,
          orgId,
        }).catch(() => ({ ok: true, entries: [] })),
      ]);
      if (reqId !== rowsReqIdRef.current) return;

      setColumns(rowsRes.columns ?? activeTable.columns);
      setRows(rowsRes.rows ?? []);
      setTotalCount(rowsRes.totalCount ?? 0);
      setCompiledSql(rowsRes.compiledSql ?? "");
      setAuditEntries(auditRes.entries ?? []);
    } catch (err) {
      if (reqId === rowsReqIdRef.current && isDataStoreNotConfiguredError(err)) {
        setNoDataStore(true);
        setRows([]);
        setTotalCount(0);
      } else if (reqId === rowsReqIdRef.current) {
        setErrorBanner(
          err instanceof Error ? err.message : "Failed to load table rows",
        );
      }
    } finally {
      if (reqId === rowsReqIdRef.current) {
        setLoading(false);
      }
    }
  }, [
    project,
    envName,
    orgId,
    selectedWorkspace,
    activeTable,
    appliedFilter,
    sortCol,
    sortDir,
    limit,
    offset,
  ]);

  useEffect(() => {
    void loadRowsAndAudit();
  }, [loadRowsAndAudit]);

  const entityTables = useMemo(
    () => tables.filter((t) => t.category === "entity"),
    [tables],
  );
  const brickTables = useMemo(
    () => tables.filter((t) => t.category === "brick"),
    [tables],
  );

  const canWriteActiveTable =
    envName === "preview" &&
    !isViewer &&
    Boolean(activeTable) &&
    activeTable?.category === "entity" &&
    !activeTable?.readOnly;

  const effectiveColumns = useMemo(
    () =>
      activeTable?.columns && activeTable.columns.length > 0
        ? activeTable.columns
        : columns,
    [activeTable, columns],
  );

  const editableColumns = useMemo(
    () =>
      effectiveColumns.filter(
        (c) =>
          !c.readOnly &&
          c.name !== "id" &&
          c.name !== "workspace_id" &&
          c.name !== "created_at" &&
          c.name !== "updated_at",
      ),
    [effectiveColumns],
  );

  const handleToggleSort = (colName: string) => {
    if (sortCol === colName) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(colName);
      setSortDir("asc");
    }
    setOffset(0);
  };

  const handleApplyFilter = () => {
    const colToUse = filterCol || effectiveColumns[0]?.name || "";
    if (!colToUse || filterVal.trim() === "") {
      setAppliedFilter(null);
    } else {
      setAppliedFilter({
        col: colToUse,
        op: filterOp,
        val: filterVal.trim(),
      });
    }
    setOffset(0);
  };

  const handleClearFilter = () => {
    setFilterCol("");
    setFilterVal("");
    setAppliedFilter(null);
    setOffset(0);
  };

  const handleStartAddRow = () => {
    if (!canWriteActiveTable) return;
    const initial: Record<string, string> = {};
    for (const col of editableColumns) {
      initial[col.name] = "";
    }
    setNewRowDraft(initial);
    setAddingRow(true);
    setEditingRowId(null);
    setErrorBanner(null);
  };

  const handleQueueInsertRow = () => {
    if (!activeTable || !selectedWorkspace) return;
    const rowPayload: Record<string, unknown> = {};
    for (const col of editableColumns) {
      const raw = newRowDraft[col.name] ?? "";
      if (
        col.type.includes("INT") ||
        col.type.includes("NUM") ||
        col.type.includes("REAL")
      ) {
        rowPayload[col.name] = raw === "" ? 0 : Number(raw);
      } else {
        rowPayload[col.name] = raw;
      }
    }
    setPendingWrite({
      operation: "insert",
      tableName: activeTable.name,
      workspaceId: selectedWorkspace,
      row: rowPayload,
    });
  };

  const handleStartEditRow = (row: Record<string, unknown>) => {
    if (!canWriteActiveTable) return;
    const rowId = String(row.id ?? "");
    if (!rowId) return;
    const draft: Record<string, string> = {};
    for (const col of editableColumns) {
      const val = row[col.name];
      draft[col.name] = val === null || val === undefined ? "" : String(val);
    }
    setEditingRowId(rowId);
    setEditRowDraft(draft);
    setAddingRow(false);
    setErrorBanner(null);
  };

  const handleQueueUpdateRow = (rowId: string) => {
    if (!activeTable || !selectedWorkspace) return;
    const patchPayload: Record<string, unknown> = {};
    for (const col of editableColumns) {
      const raw = editRowDraft[col.name] ?? "";
      if (
        col.type.includes("INT") ||
        col.type.includes("NUM") ||
        col.type.includes("REAL")
      ) {
        patchPayload[col.name] = raw === "" ? 0 : Number(raw);
      } else {
        patchPayload[col.name] = raw;
      }
    }
    setPendingWrite({
      operation: "update",
      tableName: activeTable.name,
      workspaceId: selectedWorkspace,
      rowId,
      patch: patchPayload,
    });
  };

  const handleQueueDeleteRow = (rowId: string) => {
    if (!activeTable || !selectedWorkspace) return;
    setPendingWrite({
      operation: "delete",
      tableName: activeTable.name,
      workspaceId: selectedWorkspace,
      rowId,
    });
  };

  const handleConfirmPendingWrite = async () => {
    if (!pendingWrite) return;
    setSubmittingWrite(true);
    setErrorBanner(null);
    setStatusNotice(null);

    try {
      const method =
        pendingWrite.operation === "insert"
          ? "POST"
          : pendingWrite.operation === "update"
            ? "PATCH"
            : "DELETE";

      const result = await mutateDataBrowserRow(
        project,
        envName,
        pendingWrite.tableName,
        {
          method,
          workspaceId: pendingWrite.workspaceId,
          confirmWrite: true,
          rowId: pendingWrite.rowId,
          row: pendingWrite.row,
          patch: pendingWrite.patch,
          orgId,
        },
      );

      if (!result.ok) {
        setErrorBanner(
          `${result.error?.code ?? "ERROR"}: ${result.error?.message ?? "Write rejected"}`,
        );
        setPendingWrite(null);
        return;
      }

      setPendingWrite(null);
      setAddingRow(false);
      setEditingRowId(null);
      setStatusNotice(
        `Committed ${pendingWrite.operation} on ${pendingWrite.tableName} (audit ${result.auditId ?? "recorded"})`,
      );
      await loadCatalog();
      await loadRowsAndAudit();
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : "Failed to commit row mutation",
      );
      setPendingWrite(null);
    } finally {
      setSubmittingWrite(false);
    }
  };

  return (
    <div data-testid="data-browser-view" className="space-y-4">
      {/* Top Control Bar: Environment Toggle, Status Badge & Mandatory Workspace Selector */}
      <div
        data-testid="data-browser-header"
        className="p-4 rounded-lg bg-surface-raised border border-border flex flex-wrap items-center justify-between gap-4"
      >
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h2 className="text-base font-bold text-text-primary">
              Workspace Data Browser
            </h2>
            <p className="text-xs text-text-muted mt-0.5">
              Inspect deployed entity &amp; brick rows strictly scoped by{" "}
              <span className="font-mono text-emerald-400">
                WHERE workspace_id = ?1
              </span>
              . Secret columns are excluded.
            </p>
          </div>

          {/* Environment Toggle */}
          <div
            role="group"
            aria-label="Data Browser Environment"
            className="inline-flex rounded-lg bg-surface-base p-1 border border-border"
          >
            <button
              type="button"
              data-testid="data-browser-env-preview"
              onClick={() => handleSelectEnv("preview")}
              className={`px-3 py-1 rounded text-xs font-bold transition ${
                envName === "preview"
                  ? "bg-sky-400 text-slate-950"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              preview
            </button>
            <button
              type="button"
              data-testid="data-browser-env-production"
              onClick={() => handleSelectEnv("production")}
              className={`px-3 py-1 rounded text-xs font-bold transition ${
                envName === "production"
                  ? "bg-amber-400 text-slate-950"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              production
            </button>
          </div>

          {envName === "production" ? (
            <span
              data-testid="data-browser-readonly-badge"
              style={{
                backgroundColor: "rgba(245, 158, 11, 0.15)",
                borderColor: "rgba(245, 158, 11, 0.45)",
                color: "rgb(253, 230, 138)",
              }}
              className="px-2.5 py-1 rounded border text-xs font-bold inline-flex items-center gap-1.5"
            >
              🔒 Read-only in production
            </span>
          ) : (
            <span
              data-testid="data-browser-preview-badge"
              style={{
                backgroundColor: "rgba(16, 185, 129, 0.15)",
                borderColor: "rgba(16, 185, 129, 0.45)",
                color: "rgb(110, 231, 183)",
              }}
              className="px-2.5 py-1 rounded border text-xs font-bold inline-flex items-center gap-1.5"
            >
              ✎ Preview · Audited entity writes
            </span>
          )}
        </div>

        {/* Mandatory Workspace Selector */}
        <div className="flex items-center gap-2">
          <label
            htmlFor="data-browser-workspace-select"
            className="text-xs font-bold uppercase tracking-wider text-text-muted"
          >
            Workspace:
          </label>
          <select
            id="data-browser-workspace-select"
            aria-label="Workspace selector"
            data-testid="data-browser-workspace-select"
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
          <span
            data-testid="data-browser-sql-isolation-badge"
            className="px-2 py-1 rounded bg-surface-base border border-border font-mono text-[11px] text-emerald-400"
          >
            WHERE workspace_id = ?1
          </span>
        </div>
      </div>

      {noDataStore && (
        <div
          role="status"
          data-testid="data-browser-no-data-store"
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
          data-testid="data-browser-error-alert"
          className="p-3 rounded-lg bg-rose-500/15 border border-rose-500/40 text-rose-200 text-xs flex items-center justify-between gap-3"
        >
          <span>⚠ {errorBanner}</span>
          <button
            type="button"
            onClick={() => setErrorBanner(null)}
            className="px-2 py-0.5 rounded bg-surface-control text-text-secondary hover:text-text-primary text-[11px]"
          >
            Dismiss
          </button>
        </div>
      )}

      {statusNotice && (
        <div
          role="status"
          data-testid="data-browser-status-notice"
          className="p-3 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-200 text-xs flex items-center justify-between gap-3"
        >
          <span>✓ {statusNotice}</span>
          <button
            type="button"
            onClick={() => setStatusNotice(null)}
            className="px-2 py-0.5 rounded bg-surface-control text-text-secondary hover:text-text-primary text-[11px]"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="grid grid-cols-12 gap-4">
        {/* Left Sidebar: Grouped Entities & Brick Tables */}
        <aside
          data-testid="data-browser-tables-sidebar"
          className="col-span-3 space-y-4 p-3 rounded-lg bg-surface-raised border border-border"
        >
          <div data-testid="data-browser-group-entities" className="space-y-1.5">
            <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted px-1">
              Entities ({entityTables.length})
            </div>
            {entityTables.length === 0 ? (
              <div className="text-xs text-text-muted px-1 py-1">
                No dynamic entities
              </div>
            ) : (
              entityTables.map((tbl) => {
                const active = activeTable?.name === tbl.name;
                return (
                  <button
                    key={tbl.name}
                    type="button"
                    data-testid={`data-browser-table-${tbl.name}`}
                    onClick={() => handleSelectTable(tbl.name)}
                    className={`w-full px-2.5 py-2 rounded-lg border text-left text-xs transition flex items-center justify-between ${
                      active
                        ? "bg-surface-control border-accent text-text-primary ring-1 ring-accent font-bold"
                        : "bg-surface-base/60 border-border text-text-secondary hover:border-border-strong"
                    }`}
                  >
                    <div className="truncate">
                      <div className="font-mono">{tbl.name}</div>
                      <div className="text-[10px] text-text-muted font-mono">
                        {tbl.tableName}
                      </div>
                    </div>
                    <span className="px-1.5 py-0.5 rounded bg-surface-base border border-border text-[10px] font-mono text-text-secondary">
                      {tbl.rowCount ?? "—"}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <div
            data-testid="data-browser-group-bricks"
            className="space-y-1.5 pt-2 border-t border-border"
          >
            <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted px-1">
              Brick Tables ({brickTables.length})
            </div>
            {brickTables.length === 0 ? (
              <div className="text-xs text-text-muted px-1 py-1">
                No brick tables
              </div>
            ) : (
              brickTables.map((tbl) => {
                const active = activeTable?.name === tbl.name;
                return (
                  <button
                    key={tbl.name}
                    type="button"
                    data-testid={`data-browser-table-${tbl.name}`}
                    onClick={() => handleSelectTable(tbl.name)}
                    className={`w-full px-2.5 py-2 rounded-lg border text-left text-xs transition flex items-center justify-between ${
                      active
                        ? "bg-surface-control border-accent text-text-primary ring-1 ring-accent font-bold"
                        : "bg-surface-base/60 border-border text-text-secondary hover:border-border-strong"
                    }`}
                  >
                    <div className="truncate">
                      <div className="font-mono">{tbl.name}</div>
                      <div className="text-[10px] text-amber-300/90 font-sans">
                        Read-only
                      </div>
                    </div>
                    <span className="px-1.5 py-0.5 rounded bg-surface-base border border-border text-[10px] font-mono text-text-secondary">
                      {tbl.rowCount ?? "—"}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* Main Data Grid & Controls */}
        <div className="col-span-9 space-y-4">
          <div className="p-4 rounded-lg bg-surface-raised border border-border space-y-4">
            {/* Table Title & Filter Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h3
                  data-testid="data-browser-active-table-title"
                  className="text-sm font-bold font-mono text-text-primary"
                >
                  {activeTable ? activeTable.label : "Select a table"}
                </h3>
                {activeTable && (
                  <span
                    data-testid="data-browser-table-mode-badge"
                    className={`px-2 py-0.5 rounded text-[11px] font-semibold border ${
                      canWriteActiveTable
                        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                        : "bg-amber-500/10 border-amber-500/30 text-amber-300"
                    }`}
                  >
                    {canWriteActiveTable ? "Editable (Preview)" : "Read-only"}
                  </span>
                )}
              </div>

              {canWriteActiveTable && (
                <button
                  type="button"
                  data-testid="data-browser-add-row-button"
                  onClick={handleStartAddRow}
                  className="px-3 py-1.5 rounded bg-accent text-slate-950 font-bold text-xs hover:opacity-90"
                >
                  + Add Row
                </button>
              )}
            </div>

            {/* Filter Bar */}
            <div
              data-testid="data-browser-filter-bar"
              className="p-2.5 rounded-lg bg-surface-base border border-border flex flex-wrap items-center gap-2 text-xs"
            >
              <span className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
                Filter:
              </span>
              <select
                aria-label="Filter column"
                data-testid="data-browser-filter-column"
                value={filterCol || effectiveColumns[0]?.name || ""}
                onChange={(e) => setFilterCol(e.target.value)}
                className="px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary"
              >
                {effectiveColumns.map((col) => (
                  <option key={col.name} value={col.name}>
                    {col.name}
                  </option>
                ))}
              </select>

              <select
                aria-label="Filter operator"
                data-testid="data-browser-filter-op"
                value={filterOp}
                onChange={(e) =>
                  setFilterOp(
                    e.target.value as "eq" | "contains" | "gt" | "lt",
                  )
                }
                className="px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-xs text-sky-300"
              >
                <option value="eq">= (eq)</option>
                <option value="contains">contains</option>
                <option value="gt">&gt; (gt)</option>
                <option value="lt">&lt; (lt)</option>
              </select>

              <input
                type="text"
                aria-label="Filter value"
                data-testid="data-browser-filter-value"
                placeholder="Value..."
                value={filterVal}
                onChange={(e) => setFilterVal(e.target.value)}
                className="px-2.5 py-1 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary min-w-[160px]"
              />

              <button
                type="button"
                data-testid="data-browser-filter-apply"
                onClick={handleApplyFilter}
                className="px-2.5 py-1 rounded bg-sky-400 text-slate-950 font-bold text-xs hover:opacity-90"
              >
                Apply
              </button>

              {appliedFilter && (
                <button
                  type="button"
                  data-testid="data-browser-filter-clear"
                  onClick={handleClearFilter}
                  className="px-2 py-1 rounded bg-surface-control border border-border text-text-secondary hover:text-text-primary text-xs"
                >
                  Clear
                </button>
              )}
            </div>

            {/* Add Row Form */}
            {addingRow && canWriteActiveTable && (
              <div
                data-testid="data-browser-add-row-form"
                className="p-3 rounded-lg bg-surface-base border border-accent/50 space-y-3"
              >
                <div className="text-xs font-bold text-text-primary">
                  New Row in{" "}
                  <span className="font-mono text-accent">
                    {activeTable?.name}
                  </span>{" "}
                  (workspace:{" "}
                  <span className="font-mono text-emerald-400">
                    {selectedWorkspace}
                  </span>
                  )
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {editableColumns.map((col) => (
                    <label key={col.name} className="space-y-1 text-xs">
                      <span className="font-mono text-text-secondary">
                        {col.name} ({col.type})
                      </span>
                      <input
                        type="text"
                        data-testid={`data-browser-new-input-${col.name}`}
                        value={newRowDraft[col.name] ?? ""}
                        onChange={(e) =>
                          setNewRowDraft((prev) => ({
                            ...prev,
                            [col.name]: e.target.value,
                          }))
                        }
                        className="w-full px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary"
                      />
                    </label>
                  ))}
                </div>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    data-testid="data-browser-add-row-cancel"
                    onClick={() => setAddingRow(false)}
                    className="px-2.5 py-1 rounded bg-surface-control border border-border text-xs text-text-secondary"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    data-testid="data-browser-add-row-review"
                    onClick={handleQueueInsertRow}
                    className="px-3 py-1 rounded bg-emerald-400 text-slate-950 font-bold text-xs"
                  >
                    Review &amp; Confirm Insert
                  </button>
                </div>
              </div>
            )}

            {/* Data Grid */}
            <div className="overflow-x-auto">
              <table
                data-testid="data-browser-grid"
                className="w-full text-left border-collapse text-xs"
              >
                <thead>
                  <tr className="border-b border-border text-[11px] uppercase tracking-wider text-text-muted">
                    {effectiveColumns.map((col) => (
                      <th key={col.name} className="py-2 px-2.5 font-mono">
                        <button
                          type="button"
                          data-testid={`data-browser-sort-${col.name}`}
                          onClick={() => handleToggleSort(col.name)}
                          className="inline-flex items-center gap-1 hover:text-text-primary"
                        >
                          <span>{col.name}</span>
                          {sortCol === col.name && (
                            <span className="text-accent">
                              {sortDir === "asc" ? "↑" : "↓"}
                            </span>
                          )}
                        </button>
                      </th>
                    ))}
                    {canWriteActiveTable && (
                      <th className="py-2 px-2.5 text-right">Actions</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border font-mono">
                  {loading ? (
                    <tr>
                      <td
                        colSpan={effectiveColumns.length + (canWriteActiveTable ? 1 : 0)}
                        className="py-6 text-center text-text-muted font-sans"
                      >
                        Loading rows for workspace {selectedWorkspace}…
                      </td>
                    </tr>
                  ) : rows.length === 0 ? (
                    <tr data-testid="data-browser-empty-rows">
                      <td
                        colSpan={effectiveColumns.length + (canWriteActiveTable ? 1 : 0)}
                        className="py-6 text-center text-text-muted font-sans"
                      >
                        No rows found in workspace{" "}
                        <span className="font-mono text-text-primary">
                          {selectedWorkspace}
                        </span>
                        .
                      </td>
                    </tr>
                  ) : (
                    rows.map((row, rIdx) => {
                      const rowId = String(row.id ?? `idx_${rIdx}`);
                      const isEditing = editingRowId === rowId;
                      return (
                        <tr
                          key={rowId}
                          data-testid={`data-browser-row-${rowId}`}
                          className="hover:bg-surface-base/40"
                        >
                          {effectiveColumns.map((col) => {
                            const cellVal = row[col.name];
                            const canEditCol =
                              isEditing &&
                              editableColumns.some((c) => c.name === col.name);
                            return (
                              <td
                                key={col.name}
                                data-testid={`data-browser-cell-${rowId}-${col.name}`}
                                className="py-2 px-2.5 text-text-primary"
                              >
                                {canEditCol ? (
                                  <input
                                    type="text"
                                    aria-label={`Edit ${col.name} for ${rowId}`}
                                    data-testid={`data-browser-inline-input-${col.name}`}
                                    value={editRowDraft[col.name] ?? ""}
                                    onChange={(e) =>
                                      setEditRowDraft((prev) => ({
                                        ...prev,
                                        [col.name]: e.target.value,
                                      }))
                                    }
                                    className="px-2 py-0.5 rounded bg-surface-control border border-accent font-mono text-xs text-text-primary w-28"
                                  />
                                ) : (
                                  <span>
                                    {cellVal === null || cellVal === undefined
                                      ? "NULL"
                                      : typeof cellVal === "object"
                                        ? JSON.stringify(cellVal)
                                        : String(cellVal)}
                                  </span>
                                )}
                              </td>
                            );
                          })}
                          {canWriteActiveTable && (
                            <td className="py-2 px-2.5 text-right font-sans">
                              {isEditing ? (
                                <div className="inline-flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    data-testid={`data-browser-save-edit-${rowId}`}
                                    onClick={() => handleQueueUpdateRow(rowId)}
                                    className="px-2 py-0.5 rounded bg-emerald-400 text-slate-950 font-bold text-[11px]"
                                  >
                                    Save
                                  </button>
                                  <button
                                    type="button"
                                    data-testid={`data-browser-cancel-edit-${rowId}`}
                                    onClick={() => setEditingRowId(null)}
                                    className="px-2 py-0.5 rounded bg-surface-control border border-border text-text-secondary text-[11px]"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <div className="inline-flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    data-testid={`data-browser-edit-row-${rowId}`}
                                    onClick={() => handleStartEditRow(row)}
                                    className="px-2 py-0.5 rounded bg-surface-control border border-border-strong text-text-primary hover:bg-slate-700 text-[11px]"
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    data-testid={`data-browser-delete-row-${rowId}`}
                                    onClick={() => handleQueueDeleteRow(rowId)}
                                    className="px-2 py-0.5 rounded bg-rose-500/15 border border-rose-500/40 text-rose-300 hover:bg-rose-500/25 text-[11px]"
                                  >
                                    Delete
                                  </button>
                                </div>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination Footer */}
            <div className="pt-2 border-t border-border flex flex-wrap items-center justify-between gap-3 text-xs text-text-muted">
              <div data-testid="data-browser-page-info">
                Showing {rows.length} of {totalCount} rows in{" "}
                <span className="font-mono text-text-primary">
                  {selectedWorkspace}
                </span>
                {compiledSql && (
                  <span className="ml-2 font-mono text-[10px] text-text-muted">
                    ({compiledSql})
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="data-browser-prev-page"
                  disabled={offset <= 0}
                  onClick={() => setOffset((prev) => Math.max(0, prev - limit))}
                  className="px-2.5 py-1 rounded bg-surface-control border border-border text-text-primary disabled:opacity-40"
                >
                  ← Prev
                </button>
                <button
                  type="button"
                  data-testid="data-browser-next-page"
                  disabled={offset + rows.length >= totalCount}
                  onClick={() => setOffset((prev) => prev + limit)}
                  className="px-2.5 py-1 rounded bg-surface-control border border-border text-text-primary disabled:opacity-40"
                >
                  Next →
                </button>
              </div>
            </div>
          </div>

          {/* Preview Audit Log Panel */}
          {envName === "preview" && (
            <div
              data-testid="data-browser-audit-panel"
              className="p-4 rounded-lg bg-surface-raised border border-border space-y-2"
            >
              <div className="text-xs font-bold text-text-primary flex items-center justify-between">
                <span>
                  Preview Write Audit Trail (`data_browser_audit_log`)
                </span>
                <span className="font-mono text-[11px] text-text-muted">
                  {auditEntries.length} recorded{" "}
                  {auditEntries.length === 1 ? "mutation" : "mutations"}
                </span>
              </div>
              {auditEntries.length === 0 ? (
                <div className="text-xs text-text-muted">
                  No preview row mutations recorded for this workspace/table yet.
                </div>
              ) : (
                <div className="space-y-1.5 max-h-44 overflow-y-auto">
                  {auditEntries.map((entry) => (
                    <div
                      key={entry.auditId}
                      data-testid={`data-browser-audit-entry-${entry.auditId}`}
                      className="p-2 rounded bg-surface-base border border-border text-[11px] font-mono flex flex-wrap items-center justify-between gap-2"
                    >
                      <div>
                        <span className="font-bold uppercase text-emerald-400">
                          {entry.operation}
                        </span>{" "}
                        <span className="text-text-primary">
                          {entry.tableName}/{entry.rowId}
                        </span>{" "}
                        <span className="text-text-muted">
                          (workspace: {entry.workspaceId})
                        </span>
                      </div>
                      <div className="text-text-muted">
                        actor: {entry.actor} · {entry.auditId}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Confirmation Modal for Preview Dynamic Entity Writes */}
      {pendingWrite && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm preview data write"
          data-testid="data-browser-confirm-modal"
          className="fixed inset-0 z-50 bg-slate-950/80 flex items-center justify-center p-4"
        >
          <div className="max-w-md w-full p-5 rounded-xl bg-surface-raised border border-border-strong space-y-4 shadow-2xl">
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-text-primary">
                Confirm Preview Entity Write ({pendingWrite.operation.toUpperCase()})
              </h3>
              <p className="text-xs text-text-secondary">
                This mutation on table{" "}
                <span className="font-mono font-bold text-accent">
                  {pendingWrite.tableName}
                </span>{" "}
                is scoped strictly to{" "}
                <span className="font-mono font-bold text-emerald-400">
                  workspace_id = &quot;{pendingWrite.workspaceId}&quot;
                </span>{" "}
                and will record an immutable before/after snapshot in{" "}
                <span className="font-mono">data_browser_audit_log</span>.
              </p>
            </div>

            <div className="p-2.5 rounded bg-surface-base border border-border font-mono text-[11px] text-text-secondary overflow-x-auto">
              {JSON.stringify(
                {
                  operation: pendingWrite.operation,
                  workspaceId: pendingWrite.workspaceId,
                  tableName: pendingWrite.tableName,
                  ...(pendingWrite.rowId ? { rowId: pendingWrite.rowId } : {}),
                  ...(pendingWrite.row ? { row: pendingWrite.row } : {}),
                  ...(pendingWrite.patch ? { patch: pendingWrite.patch } : {}),
                  confirmWrite: true,
                },
                null,
                2,
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                data-testid="data-browser-confirm-cancel"
                disabled={submittingWrite}
                onClick={() => setPendingWrite(null)}
                className="px-3 py-1.5 rounded bg-surface-control border border-border text-xs font-semibold text-text-secondary hover:text-text-primary"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="data-browser-confirm-submit"
                disabled={submittingWrite}
                onClick={() => void handleConfirmPendingWrite()}
                className="px-3.5 py-1.5 rounded bg-emerald-400 text-slate-950 font-bold text-xs hover:opacity-90 disabled:opacity-40"
              >
                {submittingWrite ? "Committing…" : "Confirm & Write"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
