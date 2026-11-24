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
export type CloudflareError = CloudflareApiError | CloudflareNetworkError | CloudflareMalformedError;
export const isCloudflareError = (e: unknown): e is CloudflareError => e instanceof CloudflareApiError || e instanceof CloudflareNetworkError || e instanceof CloudflareMalformedError;

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
}

const readOnly = (sql: string) => /^\s*select\b/i.test(sql);
export const sqlKindOf = (statements: Array<{ sql: string }>): "select" | "write" => (statements.every((s) => readOnly(s.sql)) ? "select" : "write");

export interface Client {
  readonly calls: readonly CallRecord[];
  /** Hides the token, the account id and anything given in `alsoHide` in a piece of text. */
  hide(text: string): string;

  verifyToken(): Promise<{ status: string; id?: string; expiresOn?: string }>;
  /** The permission group names in the token's own policies. Needs a permission the token may lack: expect a refusal. */
  getTokenPermissions(tokenId: string): Promise<string[]>;
  getAccountSubdomain(): Promise<string | null>;

  listDatabases(name?: string): Promise<Array<{ uuid: string; name: string }>>;
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
  listVersions(name: string): Promise<Array<{ id: string; number?: number; metadata?: Record<string, unknown> }> | null>;
  /** The Worker's bindings as Cloudflare reports them (type and name; a Workflow's name and class), or null if there is no such Worker. Never returns a secret. */
  getScriptBindings(name: string): Promise<Array<{ type: string; name: string; workflowName?: string; className?: string }> | null>;
  getScriptSubdomain(name: string): Promise<{ enabled: boolean } | null>;
  setScriptSubdomain(name: string, enabled: boolean): Promise<void>;

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
  }

  async function send<T>(spec: Request1): Promise<T | null> {
    const queryString = spec.query && Object.keys(spec.query).length > 0 ? `?${new URLSearchParams(spec.query)}` : "";
    const path = `/accounts/${accountId}${spec.path}`;
    const shownPath = spec.display ?? `${shown(path)}${queryString.replace(accountId, "{account}")}`;
    const safeToRepeatOnServerError = spec.method === "GET";
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const t0 = now();
      const record = (status: number | null, outcome: Outcome, extra: Partial<CallRecord> = {}) =>
        calls.push({ n: calls.length + 1, atMs: Math.round(t0 - started), method: spec.method, path: shownPath, status, ms: Math.round(now() - t0), outcome, attempt, ...(spec.sqlKind ? { sqlKind: spec.sqlKind } : {}), ...extra });

      let response: Response;
      try {
        const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
        if (spec.json !== undefined) headers["content-type"] = "application/json";
        response = await options.fetch(new Request(`${base}${path}${queryString}`, { method: spec.method, headers, body: spec.form ?? (spec.json === undefined ? null : JSON.stringify(spec.json)) }));
      } catch (error) {
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
      return body.result as T;
    }
  }
  const must = <T>(value: T | null, what: string): T => {
    if (value === null) throw new CloudflareMalformedError("GET", what, 0, "an empty answer");
    return value;
  };

  return {
    calls,
    hide,

    async verifyToken() {
      const r = must(await send<{ id?: string; status: string; expires_on?: string }>({ method: "GET", path: "/tokens/verify" }), "/tokens/verify");
      return { status: r.status, ...(r.id ? { id: r.id } : {}), ...(r.expires_on ? { expiresOn: r.expires_on } : {}) };
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
      const r = must(await send<Array<{ uuid: string; name: string }>>({ method: "GET", path: "/d1/database", query: name ? { name } : {} }), "/d1/database");
      if (!Array.isArray(r)) throw new CloudflareMalformedError("GET", "/d1/database", 200, "the result is not a list");
      return r.map((d) => ({ uuid: d.uuid, name: d.name }));
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
      const r = must(await send<Array<{ id: string }>>({ method: "GET", path: "/workers/scripts" }), "/workers/scripts");
      if (!Array.isArray(r)) throw new CloudflareMalformedError("GET", "/workers/scripts", 200, "the result is not a list");
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
      const r = await send<{ items?: Array<{ id: string; number?: number; metadata?: Record<string, unknown> }> }>({ method: "GET", path: `/workers/scripts/${encodeURIComponent(name)}/versions`, notFoundIs: "null" });
      return r === null ? null : (r.items ?? []).map((v) => ({
        id: v.id,
        ...(typeof v.number === "number" ? { number: v.number } : {}),
        ...(v.metadata ? { metadata: v.metadata } : {}),
      }));
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

    async listWorkflows() {
      const r = must(await send<Array<{ name: string }>>({ method: "GET", path: "/workflows" }), "/workflows");
      if (!Array.isArray(r)) throw new CloudflareMalformedError("GET", "/workflows", 200, "the result is not a list");
      return r.map((w) => w.name);
    },
    async listWorkflowDefinitions() {
      const r = must(await send<Array<{ name: string; class_name?: string; script_name?: string }>>({ method: "GET", path: "/workflows" }), "/workflows");
      if (!Array.isArray(r)) throw new CloudflareMalformedError("GET", "/workflows", 200, "the result is not a list");
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
