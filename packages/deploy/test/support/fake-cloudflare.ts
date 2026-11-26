import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

// A stand-in for the parts of Cloudflare's REST API the provisioner uses, built from the request and response shapes in
// Cloudflare's documentation (read 2026-10-21): D1 create, list (searched by name), query (one statement or a batch) and
// delete; Worker upload (multipart: a JSON "metadata" part and the module), version list, per-script workers.dev switch,
// delete; the account's workers.dev name; token verify. D1 is real SQLite, so migrations really run.
//
// What it proves: that the provisioner's logic is right against a server that behaves as documented. What it does not
// prove: that Cloudflare behaves as documented. Where the documentation was silent (the error codes of most refusals, the
// Workflows list and delete endpoints) the fake is a guess, said so here, and the real runs are what settle it.

export interface FakeOptions {
  token: string;
  accountId: string;
  /** The account's workers.dev name, or null for an account that has not registered one. */
  subdomain?: string | null;
  expiresOn?: string;
  /** Permission group names the token's own policies list. Absent or null: reading the token's policies is refused, as for most scoped tokens. */
  tokenGroups?: string[] | null;
  /** The account name GET /accounts/{id} answers with. Null: that read is refused, as for a token without Account Settings Read. */
  accountName?: string | null;
  /** The token status /tokens/verify reports (default "active"). A revoked account token answers 401 to every call instead; a revoked user token reports status "revoked" at /user/tokens/verify. */
  tokenStatus?: "active" | "disabled" | "expired" | "revoked";
  /**
   * "account" (default): an account-owned token, verified at /accounts/{id}/tokens/verify. "user": a user token (My Profile),
   * which that endpoint answers with 1000 "Invalid API Token" (as the real service does) and /user/tokens/verify verifies.
   */
  tokenKind?: "account" | "user";
  /** The most items a list endpoint returns per page, whatever per_page asks (to test paging). Default: what per_page asks. */
  maxPerPage?: number;
  /**
   * Where the version list carries a version's annotations: "metadata" (metadata.annotations, the default), "top-level"
   * (annotations beside metadata), or "detail-only" (not in the list; only GET .../versions/{id} has them). Which one the
   * real service uses is not yet checked, so the client must read all three.
   */
  versionAnnotations?: "metadata" | "top-level" | "detail-only";
  /** Answers GET /queues with this status (400 or 404: an account without Queues). */
  queuesUnavailable?: 400 | 404;
  /** Simulates Cloudflare refusing a Workflow binding in an upload. */
  refuseWorkflowBindings?: boolean;
  /** Refuses every upload (any binding), as a broken account or an oversized script would. */
  refuseAllUploads?: boolean;
  maxScriptBytes?: number;
  /** Cloudflare's record of a Workflow run, as the REST endpoint would give it. The fake runs no Workflows itself; a test that needs a record supplies one. */
  instanceDetails?: (workflowName: string, instanceId: string) => unknown | null | Promise<unknown | null>;
  healthzStub?: (version: string, code: string, request: Request) => Response | Promise<Response>;
}

export type Fault =
  | { when: (method: string, path: string) => boolean; times?: number; respond: "network-error"; /** Let the fake process the request first, then lose the answer: the case where something was created but the caller never heard. */ afterHandling?: boolean }
  | { when: (method: string, path: string) => boolean; times?: number; respond: { status: number; body?: unknown; text?: string; headers?: Record<string, string> } };

export interface ScriptVersion {
  id: string;
  number: number;
  createdOn: string;
  code: string;
  bindings: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}

export interface Deployment {
  id: string;
  created_on: string;
  strategy: "percentage";
  versions: Array<{ version_id: string; percentage: number }>;
}

