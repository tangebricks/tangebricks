import { createHash, randomUUID } from "node:crypto";
import { splitStatements } from "@poc/sdk";
import { deriveProjectSecret } from "@poc/telemetry";
import type { Catalog, ProjectLock } from "@poc/assembler";
import { lintMigration } from "../migration-lint.ts";
import { planDeploy } from "./plan.ts";
import { migrationKey } from "./plan-core.ts";
import { CloudflareApiError, isCloudflareError } from "./cloudflare.ts";
import type { CallRecord, Client } from "./cloudflare.ts";
import type { Ledger } from "./ledger.ts";
import type { ResourceNames } from "./names.ts";
import { KEY_HEADER } from "../worker/gate.ts";

// Deploys one assembled project to the owner's account by converging: read what exists, do only what is missing, and say
// what was done. A second run with nothing changed does nothing and says so.
//
// How "nothing changed" is decided: the database is found by name; each migration is recorded (name and hash) in a table of
// the project's own database and is never run twice; the Worker is uploaded only when the fingerprint of what would be
// uploaded (the bundle's hash, the bindings, the compatibility settings, a digest of the access key) differs from the one
// recorded after the last upload, or when Cloudflare's newest version is no longer the one recorded (someone changed the
// Worker behind this tool's back). The record is bookkeeping of this tool; whether a deploy REALLY changed nothing is
// judged separately by reading the account before and after (see readAccountState), not by what this tool says.

// R2 Storage and Lifecycle for Integration Blobs:
// Deployed graphs using integration operations with binary payloads (multipart/form-data,
// multipart/related, application/octet-stream, or binary responses) bind an R2 bucket
// named INTEGRATION_BLOBS. Keys are partitioned by workspace: `int-blobs/<workspaceId>/<uuid>`.
// Provisioners should configure an R2 lifecycle rule expiring prefix `int-blobs/` after 7 days
// to avoid unbounded storage growth.

export const MIGRATIONS_TABLE = "_projectx_migrations";
export const DEPLOY_TABLE = "_projectx_deploy";
export const DEPLOY_HISTORY_TABLE = "_projectx_deploy_history";
export const DB_BINDING = "DB";
export const KEY_BINDING = "POC_ACCESS_KEY";
export const MAIN_MODULE = "worker.mjs";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export interface Migration {
  name: string;
  sql: string;
}
/** The project's migrations in the order they must run: its migrations/ files, sorted by path. */
export function migrationsFrom(files: Record<string, string>): Migration[] {
  return Object.keys(files)
    .filter((path) => /^migrations\/[^/]+\.sql$/.test(path))
    .sort()
    .map((path) => ({ name: path.slice("migrations/".length), sql: files[path]! }));
}

export interface WorkflowSpec {
  /** The binding's name in the Worker, for example GRAPH_RUNNER. */
  binding: string;
  className: string;
}

export interface ObservabilityDeploySpec {
  logs?: boolean;
  logpush?: boolean;
  alerts?: {
    webhookSecret?: string;
    signingSecret?: string;
  };
  tailBundle?: {
    code: string;
    sha256?: string;
  };
}

export interface IsolatedBrickWorker {
  id: string;
  bundle: { code: string; sha256?: string };
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  bindings?: Array<Record<string, unknown>>;
}

export interface DeployInput {
  client: Client;
  ledger: Ledger;
  names: ResourceNames;
  /** The per-deploy access key, bound to the Worker as a secret. */
  accessKey: string;
  bundle: { code: string; sha256: string };
  migrations: Migration[];
  compatibilityDate: string;
  compatibilityFlags?: string[];
  workflow?: WorkflowSpec;
  /** The binding the secret goes in. Defaults to the project's access key binding; the MCP endpoint's own Worker names its bearer token. */
  secretBinding?: string;
  nowIso?: () => string;
  allowDestructive?: boolean;
  scriptIsolation?: { binding: string; type: "worker_loader" | "dispatch_namespace"; namespace?: string };
  gradual?: string | number[];
  observability?: ObservabilityDeploySpec;
  brickWorkers?: IsolatedBrickWorker[];
  /** Where this deploy goes. Defaults to "dev". Bound to the Worker as PX_ENVIRONMENT. */
  environment?: "dev" | "preview" | "production";
  /** The assembled project's lock (project.json). Its identity is checked before anything is written. When given, deploy() plans first and refuses blocking items, and stores the lock with the deploy so the next plan can diff against it. */
  lock?: ProjectLock;
  /** The catalog the lock was assembled from; lets the plan check saved settings against the bricks' current manifests. */
  catalog?: Catalog;
  /** Acknowledges brick major-version bumps the plan would otherwise block. */
  allowMajor?: boolean;
  /**
   * Story 1.4 / 1.17: the project's control-plane and telemetry bindings (build them with telemetryWebhookConfig): its
   * project id, its derived control-plane secret, its derived webhook-signing secret and, when the Worker pushes telemetry
   * to Studio, the webhook URL. Bound as PX_PROJECT_ID, the secrets PX_TELEMETRY_SECRET (the derived control-plane value;
   * the binding keeps its name) and PX_TELEMETRY_WEBHOOK_SECRET, and PX_TELEMETRY_WEBHOOK_URL. Studio's root secret is
   * never bound to a Worker; the URL is never bound without the others.
   */
  telemetryWebhook?: TelemetryWebhookConfig;
}

export interface TelemetryWebhookConfig {
  /** Where the Worker pushes telemetry; absent when it does not push (it is still signed for and pulled from). */
  url?: string;
  projectId: string;
  /** deriveProjectSecret(root, projectId, "telemetry-webhook"), never the root secret itself. */
  signingSecret: string;
  /** deriveProjectSecret(root, projectId, "control-plane"), never the root secret itself. */
  controlPlaneSecret: string;
}

