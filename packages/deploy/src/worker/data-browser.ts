import type { D1Like } from "@poc/sdk";
import { CONTROL_REQUEST_ID_PATTERN, checkControlPlaneSignature, claimControlRequest } from "@poc/telemetry";

export const EXCLUDED_DATA_BROWSER_TABLES = new Set<string>([
  "px_connections",
  "int_connections",
  "_px_migrations",
  "_px_workflows",
  // Story R53: the deploy's own bookkeeping in the project's database (applied migrations; what Studio last deployed).
  "_projectx_migrations",
  "_projectx_studio_state",
  "px_runs",
  "px_step_events",
  "px_steps",
  "px_logs",
  "px_http_rollups",
  "px_queue_metrics",
  "px_schedules",
  // Story 1.17: the one-time request ids of the signed control-plane routes (keyed by workspace, but not app data).
  "px_control_requests",
  "deploy_tokens",
  "deploy_token_audit_log",
  "data_browser_audit_log",
  "d1_migrations",
  "_cf_KV",
  // The deploy's own tables: stored workflow graphs (keyed by workspace_id, but not app data, and their reserved "__app__"
  // workspace is not a workspace anyone browses) and the timed-write scratch table.
  "poc_graphs",
  "poc_write_latency",
  // Studio control-plane tables (when sharing STUDIO_DB in local/test mode)
  "user",
  "session",
  "account",
  "verification",
  "studio_orgs",
  "studio_org_members",
  "studio_mcp_tokens",
  "studio_audit_log",
  "studio_audit_logs",
  "projects",
  "project_retention_settings",
  "studio_builds",
  "studio_secret_vault",
  "project_environments",
  "project_deployments",
  "builds",
  "deployments",
  "deployment_steps",
  "onboarding_funnel_events",
  "studio_onboarding_events",
  "studio_connections_metadata",
  "studio_oauth_states",
  "studio_connection_requests",
  "mcp_files",
  "mcp_builds",
]);

/** A credit amount read from a table in whole (or decimal) credits, as whole thousandths; 0 when it is not a number. */
function toMilliOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}

export const IMMUTABLE_LEDGER_TABLES = new Set<string>([
  "credit_accounts",
  "credit_wallets",
  "credit_orders",
  "credit_ledger",
  "credit_action_costs",
  "wallet_balances",
  "wallet_ledger",
  "usage_events",
  "usage_rollups",
  "usage_meters",
  "meter_definitions",
  "meter_events",
  "meter_aggregates",
]);

const SECRET_COLUMN_PATTERN =
  /^(password|password_hash|hashed_password|secret|secret_token|access_token|refresh_token|api_key|private_key|client_secret|webhook_secret|signing_secret|ciphertext|ciphertext_b64|wrapped_dek|dek_iv|token_hash|session_token|encrypted_.*|.*_secret|.*_password|.*_password_hash|.*_token)$/i;

const SAFE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface DataBrowserColumnMetadata {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  readOnly: boolean;
}

export interface BrowsableTableMetadata {
  name: string;
  tableName: string;
  label: string;
  category: "entity" | "brick";
  readOnly: boolean;
  isLedger: boolean;
  columns: DataBrowserColumnMetadata[];
  rowCount?: number;
}

export interface DataBrowserFilterClause {
  column: string;
  op: "eq" | "contains" | "gt" | "lt";
  value: string | number | boolean;
}

export interface DataBrowserWalletSummary {
  balance: number;
  /** Story 2.5: the balance in whole thousandths of a credit (credit-wallet's unit since its migration 0004). */
  balanceMilli: number;
  currencyOrUnit: string;
  updatedAt: string;
  netChange30d: number;
  netChange30dMilli: number;
}

export interface DataBrowserUsageSummaryItem {
  metricKey: string;
  periodStart: string;
  periodEnd: string;
  totalQuantity: number;
}

export interface DataBrowserLedgerEntry {
  entryId: string;
  workspaceId: string;
  delta: number;
  balanceAfter: number;
  /** Story 2.5: the same two amounts in whole thousandths of a credit, exact. */
  deltaMilli: number;
  balanceAfterMilli: number;
  reason: string;
  idempotencyKey: string | null;
  runId?: string | null;
  nodeId?: string | null;
  createdAt: string;
}

export interface DataBrowserLedgerResponse {
  ok: true;
  envName: "preview" | "production";
  readOnly: true;
  immutable: true;
  workspaceId: string;
  wallet: DataBrowserWalletSummary;
  usageSummary: DataBrowserUsageSummaryItem[];
  journalEntries: DataBrowserLedgerEntry[];
  totalCount: number;
  nextCursor: string | null;
}

export interface DataBrowserOptions {
  db: D1Like;
  pxEnv?: "preview" | "production";
  /**
   * PX_TELEMETRY_SECRET. Every request must carry the control-plane signature made with it (story 1.4): method, path with
   * the whole query string, x-px-signed-at within 300 s, and the body. Without a secret every request is refused.
   */
  telemetrySecret?: string;
  /** Wall clock in epoch milliseconds, for the signature window (default Date.now). */
  clock?: () => number;
  /** Optional explicit entity names (e.g. ["invoices", "customers"]). */
  declaredEntities?: Iterable<string>;
  /** Optional explicit secret column names from brick manifests or entity schemas. */
  secretColumns?: Iterable<string>;
}

export function isExcludedDataBrowserTable(tableName: string): boolean {
  const trimmed = tableName.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("sqlite_") ||
    lower.startsWith("_cf_") ||
    lower.startsWith("_px_")
  ) {
    return true;
  }
  for (const excluded of EXCLUDED_DATA_BROWSER_TABLES) {
    if (excluded.toLowerCase() === lower) {
      return true;
    }
  }
  return false;
}

export function isImmutableLedgerTable(tableName: string): boolean {
  const trimmed = tableName.trim().toLowerCase();
  const normalized = trimmed.startsWith("ent_") ? trimmed.slice(4) : trimmed;
  return (
    IMMUTABLE_LEDGER_TABLES.has(trimmed) ||
    IMMUTABLE_LEDGER_TABLES.has(normalized)
  );
}

