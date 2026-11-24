import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { assemble } from "@poc/assembler";
import { codeLines, findDynamicEvaluation } from "@poc/harness";
import { catalog } from "../../assembler/catalog.generated.ts";
import { INVOICE_FLOW_BLUEPRINT } from "../../../test/support/blueprints.ts";
import {
  CloudflareApiError,
  CloudflareNetworkError,
  DEPLOY_TABLE,
  DeployError,
  KEY_BINDING,
  MIGRATIONS_TABLE,
  UploadFailed,
  createClient,
  deploy,
  findSecrets,
  findUnledgered,
  isWriteCall,
  memoryStore,
  migrationsFrom,
  openLedger,
  readAccountState,
  resourceNames,
  teardown,
} from "../src/provisioner/index.ts";
import type { DeployInput, Migration } from "../src/provisioner/index.ts";
import { createFakeCloudflare } from "./support/fake-cloudflare.ts";
import type { FakeOptions } from "./support/fake-cloudflare.ts";

// The provisioner against a fake Cloudflare (see test/support/fake-cloudflare.ts for what the fake does and does not prove).
// The tool's own report is never the evidence: a deploy is judged by reading the fake's state before and after, by a client
// of its own, and by the list of calls the tool made.
const root = resolve(import.meta.dirname, "..", "..", "..");
const TOKEN = "cfut_Zq8rLm3VxN2pTb7YkWd4HsJc9GaE5uRo6QiXf1BvPn0AyMt";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const KEY = "9f".repeat(32);
const SUFFIX = "0a1b2c3d";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const bundleOf = (code: string) => ({ code, sha256: sha(code) });
const BUNDLE = bundleOf("export default { fetch() { return new Response('ok'); } }; export class GraphRunner {}");
const MIGRATIONS: Migration[] = [
  { name: "0001_a.sql", sql: "CREATE TABLE a (id INTEGER PRIMARY KEY, label TEXT);\nCREATE INDEX a_label ON a (label);" },
  { name: "0002_b.sql", sql: "CREATE TABLE b (id TEXT PRIMARY KEY, a_id INTEGER REFERENCES a (id));" },
];

function world(options: Partial<FakeOptions> = {}) {
  const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT, ...options });
  const sleeps: number[] = [];
  const credentials = { token: TOKEN, accountId: ACCOUNT };
  const make = () => createClient({ credentials, fetch: fake.fetch, sleep: async (ms) => void sleeps.push(ms), alsoHide: [KEY] });
  const client = make();
  const store = memoryStore();
  const ledger = openLedger(store, () => SUFFIX, () => new Date("2026-10-21T00:00:00Z"));
  const names = resourceNames(SUFFIX);
  const input = (over: Partial<DeployInput> = {}): DeployInput => ({ client, ledger, names, accessKey: KEY, bundle: BUNDLE, migrations: MIGRATIONS, compatibilityDate: "2026-10-01", nowIso: () => "2026-10-21T00:00:00.000Z", ...over });
  return { fake, client, store, ledger, names, input, independentClient: make, sleeps };
}

let logged: string[];
beforeEach(() => {
  logged = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
});
afterEach(() => vi.restoreAllMocks());