/**
 * One project's Worker secrets, derived from Studio's root secret (story 1.17): the control-plane secret its /__px routes
 * verify with, and the webhook secret it signs telemetry pushes with. Only these derived values are ever bound.
 */
export async function telemetryWebhookConfig(url: string | undefined, projectId: string, rootSecret: string): Promise<TelemetryWebhookConfig> {
  if (typeof rootSecret !== "string" || rootSecret.trim().length === 0) throw new Error("telemetryWebhookConfig needs the root secret to derive from");
  return {
    ...(url ? { url } : {}),
    projectId,
    signingSecret: await deriveProjectSecret(rootSecret, projectId, "telemetry-webhook"),
    controlPlaneSecret: await deriveProjectSecret(rootSecret, projectId, "control-plane"),
  };
}

/** The bindings a telemetryWebhook config adds to a Worker upload: only derived values, never the root secret. */
export function telemetryWebhookBindings(config: TelemetryWebhookConfig | undefined): Array<Record<string, unknown>> {
  if (!config) return [];
  return [
    ...(config.url ? [{ type: "plain_text", name: "PX_TELEMETRY_WEBHOOK_URL", text: config.url }] : []),
    { type: "plain_text", name: "PX_PROJECT_ID", text: config.projectId },
    { type: "secret_text", name: "PX_TELEMETRY_SECRET", text: config.controlPlaneSecret },
    { type: "secret_text", name: "PX_TELEMETRY_WEBHOOK_SECRET", text: config.signingSecret },
  ];
}

export interface RollbackInput {
  client: Client;
  names: ResourceNames;
  databaseId?: string;
  targetVersionId?: string;
  nowIso?: () => string;
}

export interface RollbackResult {
  rolledBack: boolean;
  versionId: string;
  previousVersionId?: string | null;
  databaseId: string;
  warning?: string;
}

export interface Change {
  kind: "database_created" | "database_adopted" | "migration_applied" | "script_uploaded" | "workflow_registered" | "address_enabled" | "bookkeeping_created";
  what: string;
}
export interface DeployResult {
  changes: Change[];
  url: string;
  databaseId: string;
  uploadFingerprint: string;
  /** How long Cloudflare says the script took to start, when the upload was made and Cloudflare said. */
  startupTimeMs?: number;
  state: AccountState;
}

export class DeployError extends Error {
  readonly detail?: unknown;
  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = "DeployError";
    this.detail = detail;
  }
}

/** What an upload refusal means. Only "platform_refusal" can ever count as Cloudflare not accepting the idea. */
export type UploadFailureClass = "platform_refusal" | "not_the_workflow_binding" | "not_a_refusal";
export class UploadFailed extends Error {
  readonly classification: UploadFailureClass;
  readonly withWorkflow: Error;
  readonly control?: { accepted: boolean; error?: Error };
  constructor(classification: UploadFailureClass, message: string, withWorkflow: Error, control?: { accepted: boolean; error?: Error }) {
    super(message);
    this.name = "UploadFailed";
    this.classification = classification;
    this.withWorkflow = withWorkflow;
    if (control) this.control = control;
  }
}

// ---------------------------------------------------------------------------------------------------------------------

export interface AccountState {
  databaseId: string | null;
  appliedMigrations: string[];
  latestVersionId: string | null;
  versionCount: number;
  addressEnabled: boolean | null;
}

