import { describe, expect, test } from "vitest";
import {
  DEPLOY_HISTORY_TABLE,
  MIGRATIONS_TABLE,
  createClient,
  deploy,
  memoryStore,
  openLedger,
  resourceNames,
} from "../src/provisioner/index.ts";
import type { DeployInput, Migration } from "../src/provisioner/index.ts";
import { createFakeCloudflare } from "./support/fake-cloudflare.ts";
import { runRestore } from "../../../scripts/poc-restore.ts";

const TOKEN = "cfut_Zq8rLm3VxN2pTb7YkWd4HsJc9GaE5uRo6QiXf1BvPn0AyMt";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const KEY = "9f".repeat(32);
const SUFFIX = "0a1b2c3d";

const BUNDLE = { code: "export default { fetch() { return new Response('ok'); } };", sha256: "bundle_sha" };

function setup() {
  const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT });
  const credentials = { token: TOKEN, accountId: ACCOUNT };
  const client = createClient({ credentials, fetch: fake.fetch, alsoHide: [KEY] });
  const store = memoryStore();
  let timeMs = Date.parse("2026-10-21T00:00:00.000Z");
  const nextTime = () => {
    timeMs += 1000;
    return new Date(timeMs);
  };
  const ledger = openLedger(store, () => SUFFIX, () => nextTime());
  const names = resourceNames(SUFFIX);
  const input = (over: Partial<DeployInput> = {}): DeployInput => ({
    client,
    ledger,
    names,
    accessKey: KEY,
    bundle: BUNDLE,
    migrations: [],
    compatibilityDate: "2026-10-01",
    nowIso: () => nextTime().toISOString(),
    ...over,
  });
  return { fake, client, store, ledger, names, input };
}

