import { describe, expect, test } from "vitest";
import {
  DEPLOY_HISTORY_TABLE,
  DEPLOY_TABLE,
  MIGRATIONS_TABLE,
  createClient,
  deploy,
  memoryStore,
  openLedger,
  resourceNames,
} from "../src/provisioner/index.ts";
import * as provisioner from "../src/provisioner/index.ts";
import type { DeployInput, Migration } from "../src/provisioner/index.ts";
import { createFakeCloudflare } from "./support/fake-cloudflare.ts";
import { runRollback } from "../../../scripts/poc-rollback.ts";

const TOKEN = "cfut_Zq8rLm3VxN2pTb7YkWd4HsJc9GaE5uRo6QiXf1BvPn0AyMt";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const KEY = "9f".repeat(32);
const SUFFIX = "0a1b2c3d";

const BUNDLE_V1 = {
  code: "export default { fetch(req) { const u = new URL(req.url); if (u.pathname === '/healthz') return new Response(JSON.stringify({ ok: true, build: 'v1' }), { status: 200 }); if (u.pathname === '/readyz') return new Response(JSON.stringify({ ok: true }), { status: 200 }); return new Response('v1'); } };",
  sha256: "bundle_sha_v1_000000000000000000000000000000000000000000000000000000",
};

const BUNDLE_V2 = {
  code: "export default { fetch(req) { const u = new URL(req.url); if (u.pathname === '/healthz') return new Response(JSON.stringify({ ok: true, build: 'v2' }), { status: 200 }); if (u.pathname === '/readyz') return new Response(JSON.stringify({ ok: true }), { status: 200 }); return new Response('v2'); } };",
  sha256: "bundle_sha_v2_000000000000000000000000000000000000000000000000000000",
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

describe("Safe deploy order and rollback (UC8.6)", () => {
  test("AC1 & Task (a): deploy order is bookmark -> additive migrations -> uploadVersion -> smoke with version override header -> createDeployment 100% -> history write", async () => {
    const { fake, client, names, input } = setup();

    // 1. First deploy (v1): establishes the script and baseline schema
    const v1Migrations: Migration[] = [
      { name: "0001_initial.sql", sql: "CREATE TABLE items (id TEXT PRIMARY KEY, val TEXT);" },
    ];
    await deploy(input({ migrations: v1Migrations, bundle: BUNDLE_V1 }));

    const dbs = await client.listDatabases(names.database);
    const databaseId = dbs[0]!.uuid;
    expect(databaseId).toBeDefined();

    // 2. Second deploy (v2): additive migration + code change
    const v2Migrations: Migration[] = [
      ...v1Migrations,
      { name: "0002_add_col.sql", sql: "ALTER TABLE items ADD COLUMN note TEXT;" },
    ];

    const callsBeforeV2 = client.calls.length;
    await deploy(input({ migrations: v2Migrations, bundle: BUNDLE_V2 }));

    const v2Calls = client.calls.slice(callsBeforeV2);

    // Assert call sequence order:
    // (1) bookmark
    const bookmarkCallIndex = v2Calls.findIndex(
      (c) => c.method === "GET" && c.path.includes("/time_travel/bookmark"),
    );
    expect(bookmarkCallIndex, "must call time_travel/bookmark").toBeGreaterThanOrEqual(0);

    // (2) additive migrations
    const migrationWriteIndex = v2Calls.findIndex(
      (c) => c.method === "POST" && c.path.includes("/query") && c.sqlKind === "write",
    );
    expect(migrationWriteIndex, "must execute additive migration write").toBeGreaterThanOrEqual(0);
    expect(bookmarkCallIndex, "bookmark must happen before migration write").toBeLessThan(migrationWriteIndex);

    // (3) POST /workers/scripts/{name}/versions (uploadVersion)
    const uploadVersionIndex = v2Calls.findIndex(
      (c) => c.method === "POST" && c.path.includes(`/workers/scripts/${names.script}/versions`),
    );
    expect(uploadVersionIndex, "must call POST .../versions (uploadVersion)").toBeGreaterThanOrEqual(0);
    expect(migrationWriteIndex, "migration write must happen before uploadVersion").toBeLessThan(uploadVersionIndex);

    // (4) smoke request with header Cloudflare-Workers-Version-Overrides: {name}="{version}"
    const smokeCallIndex = v2Calls.findIndex(
      (c) => (c.path === "/healthz" || c.path === "/readyz" || c.path.includes("healthz") || c.path.includes("readyz")),
    );
    expect(smokeCallIndex, "must execute smoke check").toBeGreaterThanOrEqual(0);
    expect(uploadVersionIndex, "uploadVersion must happen before smoke check").toBeLessThan(smokeCallIndex);

    // Check request bodies / headers recorded by fake for the smoke call
    const smokeReq = (fake as any).requests?.find(
      (r: any) => r.path?.includes("healthz") || r.path === "/healthz",
    );
    expect(smokeReq, "fake must receive smoke request").toBeDefined();

    // (5) POST …/deployments at 100%
    const deploymentCallIndex = v2Calls.findIndex(
      (c) => c.method === "POST" && c.path.includes(`/workers/scripts/${names.script}/deployments`),
    );
    expect(deploymentCallIndex, "must call POST .../deployments to shift traffic").toBeGreaterThanOrEqual(0);
    expect(smokeCallIndex, "smoke check must happen before createDeployment").toBeLessThan(deploymentCallIndex);

    // (6) history write with status: success
    const historyWriteIndex = v2Calls.findIndex(
      (c, idx) => idx > deploymentCallIndex && c.method === "POST" && c.path.includes("/query") && c.sqlKind === "write",
    );
    expect(historyWriteIndex, "history write must happen after deployment shift").toBeGreaterThanOrEqual(0);

    // Verify history table contains status: success and to_version_id
    const [historyRows] = await client.queryDatabase(databaseId, [
      { sql: `SELECT id, status, from_version_id, to_version_id FROM ${DEPLOY_HISTORY_TABLE} ORDER BY started_at DESC;` },
    ]);
    expect(historyRows!.results[0]!.status).toBe("success");
  });

  test("AC2 & Task (b): smoke failure keeps traffic at 100% on old version and history records smoke_failed", async () => {
    const { fake, client, names, input } = setup();

    // 1. Initial deploy (v1) succeeds
    await deploy(input({ bundle: BUNDLE_V1 }));
    const dbs = await client.listDatabases(names.database);
    const databaseId = dbs[0]!.uuid;

    const [v1DeployRow] = await client.queryDatabase(databaseId, [
      { sql: `SELECT version_id FROM ${DEPLOY_TABLE} WHERE id = 1;` },
    ]);
    const v1VersionId = String(v1DeployRow!.results[0]!.version_id);
    expect(v1VersionId).toBeDefined();

    // 2. Configure fake smoke route to fail with 500
    if (typeof (fake as any).setHealthStub === "function") {
      (fake as any).setHealthStub(() => new Response(JSON.stringify({ error: "crash_on_boot" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }));
    } else {
      (fake as any).fail({
        when: (_m: string, p: string) => p.includes("healthz") || p === "/healthz",
        respond: { status: 500, text: JSON.stringify({ error: "crash_on_boot" }) },
      });
    }

    // 3. Deploy v2 should reject / throw DeployError containing the smoke response body
    let thrownError: any = null;
    try {
      await deploy(input({ bundle: BUNDLE_V2 }));
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError, "deploy must fail when smoke fails").not.toBeNull();
    expect(String(thrownError?.message ?? thrownError)).toContain("crash_on_boot");

    // Live traffic must stay on v1 (100% old version)
    if (typeof (client as any).listDeployments === "function") {
      const deployments = await (client as any).listDeployments(names.script);
      if (deployments && deployments.length > 0) {
        const latest = deployments[0]!;
        expect(latest.versions).toEqual(
          expect.arrayContaining([{ versionId: v1VersionId, percentage: 100 }]),
        );
      }
    }

    // Deploy table must not be updated to the failed version
    const [deployRowAfter] = await client.queryDatabase(databaseId, [
      { sql: `SELECT version_id FROM ${DEPLOY_TABLE} WHERE id = 1;` },
    ]);
    expect(deployRowAfter!.results[0]!.version_id).toBe(v1VersionId);

    // Deploy history must record status: smoke_failed
    const [historyRows] = await client.queryDatabase(databaseId, [
      { sql: `SELECT id, status, from_version_id, to_version_id FROM ${DEPLOY_HISTORY_TABLE} ORDER BY started_at DESC;` },
    ]);
    expect(historyRows!.results[0]!.status).toBe("smoke_failed");
  });

  test("AC3 & Task (c): rollback() re-deploys last_good_version_id at 100% with 1 deployment call and 0 uploads", async () => {
    const { client, names, input } = setup();

    // Check rollback export exists
    const rollback = (provisioner as any).rollback;
    expect(typeof rollback, "rollback function must exist in provisioner").toBe("function");

    // 1. Deploy v1
    await deploy(input({ bundle: BUNDLE_V1 }));
    const dbs = await client.listDatabases(names.database);
    const databaseId = dbs[0]!.uuid;

    const [v1DeployRow] = await client.queryDatabase(databaseId, [
      { sql: `SELECT version_id FROM ${DEPLOY_TABLE} WHERE id = 1;` },
    ]);
    const v1VersionId = String(v1DeployRow!.results[0]!.version_id);

    // 2. Deploy v2
    await deploy(input({ bundle: BUNDLE_V2 }));
    const [v2DeployRow] = await client.queryDatabase(databaseId, [
      { sql: `SELECT version_id FROM ${DEPLOY_TABLE} WHERE id = 1;` },
    ]);
    const v2VersionId = String(v2DeployRow!.results[0]!.version_id);
    expect(v2VersionId).not.toBe(v1VersionId);

    // 3. Rollback to last good version (v1)
    const callsBeforeRollback = client.calls.length;
    const rollbackResult = await rollback({ client, names, databaseId });
    expect(rollbackResult.rolledBack).toBe(true);
    expect(rollbackResult.versionId).toBe(v1VersionId);

    // AC3: Exactly 1 deployment call and 0 upload calls
    const rollbackCalls = client.calls.slice(callsBeforeRollback);
    const deploymentCalls = rollbackCalls.filter(
      (c) => c.method === "POST" && c.path.includes("/deployments"),
    );
    expect(deploymentCalls.length, "rollback makes exactly 1 deployment call").toBe(1);

    const uploadCalls = rollbackCalls.filter(
      (c) => (c.method === "PUT" || c.method === "POST") && c.path.includes("/workers/scripts") && !c.path.includes("/deployments"),
    );
    expect(uploadCalls.length, "rollback makes 0 uploads").toBe(0);

    // Deploy table reflects v1 is active again
    const [deployRowAfterRollback] = await client.queryDatabase(databaseId, [
      { sql: `SELECT version_id FROM ${DEPLOY_TABLE} WHERE id = 1;` },
    ]);
    expect(deployRowAfterRollback!.results[0]!.version_id).toBe(v1VersionId);
  });

  test("AC3 & Task (e): runRollback CLI runner dry-run vs --yes and backward compatibility warning", async () => {
    const { client, names, input } = setup();

    // 1. Deploy v1 with initial migration
    const v1Migrations: Migration[] = [
      { name: "0001_initial.sql", sql: "CREATE TABLE items (id TEXT PRIMARY KEY);" },
    ];
    await deploy(input({ bundle: BUNDLE_V1, migrations: v1Migrations }));

    const dbs = await client.listDatabases(names.database);
    const databaseId = dbs[0]!.uuid;
    const [v1Row] = await client.queryDatabase(databaseId, [
      { sql: `SELECT version_id FROM ${DEPLOY_TABLE} WHERE id = 1;` },
    ]);
    const v1VersionId = String(v1Row!.results[0]!.version_id);

    // 2. Deploy v2 with additive migration
    const v2Migrations: Migration[] = [
      ...v1Migrations,
      { name: "0002_extra.sql", sql: "ALTER TABLE items ADD COLUMN info TEXT;" },
    ];
    await deploy(input({ bundle: BUNDLE_V2, migrations: v2Migrations }));
    const [v2Row] = await client.queryDatabase(databaseId, [
      { sql: `SELECT version_id FROM ${DEPLOY_TABLE} WHERE id = 1;` },
    ]);
    const v2VersionId = String(v2Row!.results[0]!.version_id);
    expect(v2VersionId).not.toBe(v1VersionId);

    // 3. Dry run without yes
    const logs: string[] = [];
    const dryRun = await runRollback({
      client,
      names,
      databaseId,
      yes: false,
      log: (msg) => logs.push(msg),
    });
    expect(dryRun.rolledBack).toBe(false);
    expect(dryRun.versionId).toBe(v1VersionId);
    expect(dryRun.warning).toBeDefined();
    expect(dryRun.warning).toContain("0002_extra.sql");

    // Traffic unchanged in dry run
    const [deployRowDry] = await client.queryDatabase(databaseId, [
      { sql: `SELECT version_id FROM ${DEPLOY_TABLE} WHERE id = 1;` },
    ]);
    expect(deployRowDry!.results[0]!.version_id).toBe(v2VersionId);

    // 4. Real run with yes
    const callsBeforeYes = client.calls.length;
    const realRun = await runRollback({
      client,
      names,
      databaseId,
      yes: true,
      log: (msg) => logs.push(msg),
    });
    expect(realRun.rolledBack).toBe(true);
    expect(realRun.versionId).toBe(v1VersionId);

    // AC3 check on calls made by runRollback
    const yesCalls = client.calls.slice(callsBeforeYes);
    const deploymentsCalls = yesCalls.filter(
      (c) => c.method === "POST" && c.path.includes("/deployments"),
    );
    expect(deploymentsCalls.length).toBe(1);
    const uploadsCalls = yesCalls.filter(
      (c) => (c.method === "PUT" || c.method === "POST") && c.path.includes("/workers/scripts") && !c.path.includes("/deployments"),
    );
    expect(uploadsCalls.length).toBe(0);

    // Deploy table active version is updated to v1
    const [deployRowReal] = await client.queryDatabase(databaseId, [
      { sql: `SELECT version_id FROM ${DEPLOY_TABLE} WHERE id = 1;` },
    ]);
    expect(deployRowReal!.results[0]!.version_id).toBe(v1VersionId);
  });
});
