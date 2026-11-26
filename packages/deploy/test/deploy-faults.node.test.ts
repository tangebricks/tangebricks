import { describe, expect, test } from "vitest";
import {
  DEPLOY_HISTORY_TABLE,
  DEPLOY_TABLE,
  MIGRATIONS_TABLE,
  createClient,
  deploy,
  memoryStore,
  openLedger,
  readAccountState,
  resourceNames,
} from "../src/provisioner/index.ts";
import type { DeployInput, Migration } from "../src/provisioner/index.ts";
import { createFakeCloudflare } from "./support/fake-cloudflare.ts";

const TOKEN = "cfut_Zq8rLm3VxN2pTb7YkWd4HsJc9GaE5uRo6QiXf1BvPn0AyMt";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const KEY = "9f".repeat(32);
const SUFFIX = "0a1b2c3d";

const BUNDLE_V1 = {
  code: "export default { fetch(req) { const u = new URL(req.url); if (u.pathname === '/healthz') return new Response(JSON.stringify({ ok: true, build: 'v1' }), { status: 200 }); if (u.pathname === '/readyz') return new Response(JSON.stringify({ ok: true }), { status: 200 }); return new Response('v1'); } };",
  sha256: "1111111111111111111111111111111111111111111111111111111111111111",
};

const BUNDLE_V2 = {
  code: "export default { fetch(req) { const u = new URL(req.url); if (u.pathname === '/healthz') return new Response(JSON.stringify({ ok: true, build: 'v2' }), { status: 200 }); if (u.pathname === '/readyz') return new Response(JSON.stringify({ ok: true }), { status: 200 }); return new Response('v2'); } };",
  sha256: "2222222222222222222222222222222222222222222222222222222222222222",
};

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
    bundle: BUNDLE_V1,
    migrations: [],
    compatibilityDate: "2026-10-01",
    nowIso: () => nextTime().toISOString(),
    ...over,
  });
  return { fake, client, store, ledger, names, input, nextTime };
}

