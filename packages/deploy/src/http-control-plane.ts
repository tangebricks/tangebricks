import { splitStatements } from "@poc/sdk";
import { CloudflareApiError, createClient, sharedRequestBudget } from "./provisioner/cloudflare.ts";
import type { CallRecord, Client, RequestBudget } from "./provisioner/cloudflare.ts";
import { storedGraphKey } from "./sandbox-dispatcher.ts";
import { REQUIRED_CLOUDFLARE_PERMISSIONS } from "./target.ts";
import type {
  CloudflareApiCallRecord,
  CloudflareApiClient,
  CloudflarePermissionScope,
  CloudflareD1DatabaseState,
  CloudflareQueueState,
  CloudflareTokenCheckResult,
  CloudflareWorkerScriptState,
  CloudflareWorkflowState,
} from "./target.ts";
import { APP_WORKSPACE, GRAPH_TABLE, LATENCY_TABLE, TELEMETRY_MIGRATION } from "./worker/graph-run.ts";

// The real CloudflareApiClient: Studio's deploy path over Cloudflare's REST API (story R53 / 1.2). Every call goes through the
// provisioner's one REST client (provisioner/cloudflare.ts), so auth, retries (429 with Retry-After, GET on 5xx), error
// classes, secret redaction and the per-account request budget are the same as the proof scripts'. There is no second HTTP
// stack here: this file only maps the CloudflareApiClient interface onto that client's endpoints.
//
// What Cloudflare does not store for us, this client keeps in the project's own D1 database, in two bookkeeping tables:
// _projectx_migrations (name, sha256, applied_at), the same table the provisioner uses, and _projectx_studio_state (key,
// value: the build, code and graph hashes of the last Studio deploy, and the schedule rows). The Worker's code hash travels in
// the version annotation `workers/message` ("projectx-studio code=<hash>"), so an unchanged redeploy is recognised without
// downloading code. Endpoint shapes follow Cloudflare's v4 API documentation; where an endpoint was not yet exercised against
// the live API, the method in provisioner/cloudflare.ts says so.

export const STUDIO_STATE_TABLE = "_projectx_studio_state";
const MIGRATIONS_TABLE = "_projectx_migrations"; // same as provisioner/deploy.ts (not imported: that module is Node-side)
const DB_BINDING = "DB";
const MAIN_MODULE = "worker.mjs";
export const STUDIO_COMPATIBILITY_DATE = "2026-10-01";
const ANNOTATION_PREFIX = "projectx-studio code=";
/** How many versions without list annotations are read one by one, looking for Studio's newest annotated upload. */
const MAX_VERSION_DETAIL_READS = 25;

/** Told to the owner when the account has no workers.dev name. Studio never creates one (it is account-wide and permanent). */
export const NO_WORKERS_DEV_SUBDOMAIN_MESSAGE =
  "NO_WORKERS_DEV_SUBDOMAIN: this Cloudflare account has no workers.dev subdomain yet. Enable it once in the Cloudflare dashboard (Workers & Pages > Overview > your subdomain: choose a name and save), then deploy again. Studio does not create it for you.";

/** The permission group names (Cloudflare v4 /tokens/{id} policies) that satisfy each required scope. "Edit" in the dashboard is "Write" in the API; both spellings are accepted. Not yet checked against the live API. */
export const PERMISSION_GROUP_NAMES: Record<CloudflarePermissionScope, readonly string[]> = {
  "Account Settings: Read": ["Account Settings Read", "Account Settings Write", "Account Settings Edit"],
  "Workers Scripts: Edit": ["Workers Scripts Write", "Workers Scripts Edit"],
  "D1: Edit": ["D1 Write", "D1 Edit"],
  "Queues: Edit": ["Queues Write", "Queues Edit"],
};

/** A legacy Global API Key: 37 hex characters. Refused before it is ever sent anywhere. */
const GLOBAL_API_KEY = /^[0-9a-f]{37}$/i;

