import { applyMigration } from "@poc/sdk";
import type { D1Like, D1Result, D1Statement } from "@poc/sdk";
import { APP_WORKSPACE, GRAPH_MIGRATIONS, GRAPH_TABLE, TELEMETRY_MIGRATION } from "./worker/graph-run.ts";

export const SANDBOX_DAILY_REQUEST_LIMIT = 10_000;
export const SANDBOX_DAILY_REQUEST_QUOTA = SANDBOX_DAILY_REQUEST_LIMIT;
export const SANDBOX_D1_MAX_ROWS = 10_000;
export const SANDBOX_D1_ROW_CAP = SANDBOX_D1_MAX_ROWS;
export const SANDBOX_D1_MAX_BYTES = 25 * 1024 * 1024; // 25 MB
export const SANDBOX_D1_BYTES_CAP = SANDBOX_D1_MAX_BYTES;
export const SANDBOX_TTL_DAYS = 7;
export const SANDBOX_TTL_MS = SANDBOX_TTL_DAYS * 24 * 60 * 60 * 1000; // 7 days
export const SANDBOX_OUTBOUND_RPM_LIMIT = 60;
export const SANDBOX_OUTBOUND_RATE_LIMIT_PER_MIN = SANDBOX_OUTBOUND_RPM_LIMIT;
export const DEFAULT_SANDBOX_DISPATCH_NAMESPACE = "px-sandbox-preview";

export type SandboxGuardrailCode =
  | "SANDBOX_QUOTA_EXCEEDED"
  | "SANDBOX_STORAGE_CAP_EXCEEDED"
  | "SANDBOX_EXPIRED"
  | "SANDBOX_OUTBOUND_RATE_LIMITED"
  | "SANDBOX_LIVE_PAYMENTS_BLOCKED"
  | "SANDBOX_SSRF_BLOCKED"
  | "SANDBOX_NOT_FOUND";
export type SandboxErrorCode = SandboxGuardrailCode;

export class SandboxGuardrailError extends Error {
  readonly code: SandboxGuardrailCode;
  readonly status: 403 | 404 | 410 | 429;

  constructor(
    code: SandboxGuardrailCode,
    status: 403 | 404 | 410 | 429,
    message: string,
  ) {
    super(message);
    this.name = "SandboxGuardrailError";
    this.code = code;
    this.status = status;
  }

  toResponse(): Response {
    return new Response(
      JSON.stringify({
        error: {
          code: this.code,
          message: this.message,
          upgradeCta: "Move to my Cloudflare account",
          dailyLimit: SANDBOX_DAILY_REQUEST_LIMIT,
          maxRows: SANDBOX_D1_MAX_ROWS,
          maxBytes: SANDBOX_D1_MAX_BYTES,
        },
      }),
      {
        status: this.status,
        headers: { "content-type": "application/json" },
      },
    );
  }
}

const LIVE_PAYMENT_KEY_PATTERNS: readonly RegExp[] = [
  /\bsk_live_[A-Za-z0-9_]+\b/i,
  /\brk_live_[A-Za-z0-9_]+\b/i,
  /\bpk_live_[A-Za-z0-9_]+\b/i,
  /\bwhsec_live_[A-Za-z0-9_]+\b/i,
  /\bcfsk_ma_prod_[A-Za-z0-9_]+\b/i,
  /\bcf_live_[A-Za-z0-9_]+\b/i,
  /\blive_cashfree_[A-Za-z0-9_]+\b/i,
];

const LIVE_PAYMENT_HOSTS: readonly string[] = [
  "api.cashfree.com",
  "payout.cashfree.com",
  "checkout.stripe.com",
];

export function isLivePaymentCredential(
  secretNameOrRef: string,
  secretValue: string,
): { blocked: boolean; reason?: string } {
  const trimmedVal = secretValue.trim();
  for (const pattern of LIVE_PAYMENT_KEY_PATTERNS) {
    if (pattern.test(trimmedVal)) {
      return {
        blocked: true,
        reason: `Live payment credential detected in "${secretNameOrRef}". Hosted sandboxes only permit test/sandbox credentials (e.g. sk_test_*). Move to your Cloudflare account (BYOC) to use live payment keys.`,
      };
    }
  }
  const lowerName = secretNameOrRef.toLowerCase();
  const lowerVal = trimmedVal.toLowerCase();
  if (
    (lowerName.includes("stripe") ||
      lowerName.includes("cashfree") ||
      lowerName.includes("payment")) &&
    (lowerVal.startsWith("live_") || lowerVal.includes("_prod_"))
  ) {
    return {
      blocked: true,
      reason: `Live payment credential detected in "${secretNameOrRef}". Hosted sandboxes only permit test/sandbox credentials.`,
    };
  }
  return { blocked: false };
}

export function assertNoLivePaymentCredential(
  secretNameOrRef: string,
  secretValue: string,
): void {
  const check = isLivePaymentCredential(secretNameOrRef, secretValue);
  if (check.blocked) {
    throw new SandboxGuardrailError(
      "SANDBOX_LIVE_PAYMENTS_BLOCKED",
      403,
      check.reason ??
        "Live payment credentials (sk_live_*, Cashfree production keys) are blocked in hosted sandboxes.",
    );
  }
}