describe("a first deploy to an empty account", () => {
  test("creates the database, applies each migration once in order, uploads one Worker with its bindings, and switches its address on", async () => {
    const w = world();
    const result = await deploy(w.input());
    expect(result.changes.map((c) => c.kind)).toEqual(["database_created", "bookkeeping_created", "migration_applied", "migration_applied", "script_uploaded", "address_enabled"]);
    expect(result.url).toBe("https://projectx-poc-0a1b2c3d.fake-subdomain.workers.dev");

    const state = w.fake.state();
    expect(state.databases).toHaveLength(1);
    expect(state.databases[0]!.name).toBe(w.names.database);
    expect(state.databases[0]!.tables).toEqual(["_projectx_deploy", "_projectx_migrations", "a", "b"]);
    expect(w.fake.rows(w.names.database, `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY name`)).toEqual([{ name: "0001_a.sql" }, { name: "0002_b.sql" }]);
    expect(state.scripts).toHaveLength(1);
    expect(state.scripts[0]).toMatchObject({ name: w.names.script, addressEnabled: true, bindingTypes: ["d1", "secret_text"], codeSha256: sha(BUNDLE.code) });
    expect(state.scripts[0]!.versionIds).toHaveLength(1);
    expect(state.workflows).toEqual([]);
  });

  test("does things in a safe order: the database and its tables exist before the Worker that binds to it is uploaded", async () => {
    const w = world();
    await deploy(w.input());
    const order = w.fake.requests.map((r) => `${r.method} ${r.path.replace(/\/[0-9a-f-]{36}\//, "/{id}/")}`);
    const at = (text: string) => order.findIndex((line) => line.includes(text));
    expect(at("POST /client/v4/accounts/{account}/d1/database")).toBeLessThan(at("PUT /client/v4/accounts/{account}/workers/scripts/"));
    expect(at("/query")).toBeLessThan(at("PUT /client/v4/accounts/{account}/workers/scripts/"));
    expect(at("PUT /client/v4/accounts/{account}/workers/scripts/")).toBeLessThan(at("POST /client/v4/accounts/{account}/workers/scripts/projectx-poc-0a1b2c3d/subdomain"));
  });

  test("records what it created in the ledger, with the database's id, and nothing else", async () => {
    const w = world();
    await deploy(w.input());
    const entries = w.ledger.entries();
    expect(entries.map((e) => [e.kind, e.name, e.status])).toEqual([
      ["d1_database", "projectx-poc-0a1b2c3d-db", "created"],
      ["worker_script", "projectx-poc-0a1b2c3d", "created"],
    ]);
    expect(entries[0]!.id).toBe(w.fake.state().databases[0]!.uuid);
  });

  test("uploads isolated brick Worker before host and records worker_script in ledger as ${names.script}-b-<id>", async () => {
    const w = world();
    await deploy(
      w.input({
        brickWorkers: [
          {
            id: "fixture-isolated",
            bundle: { code: "export default {}", sha256: "abc123" },
          },
        ],
      }),
    );
    const entries = w.ledger.entries();
    expect(entries.map((e) => [e.kind, e.name, e.status])).toEqual([
      ["d1_database", "projectx-poc-0a1b2c3d-db", "created"],
      ["worker_script", "projectx-poc-0a1b2c3d-b-fixture-isolated", "created"],
      ["worker_script", "projectx-poc-0a1b2c3d", "created"],
    ]);

    // Verify isolated brick Worker was uploaded before the host Worker
    const order = w.fake.requests.map((r) => `${r.method} ${r.path}`);
    const isolatedUpload = order.findIndex((l) => l.startsWith("PUT ") && l.includes("projectx-poc-0a1b2c3d-b-fixture-isolated"));
    const hostUpload = order.findIndex((l) => l.startsWith("PUT ") && l.includes("projectx-poc-0a1b2c3d") && !l.includes("-b-"));
    expect(isolatedUpload).toBeGreaterThan(-1);
    expect(hostUpload).toBeGreaterThan(isolatedUpload);

    // Verify host Worker includes service binding for the isolated brick
    const hostUploadBody = w.fake.bodies.find((b) => b.includes("projectx-poc-0a1b2c3d") && b.includes("BRICK_FIXTURE_ISOLATED")) ?? "";
    expect(hostUploadBody).toContain("BRICK_FIXTURE_ISOLATED");
  });

  test("a migration that is several statements, with an index, is applied for real and its record lands with it", async () => {
    const w = world();
    await deploy(w.input());
    expect(w.fake.rows(w.names.database, "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'a_label'")).toHaveLength(1);
  });

  test("the project's real migrations (workspaces, wallet, invoices) apply to a database", async () => {
    const assembled = assemble(INVOICE_FLOW_BLUEPRINT, catalog);
    if (!assembled.ok) throw new Error(assembled.errors.join("; "));
    const migrations = migrationsFrom(assembled.files);
    expect(migrations.map((m) => m.name)).toEqual(["0001_multi-workspace__0001_multi_workspace.sql", "0002_credit-wallet__0001_credit_wallet.sql", "0003_credit-wallet__0002_workspace_scoped_idempotency.sql", "0004_entity__invoices.sql", "0005_shell__px_rate_limits.sql"]);
    const w = world();
    await deploy(w.input({ migrations }));
    const tables = w.fake.state().databases[0]!.tables;
    for (const table of ["mw_workspaces", "mw_members", "credit_wallets", "credit_ledger", "ent_invoices"]) expect(tables).toContain(table);
  });

  test("the Worker is uploaded with the database id the fake knows and the access key as a secret, not as plain text", async () => {
    const w = world();
    await deploy(w.input());
    const upload = w.fake.bodies.find((b) => b.includes('"main_module"'))!;
    expect(upload).toContain(w.fake.state().databases[0]!.uuid);
    expect(upload).toContain('"type":"secret_text"');
    expect(upload).not.toContain('"type":"plain_text"');
    expect(upload).toContain(`"name":"${KEY_BINDING}"`);
  });
});

describe("a second deploy of the same thing", () => {
  test("changes nothing: no change reported, no write call made, and the account is exactly as it was", async () => {
    const w = world();
    await deploy(w.input());
    const before = JSON.stringify(w.fake.state());
    const beforeIndependent = await readAccountState(w.independentClient(), w.names);
    const callsBefore = w.client.calls.length;

    const second = await deploy(w.input());

    expect(second.changes).toEqual([]);
    const secondCalls = w.client.calls.slice(callsBefore);
    expect(secondCalls.length).toBeGreaterThan(0);
    expect(secondCalls.filter(isWriteCall)).toEqual([]);
    expect(JSON.stringify(w.fake.state())).toBe(before);
    expect(await readAccountState(w.independentClient(), w.names)).toEqual(beforeIndependent);
  });

  test("the same holds on a third and fourth run", async () => {
    const w = world();
    await deploy(w.input());
    const before = JSON.stringify(w.fake.state());
    for (let i = 0; i < 3; i += 1) expect((await deploy(w.input())).changes).toEqual([]);
    expect(JSON.stringify(w.fake.state())).toBe(before);
  });

  test("a fresh process (a new client, the same ledger and key) also finds nothing to do", async () => {
    const w = world();
    await deploy(w.input());
    const callsOfNew = w.independentClient();
    const result = await deploy(w.input({ client: callsOfNew }));
    expect(result.changes).toEqual([]);
    expect(callsOfNew.calls.filter(isWriteCall)).toEqual([]);
  });
});

