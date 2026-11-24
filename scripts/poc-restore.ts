// Restores a project D1 database to a Time Travel bookmark or deploy ID, and reports previous_bookmark.
//
// Usage:
//   node "--env-file=.../.env" scripts/poc-restore.ts --state-dir <folder> --to <bookmark|deploy-id> --yes
//
// Without --to it lists deploy history rows.
// Without --yes it prints the plan (database, target bookmark, what will be lost) without writing.
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEPLOY_HISTORY_TABLE,
  MIGRATIONS_TABLE,
  PROOF_PREFIX,
  createClient,
  fileStore,
  loadCredentials,
  openLedger,
} from "../packages/deploy/src/provisioner/index.ts";
import type { Client } from "../packages/deploy/src/provisioner/index.ts";

export interface DeployHistoryRow {
  id: string;
  started_at: string;
  bookmark: string;
  from_version_id: string | null;
  to_version_id: string | null;
  status: string;
}

export interface RestoreOptions {
  client?: Client;
  databaseId?: string;
  to?: string;
  yes?: boolean;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

export interface RestoreResult {
  restored: boolean;
  databaseId: string;
  bookmark: string;
  previous_bookmark?: string;
  targetDeployId?: string;
  fromVersionId?: string | null;
  history: DeployHistoryRow[];
  lostMigrations?: string[];
}

export async function runRestore(options: RestoreOptions): Promise<RestoreResult> {
  const log = options.log ?? ((msg: string) => console.log(msg));

  let client = options.client;
  if (!client) {
    const credentials = loadCredentials(options.env ?? process.env);
    client = createClient({ credentials, fetch: (req) => fetch(req) });
  }

  let databaseId = options.databaseId;
  if (!databaseId && options.stateDir) {
    const store = fileStore(join(resolve(options.stateDir), "ledger.json"));
    const data = store.read();
    if (data) {
      const ledger = openLedger(store, () => data.suffix);
      const dbEntry = ledger.entries().find((e) => e.kind === "d1_database" && e.status !== "removed");
      if (dbEntry?.id) databaseId = dbEntry.id;
    }
  }

  if (!databaseId) {
    const dbs = await client.listDatabases(PROOF_PREFIX);
    if (dbs.length > 0) databaseId = dbs[0]!.uuid;
  }

  if (!databaseId) {
    throw new Error("could not determine database ID: provide --database <id> or --state-dir with an active ledger");
  }

  // Read deploy history
  let history: DeployHistoryRow[] = [];
  try {
    const [res] = await client.queryDatabase(databaseId, [
      { sql: `SELECT id, started_at, bookmark, from_version_id, to_version_id, status FROM ${DEPLOY_HISTORY_TABLE} ORDER BY started_at DESC` },
    ]);
    history = (res?.results ?? []) as unknown as DeployHistoryRow[];
  } catch {
    // History table might not exist yet if no migrations ran
    history = [];
  }

  if (!options.to) {
    log(`Deploy history for database ${databaseId}:`);
    if (history.length === 0) {
      log("  (no deploy history recorded yet)");
    } else {
      for (const row of history) {
        log(`  - deploy: ${row.id} | started: ${row.started_at} | bookmark: ${row.bookmark} | status: ${row.status} | from: ${row.from_version_id ?? "none"} -> to: ${row.to_version_id ?? "none"}`);
      }
    }
    log("\nSpecify --to <bookmark|deploy-id> to restore.");
    return { restored: false, databaseId, bookmark: "", history };
  }

  const to = options.to;
  const matchedRow = history.find((r) => r.id === to || r.bookmark === to);
  const targetBookmark = matchedRow ? matchedRow.bookmark : to;
  const targetDeployId = matchedRow?.id;
  const fromVersionId = matchedRow?.from_version_id ?? null;

  // Find what migrations or data would be reverted
  let lostMigrations: string[] = [];
  if (matchedRow) {
    try {
      const [migRes] = await client.queryDatabase(databaseId, [
        { sql: `SELECT name FROM ${MIGRATIONS_TABLE} WHERE applied_at >= ?`, params: [matchedRow.started_at] },
      ]);
      lostMigrations = (migRes?.results ?? []).map((r) => String(r.name));
    } catch {
      lostMigrations = [];
    }
  }

  log("Restore plan:");
  log(`  Database ID:      ${databaseId}`);
  log(`  Target bookmark:  ${targetBookmark}`);
  if (targetDeployId) log(`  Target deploy ID: ${targetDeployId}`);
  if (lostMigrations.length > 0) {
    log(`  Migrations that will be reverted: ${lostMigrations.join(", ")}`);
  } else {
    log("  No migrations recorded after target deploy.");
  }

  if (!options.yes) {
    log("\nDry run: no changes made. Pass --yes to execute restore.");
    return {
      restored: false,
      databaseId,
      bookmark: targetBookmark,
      targetDeployId,
      fromVersionId,
      history,
      lostMigrations,
    };
  }

  // Execute restore
  const restoreResult = await client.restoreD1(databaseId, targetBookmark);
  log(`Database ${databaseId} restored to bookmark ${targetBookmark}.`);
  log(`Previous bookmark (for undo): ${restoreResult.previous_bookmark}`);

  if (fromVersionId) {
    log(`Worker rollback target: ${fromVersionId} (will be restored via UC8.6 rollback if available).`);
  }

  return {
    restored: true,
    databaseId,
    bookmark: targetBookmark,
    previous_bookmark: restoreResult.previous_bookmark,
    targetDeployId,
    fromVersionId,
    history,
    lostMigrations,
  };
}

// CLI entrypoint
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const getArg = (name: string): string | undefined => {
    const idx = process.argv.indexOf(name);
    return idx >= 0 ? process.argv[idx + 1] : undefined;
  };

  const to = getArg("--to");
  const stateDir = getArg("--state-dir");
  const databaseId = getArg("--database");
  const yes = process.argv.includes("--yes");

  runRestore({ to, stateDir, databaseId, yes })
    .then((result) => {
      if (result.restored) {
        process.exit(0);
      } else {
        process.exit(to && !yes ? 0 : 0);
      }
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
