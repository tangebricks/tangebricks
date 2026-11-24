import { describe, expect, test } from "vitest";
import type { ProjectLock } from "@poc/assembler";
import { MockCloudflareControlPlane, createByocProvisioner } from "../src/index.ts";
import { createClient, deploy, memoryStore, openLedger, resourceNames } from "../src/provisioner/index.ts";
import { planDeploy } from "../src/provisioner/plan.ts";
import { createFakeCloudflare } from "./support/fake-cloudflare.ts";

// UC8.8 AC3: for the same previous lock, new lock and migrations, Studio's BYOC plan and the provisioner's planDeploy must report the
// same migrations, brick moves and setting changes, because both call provisioner/plan-core.ts.
const TOKEN = "cfut_Zq8rLm3VxN2pTb7YkWd4HsJc9GaE5uRo6QiXf1BvPn0AyMt";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const KEY = "9f".repeat(32);
const PREVIOUS: ProjectLock = { project: "demo", bricks: [{ id: "alpha", version: "1.0.0", settings: { limit: 5 } }, { id: "beta", version: "1.2.0", settings: { mode: "a" } }], migrations: ["0001_initial.sql"] };
const NEXT: ProjectLock = { project: "demo", bricks: [{ id: "alpha", version: "1.4.0", settings: { limit: 9 } }, { id: "beta", version: "1.2.0", settings: { mode: "b", extra: true } }, { id: "gamma", version: "0.1.0", settings: {} }], migrations: ["0001_initial.sql", "0002_add_col.sql", "0003_drop.sql"] };
const M1 = { name: "0001_initial.sql", sql: "CREATE TABLE items (id TEXT PRIMARY KEY, val TEXT);" };
const M2 = { name: "0002_add_col.sql", sql: "ALTER TABLE items ADD COLUMN note TEXT;" };
const M3 = { name: "0003_drop.sql", sql: "DROP TABLE items;" };

describe("Studio plan and planDeploy agree (UC8.8 AC3)", () => {
  test("same migrations, bricks and settings for the same inputs", async () => {
    const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT });
    const client = createClient({ credentials: { token: TOKEN, accountId: ACCOUNT }, fetch: fake.fetch, alsoHide: [KEY] });
    const ledger = openLedger(memoryStore(), () => "0a1b2c3d", () => new Date());
    const names = resourceNames("0a1b2c3d");
    const bundle = { code: "export default { fetch() { return new Response('ok'); } };", sha256: "bundle_sha_parity_00000000000000000000000000000000000000000000000000" };
    await deploy({ client, ledger, names, accessKey: KEY, bundle, migrations: [M1], compatibilityDate: "2026-10-01", lock: PREVIOUS });
    const provisioned = await planDeploy({ client, ledger, names, accessKey: KEY, bundle, migrations: [M1, M2, M3], compatibilityDate: "2026-10-01", lock: NEXT, allowDestructive: true });

    const controlPlane = new MockCloudflareControlPlane();
    controlPlane.registerToken({ token: "cf_live_token_parity_12345", accountId: ACCOUNT, accountName: "Acme BYOC" });
    const studio = await createByocProvisioner({ apiClient: controlPlane, resolveToken: async () => "cf_live_token_parity_12345" }).plan({
      target: { type: "byoc", accountId: ACCOUNT, tokenRef: "tok_0192b8e4-5a6c-7f12-8b3d-0123456789ab", envName: "preview" },
      project: "demo",
      buildHash: "b",
      bundle,
      migrations: [M1, M2, M3],
      lock: NEXT,
      envState: { databaseExists: true, appliedMigrations: [M1.name], previousLock: PREVIOUS },
    });

    expect(provisioned.bricks.length).toBeGreaterThan(0);
    expect(provisioned.settings.length).toBeGreaterThan(0);
    expect(studio.lockPlan).toEqual({ migrations: provisioned.migrations, bricks: provisioned.bricks, settings: provisioned.settings });
  });
});