describe("a deploy after something changed", () => {
  test("a different project uploads exactly one new version and touches nothing else", async () => {
    const w = world();
    await deploy(w.input());
    const before = await readAccountState(w.independentClient(), w.names);
    const changed = await deploy(w.input({ bundle: bundleOf(BUNDLE.code + "\n// one setting changed") }));
    expect(changed.changes.map((c) => c.kind)).toEqual(["script_uploaded"]);
    const after = await readAccountState(w.independentClient(), w.names);
    expect(after.versionCount).toBe(before.versionCount + 1);
    expect(after.latestVersionId).not.toBe(before.latestVersionId);
    expect(after.databaseId).toBe(before.databaseId);
    expect(after.appliedMigrations).toEqual(before.appliedMigrations);
    expect(w.fake.state().databases).toHaveLength(1);
  });

  test("and the run after that, with the same new project, changes nothing again", async () => {
    const w = world();
    await deploy(w.input());
    const next = bundleOf(BUNDLE.code + "\n// changed");
    await deploy(w.input({ bundle: next }));
    expect((await deploy(w.input({ bundle: next }))).changes).toEqual([]);
  });

  test("a new access key uploads a new version (the secret changed), and the key is not stored anywhere", async () => {
    const w = world();
    await deploy(w.input());
    const rotated = "7e".repeat(32);
    const result = await deploy(w.input({ accessKey: rotated }));
    expect(result.changes.map((c) => c.kind)).toEqual(["script_uploaded"]);
    expect(w.fake.state().scripts[0]!.versionIds).toHaveLength(2);
    expect(findSecrets(JSON.stringify(w.fake.rows(w.names.database, `SELECT * FROM ${DEPLOY_TABLE}`)), { oldKey: KEY, newKey: rotated })).toEqual([]);
  });

  test("a changed compatibility date is a change", async () => {
    const w = world();
    await deploy(w.input());
    expect((await deploy(w.input({ compatibilityDate: "2026-10-15" }))).changes.map((c) => c.kind)).toEqual(["script_uploaded"]);
  });

  test("a Worker changed behind the tool's back (a version it did not upload) is noticed and replaced", async () => {
    const w = world();
    await deploy(w.input());
    w.fake.tamperWithScript(w.names.script);
    const result = await deploy(w.input());
    expect(result.changes.map((c) => c.kind)).toEqual(["script_uploaded"]);
    expect(w.fake.state().scripts[0]!.versionIds).toHaveLength(3);
    expect((await deploy(w.input())).changes).toEqual([]);
  });

  test("a new migration is applied alone; the ones already applied are not run again", async () => {
    const w = world();
    await deploy(w.input());
    const more = [...MIGRATIONS, { name: "0003_c.sql", sql: "CREATE TABLE c (id INTEGER PRIMARY KEY);" }];
    const result = await deploy(w.input({ migrations: more }));
    expect(result.changes.map((c) => c.kind)).toEqual(["migration_applied"]);
    expect(result.changes[0]!.what).toContain("0003_c.sql");
    expect(w.fake.state().databases[0]!.tables).toContain("c");
  });

  // Story 0.7: a brick that adds a migration renumbers every later emitted one. The renumbered migrations have already
  // run, so only the new one may run; re-running `ALTER TABLE ... ADD COLUMN` would fail with "duplicate column".
  test("a brick migration that shifts the numbers of later ones: only the new migration runs on redeploy", async () => {
    const w = world();
    const first: Migration[] = [
      { name: "0001_brick-x__0001_init.sql", sql: "CREATE TABLE x (id INTEGER PRIMARY KEY);" },
      { name: "0002_brick-y__0001_init.sql", sql: "CREATE TABLE y (id INTEGER PRIMARY KEY);" },
      { name: "0003_brick-y__0002_add.sql", sql: "ALTER TABLE y ADD COLUMN note TEXT;" },
    ];
    await deploy(w.input({ migrations: first }));
    const shifted: Migration[] = [
      first[0]!,
      { name: "0002_brick-x__0002_more.sql", sql: "CREATE TABLE x_more (id INTEGER PRIMARY KEY);" },
      { name: "0003_brick-y__0001_init.sql", sql: first[1]!.sql },
      { name: "0004_brick-y__0002_add.sql", sql: first[2]!.sql },
    ];
    const result = await deploy(w.input({ migrations: shifted }));
    expect(result.changes.map((c) => c.kind)).toEqual(["migration_applied"]);
    expect(result.changes[0]!.what).toContain("0002_brick-x__0002_more.sql");
    expect(w.fake.state().databases[0]!.tables).toContain("x_more");
    // And the run after that has nothing left to do.
    expect((await deploy(w.input({ migrations: shifted }))).changes).toEqual([]);
  });

  test("a migration edited after it ran is refused outright: nothing is written", async () => {
    const w = world();
    await deploy(w.input());
    const before = JSON.stringify(w.fake.state());
    const callsBefore = w.client.calls.length;
    const edited = [{ ...MIGRATIONS[0]!, sql: MIGRATIONS[0]!.sql + "\nALTER TABLE a ADD COLUMN extra TEXT;" }, MIGRATIONS[1]!];
    await expect(deploy(w.input({ migrations: edited }))).rejects.toThrow(/applied with different contents.*never run twice/);
    expect(w.client.calls.slice(callsBefore).filter(isWriteCall)).toEqual([]);
    expect(JSON.stringify(w.fake.state())).toBe(before);
  });

  test("a migration that fails halfway is rolled back whole, leaves no record, and applies cleanly once fixed", async () => {
    const w = world();
    const broken = [MIGRATIONS[0]!, { name: "0002_b.sql", sql: "CREATE TABLE b (id TEXT PRIMARY KEY);\nINSERT INTO no_such_table VALUES (1);" }];
    const error = await deploy(w.input({ migrations: broken })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as CloudflareApiError).codes).toEqual([7500]);
    expect(w.fake.state().databases[0]!.tables).not.toContain("b");
    expect(w.fake.rows(w.names.database, `SELECT name FROM ${MIGRATIONS_TABLE}`)).toEqual([{ name: "0001_a.sql" }]);
    expect(w.fake.state().scripts).toEqual([]); // nothing was uploaded against a half-migrated database
    const fixed = await deploy(w.input());
    expect(fixed.changes.map((c) => c.kind)).toEqual(["migration_applied", "script_uploaded", "address_enabled"]);
  });
});

