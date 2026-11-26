import { createRedactor } from "./redact.ts";
import type { Credentials } from "./credentials.ts";

// A small client for the parts of Cloudflare's REST API this proof uses. It takes `fetch` as an argument, so the same code
// talks to the real API, to the fake in the tests, and to nothing at all in a unit test.
//
// What it guarantees:
// - the token goes only in the Authorization header of a request to the API's own address;
// - every call is written to a log (method, path with the account id hidden, status, time) with no header and no body;
// - every error message and every stored body has the token and the account id hidden;
// - a failure is one of three kinds, so a caller can tell Cloudflare refusing a request (an HTTP answer carrying errors)
//   from the network failing from an answer that is not what the API documents.

export const API_BASE = "https://api.cloudflare.com/client/v4";

export type Outcome = "ok" | "api_error" | "network_error" | "malformed";
export interface CallRecord {
  n: number;
  /** Milliseconds since the client was created. */
  atMs: number;
  method: string;
  /** The path with the account id replaced by {account}. */
  path: string;
  status: number | null;
  ms: number;
  outcome: Outcome;
  /** For a D1 query: whether the SQL only reads. Lets a reader tell a read-only POST from a write without trusting the caller. */
  sqlKind?: "select" | "write";
  /** Cloudflare's error codes, when it refused. */
  errorCodes?: number[];
  attempt: number;
}

export class CloudflareApiError extends Error {
  readonly kind = "api_error" as const;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly codes: number[];
  readonly details: string[];
  /** The answer's body with secrets hidden, kept so a refusal can be shown to the owner exactly as Cloudflare gave it. */
  readonly body: string;
  constructor(method: string, path: string, status: number, codes: number[], details: string[], body: string) {
    super(`Cloudflare refused ${method} ${path}: HTTP ${status}${codes.length ? `, code ${codes.join(", ")}` : ""}${details.length ? `: ${details.join("; ")}` : ""}`);
    this.name = "CloudflareApiError";
    this.method = method;
    this.path = path;
    this.status = status;
    this.codes = codes;
    this.details = details;
    this.body = body;
  }
}
export class CloudflareNetworkError extends Error {
  readonly kind = "network_error" as const;
  readonly method: string;
  readonly path: string;
  constructor(method: string, path: string, reason: string) {
    super(`could not reach Cloudflare for ${method} ${path}: ${reason}`);
    this.name = "CloudflareNetworkError";
    this.method = method;
    this.path = path;
  }
}
export class CloudflareMalformedError extends Error {
  readonly kind = "malformed" as const;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  constructor(method: string, path: string, status: number, reason: string) {
    super(`Cloudflare's answer to ${method} ${path} (HTTP ${status}) was not what the API documents: ${reason}`);
    this.name = "CloudflareMalformedError";
    this.method = method;
    this.path = path;
    this.status = status;
  }
}
/**
 * A request a caller's own guard refused before it was sent (the live proof's write guard). Never a network failure: the
 * client rethrows it unchanged, with no retry, so it is reported as a refusal, not as Cloudflare being unreachable.
 */
export class RequestGuardError extends Error {
  readonly code = "GUARD_REFUSED" as const;
  constructor(message: string) {
    super(message);
    this.name = "RequestGuardError";
  }
}

export type CloudflareError = CloudflareApiError | CloudflareNetworkError | CloudflareMalformedError;
export const isCloudflareError = (e: unknown): e is CloudflareError => e instanceof CloudflareApiError || e instanceof CloudflareNetworkError || e instanceof CloudflareMalformedError;

/**
 * Cloudflare's documented limit is 1,200 API requests per five minutes per user/account. The budget is set below it so a
 * burst from Studio, a proof script and the dashboard together still fits. Every attempt (a retry included) takes a token.
 */
export const CLOUDFLARE_REQUESTS_PER_WINDOW = 1_200;
export const REQUEST_BUDGET_WINDOW_MS = 5 * 60 * 1000;
export const DEFAULT_REQUEST_BUDGET = 1_100;

/** A token bucket: `limit` requests per `windowMs`, refilled continuously. `take()` waits for a token instead of failing. */
export interface RequestBudget {
  readonly limit: number;
  readonly windowMs: number;
  /** Resolves when a request may be sent; never rejects. */
  take(): Promise<void>;
  /** Tokens left right now (fractional while refilling). */
  available(): number;
  /** How long `take()` has waited in total, in milliseconds. */
  waitedMs(): number;
}