interface Script {
  name: string;
  code: string;
  bindings: Array<Record<string, unknown>>;
  schedules?: string[];
  versions: Array<ScriptVersion>;
  deployments: Array<Deployment>;
  addressEnabled: boolean;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const envelope = (result: unknown) => ({ success: true, errors: [], messages: [], result });
const failure = (status: number, code: number, message: string) => new Response(JSON.stringify({ success: false, errors: [{ code, message }], messages: [], result: null }), { status, headers: { "content-type": "application/json" } });
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

export function createFakeCloudflare(options: FakeOptions) {
  const databases = new Map<string, { uuid: string; name: string; created: string; sqlite: DatabaseSync }>();
  const snapshots = new Map<string, string>();
  const tmpDir = mkdtempSync(join(tmpdir(), "d1-fake-"));
  const scripts = new Map<string, Script>();
  const workflows = new Map<string, { name: string; className: string; script: string }>();
  const queues = new Map<string, { id: string; name: string; created: string }>();
  /** The secret values set by an upload or PUT .../secrets, kept only so a test can check what a Worker received. */
  const secretValues = new Map<string, Map<string, string>>();
  const requests: Array<{ method: string; path: string; query: string }> = [];
  const faults: Array<Fault & { used: number }> = [];
  let subdomain = options.subdomain === undefined ? "fake-subdomain" : options.subdomain;
  let versionCounter = 0;
  let activeHealthStub = options.healthzStub;
  const opts = { ...options };

  const prefix = `/client/v4/accounts/${options.accountId}`;
  const bodies: string[] = [];

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    requests.push({ method, path: url.pathname.replace(options.accountId, "{account}"), query: url.search });
    bodies.push(await request.clone().text());

    const fault = faults.find((f) => f.when(method, url.pathname) && (f.times === undefined || f.used < f.times));
    if (fault) {
      fault.used += 1;
      if (fault.respond === "network-error") {
        if ((fault as { afterHandling?: boolean }).afterHandling) await route(request); // processed, but the caller never hears
        throw new TypeError("fetch failed (simulated network failure)");
      }
      const r = fault.respond;
      return r.text !== undefined ? new Response(r.text, { status: r.status, headers: r.headers }) : json(r.body ?? { success: false, errors: [{ code: 1000, message: "simulated fault" }] }, r.status, r.headers);
    }
    return route(request);
  }

  /** One page of a list, as Cloudflare's paged lists answer (page / per_page, result_info). Without paging parameters: all. */
  function paged(list: unknown[], url: URL): Response {
    const pageParam = url.searchParams.get("page");
    const perParam = url.searchParams.get("per_page");
    if (pageParam === null && perParam === null && opts.maxPerPage === undefined) {
      return json({ ...envelope(list), result_info: { page: 1, per_page: list.length, count: list.length, total_count: list.length, total_pages: 1 } });
    }
    const page = Math.max(1, Number(pageParam ?? 1));
    const per = Math.max(1, Math.min(Number(perParam ?? 20), opts.maxPerPage ?? Number.MAX_SAFE_INTEGER));
    const slice = list.slice((page - 1) * per, page * per);
    return json({ ...envelope(slice), result_info: { page, per_page: per, count: slice.length, total_count: list.length, total_pages: Math.max(1, Math.ceil(list.length / per)) } });
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    const overrideHeader = request.headers.get("Cloudflare-Workers-Version-Overrides");
    if (overrideHeader || url.pathname === "/healthz" || url.pathname === "/readyz") {
      let scriptName: string | undefined;
      let versionId: string | undefined;
      if (overrideHeader) {
        const match = overrideHeader.match(/^\s*([^=]+?)\s*=\s*"?([^"]+?)"?\s*$/);
        if (match) {
          scriptName = match[1]?.trim();
          versionId = match[2]?.trim();
        }
      }
      if (!scriptName) {
        scriptName = url.hostname.split(".")[0];
      }
      const script = scriptName ? scripts.get(scriptName) : undefined;
      let targetCode = script?.code;
      if (versionId && script) {
        const ver = script.versions.find((v) => v.id === versionId);
        if (ver) {
          targetCode = ver.code;
        }
      }
      if (activeHealthStub) {
        return activeHealthStub(versionId ?? "", targetCode ?? "", request);
      }
      if (url.pathname === "/healthz") {
        return json({ ok: true, build: sha(targetCode ?? ""), version: versionId });
      }
      if (url.pathname === "/readyz") {
        return json({ ok: true, checks: { d1: "ok", bindings: "ok", migrations: "ok" } });
      }
      return new Response("ok", { status: 200 });
    }

    if (request.headers.get("authorization") !== `Bearer ${options.token}`) {
      // the real service answers an unknown token with 1000 "Invalid API Token" on both verify endpoints
      if (url.pathname.endsWith("/tokens/verify")) return failure(401, 1000, "Invalid API Token");
      return failure(401, 10000, "Authentication error");
    }
    if (method === "GET" && url.pathname === "/client/v4/user/tokens/verify") {
      if ((opts.tokenKind ?? "account") !== "user") return failure(401, 1000, "Invalid API Token");
      return json(envelope({ id: "fake-user-token-id", status: opts.tokenStatus ?? "active", expires_on: options.expiresOn ?? "2026-10-28T18:29:59Z" }));
    }
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return failure(403, 10000, "Authentication error");
    const path = url.pathname.slice(prefix.length);

    let m: RegExpMatchArray | null;