describe("an account that is not ready, or a run that stopped", () => {
  test("an account with no workers.dev name is told so before anything is created", async () => {
    const w = world({ subdomain: null });
    await expect(deploy(w.input())).rejects.toThrow(/no workers\.dev name yet.*does not create one/);
    expect(w.client.calls.filter(isWriteCall)).toEqual([]);
    expect(w.fake.state().databases).toEqual([]);
    expect(w.ledger.entries()).toEqual([]);
  });

  test("a database with this deploy's name but no ledger entry (a run stopped early) is adopted, not duplicated", async () => {
    const w = world();
    const id = w.fake.seedDatabase(w.names.database);
    const result = await deploy(w.input());
    expect(result.changes[0]!.kind).toBe("database_adopted");
    expect(w.fake.state().databases).toHaveLength(1);
    expect(w.ledger.entries().find((e) => e.kind === "d1_database")).toMatchObject({ status: "created", id });
  });

  test("two databases with the name stop the run rather than guess", async () => {
    const w = world();
    w.fake.seedDatabase(w.names.database);
    w.fake.seedDatabase(w.names.database);
    await expect(deploy(w.input())).rejects.toBeInstanceOf(DeployError);
    expect(w.client.calls.filter(isWriteCall)).toEqual([]);
  });

  test("a database whose name merely contains this one's is not mistaken for it", async () => {
    const w = world();
    w.fake.seedDatabase(`${w.names.database}-old`);
    const result = await deploy(w.input());
    expect(result.changes[0]!.kind).toBe("database_created");
    expect(w.fake.state().databases).toHaveLength(2);
  });

  test("the ledger already knows a database is coming BEFORE it is asked for, so a failed create leaves a trace", async () => {
    const w = world();
    w.fake.fail({ when: (m, p) => m === "POST" && p.endsWith("/d1/database"), respond: { status: 500, body: { success: false, errors: [{ code: 1000, message: "internal" }] } } });
    await expect(deploy(w.input())).rejects.toBeInstanceOf(CloudflareApiError);
    expect(w.store.snapshot()!.entries).toEqual([{ kind: "d1_database", name: w.names.database, status: "creating", at: "2026-10-21T00:00:00.000Z" }]);
  });

  test("the same for the Worker: an upload that fails leaves it recorded as 'creating'", async () => {
    const w = world({ refuseAllUploads: true });
    await expect(deploy(w.input())).rejects.toBeInstanceOf(UploadFailed);
    expect(w.ledger.entries().find((e) => e.kind === "worker_script")).toMatchObject({ status: "creating" });
  });

  test("an answer lost after Cloudflare made the database: the run fails, the next finds it by name, and there is still only one", async () => {
    const w = world();
    w.fake.fail({ when: (m, p) => m === "POST" && p.endsWith("/d1/database"), times: 1, respond: "network-error", afterHandling: true });
    await expect(deploy(w.input())).rejects.toBeInstanceOf(CloudflareNetworkError);
    expect(w.fake.state().databases).toHaveLength(1); // Cloudflare did make it
    expect(w.ledger.entries()[0]).toMatchObject({ status: "creating" });
    const result = await deploy(w.input());
    expect(w.fake.state().databases).toHaveLength(1);
    expect(w.ledger.entries().find((e) => e.kind === "d1_database")).toMatchObject({ status: "created", id: w.fake.state().databases[0]!.uuid });
    expect(result.changes.map((c) => c.kind)).not.toContain("database_created");
  });

  test("a run that stopped after the migrations but before the upload picks up where it left off", async () => {
    const w = world();
    w.fake.fail({ when: (m, p) => m === "PUT" && p.includes("/workers/scripts/"), times: 1, respond: { status: 500, body: { success: false, errors: [{ code: 1000, message: "internal" }] } } });
    await expect(deploy(w.input())).rejects.toBeInstanceOf(UploadFailed);
    const resumed = await deploy(w.input());
    expect(resumed.changes.map((c) => c.kind)).toEqual(["script_uploaded", "address_enabled"]);
    expect(w.fake.state().databases).toHaveLength(1);
    expect(w.fake.rows(w.names.database, `SELECT COUNT(*) AS n FROM ${MIGRATIONS_TABLE}`)).toEqual([{ n: 2 }]);
  });
});