export function inspectOutboundPaymentAndSsrf(
  inputUrl: string | URL,
  init?: RequestInit,
): { blocked: false } | { blocked: true; error: SandboxGuardrailError } {
  let parsed: URL;
  try {
    parsed = typeof inputUrl === "string" ? new URL(inputUrl) : inputUrl;
  } catch {
    return {
      blocked: true,
      error: new SandboxGuardrailError(
        "SANDBOX_SSRF_BLOCKED",
        403,
        `Invalid outbound URL "${String(inputUrl)}" in sandbox environment.`,
      ),
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "169.254.169.254" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    return {
      blocked: true,
      error: new SandboxGuardrailError(
        "SANDBOX_SSRF_BLOCKED",
        403,
        `Outbound request to private/loopback/metadata host "${host}" is blocked in hosted sandbox.`,
      ),
    };
  }

  if (parsed.protocol !== "https:") {
    return {
      blocked: true,
      error: new SandboxGuardrailError(
        "SANDBOX_SSRF_BLOCKED",
        403,
        `Outbound request in hosted sandbox must use https: (received "${parsed.protocol}").`,
      ),
    };
  }

  // Inspect headers and body for live payment credentials
  const headerEntries: Array<[string, string]> = [];
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => headerEntries.push([k, v]));
    } else if (Array.isArray(init.headers)) {
      for (const pair of init.headers) {
        if (Array.isArray(pair) && pair.length >= 2) {
          headerEntries.push([String(pair[0]), String(pair[1])]);
        }
      }
    } else {
      for (const [k, v] of Object.entries(init.headers)) {
        if (v !== undefined) headerEntries.push([k, String(v)]);
      }
    }
  }

  let hasTestCredential = false;
  for (const [k, v] of headerEntries) {
    const check = isLivePaymentCredential(k, v);
    if (check.blocked) {
      return {
        blocked: true,
        error: new SandboxGuardrailError(
          "SANDBOX_LIVE_PAYMENTS_BLOCKED",
          403,
          check.reason ??
            "Outbound request carrying live payment credentials (sk_live_*) is blocked in hosted sandbox.",
        ),
      };
    }
    if (/\b(?:sk_test_|rk_test_|pk_test_|cfsk_ma_test_)/i.test(v)) {
      hasTestCredential = true;
    }
  }

  if (typeof init?.body === "string") {
    const bodyCheck = isLivePaymentCredential("request_body", init.body);
    if (bodyCheck.blocked) {
      return {
        blocked: true,
        error: new SandboxGuardrailError(
          "SANDBOX_LIVE_PAYMENTS_BLOCKED",
          403,
          bodyCheck.reason ??
            "Outbound request body containing live payment credentials is blocked in hosted sandbox.",
        ),
      };
    }
  }

  if (LIVE_PAYMENT_HOSTS.includes(host)) {
    return {
      blocked: true,
      error: new SandboxGuardrailError(
        "SANDBOX_LIVE_PAYMENTS_BLOCKED",
        403,
        `Outbound request to live payment gateway host "${host}" is blocked in hosted sandbox. Use sandbox/test endpoints or move to your Cloudflare account (BYOC).`,
      ),
    };
  }

  if (
    host === "api.stripe.com" &&
    (parsed.pathname.startsWith("/v1/charges") ||
      parsed.pathname.startsWith("/v1/payment_intents") ||
      parsed.pathname.startsWith("/v1/checkout/sessions") ||
      parsed.pathname.startsWith("/v1/Transfers")) &&
    !hasTestCredential
  ) {
    return {
      blocked: true,
      error: new SandboxGuardrailError(
        "SANDBOX_LIVE_PAYMENTS_BLOCKED",
        403,
        `Outbound request to Stripe charge endpoint "${parsed.pathname}" requires an explicit sk_test_* key in hosted sandbox.`,
      ),
    };
  }

  return { blocked: false };
}

export interface SandboxStorageCapOptions {
  maxRows?: number;
  maxBytes?: number;
  initialRows?: number;
  initialBytes?: number;
}

export interface SandboxStorageStats {
  totalRows: number;
  totalBytes: number;
  maxRows: number;
  maxBytes: number;
}

export interface GuardedSandboxD1 extends D1Like {
  getStorageStats(): Promise<SandboxStorageStats>;
  setSimulatedStorageStats(stats: { totalRows?: number; totalBytes?: number }): void;
}

function isWriteSqlMutation(sql: string): boolean {
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ")
    .trim();
  return /^(?:INSERT|UPDATE|REPLACE)\b/i.test(cleaned);
}

export function wrapSandboxD1WithStorageCap(
  underlyingDb: D1Like,
  options: SandboxStorageCapOptions = {},
): GuardedSandboxD1 {
  const maxRows = options.maxRows ?? SANDBOX_D1_MAX_ROWS;
  const maxBytes = options.maxBytes ?? SANDBOX_D1_MAX_BYTES;
  let simulatedRows: number | null = options.initialRows ?? null;
  let simulatedBytes: number | null = options.initialBytes ?? null;

  async function measureStorageStats(): Promise<SandboxStorageStats> {
    let totalBytes = simulatedBytes ?? 0;
    let totalRows = simulatedRows ?? 0;

    if (simulatedBytes === null) {
      try {
        const pageCountRow = await underlyingDb
          .prepare("PRAGMA page_count")
          .first<{ page_count?: number }>();
        const pageSizeRow = await underlyingDb
          .prepare("PRAGMA page_size")
          .first<{ page_size?: number }>();
        const pageCount = Number(pageCountRow?.page_count ?? 0);
        const pageSize = Number(pageSizeRow?.page_size ?? 4096);
        if (pageCount > 0 && pageSize > 0) {
          totalBytes = pageCount * pageSize;
        }
      } catch {
        // Fallback if underlying D1 mock does not support PRAGMA
      }
    }

    if (simulatedRows === null) {
      try {
        const tablesRes = await underlyingDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
          )
          .all<{ name: string }>();
        let sum = 0;
        for (const tbl of tablesRes.results ?? []) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tbl.name)) continue;
          const cntRow = await underlyingDb
            .prepare(`SELECT COUNT(*) AS cnt FROM "${tbl.name}"`)
            .first<{ cnt?: number }>();
          sum += Number(cntRow?.cnt ?? 0);
        }
        totalRows = sum;
      } catch {
        // Fallback if underlying D1 mock does not expose sqlite_master
      }
    }

    return {
      totalRows,
      totalBytes,
      maxRows,
      maxBytes,
    };
  }

  async function assertWithinStorageCap(sql: string): Promise<void> {
    if (!isWriteSqlMutation(sql)) {
      return;
    }
    const stats = await measureStorageStats();
    if (stats.totalRows >= maxRows || stats.totalBytes >= maxBytes) {
      throw new SandboxGuardrailError(
        "SANDBOX_STORAGE_CAP_EXCEEDED",
        403,
        "Sandbox D1 storage cap (10,000 rows / 25 MB) reached. Move to your Cloudflare account to continue.",
      );
    }
  }

  function wrapStatement(stmt: D1Statement, sql: string): D1Statement {
    return {
      bind(...values: unknown[]): D1Statement {
        return wrapStatement(stmt.bind(...values), sql);
      },
      async first<T = unknown>(): Promise<T | null> {
        await assertWithinStorageCap(sql);
        return stmt.first<T>();
      },
      async run(): Promise<D1Result> {
        await assertWithinStorageCap(sql);
        return stmt.run();
      },
      async all<T = unknown>(): Promise<D1Result<T>> {
        await assertWithinStorageCap(sql);
        return stmt.all<T>();
      },
    };
  }

  return {
    prepare(sql: string): D1Statement {
      return wrapStatement(underlyingDb.prepare(sql), sql);
    },
    exec: async (sql: string) => {
      await assertWithinStorageCap(sql);
      return underlyingDb.prepare(sql).run();
    },
    async batch<T = unknown>(statements: D1Statement[]): Promise<D1Result<T>[]> {
      const results: D1Result<T>[] = [];
      for (const s of statements) {
        results.push((await s.run()) as unknown as D1Result<T>);
      }
      return results;
    },
    getStorageStats: measureStorageStats,
    setSimulatedStorageStats(stats) {
      if (stats.totalRows !== undefined) simulatedRows = stats.totalRows;
      if (stats.totalBytes !== undefined) simulatedBytes = stats.totalBytes;
    },
  };
}