/** Everything the account holds for this deploy, read with GETs and SELECTs only. Used by the tool and, separately, by the tests that judge it. */
export async function readAccountState(client: Client, names: ResourceNames): Promise<AccountState> {
  const databases = (await client.listDatabases(names.database)).filter((d) => d.name === names.database);
  const databaseId = databases[0]?.uuid ?? null;
  let appliedMigrations: string[] = [];
  if (databaseId) {
    const [tables] = await client.queryDatabase(databaseId, [
      { sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", params: [MIGRATIONS_TABLE] },
    ]);
    if (tables!.results.length > 0) {
      const [rows] = await client.queryDatabase(databaseId, [{ sql: `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY name` }]);
      appliedMigrations = rows!.results.map((r) => String(r.name));
    }
  }
  const versions = await client.listVersions(names.script);
  const address = versions === null ? null : await client.getScriptSubdomain(names.script);
  return {
    databaseId,
    appliedMigrations,
    latestVersionId: versions?.[0]?.id ?? null,
    versionCount: versions?.length ?? 0,
    addressEnabled: address === null ? null : address.enabled,
  };
}

/** True for a call that could have changed the account: anything but a GET, except a D1 query that only reads. */
export const isWriteCall = (call: CallRecord): boolean =>
  call.method !== "GET" && !(call.method === "POST" && call.sqlKind === "select" && /\/d1\/database\/[^/]+\/query$/.test(call.path));

// ---------------------------------------------------------------------------------------------------------------------

export function uploadMetadata(input: DeployInput, databaseId: string, withWorkflow: boolean, fingerprint?: string) {
  const bindings: Array<Record<string, unknown>> = [
    { type: "d1", name: DB_BINDING, database_id: databaseId },
    { type: "secret_text", name: input.secretBinding ?? KEY_BINDING, text: input.accessKey },
  ];
  if (input.environment) bindings.push({ type: "plain_text", name: "PX_ENVIRONMENT", text: input.environment });
  bindings.push(...telemetryWebhookBindings(input.telemetryWebhook));
  if (withWorkflow && input.workflow)
    bindings.push({ type: "workflow", name: input.workflow.binding, workflow_name: input.names.workflow, class_name: input.workflow.className });
  if (input.scriptIsolation) {
    if (input.scriptIsolation.type === "worker_loader") {
      bindings.push({ type: "worker_loader", name: input.scriptIsolation.binding });
    } else {
      bindings.push({
        type: "dispatch_namespace",
        name: input.scriptIsolation.binding,
        namespace: input.scriptIsolation.namespace ?? "px-scripts",
      });
    }
  }
  if (input.brickWorkers && input.brickWorkers.length > 0) {
    for (const bw of input.brickWorkers) {
      bindings.push({
        type: "service",
        name: `BRICK_${bw.id.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`,
        service: `${input.names.script}-b-${bw.id}`,
      });
    }
  }
  return {
    compatibility_date: input.compatibilityDate,
    ...(input.compatibilityFlags && input.compatibilityFlags.length > 0 ? { compatibility_flags: input.compatibilityFlags } : {}),
    ...(input.observability?.logs ? { observability: { enabled: true } } : {}),
    ...(input.observability?.logpush ? { logpush: true } : {}),
    ...(input.observability?.alerts ? { tail_consumers: [{ service: `${input.names.script}-tail` }] } : {}),
    bindings,
    annotations: {
      "workers/message": `projectx-poc ${input.bundle.sha256}`,
      ...(fingerprint ? { "projectx/fingerprint": fingerprint } : {}),
    },
  };
}

function versionMatchesTarget(v: { id: string; metadata?: Record<string, unknown> }, fingerprint: string, expectedAnnotation: string): boolean {
  const meta = v.metadata as { annotations?: Record<string, string> } | undefined;
  const annotations = meta?.annotations;
  if (!annotations) return false;
  if (annotations["projectx/fingerprint"]) {
    return annotations["projectx/fingerprint"] === fingerprint;
  }
  return annotations["workers/message"] === expectedAnnotation;
}

/** A fingerprint of what an upload would send, with the access key replaced by its digest so the key itself is never stored. */
export function fingerprintOf(input: DeployInput, databaseId: string): string {
  const metadata = uploadMetadata(input, databaseId, true);
  const shaped = { ...metadata, bindings: metadata.bindings.map((b) => (b.type === "secret_text" ? { ...b, text: sha256(String(b.text)) } : b)) };
  return sha256(JSON.stringify({ code: input.bundle.sha256, metadata: shaped }));
}

export async function deploy(input: DeployInput): Promise<DeployResult> {
  const { client, ledger, names } = input;
  const nowIso = input.nowIso ?? (() => new Date().toISOString());
  const changes: Change[] = [];
  if (input.environment === "production" && input.lock?.identity === "stub") {
    throw new DeployError('identity "stub" is for tests only; choose core-auth or oidc-verify');
  }
  let startupTimeMs: number | undefined;

  // The address needs the account's workers.dev name. The owner chooses it once; this tool does not create it.
  const subdomain = await client.getAccountSubdomain();
  if (subdomain === null)
    throw new DeployError(
      "this account has no workers.dev name yet; register one in the Cloudflare dashboard (Workers & Pages > Overview > your subdomain: choose a name and save) and run again. This tool does not create one for you.",
    );

  if (input.lock) {
    const plan = await planDeploy({ ...input, lock: input.lock });
    if (plan.blocking.length > 0) throw new DeployError(`DEPLOY_PLAN_BLOCKED: ${plan.blocking.join("; ")}`, plan);
  }

  // Pre-check pending migrations before any write calls (database creation, bookkeeping tables, etc.)
  const found = (await client.listDatabases(names.database)).filter((d) => d.name === names.database);
  if (found.length > 1) throw new DeployError(`${found.length} databases are named "${names.database}"; refusing to guess which one is meant`);

  let preAppliedNames = new Set<string>();
  if (found.length === 1) {
    const dbId = found[0]!.uuid;
    const [tables] = await client.queryDatabase(dbId, [
      { sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", params: [MIGRATIONS_TABLE] },
    ]);
    if (tables?.results.some((r) => String(r.name) === MIGRATIONS_TABLE)) {
      const [recorded] = await client.queryDatabase(dbId, [{ sql: `SELECT name FROM ${MIGRATIONS_TABLE}` }]);
      preAppliedNames = new Set(recorded!.results.map((r) => String(r.name)));
    }
  }

  const preAppliedKeys = new Set([...preAppliedNames].map(migrationKey));
  const pendingPrecheck = input.migrations.filter((m) => !preAppliedKeys.has(migrationKey(m.name)));
  const allowDestructive = input.allowDestructive === true || ledger.entries().some((e) => e.kind === "allow_destructive" || e.name === "allow_destructive");

  for (const migration of pendingPrecheck) {
    const lintResult = lintMigration(migration.name, migration.sql);
    if (lintResult.class === "destructive") {
      if (allowDestructive) {
        ledger.planned("allow_destructive", names.database);
        ledger.created("allow_destructive", names.database, migration.name);
      } else if (lintResult.header?.phase === "contract") {
        const expands = lintResult.header.expands;
        if (!expands || !preAppliedNames.has(expands)) {
          throw new DeployError(
            `MIGRATION_DESTRUCTIVE_BLOCKED: contract migration "${migration.name}" requires expand migration "${expands ?? "none"}" to be already applied in target database, but "${expands ?? "none"}" was not found in applied migrations`,
          );
        }
      } else {
        const messages = lintResult.findings.map((f) => f.message).join("; ");
        throw new DeployError(
          `MIGRATION_DESTRUCTIVE_BLOCKED: migration "${migration.name}" is destructive and blocked without expand/contract header or allowDestructive flag: ${messages}`,
        );
      }
    }
  }

  // 1. the database
  const isExistingDatabase = found.length === 1;
  let databaseId: string;
  if (found.length === 1) {
    databaseId = found[0]!.uuid;
    const entry = ledger.entries().find((e) => e.kind === "d1_database" && e.name === names.database && e.status !== "removed");
    if (!entry) {
      // carries this deploy's own random suffix, so it can only be ours from a run that stopped before it was recorded
      ledger.planned("d1_database", names.database);
      ledger.created("d1_database", names.database, databaseId);
      changes.push({ kind: "database_adopted", what: `database ${names.database} found in the account and added to the ledger` });
    } else if (entry.status !== "created" || entry.id !== databaseId) {
      // a run stopped between asking Cloudflare to create it and hearing back: the ledger already knew it was coming
      ledger.created("d1_database", names.database, databaseId);
    }
  } else {
    ledger.planned("d1_database", names.database);
    const made = await client.createDatabase(names.database);
    databaseId = made.uuid;
    ledger.created("d1_database", names.database, databaseId);
    changes.push({ kind: "database_created", what: `created database ${names.database}` });
  }

  // 2. the bookkeeping tables, only if missing
  const [tables] = await client.queryDatabase(databaseId, [
    { sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)", params: [MIGRATIONS_TABLE, DEPLOY_TABLE] },
  ]);
  const have = new Set(tables!.results.map((r) => String(r.name)));
  if (!have.has(MIGRATIONS_TABLE) || !have.has(DEPLOY_TABLE)) {
    const statements: Array<{ sql: string }> = [];
    if (!have.has(MIGRATIONS_TABLE))
      statements.push({ sql: `CREATE TABLE ${MIGRATIONS_TABLE} (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)` });
    if (!have.has(DEPLOY_TABLE))
      statements.push({
        sql: `CREATE TABLE ${DEPLOY_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), upload_sha256 TEXT NOT NULL, version_id TEXT NOT NULL, deployed_at TEXT NOT NULL, last_good_version_id TEXT)`,
      });
    await client.queryDatabase(databaseId, statements);
    changes.push({ kind: "bookkeeping_created", what: "created the tool's two bookkeeping tables in the project database" });
  }

  // 3. migrations: each once, in order, never changed after it ran
  const [recorded] = await client.queryDatabase(databaseId, [{ sql: `SELECT name, sha256 FROM ${MIGRATIONS_TABLE}` }]);
  // Keyed by migrationKey: a migration that only moved to a new counter (because a brick added one before it) has run.
  const applied = new Map(recorded!.results.map((r) => [migrationKey(String(r.name)), String(r.sha256)]));

  const pending: Migration[] = [];
  for (const migration of input.migrations) {
    const hash = sha256(migration.sql);
    const before = applied.get(migrationKey(migration.name));
    if (before === hash) continue;
    if (before !== undefined)
      throw new DeployError(
        `migration ${migration.name} was applied with different contents; a migration is never run twice, so add a new one instead of editing it`,
      );
    pending.push(migration);
  }

  let deployHistoryId: string | null = null;
  let fromVersionId: string | null = null;
  let previousLastGood: string | null = null;

  if (isExistingDatabase) {
    const [deployRowBefore] = await client.queryDatabase(databaseId, [{ sql: `SELECT version_id, last_good_version_id FROM ${DEPLOY_TABLE} WHERE id = 1` }]);
    fromVersionId = (deployRowBefore?.results[0] as { version_id?: string; last_good_version_id?: string } | undefined)?.version_id ?? null;
    previousLastGood =
      (deployRowBefore?.results[0] as { version_id?: string; last_good_version_id?: string } | undefined)?.last_good_version_id ?? fromVersionId;

    if (pending.length > 0) {
      const bookmark = await client.getD1Bookmark(databaseId);
      ledger.planned("d1_bookmark", names.database);
      ledger.created("d1_bookmark", names.database, bookmark);
      deployHistoryId = `dep_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;

      for (let i = 0; i < pending.length; i++) {
        const migration = pending[i]!;
        const hash = sha256(migration.sql);
        const statements: Array<{ sql: string; params?: unknown[] }> = [];

        if (i === 0) {
          statements.push({
            sql: `CREATE TABLE IF NOT EXISTS ${DEPLOY_HISTORY_TABLE} (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, bookmark TEXT NOT NULL, from_version_id TEXT, to_version_id TEXT, last_good_version_id TEXT, status TEXT NOT NULL)`,
          });
          statements.push({
            sql: `INSERT INTO ${DEPLOY_HISTORY_TABLE} (id, started_at, bookmark, from_version_id, to_version_id, last_good_version_id, status) VALUES (?, ?, ?, ?, NULL, ?, ?)`,
            params: [deployHistoryId, nowIso(), bookmark, fromVersionId, previousLastGood, "migrated"],
          });
        }

        statements.push(...splitStatements(migration.sql).map((sql) => ({ sql })));
        statements.push({
          sql: `INSERT INTO ${MIGRATIONS_TABLE} (name, sha256, applied_at) VALUES (?, ?, ?)`,
          params: [migration.name, hash, nowIso()],
        });

        await client.queryDatabase(databaseId, statements); // one atomic batch: the migration and its record land together or not at all
        applied.set(migrationKey(migration.name), hash);
        changes.push({ kind: "migration_applied", what: `applied migration ${migration.name}` });
      }
    }
  } else {
    for (const migration of pending) {
      const hash = sha256(migration.sql);
      const statements = splitStatements(migration.sql).map((sql) => ({ sql }));
      statements.push({
        sql: `INSERT INTO ${MIGRATIONS_TABLE} (name, sha256, applied_at) VALUES ('${migration.name.replace(/'/g, "''")}', '${hash}', '${nowIso()}')`,
      });
      await client.queryDatabase(databaseId, statements);
      applied.set(migrationKey(migration.name), hash);
      changes.push({ kind: "migration_applied", what: `applied migration ${migration.name}` });
    }
  }

  // 4. the Worker
  const fingerprint = fingerprintOf(input, databaseId);
  const versionsBefore = await client.listVersions(names.script);
  const isInitialDeploy = versionsBefore === null || versionsBefore.length === 0;
  const [deployRow] = await client.queryDatabase(databaseId, [
    { sql: `SELECT upload_sha256, version_id, last_good_version_id FROM ${DEPLOY_TABLE} WHERE id = 1` },
  ]);
  const last = deployRow!.results[0] as { upload_sha256?: string; version_id?: string; last_good_version_id?: string } | undefined;
  const upToDate = !isInitialDeploy && last?.upload_sha256 === fingerprint && last?.version_id === versionsBefore[0]!.id;

  if (!upToDate) {
    if (input.gradual && input.workflow) {
      throw new DeployError(
        "Gradual deployment percentage split is not supported for projects with Workflow bindings (graphs-enabled). Deploy at 100% or remove workflow bindings.",
      );
    }

    if (!deployHistoryId && isExistingDatabase) {
      deployHistoryId = `dep_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
      await client.queryDatabase(databaseId, [
        {
          sql: `CREATE TABLE IF NOT EXISTS ${DEPLOY_HISTORY_TABLE} (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, bookmark TEXT NOT NULL, from_version_id TEXT, to_version_id TEXT, last_good_version_id TEXT, status TEXT NOT NULL)`,
        },
        {
          sql: `INSERT INTO ${DEPLOY_HISTORY_TABLE} (id, started_at, bookmark, from_version_id, to_version_id, last_good_version_id, status) VALUES (?, ?, ?, ?, NULL, ?, ?)`,
          params: [deployHistoryId, nowIso(), "", fromVersionId, previousLastGood, "started"],
        },
      ]);
    }

    let newVersionId: string;
    const scriptUrl = `https://${names.script}.${subdomain}.workers.dev`;

    if (input.observability?.alerts || input.observability?.tailBundle) {
      const tailScriptName = `${names.script}-tail`;
      const tailCode = input.observability.tailBundle?.code ?? `export default { async tail(events, env) {} };`;
      if (!ledger.has("worker_script", tailScriptName)) {
        ledger.planned("worker_script", tailScriptName);
      }
      await client.uploadScript(tailScriptName, {
        mainModule: MAIN_MODULE,
        code: tailCode,
        metadata: {
          compatibility_date: input.compatibilityDate,
          annotations: { "workers/message": `projectx-poc tail ${names.script}` },
        },
      });
      ledger.created("worker_script", tailScriptName);
      changes.push({ kind: "script_uploaded", what: `uploaded tail Worker ${tailScriptName}` });
    }

    // Upload isolated brick Workers before the host Worker
    if (input.brickWorkers && input.brickWorkers.length > 0) {
      for (const bw of input.brickWorkers) {
        const scriptName = `${names.script}-b-${bw.id}`;
        ledger.planned("worker_script", scriptName);
        await client.uploadScript(scriptName, {
          mainModule: MAIN_MODULE,
          code: bw.bundle.code,
          metadata: {
            compatibility_date: bw.compatibilityDate ?? input.compatibilityDate,
            ...(bw.compatibilityFlags && bw.compatibilityFlags.length > 0 ? { compatibility_flags: bw.compatibilityFlags } : {}),
            bindings: bw.bindings ?? [],
          },
        });
        ledger.created("worker_script", scriptName);
        changes.push({ kind: "script_uploaded", what: `uploaded isolated brick Worker ${scriptName}` });
      }
    }

    if (isInitialDeploy) {
      if (!ledger.has("worker_script", names.script)) ledger.planned("worker_script", names.script);
      startupTimeMs = (await uploadWithDiagnosis(input, databaseId, fingerprint)).startupTimeMs;
      ledger.created("worker_script", names.script);
      const after = await client.listVersions(names.script);
      const latest = after?.[0]?.id;
      if (!latest) throw new DeployError("the Worker was uploaded but Cloudflare lists no version for it");
      newVersionId = latest;
      await client.queryDatabase(databaseId, [
        {
          sql: `INSERT INTO ${DEPLOY_TABLE} (id, upload_sha256, version_id, deployed_at, last_good_version_id) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET upload_sha256 = excluded.upload_sha256, version_id = excluded.version_id, deployed_at = excluded.deployed_at, last_good_version_id = excluded.last_good_version_id`,
          params: [fingerprint, newVersionId, nowIso(), newVersionId],
        },
      ]);
      changes.push({ kind: "script_uploaded", what: `uploaded Worker ${names.script}` });
    } else {
      const existingDeployments = await client.listDeployments(names.script);
      const activeDeployment = existingDeployments?.[0];
      const deployedVersionIds = new Set(existingDeployments?.flatMap((d) => d.versions.map((v) => v.versionId)) ?? []);

      const expectedAnnotation = `projectx-poc ${input.bundle.sha256}`;

      // Check if the current 100% active deployment in Cloudflare already matches our target
      // Only reconcile if the active version was NOT already recorded in DEPLOY_TABLE as the previous deploy (i.e. a crashed deploy of the new target)
      const activeMatchingVersion = activeDeployment?.versions?.find(
        (v) =>
          v.percentage === 100 &&
          (!last?.version_id || v.versionId !== last.version_id) &&
          versionsBefore?.some((vb) => vb.id === v.versionId && versionMatchesTarget(vb, fingerprint, expectedAnnotation)),
      );

      let isAlreadyActiveAt100 = false;
      let orphanVersion: { id: string } | undefined;

      if (activeMatchingVersion) {
        // Reconcile: the deployment already succeeded in Cloudflare, but history write failed/crashed
        newVersionId = activeMatchingVersion.versionId;
        isAlreadyActiveAt100 = true;
      } else {
        // Version was uploaded, but never deployed (orphan version)
        orphanVersion = versionsBefore?.find((v) => {
          if (deployedVersionIds.has(v.id)) return false;
          return versionMatchesTarget(v, fingerprint, expectedAnnotation);
        });

        if (orphanVersion) {
          newVersionId = orphanVersion.id;
        } else {
          if (!ledger.has("worker_script", names.script)) ledger.planned("worker_script", names.script);
          try {
            const verRes = await uploadVersionWithDiagnosis(input, databaseId, fingerprint);
            newVersionId = verRes.id;
          } catch (uploadErr) {
            if (deployHistoryId) {
              await client.queryDatabase(databaseId, [
                {
                  sql: `UPDATE ${DEPLOY_HISTORY_TABLE} SET to_version_id = NULL, last_good_version_id = ?, status = 'upload_failed' WHERE id = ?`,
                  params: [previousLastGood, deployHistoryId],
                },
              ]);
            }
            throw uploadErr;
          }
          ledger.created("worker_script", names.script);
        }
      }

      if (!isAlreadyActiveAt100) {
        // Smoke check on the new version taking 0% traffic
        try {
          await runSmokeCheck(client, scriptUrl, names.script, newVersionId, smokeKeyFor(input));
        } catch (smokeErr) {
          if (deployHistoryId) {
            await client.queryDatabase(databaseId, [
              {
                sql: `UPDATE ${DEPLOY_HISTORY_TABLE} SET to_version_id = ?, last_good_version_id = ?, status = 'smoke_failed' WHERE id = ?`,
                params: [newVersionId, previousLastGood, deployHistoryId],
              },
            ]);
          }
          throw smokeErr;
        }

        // Shift traffic via createDeployment
        if (input.gradual) {
          const raw = Array.isArray(input.gradual)
            ? input.gradual
            : String(input.gradual)
                .split(",")
                .map((s) => Number(s.trim()));
          const steps = raw.filter((n) => Number.isFinite(n) && n > 0 && n <= 100);
          for (const pct of steps) {
            await client.createDeployment(names.script, [
              { versionId: newVersionId, percentage: pct },
              ...(pct < 100 && fromVersionId ? [{ versionId: fromVersionId, percentage: 100 - pct }] : []),
            ]);
            if (pct < 100) {
              await runSmokeCheck(client, scriptUrl, names.script, newVersionId, smokeKeyFor(input));
            }
          }
        } else {
          await client.createDeployment(names.script, [{ versionId: newVersionId, percentage: 100 }]);
        }
      }
      changes.push({
        kind: "script_uploaded",
        what: orphanVersion
          ? `adopted existing version ${newVersionId} of Worker ${names.script}`
          : isAlreadyActiveAt100
            ? `reconciled deployed version ${newVersionId} of Worker ${names.script}`
            : `uploaded a new version of Worker ${names.script}`,
      });
    }

    // 4b. the Workflow the binding names: re-register after the shift
    if (input.workflow) {
      const spec = input.workflow;
      const registered = (await client.listWorkflowDefinitions()).find((w) => w.name === names.workflow);
      const current = registered !== undefined && registered.className === spec.className && registered.scriptName === names.script;
      if (!current || !upToDate) {
        if (!ledger.has("workflow", names.workflow)) ledger.planned("workflow", names.workflow);
        await client.putWorkflow(names.workflow, { className: spec.className, scriptName: names.script });
        ledger.created("workflow", names.workflow);
        changes.push({ kind: "workflow_registered", what: `registered Workflow ${names.workflow} (class ${spec.className}) on ${names.script}` });
      }
    }

    // 7. Write DEPLOY_TABLE and DEPLOY_HISTORY_TABLE with last_good_version_id
    await client.queryDatabase(databaseId, [
      {
        sql: `INSERT INTO ${DEPLOY_TABLE} (id, upload_sha256, version_id, deployed_at, last_good_version_id) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET upload_sha256 = excluded.upload_sha256, version_id = excluded.version_id, deployed_at = excluded.deployed_at, last_good_version_id = excluded.last_good_version_id`,
        params: [fingerprint, newVersionId, nowIso(), newVersionId],
      },
    ]);
    if (deployHistoryId) {
      await client.queryDatabase(databaseId, [
        {
          sql: `UPDATE ${DEPLOY_HISTORY_TABLE} SET to_version_id = ?, last_good_version_id = ?, status = 'success' WHERE id = ?`,
          params: [newVersionId, newVersionId, deployHistoryId],
        },
      ]);
    }
  } else {
    // Up to date: check if workflow was deleted/changed behind the tool's back
    if (input.workflow) {
      const spec = input.workflow;
      const registered = (await client.listWorkflowDefinitions()).find((w) => w.name === names.workflow);
      const current = registered !== undefined && registered.className === spec.className && registered.scriptName === names.script;
      if (!current) {
        if (!ledger.has("workflow", names.workflow)) ledger.planned("workflow", names.workflow);
        await client.putWorkflow(names.workflow, { className: spec.className, scriptName: names.script });
        ledger.created("workflow", names.workflow);
        changes.push({ kind: "workflow_registered", what: `registered Workflow ${names.workflow} (class ${spec.className}) on ${names.script}` });
      }
    }
    if (deployHistoryId) {
      const currentVersionId = last?.version_id ?? fromVersionId;
      await client.queryDatabase(databaseId, [
        {
          sql: `UPDATE ${DEPLOY_HISTORY_TABLE} SET to_version_id = ?, last_good_version_id = ?, status = 'success' WHERE id = ?`,
          params: [currentVersionId, currentVersionId, deployHistoryId],
        },
      ]);
    }
  }

  if (input.lock) await storeLock(client, databaseId, input.lock, deployHistoryId, nowIso);

  // 5. its address
  const address = await client.getScriptSubdomain(names.script);
  if (address === null || !address.enabled) {
    await client.setScriptSubdomain(names.script, true);
    changes.push({ kind: "address_enabled", what: `switched on https://${names.script}.${subdomain}.workers.dev` });
  }

  return {
    changes,
    url: `https://${names.script}.${subdomain}.workers.dev`,
    databaseId,
    uploadFingerprint: fingerprint,
    ...(startupTimeMs !== undefined ? { startupTimeMs } : {}),
    state: await readAccountState(client, names),
  };
}