export function isSecretColumnName(
  columnName: string,
  explicitSecretColumns?: ReadonlySet<string>,
): boolean {
  const trimmed = columnName.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (explicitSecretColumns?.has(lower) || explicitSecretColumns?.has(trimmed)) {
    return true;
  }
  return SECRET_COLUMN_PATTERN.test(trimmed);
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

/**
 * The workspace a data request reads or writes: the `workspaceId` of its query, which the signature covers (story 1.4).
 * Empty when the query names none.
 */
function signedWorkspaceOf(url: URL): string {
  return (url.searchParams.get("workspaceId") ?? url.searchParams.get("workspace_id") ?? "").trim();
}

const workspaceRequired = (message: string) =>
  json(400, { error: { code: "WORKSPACE_ID_REQUIRED", message } });

interface SqliteTableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

export async function discoverBrowsableTables(
  db: D1Like,
  options: {
    pxEnv?: "preview" | "production";
    declaredEntities?: Iterable<string>;
    secretColumns?: Iterable<string>;
    workspaceIdForCount?: string;
  } = {},
): Promise<BrowsableTableMetadata[]> {
  const pxEnv = options.pxEnv === "production" ? "production" : "preview";
  const declaredEntitySet = new Set<string>();
  for (const name of options.declaredEntities ?? []) {
    if (typeof name === "string" && name.trim()) {
      declaredEntitySet.add(name.trim().toLowerCase());
      declaredEntitySet.add(`ent_${name.trim().toLowerCase()}`);
    }
  }

  const secretColSet = new Set<string>();
  for (const col of options.secretColumns ?? []) {
    if (typeof col === "string" && col.trim()) {
      secretColSet.add(col.trim().toLowerCase());
    }
  }

  const masterRes = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC",
    )
    .bind()
    .all<{ name: string }>();

  const rawTableNames = (masterRes.results ?? [])
    .map((r) => r.name)
    .filter(
      (name) =>
        typeof name === "string" &&
        SAFE_SQL_IDENTIFIER.test(name) &&
        !isExcludedDataBrowserTable(name),
    );

  // Deduplicate if both `ent_<name>` and `<name>` exist by preferring `ent_<name>` as sqlTable and `<name>` as logical entity name
  const tables: BrowsableTableMetadata[] = [];
  const seenLogicalNames = new Set<string>();

  // Sort so `ent_*` tables are processed before unprefixed aliases
  const sortedTableNames = [...rawTableNames].sort((a, b) => {
    const aEnt = a.startsWith("ent_") ? 0 : 1;
    const bEnt = b.startsWith("ent_") ? 0 : 1;
    if (aEnt !== bEnt) return aEnt - bEnt;
    return a.localeCompare(b);
  });

  for (const sqlTable of sortedTableNames) {
    const pragmaRes = await db
      .prepare(`PRAGMA table_info("${sqlTable}")`)
      .bind()
      .all<SqliteTableInfoRow>();
    const rawCols = pragmaRes.results ?? [];
    if (rawCols.length === 0) continue;

    const hasWorkspaceId = rawCols.some(
      (col) => col.name.toLowerCase() === "workspace_id",
    );
    if (!hasWorkspaceId) {
      continue;
    }

    const lowerSql = sqlTable.toLowerCase();
    const isEntity =
      lowerSql.startsWith("ent_") || declaredEntitySet.has(lowerSql);
    const logicalName = lowerSql.startsWith("ent_")
      ? sqlTable.slice(4)
      : sqlTable;
    if (seenLogicalNames.has(logicalName.toLowerCase())) {
      continue;
    }
    seenLogicalNames.add(logicalName.toLowerCase());

    const category: "entity" | "brick" = isEntity ? "entity" : "brick";
    const isLedger = isImmutableLedgerTable(sqlTable);
    const tableReadOnly =
      pxEnv === "production" || category !== "entity" || isLedger;

    const visibleColumns: DataBrowserColumnMetadata[] = rawCols
      .filter(
        (col) =>
          SAFE_SQL_IDENTIFIER.test(col.name) &&
          !isSecretColumnName(col.name, secretColSet),
      )
      .map((col) => {
        const isPk = Number(col.pk) > 0 || col.name === "id";
        const isSystemCol =
          isPk ||
          col.name === "workspace_id" ||
          col.name === "created_at" ||
          col.name === "updated_at";
        return {
          name: col.name,
          type: (col.type || "TEXT").toUpperCase(),
          notNull: Number(col.notnull) > 0 || isPk,
          primaryKey: isPk,
          readOnly: tableReadOnly || isSystemCol,
        };
      });

    if (visibleColumns.length === 0) continue;

    let rowCount: number | undefined;
    if (
      options.workspaceIdForCount &&
      options.workspaceIdForCount.trim().length > 0
    ) {
      const countRow = await db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM "${sqlTable}" WHERE "workspace_id" = ?1`,
        )
        .bind(options.workspaceIdForCount.trim())
        .first<{ cnt: number }>();
      rowCount = Number(countRow?.cnt ?? 0);
    }

    tables.push({
      name: logicalName,
      tableName: sqlTable,
      label: isEntity ? `${logicalName} (${sqlTable})` : sqlTable,
      category,
      readOnly: tableReadOnly,
      isLedger,
      columns: visibleColumns,
      ...(rowCount !== undefined ? { rowCount } : {}),
    });
  }

  return tables;
}

/**
 * Whether `workspaceId` has any row in the data store's browsable tables (or is an id in its `workspaces` table). One
 * `SELECT 1 ... LIMIT 1` per table, so it holds for any workspace, not only the first hundred a listing would return
 * (story 1.17: Studio's preview-workspace check).
 */
export async function workspaceHasBrowsableData(db: D1Like, workspaceId: string): Promise<boolean> {
  const ws = workspaceId.trim();
  if (!ws) return false;
  for (const table of await discoverBrowsableTables(db)) {
    try {
      const hit = await db
        .prepare(`SELECT 1 AS hit FROM "${table.tableName}" WHERE "workspace_id" = ?1 LIMIT 1`)
        .bind(ws)
        .first<{ hit: number }>();
      if (hit) return true;
    } catch {
      // a table that cannot be read names no workspace
    }
  }
  try {
    const wsTable = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspaces' LIMIT 1")
      .bind()
      .first<{ name: string }>();
    if (wsTable?.name === "workspaces") {
      const hit = await db.prepare("SELECT 1 AS hit FROM workspaces WHERE id = ?1 LIMIT 1").bind(ws).first<{ hit: number }>();
      if (hit) return true;
    }
  } catch {
    // a workspaces table of another shape names no workspace
  }
  return false;
}

export async function listBrowsableWorkspaces(
  db: D1Like,
  tables?: BrowsableTableMetadata[],
): Promise<string[]> {
  const catalogTables = tables ?? (await discoverBrowsableTables(db));
  const workspaceSet = new Set<string>();

  for (const table of catalogTables) {
    try {
      const res = await db
        .prepare(
          `SELECT DISTINCT "workspace_id" AS workspace_id FROM "${table.tableName}" WHERE "workspace_id" IS NOT NULL AND TRIM("workspace_id") != '' ORDER BY "workspace_id" ASC LIMIT 100`,
        )
        .bind()
        .all<{ workspace_id: string }>();
      for (const row of res.results ?? []) {
        if (typeof row.workspace_id === "string" && row.workspace_id.trim()) {
          workspaceSet.add(row.workspace_id.trim());
        }
      }
    } catch {
      // Ignore table read errors during workspace discovery
    }
  }

  // Also check if `workspaces` table has an `id` column (from multi-workspace brick)
  try {
    const wsTableRes = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspaces' LIMIT 1",
      )
      .bind()
      .first<{ name: string }>();
    if (wsTableRes?.name === "workspaces") {
      const wsIds = await db
        .prepare(
          "SELECT DISTINCT id FROM workspaces WHERE id IS NOT NULL AND TRIM(id) != '' ORDER BY id ASC LIMIT 100",
        )
        .bind()
        .all<{ id: string }>();
      for (const row of wsIds.results ?? []) {
        if (typeof row.id === "string" && row.id.trim()) {
          workspaceSet.add(row.id.trim());
        }
      }
    }
  } catch {
    // Ignore if workspaces table has different shape
  }

  // No workspace is invented when the data names none (story 1.4: there is no default workspace).
  return [...workspaceSet].sort((a, b) => a.localeCompare(b));
}

function resolveTargetTable(
  requestedName: string,
  tables: BrowsableTableMetadata[],
): BrowsableTableMetadata | null {
  const trimmed = requestedName.trim().toLowerCase();
  if (!trimmed) return null;
  const withoutEnt = trimmed.startsWith("ent_") ? trimmed.slice(4) : trimmed;
  const withEnt = `ent_${withoutEnt}`;

  return (
    tables.find(
      (t) =>
        t.name.toLowerCase() === trimmed ||
        t.tableName.toLowerCase() === trimmed ||
        t.name.toLowerCase() === withoutEnt ||
        t.tableName.toLowerCase() === withEnt,
    ) ?? null
  );
}

function parseFilterClauses(url: URL): {
  clauses: Array<{ column: string; op: "eq" | "contains" | "gt" | "lt"; value: string }>;
} {
  const clauses: Array<{
    column: string;
    op: "eq" | "contains" | "gt" | "lt";
    value: string;
  }> = [];

  const validOps = new Set(["eq", "contains", "gt", "lt"]);
  const normalizeOp = (raw: string | null | undefined): "eq" | "contains" | "gt" | "lt" => {
    const lower = (raw ?? "eq").trim().toLowerCase();
    return validOps.has(lower) ? (lower as "eq" | "contains" | "gt" | "lt") : "eq";
  };

  const singleCol =
    url.searchParams.get("filterCol") ??
    url.searchParams.get("filterColumn") ??
    url.searchParams.get("column");
  const singleOp =
    url.searchParams.get("filterOp") ??
    url.searchParams.get("op");
  const singleVal =
    url.searchParams.get("filterVal") ??
    url.searchParams.get("filterValue") ??
    url.searchParams.get("value");

  if (singleCol && singleCol.trim() && singleVal !== null && singleVal !== "") {
    clauses.push({
      column: singleCol.trim(),
      op: normalizeOp(singleOp),
      value: singleVal,
    });
  }

  const rawFilters =
    url.searchParams.get("filters") ?? url.searchParams.get("filter");
  if (rawFilters && rawFilters.trim()) {
    const trimmed = rawFilters.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of arr) {
          if (typeof item === "object" && item !== null) {
            const rec = item as Record<string, unknown>;
            const col =
              typeof rec.column === "string"
                ? rec.column
                : typeof rec.field === "string"
                  ? rec.field
                  : "";
            const val = rec.value;
            if (col.trim() && val !== undefined && val !== null && String(val) !== "") {
              clauses.push({
                column: col.trim(),
                op: normalizeOp(typeof rec.op === "string" ? rec.op : "eq"),
                value: String(val),
              });
            }
          }
        }
      } catch {
        // Ignore malformed JSON filter strings (never interpolate raw strings into SQL)
      }
    }
  }

  return { clauses };
}

export async function queryWorkspaceLedger(
  db: D1Like,
  workspaceId: string,
  options: {
    pxEnv?: "preview" | "production";
    cursor?: string | null;
    limit?: number;
  } = {},
): Promise<DataBrowserLedgerResponse> {
  const pxEnv = options.pxEnv === "production" ? "production" : "preview";
  const rawLimit = Number(options.limit ?? 50);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(100, Math.trunc(rawLimit)))
    : 50;
  const rawCursor = Number(options.cursor ?? 0);
  const offset =
    Number.isFinite(rawCursor) && rawCursor >= 0 ? Math.trunc(rawCursor) : 0;

  const existingTablesRes = await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all<{ name: string }>()
    .catch(() => ({ results: [] as Array<{ name: string }> }));
  const existingTableNames = new Set(
    (existingTablesRes.results ?? []).map((r) => r.name),
  );

  // 1. Collect journal entries across credit_ledger and wallet_ledger strictly scoped by WHERE "workspace_id" = ?1
  const allEntries: DataBrowserLedgerEntry[] = [];

  if (existingTableNames.has("credit_ledger")) {
    const rowsRes = await db
      .prepare(
        `SELECT * FROM "credit_ledger" WHERE "workspace_id" = ?1 ORDER BY "created_at" DESC, rowid DESC`,
      )
      .bind(workspaceId)
      .all<Record<string, unknown>>()
      .catch(() => ({ results: [] as Array<Record<string, unknown>> }));

    for (const row of rowsRes.results ?? []) {
      const entryId = String(row.id ?? row.entry_id ?? "");
      const rawType = String(row.type ?? row.entry_type ?? "topup").toLowerCase();
      // credit-wallet holds thousandths since its migration 0004 (story 2.5); a table still in whole credits is scaled.
      const rawMilli =
        row.amount_milli !== undefined && row.amount_milli !== null
          ? Number(row.amount_milli)
          : toMilliOrZero(row.amount ?? row.delta ?? row.delta_credits ?? 0);
      const deltaMilli =
        rawMilli < 0
          ? rawMilli
          : rawType === "deduction" || rawType === "debit" || rawType === "transfer_out"
            ? -Math.abs(rawMilli)
            : rawMilli;
      const balanceAfterMilli =
        row.balance_after_milli !== undefined && row.balance_after_milli !== null
          ? Number(row.balance_after_milli)
          : toMilliOrZero(row.balance_after ?? 0);
      const delta = deltaMilli / 1000;
      const balanceAfter = balanceAfterMilli / 1000;
      const reason = String(row.reason ?? "");
      const idempotencyKey =
        typeof row.idempotency_key === "string" && row.idempotency_key.length > 0
          ? row.idempotency_key
          : null;
      const createdAt = String(row.created_at ?? new Date().toISOString());

      let runId: string | null =
        typeof row.run_id === "string" && row.run_id
          ? row.run_id
          : typeof row.runId === "string" && row.runId
            ? row.runId
            : null;
      let nodeId: string | null =
        typeof row.node_id === "string" && row.node_id
          ? row.node_id
          : typeof row.nodeId === "string" && row.nodeId
            ? row.nodeId
            : null;

      if ((!runId || !nodeId) && typeof row.metadata === "string" && row.metadata.trim()) {
        try {
          const parsedMeta = JSON.parse(row.metadata) as Record<string, unknown>;
          if (!runId) {
            const metaRun = parsedMeta.runId ?? parsedMeta.run_id;
            if (typeof metaRun === "string" && metaRun) runId = metaRun;
          }
          if (!nodeId) {
            const metaNode = parsedMeta.nodeId ?? parsedMeta.node_id;
            if (typeof metaNode === "string" && metaNode) nodeId = metaNode;
          }
        } catch {
          // Ignore malformed metadata JSON
        }
      }

      allEntries.push({
        entryId,
        workspaceId,
        delta,
        balanceAfter,
        deltaMilli,
        balanceAfterMilli,
        reason,
        idempotencyKey,
        runId,
        nodeId,
        createdAt,
      });
    }
  }

  if (existingTableNames.has("wallet_ledger")) {
    const rowsRes = await db
      .prepare(
        `SELECT * FROM "wallet_ledger" WHERE "workspace_id" = ?1 ORDER BY "created_at" DESC, rowid DESC`,
      )
      .bind(workspaceId)
      .all<Record<string, unknown>>()
      .catch(() => ({ results: [] as Array<Record<string, unknown>> }));

    for (const row of rowsRes.results ?? []) {
      const entryId = String(row.entry_id ?? row.id ?? "");
      const rawType = String(row.entry_type ?? row.type ?? "grant").toLowerCase();
      const rawDeltaMilli = toMilliOrZero(row.delta_credits ?? row.delta ?? row.amount ?? 0);
      const deltaMilli =
        rawDeltaMilli < 0
          ? rawDeltaMilli
          : rawType === "deduction" || rawType === "debit"
            ? -Math.abs(rawDeltaMilli)
            : rawDeltaMilli;
      const balanceAfterMilli = toMilliOrZero(row.balance_after ?? 0);
      const delta = deltaMilli / 1000;
      const balanceAfter = balanceAfterMilli / 1000;
      const reason = String(row.reason ?? "");
      const idempotencyKey =
        typeof row.idempotency_key === "string" && row.idempotency_key.length > 0
          ? row.idempotency_key
          : null;
      const createdAt = String(row.created_at ?? new Date().toISOString());

      let runId: string | null =
        typeof row.run_id === "string" && row.run_id
          ? row.run_id
          : typeof row.runId === "string" && row.runId
            ? row.runId
            : null;
      let nodeId: string | null =
        typeof row.node_id === "string" && row.node_id
          ? row.node_id
          : typeof row.nodeId === "string" && row.nodeId
            ? row.nodeId
            : null;

      if ((!runId || !nodeId) && typeof row.metadata === "string" && row.metadata.trim()) {
        try {
          const parsedMeta = JSON.parse(row.metadata) as Record<string, unknown>;
          if (!runId) {
            const metaRun = parsedMeta.runId ?? parsedMeta.run_id;
            if (typeof metaRun === "string" && metaRun) runId = metaRun;
          }
          if (!nodeId) {
            const metaNode = parsedMeta.nodeId ?? parsedMeta.node_id;
            if (typeof metaNode === "string" && metaNode) nodeId = metaNode;
          }
        } catch {
          // Ignore malformed metadata JSON
        }
      }

      allEntries.push({
        entryId,
        workspaceId,
        delta,
        balanceAfter,
        deltaMilli,
        balanceAfterMilli,
        reason,
        idempotencyKey,
        runId,
        nodeId,
        createdAt,
      });
    }
  }

  allEntries.sort((a, b) => {
    const cmp = b.createdAt.localeCompare(a.createdAt);
    if (cmp !== 0) return cmp;
    return b.entryId.localeCompare(a.entryId);
  });

  // 2. Determine live wallet balance for workspaceId
  let walletBalanceMilli: number | null = null;
  let currencyOrUnit = "credits";
  let walletUpdatedAt = allEntries[0]?.createdAt ?? new Date(0).toISOString();

  if (existingTableNames.has("credit_wallets")) {
    const wRow = await db
      .prepare(
        `SELECT * FROM "credit_wallets" WHERE "workspace_id" = ?1 LIMIT 1`,
      )
      .bind(workspaceId)
      .first<Record<string, unknown>>()
      .catch(() => null);
    if (wRow) {
      walletBalanceMilli =
        wRow.balance_milli !== undefined && wRow.balance_milli !== null ? Number(wRow.balance_milli) : toMilliOrZero(wRow.balance ?? 0);
      if (typeof wRow.updated_at === "string" && wRow.updated_at) {
        walletUpdatedAt = wRow.updated_at;
      } else if (typeof wRow.created_at === "string" && wRow.created_at && allEntries.length === 0) {
        walletUpdatedAt = wRow.created_at;
      }
    }
  }

  if (walletBalanceMilli === null && existingTableNames.has("wallet_balances")) {
    const wRow = await db
      .prepare(
        `SELECT * FROM "wallet_balances" WHERE "workspace_id" = ?1 LIMIT 1`,
      )
      .bind(workspaceId)
      .first<Record<string, unknown>>()
      .catch(() => null);
    if (wRow) {
      walletBalanceMilli = toMilliOrZero(wRow.balance ?? wRow.credits ?? 0);
      if (typeof wRow.currency_or_unit === "string" && wRow.currency_or_unit) {
        currencyOrUnit = wRow.currency_or_unit;
      }
      if (typeof wRow.updated_at === "string" && wRow.updated_at) {
        walletUpdatedAt = wRow.updated_at;
      }
    }
  }

  if (walletBalanceMilli === null) {
    walletBalanceMilli = allEntries.length > 0 ? allEntries[0]!.balanceAfterMilli : 0;
  }

  // Summed in whole thousandths, never as floats (story 2.5).
  const netChange30dMilli = allEntries.reduce((acc, entry) => acc + entry.deltaMilli, 0);

  // 3. Collect usage summaries strictly scoped by WHERE "workspace_id" = ?1
  const usageSummary: DataBrowserUsageSummaryItem[] = [];

  if (existingTableNames.has("meter_aggregates")) {
    const aggRes = await db
      .prepare(
        `SELECT * FROM "meter_aggregates" WHERE "workspace_id" = ?1 ORDER BY "meter_key" ASC, "window_period" DESC`,
      )
      .bind(workspaceId)
      .all<Record<string, unknown>>()
      .catch(() => ({ results: [] as Array<Record<string, unknown>> }));
    for (const r of aggRes.results ?? []) {
      const wp = String(r.window_period ?? "current");
      usageSummary.push({
        metricKey: String(r.meter_key ?? "requests"),
        periodStart: wp,
        periodEnd: String(r.updated_at ?? wp),
        totalQuantity: Number(r.total_value ?? 0),
      });
    }
  }

  if (usageSummary.length === 0 && existingTableNames.has("meter_events")) {
    const evRes = await db
      .prepare(
        `SELECT "meter_key" AS metric_key, MIN("timestamp") AS period_start, MAX("timestamp") AS period_end, SUM("value") AS total_quantity
         FROM "meter_events"
         WHERE "workspace_id" = ?1
         GROUP BY "meter_key"
         ORDER BY "meter_key" ASC`,
      )
      .bind(workspaceId)
      .all<Record<string, unknown>>()
      .catch(() => ({ results: [] as Array<Record<string, unknown>> }));
    for (const r of evRes.results ?? []) {
      usageSummary.push({
        metricKey: String(r.metric_key ?? "events"),
        periodStart: String(r.period_start ?? ""),
        periodEnd: String(r.period_end ?? ""),
        totalQuantity: Number(r.total_quantity ?? 0),
      });
    }
  }

  if (existingTableNames.has("usage_rollups")) {
    const rollRes = await db
      .prepare(
        `SELECT * FROM "usage_rollups" WHERE "workspace_id" = ?1 ORDER BY "metric_key" ASC`,
      )
      .bind(workspaceId)
      .all<Record<string, unknown>>()
      .catch(() => ({ results: [] as Array<Record<string, unknown>> }));
    for (const r of rollRes.results ?? []) {
      usageSummary.push({
        metricKey: String(r.metric_key ?? r.meter_key ?? "usage"),
        periodStart: String(r.period_start ?? ""),
        periodEnd: String(r.period_end ?? ""),
        totalQuantity: Number(r.total_quantity ?? r.total_value ?? 0),
      });
    }
  }

  if (usageSummary.length === 0 && existingTableNames.has("usage_events")) {
    const evRes = await db
      .prepare(
        `SELECT "metric_key", MIN("created_at") AS period_start, MAX("created_at") AS period_end, SUM("quantity") AS total_quantity
         FROM "usage_events"
         WHERE "workspace_id" = ?1
         GROUP BY "metric_key"
         ORDER BY "metric_key" ASC`,
      )
      .bind(workspaceId)
      .all<Record<string, unknown>>()
      .catch(() => ({ results: [] as Array<Record<string, unknown>> }));
    for (const r of evRes.results ?? []) {
      usageSummary.push({
        metricKey: String(r.metric_key ?? "usage"),
        periodStart: String(r.period_start ?? ""),
        periodEnd: String(r.period_end ?? ""),
        totalQuantity: Number(r.total_quantity ?? 0),
      });
    }
  }

  const pagedEntries = allEntries.slice(offset, offset + limit);
  const nextCursor =
    offset + pagedEntries.length < allEntries.length
      ? String(offset + limit)
      : null;

  return {
    ok: true,
    envName: pxEnv,
    readOnly: true,
    immutable: true,
    workspaceId,
    wallet: {
      balance: walletBalanceMilli / 1000,
      balanceMilli: walletBalanceMilli,
      currencyOrUnit,
      updatedAt: walletUpdatedAt,
      netChange30d: netChange30dMilli / 1000,
      netChange30dMilli,
    },
    usageSummary,
    journalEntries: pagedEntries,
    totalCount: allEntries.length,
    nextCursor,
  };
}

export async function handleDataBrowserRequest(
  request: Request,
  options: DataBrowserOptions,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/__px/data")) {
    return null;
  }

  const pxEnv = options.pxEnv === "production" ? "production" : "preview";
  const isReadMethod = request.method === "GET";
  const rawBody = isReadMethod ? null : await request.text();

  // One signature scheme only: the control-plane one over method, path and query, timestamp and body, made with
  // PX_TELEMETRY_SECRET. No body-only, pathname-only or unsigned path remains (story 1.4).
  const refusal = await checkControlPlaneSignature(request, {
    secret: options.telemetrySecret,
    body: rawBody ?? "",
    nowMs: (options.clock ?? Date.now)(),
  });
  if (refusal) {
    return json(refusal.status, { error: { code: refusal.code, message: refusal.message } });
  }

  // Story 1.17: a signed write carries a one-time `requestId` (a UUID) in its signed query string, claimed in
  // px_control_requests before anything is written, so a captured write replayed inside the window is 409 and writes
  // nothing.
  if (!isReadMethod) {
    const requestId = url.searchParams.get("requestId") ?? "";
    if (!CONTROL_REQUEST_ID_PATTERN.test(requestId)) {
      return json(400, {
        error: { code: "BAD_REQUEST_ID", message: "a signed write needs a requestId (a UUID) in its query string, used once" },
      });
    }
    const fresh = await claimControlRequest(options.db, {
      requestId,
      path: url.pathname,
      workspaceId: signedWorkspaceOf(url) || null,
      nowMs: (options.clock ?? Date.now)(),
    });
    if (!fresh) {
      return json(409, {
        error: { code: "DUPLICATE_REQUEST", message: "this requestId has already been used; nothing was written" },
      });
    }
  }

  const secretColSet = new Set<string>();
  for (const col of options.secretColumns ?? []) {
    if (typeof col === "string" && col.trim()) {
      secretColSet.add(col.trim().toLowerCase());
    }
  }

  // Route 1: GET /__px/data/workspaces
  if (url.pathname === "/__px/data/workspaces") {
    if (request.method !== "GET") {
      return json(405, {
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "Expected GET /__px/data/workspaces",
        },
      });
    }
    const tables = await discoverBrowsableTables(options.db, {
      pxEnv,
      declaredEntities: options.declaredEntities,
      secretColumns: options.secretColumns,
    });
    const workspaces = await listBrowsableWorkspaces(options.db, tables);
    return json(200, {
      ok: true,
      envName: pxEnv,
      workspaces,
    });
  }

  // Route 2: GET /__px/data/tables
  if (url.pathname === "/__px/data/tables") {
    if (request.method !== "GET") {
      return json(405, {
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "Expected GET /__px/data/tables",
        },
      });
    }
    // With a (signed) workspace, each table's row count in that workspace; without one, the table schema only: no row
    // and no count of any workspace.
    const workspaceId = signedWorkspaceOf(url) || undefined;
    const tables = await discoverBrowsableTables(options.db, {
      pxEnv,
      declaredEntities: options.declaredEntities,
      secretColumns: options.secretColumns,
      workspaceIdForCount: workspaceId,
    });
    return json(200, {
      ok: true,
      envName: pxEnv,
      readOnly: pxEnv === "production",
      tables,
    });
  }

  // Route 2b: GET /__px/data/ledger (and reject any write method with 403 LEDGER_IMMUTABLE_READ_ONLY in both preview & production)
  if (
    url.pathname === "/__px/data/ledger" ||
    url.pathname.startsWith("/__px/data/ledger/")
  ) {
    if (
      request.method === "POST" ||
      request.method === "PATCH" ||
      request.method === "PUT" ||
      request.method === "DELETE"
    ) {
      return json(403, {
        error: {
          code: "LEDGER_IMMUTABLE_READ_ONLY",
          message:
            "Wallet and usage ledger tables are immutable and cannot be modified from the Data Browser in any environment.",
        },
      });
    }

    if (request.method !== "GET") {
      return json(405, {
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "Expected GET /__px/data/ledger",
        },
      });
    }

    const workspaceId = signedWorkspaceOf(url);

    if (!workspaceId) {
      return workspaceRequired(
        "Query parameter 'workspaceId' is required to inspect the Wallet & Usage Ledger (WHERE workspace_id = ?1).",
      );
    }

    const cursor = url.searchParams.get("cursor") ?? url.searchParams.get("offset");
    const limitRaw = Number(url.searchParams.get("limit") ?? "50");
    const ledgerPayload = await queryWorkspaceLedger(options.db, workspaceId, {
      pxEnv,
      cursor,
      limit: limitRaw,
    });
    return json(200, ledgerPayload);
  }

  // Match /__px/data/tables/:tableName/rows or /__px/data/tables/:tableName/rows/:rowId
  const rowsMatch = url.pathname.match(
    /^\/__px\/data\/tables\/([^/]+)\/rows(?:\/([^/]+))?$/,
  );
  if (!rowsMatch) {
    return null;
  }

  const requestedTableName = decodeURIComponent(rowsMatch[1]!);
  const pathRowId = rowsMatch[2] ? decodeURIComponent(rowsMatch[2]) : undefined;

  if (isExcludedDataBrowserTable(requestedTableName)) {
    return json(403, {
      error: {
        code: "TABLE_FORBIDDEN",
        message: `Table "${requestedTableName}" is a protected system or secret table and is excluded from the Data Browser.`,
      },
    });
  }

  const tables = await discoverBrowsableTables(options.db, {
    pxEnv,
    declaredEntities: options.declaredEntities,
    secretColumns: options.secretColumns,
  });
  const targetTable = resolveTargetTable(requestedTableName, tables);

  // Check ledger immutability on write methods even before table existence so wallet/ledger names always return LEDGER_IMMUTABLE_READ_ONLY
  if (
    request.method === "POST" ||
    request.method === "PATCH" ||
    request.method === "PUT" ||
    request.method === "DELETE"
  ) {
    if (
      isImmutableLedgerTable(requestedTableName) ||
      targetTable?.isLedger
    ) {
      return json(403, {
        error: {
          code: "LEDGER_IMMUTABLE_READ_ONLY",
          message:
            "Wallet and usage ledger tables are immutable and cannot be modified from the Data Browser in any environment.",
        },
      });
    }

    if (pxEnv === "production") {
      return json(403, {
        error: {
          code: "PRODUCTION_DATA_WRITE_FORBIDDEN",
          message:
            "Data Browser writes are strictly forbidden in the production environment.",
        },
      });
    }
  }

  if (!targetTable) {
    return json(404, {
      error: {
        code: "TABLE_NOT_FOUND",
        message: `Table "${requestedTableName}" was not found in the browsable catalog.`,
      },
    });
  }

  const allowlistedColumnMap = new Map(
    targetTable.columns.map((c) => [c.name.toLowerCase(), c]),
  );
  const projectionSql = targetTable.columns
    .map((c) => `"${c.name}"`)
    .join(", ");

  // Route 3: GET /__px/data/tables/:tableName/rows
  if (request.method === "GET") {
    const workspaceId = signedWorkspaceOf(url);

    if (!workspaceId) {
      return workspaceRequired("Query parameter 'workspaceId' is required and must be non-empty.");
    }

    const limitRaw = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(100, Math.trunc(limitRaw)))
      : 50;

    const offsetRaw = Number(
      url.searchParams.get("offset") ?? url.searchParams.get("cursor") ?? "0",
    );
    const offset =
      Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.trunc(offsetRaw) : 0;

    // Parameter ?1 is ALWAYS workspaceId
    const whereParts: string[] = [`"workspace_id" = ?1`];
    const bindValues: unknown[] = [workspaceId];

    const { clauses } = parseFilterClauses(url);
    for (const clause of clauses) {
      const colLower = clause.column.toLowerCase();
      // Never allow filtering on secret columns or overriding workspace_id isolation
      if (isSecretColumnName(clause.column, secretColSet)) {
        return json(400, {
          error: {
            code: "SECRET_COLUMN_FORBIDDEN",
            message: `Column "${clause.column}" is restricted and cannot be queried.`,
          },
        });
      }
      if (colLower === "workspace_id") {
        // Ignore any attempt to filter workspace_id away from ?1
        continue;
      }
      const colMeta = allowlistedColumnMap.get(colLower);
      if (!colMeta) {
        // Ignore unknown / non-allowlisted column names so adversarial filter keys cannot inject SQL
        continue;
      }

      const paramIndex = bindValues.length + 1;
      const quotedCol = `"${colMeta.name}"`;
      if (clause.op === "contains") {
        whereParts.push(`CAST(${quotedCol} AS TEXT) LIKE ?${paramIndex}`);
        bindValues.push(`%${clause.value}%`);
      } else if (clause.op === "gt") {
        whereParts.push(`${quotedCol} > ?${paramIndex}`);
        bindValues.push(clause.value);
      } else if (clause.op === "lt") {
        whereParts.push(`${quotedCol} < ?${paramIndex}`);
        bindValues.push(clause.value);
      } else {
        whereParts.push(`${quotedCol} = ?${paramIndex}`);
        bindValues.push(clause.value);
      }
    }

    const rawSortCol = (
      url.searchParams.get("sortCol") ??
      url.searchParams.get("sortBy") ??
      url.searchParams.get("sort") ??
      "id"
    ).trim();
    const sortColMeta =
      allowlistedColumnMap.get(rawSortCol.toLowerCase()) ??
      allowlistedColumnMap.get("id") ??
      targetTable.columns[0]!;
    const rawSortDir = (
      url.searchParams.get("sortDir") ??
      url.searchParams.get("sortOrder") ??
      url.searchParams.get("order") ??
      "asc"
    )
      .trim()
      .toUpperCase();
    const sortDir: "ASC" | "DESC" = rawSortDir === "DESC" ? "DESC" : "ASC";

    const whereSql = `WHERE ${whereParts.join(" AND ")}`;
    const countSql = `SELECT COUNT(*) AS cnt FROM "${targetTable.tableName}" ${whereSql}`;
    const countRow = await options.db
      .prepare(countSql)
      .bind(...bindValues)
      .first<{ cnt: number }>();
    const totalCount = Number(countRow?.cnt ?? 0);

    const limitParamIdx = bindValues.length + 1;
    const offsetParamIdx = bindValues.length + 2;
    const selectSql = `SELECT ${projectionSql} FROM "${targetTable.tableName}" ${whereSql} ORDER BY "${sortColMeta.name}" ${sortDir} LIMIT ?${limitParamIdx} OFFSET ?${offsetParamIdx}`;
    const rowsRes = await options.db
      .prepare(selectSql)
      .bind(...bindValues, limit, offset)
      .all<Record<string, unknown>>();

    const rows = (rowsRes.results ?? []).map((row) => {
      const sanitized: Record<string, unknown> = {};
      for (const col of targetTable.columns) {
        if (Object.hasOwn(row, col.name)) {
          sanitized[col.name] = row[col.name];
        }
      }
      return sanitized;
    });

    const hasMore = offset + rows.length < totalCount;
    const nextCursor = hasMore ? String(offset + limit) : null;

    return json(200, {
      ok: true,
      envName: pxEnv,
      readOnly: targetTable.readOnly,
      workspaceId,
      tableName: targetTable.name,
      sqlTable: targetTable.tableName,
      category: targetTable.category,
      columns: targetTable.columns,
      rows,
      totalCount,
      limit,
      offset,
      hasMore,
      nextCursor,
      sortCol: sortColMeta.name,
      sortDir: sortDir.toLowerCase(),
      compiledSql: selectSql,
    });
  }

  // Route 4: Write operations (POST | PATCH | DELETE) in preview
  if (
    request.method !== "POST" &&
    request.method !== "PATCH" &&
    request.method !== "DELETE"
  ) {
    return json(405, {
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: `Unsupported method ${request.method}`,
      },
    });
  }

  if (targetTable.category !== "entity") {
    return json(403, {
      error: {
        code: "TABLE_READ_ONLY",
        message: `Table "${targetTable.name}" is a brick table and is read-only in the Data Browser.`,
      },
    });
  }

  let parsedBody: Record<string, unknown> = {};
  if (rawBody && rawBody.trim().length > 0) {
    try {
      const jsonVal = JSON.parse(rawBody) as unknown;
      if (typeof jsonVal === "object" && jsonVal !== null && !Array.isArray(jsonVal)) {
        parsedBody = jsonVal as Record<string, unknown>;
      }
    } catch {
      return json(400, {
        error: {
          code: "INVALID_JSON",
          message: "Request body must be a valid JSON object.",
        },
      });
    }
  }

  // The workspace of a mutation is the signed query's; a body that names another one is refused.
  const workspaceId = signedWorkspaceOf(url);

  if (!workspaceId) {
    return workspaceRequired("A non-empty 'workspaceId' query parameter is required for all Data Browser mutations.");
  }
  for (const bodyWorkspace of [parsedBody.workspaceId, parsedBody.workspace_id]) {
    if (typeof bodyWorkspace === "string" && bodyWorkspace.trim() && bodyWorkspace.trim() !== workspaceId) {
      return json(400, {
        error: {
          code: "WORKSPACE_MISMATCH",
          message: "The body names a different workspace than the signed query; nothing was written.",
        },
      });
    }
  }

  if (parsedBody.confirmWrite !== true) {
    return json(422, {
      error: {
        code: "CONFIRM_WRITE_REQUIRED",
        message:
          "Preview entity mutations require explicit confirmation (confirmWrite: true).",
      },
    });
  }

  const inputRowObject =
    typeof parsedBody.row === "object" &&
    parsedBody.row !== null &&
    !Array.isArray(parsedBody.row)
      ? (parsedBody.row as Record<string, unknown>)
      : typeof parsedBody.patch === "object" &&
          parsedBody.patch !== null &&
          !Array.isArray(parsedBody.patch)
        ? (parsedBody.patch as Record<string, unknown>)
        : typeof parsedBody.values === "object" &&
            parsedBody.values !== null &&
            !Array.isArray(parsedBody.values)
          ? (parsedBody.values as Record<string, unknown>)
          : typeof parsedBody.data === "object" &&
              parsedBody.data !== null &&
              !Array.isArray(parsedBody.data)
            ? (parsedBody.data as Record<string, unknown>)
            : parsedBody;

  if (request.method === "POST") {
    const requestedId =
      typeof inputRowObject.id === "string" && inputRowObject.id.trim()
        ? inputRowObject.id.trim()
        : typeof parsedBody.rowId === "string" && parsedBody.rowId.trim()
          ? parsedBody.rowId.trim()
          : `row_${crypto.randomUUID()}`;

    const insertCols: string[] = ["workspace_id", "id"];
    const insertParams: unknown[] = [workspaceId, requestedId];

    for (const col of targetTable.columns) {
      if (col.name === "workspace_id" || col.name === "id") continue;
      if (Object.hasOwn(inputRowObject, col.name)) {
        const val = inputRowObject[col.name];
        insertCols.push(col.name);
        insertParams.push(
          typeof val === "boolean"
            ? val
              ? 1
              : 0
            : val !== undefined && typeof val === "object" && val !== null
              ? JSON.stringify(val)
              : (val ?? null),
        );
      } else if (col.notNull) {
        insertCols.push(col.name);
        insertParams.push(
          col.type.includes("INT") || col.type.includes("REAL") || col.type.includes("NUM")
            ? 0
            : "",
        );
      }
    }

    const quotedInsertCols = insertCols.map((c) => `"${c}"`).join(", ");
    const placeholders = insertCols.map((_, idx) => `?${idx + 1}`).join(", ");
    const insertSql = `INSERT INTO "${targetTable.tableName}" (${quotedInsertCols}) VALUES (${placeholders})`;

    await options.db
      .prepare(insertSql)
      .bind(...insertParams)
      .run();

    const afterSnapshot = await options.db
      .prepare(
        `SELECT ${projectionSql} FROM "${targetTable.tableName}" WHERE "workspace_id" = ?1 AND "id" = ?2`,
      )
      .bind(workspaceId, requestedId)
      .first<Record<string, unknown>>();

    return json(201, {
      ok: true,
      operation: "insert",
      envName: pxEnv,
      workspaceId,
      tableName: targetTable.name,
      sqlTable: targetTable.tableName,
      rowId: requestedId,
      row: afterSnapshot,
      beforeSnapshot: null,
      afterSnapshot,
    });
  }

  const targetRowId = (
    pathRowId ||
    (typeof parsedBody.rowId === "string" ? parsedBody.rowId : "") ||
    (typeof parsedBody.id === "string" ? parsedBody.id : "") ||
    (typeof inputRowObject.id === "string" ? inputRowObject.id : "") ||
    url.searchParams.get("rowId") ||
    url.searchParams.get("id") ||
    ""
  ).trim();

  if (!targetRowId) {
    return json(400, {
      error: {
        code: "ROW_ID_REQUIRED",
        message: "A non-empty 'rowId' (or 'id') is required for PATCH and DELETE.",
      },
    });
  }

  // Strictly scope lookup to WHERE "workspace_id" = ?1 AND "id" = ?2
  const beforeSnapshot = await options.db
    .prepare(
      `SELECT ${projectionSql} FROM "${targetTable.tableName}" WHERE "workspace_id" = ?1 AND "id" = ?2`,
    )
    .bind(workspaceId, targetRowId)
    .first<Record<string, unknown>>();

  if (!beforeSnapshot) {
    return json(404, {
      error: {
        code: "ROW_NOT_FOUND",
        message: `Row "${targetRowId}" does not exist in workspace "${workspaceId}".`,
      },
    });
  }

  if (request.method === "PATCH") {
    const editableCols = targetTable.columns.filter(
      (col) =>
        col.name !== "id" &&
        col.name !== "workspace_id" &&
        col.name !== "created_at" &&
        Object.hasOwn(inputRowObject, col.name) &&
        col.name !== "confirmWrite" &&
        col.name !== "workspaceId" &&
        col.name !== "rowId",
    );

    if (editableCols.length === 0) {
      return json(400, {
        error: {
          code: "EMPTY_PATCH",
          message: "No editable non-secret columns were provided in the PATCH payload.",
        },
      });
    }

    // Parameter ?1 is workspaceId, Parameter ?2 is targetRowId
    const bindArgs: unknown[] = [workspaceId, targetRowId];
    const setClauses: string[] = [];

    for (const col of editableCols) {
      const paramIdx = bindArgs.length + 1;
      setClauses.push(`"${col.name}" = ?${paramIdx}`);
      const rawVal = inputRowObject[col.name];
      bindArgs.push(
        typeof rawVal === "boolean"
          ? rawVal
            ? 1
            : 0
          : rawVal !== undefined && typeof rawVal === "object" && rawVal !== null
            ? JSON.stringify(rawVal)
            : (rawVal ?? null),
      );
    }

    const updateSql = `UPDATE "${targetTable.tableName}" SET ${setClauses.join(", ")} WHERE "workspace_id" = ?1 AND "id" = ?2`;
    await options.db
      .prepare(updateSql)
      .bind(...bindArgs)
      .run();

    const afterSnapshot = await options.db
      .prepare(
        `SELECT ${projectionSql} FROM "${targetTable.tableName}" WHERE "workspace_id" = ?1 AND "id" = ?2`,
      )
      .bind(workspaceId, targetRowId)
      .first<Record<string, unknown>>();

    return json(200, {
      ok: true,
      operation: "update",
      envName: pxEnv,
      workspaceId,
      tableName: targetTable.name,
      sqlTable: targetTable.tableName,
      rowId: targetRowId,
      row: afterSnapshot,
      beforeSnapshot,
      afterSnapshot,
    });
  }

  // DELETE: strictly scoped to WHERE "workspace_id" = ?1 AND "id" = ?2
  const deleteSql = `DELETE FROM "${targetTable.tableName}" WHERE "workspace_id" = ?1 AND "id" = ?2`;
  await options.db.prepare(deleteSql).bind(workspaceId, targetRowId).run();

  return json(200, {
    ok: true,
    operation: "delete",
    envName: pxEnv,
    workspaceId,
    tableName: targetTable.name,
    sqlTable: targetTable.tableName,
    rowId: targetRowId,
    beforeSnapshot,
    afterSnapshot: null,
  });
}
