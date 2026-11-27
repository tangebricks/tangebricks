// Rolls a project Worker back to a previous good version at 100% without re-uploading.
//
// Usage:
//   node "--env-file=.../.env" scripts/poc-rollback.ts --state-dir <folder> [--to <version-id>] [--yes]
//
// Without --yes it prints the rollback plan and backward-compatibility warnings without writing.
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEPLOY_HISTORY_TABLE,
  DEPLOY_TABLE,
  MIGRATIONS_TABLE,
  PROOF_PREFIX,
  createClient,
  fileStore,
  loadCredentials,
  openLedger,
  resourceNames,
  rollback,
} from "../packages/deploy/src/provisioner/index.ts";
import type { Client, ResourceNames, RollbackResult } from "../packages/deploy/src/provisioner/index.ts";

export interface DeployHistoryRow {
  id: string;
  started_at: string;
  bookmark: string;
  from_version_id: string | null;
  to_version_id: string | null;
  last_good_version_id?: string | null;
  status: string;
}

export interface RollbackOptions {
  client?: Client;
  names?: ResourceNames;
  databaseId?: string;
  to?: string;
  yes?: boolean;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

export interface PocRollbackResult {
  rolledBack: boolean;
  versionId: string;
  currentVersionId: string | null;
  databaseId: string;
  scriptName: string;
  history: DeployHistoryRow[];
  warning?: string;
}

export async function runRollback(options: RollbackOptions): Promise<PocRollbackResult> {
  const log = options.log ?? ((msg: string) => console.log(msg));

  let client = options.client;
  if (!client) {
    const credentials = loadCredentials(options.env ?? process.env);
    client = createClient({ credentials, fetch: (req) => fetch(req) });
  }

  let databaseId = options.databaseId;
  let names = options.names;

  if (options.stateDir) {
    const store = fileStore(join(resolve(options.stateDir), "ledger.json"));
    const data = store.read();
    if (data) {
      const ledger = openLedger(store, () => data.suffix);
      if (!names) names = resourceNames(data.suffix);
      const dbEntry = ledger.entries().find((e) => e.kind === "d1_database" && e.status !== "removed");
      if (dbEntry?.id) databaseId = dbEntry.id;
    }
  }

  if (!names) {
    names = resourceNames("poc00000");
  }

  if (!databaseId) {
    const dbs = await client.listDatabases(names.database);
    if (dbs.length > 0) {
      databaseId = dbs[0]!.uuid;
    } else {
      const proofDbs = await client.listDatabases(PROOF_PREFIX);
      if (proofDbs.length > 0) databaseId = proofDbs[0]!.uuid;
    }
  }

  if (!databaseId) {
    throw new Error("could not determine database ID: provide --database <id> or --state-dir with an active ledger");
  }

  // Read current deploy info
  let currentVersionId: string | null = null;
  try {
    const [deployRow] = await client.queryDatabase(databaseId, [{ sql: `SELECT version_id, last_good_version_id FROM ${DEPLOY_TABLE} WHERE id = 1` }]);
    currentVersionId = (deployRow?.results[0] as { version_id?: string } | undefined)?.version_id ?? null;
  } catch {
    currentVersionId = null;
  }

  // Read deploy history
  let history: DeployHistoryRow[] = [];
  try {
    const [res] = await client.queryDatabase(databaseId, [
      {
        sql: `SELECT id, started_at, bookmark, from_version_id, to_version_id, last_good_version_id, status FROM ${DEPLOY_HISTORY_TABLE} ORDER BY started_at DESC`,
      },
    ]);
    history = (res?.results ?? []) as unknown as DeployHistoryRow[];
  } catch {
    history = [];
  }

  // Determine target rollback version
  let targetVersionId = options.to;
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
    log("Deploy history:");
    for (const row of history) {
      log(
        `  - deploy: ${row.id} | started: ${row.started_at} | status: ${row.status} | from: ${row.from_version_id ?? "none"} -> to: ${row.to_version_id ?? "none"}`,
      );
    }
    throw new Error("no previous version found to roll back to; specify --to <version-id>");
  }

  // Check backward compatibility of migrations applied since target version
  let warning: string | undefined;
  const deploysChrono = history.slice().reverse();
  const firstDeployAfter = deploysChrono.find((h) => h.from_version_id === targetVersionId);
  const targetDeployRow = history.find((h) => h.to_version_id === targetVersionId && h.status === "success");

  const referenceDeploy = firstDeployAfter ?? targetDeployRow;
  if (referenceDeploy) {
    try {
      const filterSql = firstDeployAfter
        ? `SELECT name FROM ${MIGRATIONS_TABLE} WHERE applied_at >= ?`
        : `SELECT name FROM ${MIGRATIONS_TABLE} WHERE applied_at > ?`;
      const [appliedSince] = await client.queryDatabase(databaseId, [{ sql: filterSql, params: [referenceDeploy.started_at] }]);
      const migNames = (appliedSince?.results ?? []).map((r) => String(r.name));
      if (migNames.length > 0) {
        const restoreBookmark = firstDeployAfter?.bookmark || targetDeployRow?.bookmark;
        const bookmarkHint = restoreBookmark ? ` to bookmark ${restoreBookmark}` : "";
        warning = `WARNING: Migrations were applied after version ${targetVersionId} was originally deployed: ${migNames.join(", ")}. If these migrations altered or dropped schemas, consider running poc:restore to rewind D1${bookmarkHint}.`;
      }
    } catch {
      // Non-fatal
    }
  }

  log("Rollback plan:");
  log(`  Script:             ${names.script}`);
  log(`  Database ID:        ${databaseId}`);
  log(`  Current version:    ${currentVersionId ?? "unknown"}`);
  log(`  Target rollback:    ${targetVersionId}`);
  if (warning) {
    log(`  ${warning}`);
  }

  if (!options.yes) {
    log("\nDry run: no changes made. Pass --yes to execute rollback.");
    return {
      rolledBack: false,
      versionId: targetVersionId,
      currentVersionId,
      databaseId,
      scriptName: names.script,
      history,
      ...(warning ? { warning } : {}),
    };
  }

  // Execute rollback
  const result: RollbackResult = await rollback({
    client,
    names,
    databaseId,
    targetVersionId,
  });

  log(`Worker ${names.script} rolled back to version ${result.versionId} at 100%.`);
  if (result.warning) {
    log(result.warning);
  }

  return {
    rolledBack: true,
    versionId: result.versionId,
    currentVersionId,
    databaseId,
    scriptName: names.script,
    history,
    ...(result.warning ? { warning: result.warning } : {}),
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

  runRollback({ to, stateDir, databaseId, yes })
    .then((_result) => {
      process.exit(0);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
