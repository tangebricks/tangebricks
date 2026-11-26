import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import {
  createClient,
  loadCredentials,
  CredentialsError,
} from "../packages/deploy/src/provisioner/index.ts";
import type { Client } from "../packages/deploy/src/provisioner/index.ts";
import { createFakeCloudflare } from "../packages/deploy/test/support/fake-cloudflare.ts";
import {
  getEvidenceDir,
  getGitSha,
  stampEvidence,
  writeEvidence,
} from "./lib/evidence-stamp.ts";

export interface RestoreDrillStep {
  name: string;
  durationMs: number;
  details?: Record<string, unknown>;
}

export interface RestoreDrillDurations {
  total: number;
  createDb: number;
  migrate: number;
  seedA: number;
  bookmark: number;
  seedB: number;
  restoreA: number;
  verifyA: number;
  restoreB: number;
  verifyB: number;
  teardown: number;
  [key: string]: number;
}

export interface RestoreDrillResult {
  success: boolean;
  databaseName: string;
  databaseId?: string;
  bookmarkA: string;
  previousBookmark: string;
  steps: RestoreDrillStep[];
  durationsMs: RestoreDrillDurations;
  gitSha: string;
  measuredAt: string;
  verification: {
    canaryA: "present";
    canaryBRevertedOnRestoreA: "absent";
    canaryBRestoredOnRestoreB: "present";
  };
}

export interface RestoreDrillOptions {
  mode?: "fake" | "live";
  client?: Client;
  dbName?: string;
  env?: NodeJS.ProcessEnv;
  writeEvidenceFile?: boolean;
  evidencePath?: string;
  log?: (msg: string) => void;
  _failAtStep?: string;
}

const DEFAULT_ENV_FILE = process.env.PX_ENV_FILE ?? ".env";

/**
 * Runs the end-to-end D1 Time Travel restore drill:
 * 1. Generates and asserts scratch database prefixed with 'px-drill-'.
 * 2. Creates the database in Cloudflare (or in fake harness).
 * 3. Applies schema migrations (canary tables).
 * 4. Seeds canary row A.
 * 5. Captures D1 Time Travel bookmark (bookmarkA).
 * 6. Seeds canary row B (mutates database state).
 * 7. Restores to bookmarkA, capturing previous_bookmark (undo token).
 * 8. Verifies row A is present and row B is absent.
 * 9. Restores to previous_bookmark.
 * 10. Verifies row A is present and row B is back.
 * 11. Tears down scratch database.
 * 12. Writes stamped evidence when in live mode.
 */