describe("when Cloudflare refuses the Worker upload", () => {
  const WORKFLOW = { binding: "GRAPH_RUNNER", className: "GraphRunner" };

  test("it can carry a Workflow binding when the account accepts it, and the Workflow is then listed", async () => {
    const w = world();
    const result = await deploy(w.input({ workflow: WORKFLOW }));
    expect(result.changes.map((c) => c.kind)).toContain("script_uploaded");
    expect(w.fake.state().scripts[0]!.bindingTypes).toEqual(["d1", "secret_text", "workflow"]);
    expect(w.fake.state().workflows).toEqual([{ name: w.names.workflow, className: "GraphRunner", script: w.names.script }]);
    expect(w.ledger.entries().map((e) => e.kind)).toEqual(["d1_database", "worker_script", "workflow"]);
  });

  test("a refusal of the Workflow binding alone, while the plain script is accepted, is classed as the platform refusing, and the answer is kept", async () => {
    const w = world({ refuseWorkflowBindings: true });
    const error = (await deploy(w.input({ workflow: WORKFLOW })).catch((e: unknown) => e)) as UploadFailed;
    expect(error).toBeInstanceOf(UploadFailed);
    expect(error.classification).toBe("platform_refusal");
    expect(error.control).toEqual({ accepted: true });
    expect(error.withWorkflow).toBeInstanceOf(CloudflareApiError);
    expect((error.withWorkflow as CloudflareApiError).body).toContain("binding type workflow is not accepted");
    expect((error.withWorkflow as CloudflareApiError).codes).toEqual([10021]);
  });

  test("the throw-away control script is removed afterwards and the real Worker was never created", async () => {
    const w = world({ refuseWorkflowBindings: true });
    await deploy(w.input({ workflow: WORKFLOW })).catch(() => undefined);
    expect(w.fake.state().scripts).toEqual([]);
    expect(w.ledger.entries().find((e) => e.name.endsWith("-ctl"))).toMatchObject({ kind: "worker_script", status: "removed" });
    expect(w.fake.requests.filter((r) => r.method === "PUT")).toHaveLength(2); // the upload and the control
  });

  test("when the plain script is refused too, the Workflow binding is NOT the cause and this is not classed as a platform refusal", async () => {
    const w = world({ refuseAllUploads: true });
    const error = (await deploy(w.input({ workflow: WORKFLOW })).catch((e: unknown) => e)) as UploadFailed;
    expect(error.classification).toBe("not_the_workflow_binding");
    expect(error.control!.accepted).toBe(false);
    expect(error.control!.error).toBeInstanceOf(CloudflareApiError);
    expect(w.fake.state().scripts).toEqual([]);
  });

  test("a script that is too big is refused with and without the binding, so it is never read as a refusal of the idea", async () => {
    const w = world({ maxScriptBytes: 10 });
    const error = (await deploy(w.input({ workflow: WORKFLOW })).catch((e: unknown) => e)) as UploadFailed;
    expect(error.classification).toBe("not_the_workflow_binding");
    expect((error.withWorkflow as CloudflareApiError).codes).toEqual([10027]);
  });

  test("a network failure during the upload is not a refusal, and no control upload is made", async () => {
    const w = world();
    w.fake.fail({ when: (m, p) => m === "PUT" && p.includes("/workers/scripts/"), respond: "network-error" });
    const error = (await deploy(w.input({ workflow: WORKFLOW })).catch((e: unknown) => e)) as UploadFailed;
    expect(error.classification).toBe("not_a_refusal");
    expect(error.withWorkflow).toBeInstanceOf(CloudflareNetworkError);
    expect(w.fake.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  });

  test("an answer that is not what the API documents is not a refusal either", async () => {
    const w = world();
    w.fake.fail({ when: (m, p) => m === "PUT" && p.includes("/workers/scripts/"), respond: { status: 200, text: "<html>maintenance</html>" } });
    const error = (await deploy(w.input({ workflow: WORKFLOW })).catch((e: unknown) => e)) as UploadFailed;
    expect(error.classification).toBe("not_a_refusal");
  });

  test("a refusal when no Workflow binding was asked for is never a platform refusal of the Workflow", async () => {
    const w = world({ refuseAllUploads: true });
    const error = (await deploy(w.input()).catch((e: unknown) => e)) as UploadFailed;
    expect(error.classification).toBe("not_the_workflow_binding");
    expect(w.fake.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  });

  test("a binding to a class the script does not export is refused with and without it only if the plain script is also refused", async () => {
    const w = world();
    const error = (await deploy(w.input({ workflow: { binding: "GRAPH_RUNNER", className: "NoSuchClass" } })).catch((e: unknown) => e)) as UploadFailed;
    expect(error.classification).toBe("platform_refusal"); // the plain script is accepted, so by this rule the binding alone is refused
    expect((error.withWorkflow as CloudflareApiError).details.join()).toMatch(/does not export a class named NoSuchClass/);
  });
});

describe("the Workflow the binding names", () => {
  // Found on the real service (2026-10-21): uploading a Worker with a Workflow binding registers NOTHING. The Workflows list
  // stayed empty and starting a run threw until the Workflow was registered with its own call. The fake now behaves so.
  const WORKFLOW = { binding: "GRAPH_RUNNER", className: "GraphRunner" };
  const workflowCalls = (w: ReturnType<typeof world>, from = 0) => w.client.calls.slice(from).filter((c) => c.path.includes("/workflows/") && c.method === "PUT");

  test("is registered by its own call, after the upload and before the address is switched on", async () => {
    const w = world();
    const result = await deploy(w.input({ workflow: WORKFLOW }));
    expect(result.changes.map((c) => c.kind)).toEqual(["database_created", "bookkeeping_created", "migration_applied", "migration_applied", "script_uploaded", "workflow_registered", "address_enabled"]);
    const order = w.fake.requests.map((r) => `${r.method} ${r.path.replace("/client/v4/accounts/{account}", "")}`);
    const at = (text: string) => order.findIndex((line) => line.includes(text));
    expect(at("PUT /workers/scripts/projectx-poc-0a1b2c3d")).toBeGreaterThan(-1);
    expect(at("PUT /workflows/projectx-poc-0a1b2c3d-graphs")).toBeGreaterThan(at("PUT /workers/scripts/projectx-poc-0a1b2c3d"));
    expect(at("POST /workers/scripts/projectx-poc-0a1b2c3d/subdomain")).toBeGreaterThan(at("PUT /workflows/"));
    expect(w.fake.state().workflows).toEqual([{ name: w.names.workflow, className: "GraphRunner", script: w.names.script }]);
  });

  test("an upload on its own leaves the account with no Workflow", async () => {
    const w = world();
    await deploy(w.input()); // no workflow asked for: nothing is registered, as the real service does
    expect(w.fake.state().workflows).toEqual([]);
    const upload = new FormData();
    upload.set("metadata", new Blob([JSON.stringify({ main_module: "worker.mjs", compatibility_date: "2026-10-01", bindings: [{ type: "workflow", name: "GRAPH_RUNNER", workflow_name: "someone-elses-flow", class_name: "GraphRunner" }] })], { type: "application/json" }));
    upload.set("worker.mjs", new Blob([BUNDLE.code], { type: "application/javascript+module" }), "worker.mjs");
    const response = await w.fake.fetch(new Request(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/some-script`, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}` }, body: upload }));
    expect(response.status).toBe(200);
    expect(w.fake.state().workflows).toEqual([]);
  });

  test("the ledger knows the Workflow is coming before it is asked for, and has it as created afterwards", async () => {
    const w = world();
    w.fake.fail({ when: (m, p) => m === "PUT" && p.includes("/workflows/"), times: 1, respond: { status: 500, body: { success: false, errors: [{ code: 1000, message: "internal" }] } } });
    await expect(deploy(w.input({ workflow: WORKFLOW }))).rejects.toBeInstanceOf(CloudflareApiError);
    expect(w.ledger.entries().find((e) => e.kind === "workflow")).toMatchObject({ status: "creating" });
    expect(w.fake.state().workflows).toEqual([]);
    const resumed = await deploy(w.input({ workflow: WORKFLOW }));
    expect(resumed.changes.map((c) => c.kind)).toEqual(["workflow_registered", "address_enabled"]);
    expect(w.ledger.entries().find((e) => e.kind === "workflow")).toMatchObject({ status: "created" });
  });

  test("a second run registers nothing and makes no call that writes", async () => {
    const w = world();
    await deploy(w.input({ workflow: WORKFLOW }));
    const from = w.client.calls.length;
    const second = await deploy(w.input({ workflow: WORKFLOW }));
    expect(second.changes).toEqual([]);
    expect(workflowCalls(w, from)).toEqual([]);
    expect(w.client.calls.slice(from).filter(isWriteCall)).toEqual([]);
  });

  test("a changed project is registered again with its new version (a new upload does it every time)", async () => {
    const w = world();
    await deploy(w.input({ workflow: WORKFLOW }));
    const result = await deploy(w.input({ workflow: WORKFLOW, bundle: bundleOf(BUNDLE.code + "\n// changed") }));
    expect(result.changes.map((c) => c.kind)).toEqual(["script_uploaded", "workflow_registered"]);
  });

  test("a Workflow deleted behind the tool's back is registered again, and nothing else is touched", async () => {
    const w = world();
    await deploy(w.input({ workflow: WORKFLOW }));
    const before = w.fake.state().scripts[0]!.versionIds;
    await w.client.deleteWorkflow(w.names.workflow);
    const result = await deploy(w.input({ workflow: WORKFLOW }));
    expect(result.changes.map((c) => c.kind)).toEqual(["workflow_registered"]);
    expect(w.fake.state().scripts[0]!.versionIds).toEqual(before);
  });

  test("a Workflow registered for another class is corrected", async () => {
    const w = world();
    await deploy(w.input({ workflow: WORKFLOW }));
    await w.client.putWorkflow(w.names.workflow, { className: "Response", scriptName: w.names.script });
    const result = await deploy(w.input({ workflow: WORKFLOW }));
    expect(result.changes.map((c) => c.kind)).toEqual(["workflow_registered"]);
    expect(w.fake.state().workflows[0]!.className).toBe("GraphRunner");
  });

  test("a Workflow registered for the same class on another Worker is corrected", async () => {
    const w = world();
    await deploy(w.input({ workflow: WORKFLOW }));
    w.fake.seedScript("someone-elses-worker", "export class GraphRunner {}");
    await w.client.putWorkflow(w.names.workflow, { className: "GraphRunner", scriptName: "someone-elses-worker" });
    const result = await deploy(w.input({ workflow: WORKFLOW }));
    expect(result.changes.map((c) => c.kind)).toEqual(["workflow_registered"]);
    expect(w.fake.state().workflows[0]!.script).toBe(w.names.script);
  });

  test("a Workflow is not registered when none was asked for", async () => {
    const w = world();
    await deploy(w.input());
    expect(w.fake.requests.some((r) => r.path.includes("/workflows"))).toBe(false);
  });

  test("a refusal of the registration is reported as it is, not as a refusal of the upload", async () => {
    const w = world();
    w.fake.fail({ when: (m, p) => m === "PUT" && p.includes("/workflows/"), respond: { status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] } } });
    const error = await deploy(w.input({ workflow: WORKFLOW })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect(error).not.toBeInstanceOf(UploadFailed);
  });
});