    if (method === "GET" && path === "/tokens/verify") {
      if ((opts.tokenKind ?? "account") === "user") return failure(401, 1000, "Invalid API Token");
      if (opts.tokenStatus === "revoked") return failure(401, 1000, "Invalid API Token");
      return json(envelope({ id: "fake-token-id", status: opts.tokenStatus ?? "active", expires_on: options.expiresOn ?? "2026-10-28T18:29:59Z" }));
    }
    if (opts.tokenStatus === "revoked" || opts.tokenStatus === "disabled" || opts.tokenStatus === "expired") return failure(401, 10000, "Authentication error");
    if (method === "GET" && path === "") {
      if (opts.accountName === null) return failure(403, 9109, "Unauthorized to access requested resource");
      return json(envelope({ id: options.accountId, name: opts.accountName ?? "Fake Account", settings: {} }));
    }
    if (method === "GET" && path === "/tokens/fake-token-id") {
      // Like the real service for a token without permission to read tokens: refused. A list of group names makes it readable.
      if (options.tokenGroups === undefined || options.tokenGroups === null) return failure(403, 9109, "Unauthorized to access requested resource");
      return json(envelope({ id: "fake-token-id", status: "active", policies: [{ effect: "allow", permission_groups: options.tokenGroups.map((name) => ({ id: name.toLowerCase().replace(/\W+/g, "-"), name })) }] }));
    }
    if (method === "GET" && path === "/workers/subdomain") return subdomain === null ? failure(404, 10007, "This account has no workers.dev subdomain") : json(envelope({ subdomain }));

    // ---- D1
    if (path === "/d1/database" && method === "POST") {
      const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
      if (!body || typeof body.name !== "string" || body.name === "") return failure(400, 7400, "name is required");
      if ([...databases.values()].some((d) => d.name === body.name)) return failure(400, 7502, "A database with that name already exists");
      const uuid = randomUUID();
      databases.set(uuid, { uuid, name: body.name, created: new Date().toISOString(), sqlite: new DatabaseSync(":memory:") });
      return json(envelope({ uuid, name: body.name, created_at: new Date().toISOString(), version: "production", num_tables: 0, file_size: 0 }));
    }
    if (path === "/d1/database" && method === "GET") {
      const wanted = url.searchParams.get("name");
      // the real endpoint searches; a database whose name merely contains the text is returned too, so callers must compare names exactly
      const list = [...databases.values()].filter((d) => wanted === null || d.name.includes(wanted)).map((d) => ({ uuid: d.uuid, name: d.name, created_at: d.created, version: "production" }));
      return paged(list, url);
    }
    if ((m = path.match(/^\/d1\/database\/([^/]+)$/)) && method === "DELETE") {
      if (!databases.has(m[1]!)) return failure(404, 7404, "database not found");
      databases.get(m[1]!)!.sqlite.close();
      databases.delete(m[1]!);
      return json(envelope({}));
    }
    if ((m = path.match(/^\/d1\/database\/([^/]+)\/query$/)) && method === "POST") {
      const db = databases.get(m[1]!);
      if (!db) return failure(404, 7404, "database not found");
      const body = (await request.json().catch(() => null)) as { sql?: string; params?: unknown[]; batch?: Array<{ sql: string; params?: unknown[] }> } | null;
      const statements = body?.batch ?? (typeof body?.sql === "string" ? [{ sql: body.sql, params: body.params }] : null);
      if (!statements) return failure(400, 7400, "a query needs sql or a batch");
      try {
        db.sqlite.exec("BEGIN");
        const out = statements.map((s) => {
          const stmt = db.sqlite.prepare(s.sql);
          const params = (s.params ?? []) as SQLInputValue[];
          if (/^\s*(select|pragma|with)\b/i.test(s.sql)) return { results: stmt.all(...params).map((r) => ({ ...r })), success: true, meta: { changes: 0, changed_db: false } };
          const r = stmt.run(...params);
          return { results: [], success: true, meta: { changes: Number(r.changes), changed_db: Number(r.changes) > 0 } };
        });
        db.sqlite.exec("COMMIT");
        return json(envelope(out));
      } catch (error) {
        try {
          db.sqlite.exec("ROLLBACK");
        } catch {
          // no transaction was open
        }
        return failure(400, 7500, error instanceof Error ? error.message : String(error));
      }
    }
    if ((m = path.match(/^\/d1\/database\/([^/]+)\/time_travel\/bookmark$/)) && method === "GET") {
      const db = databases.get(m[1]!);
      if (!db) return failure(404, 7404, "database not found");
      const bookmark = `bm_${Date.now()}_${randomUUID().slice(0, 8)}`;
      const snapPath = join(tmpDir, `${m[1]}-${bookmark}.sqlite`);
      db.sqlite.exec(`VACUUM INTO '${snapPath.replace(/\\/g, "/")}'`);
      snapshots.set(bookmark, snapPath);
      return json(envelope({ bookmark }));
    }
    if ((m = path.match(/^\/d1\/database\/([^/]+)\/time_travel\/restore$/)) && method === "POST") {
      const db = databases.get(m[1]!);
      if (!db) return failure(404, 7404, "database not found");
      const bookmark = url.searchParams.get("bookmark");
      if (!bookmark || !snapshots.has(bookmark)) return failure(404, 7404, `bookmark ${bookmark} not found`);

      // Snapshot current state before restoring, so the restore itself can be undone
      const previousBookmark = `bm_${Date.now()}_${randomUUID().slice(0, 8)}`;
      const prevPath = join(tmpDir, `${m[1]}-${previousBookmark}.sqlite`);
      db.sqlite.exec(`VACUUM INTO '${prevPath.replace(/\\/g, "/")}'`);
      snapshots.set(previousBookmark, prevPath);

      // Restore
      const snapPath = snapshots.get(bookmark)!;
      db.sqlite.close();
      const currentPath = join(tmpDir, `${m[1]}-current-${Date.now()}-${randomUUID().slice(0, 8)}.sqlite`);
      copyFileSync(snapPath, currentPath);
      db.sqlite = new DatabaseSync(currentPath);

      return json(envelope({ previous_bookmark: previousBookmark }));
    }