export interface SandboxOutboundRateLimiterOptions {
  maxRequestsPerMinute?: number;
  now?: () => number;
  baseFetch?: typeof fetch;
}

export function createSandboxOutboundFetch(options: {
  sandboxId: string;
  maxRequestsPerMinute?: number;
  now?: () => number;
  baseFetch?: typeof fetch;
  windowMap?: Map<string, number[]>;
}): typeof fetch {
  const limit = options.maxRequestsPerMinute ?? SANDBOX_OUTBOUND_RPM_LIMIT;
  const nowFn = options.now ?? (() => Date.now());
  const windowMap = options.windowMap ?? new Map<string, number[]>();
  const underlyingFetch =
    options.baseFetch ??
    (async (_input: Request | string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, sandboxOutbound: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

  return async (
    input: Request | string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const urlStr =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    const paymentAndSsrf = inspectOutboundPaymentAndSsrf(urlStr, init);
    if (paymentAndSsrf.blocked) {
      return paymentAndSsrf.error.toResponse();
    }

    const nowMs = nowFn();
    const cutoff = nowMs - 60_000;
    const prevTimestamps = windowMap.get(options.sandboxId) ?? [];
    const activeTimestamps = prevTimestamps.filter((ts) => ts > cutoff);
    if (activeTimestamps.length >= limit) {
      windowMap.set(options.sandboxId, activeTimestamps);
      const err = new SandboxGuardrailError(
        "SANDBOX_OUTBOUND_RATE_LIMITED",
        429,
        `Sandbox outbound request rate limit (${limit} requests/min) exceeded for "${options.sandboxId}".`,
      );
      return err.toResponse();
    }

    activeTimestamps.push(nowMs);
    windowMap.set(options.sandboxId, activeTimestamps);
    return underlyingFetch(input, init);
  };
}

export interface SandboxWorkerRecord {
  sandboxId: string;
  dispatchNamespace: string;
  projectId: string;
  versionId: string;
  buildHash: string;
  codeHash: string;
  graphHash: string;
  code: string;
  databaseId: string;
  databaseName: string;
  pxConnKey: string;
  telemetryHmacKey: string;
  secrets: Record<string, string>;
  cronTriggers: string[];
  queues: string[];
  workflows: Array<{ name: string; className: string }>;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  customHandler?: (
    request: Request,
    env: Record<string, unknown>,
  ) => Response | Promise<Response>;
}

export interface SandboxDatabaseRecord {
  uuid: string;
  name: string;
  sandboxId: string;
  appliedMigrations: Array<{
    name: string;
    sql: string;
    sha256: string;
    appliedAt: string;
  }>;
  /** Keyed by graph id for app-wide graphs, by `<workspace>:<id>` for any other workspace (storedGraphKey). */
  graphs: Record<string, { graph: string; updatedAt: string; workspaceId?: string }>;
  schedules: Array<Record<string, unknown>>;
  graphHash?: string;
  d1Binding: GuardedSandboxD1;
  rawD1: D1Like;
  createdAt: string;
}

/** How a stored graph is keyed in a database record: app-wide graphs by their id, a workspace's own as `<workspace>:<id>`. */
export function storedGraphKey(workspaceId: string, graphId: string): string {
  return workspaceId === APP_WORKSPACE ? graphId : `${workspaceId}:${graphId}`;
}

function createLightweightInMemoryD1(): D1Like {
  const tables = new Map<string, Array<Record<string, unknown>>>();
  const tableSchemas = new Map<
    string,
    Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>
  >();
  let simulatedPageCount = 4;
  const pageSize = 4096;

  function ensureTable(name: string, createSql?: string): Array<Record<string, unknown>> {
    let rows = tables.get(name);
    if (!rows) {
      rows = [];
      tables.set(name, rows);
    }
    if (createSql && !tableSchemas.has(name)) {
      const openIdx = createSql.indexOf("(");
      const closeIdx = createSql.lastIndexOf(")");
      if (openIdx >= 0 && closeIdx > openIdx) {
        const body = createSql.slice(openIdx + 1, closeIdx);
        const colDefs: Array<{
          cid: number;
          name: string;
          type: string;
          notnull: number;
          dflt_value: unknown;
          pk: number;
        }> = [];
        const lines = body.split(",\n").flatMap((part) => part.split(/,\s*(?=["`A-Za-z_])/));
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || /^(?:PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) {
            continue;
          }
          const colMatch = line.match(/^["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\s+([A-Za-z]+)/);
          if (colMatch) {
            const colName = colMatch[1]!;
            const colType = colMatch[2]!.toUpperCase();
            if (colDefs.some((c) => c.name === colName)) continue;
            colDefs.push({
              cid: colDefs.length,
              name: colName,
              type: colType,
              notnull: /\bNOT\s+NULL\b/i.test(line) ? 1 : 0,
              dflt_value: null,
              pk: /\bPRIMARY\s+KEY\b/i.test(line) || colName === "id" ? 1 : 0,
            });
          }
        }
        if (colDefs.length > 0) {
          tableSchemas.set(name, colDefs);
        }
      }
    }
    return rows;
  }

  function getTableInfo(name: string) {
    const schema = tableSchemas.get(name);
    const rows = tables.get(name) ?? [];
    const seen = new Map<
      string,
      {
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
        pk: number;
      }
    >();
    for (const c of schema ?? []) {
      seen.set(c.name, c);
    }
    for (const r of rows) {
      for (const [k, v] of Object.entries(r)) {
        if (!seen.has(k)) {
          seen.set(k, {
            cid: seen.size,
            name: k,
            type: typeof v === "number" ? "INTEGER" : "TEXT",
            notnull: k === "workspace_id" || k === "id" ? 1 : 0,
            dflt_value: null,
            pk: k === "id" ? 1 : 0,
          });
        }
      }
    }
    if (seen.size === 0 && name.startsWith("ent_")) {
      return [
        { cid: 0, name: "id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
        { cid: 1, name: "workspace_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 2, name: "title", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
        { cid: 3, name: "status", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
        { cid: 4, name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 5, name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      ];
    }
    return [...seen.values()];
  }

  function makeStatement(sql: string, bound: unknown[] = []): D1Statement {
    return {
      bind(...values: unknown[]): D1Statement {
        return makeStatement(sql, values);
      },
      async first<T = unknown>(): Promise<T | null> {
        const trimmed = sql.trim();
        if (/^PRAGMA\s+page_count/i.test(trimmed)) {
          return { page_count: simulatedPageCount } as unknown as T;
        }
        if (/^PRAGMA\s+page_size/i.test(trimmed)) {
          return { page_size: pageSize } as unknown as T;
        }
        if (/COUNT\(\*\)\s+AS\s+(?:cnt|total)/i.test(trimmed)) {
          const m = trimmed.match(/FROM\s+["`]?([A-Za-z0-9_]+)["`]?/i);
          const tbl = m?.[1] ?? "";
          let rows = tables.get(tbl) ?? [];
          if (/WHERE\s+["`]?workspace_id["`]?\s*=\s*\?(?:1)?/i.test(trimmed) && bound.length > 0) {
            rows = rows.filter((r) => r.workspace_id === bound[0]);
          }
          return { cnt: rows.length, total: rows.length } as unknown as T;
        }
        const allRes = await this.all<T>();
        return allRes.results[0] ?? null;
      },
      async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const trimmed = sql.trim();
        const createMatches = trimmed.matchAll(
          /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z0-9_]+)["`]?/gi,
        );
        for (const m of createMatches) {
          ensureTable(m[1]!, trimmed);
        }
        const dropMatches = trimmed.matchAll(
          /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?([A-Za-z0-9_]+)["`]?/gi,
        );
        for (const m of dropMatches) {
          tables.delete(m[1]!);
          tableSchemas.delete(m[1]!);
        }
        // A table rebuild: ALTER TABLE a RENAME TO b moves the rows and the schema.
        const renameMatch = trimmed.match(
          /^ALTER\s+TABLE\s+["`]?([A-Za-z0-9_]+)["`]?\s+RENAME\s+TO\s+["`]?([A-Za-z0-9_]+)["`]?/i,
        );
        if (renameMatch) {
          const [, from, to] = renameMatch as unknown as [string, string, string];
          tables.set(to, tables.get(from) ?? []);
          tables.delete(from);
          const schema = tableSchemas.get(from);
          tableSchemas.delete(from);
          if (schema) tableSchemas.set(to, schema);
          return { results: [], success: true, meta: { changes: 0 } };
        }
        // INSERT INTO t (c1, ...) SELECT e1, ... FROM src: each expression is a column of src or a quoted literal.
        const insertSelectMatch = trimmed.match(
          /^INSERT\s+(?:OR\s+REPLACE\s+|OR\s+IGNORE\s+)?INTO\s+["`]?([A-Za-z0-9_]+)["`]?\s*\(([^)]+)\)\s*SELECT\s+([\s\S]+?)\s+FROM\s+["`]?([A-Za-z0-9_]+)["`]?\s*;?$/i,
        );
        if (insertSelectMatch) {
          const [, tbl, colsRaw, exprsRaw, src] = insertSelectMatch as unknown as [string, string, string, string, string];
          const cols = colsRaw.split(",").map((c) => c.trim().replace(/^["`]|["`]$/g, ""));
          const exprs = exprsRaw.split(",").map((e) => e.trim());
          const list = ensureTable(tbl);
          for (const source of tables.get(src) ?? []) {
            const row: Record<string, unknown> = {};
            cols.forEach((col, i) => {
              const expr = exprs[i] ?? "NULL";
              row[col] = /^'.*'$/.test(expr) ? expr.slice(1, -1) : (source[expr.replace(/^["`]|["`]$/g, "")] ?? null);
            });
            list.push(row);
          }
          return { results: [], success: true, meta: { changes: (tables.get(src) ?? []).length } };
        }
        const insertMatch = trimmed.match(
          /^INSERT\s+(?:OR\s+REPLACE\s+|OR\s+IGNORE\s+)?INTO\s+["`]?([A-Za-z0-9_]+)["`]?\s*(?:\(([^)]+)\))?(?:\s+VALUES\s*\(([^)]*)\))?/i,
        );
        if (insertMatch) {
          const tbl = insertMatch[1]!;
          const colsRaw = insertMatch[2];
          const valsRaw = insertMatch[3];
          const cols = colsRaw
            ? colsRaw.split(",").map((c) => c.trim().replace(/^["`]|["`]$/g, ""))
            : ["id", "value"];
          const parsedLiterals =
            bound.length === 0 && valsRaw
              ? valsRaw.split(",").map((v) => {
                  const t = v.trim();
                  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
                    return t.slice(1, -1);
                  }
                  if (/^-?\d+(?:\.\d+)?$/.test(t)) {
                    return Number(t);
                  }
                  if (t.toUpperCase() === "NULL") return null;
                  return t;
                })
              : [];
          const row: Record<string, unknown> = {};
          cols.forEach((col, i) => {
            row[col] = bound[i] !== undefined ? bound[i] : (parsedLiterals[i] ?? null);
          });
          if (!row.created_at) row.created_at = new Date().toISOString();
          if (!row.updated_at) row.updated_at = new Date().toISOString();
          const list = ensureTable(tbl);
          if (row.id) {
            // the graph table is keyed (workspace_id, id); every other table here is keyed by id
            const existingIdx = list.findIndex((r) => r.id === row.id && (tbl !== GRAPH_TABLE || r.workspace_id === row.workspace_id));
            if (existingIdx >= 0) {
              list[existingIdx] = row;
            } else {
              list.push(row);
            }
          } else {
            list.push(row);
          }
          simulatedPageCount += 1;
        }
        const deleteMatch = trimmed.match(
          /^DELETE\s+FROM\s+["`]?([A-Za-z0-9_]+)["`]?/i,
        );
        if (deleteMatch) {
          const tbl = deleteMatch[1]!;
          if (/WHERE\s+["`]?id["`]?\s*=\s*\?/i.test(trimmed) && bound.length > 0) {
            const list = ensureTable(tbl);
            tables.set(
              tbl,
              list.filter((r) => r.id !== bound[0]),
            );
          } else {
            tables.set(tbl, []);
          }
        }
        return {
          results: [],
          success: true,
          meta: { changes: 1 },
        };
      },
      async all<T = unknown>(): Promise<D1Result<T>> {
        const trimmed = sql.trim();
        const pragmaInfoMatch = trimmed.match(/^PRAGMA\s+table_info\(["`']?([A-Za-z0-9_]+)["`']?\)/i);
        if (pragmaInfoMatch) {
          const tbl = pragmaInfoMatch[1]!;
          return {
            results: getTableInfo(tbl) as unknown as T[],
            success: true,
            meta: { changes: 0 },
          };
        }
        if (trimmed.includes("FROM sqlite_master")) {
          const results = [...tables.keys()]
            .filter((n) => !n.startsWith("sqlite_") && !n.startsWith("_cf_"))
            .map((name) => ({ name })) as unknown as T[];
          return { results, success: true, meta: { changes: 0 } };
        }
        const fromMatch = trimmed.match(/FROM\s+["`]?([A-Za-z0-9_]+)["`]?/i);
        if (fromMatch) {
          const tbl = fromMatch[1]!;
          let rows = [...(tables.get(tbl) ?? [])];
          if (/WHERE\s+["`]?workspace_id["`]?\s*=\s*\?(?:1)?/i.test(trimmed) && bound.length > 0) {
            rows = rows.filter((r) => r.workspace_id === bound[0]);
          }
          if (/WHERE\s+["`]?id["`]?\s*=\s*\?(?:1)?/i.test(trimmed) && bound.length > 0) {
            rows = rows.filter((r) => r.id === bound[0]);
          }
          if (
            /WHERE\s+["`]?workspace_id["`]?\s*=\s*\?1\s+AND\s+["`]?id["`]?\s*=\s*\?2/i.test(trimmed) &&
            bound.length >= 2
          ) {
            rows = rows.filter((r) => r.workspace_id === bound[0] && r.id === bound[1]);
          }
          // runStoredGraph: `id = ?1 AND workspace_id IN (?2, '__app__')`, the run's own row before the app-wide one
          if (/workspace_id\s+IN\s*\(\s*\?2\s*,\s*'([^']+)'\s*\)/i.test(trimmed) && bound.length >= 2) {
            const app = trimmed.match(/workspace_id\s+IN\s*\(\s*\?2\s*,\s*'([^']+)'\s*\)/i)![1];
            rows = rows
              .filter((r) => r.workspace_id === bound[1] || r.workspace_id === app)
              .sort((a, b) => (a.workspace_id === bound[1] ? 0 : 1) - (b.workspace_id === bound[1] ? 0 : 1));
          }
          return { results: rows as unknown as T[], success: true, meta: { changes: 0 } };
        }
        return { results: [], success: true, meta: { changes: 0 } };
      },
    };
  }

  return {
    prepare(sql: string): D1Statement {
      return makeStatement(sql);
    },
    exec: async (sql: string) => makeStatement(sql).run(),
    async batch<T = unknown>(statements: D1Statement[]): Promise<D1Result<T>[]> {
      const out: D1Result<T>[] = [];
      for (const s of statements) {
        out.push((await s.run()) as unknown as D1Result<T>);
      }
      return out;
    },
  };
}

export interface DispatchWorkerStub {
  fetch(request: Request): Promise<Response>;
}

export interface DispatchNamespaceBinding {
  get(sandboxId: string): DispatchWorkerStub;
}

function randomKeyHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class SandboxDispatchPlatform {
  private readonly workers = new Map<string, SandboxWorkerRecord>();
  private readonly databases = new Map<string, SandboxDatabaseRecord>();
  private readonly dailyRequestCounts = new Map<string, number>();
  private readonly outboundWindowMap = new Map<string, number[]>();
  private readonly telemetryBuffer = new Map<string, Array<Record<string, unknown>>>();
  private versionCounter = 1;
  private mutatingOps = 0;
  private nowFn: () => number;
  private createD1Factory: (sandboxId: string, dbName: string) => D1Like;
  private dailyLimit: number;
  private outboundRpmLimit: number;
  private maxRows: number;
  private maxBytes: number;
  private studioEventsSink?: (
    sandboxId: string,
    request: Request,
  ) => Response | Promise<Response>;

  constructor(options?: {
    now?: () => number;
    createD1?: (sandboxId: string, dbName: string) => D1Like;
    dailyRequestLimit?: number;
    outboundRpmLimit?: number;
    maxD1Rows?: number;
    maxD1Bytes?: number;
    studioEventsSink?: (
      sandboxId: string,
      request: Request,
    ) => Response | Promise<Response>;
  }) {
    this.nowFn = options?.now ?? (() => Date.now());
    this.createD1Factory =
      options?.createD1 ?? (() => createLightweightInMemoryD1());
    this.dailyLimit = options?.dailyRequestLimit ?? SANDBOX_DAILY_REQUEST_LIMIT;
    this.outboundRpmLimit =
      options?.outboundRpmLimit ?? SANDBOX_OUTBOUND_RPM_LIMIT;
    this.maxRows = options?.maxD1Rows ?? SANDBOX_D1_MAX_ROWS;
    this.maxBytes = options?.maxD1Bytes ?? SANDBOX_D1_MAX_BYTES;
    this.studioEventsSink = options?.studioEventsSink;
  }

  get mutatingCallCount(): number {
    return this.mutatingOps;
  }

  setNow(now: () => number): void {
    this.nowFn = now;
  }

  advanceTimeMs(deltaMs: number): void {
    const base = this.nowFn();
    this.nowFn = () => base + deltaMs;
  }

  now(): number {
    return this.nowFn();
  }

  private utcDayKey(sandboxId: string, nowMs?: number): string {
    const day = new Date(nowMs ?? this.nowFn()).toISOString().slice(0, 10);
    return `${sandboxId}:${day}`;
  }

  getDailyRequestsUsed(sandboxId: string, nowMs?: number): number {
    return this.dailyRequestCounts.get(this.utcDayKey(sandboxId, nowMs)) ?? 0;
  }

  getDailyRequestCount(sandboxId: string, nowMs?: number): number {
    return this.getDailyRequestsUsed(sandboxId, nowMs);
  }

  setDailyRequestsUsed(sandboxId: string, count: number, nowMs?: number): void {
    this.dailyRequestCounts.set(this.utcDayKey(sandboxId, nowMs), count);
  }

  setDailyRequestCount(sandboxId: string, count: number, nowMs?: number): void {
    this.setDailyRequestsUsed(sandboxId, count, nowMs);
  }

  incrementDailyRequests(sandboxId: string, nowMs?: number): number {
    const key = this.utcDayKey(sandboxId, nowMs);
    const next = (this.dailyRequestCounts.get(key) ?? 0) + 1;
    this.dailyRequestCounts.set(key, next);
    return next;
  }

  listActiveSandboxes(): SandboxWorkerRecord[] {
    return [...this.workers.values()];
  }

  getSandbox(sandboxId: string): {
    worker: SandboxWorkerRecord | null;
    d1: SandboxDatabaseRecord | null;
  } | null {
    const worker = this.findWorkerBySandboxId(sandboxId);
    const d1 = this.getDatabase(sandboxId);
    if (!worker && !d1) {
      return null;
    }
    return { worker, d1 };
  }

  getWorker(
    dispatchNamespace: string,
    sandboxId: string,
  ): SandboxWorkerRecord | null {
    return this.workers.get(`${dispatchNamespace}:${sandboxId}`) ?? null;
  }

  findWorkerBySandboxId(sandboxId: string): SandboxWorkerRecord | null {
    for (const w of this.workers.values()) {
      if (w.sandboxId === sandboxId) {
        return w;
      }
    }
    return null;
  }

  getDatabase(sandboxIdOrDbName: string): SandboxDatabaseRecord | null {
    const normalized = sandboxIdOrDbName.startsWith("px_sbx_")
      ? sandboxIdOrDbName
      : `px_sbx_${sandboxIdOrDbName}`;
    return this.databases.get(normalized) ?? null;
  }

  async ensureDatabase(sandboxId: string): Promise<SandboxDatabaseRecord> {
    const dbName = `px_sbx_${sandboxId}`;
    const existing = this.databases.get(dbName);
    if (existing) {
      return existing;
    }
    this.mutatingOps += 1;
    const rawD1 = this.createD1Factory(sandboxId, dbName);
    // Telemetry first: its px_steps view reads px_step_events, and SQLite's ALTER TABLE ... RENAME in 9002 refuses to run
    // while any view in the schema points at a table that is missing (a reused database can keep the view, not the table).
    await rawD1.prepare(TELEMETRY_MIGRATION.sql).run();
    // 9000 then 9002, statement by statement, so a fresh sandbox database ends where an upgraded one does. These are not
    // recorded anywhere, so a reused database is read first: only what its graph table still lacks is applied.
    const graphColumns = ((await rawD1.prepare(`PRAGMA table_info(${GRAPH_TABLE})`).all<{ name: string }>()).results ?? []).map((c) => c.name);
    const pendingGraphMigrations = graphColumns.includes("workspace_id")
      ? []
      : graphColumns.length > 0
        ? GRAPH_MIGRATIONS.slice(1)
        : GRAPH_MIGRATIONS;
    for (const migration of pendingGraphMigrations) await applyMigration(rawD1, migration.sql);
    const guarded = wrapSandboxD1WithStorageCap(rawD1, {
      maxRows: this.maxRows,
      maxBytes: this.maxBytes,
    });
    const record: SandboxDatabaseRecord = {
      uuid: `d1_${dbName}`,
      name: dbName,
      sandboxId,
      appliedMigrations: [],
      graphs: {},
      schedules: [],
      d1Binding: guarded,
      rawD1,
      createdAt: new Date(this.nowFn()).toISOString(),
    };
    this.databases.set(dbName, record);
    return record;
  }

  async applyMigration(
    sandboxId: string,
    migration: { name: string; sql: string; sha256: string },
  ): Promise<void> {
    const db = await this.ensureDatabase(sandboxId);
    if (db.appliedMigrations.some((m) => m.name === migration.name)) {
      return;
    }
    this.mutatingOps += 1;
    await db.rawD1.prepare(migration.sql).run();
    db.appliedMigrations.push({
      name: migration.name,
      sql: migration.sql,
      sha256: migration.sha256,
      appliedAt: new Date(this.nowFn()).toISOString(),
    });
  }

  /** Stores a graph row for one workspace. The Studio deploy path writes app-wide graphs, under APP_WORKSPACE. */
  async putStoredGraph(
    sandboxId: string,
    workspaceId: string,
    graphId: string,
    graphJson: string,
    graphHash?: string,
  ): Promise<{ graphId: string; updatedAt: string }> {
    const db = await this.ensureDatabase(sandboxId);
    this.mutatingOps += 1;
    const updatedAt = new Date(this.nowFn()).toISOString();
    db.graphs[storedGraphKey(workspaceId, graphId)] = { graph: graphJson, updatedAt, workspaceId };
    if (graphHash !== undefined) {
      db.graphHash = graphHash;
    }
    await db.rawD1
      .prepare(
        `INSERT OR REPLACE INTO ${GRAPH_TABLE} (workspace_id, id, graph, updated_at) VALUES (?1, ?2, ?3, ?4)`,
      )
      .bind(workspaceId, graphId, graphJson, updatedAt)
      .run();
    return { graphId, updatedAt };
  }

  async putScheduleRows(
    sandboxId: string,
    schedules: Array<Record<string, unknown>>,
  ): Promise<{ count: number; updatedAt: string }> {
    const db = await this.ensureDatabase(sandboxId);
    this.mutatingOps += 1;
    db.schedules = [...schedules];
    return {
      count: schedules.length,
      updatedAt: new Date(this.nowFn()).toISOString(),
    };
  }

  async putWorker(input: {
    dispatchNamespace: string;
    sandboxId: string;
    projectId: string;
    code: string;
    buildHash: string;
    codeHash: string;
    graphHash: string;
    cronTriggers?: string[];
    queues?: string[];
    workflows?: Array<{ name: string; className: string }>;
    secrets?: Record<string, string>;
    customHandler?: SandboxWorkerRecord["customHandler"];
  }): Promise<SandboxWorkerRecord> {
    for (const [secName, secVal] of Object.entries(input.secrets ?? {})) {
      assertNoLivePaymentCredential(secName, secVal);
    }
    const db = await this.ensureDatabase(input.sandboxId);
    this.mutatingOps += 1;
    const key = `${input.dispatchNamespace}:${input.sandboxId}`;
    const existing = this.workers.get(key);
    const nowIso = new Date(this.nowFn()).toISOString();
    const createdAt = existing?.createdAt ?? nowIso;
    const expiresAt =
      existing?.expiresAt ??
      new Date(Date.parse(createdAt) + SANDBOX_TTL_MS).toISOString();
    const versionId = `sbx_ver_${this.versionCounter++}_${input.codeHash.slice(0, 8)}`;

    const record: SandboxWorkerRecord = {
      sandboxId: input.sandboxId,
      dispatchNamespace: input.dispatchNamespace,
      projectId: input.projectId,
      versionId,
      buildHash: input.buildHash,
      codeHash: input.codeHash,
      graphHash: input.graphHash,
      code: input.code,
      databaseId: db.uuid,
      databaseName: db.name,
      // Fresh random keys per sandbox: deriving them from the (public) sandbox id would let anyone compute them.
      pxConnKey: existing?.pxConnKey ?? `px_conn_key_${randomKeyHex()}`,
      telemetryHmacKey:
        existing?.telemetryHmacKey ?? `px_telemetry_hmac_${randomKeyHex()}`,
      secrets: {
        ...(existing?.secrets ?? {}),
        ...(input.secrets ?? {}),
      },
      cronTriggers: input.cronTriggers ?? existing?.cronTriggers ?? [],
      queues: input.queues ?? existing?.queues ?? [],
      workflows: input.workflows ?? existing?.workflows ?? [],
      createdAt,
      updatedAt: nowIso,
      expiresAt,
      customHandler: input.customHandler ?? existing?.customHandler,
    };
    this.workers.set(key, record);
    return record;
  }

  putSecret(
    dispatchNamespace: string,
    sandboxId: string,
    secretName: string,
    secretValue: string,
  ): SandboxWorkerRecord {
    assertNoLivePaymentCredential(secretName, secretValue);
    const key = `${dispatchNamespace}:${sandboxId}`;
    const existing = this.workers.get(key);
    if (!existing) {
      throw new Error(
        `Sandbox worker "${sandboxId}" not found in dispatch namespace "${dispatchNamespace}".`,
      );
    }
    this.mutatingOps += 1;
    existing.secrets[secretName] = secretValue;
    existing.updatedAt = new Date(this.nowFn()).toISOString();
    return existing;
  }

  destroySandbox(
    dispatchNamespace: string,
    sandboxId: string,
  ): { removedWorker: boolean; removedDatabase: boolean } {
    const key = `${dispatchNamespace}:${sandboxId}`;
    const hadWorker = this.workers.delete(key);
    const dbName = `px_sbx_${sandboxId}`;
    const hadDb = this.databases.delete(dbName);
    this.telemetryBuffer.delete(sandboxId);
    if (hadWorker || hadDb) {
      this.mutatingOps += 1;
    }
    return { removedWorker: hadWorker, removedDatabase: hadDb };
  }

  createOutboundFetchForSandbox(
    sandboxId: string,
    baseFetch?: typeof fetch,
  ): typeof fetch {
    return createSandboxOutboundFetch({
      sandboxId,
      maxRequestsPerMinute: this.outboundRpmLimit,
      now: () => this.nowFn(),
      baseFetch,
      windowMap: this.outboundWindowMap,
    });
  }

  createDispatchNamespaceBinding(
    dispatchNamespace: string = DEFAULT_SANDBOX_DISPATCH_NAMESPACE,
  ): DispatchNamespaceBinding {
    return {
      get: (sandboxId: string): DispatchWorkerStub => {
        const worker = this.getWorker(dispatchNamespace, sandboxId);
        if (!worker) {
          throw new SandboxGuardrailError(
            "SANDBOX_NOT_FOUND",
            404,
            `Sandbox worker "${sandboxId}" is not deployed in namespace "${dispatchNamespace}".`,
          );
        }
        const db = this.getDatabase(sandboxId);
        const outboundFetch = this.createOutboundFetchForSandbox(sandboxId);
        return {
          fetch: async (request: Request): Promise<Response> => {
            const url = new URL(request.url);
            const envBindings: Record<string, unknown> = {
              DB: db?.d1Binding,
              PX_CONN_KEY: worker.pxConnKey,
              PX_TELEMETRY_HMAC_KEY: worker.telemetryHmacKey,
              SANDBOX_FETCH: outboundFetch,
              ...worker.secrets,
            };

            if (worker.customHandler) {
              return worker.customHandler(request, envBindings);
            }

            if (url.pathname === "/__px/health" || url.pathname === "/health") {
              return new Response(
                JSON.stringify({
                  ok: true,
                  sandboxId: worker.sandboxId,
                  projectId: worker.projectId,
                  buildHash: worker.buildHash,
                  versionId: worker.versionId,
                  databaseName: worker.databaseName,
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              );
            }

            if (url.pathname === "/openapi.json") {
              return new Response(
                JSON.stringify({
                  openapi: "3.1.0",
                  info: { title: worker.projectId, version: "0.0.0" },
                  paths: {},
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              );
            }

            if (url.pathname === "/__px/graphs") {
              return new Response(
                JSON.stringify({
                  ok: true,
                  sandboxId: worker.sandboxId,
                  graphHash: db?.graphHash ?? worker.graphHash,
                  graphs: db?.graphs ?? {},
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              );
            }

            if (url.pathname.startsWith("/data/") && db) {
              const tableName = url.pathname
                .slice("/data/".length)
                .replace(/[^A-Za-z0-9_]/g, "");
              if (tableName) {
                try {
                  if (request.method === "POST" || request.method === "PUT") {
                    const body = (await request.json().catch(() => ({}))) as Record<
                      string,
                      unknown
                    >;
                    const cols = Object.keys(body);
                    const vals = Object.values(body);
                    const placeholders = cols.map(() => "?").join(", ");
                    await db.d1Binding
                      .prepare(
                        `INSERT INTO "${tableName}" (${cols.join(", ")}) VALUES (${placeholders})`,
                      )
                      .bind(...vals)
                      .run();
                    return new Response(
                      JSON.stringify({ ok: true, table: tableName, inserted: true }),
                      {
                        status: 201,
                        headers: { "content-type": "application/json" },
                      },
                    );
                  }
                  if (request.method === "DELETE") {
                    await db.d1Binding
                      .prepare(`DELETE FROM "${tableName}"`)
                      .run();
                    return new Response(
                      JSON.stringify({ ok: true, table: tableName, deleted: true }),
                      {
                        status: 200,
                        headers: { "content-type": "application/json" },
                      },
                    );
                  }
                  const rowsRes = await db.d1Binding
                    .prepare(`SELECT * FROM "${tableName}"`)
                    .all();
                  return new Response(
                    JSON.stringify({
                      ok: true,
                      table: tableName,
                      rows: rowsRes.results,
                    }),
                    {
                      status: 200,
                      headers: { "content-type": "application/json" },
                    },
                  );
                } catch (err) {
                  if (err instanceof SandboxGuardrailError) {
                    return err.toResponse();
                  }
                  throw err;
                }
              }
            }

            return new Response(
              JSON.stringify({
                ok: true,
                sandboxId: worker.sandboxId,
                projectId: worker.projectId,
                buildHash: worker.buildHash,
                versionId: worker.versionId,
                path: url.pathname,
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            );
          },
        };
      },
    };
  }

  async dispatchRequest(
    request: Request,
    options?:
      | number
      | {
          dispatchNamespace?: string;
          now?: number;
          studioEventsHandler?: (
            sandboxId: string,
            request: Request,
          ) => Response | Promise<Response>;
        },
  ): Promise<Response> {
    const opts =
      typeof options === "object" && options !== null ? options : undefined;
    const explicitNamespace = opts?.dispatchNamespace;
    const sandboxId = extractSandboxIdFromRequest(request);
    if (!sandboxId) {
      return new Response(
        JSON.stringify({
          error: {
            code: "SANDBOX_NOT_FOUND",
            message:
              "Could not resolve sandboxId from hostname (<sandboxId>.sandbox.projectx.dev) or x-px-sandbox-id header.",
          },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }

    const worker = explicitNamespace
      ? this.getWorker(explicitNamespace, sandboxId)
      : (this.getWorker(DEFAULT_SANDBOX_DISPATCH_NAMESPACE, sandboxId) ??
        this.getSandbox(sandboxId)?.worker ??
        null);
    if (!worker) {
      return new SandboxGuardrailError(
        "SANDBOX_NOT_FOUND",
        404,
        `Sandbox "${sandboxId}" is not deployed or has been destroyed.`,
      ).toResponse();
    }
    const namespace =
      worker.dispatchNamespace ||
      explicitNamespace ||
      DEFAULT_SANDBOX_DISPATCH_NAMESPACE;

    // Check 7-day TTL expiry first (Story 9.2 AC 3)
    const nowMs =
      typeof options === "number"
        ? options
        : typeof opts?.now === "number"
          ? opts.now
          : this.nowFn();
    if (nowMs >= Date.parse(worker.expiresAt)) {
      return new SandboxGuardrailError(
        "SANDBOX_EXPIRED",
        410,
        "This 7-day preview sandbox has expired. Re-deploy or move to your Cloudflare account in ProjectX Studio.",
      ).toResponse();
    }

    // Check daily request quota (10,000 req/day) (Story 9.2 AC 1)
    const count = this.incrementDailyRequests(sandboxId, nowMs);
    if (count > this.dailyLimit) {
      return new SandboxGuardrailError(
        "SANDBOX_QUOTA_EXCEEDED",
        429,
        "Daily sandbox limit (10,000 requests) reached. Move to your Cloudflare account for unlimited BYOC traffic.",
      ).toResponse();
    }

    const url = new URL(request.url);
    if (url.pathname === "/__px/events" || url.pathname.startsWith("/__px/events/")) {
      const sink = opts?.studioEventsHandler ?? this.studioEventsSink;
      if (sink) {
        const forwardedHeaders = new Headers(request.headers);
        forwardedHeaders.set("x-px-sandbox-id", sandboxId);
        forwardedHeaders.set(
          "x-px-telemetry-hmac-Present",
          worker.telemetryHmacKey ? "1" : "0",
        );
        const forwardedReq = new Request(request.url, {
          method: request.method,
          headers: forwardedHeaders,
          body:
            request.method !== "GET" && request.method !== "HEAD"
              ? await request.clone().text()
              : undefined,
        });
        return sink(sandboxId, forwardedReq);
      }
      if (request.method === "POST") {
        const payload = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        const list = this.telemetryBuffer.get(sandboxId) ?? [];
        list.push(payload);
        this.telemetryBuffer.set(sandboxId, list);
        return new Response(
          JSON.stringify({
            ok: true,
            sandboxId,
            forwardedToStudioApi: true,
            bufferedEvents: list.length,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          sandboxId,
          events: this.telemetryBuffer.get(sandboxId) ?? [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const binding = this.createDispatchNamespaceBinding(namespace);
    const stub = binding.get(sandboxId);
    return stub.fetch(request);
  }
}

export function extractSandboxIdFromRequest(request: Request): string | null {
  const headerId = request.headers.get("x-px-sandbox-id")?.trim();
  if (headerId) {
    return headerId.toLowerCase();
  }
  try {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const suffix = ".sandbox.projectx.dev";
    if (host.endsWith(suffix)) {
      const sub = host.slice(0, -suffix.length);
      if (sub && !sub.includes(".")) {
        return sub;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export interface SandboxDispatcherEnv {
  DISPATCH_NAMESPACE?: DispatchNamespaceBinding;
  SANDBOX_PLATFORM?: SandboxDispatchPlatform;
  STUDIO_API_ORIGIN?: string;
}

export interface SandboxDispatcherOptions {
  platform?: SandboxDispatchPlatform;
  now?: () => number;
}

export function createSandboxDispatcher(
  platformOrOptions:
    | SandboxDispatchPlatform
    | SandboxDispatcherOptions = defaultSandboxDispatchPlatform,
) {
  const isPlatformInstance =
    platformOrOptions instanceof SandboxDispatchPlatform ||
    typeof (platformOrOptions as SandboxDispatchPlatform)?.dispatchRequest ===
      "function";
  const resolvedPlatform = isPlatformInstance
    ? (platformOrOptions as SandboxDispatchPlatform)
    : ((platformOrOptions as SandboxDispatcherOptions)?.platform ??
      defaultSandboxDispatchPlatform);
  const nowFn = !isPlatformInstance
    ? (platformOrOptions as SandboxDispatcherOptions)?.now
    : undefined;

  return {
    async fetch(
      request: Request,
      env?: SandboxDispatcherEnv,
    ): Promise<Response> {
      const activePlatform = env?.SANDBOX_PLATFORM ?? resolvedPlatform;
      if (env?.DISPATCH_NAMESPACE && !env?.SANDBOX_PLATFORM) {
        const sandboxId = extractSandboxIdFromRequest(request);
        if (!sandboxId) {
          return new SandboxGuardrailError(
            "SANDBOX_NOT_FOUND",
            404,
            "Missing sandboxId in hostname or x-px-sandbox-id header.",
          ).toResponse();
        }
        try {
          const stub = env.DISPATCH_NAMESPACE.get(sandboxId);
          return await stub.fetch(request);
        } catch (err) {
          if (err instanceof SandboxGuardrailError) {
            return err.toResponse();
          }
          return new SandboxGuardrailError(
            "SANDBOX_NOT_FOUND",
            404,
            err instanceof Error ? err.message : "Sandbox worker not found",
          ).toResponse();
        }
      }
      return activePlatform.dispatchRequest(
        request,
        nowFn ? nowFn() : undefined,
      );
    },
  };
}

export const defaultSandboxDispatchPlatform = new SandboxDispatchPlatform();

export default createSandboxDispatcher(defaultSandboxDispatchPlatform);