export function createRequestBudget(options: { limit?: number; windowMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): RequestBudget {
  const limit = options.limit ?? DEFAULT_REQUEST_BUDGET;
  const windowMs = options.windowMs ?? REQUEST_BUDGET_WINDOW_MS;
  if (!(limit > 0) || !(windowMs > 0)) throw new Error("a request budget needs a positive limit and window");
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const perMs = limit / windowMs;
  let tokens = limit;
  let last = now();
  let waited = 0;
  // Requests queue in order, so a waiting request is not overtaken by a later one.
  let queue: Promise<void> = Promise.resolve();
  const refill = () => {
    const t = now();
    if (t > last) {
      tokens = Math.min(limit, tokens + (t - last) * perMs);
      last = t;
    }
  };
  const takeOne = async () => {
    for (;;) {
      refill();
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      const wait = Math.max(1, Math.ceil((1 - tokens) / perMs));
      waited += wait;
      const before = now();
      await sleep(wait);
      // A clock that did not move during the wait (a test's frozen clock) is credited with the wait, so the loop always ends.
      if (now() <= before) tokens = Math.min(limit, tokens + wait * perMs);
    }
  };
  return {
    limit,
    windowMs,
    take() {
      const next = queue.then(takeOne);
      queue = next.catch(() => {});
      return next;
    },
    available() {
      refill();
      return tokens;
    },
    waitedMs: () => waited,
  };
}

/** How many accounts' budgets one process keeps; the least recently used is dropped beyond this. */
export const SHARED_BUDGET_ACCOUNTS = 256;
const sharedBudgets = new Map<string, RequestBudget>();
/**
 * The budget for one account, shared by every client this PROCESS makes for it (Studio's per-deploy clients, a proof script).
 * It is per process and per account, not per user: Cloudflare counts per user, so a token used from two processes, or two
 * accounts reached with one user's tokens, are not summed here; the 100-request margin below 1,200 is for that. The map is an
 * LRU of SHARED_BUDGET_ACCOUNTS entries, so it cannot grow without bound. Real clock and real waits; a test passes its own
 * budget to createClient instead.
 */
export function sharedRequestBudget(accountId: string): RequestBudget {
  const key = accountId.trim().toLowerCase();
  let budget = sharedBudgets.get(key);
  if (budget) {
    sharedBudgets.delete(key); // re-inserted below: most recently used last
  } else {
    budget = createRequestBudget();
  }
  sharedBudgets.set(key, budget);
  while (sharedBudgets.size > SHARED_BUDGET_ACCOUNTS) sharedBudgets.delete(sharedBudgets.keys().next().value!);
  return budget;
}
export const sharedBudgetCount = (): number => sharedBudgets.size;

export interface ClientOptions {
  credentials: Credentials;
  fetch: (request: Request) => Promise<Response>;
  /** Waits; replaced in tests so a retry costs no time. */
  sleep?: (ms: number) => Promise<void>;
  /** A clock in milliseconds; replaced in tests. */
  now?: () => number;
  /** Extra values to hide, for example the deploy's access key. */
  alsoHide?: string[];
  base?: string;
  /** The request budget every attempt draws from. Default: one of its own (1,100 per five minutes) on this client's clock and sleep. */
  budget?: RequestBudget;
  /** Called with every call record as it is made (a per-deploy recorder), besides this client's own log. */
  onCall?: (record: CallRecord) => void;
}

/** Results per page asked of Cloudflare's list endpoints. The page / per_page parameters are not yet checked against the live API for /workers/scripts, /queues and /workflows. */
export const LIST_PAGE_SIZE = 100;
/** A list longer than this many pages is refused rather than read forever. */
const MAX_LIST_PAGES = 200;

const readOnly = (sql: string) => /^\s*select\b/i.test(sql);
export const sqlKindOf = (statements: Array<{ sql: string }>): "select" | "write" => (statements.every((s) => readOnly(s.sql)) ? "select" : "write");

export interface Client {
  readonly calls: readonly CallRecord[];
  /** Hides the token, the account id and anything given in `alsoHide` in a piece of text. */
  hide(text: string): string;

  /**
   * Verifies the token. Cloudflare has account-owned tokens (verified at /accounts/{id}/tokens/verify) and user tokens (made
   * under My Profile, verified at /user/tokens/verify; the account endpoint answers 1000 "Invalid API Token" for them). The
   * account endpoint is tried first; on a 401 or code 1000 the user endpoint is tried. `kind` says which one answered. A
   * token both endpoints refuse throws the account endpoint's refusal.
   */
  verifyToken(): Promise<{ status: string; id?: string; expiresOn?: string; kind: "account" | "user" }>;
  /** The permission group names in the token's own policies. Needs a permission the token may lack: expect a refusal. */
  getTokenPermissions(tokenId: string): Promise<string[]>;
  getAccountSubdomain(): Promise<string | null>;

  listDatabases(name?: string): Promise<Array<{ uuid: string; name: string }>>;
  /** One database by its uuid (the live name, read before acting on a database named only by id). */
  getDatabase(id: string): Promise<{ uuid: string; name: string }>;
  createDatabase(name: string): Promise<{ uuid: string; name: string }>;
  deleteDatabase(id: string): Promise<void>;
  /** One statement list sent as one atomic batch. */
  queryDatabase(id: string, statements: Array<{ sql: string; params?: unknown[] }>): Promise<Array<{ results: Record<string, unknown>[]; meta: Record<string, unknown> }>>;
  /** Retrieves a D1 Time Travel bookmark for the database, optionally for a specific timestamp. */
  getD1Bookmark(databaseId: string, timestamp?: string): Promise<string>;
  /** Restores a D1 database to a previous bookmark, returning the bookmark of the state before restoration. */
  restoreD1(databaseId: string, bookmark: string): Promise<{ previous_bookmark: string }>;

  listScripts(): Promise<string[]>;
  uploadScript(name: string, upload: { mainModule: string; code: string; metadata: Record<string, unknown> }): Promise<{ etag?: string; startupTimeMs?: number }>;
  uploadVersion(name: string, upload: { mainModule: string; code: string; metadata: Record<string, unknown> }): Promise<{ id: string; number?: number }>;
  createDeployment(name: string, versions: Array<{ versionId: string; percentage: number }>): Promise<{ id?: string; created_on?: string; versions: Array<{ versionId: string; percentage: number }> }>;
  listDeployments(name: string): Promise<Array<{ id: string; created_on?: string; versions: Array<{ versionId: string; percentage: number }> }> | null>;
  fetchWithVersionOverride(url: string, name: string, versionId: string, init?: RequestInit): Promise<Response>;
  deleteScript(name: string): Promise<void>;
  /** Every version, newest first, read page by page. `annotations` is the version's own, from whichever shape the list gives (see getVersion). */
  listVersions(name: string): Promise<Array<{ id: string; number?: number; metadata?: Record<string, unknown>; annotations?: Record<string, unknown> }> | null>;
  /** One version's detail (GET /workers/scripts/{n}/versions/{id}); null if there is none. Not yet checked against the live API. */
  getVersion(name: string, versionId: string): Promise<{ id: string; metadata?: Record<string, unknown>; annotations?: Record<string, unknown> } | null>;
  /** The Worker's bindings as Cloudflare reports them (type and name; a Workflow's name and class), or null if there is no such Worker. Never returns a secret. */
  getScriptBindings(name: string): Promise<Array<{ type: string; name: string; workflowName?: string; className?: string }> | null>;
  getScriptSubdomain(name: string): Promise<{ enabled: boolean } | null>;
  setScriptSubdomain(name: string, enabled: boolean): Promise<void>;

  /** The account's own record (GET /accounts/{id}); needs Account Settings Read. */
  getAccount(): Promise<{ id: string; name: string }>;
  /** Sets one secret on a Worker without uploading code (PUT /workers/scripts/{n}/secrets). The value never enters the call log. */
  putScriptSecret(name: string, secretName: string, value: string): Promise<{ versionId?: string }>;
  /** Removes one secret from a Worker (DELETE /workers/scripts/{n}/secrets/{name}). Not yet checked against the live API. */
  deleteScriptSecret(name: string, secretName: string): Promise<void>;
  /** The Worker's Cron Triggers, or null if there is no such Worker. */
  getSchedules(name: string): Promise<string[] | null>;
  /** Replaces the Worker's Cron Triggers (PUT /workers/scripts/{n}/schedules). */
  putSchedules(name: string, crons: string[]): Promise<string[]>;
  listQueues(): Promise<Array<{ id: string; name: string }>>;
  createQueue(name: string): Promise<{ id: string; name: string }>;
  deleteQueue(id: string): Promise<void>;

  listWorkflows(): Promise<string[]>;
  /** The Workflows registered in the account, with the class and Worker each points at. */
  listWorkflowDefinitions(): Promise<Array<{ name: string; className: string; scriptName: string }>>;
  /** Registers (or updates) a Workflow. Uploading a Worker with a Workflow binding does NOT do this: the binding names a Workflow that must exist. */
  putWorkflow(name: string, definition: { className: string; scriptName: string }): Promise<void>;
  deleteWorkflow(name: string): Promise<void>;
  /** Cloudflare's own record of one run: its status, error, output and every step with its name and times. Null if there is no such run. */
  getWorkflowInstance(workflowName: string, instanceId: string): Promise<WorkflowInstance | null>;
}

export interface WorkflowInstance {
  status: string;
  success: boolean | null;
  error: { name?: string; message?: string } | null;
  output: unknown;
  params: unknown;
  start: string | null;
  end: string | null;
  steps: Array<{ type: string; name: string; success: boolean | null; start: string | null; end: string | null; attempts: number; output?: unknown }>;
}

export function createClient(options: ClientOptions): Client {
  const { token, accountId } = options.credentials;
  const hide = createRedactor([token, accountId, ...(options.alsoHide ?? [])]);
  const base = options.base ?? API_BASE;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => performance.now());
  const budget = options.budget ?? createRequestBudget({ now, sleep });
  const started = now();
  const calls: CallRecord[] = [];
  const shown = (path: string) => path.split(accountId).join("{account}");

  interface Request1 {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string; // relative to /accounts/{id}, starting with "/"
    query?: Record<string, string>;
    json?: unknown;
    form?: FormData;
    sqlKind?: "select" | "write";
    /** What to write in the call log instead of the real path, for a path that carries an identifier that should not be kept. */
    display?: string;
    /** What to do with a 404: some reads treat it as "not there". */
    notFoundIs?: "null";
    /** The path is relative to the API base, not to /accounts/{id} (the user-token endpoint). */
    outsideAccount?: boolean;
    /** Receives the answer's result_info (paging), when it has one. */
    onInfo?: (info: { page?: number; per_page?: number; total_pages?: number; total_count?: number; count?: number; cursor?: string; cursors?: { after?: string } } | undefined) => void;
  }

  async function send<T>(spec: Request1): Promise<T | null> {
    const queryString = spec.query && Object.keys(spec.query).length > 0 ? `?${new URLSearchParams(spec.query)}` : "";
    const path = spec.outsideAccount ? spec.path : `/accounts/${accountId}${spec.path}`;
    const shownPath = spec.display ?? `${shown(path)}${queryString.replace(accountId, "{account}")}`;
    const safeToRepeatOnServerError = spec.method === "GET";
    let attempt = 0;
    for (;;) {
      attempt += 1;
      await budget.take(); // waits for budget instead of failing; a retry takes a token like any other attempt
      const t0 = now();
      const record = (status: number | null, outcome: Outcome, extra: Partial<CallRecord> = {}) => {
        const entry: CallRecord = { n: calls.length + 1, atMs: Math.round(t0 - started), method: spec.method, path: shownPath, status, ms: Math.round(now() - t0), outcome, attempt, ...(spec.sqlKind ? { sqlKind: spec.sqlKind } : {}), ...extra };
        calls.push(entry);
        options.onCall?.(entry);
      };

      let response: Response;
      try {
        const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
        if (spec.json !== undefined) headers["content-type"] = "application/json";
        response = await options.fetch(new Request(`${base}${path}${queryString}`, { method: spec.method, headers, body: spec.form ?? (spec.json === undefined ? null : JSON.stringify(spec.json)) }));
      } catch (error) {
        if (error instanceof RequestGuardError) throw error; // refused before it was sent: not a network failure
        record(null, "network_error");
        if (safeToRepeatOnServerError && attempt < 3) {
          await sleep(200 * attempt);
          continue;
        }
        throw new CloudflareNetworkError(spec.method, shownPath, hide(error instanceof Error ? error.message : String(error)));
      }

      const text = await response.text();
      let body: { success?: boolean; errors?: Array<{ code?: number; message?: string }>; result?: unknown } | null = null;
      try {
        body = JSON.parse(text);
      } catch {
        // handled below
      }

      if (response.status === 429 && attempt < 4) {
        record(429, "api_error", { errorCodes: [] });
        const wait = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 30) * 1000 : 500 * attempt);
        continue; // a rate-limited request was not processed, so repeating it is safe for every method
      }
      if (response.status >= 500 && safeToRepeatOnServerError && attempt < 3) {
        record(response.status, "api_error");
        await sleep(200 * attempt);
        continue;
      }
      if (response.status === 404 && spec.notFoundIs === "null") {
        record(404, "ok");
        return null;
      }

      if (body === null || typeof body !== "object") {
        record(response.status, "malformed");
        throw new CloudflareMalformedError(spec.method, shownPath, response.status, response.ok ? "the body is not JSON" : `the body is not JSON (${hide(text).slice(0, 120)})`);
      }
      if (!response.ok || body.success === false) {
        const codes = (body.errors ?? []).map((e) => e.code).filter((c): c is number => typeof c === "number");
        const details = (body.errors ?? []).map((e) => hide(String(e.message ?? ""))).filter(Boolean);
        record(response.status, "api_error", { errorCodes: codes });
        throw new CloudflareApiError(spec.method, shownPath, response.status, codes, details, hide(text).slice(0, 4000));
      }
      if (!("result" in body)) {
        record(response.status, "malformed");
        throw new CloudflareMalformedError(spec.method, shownPath, response.status, "no result field");
      }
      record(response.status, "ok");
      spec.onInfo?.((body as { result_info?: never }).result_info);
      return body.result as T;
    }
  }
  const must = <T>(value: T | null, what: string): T => {
    if (value === null) throw new CloudflareMalformedError("GET", what, 0, "an empty answer");
    return value;
  };
  /** A version as this client gives it: the annotations from the top level or from metadata, whichever Cloudflare sent. */
  function shapeVersion(v: { id: string; number?: number; metadata?: Record<string, unknown>; annotations?: Record<string, unknown> }) {
    const annotations = v.annotations ?? (v.metadata?.annotations as Record<string, unknown> | undefined);
    return {
      id: v.id,
      ...(typeof v.number === "number" ? { number: v.number } : {}),
      ...(v.metadata ? { metadata: v.metadata } : {}),
      ...(annotations ? { annotations } : {}),
    };
  }
  /**
   * Every item of a list endpoint, page by page (page / per_page). It stops at result_info.total_pages when the answer gives
   * it, otherwise at a short page; an endpoint that ignores paging (the same items again) stops at the first repeat.
   */
  async function listAll<T>(path: string, key: (item: T) => string, query: Record<string, string> = {}): Promise<T[]> {
    const out: T[] = [];
    const seen = new Set<string>();
    let totalCount: number | undefined;
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
      let info: { total_pages?: number; per_page?: number; total_count?: number; cursor?: string; cursors?: { after?: string } } | undefined;
      const r = must(await send<T[]>({ method: "GET", path, query: { ...query, page: String(page), per_page: String(LIST_PAGE_SIZE) }, onInfo: (i) => (info = i) }), path);
      if (!Array.isArray(r)) throw new CloudflareMalformedError("GET", path, 200, "the result is not a list");
      let fresh = 0;
      for (const item of r) {
        const k = key(item);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(item);
        fresh += 1;
      }
      if (typeof info?.total_count === "number") totalCount = info.total_count;
      // A cursor-paged answer is not followed by this page/per_page reader: refuse rather than return part of the list.
      if (info?.cursor || info?.cursors?.after) throw new CloudflareMalformedError("GET", path, 200, "the list is cursor-paged and this reader follows page numbers only; refusing a partial list");
      if (fresh === 0) break;
      if (typeof info?.total_pages === "number") {
        if (page >= info.total_pages) break;
      } else if (r.length < (info?.per_page ?? LIST_PAGE_SIZE)) break;
      if (page === MAX_LIST_PAGES) throw new CloudflareMalformedError("GET", path, 200, `more than ${MAX_LIST_PAGES} pages`);
    }
    if (totalCount !== undefined && totalCount > out.length) {
      throw new CloudflareMalformedError("GET", path, 200, `Cloudflare counts ${totalCount} items but only ${out.length} were read; refusing a partial list`);
    }
    return out;
  }

  return {
    calls,
    hide,

    async verifyToken() {
      type Verified = { id?: string; status: string; expires_on?: string };
      const shape = (r: Verified, kind: "account" | "user") => ({ status: r.status, ...(r.id ? { id: r.id } : {}), ...(r.expires_on ? { expiresOn: r.expires_on } : {}), kind });
      try {
        return shape(must(await send<Verified>({ method: "GET", path: "/tokens/verify" }), "/tokens/verify"), "account");
      } catch (accountError) {
        const notAnAccountToken = accountError instanceof CloudflareApiError && (accountError.status === 401 || accountError.codes.includes(1000));
        if (!notAnAccountToken) throw accountError;
        try {
          return shape(must(await send<Verified>({ method: "GET", path: "/user/tokens/verify", outsideAccount: true }), "/user/tokens/verify"), "user");
        } catch (userError) {
          // Refused by both (a 4xx from the user endpoint too): the token is not valid. A 5xx, a network failure or a malformed
          // answer is Cloudflare being unreachable, never a verdict on the token: it propagates as such.
          if (userError instanceof CloudflareApiError && userError.status >= 400 && userError.status < 500) throw accountError;
          throw userError;
        }
      }
    },
    async getTokenPermissions(tokenId) {
      // Reading a token's own policies needs a permission this token may not have; the caller treats a refusal as "unknown", not as a failure.
      const r = must(await send<{ policies?: Array<{ effect?: string; permission_groups?: Array<{ name?: string }> }> }>({ method: "GET", path: `/tokens/${encodeURIComponent(tokenId)}`, display: "/accounts/{account}/tokens/{token-id}" }), "/tokens/{id}");
      const names = (r.policies ?? []).filter((p) => p.effect === undefined || p.effect === "allow").flatMap((p) => (p.permission_groups ?? []).map((g) => g.name).filter((n): n is string => typeof n === "string"));
      return [...new Set(names)].sort();
    },
    async getAccountSubdomain() {
      const r = await send<{ subdomain?: string }>({ method: "GET", path: "/workers/subdomain", notFoundIs: "null" });
      return r?.subdomain ?? null;
    },

    async listDatabases(name) {
      // ?name= is a search (not an exact match, not a prefix), so callers compare names themselves.
      const r = await listAll<{ uuid: string; name: string }>("/d1/database", (d) => d.uuid, name ? { name } : {});
      return r.map((d) => ({ uuid: d.uuid, name: d.name }));
    },
    async getDatabase(id) {
      const r = must(await send<{ uuid?: string; name?: string }>({ method: "GET", path: `/d1/database/${encodeURIComponent(id)}`, display: "/accounts/{account}/d1/database/{id}" }), "/d1/database/{id}");
      if (typeof r.uuid !== "string" || typeof r.name !== "string") throw new CloudflareMalformedError("GET", "/d1/database/{id}", 200, "the database has no uuid or name");
      return { uuid: r.uuid, name: r.name };
    },
    async createDatabase(name) {
      const r = must(await send<{ uuid?: string; name?: string }>({ method: "POST", path: "/d1/database", json: { name } }), "/d1/database");
      if (typeof r.uuid !== "string" || typeof r.name !== "string") throw new CloudflareMalformedError("POST", "/d1/database", 200, "the created database has no uuid or name");
      return { uuid: r.uuid, name: r.name };
    },
    async deleteDatabase(id) {
      await send({ method: "DELETE", path: `/d1/database/${encodeURIComponent(id)}` });
    },
    async queryDatabase(id, statements) {
      const sqlKind = sqlKindOf(statements);
      const json = statements.length === 1 ? { sql: statements[0]!.sql, params: statements[0]!.params ?? [] } : { batch: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })) };
      const r = must(await send<Array<{ results?: Record<string, unknown>[]; meta?: Record<string, unknown> }>>({ method: "POST", path: `/d1/database/${encodeURIComponent(id)}/query`, json, sqlKind }), "/query");
      if (!Array.isArray(r)) throw new CloudflareMalformedError("POST", "/d1/database/{id}/query", 200, "the result is not a list");
      return r.map((q) => ({ results: q.results ?? [], meta: q.meta ?? {} }));
    },
    async getD1Bookmark(id, timestamp) {
      const query: Record<string, string> | undefined = timestamp ? { timestamp } : undefined;
      const r = must(
        await send<{ bookmark: string }>({
          method: "GET",
          path: `/d1/database/${encodeURIComponent(id)}/time_travel/bookmark`,
          query,
        }),
        "/d1/database/{id}/time_travel/bookmark",
      );
      if (typeof r.bookmark !== "string") throw new CloudflareMalformedError("GET", "/d1/database/{id}/time_travel/bookmark", 200, "no bookmark field");
      return r.bookmark;
    },
    async restoreD1(id, bookmark) {
      const r = must(
        await send<{ previous_bookmark: string }>({
          method: "POST",
          path: `/d1/database/${encodeURIComponent(id)}/time_travel/restore`,
          query: { bookmark },
        }),
        "/d1/database/{id}/time_travel/restore",
      );
      if (typeof r.previous_bookmark !== "string") throw new CloudflareMalformedError("POST", "/d1/database/{id}/time_travel/restore", 200, "no previous_bookmark field");
      return { previous_bookmark: r.previous_bookmark };
    },

    async listScripts() {
      const r = await listAll<{ id: string }>("/workers/scripts", (s) => s.id);
      return r.map((s) => s.id);
    },
    async uploadScript(name, upload) {
      const form = new FormData();
      form.set("metadata", new Blob([JSON.stringify({ ...upload.metadata, main_module: upload.mainModule })], { type: "application/json" }), "metadata.json");
      form.set(upload.mainModule, new Blob([upload.code], { type: "application/javascript+module" }), upload.mainModule);
      const r = must(await send<{ etag?: string; startup_time_ms?: number }>({ method: "PUT", path: `/workers/scripts/${encodeURIComponent(name)}`, form }), "/workers/scripts");
      return { ...(r.etag ? { etag: r.etag } : {}), ...(typeof r.startup_time_ms === "number" ? { startupTimeMs: r.startup_time_ms } : {}) };
    },
    async uploadVersion(name, upload) {
      const form = new FormData();
      form.set("metadata", new Blob([JSON.stringify({ ...upload.metadata, main_module: upload.mainModule })], { type: "application/json" }), "metadata.json");
      form.set(upload.mainModule, new Blob([upload.code], { type: "application/javascript+module" }), upload.mainModule);
      const r = must(
        await send<{ id: string; number?: number }>({
          method: "POST",
          path: `/workers/scripts/${encodeURIComponent(name)}/versions`,
          form,
        }),
        "/workers/scripts/{id}/versions",
      );
      if (typeof r.id !== "string") throw new CloudflareMalformedError("POST", "/workers/scripts/{id}/versions", 200, "no id field");
      return { id: r.id, ...(typeof r.number === "number" ? { number: r.number } : {}) };
    },
    async createDeployment(name, versions) {
      const r = must(
        await send<{ id?: string; created_on?: string; versions?: Array<{ version_id?: string; versionId?: string; percentage: number }> }>({
          method: "POST",
          path: `/workers/scripts/${encodeURIComponent(name)}/deployments`,
          json: {
            strategy: "percentage",
            versions: versions.map((v) => ({ version_id: v.versionId, percentage: v.percentage })),
          },
        }),
        "/workers/scripts/{id}/deployments",
      );
      const rawVersions = r.versions ?? [];
      return {
        ...(r.id ? { id: r.id } : {}),
        ...(r.created_on ? { created_on: r.created_on } : {}),
        versions: rawVersions.map((v) => ({
          versionId: v.version_id ?? v.versionId ?? "",
          percentage: v.percentage,
        })),
      };
    },
    async listDeployments(name) {
      const r = await send<{ deployments?: Array<Record<string, unknown>>; items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>({
        method: "GET",
        path: `/workers/scripts/${encodeURIComponent(name)}/deployments`,
        notFoundIs: "null",
      });
      if (r === null) return null;
      const rawList = Array.isArray(r) ? r : (r.deployments ?? r.items ?? []);
      return rawList.map((d) => ({
        id: String(d.id ?? ""),
        ...(d.created_on ? { created_on: String(d.created_on) } : {}),
        versions: ((d.versions as Array<{ version_id?: string; versionId?: string; percentage?: number }>) ?? []).map((v) => ({
          versionId: String(v.version_id ?? v.versionId ?? ""),
          percentage: Number(v.percentage ?? 0),
        })),
      }));
    },
    async fetchWithVersionOverride(url, name, versionId, init) {
      const headers = new Headers(init?.headers);
      headers.set("Cloudflare-Workers-Version-Overrides", `${name}="${versionId}"`);
      const req = new Request(url, { ...init, headers });
      const parsedUrl = new URL(url);
      const shownPath = `/accounts/{account}/workers/scripts/${name}/smoke${parsedUrl.pathname}`;
      const t0 = now();
      try {
        const res = await options.fetch(req);
        calls.push({
          n: calls.length + 1,
          atMs: Math.round(t0 - started),
          method: req.method,
          path: shownPath,
          status: res.status,
          ms: Math.round(now() - t0),
          outcome: res.ok ? "ok" : "api_error",
          attempt: 1,
        });
        return res;
      } catch (err) {
        calls.push({
          n: calls.length + 1,
          atMs: Math.round(t0 - started),
          method: req.method,
          path: shownPath,
          status: null,
          ms: Math.round(now() - t0),
          outcome: "network_error",
          attempt: 1,
        });
        throw err;
      }
    },
    async deleteScript(name) {
      await send({ method: "DELETE", path: `/workers/scripts/${encodeURIComponent(name)}`, query: { force: "true" } });
    },
    async listVersions(name) {
      // Paged with page/per_page (not yet checked against the live API for this endpoint); stops at a short or repeated page.
      type Item = { id: string; number?: number; metadata?: Record<string, unknown>; annotations?: Record<string, unknown> };
      const out: ReturnType<typeof shapeVersion>[] = [];
      const seen = new Set<string>();
      for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
        let info: { total_pages?: number; per_page?: number } | undefined;
        const r = await send<{ items?: Item[] }>({ method: "GET", path: `/workers/scripts/${encodeURIComponent(name)}/versions`, query: { page: String(page), per_page: String(LIST_PAGE_SIZE) }, notFoundIs: "null", onInfo: (i) => (info = i) });
        if (r === null) return page === 1 ? null : out;
        const items = r.items ?? [];
        let fresh = 0;
        for (const v of items) {
          if (seen.has(v.id)) continue;
          seen.add(v.id);
          out.push(shapeVersion(v));
          fresh += 1;
        }
        if (fresh === 0) break;
        if (typeof info?.total_pages === "number") {
          if (page >= info.total_pages) break;
        } else if (items.length < (info?.per_page ?? LIST_PAGE_SIZE)) break;
      }
      return out;
    },
    async getVersion(name, versionId) {
      const r = await send<{ id?: string; metadata?: Record<string, unknown>; annotations?: Record<string, unknown> }>({ method: "GET", path: `/workers/scripts/${encodeURIComponent(name)}/versions/${encodeURIComponent(versionId)}`, notFoundIs: "null" });
      if (r === null) return null;
      return shapeVersion({ id: r.id ?? versionId, ...(r.metadata ? { metadata: r.metadata } : {}), ...(r.annotations ? { annotations: r.annotations } : {}) });
    },
    async getScriptBindings(name) {
      // Keeps only what is not secret: a binding's type and name, and for a Workflow its workflow name and class. A secret's text is never read back by the API and is dropped here regardless.
      const r = await send<{ bindings?: Array<{ type?: string; name?: string; workflow_name?: string; class_name?: string }> }>({ method: "GET", path: `/workers/scripts/${encodeURIComponent(name)}/settings`, notFoundIs: "null" });
      if (r === null) return null;
      return (r.bindings ?? []).filter((b): b is { type: string; name: string; workflow_name?: string; class_name?: string } => typeof b.type === "string" && typeof b.name === "string").map((b) => ({ type: b.type, name: b.name, ...(b.type === "workflow" && b.workflow_name ? { workflowName: b.workflow_name } : {}), ...(b.type === "workflow" && b.class_name ? { className: b.class_name } : {}) }));
    },
    async getScriptSubdomain(name) {
      const r = await send<{ enabled?: boolean }>({ method: "GET", path: `/workers/scripts/${encodeURIComponent(name)}/subdomain`, notFoundIs: "null" });
      return r === null ? null : { enabled: r.enabled === true };
    },
    async setScriptSubdomain(name, enabled) {
      await send({ method: "POST", path: `/workers/scripts/${encodeURIComponent(name)}/subdomain`, json: { enabled, previews_enabled: false } });
    },

    async getAccount() {
      // GET /accounts/{account_id} ("Account Details", Cloudflare v4). Shape (id, name) from the documentation; not yet checked against the live API.
      const r = must(await send<{ id?: string; name?: string }>({ method: "GET", path: "" }), "/accounts/{account}");
      if (typeof r.name !== "string") throw new CloudflareMalformedError("GET", "/accounts/{account}", 200, "the account has no name");
      return { id: typeof r.id === "string" ? r.id : accountId, name: r.name };
    },
    async putScriptSecret(name, secretName, value) {
      // PUT /workers/scripts/{script_name}/secrets with {name, text, type: "secret_text"} ("Add script secret", Cloudflare v4).
      // The value travels only in the body, which the call log never keeps; error text goes through hide() like every other.
      const r = await send<{ version_id?: unknown; versionId?: unknown }>({ method: "PUT", path: `/workers/scripts/${encodeURIComponent(name)}/secrets`, json: { name: secretName, text: value, type: "secret_text" } });
      // Whether the answer names the version this put created is NOT checked against the live API; an id is used only if present.
      const versionId = typeof r?.version_id === "string" ? r.version_id : typeof r?.versionId === "string" ? r.versionId : undefined;
      return versionId ? { versionId } : {};
    },
    async deleteScriptSecret(name, secretName) {
      await send({ method: "DELETE", path: `/workers/scripts/${encodeURIComponent(name)}/secrets/${encodeURIComponent(secretName)}` });
    },
    async getSchedules(name) {
      // GET /workers/scripts/{script_name}/schedules -> {schedules: [{cron}]}. From the documentation; not yet checked against the live API.
      const r = await send<{ schedules?: Array<{ cron?: string }> }>({ method: "GET", path: `/workers/scripts/${encodeURIComponent(name)}/schedules`, notFoundIs: "null" });
      if (r === null) return null;
      return (r.schedules ?? []).map((s) => s.cron).filter((c): c is string => typeof c === "string");
    },
    async putSchedules(name, crons) {
      // PUT /workers/scripts/{script_name}/schedules with [{cron}], which replaces the list. Not yet checked against the live API.
      const r = must(await send<{ schedules?: Array<{ cron?: string }> }>({ method: "PUT", path: `/workers/scripts/${encodeURIComponent(name)}/schedules`, json: crons.map((cron) => ({ cron })) }), "/workers/scripts/{id}/schedules");
      return (r.schedules ?? []).map((s) => s.cron).filter((c): c is string => typeof c === "string");
    },
    async listQueues() {
      // GET /queues -> [{queue_id, queue_name}]. From the documentation; not yet checked against the live API.
      const r = await listAll<{ queue_id?: string; queue_name?: string }>("/queues", (q) => String(q.queue_id ?? q.queue_name));
      return r.filter((q) => typeof q.queue_id === "string" && typeof q.queue_name === "string").map((q) => ({ id: q.queue_id!, name: q.queue_name! }));
    },
    async createQueue(name) {
      // POST /queues {queue_name} -> {queue_id, queue_name}. Not yet checked against the live API.
      const r = must(await send<{ queue_id?: string; queue_name?: string }>({ method: "POST", path: "/queues", json: { queue_name: name } }), "/queues");
      if (typeof r.queue_id !== "string") throw new CloudflareMalformedError("POST", "/queues", 200, "the created queue has no id");
      return { id: r.queue_id, name: r.queue_name ?? name };
    },
    async deleteQueue(id) {
      await send({ method: "DELETE", path: `/queues/${encodeURIComponent(id)}` });
    },

    async listWorkflows() {
      const r = await listAll<{ name: string }>("/workflows", (w) => w.name);
      return r.map((w) => w.name);
    },
    async listWorkflowDefinitions() {
      const r = await listAll<{ name: string; class_name?: string; script_name?: string }>("/workflows", (w) => w.name);
      return r.map((w) => ({ name: w.name, className: w.class_name ?? "", scriptName: w.script_name ?? "" }));
    },
    async putWorkflow(name, definition) {
      await send({ method: "PUT", path: `/workflows/${encodeURIComponent(name)}`, json: { class_name: definition.className, script_name: definition.scriptName } });
    },
    async getWorkflowInstance(workflowName, instanceId) {
      const r = await send<Record<string, unknown>>({ method: "GET", path: `/workflows/${encodeURIComponent(workflowName)}/instances/${encodeURIComponent(instanceId)}`, display: `/accounts/{account}/workflows/{workflow}/instances/{run}`, notFoundIs: "null" });
      if (r === null) return null;
      // Outputs arrive as text holding JSON; they are parsed here so a caller compares values, not spellings.
      const parse = (value: unknown): unknown => {
        if (typeof value !== "string") return value;
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      };
      const steps = (Array.isArray(r.steps) ? (r.steps as Array<Record<string, unknown>>) : []).map((s) => ({
        type: String(s.type ?? ""),
        name: String(s.name ?? ""),
        success: typeof s.success === "boolean" ? s.success : null,
        start: typeof s.start === "string" ? s.start : null,
        end: typeof s.end === "string" ? s.end : null,
        attempts: Array.isArray(s.attempts) ? s.attempts.length : 0,
        ...(s.output !== undefined ? { output: parse(s.output) } : {}),
      }));
      const error = r.error && typeof r.error === "object" ? (r.error as { name?: string; message?: string }) : null;
      return { status: String(r.status ?? ""), success: typeof r.success === "boolean" ? r.success : null, error: error ? { ...(error.name ? { name: hide(String(error.name)) } : {}), ...(error.message ? { message: hide(String(error.message)) } : {}) } : null, output: parse(r.output), params: r.params ?? null, start: typeof r.start === "string" ? r.start : null, end: typeof r.end === "string" ? r.end : null, steps };
    },
    async deleteWorkflow(name) {
      await send({ method: "DELETE", path: `/workflows/${encodeURIComponent(name)}` });
    },
  };
}