const HISTORY_COLUMNS =
  "id TEXT PRIMARY KEY, started_at TEXT NOT NULL, bookmark TEXT NOT NULL, from_version_id TEXT, to_version_id TEXT, last_good_version_id TEXT, status TEXT NOT NULL";

/** Records the lock this deploy put live in the history table (adding the column to an older table), so planDeploy can diff against it. */
async function storeLock(client: Client, databaseId: string, lock: ProjectLock, historyId: string | null, nowIso: () => string): Promise<void> {
  await client.queryDatabase(databaseId, [{ sql: `CREATE TABLE IF NOT EXISTS ${DEPLOY_HISTORY_TABLE} (${HISTORY_COLUMNS}, lock_json TEXT)` }]);
  const [columns] = await client.queryDatabase(databaseId, [{ sql: `SELECT name FROM pragma_table_info('${DEPLOY_HISTORY_TABLE}') WHERE name = 'lock_json'` }]);
  if (columns!.results.length === 0) await client.queryDatabase(databaseId, [{ sql: `ALTER TABLE ${DEPLOY_HISTORY_TABLE} ADD COLUMN lock_json TEXT` }]);
  const [row] = await client.queryDatabase(databaseId, [{ sql: `SELECT version_id FROM ${DEPLOY_TABLE} WHERE id = 1` }]);
  const versionId = (row?.results[0] as { version_id?: string } | undefined)?.version_id ?? null;
  const text = JSON.stringify(lock);
  if (historyId) {
    await client.queryDatabase(databaseId, [{ sql: `UPDATE ${DEPLOY_HISTORY_TABLE} SET lock_json = ? WHERE id = ?`, params: [text, historyId] }]);
    return;
  }
  const [stored] = await client.queryDatabase(databaseId, [
    {
      sql: `SELECT lock_json FROM ${DEPLOY_HISTORY_TABLE} WHERE status = 'success' AND to_version_id = ? AND lock_json IS NOT NULL ORDER BY started_at DESC LIMIT 1`,
      params: [versionId],
    },
  ]);
  if (stored?.results[0] && String(stored.results[0].lock_json) === text) return;
  await client.queryDatabase(databaseId, [
    {
      sql: `INSERT INTO ${DEPLOY_HISTORY_TABLE} (id, started_at, bookmark, from_version_id, to_version_id, last_good_version_id, status, lock_json) VALUES (?, ?, ?, NULL, ?, ?, 'success', ?)`,
      params: [`dep_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`, nowIso(), "", versionId, versionId, text],
    },
  ]);
}