export async function runRestoreDrill(options: RestoreDrillOptions = {}): Promise<RestoreDrillResult> {
  const log = options.log ?? ((msg: string) => console.log(msg));
  const mode = options.mode ?? "fake";

  // Database name generation and AC2 enforcement
  const dbName = options.dbName ?? `px-drill-${randomBytes(4).toString("hex")}`;
  if (!dbName.startsWith("px-drill-")) {
    throw new Error(
      `AC2 violation: database name '${dbName}' must start with 'px-drill-'; refusing to touch database.`,
    );
  }

  // Resolve client
  let liveCredentials: { token: string; accountId: string } | null = null;
  let client = options.client;
  if (!client) {
    if (mode === "fake") {
      const fakeToken = "cfut_Zq8rLm3VxN2pTb7YkWd4HsJc9GaE5uRo6QiXf1BvPn0AyMt";
      const fakeAccount = "0123456789abcdef0123456789abcdef";
      const fake = createFakeCloudflare({ token: fakeToken, accountId: fakeAccount });
      client = createClient({ credentials: { token: fakeToken, accountId: fakeAccount }, fetch: fake.fetch });
    } else {
      // Live mode credentials
      const env = { ...process.env, ...options.env };
      if (!env.CLOUDFLARE_API_TOKEN && existsSync(DEFAULT_ENV_FILE)) {
        try {
          process.loadEnvFile(DEFAULT_ENV_FILE);
          Object.assign(env, process.env);
        } catch {
          // ignore error loading default env file
        }
      }
      const credentials = loadCredentials(env);
      liveCredentials = credentials;
      client = createClient({ credentials, fetch: (req) => fetch(req) });
    }
  }

  const steps: RestoreDrillStep[] = [];
  const durationsMs: Record<string, number> = {};
  const startedAt = new Date().toISOString();
  const drillStartTime = performance.now();

  async function recordStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (options._failAtStep === name) {
      throw new Error(`simulated failure at ${name}`);
    }
    const t0 = performance.now();
    const result = await fn();
    const duration = Math.round((performance.now() - t0) * 100) / 100;
    durationsMs[name] = duration;
    steps.push({ name, durationMs: duration });
    return result;
  }

  let databaseId: string | undefined;
  let createdDatabaseId = "";
  let bookmarkA = "";
  let previousBookmark = "";

  try {
    log(`[drill] Starting D1 restore drill on database: ${dbName} (mode: ${mode})`);

    // Step 1: Create scratch DB
    const createdDb = await recordStep("createDb", async () => {
      return await client!.createDatabase(dbName);
    });
    databaseId = createdDb.uuid;
    createdDatabaseId = createdDb.uuid;
    log(`[drill] Created scratch database ${dbName} (${databaseId})`);

    // Step 2: Apply migrations
    await recordStep("migrate", async () => {
      await client!.queryDatabase(databaseId!, [
        {
          sql: `CREATE TABLE px_canary (
            id TEXT PRIMARY KEY,
            batch TEXT NOT NULL,
            value TEXT NOT NULL,
            created_at TEXT NOT NULL
          );`,
        },
        {
          sql: `CREATE TABLE _projectx_migrations (
            name TEXT PRIMARY KEY,
            sha256 TEXT NOT NULL,
            applied_at TEXT NOT NULL
          );`,
        },
        {
          sql: `INSERT INTO _projectx_migrations (name, sha256, applied_at)
                VALUES ('0001_drill_init.sql', 'sha_drill_initial_schema', ?);`,
          params: [new Date().toISOString()],
        },
      ]);
    });
    log("[drill] Migrations applied successfully");

    // Step 3: Write canary rows A
    await recordStep("seedA", async () => {
      await client!.queryDatabase(databaseId!, [
        {
          sql: `INSERT INTO px_canary (id, batch, value, created_at)
                VALUES ('canary_a_1', 'batch_A', 'original_data', ?);`,
          params: [new Date().toISOString()],
        },
      ]);
    });
    log("[drill] Seeded canary batch A");

    // Step 4: Take bookmark A
    bookmarkA = await recordStep("bookmark", async () => {
      return await client!.getD1Bookmark(databaseId!);
    });
    log(`[drill] Captured bookmark A: ${bookmarkA}`);

    // Step 5: Write canary rows B
    await recordStep("seedB", async () => {
      await client!.queryDatabase(databaseId!, [
        {
          sql: `INSERT INTO px_canary (id, batch, value, created_at)
                VALUES ('canary_b_1', 'batch_B', 'mutated_data', ?);`,
          params: [new Date().toISOString()],
        },
      ]);
    });
    log("[drill] Seeded canary batch B");

    // Step 6: Restore to bookmark A
    const restoreResultA = await recordStep("restoreA", async () => {
      return await client!.restoreD1(databaseId!, bookmarkA);
    });
    previousBookmark = restoreResultA.previous_bookmark;
    log(`[drill] Restored to bookmark A. Previous bookmark for undo: ${previousBookmark}`);

    // Step 7: Verify A is present and B is absent
    await recordStep("verifyA", async () => {
      const [res] = await client!.queryDatabase(databaseId!, [
        { sql: "SELECT id, batch, value FROM px_canary ORDER BY id;" },
      ]);
      const rows = (res?.results ?? []) as Array<{ id: string; batch: string; value: string }>;
      const hasA = rows.some((r) => r.id === "canary_a_1" && r.value === "original_data");
      const hasB = rows.some((r) => r.id === "canary_b_1");
      if (!hasA || hasB || rows.length !== 1) {
        throw new Error(
          `Verification after restore A failed: expected only row A, got rows: ${JSON.stringify(rows)}`,
        );
      }
    });
    log("[drill] Verification A passed: row A is present, row B is absent");

    // Step 8: Restore to previous_bookmark (undo restore)
    await recordStep("restoreB", async () => {
      return await client!.restoreD1(databaseId!, previousBookmark);
    });
    log(`[drill] Restored to previous_bookmark (${previousBookmark})`);

    // Step 9: Verify B is back
    await recordStep("verifyB", async () => {
      const [res] = await client!.queryDatabase(databaseId!, [
        { sql: "SELECT id, batch, value FROM px_canary ORDER BY id;" },
      ]);
      const rows = (res?.results ?? []) as Array<{ id: string; batch: string; value: string }>;
      const hasA = rows.some((r) => r.id === "canary_a_1");
      const hasB = rows.some((r) => r.id === "canary_b_1" && r.value === "mutated_data");
      if (!hasA || !hasB || rows.length !== 2) {
        throw new Error(
          `Verification after restore B failed: expected rows A and B, got rows: ${JSON.stringify(rows)}`,
        );
      }
    });
    log("[drill] Verification B passed: both rows A and B are present");

    // Step 10: Teardown scratch DB
    await recordStep("teardown", async () => {
      await client!.deleteDatabase(databaseId!);
      databaseId = undefined;
    });
    log(`[drill] Torn down scratch database ${dbName}`);
  } finally {
    // Ensure cleanup of scratch database on any failure
    if (databaseId) {
      try {
        await client!.deleteDatabase(databaseId);
        log(`[drill] Cleanup: successfully removed scratch database ${databaseId}`);
      } catch (cleanupErr) {
        log(`[drill] Cleanup warning: failed to delete database ${databaseId}: ${cleanupErr}`);
      }
    }
  }

  const totalDuration = Math.round((performance.now() - drillStartTime) * 100) / 100;
  durationsMs.total = totalDuration;

  const gitSha = getGitSha();
  const measuredAt = new Date().toISOString();

  const result: RestoreDrillResult = {
    success: true,
    databaseName: dbName,
    bookmarkA,
    previousBookmark,
    steps,
    durationsMs: durationsMs as RestoreDrillDurations,
    gitSha,
    measuredAt,
    verification: {
      canaryA: "present",
      canaryBRevertedOnRestoreA: "absent",
      canaryBRestoredOnRestoreB: "present",
    },
  };

  // Write evidence if live mode or explicitly requested
  const shouldWriteEvidence =
    options.writeEvidenceFile !== undefined
      ? options.writeEvidenceFile
      : mode === "live";

  if (shouldWriteEvidence) {
    // Scratch runs have their own file: evidence/deployed/restore-drill-result.json is the target-mode (staging) evidence only.
    const outPath = options.evidencePath ?? resolve(getEvidenceDir(), "restore-drill-scratch.json");
    const provenance = stampEvidence("scripts/restore-drill.ts", "measured");
    const evidenceData = {
      startedAt,
      measuredAt: result.measuredAt,
      gitSha: result.gitSha,
      target: "scratch",
      databaseName: result.databaseName,
      durationsMs: result.durationsMs,
      steps: result.steps,
      verification: result.verification,
      success: result.success,
    };
    assertRedacted(JSON.stringify(evidenceData), [
      createdDatabaseId,
      createdDatabaseId.replace(/-/g, ""),
      bookmarkA,
      previousBookmark,
      liveCredentials?.accountId ?? "",
      liveCredentials?.token ?? "",
    ]);
    writeEvidence(outPath, evidenceData, provenance);
    log(`[drill] Wrote evidence to ${outPath}`);
  }

  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Target mode: the drill on one named, existing database (cephlow's staging database). Guarded: the database is named by
// uuid AND by the name it must have, that name must end in -staging, and credentials come only from an explicit env file
// outside the repository. The database is left as it was found: a fingerprint (every table with its row count) taken
// before the drill must match after the restore, and the canary table is dropped at the end.
// ---------------------------------------------------------------------------------------------------------------------

export const CANARY_TABLE = "px_restore_drill_canary";
const CANARY_ROWS = [
  { id: "canary_1", value: "restore-drill canary one" },
  { id: "canary_2", value: "restore-drill canary two" },
  { id: "canary_3", value: "restore-drill canary three" },
];
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export class RestoreDrillRefusal extends Error {
  constructor(message: string) {
    super(`REFUSED: ${message}`);
    this.name = "RestoreDrillRefusal";
  }
}

export interface TargetRestoreDrillOptions {
  /** The uuid of the one database the drill may touch. */
  targetDb: string;
  /** The name that database must have; must end in -staging. */
  expectName: string;
  /** Credentials file (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID); must be outside the repository. Required without `client`. */
  envFile?: string;
  /** The label the evidence names the target by (never an id). */
  label?: string;
  /** Tests only: an already-built client (no env file is read). */
  client?: Client;
  writeEvidenceFile?: boolean;
  evidencePath?: string;
  log?: (msg: string) => void;
  /** Tests only: fail just before the named step. */
  _failAtStep?: string;
}

export interface TargetRestoreDrillResult {
  success: true;
  target: string;
  startedAt: string;
  measuredAt: string;
  gitSha: string;
  steps: RestoreDrillStep[];
  durationsMs: Record<string, number>;
  tablesFingerprinted: number;
  verification: {
    canaryRestored: true;
    fingerprintMatches: true;
    canaryDropped: true;
  };
}

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Checks the guard inputs that need no network call. Throws RestoreDrillRefusal. */
export function assertTargetGuards(options: Pick<TargetRestoreDrillOptions, "targetDb" | "expectName" | "envFile" | "label" | "client">): void {
  if (!options.targetDb || !UUID_RE.test(options.targetDb)) throw new RestoreDrillRefusal("--target-db must be a D1 database uuid");
  if (!options.expectName) throw new RestoreDrillRefusal("--expect-name is required in target mode");
  if (!options.expectName.endsWith("-staging")) {
    throw new RestoreDrillRefusal(`--expect-name '${options.expectName}' does not end in -staging; the drill runs only on a staging database`);
  }
  if (options.label !== undefined && !LABEL_RE.test(options.label)) throw new RestoreDrillRefusal("--label must be lowercase letters, digits and dashes");
  if (!options.client) {
    if (!options.envFile) throw new RestoreDrillRefusal("--env-file is required in target mode");
    const abs = resolve(options.envFile);
    const rel = relative(repoRoot, abs);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      throw new RestoreDrillRefusal(`--env-file must be outside the repository (got ${options.envFile}); credentials are never loaded from the repo`);
    }
    if (!existsSync(abs)) throw new RestoreDrillRefusal(`--env-file ${options.envFile} does not exist`);
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Every table except Cloudflare's (_cf_*), SQLite's (sqlite_*) and the drill's canary, with its row count. */
async function fingerprintDatabase(client: Client, databaseId: string): Promise<Record<string, number>> {
  const [res] = await client.queryDatabase(databaseId, [{ sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name" }]);
  const names = (res?.results ?? [])
    .map((r) => String(r.name))
    .filter((n) => !n.startsWith("_cf_") && !n.startsWith("sqlite_") && n !== CANARY_TABLE);
  if (names.length === 0) return {};
  const counts = await client.queryDatabase(databaseId, names.map((n) => ({ sql: `SELECT COUNT(*) AS n FROM ${quoteIdent(n)}` })));
  const out: Record<string, number> = {};
  names.forEach((n, i) => {
    out[n] = Number(counts[i]?.results?.[0]?.n ?? NaN);
  });
  return out;
}

async function tableExists(client: Client, databaseId: string, name: string): Promise<boolean> {
  const [res] = await client.queryDatabase(databaseId, [{ sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", params: [name] }]);
  return (res?.results ?? []).length > 0;
}

function sameFingerprint(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/** Throws when the evidence text carries any of the given secrets or ids, or a workers.dev address. */
export function assertRedacted(text: string, forbidden: string[]): void {
  for (const value of forbidden) {
    if (value && value.length >= 6 && text.toLowerCase().includes(value.toLowerCase())) {
      throw new Error("EVIDENCE_NOT_REDACTED: the evidence would carry an id, a bookmark or a credential; nothing was written");
    }
  }
  if (/workers\.dev/i.test(text) || /\b[0-9a-f]{32}\b/i.test(text) || /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text)) {
    throw new Error("EVIDENCE_NOT_REDACTED: the evidence would carry a uuid, an account id or a workers.dev address; nothing was written");
  }
}

function credentialsFromEnvFile(path: string) {
  // Only the named file: neither process.env nor the repository's .env is read.
  const parsed = parseEnv(readFileSync(resolve(path), "utf8"));
  return loadCredentials({ CLOUDFLARE_API_TOKEN: parsed.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: parsed.CLOUDFLARE_ACCOUNT_ID });
}

/**
 * The drill on one existing database:
 * 1. guards (uuid, -staging name, env file outside the repo), then the live name must equal --expect-name;
 * 2. fingerprint: every table with its row count; a leftover canary table is refused;
 * 3. create and seed the canary table;
 * 4. take the bookmark;
 * 5. destroy: delete the canary rows and drop the canary table;
 * 6. restore to the bookmark;
 * 7. verify the canary rows are back and the fingerprint matches;
 * 8. drop the canary table.
 * A failure after the bookmark restores to it (unless the restore already ran) and drops the canary; no evidence is written.
 */
export async function runTargetRestoreDrill(options: TargetRestoreDrillOptions): Promise<TargetRestoreDrillResult> {
  const log = options.log ?? ((msg: string) => console.log(msg));
  assertTargetGuards(options);
  const label = options.label ?? "cephlow-staging";
  const databaseId = options.targetDb;
  let credentials: { token: string; accountId: string } | null = null;
  let client = options.client;
  if (!client) {
    credentials = credentialsFromEnvFile(options.envFile!);
    client = createClient({ credentials, fetch: (req) => fetch(req) });
  }
  const c = client;

  const steps: RestoreDrillStep[] = [];
  const durationsMs: Record<string, number> = {};
  const startedAt = new Date().toISOString();
  const t0All = performance.now();
  async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (options._failAtStep === name) throw new Error(`simulated failure at ${name}`);
    const t0 = performance.now();
    const out = await fn();
    const ms = Math.round((performance.now() - t0) * 100) / 100;
    durationsMs[name] = ms;
    steps.push({ name, durationMs: ms });
    return out;
  }

  // Read-only preflight: the live name must be exactly the expected one. Nothing is written before this passes.
  const live = await step("preflight", async () => c.getDatabase(databaseId));
  if (live.uuid !== databaseId && live.uuid.replace(/-/g, "") !== databaseId.replace(/-/g, "")) {
    throw new RestoreDrillRefusal("Cloudflare answered with another database than the one asked for");
  }
  if (live.name !== options.expectName) {
    throw new RestoreDrillRefusal(`the database is named '${live.name}', not '${options.expectName}'; nothing was written`);
  }
  log(`[drill] Target database confirmed by name (${label})`);

  const before = await step("fingerprint", async () => fingerprintDatabase(c, databaseId));
  if (await tableExists(c, databaseId, CANARY_TABLE)) {
    throw new RestoreDrillRefusal(`${CANARY_TABLE} already exists (a stopped earlier drill?); drop it by hand after checking it, then run again`);
  }
  log(`[drill] Fingerprinted ${Object.keys(before).length} table(s)`);

  let canaryCreated = false;
  let bookmark: string | null = null;
  let restored = false;
  try {
    await step("createCanary", async () => {
      canaryCreated = true;
      await c.queryDatabase(databaseId, [
        { sql: `CREATE TABLE ${CANARY_TABLE} (id TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL)` },
        ...CANARY_ROWS.map((r) => ({ sql: `INSERT INTO ${CANARY_TABLE} (id, value, created_at) VALUES (?, ?, ?)`, params: [r.id, r.value, new Date().toISOString()] })),
      ]);
    });
    log("[drill] Created and seeded the canary table");

    bookmark = await step("bookmark", async () => c.getD1Bookmark(databaseId));
    log("[drill] Took the bookmark");

    await step("destroy", async () => {
      await c.queryDatabase(databaseId, [{ sql: `DELETE FROM ${CANARY_TABLE}` }, { sql: `DROP TABLE ${CANARY_TABLE}` }]);
    });
    if (await tableExists(c, databaseId, CANARY_TABLE)) throw new Error("the destructive change did not drop the canary table");
    log("[drill] Destructive change made: canary rows deleted, canary table dropped");

    await step("restore", async () => {
      await c.restoreD1(databaseId, bookmark!);
      restored = true;
    });
    log("[drill] Restored to the bookmark");

    await step("verify", async () => {
      const [res] = await c.queryDatabase(databaseId, [{ sql: `SELECT id, value FROM ${CANARY_TABLE} ORDER BY id` }]);
      const rows = (res?.results ?? []) as Array<{ id: string; value: string }>;
      const expected = [...CANARY_ROWS].sort((a, b) => a.id.localeCompare(b.id));
      if (rows.length !== expected.length || rows.some((r, i) => r.id !== expected[i]!.id || r.value !== expected[i]!.value)) {
        throw new Error(`the canary rows did not come back after the restore (got ${rows.length} of ${expected.length})`);
      }
      const after = await fingerprintDatabase(c, databaseId);
      if (!sameFingerprint(before, after)) throw new Error("the database fingerprint after the restore differs from the one taken before the drill");
    });
    log("[drill] Verified: canary rows restored, fingerprint matches");

    await step("dropCanary", async () => {
      await c.queryDatabase(databaseId, [{ sql: `DROP TABLE IF EXISTS ${CANARY_TABLE}` }]);
      canaryCreated = false;
    });
    if (await tableExists(c, databaseId, CANARY_TABLE)) throw new Error("the canary table is still there after dropping it");
    log("[drill] Dropped the canary table");
  } catch (error) {
    // Best effort: back to the bookmark (unless the restore already ran), then the canary goes.
    if (bookmark && !restored) {
      try {
        await c.restoreD1(databaseId, bookmark);
        log("[drill] Cleanup: restored to the bookmark");
      } catch (e) {
        log(`[drill] Cleanup warning: the restore to the bookmark failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (canaryCreated || bookmark) {
      try {
        await c.queryDatabase(databaseId, [{ sql: `DROP TABLE IF EXISTS ${CANARY_TABLE}` }]);
        log("[drill] Cleanup: dropped the canary table");
      } catch (e) {
        log(`[drill] Cleanup warning: dropping ${CANARY_TABLE} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    throw error;
  }

  durationsMs.total = Math.round((performance.now() - t0All) * 100) / 100;
  const result: TargetRestoreDrillResult = {
    success: true,
    target: label,
    startedAt,
    measuredAt: new Date().toISOString(),
    gitSha: getGitSha(),
    steps,
    durationsMs,
    tablesFingerprinted: Object.keys(before).length,
    verification: { canaryRestored: true, fingerprintMatches: true, canaryDropped: true },
  };

  const shouldWrite = options.writeEvidenceFile ?? true;
  if (shouldWrite) {
    const outPath = options.evidencePath ?? resolve(getEvidenceDir(), "deployed", "restore-drill-result.json");
    const evidenceData = {
      startedAt: result.startedAt,
      measuredAt: result.measuredAt,
      gitSha: result.gitSha,
      mode: "target",
      target: result.target,
      durationsMs: result.durationsMs,
      steps: result.steps,
      tablesFingerprinted: result.tablesFingerprinted,
      verification: result.verification,
      success: result.success,
    };
    assertRedacted(JSON.stringify(evidenceData), [databaseId, databaseId.replace(/-/g, ""), bookmark ?? "", credentials?.accountId ?? "", credentials?.token ?? ""]);
    writeEvidence(outPath, evidenceData, stampEvidence("scripts/restore-drill.ts", "measured"));
    log(`[drill] Wrote evidence to ${outPath}; record it with pnpm evidence:record-live`);
  }
  return result;
}

export interface RestoreDrillCliArgs {
  mode: "fake" | "live";
  target?: { targetDb: string; expectName: string; envFile: string; label?: string };
}

const TARGET_VALUE_FLAGS = ["--target-db", "--expect-name", "--env-file", "--label"] as const;
const BOOLEAN_FLAGS = ["--fake", "--live"] as const;

/**
 * Parses the CLI flags. Any target flag means target mode, which needs all three; --fake cannot be combined with it.
 * Anything else (an unknown argument, a `--flag=value` form, a repeated flag) is refused, so a mistyped target flag can
 * never fall back to a scratch run that reports a pass.
 */
export function parseRestoreDrillArgs(argv: string[]): RestoreDrillCliArgs {
  const values = new Map<string, string>();
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.includes("=") && arg.startsWith("--")) {
      throw new RestoreDrillRefusal(`'${arg}': write the flag and its value as two arguments (${arg.slice(0, arg.indexOf("="))} <value>)`);
    }
    if (seen.has(arg)) throw new RestoreDrillRefusal(`${arg} is given twice`);
    if ((BOOLEAN_FLAGS as readonly string[]).includes(arg)) {
      seen.add(arg);
      continue;
    }
    if ((TARGET_VALUE_FLAGS as readonly string[]).includes(arg)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new RestoreDrillRefusal(`${arg} needs a value`);
      seen.add(arg);
      values.set(arg, v);
      i += 1;
      continue;
    }
    throw new RestoreDrillRefusal(`unknown argument '${arg}'`);
  }
  if (seen.has("--fake") && seen.has("--live")) throw new RestoreDrillRefusal("--fake and --live cannot be combined");
  const targetDb = values.get("--target-db");
  const expectName = values.get("--expect-name");
  const envFile = values.get("--env-file");
  const label = values.get("--label");
  const mode: "fake" | "live" = seen.has("--live") ? "live" : "fake";
  if (targetDb === undefined && expectName === undefined && envFile === undefined) {
    if (label !== undefined) throw new RestoreDrillRefusal("--label is only for target mode");
    return { mode };
  }
  if (seen.has("--fake")) throw new RestoreDrillRefusal("target mode always runs live; --fake cannot be combined with --target-db");
  if (!targetDb || !expectName || !envFile) {
    throw new RestoreDrillRefusal("target mode needs --target-db <uuid>, --expect-name <name> and --env-file <path>");
  }
  return { mode: "live", target: { targetDb, expectName, envFile, ...(label !== undefined ? { label } : {}) } };
}

// Standalone CLI execution
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let args: RestoreDrillCliArgs;
  try {
    args = parseRestoreDrillArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`\nRestore drill refused: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const run = args.target
    ? runTargetRestoreDrill(args.target).then((r) => `target mode, ${r.target}, ${r.durationsMs.total}ms`)
    : runRestoreDrill({ mode: args.mode }).then((r) => `${args.mode} mode, ${r.durationsMs.total}ms`);
  run
    .then((summary) => {
      console.log(`\nRestore drill passed (${summary}).`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`\nRestore drill failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
