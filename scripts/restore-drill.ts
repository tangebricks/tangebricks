import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
      client = createClient({ credentials, fetch: (req) => fetch(req) });
    }
  }

  const steps: RestoreDrillStep[] = [];
  const durationsMs: Record<string, number> = {};
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
  let bookmarkA = "";
  let previousBookmark = "";

  try {
    log(`[drill] Starting D1 restore drill on database: ${dbName} (mode: ${mode})`);

    // Step 1: Create scratch DB
    const createdDb = await recordStep("createDb", async () => {
      return await client!.createDatabase(dbName);
    });
    databaseId = createdDb.uuid;
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
    const outPath = options.evidencePath ?? resolve(getEvidenceDir(), "restore-drill.json");
    const provenance = stampEvidence("scripts/restore-drill.ts", "measured");
    const evidenceData = {
      measuredAt: result.measuredAt,
      gitSha: result.gitSha,
      databaseName: result.databaseName,
      durationsMs: result.durationsMs,
      steps: result.steps,
      verification: result.verification,
      success: result.success,
    };
    writeEvidence(outPath, evidenceData, provenance);
    log(`[drill] Wrote evidence to ${outPath}`);
  }

  return result;
}

// Standalone CLI execution
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const isLive = process.argv.includes("--live");
  const isFake = process.argv.includes("--fake");
  const mode: "fake" | "live" = isLive ? "live" : "fake";

  runRestoreDrill({ mode })
    .then((result) => {
      console.log(`\nRestore drill passed (${mode} mode) in ${result.durationsMs.total}ms.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`\nRestore drill failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