/**
 * Uploads the Worker. If the upload carries a Workflow binding and Cloudflare refuses it, the same script is uploaded once
 * more WITHOUT that binding under a throw-away name, and the answer decides what the refusal means: only "the plain upload
 * is accepted and the one with the binding is refused by Cloudflare" counts as the platform refusing the binding. Anything
 * else (the plain upload fails too, the network failed, the answer was malformed) is a problem to fix here, never a verdict.
 */
async function uploadWithDiagnosis(input: DeployInput, databaseId: string, fingerprint?: string): Promise<{ startupTimeMs?: number }> {
  const { client, names } = input;
  const send = (name: string, withWorkflow: boolean) =>
    client.uploadScript(name, { mainModule: MAIN_MODULE, code: input.bundle.code, metadata: uploadMetadata(input, databaseId, withWorkflow, fingerprint) });
  try {
    return await send(names.script, true);
  } catch (error) {
    if (!isCloudflareError(error)) throw error;
    if (!input.workflow) throw new UploadFailed("not_the_workflow_binding", `the upload was refused and carried no Workflow binding: ${error.message}`, error);
    if (!(error instanceof CloudflareApiError))
      throw new UploadFailed("not_a_refusal", `the upload with the Workflow binding failed without a refusal from Cloudflare: ${error.message}`, error);

    const controlName = `${names.script}-ctl`;
    input.ledger.planned("worker_script", controlName);
    let control: { accepted: boolean; error?: Error };
    try {
      await send(controlName, false);
      input.ledger.created("worker_script", controlName);
      control = { accepted: true };
    } catch (controlError) {
      control = { accepted: false, error: controlError instanceof Error ? controlError : new Error(String(controlError)) };
    } finally {
      try {
        await client.deleteScript(controlName);
      } catch {
        // already absent, or never created
      }
      input.ledger.removed("worker_script", controlName);
    }
    if (control.accepted)
      throw new UploadFailed(
        "platform_refusal",
        `Cloudflare accepted the script without the Workflow binding and refused it with: ${error.message}`,
        error,
        control,
      );
    throw new UploadFailed(
      "not_the_workflow_binding",
      `the upload was refused with and without the Workflow binding, so the binding is not the cause: ${error.message}`,
      error,
      control,
    );
  }
}