/** True for a call that could have changed the account: anything but a GET, except a D1 query that only reads (as provisioner/deploy.ts isWriteCall). */
export const isHttpWriteCall = (call: CallRecord): boolean =>
  call.method !== "GET" && !(call.method === "POST" && call.sqlKind === "select" && /\/d1\/database\/[^/]+\/query$/.test(call.path));

const BOOKKEEPING_SQL = [
  `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ${STUDIO_STATE_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
];
/** The deploy's own tables (the graph rows the deployed GraphRunner reads, its scratch table, the runtime's telemetry tables). Not project migrations, so not recorded as such. */
const PLATFORM_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS ${GRAPH_TABLE} (workspace_id TEXT NOT NULL, id TEXT NOT NULL, graph TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (workspace_id, id))`,
  `CREATE TABLE IF NOT EXISTS ${LATENCY_TABLE} (id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  ...splitStatements(TELEMETRY_MIGRATION.sql),
];

export interface HttpControlPlaneOptions {
  /** How requests reach Cloudflare: global fetch in production, a fake in tests. */
  fetch: (request: Request) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  base?: string;
  /** The request budget for an account. Default: the process-wide one per account (sharedRequestBudget). */
  budgetFor?: (accountId: string) => RequestBudget;
  /** Extra values the call log and error texts must hide. */
  alsoHide?: string[];
  nowIso?: () => string;
}

export interface HttpCloudflareApiClient extends CloudflareApiClient {
  readonly kind: "http";
  /** Every REST call made, in order, as the provisioner's client recorded it (no header, no body, account id hidden). */
  readonly httpCalls: ReadonlyArray<CallRecord>;
  readonly scriptUploadCount: number;
  /** The provisioner REST client for one account and token, sharing this client's budget and call log. */
  restClient(accountId: string, token: string): Client;
}

export function createHttpCloudflareApiClient(options: HttpControlPlaneOptions): HttpCloudflareApiClient {
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const budgetFor = options.budgetFor ?? sharedRequestBudget;
  const clients = new Map<string, { client: Client; accountId: string; seen: number }>();
  const log: CloudflareApiCallRecord[] = [];
  const httpLog: CallRecord[] = [];

  const restClient = (accountId: string, token: string): Client => {
    const key = `${accountId}\u0000${token}`;
    let entry = clients.get(key);
    if (!entry) {
      const client = createClient({
        credentials: { accountId, token },
        fetch: options.fetch,
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.base ? { base: options.base } : {}),
        ...(options.alsoHide ? { alsoHide: options.alsoHide } : {}),
        budget: budgetFor(accountId),
      });
      entry = { client, accountId, seen: 0 };
      clients.set(key, entry);
    }
    return entry.client;
  };

  // The per-token clients each keep their own log; this folds new records into one append-only log, so a caller that remembers
  // `calls.length` and later slices from it sees exactly the calls made in between.
  const sync = () => {
    for (const entry of clients.values()) {
      const records = entry.client.calls;
      for (; entry.seen < records.length; entry.seen += 1) {
        const r = records[entry.seen]!;
        httpLog.push(r);
        log.push({
          method: r.method as CloudflareApiCallRecord["method"],
          path: r.path,
          accountId: "{account}",
          action: `${r.method} ${r.path}`,
          timestamp: nowIso(),
          write: isHttpWriteCall(r),
        });
      }
    }
  };

  const isStatus = (error: unknown, ...statuses: number[]) => error instanceof CloudflareApiError && statuses.includes(error.status);

  async function findDatabase(c: Client, nameOrId: string): Promise<{ uuid: string; name: string } | null> {
    const byName = (await c.listDatabases(nameOrId)).filter((d) => d.name === nameOrId);
    if (byName.length > 1) throw new Error(`${byName.length} D1 databases are named "${nameOrId}"; refusing to guess which one is meant`);
    if (byName[0]) return byName[0];
    if (!/^[0-9a-f-]{32,36}$/i.test(nameOrId)) return null;
    return (await c.listDatabases()).find((d) => d.uuid === nameOrId) ?? null;
  }

  async function readDatabaseState(c: Client, db: { uuid: string; name: string }): Promise<CloudflareD1DatabaseState> {
    const [tablesResult] = await c.queryDatabase(db.uuid, [{ sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name" }]);
    const tables = (tablesResult?.results ?? []).map((r) => String(r.name));
    const has = (t: string) => tables.includes(t);
    const reads: Array<{ sql: string }> = [];
    if (has(MIGRATIONS_TABLE)) reads.push({ sql: `SELECT name, sha256, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY rowid` });
    if (has(STUDIO_STATE_TABLE)) reads.push({ sql: `SELECT key, value FROM ${STUDIO_STATE_TABLE}` });
    if (has(GRAPH_TABLE)) reads.push({ sql: `SELECT workspace_id, id, graph, updated_at FROM ${GRAPH_TABLE}` });
    const results = reads.length > 0 ? await c.queryDatabase(db.uuid, reads) : [];
    let i = 0;
    const migrations = has(MIGRATIONS_TABLE) ? (results[i++]?.results ?? []) : [];
    const stateRows = has(STUDIO_STATE_TABLE) ? (results[i++]?.results ?? []) : [];
    const graphRows = has(GRAPH_TABLE) ? (results[i++]?.results ?? []) : [];
    const state = new Map(stateRows.map((r) => [String(r.key), String(r.value)]));
    const graphs: CloudflareD1DatabaseState["graphs"] = {};
    for (const row of graphRows) {
      const workspaceId = String(row.workspace_id);
      graphs[storedGraphKey(workspaceId, String(row.id))] = { graph: String(row.graph), updatedAt: String(row.updated_at), workspaceId };
    }
    let schedules: Array<Record<string, unknown>> = [];
    try {
      schedules = JSON.parse(state.get("schedules") ?? "[]") as Array<Record<string, unknown>>;
    } catch {
      schedules = [];
    }
    return {
      uuid: db.uuid,
      name: db.name,
      appliedMigrations: migrations.map((m) => ({ name: String(m.name), sha256: String(m.sha256), appliedAt: String(m.applied_at) })),
      graphs,
      schedules,
      ...(state.get("graph_hash") ? { graphHash: state.get("graph_hash")! } : {}),
      ...(state.get("build_hash") ? { buildHash: state.get("build_hash")! } : {}),
      ...(state.get("code_hash") ? { codeHash: state.get("code_hash")! } : {}),
      tables,
    };
  }

  async function databaseIdOf(c: Client, nameOrId: string): Promise<string> {
    const db = await findDatabase(c, nameOrId);
    if (!db) throw new Error(`D1 database "${nameOrId}" was not found in the account`);
    return db.uuid;
  }

  const upsertState = (key: string, value: string) => ({
    sql: `INSERT INTO ${STUDIO_STATE_TABLE} (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    params: [key, value, nowIso()],
  });

  const client: HttpCloudflareApiClient = {
    kind: "http",
    get calls() {
      sync();
      return log;
    },
    get httpCalls() {
      sync();
      return httpLog;
    },
    get scriptUploadCount() {
      sync();
      return httpLog.filter((r) => r.method === "PUT" && /^\/accounts\/\{account\}\/workers\/scripts\/[^/]+$/.test(r.path.split("?")[0]!)).length;
    },
    restClient,

    async verifyTokenAndPermissions(accountId, token): Promise<CloudflareTokenCheckResult> {
      const trimmed = token.trim();
      const none = (message: string) =>
        Object.fromEntries(REQUIRED_CLOUDFLARE_PERMISSIONS.map((scope) => [scope, { granted: false, message }])) as CloudflareTokenCheckResult["permissions"];
      const refused = (status: CloudflareTokenCheckResult["status"], message: string, isGlobalApiKey = false): CloudflareTokenCheckResult => ({
        valid: false,
        tokenId: null,
        status,
        expiresOn: null,
        isGlobalApiKey,
        account: null,
        permissions: none(message),
        missingPermissions: [...REQUIRED_CLOUDFLARE_PERMISSIONS],
      });
      if (GLOBAL_API_KEY.test(trimmed)) return refused("invalid", "Over-broad Global API Key rejected; create a scoped API token instead.", true);
      if (!/^[0-9a-f]{32}$/i.test(accountId)) return refused("invalid", "The Cloudflare account id must be 32 hexadecimal characters.");

      const c = restClient(accountId, trimmed);
      let verified: { status: string; id?: string; expiresOn?: string; kind: "account" | "user" };
      try {
        verified = await c.verifyToken(); // GET /accounts/{id}/tokens/verify, then /user/tokens/verify for a user token
      } catch (error) {
        // Cloudflare does not know this token for this account (revoked, deleted, another account's, or not a token at all).
        // Anything else (5xx, network, malformed) propagates: Cloudflare was unreachable, which is not a verdict on the token.
        if (isStatus(error, 400, 401, 403)) return refused("invalid", "Cloudflare did not accept this token for this account.");
        throw error;
      }
      const status: CloudflareTokenCheckResult["status"] =
        verified.status === "active" || verified.status === "disabled" || verified.status === "expired" ? verified.status : "invalid";
      if (status !== "active") {
        return { ...refused(status, `Cloudflare reports this token as ${verified.status}.`), tokenId: verified.id ?? null, expiresOn: verified.expiresOn ?? null };
      }

      const permissions = {} as CloudflareTokenCheckResult["permissions"];
      const missingPermissions: CloudflarePermissionScope[] = [];
      let groups: string[] | null = null;
      // A user token (My Profile) cannot be read at /accounts/{id}/tokens/{id}: its capabilities are checked with reads below.
      if (verified.id && verified.kind === "account") {
        try {
          groups = await c.getTokenPermissions(verified.id); // GET /accounts/{id}/tokens/{token_id}: most scoped tokens may not read themselves
        } catch (error) {
          if (!(error instanceof CloudflareApiError)) throw error;
          groups = null;
        }
      }
      let verifiedBy: "policies" | "read-probe" = "policies";
      if (groups) {
        for (const scope of REQUIRED_CLOUDFLARE_PERMISSIONS) {
          const granted = PERMISSION_GROUP_NAMES[scope].some((name) => groups!.includes(name));
          if (!granted) missingPermissions.push(scope);
          permissions[scope] = granted ? { granted, confirmed: true } : { granted, message: `Missing "${scope}" permission on this token (its policies list: ${groups.join(", ") || "none"}).` };
        }
      } else {
        verifiedBy = "read-probe";
        // The token cannot read its own policies: each capability is checked with a harmless read instead. A read proves the
        // permission group is present; it cannot prove "Edit" without writing, so the report says which reads were refused.
        const probes: Record<CloudflarePermissionScope, () => Promise<unknown>> = {
          "Account Settings: Read": () => c.getAccount(),
          "Workers Scripts: Edit": () => c.listScripts(),
          "D1: Edit": () => c.listDatabases(),
          "Queues: Edit": () => c.listQueues(),
        };
        for (const scope of REQUIRED_CLOUDFLARE_PERMISSIONS) {
          const isEdit = scope.endsWith(": Edit");
          try {
            await probes[scope]();
            // A read proves the permission group is there with at least Read; Edit is confirmed only by the first deploy.
            permissions[scope] = isEdit
              ? { granted: true, confirmed: false, message: `Read access confirmed; "${scope}" will be confirmed by the first deploy (a token that cannot read its own policies is checked with reads only).` }
              : { granted: true, confirmed: true };
          } catch (error) {
            missingPermissions.push(scope);
            if (isStatus(error, 401, 403)) {
              permissions[scope] = { granted: false, message: `Missing "${scope}" permission on this token: Cloudflare refused a read that needs it.` };
            } else if (isStatus(error, 400, 404)) {
              // Not an outage: the account answered, and this capability is not available to it (for example Queues not enabled).
              permissions[scope] = { granted: false, message: `"${scope}" is unavailable: Cloudflare answered ${(error as CloudflareApiError).status} to a read of it (the product may not be enabled on this account).` };
            } else throw error;
          }
        }
      }

      let accountName = "Cloudflare account";
      if (permissions["Account Settings: Read"]?.granted) {
        try {
          accountName = (await c.getAccount()).name;
        } catch (error) {
          if (!(error instanceof CloudflareApiError)) throw error;
        }
      }
      let subdomain: string | null = null;
      try {
        subdomain = await c.getAccountSubdomain();
      } catch (error) {
        if (!(error instanceof CloudflareApiError)) throw error;
      }
      return {
        verifiedBy,
        valid: missingPermissions.length === 0,
        tokenId: verified.id ?? null,
        status: "active",
        expiresOn: verified.expiresOn ?? null,
        isGlobalApiKey: false,
        account: { id: accountId.toLowerCase(), name: accountName, subdomain },
        permissions,
        missingPermissions,
      };
    },

    async getScript(accountId, token, scriptName, options): Promise<CloudflareWorkerScriptState | null> {
      const c = restClient(accountId, token);
      const versions = await c.listVersions(scriptName);
      if (versions === null) return null;
      const latest = versions[0];
      const bindings = (await c.getScriptBindings(scriptName)) ?? [];
      const crons = (await c.getSchedules(scriptName)) ?? [];
      // Where the annotation is: the version's own `annotations` at the top level, or `metadata.annotations` (the client's
      // listVersions folds both into `annotations`). Neither list shape is yet checked against the live API, so a version whose
      // list entry carries no annotations at all is read again through its detail (GET .../versions/{id}, also unverified live).
      const annotationsOf = (v: { annotations?: Record<string, unknown>; metadata?: Record<string, unknown> }) =>
        v.annotations ?? (v.metadata?.annotations as Record<string, unknown> | undefined);
      const messageOf = (annotations: Record<string, unknown> | undefined) =>
        typeof annotations?.["workers/message"] === "string" ? (annotations["workers/message"] as string) : "";
      // Fail-safe: the code is the newest Studio-annotated upload ONLY if every newer version is one Studio itself made (its
      // secret puts, whose ids Studio records: options.trustedVersionIds). A newer version without the annotation that Studio
      // did not make (a `wrangler deploy`, a dashboard edit) makes the code unknown, which is never "unchanged" and shows as
      // drift. No version metadata is taken as proof of a secret-only change: no such marker is checked against the live API.
      const trusted = new Set(options?.trustedVersionIds ?? []);
      let codeHash: string | undefined;
      let detailReads = 0;
      for (const v of versions) {
        let annotations = annotationsOf(v);
        if (annotations === undefined && detailReads < MAX_VERSION_DETAIL_READS) {
          detailReads += 1;
          annotations = annotationsOf((await c.getVersion(scriptName, v.id)) ?? {});
        }
        const message = messageOf(annotations);
        if (message.startsWith(ANNOTATION_PREFIX)) {
          codeHash = message.slice(ANNOTATION_PREFIX.length).trim();
          break;
        }
        if (!trusted.has(v.id)) break; // an unannotated version Studio did not make: unknown code
      }
      return {
        scriptName,
        versionId: latest?.id ?? "",
        sha256: codeHash ?? "",
        ...(codeHash ? { codeHash } : {}),
        code: "", // Cloudflare does not hand code back through these reads; the annotation carries its hash
        bindings: bindings.map((b) => ({ ...b })),
        cronTriggers: crons,
        secrets: bindings.filter((b) => b.type === "secret_text" || b.type === "secret_key").map((b) => b.name),
        updatedAt: nowIso(),
      };
    },

    async getWorkersSubdomain(accountId, token) {
      return restClient(accountId, token).getAccountSubdomain();
    },

    async listScriptVersionIds(accountId, token, scriptName) {
      const versions = await restClient(accountId, token).listVersions(scriptName);
      return versions === null ? null : versions.map((v) => v.id);
    },

    async putScript(accountId, token, scriptName, input) {
      const c = restClient(accountId, token);
      const subdomain = await c.getAccountSubdomain();
      if (subdomain === null) throw new Error(NO_WORKERS_DEV_SUBDOMAIN_MESSAGE);
      const bindings: Array<Record<string, unknown>> = [
        ...(input.databaseId ? [{ type: "d1", name: DB_BINDING, database_id: input.databaseId }] : []),
        ...(input.deployBindings ?? []),
      ];
      const seen = new Set<string>();
      for (const b of bindings) {
        if (b.type === "secret_text") throw new Error(`binding ${String(b.name)}: secrets are set with putScriptSecret, never in an upload's metadata`);
        if (seen.has(String(b.name))) throw new Error(`binding ${String(b.name)} is declared twice`);
        seen.add(String(b.name));
      }
      await c.uploadScript(scriptName, {
        mainModule: MAIN_MODULE,
        code: input.code,
        metadata: {
          compatibility_date: input.compatibilityDate ?? STUDIO_COMPATIBILITY_DATE,
          ...(input.compatibilityFlags && input.compatibilityFlags.length > 0 ? { compatibility_flags: input.compatibilityFlags } : {}),
          bindings,
          // Secrets were set separately (PUT .../secrets) and are kept by type across uploads; the upload never carries them.
          keep_bindings: ["secret_text", "secret_key"],
          annotations: { "workers/message": `${ANNOTATION_PREFIX}${input.sha256}` },
        },
      });
      const versions = await c.listVersions(scriptName);
      const versionId = versions?.[0]?.id;
      if (!versionId) throw new Error(`the Worker ${scriptName} was uploaded but Cloudflare lists no version for it`);
      const address = await c.getScriptSubdomain(scriptName);
      if (address === null || !address.enabled) await c.setScriptSubdomain(scriptName, true);
      return { scriptName, versionId, sha256: input.sha256, url: `https://${scriptName}.${subdomain}.workers.dev` };
    },

    async deleteScript(accountId, token, scriptName) {
      try {
        await restClient(accountId, token).deleteScript(scriptName);
      } catch (error) {
        if (!isStatus(error, 404)) throw error;
      }
    },

    async putScriptSecret(accountId, token, scriptName, secretName, secretValue) {
      const put = await restClient(accountId, token).putScriptSecret(scriptName, secretName, secretValue);
      return { name: secretName, type: "secret_text" as const, ...(put.versionId ? { versionId: put.versionId } : {}) };
    },

    async deleteScriptSecret(accountId, token, scriptName, secretName) {
      try {
        await restClient(accountId, token).deleteScriptSecret(scriptName, secretName);
      } catch (error) {
        if (!isStatus(error, 404)) throw error;
      }
    },

    async putCronTriggers(accountId, token, scriptName, crons) {
      return restClient(accountId, token).putSchedules(scriptName, crons);
    },

    async listDatabases(accountId, token) {
      return restClient(accountId, token).listDatabases();
    },

    async getDatabase(accountId, token, nameOrId) {
      const c = restClient(accountId, token);
      const db = await findDatabase(c, nameOrId);
      return db ? readDatabaseState(c, db) : null;
    },

    async ensureDatabase(accountId, token, name) {
      const c = restClient(accountId, token);
      const existing = await findDatabase(c, name);
      if (existing) return readDatabaseState(c, existing);
      const created = await c.createDatabase(name);
      await c.queryDatabase(created.uuid, [...BOOKKEEPING_SQL, ...PLATFORM_TABLES_SQL].map((sql) => ({ sql })));
      return readDatabaseState(c, created);
    },

    async deleteDatabase(accountId, token, databaseId) {
      const c = restClient(accountId, token);
      const db = await findDatabase(c, databaseId);
      if (!db) return;
      try {
        await c.deleteDatabase(db.uuid);
      } catch (error) {
        if (!isStatus(error, 404)) throw error;
      }
    },

    async applyDatabaseMigration(accountId, token, databaseId, migration) {
      const c = restClient(accountId, token);
      const id = await databaseIdOf(c, databaseId);
      // One atomic batch: the migration and its record land together or not at all.
      await c.queryDatabase(id, [
        ...BOOKKEEPING_SQL.map((sql) => ({ sql })),
        ...splitStatements(migration.sql).map((sql) => ({ sql })),
        { sql: `INSERT INTO ${MIGRATIONS_TABLE} (name, sha256, applied_at) VALUES (?, ?, ?)`, params: [migration.name, migration.sha256, nowIso()] },
      ]);
    },

    async getD1Bookmark(accountId, token, databaseId) {
      const c = restClient(accountId, token);
      return c.getD1Bookmark(await databaseIdOf(c, databaseId));
    },

    async restoreD1(accountId, token, databaseId, bookmark) {
      const c = restClient(accountId, token);
      return c.restoreD1(await databaseIdOf(c, databaseId), bookmark);
    },

    async putStoredGraph(accountId, token, databaseId, workspaceId, graphId, graphJson) {
      const c = restClient(accountId, token);
      const id = await databaseIdOf(c, databaseId);
      const updatedAt = nowIso();
      await c.queryDatabase(id, [
        { sql: PLATFORM_TABLES_SQL[0]! },
        {
          sql: `INSERT INTO ${GRAPH_TABLE} (workspace_id, id, graph, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, id) DO UPDATE SET graph = excluded.graph, updated_at = excluded.updated_at`,
          params: [workspaceId || APP_WORKSPACE, graphId, graphJson, updatedAt],
        },
      ]);
      return { graphId, updatedAt };
    },

    async putScheduleRows(accountId, token, databaseId, schedules) {
      const c = restClient(accountId, token);
      const id = await databaseIdOf(c, databaseId);
      await c.queryDatabase(id, [...BOOKKEEPING_SQL.map((sql) => ({ sql })), upsertState("schedules", JSON.stringify(schedules))]);
      return { count: schedules.length, updatedAt: nowIso() };
    },

    async recordDeployState(accountId, token, _scriptName, databaseName, meta) {
      const c = restClient(accountId, token);
      const db = await findDatabase(c, databaseName);
      if (!db) return;
      const writes = [
        ...(meta.buildHash !== undefined ? [upsertState("build_hash", meta.buildHash)] : []),
        ...(meta.codeHash !== undefined ? [upsertState("code_hash", meta.codeHash)] : []),
        ...(meta.graphHash !== undefined ? [upsertState("graph_hash", meta.graphHash)] : []),
      ];
      if (writes.length === 0) return;
      await c.queryDatabase(db.uuid, [...BOOKKEEPING_SQL.map((sql) => ({ sql })), ...writes]);
    },

    async listQueues(accountId, token): Promise<CloudflareQueueState[]> {
      return (await restClient(accountId, token).listQueues()).map((q) => ({ queueId: q.id, queueName: q.name, createdAt: "" }));
    },

    async ensureQueue(accountId, token, queueName) {
      const c = restClient(accountId, token);
      const existing = (await c.listQueues()).find((q) => q.name === queueName);
      const queue = existing ?? (await c.createQueue(queueName));
      return { queueId: queue.id, queueName: queue.name, createdAt: "" };
    },

    async deleteQueue(accountId, token, queueName) {
      const c = restClient(accountId, token);
      const existing = (await c.listQueues()).find((q) => q.name === queueName);
      if (!existing) return;
      try {
        await c.deleteQueue(existing.id);
      } catch (error) {
        if (!isStatus(error, 404)) throw error;
      }
    },

    async listWorkflows(accountId, token): Promise<CloudflareWorkflowState[]> {
      return (await restClient(accountId, token).listWorkflowDefinitions()).map((w) => ({ name: w.name, className: w.className, scriptName: w.scriptName, updatedAt: "" }));
    },

    async putWorkflow(accountId, token, workflowName, definition) {
      await restClient(accountId, token).putWorkflow(workflowName, definition);
      return { name: workflowName, className: definition.className, scriptName: definition.scriptName, updatedAt: nowIso() };
    },

    async deleteWorkflow(accountId, token, workflowName) {
      try {
        await restClient(accountId, token).deleteWorkflow(workflowName);
      } catch (error) {
        if (!isStatus(error, 404)) throw error;
      }
    },
  };
  return client;
}
