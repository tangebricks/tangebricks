import { describe, expect, test } from "vitest";
import type { ProjectLock } from "@poc/assembler";
import { createClient, deploy, isWriteCall, memoryStore, openLedger, resourceNames } from "../src/provisioner/index.ts";
import type { DeployInput, Migration } from "../src/provisioner/index.ts";
import { planDeploy } from "../src/provisioner/plan.ts";
import { createFakeCloudflare } from "./support/fake-cloudflare.ts";

const TOKEN = "cfut_Zq8rLm3VxN2pTb7YkWd4HsJc9GaE5uRo6QiXf1BvPn0AyMt";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const KEY = "9f".repeat(32);
const SUFFIX = "0a1b2c3d";

const worker = (build: string) => ({
  code: `export default { fetch(req) { const u = new URL(req.url); if (u.pathname === '/healthz' || u.pathname === '/readyz') return new Response(JSON.stringify({ ok: true, build: '${build}' }), { status: 200 }); return new Response('${build}'); } };`,
  sha256: `bundle_sha_${build}_000000000000000000000000000000000000000000000000000000`,
});
const BUNDLE_V1 = worker("v1");
const BUNDLE_V2 = worker("v2");

const M1: Migration = { name: "0001_initial.sql", sql: "CREATE TABLE items (id TEXT PRIMARY KEY, val TEXT);" };
const M2: Migration = { name: "0002_add_col.sql", sql: "ALTER TABLE items ADD COLUMN note TEXT;" };
const M_DROP: Migration = { name: "0003_drop.sql", sql: "DROP TABLE items;" };

const LOCK_V1: ProjectLock = {
  project: "demo",
  identity: "stub",
  bricks: [
    { id: "alpha", version: "1.0.0", settings: { limit: 5 } },
    { id: "beta", version: "2.3.1", settings: {} },
  ],
  migrations: ["0001_initial.sql"],
};
const LOCK_V2: ProjectLock = {
  ...LOCK_V1,
  bricks: [
    { id: "alpha", version: "1.1.0", settings: { limit: 10 } },
    { id: "beta", version: "2.3.1", settings: {} },
  ],
  migrations: ["0001_initial.sql", "0002_add_col.sql"],
};

function setup() {
  const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT });
  const client = createClient({ credentials: { token: TOKEN, accountId: ACCOUNT }, fetch: fake.fetch, alsoHide: [KEY] });
  let timeMs = Date.parse("2026-10-21T00:00:00.000Z");
  const nextTime = () => new Date((timeMs += 1000));
  const ledger = openLedger(memoryStore(), () => SUFFIX, () => nextTime());
  const names = resourceNames(SUFFIX);
  const input = (over: Partial<DeployInput> = {}): DeployInput => ({
    client,
    ledger,
    names,
    accessKey: KEY,
    bundle: BUNDLE_V1,
    migrations: [M1],
    compatibilityDate: "2026-10-01",
    nowIso: () => nextTime().toISOString(),
    ...over,
  });
  return { client, input };
}

describe("planDeploy (UC8.8)", () => {
  test("red scenario: lists every difference against the deployed state and makes zero write calls", async () => {
    const { client, input } = setup();
    await deploy(input({ lock: LOCK_V1 }));
    const deployed = await client.listVersions(resourceNames(SUFFIX).script);
    const v1Version = deployed![0]!.id;

    const before = client.calls.length;
    const plan = await planDeploy({
      ...input({ bundle: BUNDLE_V2, migrations: [M1, M2], scriptIsolation: { binding: "LOADER", type: "worker_loader" } }),
      lock: LOCK_V2,
    });
    const made = client.calls.slice(before);

    expect(made.length).toBeGreaterThan(0);
    expect(made.filter(isWriteCall)).toEqual([]); // AC1
    expect(plan.migrations).toEqual([{ name: "0002_add_col.sql", class: "additive" }]);
    expect(plan.bricks).toEqual([{ id: "alpha", from: "1.0.0", to: "1.1.0", kind: "minor" }]);
    expect(plan.settings).toEqual([{ brick: "alpha", key: "limit", from: 5, to: 10 }]);
    expect(plan.worker).toEqual({ changed: true, reasons: ["bundle", "bindings"] });
    expect(plan.workflow).toEqual({ action: "none" });
    expect(plan.rollbackTo).toBe(v1Version);
    expect(plan.blocking).toEqual([]);
    expect(plan.empty).toBe(false);
  });

  test("AC2: an unchanged project gives an empty plan", async () => {
    const { client, input } = setup();
    await deploy(input({ lock: LOCK_V1 }));
    const before = client.calls.length;
    const plan = await planDeploy({ ...input(), lock: LOCK_V1 });
    expect(client.calls.slice(before).filter(isWriteCall)).toEqual([]);
    expect(plan).toMatchObject({ migrations: [], bricks: [], settings: [], worker: { changed: false, reasons: [] }, workflow: { action: "none" }, blocking: [], empty: true });
  });

  test("a destructive migration and an unacknowledged major bump block; acknowledging the major clears only that", async () => {
    const { input } = setup();
    await deploy(input({ lock: LOCK_V1 }));
    const major: ProjectLock = { ...LOCK_V1, bricks: [{ id: "alpha", version: "2.0.0", settings: { limit: 5 } }, LOCK_V1.bricks![1]!] };
    const plan = await planDeploy({ ...input({ migrations: [M1, M_DROP] }), lock: major });
    expect(plan.migrations).toEqual([{ name: "0003_drop.sql", class: "destructive" }]);
    expect(plan.bricks[0]).toMatchObject({ id: "alpha", kind: "major" });
    expect(plan.blocking.some((b) => b.includes("0003_drop.sql"))).toBe(true);
    expect(plan.blocking.some((b) => b.includes("alpha") && b.includes("major"))).toBe(true);

    const acked = await planDeploy({ ...input({ migrations: [M1, M_DROP], allowMajor: true }), lock: major });
    expect(acked.blocking.some((b) => b.includes("major"))).toBe(false);
    expect(acked.blocking.some((b) => b.includes("0003_drop.sql"))).toBe(true);
  });

  test("deploy() refuses an unacknowledged major brick bump before any write", async () => {
    const { client, input } = setup();
    await deploy(input({ lock: LOCK_V1 }));
    const major: ProjectLock = { ...LOCK_V1, bricks: [{ id: "alpha", version: "2.0.0", settings: { limit: 5 } }, LOCK_V1.bricks![1]!] };
    const before = client.calls.length;
    await expect(deploy(input({ bundle: BUNDLE_V2, lock: major }))).rejects.toThrow(/DEPLOY_PLAN_BLOCKED.*major/s);
    expect(client.calls.slice(before).filter(isWriteCall)).toEqual([]);
  });

  test("a first deploy plans every migration and a worker upload", async () => {
    const { input } = setup();
    const plan = await planDeploy({ ...input({ migrations: [M1, M2] }), lock: LOCK_V1 });
    expect(plan.migrations.map((m) => m.name)).toEqual(["0001_initial.sql", "0002_add_col.sql"]);
    expect(plan.worker.changed).toBe(true);
    expect(plan.rollbackTo).toBeNull();
  });
});