async function uploadVersionWithDiagnosis(input: DeployInput, databaseId: string, fingerprint?: string): Promise<{ id: string; number?: number }> {
  const { client, names } = input;
  const send = (name: string, withWorkflow: boolean) =>
    client.uploadVersion(name, {
      mainModule: MAIN_MODULE,
      code: input.bundle.code,
      metadata: uploadMetadata(input, databaseId, withWorkflow, fingerprint),
    });
  try {
    return await send(names.script, Boolean(input.workflow));
  } catch (error) {
    if (!isCloudflareError(error)) throw error;
    if (!input.workflow)
      throw new UploadFailed("not_the_workflow_binding", `the version upload was refused and carried no Workflow binding: ${error.message}`, error);
    if (!(error instanceof CloudflareApiError))
      throw new UploadFailed("not_a_refusal", `the version upload with the Workflow binding failed without a refusal from Cloudflare: ${error.message}`, error);

    const controlName = `${names.script}-ctl`;
    input.ledger.planned("worker_script", controlName);
    let control: { accepted: boolean; error?: Error };
    try {
      await send(controlName, false);
      input.ledger.created("worker_script", controlName);
      control = { accepted: true };
    } catch (controlError) {
      control = { accepted: false, error: controlError instanceof Error ? controlError : new Error(String(controlError)) };
    } finally {
      try {
        await client.deleteScript(controlName);
      } catch {
        // already absent
      }
      input.ledger.removed("worker_script", controlName);
    }
    if (control.accepted)
      throw new UploadFailed(
        "platform_refusal",
        `Cloudflare accepted the version without the Workflow binding and refused it with: ${error.message}`,
        error,
        control,
      );
    throw new UploadFailed(
      "not_the_workflow_binding",
      `the version upload was refused with and without the Workflow binding, so the binding is not the cause: ${error.message}`,
      error,
      control,
    );
  }
}