describe("secrets", () => {
  test("neither the token nor the account id nor the access key reaches the ledger, the call log, a result, an error or the console, over a full set of runs including failures", async () => {
    const w = world();
    const outputs: string[] = [];
    const first = await deploy(w.input());
    outputs.push(JSON.stringify(first));
    outputs.push(JSON.stringify((await deploy(w.input())).changes));
    outputs.push(JSON.stringify(await deploy(w.input({ bundle: bundleOf(BUNDLE.code + "\n//2") }))));
    w.fake.fail({ when: (m, p) => m === "GET" && p.endsWith("/d1/database"), times: 1, respond: { status: 403, body: { success: false, errors: [{ code: 10000, message: `denied for ${TOKEN} on ${ACCOUNT} with ${KEY}` }] } } });
    const failure = (await deploy(w.input()).catch((e: unknown) => e)) as Error;
    outputs.push(failure.message, JSON.stringify(failure, Object.getOwnPropertyNames(failure)));
    const bad = world({ refuseWorkflowBindings: true });
    const refused = (await deploy(bad.input({ workflow: { binding: "GRAPH_RUNNER", className: "GraphRunner" } })).catch((e: unknown) => e)) as Error;
    outputs.push(refused.message, JSON.stringify(refused, Object.getOwnPropertyNames(refused)), JSON.stringify(bad.client.calls), JSON.stringify(bad.store.snapshot()));
    outputs.push(JSON.stringify(w.client.calls), JSON.stringify(w.store.snapshot()), logged.join("\n"));

    const all = outputs.join("\n");
    expect(findSecrets(all, { token: TOKEN, accountId: ACCOUNT, accessKey: KEY })).toEqual([]);
    expect(failure.message).toContain("[hidden]"); // the echo was caught and replaced, not just absent
  });

  test("the token is in no request body or address the fake received, only in the Authorization header", async () => {
    const w = world();
    await deploy(w.input());
    await deploy(w.input());
    for (const body of w.fake.bodies) expect(body).not.toContain(TOKEN);
    for (const r of w.fake.requests) expect(`${r.path}${r.query}`).not.toContain(TOKEN);
  });

  test("the access key is sent to Cloudflare only inside the upload, as a secret binding, and in no other request", async () => {
    const w = world();
    await deploy(w.input());
    const carrying = w.fake.bodies.filter((b) => b.includes(KEY));
    expect(carrying).toHaveLength(1);
    expect(carrying[0]).toContain('"type":"secret_text"');
  });

  test("the provisioner's source starts no program, reads no environment but in credentials.ts, writes files only in the two file stores, and prints nothing", () => {
    const dir = join(root, "packages", "deploy", "src", "provisioner");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const file of files) {
      const code = codeLines(readFileSync(join(dir, file), "utf8")).map((l) => l.text).join("\n");
      expect(code, file).not.toMatch(/child_process|\bspawn\w*\s*\(|\bexec\w*\s*\(|\bwrangler\b/);
      expect(code, file).not.toMatch(/\bconsole\./);
      expect(findDynamicEvaluation(code), file).toEqual([]);
      if (file !== "credentials.ts") expect(code, file).not.toMatch(/process\.env/);
      if (!["ledger.ts", "access-key.ts"].includes(file)) expect(code, file).not.toMatch(/from "node:fs"|writeFile|appendFile|createWriteStream/);
    }
  });
});

describe("teardown", () => {
  test("removes what the ledger lists, workflow first, then the Worker, then the database, and leaves the account empty", async () => {
    const w = world();
    await deploy(w.input({ workflow: { binding: "GRAPH_RUNNER", className: "GraphRunner" } }));
    const result = await teardown(w.client, w.ledger);
    expect(result.removed.map((r) => r.kind)).toEqual(["workflow", "worker_script", "d1_database"]);
    expect(result.unledgered).toEqual([]);
    expect(w.fake.state()).toEqual({ databases: [], scripts: [], workflows: [] });
    expect(w.ledger.entries().every((e) => e.status === "removed")).toBe(true);
    const deletes = w.fake.requests.filter((r) => r.method === "DELETE").map((r) => r.path);
    expect(deletes).toHaveLength(3);
  });

  test("a second teardown does nothing", async () => {
    const w = world();
    await deploy(w.input());
    await teardown(w.client, w.ledger);
    const before = w.fake.requests.length;
    const again = await teardown(w.client, w.ledger);
    expect(again.removed).toEqual([]);
    expect(w.fake.requests.slice(before).filter((r) => r.method === "DELETE")).toEqual([]);
  });

  test("a ledger entry whose name is not the proof's stops teardown before any request is made", async () => {
    const w = world();
    await deploy(w.input());
    const damaged = memoryStore({ suffix: SUFFIX, entries: [{ kind: "d1_database", name: "production-db", id: "x", status: "created", at: "2026-10-21T00:00:00Z" }, ...w.store.snapshot()!.entries] });
    const ledger = openLedger(damaged, () => SUFFIX);
    const before = w.fake.requests.length;
    await expect(teardown(w.client, ledger)).rejects.toThrow(/refusing to touch "production-db"/);
    expect(w.fake.requests.length).toBe(before);
    expect(w.fake.state().databases).toHaveLength(1);
  });

  test("things with the proof's prefix that the ledger does not know are reported by name and left in place", async () => {
    const w = world();
    await deploy(w.input());
    w.fake.seedScript("projectx-poc-deadbeef");
    w.fake.seedDatabase("projectx-poc-deadbeef-db");
    w.fake.seedDatabase("my-production-db");
    w.fake.seedScript("my-production-worker");
    const result = await teardown(w.client, w.ledger);
    expect(result.unledgered).toEqual([
      { kind: "worker_script", name: "projectx-poc-deadbeef" },
      { kind: "d1_database", name: "projectx-poc-deadbeef-db" },
    ]);
    expect(w.fake.state().scripts.map((s) => s.name).sort()).toEqual(["my-production-worker", "projectx-poc-deadbeef"]);
    expect(w.fake.state().databases.map((d) => d.name).sort()).toEqual(["my-production-db", "projectx-poc-deadbeef-db"]);
  });

  test("a database that has this name but not the id the ledger recorded is not deleted (it is not the one we made)", async () => {
    const w = world();
    await deploy(w.input());
    w.fake.fail({ when: () => false, respond: "network-error" }); // no-op, keeps the helper exercised
    const entries = w.store.snapshot()!;
    entries.entries.find((e) => e.kind === "d1_database")!.id = "an-id-we-did-not-record";
    const ledger = openLedger(memoryStore(entries), () => SUFFIX);
    const result = await teardown(w.client, ledger);
    expect(result.alreadyGone.map((r) => r.kind)).toContain("d1_database");
    expect(w.fake.state().databases).toHaveLength(1);
    expect(result.unledgered).toEqual([{ kind: "d1_database", name: w.names.database }]);
  });

  test("a resource that is already gone is reported as gone, not as an error", async () => {
    const w = world();
    await deploy(w.input());
    w.fake.state(); // read only
    await w.client.deleteScript(w.names.script);
    const result = await teardown(w.client, w.ledger);
    expect(result.alreadyGone).toEqual([{ kind: "worker_script", name: w.names.script }]);
    expect(result.removed.map((r) => r.kind)).toEqual(["d1_database"]);
  });

  test("findUnledgered is read-only", async () => {
    const w = world();
    await deploy(w.input());
    const before = w.fake.requests.length;
    await findUnledgered(w.client, w.ledger);
    expect(w.fake.requests.slice(before).every((r) => r.method === "GET")).toBe(true);
  });
});

describe("migrationsFrom", () => {
  test("takes the project's migrations/*.sql in path order and nothing else", () => {
    const files = { "migrations/0002_b.sql": "B", "migrations/0001_a.sql": "A", "src/index.ts": "x", "migrations/notes.md": "n", "migrations/sub/0003_c.sql": "C", "package.json": "{}" };
    expect(migrationsFrom(files)).toEqual([
      { name: "0001_a.sql", sql: "A" },
      { name: "0002_b.sql", sql: "B" },
    ]);
  });
});