describe("D1 Time Travel bookmark and restore (UC8.5)", () => {
  test("AC1 & Task 1: deploy v1 -> insert row -> deploy v2 with data change -> ledger has d1_bookmark before migration write", async () => {
    const { client, ledger, names, input } = setup();

    // 1. Deploy v1
    const v1Migrations: Migration[] = [
      { name: "0001_initial.sql", sql: "CREATE TABLE items (id TEXT PRIMARY KEY, val TEXT);" },
    ];
    await deploy(input({ migrations: v1Migrations }));

    const dbs = await client.listDatabases(names.database);
    const databaseId = dbs[0]!.uuid;

    // Insert canary row into v1 table
    await client.queryDatabase(databaseId, [
      { sql: "INSERT INTO items (id, val) VALUES ('item_1', 'original');" },
    ]);
    const [rowsV1] = await client.queryDatabase(databaseId, [{ sql: "SELECT val FROM items WHERE id = 'item_1';" }]);
    expect(rowsV1!.results[0]!.val).toBe("original");

    // 2. Deploy v2: updates existing row and adds new table
    const v2Migrations: Migration[] = [
      ...v1Migrations,
      {
        name: "0002_mutate.sql",
        sql: "UPDATE items SET val = 'mutated' WHERE id = 'item_1';\nCREATE TABLE items_v2 (id TEXT PRIMARY KEY);",
      },
    ];

    const callsBeforeV2 = client.calls.length;
    await deploy(input({ migrations: v2Migrations }));

    // Check ledger has d1_bookmark
    const bookmarkEntry = ledger.entries().find((e) => e.kind === "d1_bookmark");
    expect(bookmarkEntry, "ledger must record d1_bookmark").toBeDefined();
    expect(bookmarkEntry!.status).toBe("created");
    expect(typeof bookmarkEntry!.id).toBe("string");
    const v2Bookmark = bookmarkEntry!.id!;

    // AC1: call order verification in client.calls
    const v2Calls = client.calls.slice(callsBeforeV2);
    const bookmarkCallIndex = v2Calls.findIndex((c) => c.method === "GET" && c.path.includes("/time_travel/bookmark"));
    expect(bookmarkCallIndex, "must call time_travel/bookmark").toBeGreaterThanOrEqual(0);

    const firstMigrationWriteIndex = v2Calls.findIndex(
      (c) => c.method === "POST" && c.path.includes("/query") && c.sqlKind === "write",
    );
    expect(firstMigrationWriteIndex, "first migration write must happen").toBeGreaterThanOrEqual(0);
    expect(bookmarkCallIndex, "bookmark call must precede first schema write").toBeLessThan(firstMigrationWriteIndex);

    // Verify v2 mutation landed
    const [rowsV2] = await client.queryDatabase(databaseId, [{ sql: "SELECT val FROM items WHERE id = 'item_1';" }]);
    expect(rowsV2!.results[0]!.val).toBe("mutated");

    const [migRows] = await client.queryDatabase(databaseId, [{ sql: `SELECT name FROM ${MIGRATIONS_TABLE};` }]);
    expect(migRows!.results.map((r) => r.name)).toEqual(["0001_initial.sql", "0002_mutate.sql"]);

    // Check _projectx_deploy_history has been populated
    const [historyRows] = await client.queryDatabase(databaseId, [
      { sql: `SELECT id, bookmark, status FROM ${DEPLOY_HISTORY_TABLE};` },
    ]);
    expect(historyRows!.results.length).toBeGreaterThan(0);
    expect(historyRows!.results.some((r) => r.bookmark === v2Bookmark)).toBe(true);

    // 3. Direct restore to bookmark brings back original row and resets migrations to v1
    const restoreResult = await client.restoreD1(databaseId, v2Bookmark);
    expect(restoreResult.previous_bookmark).toBeDefined();

    const [rowsAfterRestore] = await client.queryDatabase(databaseId, [{ sql: "SELECT val FROM items WHERE id = 'item_1';" }]);
    expect(rowsAfterRestore!.results[0]!.val).toBe("original");

    const [migAfterRestore] = await client.queryDatabase(databaseId, [{ sql: `SELECT name FROM ${MIGRATIONS_TABLE};` }]);
    expect(migAfterRestore!.results.map((r) => r.name)).toEqual(["0001_initial.sql"]);

    // Table items_v2 should no longer exist after restore
    const [tableCheck] = await client.queryDatabase(databaseId, [
      { sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items_v2';" },
    ]);
    expect(tableCheck!.results.length).toBe(0);

    // 4. Undoing restore with previous_bookmark brings v2 state back
    await client.restoreD1(databaseId, restoreResult.previous_bookmark);
    const [rowsAfterUndo] = await client.queryDatabase(databaseId, [{ sql: "SELECT val FROM items WHERE id = 'item_1';" }]);
    expect(rowsAfterUndo!.results[0]!.val).toBe("mutated");
  });

  test("AC2 & AC3: poc:restore script dry-run without --yes writes nothing, and --yes restores data reporting previous_bookmark", async () => {
    const { client, ledger, names, input } = setup();

    const v1Migrations: Migration[] = [
      { name: "0001_initial.sql", sql: "CREATE TABLE items (id TEXT PRIMARY KEY, val TEXT);" },
    ];
    await deploy(input({ migrations: v1Migrations }));

    const dbs = await client.listDatabases(names.database);
    const databaseId = dbs[0]!.uuid;

    await client.queryDatabase(databaseId, [
      { sql: "INSERT INTO items (id, val) VALUES ('item_1', 'original');" },
    ]);

    const v2Migrations: Migration[] = [
      ...v1Migrations,
      { name: "0002_mutate.sql", sql: "UPDATE items SET val = 'mutated' WHERE id = 'item_1';" },
    ];
    await deploy(input({ migrations: v2Migrations }));

    const [historyRows] = await client.queryDatabase(databaseId, [
      { sql: `SELECT id, bookmark FROM ${DEPLOY_HISTORY_TABLE} ORDER BY started_at DESC;` },
    ]);
    const deployId = historyRows!.results[0]!.id as string;
    const bookmark = historyRows!.results[0]!.bookmark as string;

    // AC3: Without --yes, nothing is written
    const dryRun = await runRestore({
      client,
      databaseId,
      to: deployId,
      yes: false,
    });
    expect(dryRun.restored).toBe(false);

    const [rowsStillMutated] = await client.queryDatabase(databaseId, [{ sql: "SELECT val FROM items WHERE id = 'item_1';" }]);
    expect(rowsStillMutated!.results[0]!.val).toBe("mutated");

    // AC2: With --yes, restores data and reports previous_bookmark
    const realRun = await runRestore({
      client,
      databaseId,
      to: bookmark,
      yes: true,
    });
    expect(realRun.restored).toBe(true);
    expect(realRun.previous_bookmark).toBeDefined();

    const [rowsRestored] = await client.queryDatabase(databaseId, [{ sql: "SELECT val FROM items WHERE id = 'item_1';" }]);
    expect(rowsRestored!.results[0]!.val).toBe("original");
  });

  test("AC1 edge case: deploy with 0 pending migrations does not call getD1Bookmark", async () => {
    const { client, ledger, names, input } = setup();

    const v1Migrations: Migration[] = [
      { name: "0001_initial.sql", sql: "CREATE TABLE items (id TEXT PRIMARY KEY, val TEXT);" },
    ];
    await deploy(input({ migrations: v1Migrations }));

    const callsCount = client.calls.length;
    // Re-deploy with identical migrations -> 0 pending
    await deploy(input({ migrations: v1Migrations }));

    const newCalls = client.calls.slice(callsCount);
    const bookmarkCalls = newCalls.filter((c) => c.method === "GET" && c.path.includes("/time_travel/bookmark"));
    expect(bookmarkCalls).toHaveLength(0);
  });

  test("Finding 2: lostMigrations identifies migrations applied in target deploy when started_at equals applied_at", async () => {
    const { client, ledger, names, input } = setup();

    const v1Migrations: Migration[] = [
      { name: "0001_initial.sql", sql: "CREATE TABLE items (id TEXT PRIMARY KEY, val TEXT);" },
    ];
    await deploy(input({ migrations: v1Migrations }));

    const dbs = await client.listDatabases(names.database);
    const databaseId = dbs[0]!.uuid;

    // Use a fixed timestamp for deploy v2 so started_at in _projectx_deploy_history
    // and applied_at in _projectx_migrations are identical (simulating same-batch/same-millisecond execution)
    const fixedIso = "2026-10-21T12:00:00.000Z";
    const v2Migrations: Migration[] = [
      ...v1Migrations,
      { name: "0002_mutate.sql", sql: "UPDATE items SET val = 'mutated' WHERE id = 'item_1';" },
    ];
    await deploy(input({ migrations: v2Migrations, nowIso: () => fixedIso }));

    const [historyRows] = await client.queryDatabase(databaseId, [
      { sql: `SELECT id, bookmark, started_at FROM ${DEPLOY_HISTORY_TABLE} WHERE started_at = ?;`, params: [fixedIso] },
    ]);
    expect(historyRows!.results.length).toBe(1);
    const deployId = historyRows!.results[0]!.id as string;
    const startedAt = historyRows!.results[0]!.started_at as string;

    // Verify in database that applied_at equals started_at
    const [migRows] = await client.queryDatabase(databaseId, [
      { sql: `SELECT name, applied_at FROM ${MIGRATIONS_TABLE} WHERE name = '0002_mutate.sql';` },
    ]);
    expect(migRows!.results[0]!.applied_at).toBe(startedAt);

    // Dry-run restore targeting deployId
    const dryRun = await runRestore({
      client,
      databaseId,
      to: deployId,
      yes: false,
    });

    // When applied_at == started_at, lostMigrations must include 0002_mutate.sql (reverted by restoring before v2)
    expect(dryRun.lostMigrations).toEqual(["0002_mutate.sql"]);
  });
});