/**
 * The access key the smoke check presents. The deployed Worker sits behind the access-key gate (worker/gate.ts), which answers
 * 401 to any request without it, so a smoke check without the key fails every redeploy that uploads code. Only the gate
 * reads this header: a Worker that binds its secret under another name (the MCP endpoint) gets no header.
 */
export function smokeKeyFor(input: Pick<DeployInput, "accessKey" | "secretBinding">): string | undefined {
  return (input.secretBinding ?? KEY_BINDING) === KEY_BINDING ? input.accessKey : undefined;
}

export async function runSmokeCheck(
  client: Client,
  url: string,
  scriptName: string,
  versionId: string,
  accessKey?: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const endpoints = ["/healthz", "/readyz"];
  for (const endpoint of endpoints) {
    const targetUrl = `${url.replace(/\/+$/, "")}${endpoint}`;
    let lastError: Error | null = null;
    let lastBody = "";
    let success = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await client.fetchWithVersionOverride(targetUrl, scriptName, versionId, accessKey ? { headers: { [KEY_HEADER]: accessKey } } : undefined);
        lastBody = await res.text();
        if (res.ok) {
          success = true;
          break;
        }
        lastError = new Error(`HTTP ${res.status}: ${lastBody}`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      if (attempt < 3) {
        await sleep(100);
      }
    }
    if (!success) {
      throw new DeployError(
        `Smoke check failed for ${endpoint} on version ${versionId}: ${lastError?.message ?? "unknown error"}${lastBody ? ` (${lastBody})` : ""}`,
        { endpoint, versionId, body: lastBody },
      );
    }
  }
}