    // ---- Workers
    if (path === "/workers/scripts" && method === "GET") return paged([...scripts.values()].map((s) => ({ id: s.name })), url);
    if ((m = path.match(/^\/workers\/scripts\/([^/]+)$/)) && method === "PUT") {
      const name = decodeURIComponent(m[1]!);
      if (opts.refuseAllUploads) return failure(400, 10021, "simulated: every upload is refused");
      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        return failure(400, 10021, "the upload is not valid multipart form data");
      }
      const metaPart = form.get("metadata");
      if (metaPart === null) return failure(400, 10021, "the upload has no metadata part");
      let metadata: { main_module?: string; bindings?: Array<Record<string, unknown>>; compatibility_date?: string };
      try {
        metadata = JSON.parse(typeof metaPart === "string" ? metaPart : await (metaPart as Blob).text());
      } catch {
        return failure(400, 10021, "the metadata part is not JSON");
      }
      if (typeof metadata.main_module !== "string") return failure(400, 10021, "metadata.main_module is missing");
      const modulePart = form.get(metadata.main_module);
      if (modulePart === null) return failure(400, 10021, `the module ${metadata.main_module} named in main_module was not uploaded`);
      const code = typeof modulePart === "string" ? modulePart : await (modulePart as Blob).text();
      if (opts.maxScriptBytes !== undefined && Buffer.byteLength(code) > opts.maxScriptBytes) return failure(400, 10027, "The uncompressed script exceeds the size limit");
      if (typeof metadata.compatibility_date !== "string") return failure(400, 10021, "metadata.compatibility_date is missing");
      const bindings = metadata.bindings ?? [];
      const names = new Set<string>();
      for (const b of bindings) {
        if (typeof b.name !== "string" || typeof b.type !== "string") return failure(400, 10021, "a binding needs a name and a type");
        if (names.has(b.name)) return failure(400, 10021, `binding ${b.name} is declared twice`);
        names.add(b.name);
        if (b.type === "d1" && !databases.has(String(b.database_id))) return failure(400, 10021, `binding ${b.name}: no D1 database with that id`);
        if (b.type === "secret_text" && (typeof b.text !== "string" || b.text === "")) return failure(400, 10021, `binding ${b.name}: a secret needs text`);
        if (b.type === "workflow") {
          if (opts.refuseWorkflowBindings) return failure(400, 10021, "simulated: binding type workflow is not accepted in this upload");
          if (typeof b.workflow_name !== "string" || typeof b.class_name !== "string") return failure(400, 10021, `binding ${b.name}: a workflow binding needs workflow_name and class_name`);
          if (!code.includes(b.class_name)) return failure(400, 10021, `binding ${b.name}: the script does not export a class named ${b.class_name}`);
        }
      }
      const existing = scripts.get(name);
      versionCounter += 1;
      const versionId = `ver-${String(versionCounter).padStart(6, "0")}-${sha(code + JSON.stringify(bindings.map((b) => ({ ...b, text: undefined })))).slice(0, 8)}`;
      // keep_bindings (documented upload metadata): binding types of the current Worker kept when the upload does not name them.
      const keepList = (metadata as { keep_bindings?: unknown }).keep_bindings;
      const keepTypes = new Set(Array.isArray(keepList) ? keepList.map(String) : []);
      const kept = (existing?.bindings ?? []).filter((b) => keepTypes.has(String(b.type)) && !names.has(String(b.name)));
      const storedBindings = [...bindings.map((b) => (b.type === "secret_text" ? { ...b, text: "[stored]" } : b)), ...kept];
      if (existing && keepTypes.size === 0) secretValues.delete(name);
      for (const b of bindings) {
        if (b.type !== "secret_text" || typeof b.text !== "string") continue;
        if (!secretValues.has(name)) secretValues.set(name, new Map());
        secretValues.get(name)!.set(String(b.name), b.text);
      }
      const version: ScriptVersion = { id: versionId, number: (existing?.versions.length ?? 0) + 1, createdOn: new Date().toISOString(), code, bindings: storedBindings, metadata };
      const script: Script = existing ?? { name, code, bindings, versions: [], deployments: [], addressEnabled: false };
      script.code = code;
      script.bindings = storedBindings; // a stored secret is never read back
      script.versions.unshift(version);
      script.deployments.unshift({
        id: `dep-${randomUUID().slice(0, 8)}`,
        created_on: new Date().toISOString(),
        strategy: "percentage",
        versions: [{ version_id: version.id, percentage: 100 }],
      });
      scripts.set(name, script);
      // Found on the real service: uploading a Worker with a Workflow binding does NOT register the Workflow. The binding
      // just names one; PUT /workflows/{name} (below) is what creates it.
      return json(envelope({ id: name, etag: sha(code), startup_time_ms: 7, has_modules: true, handlers: ["fetch"] }));
    }
    if ((m = path.match(/^\/workers\/scripts\/([^/]+)\/versions$/)) && method === "POST") {
      const name = decodeURIComponent(m[1]!);
      if (opts.refuseAllUploads) return failure(400, 10021, "simulated: every upload is refused");
      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        return failure(400, 10021, "the upload is not valid multipart form data");
      }
      const metaPart = form.get("metadata");
      if (metaPart === null) return failure(400, 10021, "the upload has no metadata part");
      let metadata: { main_module?: string; bindings?: Array<Record<string, unknown>>; compatibility_date?: string };
      try {
        metadata = JSON.parse(typeof metaPart === "string" ? metaPart : await (metaPart as Blob).text());
      } catch {
        return failure(400, 10021, "the metadata part is not JSON");
      }
      if (typeof metadata.main_module !== "string") return failure(400, 10021, "metadata.main_module is missing");
      const modulePart = form.get(metadata.main_module);
      if (modulePart === null) return failure(400, 10021, `the module ${metadata.main_module} named in main_module was not uploaded`);
      const code = typeof modulePart === "string" ? modulePart : await (modulePart as Blob).text();
      if (opts.maxScriptBytes !== undefined && Buffer.byteLength(code) > opts.maxScriptBytes) return failure(400, 10027, "The uncompressed script exceeds the size limit");
      if (typeof metadata.compatibility_date !== "string") return failure(400, 10021, "metadata.compatibility_date is missing");
      const bindings = metadata.bindings ?? [];
      const script = scripts.get(name);
      if (!script) return failure(404, 10007, "This Worker does not exist on your account");

      versionCounter += 1;
      const versionId = `ver-${String(versionCounter).padStart(6, "0")}-${sha(code + JSON.stringify(bindings.map((b) => ({ ...b, text: undefined })))).slice(0, 8)}`;
      const version: ScriptVersion = {
        id: versionId,
        number: script.versions.length + 1,
        createdOn: new Date().toISOString(),
        code,
        bindings: bindings.map((b) => (b.type === "secret_text" ? { ...b, text: "[stored]" } : b)),
        metadata,
      };
      script.versions.unshift(version);
      return json(envelope({ id: version.id, number: version.number, metadata: { created_on: version.createdOn } }));
    }
    if ((m = path.match(/^\/workers\/scripts\/([^/]+)\/deployments$/)) && method === "POST") {
      const name = decodeURIComponent(m[1]!);
      const script = scripts.get(name);
      if (!script) return failure(404, 10007, "This Worker does not exist on your account");
      const body = (await request.json().catch(() => null)) as {
        strategy?: string;
        versions?: Array<{ version_id?: string; percentage?: number }>;
      } | null;
      if (!body || !Array.isArray(body.versions) || body.versions.length === 0) {
        return failure(400, 10021, "versions array is required");
      }
      const hasWorkflow = script.bindings.some((b) => b.type === "workflow") ||
        [...workflows.values()].some((w) => w.script === name);
      const isGradualSplit = body.versions.length > 1 || (body.versions[0]?.percentage !== 100);
      if (hasWorkflow && isGradualSplit) {
        return failure(400, 10021, "Gradual deployments are not supported for scripts with Workflow bindings");
      }
      const depId = `dep-${randomUUID().slice(0, 8)}`;
      const dep: Deployment = {
        id: depId,
        created_on: new Date().toISOString(),
        strategy: "percentage",
        versions: body.versions.map((v) => ({
          version_id: String(v.version_id),
          percentage: Number(v.percentage),
        })),
      };
      script.deployments.unshift(dep);
      const topVersion = [...dep.versions].sort((a, b) => b.percentage - a.percentage)[0];
      if (topVersion) {
        const vObj = script.versions.find((v) => v.id === topVersion.version_id);
        if (vObj) script.code = vObj.code;
      }
      return json(envelope(dep));
    }
    if ((m = path.match(/^\/workers\/scripts\/([^/]+)\/deployments$/)) && method === "GET") {
      const name = decodeURIComponent(m[1]!);
      const script = scripts.get(name);
      if (!script) return failure(404, 10007, "This Worker does not exist on your account");
      return json(envelope({ deployments: script.deployments }));
    }
    if ((m = path.match(/^\/workers\/scripts\/([^/]+)$/)) && method === "DELETE") {
      const name = decodeURIComponent(m[1]!);
      if (!scripts.has(name)) return failure(404, 10007, "This Worker does not exist on your account");
      scripts.delete(name);
      for (const [key, w] of workflows) if (w.script === name) workflows.delete(key);
      return json(envelope({ id: name }));
    }
    if ((m = path.match(/^\/workers\/scripts\/([^/]+)\/versions$/)) && method === "GET") {
      const script = scripts.get(decodeURIComponent(m[1]!));
      if (!script) return failure(404, 10007, "This Worker does not exist on your account");
      const shape = opts.versionAnnotations ?? "metadata";
      const items = script.versions.map((v) => {
        const annotations = (v.metadata?.annotations as Record<string, unknown> | undefined) ?? {};
        if (shape === "top-level") return { id: v.id, number: v.number, annotations, metadata: { created_on: v.createdOn, source: "api" } };
        if (shape === "detail-only") return { id: v.id, number: v.number, metadata: { created_on: v.createdOn, source: "api" } };
        return { id: v.id, number: v.number, metadata: { created_on: v.createdOn, source: "api", annotations, ...(v.metadata ?? {}) } };
      });
      const per = Math.min(Number(url.searchParams.get("per_page") ?? items.length) || items.length, opts.maxPerPage ?? Number.MAX_SAFE_INTEGER);
      const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
      if (!(url.searchParams.has("page") || opts.maxPerPage)) return json(envelope({ items }));
      return json({ ...envelope({ items: items.slice((page - 1) * per, page * per) }), result_info: { page, per_page: per, count: Math.min(per, Math.max(0, items.length - (page - 1) * per)), total_count: items.length, total_pages: Math.max(1, Math.ceil(items.length / per)) } });
    }
    if ((m = path.match(/^\/workers\/scripts\/([^/]+)\/versions\/([^/]+)$/)) && method === "GET") {
      const script = scripts.get(decodeURIComponent(m[1]!));
      const v = script?.versions.find((x) => x.id === decodeURIComponent(m![2]!));
      if (!v) return failure(404, 10007, "version not found");
      return json(envelope({ id: v.id, number: v.number, metadata: { created_on: v.createdOn, annotations: (v.metadata?.annotations as Record<string, unknown> | undefined) ?? {} } }));
    }
    if ((m = path.match(/^\/workers\/scripts\/([^/]+)\/secrets$/)) && method === "PUT") {
      const name = decodeURIComponent(m[1]!);
      const script = scripts.get(name);
      if (!script) return failure(404, 10007, "This Worker does not exist on your account");
      const body = (await request.json().catch(() => null)) as { name?: unknown; text?: unknown; type?: unknown } | null;
      if (!body || typeof body.name !== "string" || typeof body.text !== "string" || body.text === "" || body.type !== "secret_text") return failure(400, 10021, "a secret needs name, text and type secret_text");
      const secretName = body.name;
      script.bindings = [...script.bindings.filter((b) => b.name !== secretName), { type: "secret_text", name: secretName, text: "[stored]" }];
      if (!secretValues.has(name)) secretValues.set(name, new Map());
      secretValues.get(name)!.set(secretName, body.text);
      return json(envelope({ name: secretName, type: "secret_text" }));
    }
    if ((m = path.match(/^\/workers\/scripts\/([^/]+)\/secrets\/([^/]+)$/)) && method === "DELETE") {
      const name = decodeURIComponent(m[1]!);
      const secretName = decodeURIComponent(m[2]!);
      const script = scripts.get(name);
      if (!script || !script.bindings.some((b) => b.type === "secret_text" && b.name === secretName)) return failure(404, 10056, "secret not found");
      script.bindings = script.bindings.filter((b) => !(b.type === "secret_text" && b.name === secretName));
      secretValues.get(name)?.delete(secretName);
      return json(envelope({}));
    }
    if ((m = path.match(/^\/workers\/scripts\/([^/]+)\/schedules$/))) {
      const script = scripts.get(decodeURIComponent(m[1]!));
      if (!script) return failure(404, 10007, "This Worker does not exist on your account");
      if (method === "GET") return json(envelope({ schedules: (script.schedules ?? []).map((cron) => ({ cron })) }));
      if (method === "PUT") {
        const body = (await request.json().catch(() => null)) as Array<{ cron?: unknown }> | null;
        if (!Array.isArray(body) || body.some((s) => typeof s?.cron !== "string")) return failure(400, 10021, "schedules must be a list of {cron}");
        script.schedules = body.map((s) => String(s.cron));
        return json(envelope({ schedules: script.schedules.map((cron) => ({ cron })) }));
      }
    }
    if ((m = path.match(/^\/workers\/scripts\/([^/]+)\/settings$/)) && method === "GET") {
      const script = scripts.get(decodeURIComponent(m[1]!));
      if (!script) return failure(404, 10007, "This Worker does not exist on your account");
      // like the real service, a stored secret is reported by name and type only
      return json(envelope({ bindings: script.bindings.map((b) => (b.type === "secret_text" ? { type: b.type, name: b.name } : b)) }));
    }
    if ((m = path.match(/^\/workers\/scripts\/([^/]+)\/subdomain$/))) {
      const script = scripts.get(decodeURIComponent(m[1]!));
      if (!script) return failure(404, 10007, "This Worker does not exist on your account");
      if (method === "GET") return json(envelope({ enabled: script.addressEnabled, previews_enabled: false }));
      if (method === "POST") {
        const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
        if (!body || typeof body.enabled !== "boolean") return failure(400, 10021, "enabled must be true or false");
        if (subdomain === null) return failure(400, 10007, "this account has no workers.dev subdomain");
        script.addressEnabled = body.enabled;
        return json(envelope({ enabled: script.addressEnabled, previews_enabled: false }));
      }
    }

    // ---- Queues (shapes from the documentation; not checked against the real service)
    if (path === "/queues" && method === "GET") {
      if (opts.queuesUnavailable) return failure(opts.queuesUnavailable, 11000, "Queues is not available on this account");
      return paged([...queues.values()].map((q) => ({ queue_id: q.id, queue_name: q.name, created_on: q.created })), url);
    }
    if (path === "/queues" && method === "POST") {
      const body = (await request.json().catch(() => null)) as { queue_name?: unknown } | null;
      if (!body || typeof body.queue_name !== "string" || body.queue_name === "") return failure(400, 11000, "queue_name is required");
      const queueName = body.queue_name;
      if ([...queues.values()].some((q) => q.name === queueName)) return failure(409, 11009, "A queue with this name already exists");
      const q = { id: randomUUID().replace(/-/g, ""), name: queueName, created: new Date().toISOString() };
      queues.set(q.id, q);
      return json(envelope({ queue_id: q.id, queue_name: q.name, created_on: q.created }));
    }
    if ((m = path.match(/^\/queues\/([^/]+)$/)) && method === "DELETE") {
      if (!queues.delete(decodeURIComponent(m[1]!))) return failure(404, 11001, "queue not found");
      return json(envelope({}));
    }

    // ---- Workflows (shapes confirmed on the real service 2026-10-21: list, PUT, GET details; delete is still a guess)
    if ((m = path.match(/^\/workflows\/([^/]+)\/instances\/([^/]+)$/)) && method === "GET") {
      const details = await opts.instanceDetails?.(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
      return details ? json(envelope(details)) : failure(404, 10200, "workflows.api.error.instance.not_found");
    }
    if ((m = path.match(/^\/workflows\/([^/]+)$/)) && method === "PUT") {
      const name = decodeURIComponent(m[1]!);
      const body = (await request.json().catch(() => null)) as { class_name?: unknown; script_name?: unknown } | null;
      if (!body || typeof body.class_name !== "string" || body.class_name === "" || typeof body.script_name !== "string" || body.script_name === "") return failure(400, 10201, "class_name and script_name are required");
      const script = scripts.get(body.script_name);
      if (!script) return failure(404, 10007, "This Worker does not exist on your account");
      if (!script.code.includes(body.class_name)) return failure(400, 10201, `the script does not export a class named ${body.class_name}`);
      const existing = workflows.get(name);
      workflows.set(name, { name, className: body.class_name, script: body.script_name });
      return json(envelope({ id: existing ? "existing-workflow-id" : "new-workflow-id", name, class_name: body.class_name, script_name: body.script_name, created_on: new Date().toISOString(), modified_on: new Date().toISOString() }));
    }
    if (path === "/workflows" && method === "GET") return paged([...workflows.values()].map((w) => ({ name: w.name, class_name: w.className, script_name: w.script })), url);
    if ((m = path.match(/^\/workflows\/([^/]+)$/)) && method === "DELETE") {
      if (!workflows.delete(decodeURIComponent(m[1]!))) return failure(404, 10007, "workflow not found");
      return json(envelope({}));
    }

    return failure(404, 7003, `No route for ${method} ${path}`);
  }

  return {
    fetch: (request: Request) => handle(request),
    requests,
    /** The raw text of every request body, in order. */
    bodies,
    /** Arranges for matching requests to fail, for the next `times` matches (default: every match). */
    fail(fault: Fault) {
      faults.push({ ...fault, used: 0 });
    },
    clearFaults() {
      faults.length = 0;
    },
    setSubdomain(next: string | null) {
      subdomain = next;
    },
    set(next: Partial<Pick<FakeOptions, "refuseWorkflowBindings" | "refuseAllUploads" | "maxScriptBytes" | "tokenStatus" | "accountName" | "tokenKind" | "maxPerPage" | "queuesUnavailable" | "versionAnnotations">>) {
      Object.assign(opts, next);
    },
    /** Reads the fake's own state directly, so tests can judge a deploy without going through the provisioner. */
    state() {
      return {
        databases: [...databases.values()].map((d) => ({
          uuid: d.uuid,
          name: d.name,
          tables: (d.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name),
        })),
        scripts: [...scripts.values()].map((s) => ({ name: s.name, versionIds: s.versions.map((v) => v.id), addressEnabled: s.addressEnabled, bindingTypes: s.bindings.map((b) => String(b.type)), codeSha256: sha(s.code) })),
        workflows: [...workflows.values()],
      };
    },
    /** The queues in the account (kept out of state() so its shape stays what older tests compare). */
    queues(): Array<{ id: string; name: string }> {
      return [...queues.values()].map((q) => ({ id: q.id, name: q.name }));
    },
    /** A secret value a Worker holds, as set by an upload or PUT .../secrets (tests only; the API never reads one back). */
    secretOf(script: string, secretName: string): string | undefined {
      return secretValues.get(script)?.get(secretName);
    },
    /** Puts a Workflow in place with no ledger entry. */
    seedWorkflow(name: string, script = "someone-elses-worker", className = "Other") {
      workflows.set(name, { name, className, script });
    },
    /** Puts a queue in place with no ledger entry. */
    seedQueue(name: string): string {
      const id = randomUUID().replace(/-/g, "");
      queues.set(id, { id, name, created: new Date().toISOString() });
      return id;
    },
    /** The code last uploaded for a Worker, so a test can run exactly what was deployed. */
    codeOf(name: string): string | undefined {
      return scripts.get(name)?.code;
    },
    /** Reads rows from a database directly. */
    rows(databaseName: string, sql: string): Array<Record<string, unknown>> {
      const db = [...databases.values()].find((d) => d.name === databaseName);
      if (!db) throw new Error(`no database ${databaseName}`);
      return db.sqlite.prepare(sql).all().map((r) => ({ ...r }));
    },
    /** Runs one statement on a database directly, as the deployed Worker itself would (tests that stand in for the Worker). */
    exec(databaseName: string, sql: string, params: unknown[] = []): void {
      const db = [...databases.values()].find((d) => d.name === databaseName);
      if (!db) throw new Error(`no database ${databaseName}`);
      db.sqlite.prepare(sql).run(...(params as SQLInputValue[]));
    },
    /** Puts a database in place with no ledger entry, as a stopped run would leave one. */
    seedDatabase(name: string): string {
      const uuid = randomUUID();
      databases.set(uuid, { uuid, name, created: new Date().toISOString(), sqlite: new DatabaseSync(":memory:") });
      return uuid;
    },
    /** Changes a Worker behind the tool's back: a new version nobody uploaded through the tool. */
    tamperWithScript(name: string) {
      const s = scripts.get(name);
      if (!s) throw new Error(`no script ${name}`);
      versionCounter += 1;
      const verId = `ver-${String(versionCounter).padStart(6, "0")}-tampered`;
      s.versions.unshift({ id: verId, number: s.versions.length + 1, createdOn: new Date().toISOString(), code: s.code, bindings: s.bindings });
    },
    seedScript(name: string, code = "// seeded") {
      versionCounter += 1;
      const verId = `ver-${String(versionCounter).padStart(6, "0")}-seed`;
      scripts.set(name, {
        name,
        code,
        bindings: [],
        versions: [{ id: verId, number: 1, createdOn: new Date().toISOString(), code, bindings: [] }],
        deployments: [{
          id: `dep-${randomUUID().slice(0, 8)}`,
          created_on: new Date().toISOString(),
          strategy: "percentage",
          versions: [{ version_id: verId, percentage: 100 }],
        }],
        addressEnabled: false,
      });
    },
    listDeployments(name: string) {
      return scripts.get(name)?.deployments ?? [];
    },
    setHealthStub(fn: (version: string, code: string, request: Request) => Response | Promise<Response>) {
      activeHealthStub = fn;
    },
    clearHealthStub() {
      activeHealthStub = undefined;
    },
  };
}
export type FakeCloudflare = ReturnType<typeof createFakeCloudflare>;