describe("Deploy fault-injection suite (UC8.7)", () => {
  test("Fault 1: uploadVersion fails after migrations applied -> traffic stays old, history upload_failed, re-run uploads and converges with no migration re-run", async () => {
    const { fake, client, names, input } = setup();

    const m1: Migration = { name: "0001_init.sql", sql: "CREATE TABLE items (id TEXT PRIMARY KEY);" };
    await deploy(input({ migrations: [m1], bundle: BUNDLE_V1 }));

    const dbs = await client.listDatabases(names.database);
    const databaseId = dbs[0]!.uuid;
    const [deployRowV1] = await client.queryDatabase(databaseId, [
      { sql: `SELECT version_id FROM ${DEPLOY_TABLE} WHERE id = 1;` },
    ]);
    const v1VersionId = String(deployRowV1!.results[0]!.version_id);

    const m2: Migration = { name: "0002_add_col.sql", sql: "ALTER TABLE items ADD COLUMN note TEXT;" };

    // Inject fault: uploadVersion fails after migrations are applied
    fake.fail({
      when: (method, path) => method === "POST" && path.includes(`/workers/scripts/${names.script}/versions`),
      respond: "network-error",
      times: 1,
    });

    await expect(deploy(input({ migrations: [m1, m2], bundle: BUNDLE_V2 }))).rejects.toThrow();

    // Verify after failure:
    // 1. Traffic stays on old version
    const deploymentsAfterFail = fake.listDeployments(names.script);
    expect(deploymentsAfterFail[0]!.versions[0]!.version_id).toBe(v1VersionId);

    // 2. History status is upload_failed, last_good_version_id is v1
    const [historyRowsAfterFail] = await client.queryDatabase(databaseId, [
      { sql: `SELECT status, last_good_version_id, from_version_id FROM ${DEPLOY_HISTORY_TABLE} ORDER BY started_at DESC;` },
    ]);
    expect(historyRowsAfterFail!.results[0]!.status).toBe("upload_failed");
    expect(historyRowsAfterFail!.results[0]!.last_good_version_id).toBe(v1VersionId);

    // 3. Migration m2 was applied to D1
    const [appliedMigrations] = await client.queryDatabase(databaseId, [
      { sql: `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY name;` },
    ]);
    expect(appliedMigrations!.results.map((r) => r.name)).toEqual(["0001_init.sql", "0002_add_col.sql"]);

    // Re-run deploy without faults
    fake.clearFaults();
    const callsBeforeRerun = client.calls.length;
    await deploy(input({ migrations: [m1, m2], bundle: BUNDLE_V2 }));
    const rerunCalls = client.calls.slice(callsBeforeRerun);

    // Assert: no migration re-run
    const rerunMigrationWrites = rerunCalls.filter(
      (c) => c.method === "POST" && c.path.includes("/query") && c.sqlKind === "write" && (c as any).sql?.includes(MIGRATIONS_TABLE),
    );
    expect(rerunMigrationWrites.length).toBe(0);

    // Assert: traffic is shifted to new version
    const finalDeployments = fake.listDeployments(names.script);
    const v2VersionId = finalDeployments[0]!.versions[0]!.version_id;
    expect(v2VersionId).not.toBe(v1VersionId);

    // Assert: history is success
    const [finalHistory] = await client.queryDatabase(databaseId, [
      { sql: `SELECT status, last_good_version_id, to_version_id FROM ${DEPLOY_HISTORY_TABLE} ORDER BY started_at DESC;` },
    ]);
    expect(finalHistory!.results[0]!.status).toBe("success");
    expect(finalHistory!.results[0]!.to_version_id).toBe(v2VersionId);
    expect(finalHistory!.results[0]!.last_good_version_id).toBe(v2VersionId);

    // AC1: readAccountState is consistent
    const state = await readAccountState(client, names);
    expect(state.appliedMigrations).toEqual(["0001_init.sql", "0002_add_col.sql"]);
    expect(state.latestVersionId).toBe(v2VersionId);
  });

  test("Fault 2: uploadVersion succeeds but the answer is lost (afterHandling: true) -> re-run detects orphan version by annotation hash and reuses it", async () => {
    const { fake, client, names, input } = setup();

    await deploy(input({ bundle: BUNDLE_V1 }));
    const dbs = await client.listDatabases(names.database);
    const databaseId = dbs[0]!.uuid;
    const [deployRowV1] = await client.queryDatabase(databaseId, [
      { sql: `SELECT version_id FROM ${DEPLOY_TABLE} WHERE id = 1;` },
    ]);
    const v1VersionId = String(deployRowV1!.results[0]!.version_id);

    // Inject fault: uploadVersion succeeds in Cloudflare, but response is lost
    fake.fail({
      when: (method, path) => method === "POST" && path.includes(`/workers/scripts/${names.script}/versions`),
      respond: "network-error",
      afterHandling: true,
      times: 1,
    });

    await expect(deploy(input({ bundle: BUNDLE_V2 }))).rejects.toThrow();

    // The orphan version exists on Cloudflare
    const scriptVersions = fake.state().scripts.find((s) => s.name === names.script)?.versionIds ?? [];
    expect(scriptVersions.length).toBe(2);
    const orphanVersionId = scriptVersions[0]!;
    expect(orphanVersionId).not.toBe(v1VersionId);

    // Traffic still on v1
    expect(fake.listDeployments(names.script)[0]!.versions[0]!.version_id).toBe(v1VersionId);

    // Re-run deploy
    fake.clearFaults();
    const callsBeforeRerun = client.calls.length;
    await deploy(input({ bundle: BUNDLE_V2 }));
    const rerunCalls = client.calls.slice(callsBeforeRerun);

    // Re-run must NOT have called uploadVersion again! It must detect and reuse orphan version
    const uploadVersionCallsInRerun = rerunCalls.filter(
      (c) => c.method === "POST" && c.path.includes(`/workers/scripts/${names.script}/versions`),
    );
    expect(uploadVersionCallsInRerun.length, "must not re-upload version; must adopt orphan version").toBe(0);

    // The deployed version should be the adopted orphan version
    const finalDeployments = fake.listDeployments(names.script);
    expect(finalDeployments[0]!.versions[0]!.version_id).toBe(orphanVersionId);

    // History and deploy table updated with orphan version
    const [deployRowFinal] = await client.queryDatabase(databaseId, [
      { sql: `SELECT version_id, last_good_version_id FROM ${DEPLOY_TABLE} WHERE id = 1;` },
    ]);
    expect(deployRowFinal!.results[0]!.version_id).toBe(orphanVersionId);
    expect(deployRowFinal!.results[0]!.last_good_version_id).toBe(orphanVersionId);

    // AC1: readAccountState consistent
    const state = await readAccountState(client, names);
    expect(state.latestVersionId).toBe(orphanVersionId);
  });

  test("Fault 3: Crash between createDeployment and the history write -> re-run reads listDeployments, sees new version live, writes history, and makes no second deployment", async () => {
    const { fake, client, names, input } = setup();

    await deploy(input({ bundle: BUNDLE_V1 }));
    const dbs = await client.listDatabases(names.database);
    const databaseId = dbs[0]!.uuid;
    const [deployRowV1] = await client.queryDatabase(databaseId, [
      { sql: `SELECT version_id FROM ${DEPLOY_TABLE} WHERE id = 1;` },
    ]);
    const v1VersionId = String(deployRowV1!.results[0]!.version_id);

    // Inject fault: createDeployment succeeds on Cloudflare, but network fails after handling
    fake.fail({
      when: (method, path) => method === "POST" && path.includes(`/workers/scripts/${names.script}/deployments`),
      respond: "network-error",
      afterHandling: true,
      times: 1,
    });

    await expect(deploy(input({ bundle: BUNDLE_V2 }))).rejects.toThrow();

    // On Cloudflare, deployment was created and new version is already taking 100%
    const deploymentsAfterCrash = fake.listDeployments(names.script);
    const liveVersionId = deploymentsAfterCrash[0]!.versions[0]!.version_id;
    expect(liveVersionId).not.toBe(v1VersionId);

    // But DEPLOY_TABLE still holds v1
    const [deployRowAfterCrash] = await client.queryDatabase(databaseId, [
      { sql: `SELECT version_id, last_good_version_id FROM ${DEPLOY_TABLE} WHERE id = 1;` },
    ]);
    expect(deployRowAfterCrash!.results[0]!.version_id).toBe(v1VersionId);

    // Re-run deploy
    fake.clearFaults();
    const callsBeforeRerun = client.calls.length;
    await deploy(input({ bundle: BUNDLE_V2 }));
    const rerunCalls = client.calls.slice(callsBeforeRerun);

    // Must make NO second createDeployment call!
    const deploymentCallsInRerun = rerunCalls.filter(
      (c) => c.method === "POST" && c.path.includes(`/workers/scripts/${names.script}/deployments`),
    );
    expect(deploymentCallsInRerun.length, "must make no second deployment call").toBe(0);

    // History and deploy table reconciled to liveVersionId with status success
    const [deployRowFinal] = await client.queryDatabase(databaseId, [
      { sql: `SELECT version_id, last_good_version_id FROM ${DEPLOY_TABLE} WHERE id = 1;` },
    ]);
    expect(deployRowFinal!.results[0]!.version_id).toBe(liveVersionId);
    expect(deployRowFinal!.results[0]!.last_good_version_id).toBe(liveVersionId);

    const [finalHistory] = await client.queryDatabase(databaseId, [
      { sql: `SELECT status, to_version_id, last_good_version_id FROM ${DEPLOY_HISTORY_TABLE} ORDER BY started_at DESC;` },
    ]);
    expect(finalHistory!.results[0]!.status).toBe("success");
    expect(finalHistory!.results[0]!.to_version_id).toBe(liveVersionId);
    expect(finalHistory!.results[0]!.last_good_version_id).toBe(liveVersionId);

    // AC1: readAccountState consistent
    const state = await readAccountState(client, names);
    expect(state.latestVersionId).toBe(liveVersionId);
  });

  test("Fault 4: Bookmark call fails -> no migration runs", async () => {
    const { fake, client, names, input } = setup();

    const m1: Migration = { name: "0001_init.sql", sql: "CREATE TABLE items (id TEXT PRIMARY KEY);" };
    await deploy(input({ migrations: [m1], bundle: BUNDLE_V1 }));

    const m2: Migration = { name: "0002_new_table.sql", sql: "CREATE TABLE new_table (id TEXT);" };

    // Inject fault: getD1Bookmark fails (times: 3 so client GET retry also fails)
    fake.fail({
      when: (method, path) => method === "GET" && path.includes("/time_travel/bookmark"),
      respond: { status: 500, body: { success: false, errors: [{ code: 7000, message: "bookmark failed" }] } },
      times: 3,
    });

    await expect(deploy(input({ migrations: [m1, m2], bundle: BUNDLE_V2 }))).rejects.toThrow();

    // Verify: no migration statements from m2 ran
    const dbs = await client.listDatabases(names.database);
    const databaseId = dbs[0]!.uuid;
    const [tables] = await client.queryDatabase(databaseId, [
      { sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'new_table';" },
    ]);
    expect(tables!.results.length).toBe(0);

    const [recordedMigrations] = await client.queryDatabase(databaseId, [
      { sql: `SELECT name FROM ${MIGRATIONS_TABLE};` },
    ]);
    expect(recordedMigrations!.results.map((r) => r.name)).toEqual(["0001_init.sql"]);

    // AC1: readAccountState has only m1
    const state = await readAccountState(client, names);
    expect(state.appliedMigrations).toEqual(["0001_init.sql"]);
  });

  test("Fault 5: Migration batch fails mid-way -> D1 batch atomicity is asserted, _projectx_migrations is unchanged, and re-run retries", async () => {
    const { client, names, input } = setup();

    const m1: Migration = { name: "0001_init.sql", sql: "CREATE TABLE items (id TEXT PRIMARY KEY);" };
    await deploy(input({ migrations: [m1], bundle: BUNDLE_V1 }));

    const dbs = await client.listDatabases(names.database);
    const databaseId = dbs[0]!.uuid;

    // m2 has valid first statement and invalid second statement
    const m2Bad: Migration = {
      name: "0002_atomic_check.sql",
      sql: "CREATE TABLE partial_table (id TEXT); INSERT INTO non_existent_table_crash VALUES ('x');",
    };

    await expect(deploy(input({ migrations: [m1, m2Bad], bundle: BUNDLE_V2 }))).rejects.toThrow();

    // Assert atomicity: partial_table was rolled back and does NOT exist
    const [tables] = await client.queryDatabase(databaseId, [
      { sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial_table';" },
    ]);
    expect(tables!.results.length, "partial_table must be rolled back by batch transaction").toBe(0);

    // _projectx_migrations is unchanged
    const [recorded] = await client.queryDatabase(databaseId, [
      { sql: `SELECT name FROM ${MIGRATIONS_TABLE};` },
    ]);
    expect(recorded!.results.map((r) => r.name)).toEqual(["0001_init.sql"]);

    // Re-run with fixed migration
    const m2Fixed: Migration = {
      name: "0002_atomic_check.sql",
      sql: "CREATE TABLE partial_table (id TEXT); INSERT INTO partial_table VALUES ('fixed');",
    };
    await deploy(input({ migrations: [m1, m2Fixed], bundle: BUNDLE_V2 }));

    // Assert: re-run retries and applies m2Fixed
    const [tablesAfter] = await client.queryDatabase(databaseId, [
      { sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial_table';" },
    ]);
    expect(tablesAfter!.results.length).toBe(1);

    const [rowsAfter] = await client.queryDatabase(databaseId, [
      { sql: "SELECT id FROM partial_table;" },
    ]);
    expect(rowsAfter!.results[0]!.id).toBe("fixed");

    // AC1: readAccountState has both
    const state = await readAccountState(client, names);
    expect(state.appliedMigrations).toEqual(["0001_init.sql", "0002_atomic_check.sql"]);
  });

  test("Fault 6: createDeployment 5xx -> old version keeps traffic", async () => {
    const { fake, client, names, input } = setup();

    await deploy(input({ bundle: BUNDLE_V1 }));
    const dbs = await client.listDatabases(names.database);
    const databaseId = dbs[0]!.uuid;
    const [deployRowV1] = await client.queryDatabase(databaseId, [
      { sql: `SELECT version_id FROM ${DEPLOY_TABLE} WHERE id = 1;` },
    ]);
    const v1VersionId = String(deployRowV1!.results[0]!.version_id);

    // Inject fault: createDeployment returns 500
    fake.fail({
      when: (method, path) => method === "POST" && path.includes(`/workers/scripts/${names.script}/deployments`),
      respond: { status: 500, body: { success: false, errors: [{ code: 10021, message: "deployment failed 500" }] } },
      times: 1,
    });

    await expect(deploy(input({ bundle: BUNDLE_V2 }))).rejects.toThrow();

    // Assert: old version keeps 100% traffic
    const deployments = fake.listDeployments(names.script);
    expect(deployments[0]!.versions[0]!.version_id).toBe(v1VersionId);
    expect(deployments[0]!.versions[0]!.percentage).toBe(100);

    // Live code is still v1 code
    expect(fake.codeOf(names.script)).toContain("build: 'v1'");

    // AC1: readAccountState consistency: latest active / last_good is v1
    const [deployRow] = await client.queryDatabase(databaseId, [
      { sql: `SELECT version_id, last_good_version_id FROM ${DEPLOY_TABLE} WHERE id = 1;` },
    ]);
    expect(deployRow!.results[0]!.version_id).toBe(v1VersionId);
    expect(deployRow!.results[0]!.last_good_version_id).toBe(v1VersionId);
  });
});