export async function rollback(input: RollbackInput): Promise<RollbackResult> {
  const { client, names } = input;
  const nowIso = input.nowIso ?? (() => new Date().toISOString());

  // 1. Locate database
  let databaseId = input.databaseId;
  if (!databaseId) {
    const dbs = (await client.listDatabases(names.database)).filter((d) => d.name === names.database);
    if (dbs.length === 0) throw new DeployError(`database ${names.database} not found`);
    databaseId = dbs[0]!.uuid;
  }

  // 2. Read deploy and history tables
  const [deployRow] = await client.queryDatabase(databaseId, [{ sql: `SELECT version_id, last_good_version_id FROM ${DEPLOY_TABLE} WHERE id = 1` }]);
  const currentVersionId = (deployRow?.results[0] as { version_id?: string; last_good_version_id?: string } | undefined)?.version_id ?? null;

  const [historyRows] = await client.queryDatabase(databaseId, [
    {
      sql: `SELECT id, started_at, bookmark, from_version_id, to_version_id, last_good_version_id, status FROM ${DEPLOY_HISTORY_TABLE} ORDER BY started_at DESC`,
    },
  ]);
  const history = (historyRows?.results ?? []) as Array<{
    id: string;
    started_at: string;
    bookmark: string;
    from_version_id: string | null;
    to_version_id: string | null;
    last_good_version_id?: string | null;
    status: string;
  }>;

  // 3. Determine target version to rollback to
  let targetVersionId = input.targetVersionId;
  if (!targetVersionId) {
    const currentDeployEntry = history.find((h) => h.to_version_id === currentVersionId && h.status === "success");
    if (currentDeployEntry?.from_version_id) {
      targetVersionId = currentDeployEntry.from_version_id;
    } else {
      const prevSuccess = history.find((h) => h.status === "success" && h.to_version_id && h.to_version_id !== currentVersionId);
      if (prevSuccess?.to_version_id) {
        targetVersionId = prevSuccess.to_version_id;
      }
    }
  }

  if (!targetVersionId) {
    throw new DeployError("no previous version found to roll back to");
  }

  // 4. Exactly 1 deployment call and 0 upload calls
  await client.createDeployment(names.script, [{ versionId: targetVersionId, percentage: 100 }]);

  // 5. Update _projectx_deploy and write history row
  await client.queryDatabase(databaseId, [
    {
      sql: `UPDATE ${DEPLOY_TABLE} SET version_id = ?, deployed_at = ?, last_good_version_id = ? WHERE id = 1`,
      params: [targetVersionId, nowIso(), targetVersionId],
    },
    {
      sql: `INSERT INTO ${DEPLOY_HISTORY_TABLE} (id, started_at, bookmark, from_version_id, to_version_id, last_good_version_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [`rollback_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`, nowIso(), "", currentVersionId, targetVersionId, targetVersionId, "rollback"],
    },
  ]);

  // 6. Check backward compatibility of migrations applied since target deploy
  let warning: string | undefined;
  try {
    const targetDeployRow = history.find((h) => h.to_version_id === targetVersionId && h.status === "success");
    if (targetDeployRow) {
      const [appliedSince] = await client.queryDatabase(databaseId, [
        { sql: `SELECT name FROM ${MIGRATIONS_TABLE} WHERE applied_at > ?`, params: [targetDeployRow.started_at] },
      ]);
      const migNames = (appliedSince?.results ?? []).map((r) => String(r.name));
      if (migNames.length > 0) {
        warning = `Migrations were applied after the target version was originally deployed: ${migNames.join(", ")}. If these migrations made schema changes that are not backward compatible, consider running poc:restore to rewind D1 to the target bookmark.`;
      }
    }
  } catch {
    // Non-fatal
  }

  return {
    rolledBack: true,
    versionId: targetVersionId,
    previousVersionId: currentVersionId,
    databaseId,
    ...(warning ? { warning } : {}),
  };
}
