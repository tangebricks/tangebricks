import { describe, expect, it } from "vitest";
import type { ProjectLock } from "@poc/assembler";
import { MockCloudflareControlPlane, createByocProvisioner } from "../src/index.ts";
import type { DeployTarget } from "../src/index.ts";
import { formatPlan } from "../src/provisioner/plan.ts";
import type { DeployPlan } from "../src/provisioner/plan.ts";

// UC8.8 rework: Studio's BYOC plan and the provisioner's planDeploy must be one implementation of the lock, migration and
// settings diff. These tests drive Studio's plan() with a lock and expect the shared planner's answer.

const ACCOUNT_ID = "abcdef0123456789abcdef0123456789";
const TOKEN = "cf_live_token_shared_planner_test_12345";
const target: DeployTarget = { type: "byoc", accountId: ACCOUNT_ID, tokenRef: "tok_0192b8e4-5a6c-7f12-8b3d-0123456789ab", envName: "preview" };

const PREVIOUS: ProjectLock = {
  project: "demo",
  identity: "core-auth",
  bricks: [
    { id: "alpha", version: "1.0.0", settings: { limit: 5 } },
    { id: "beta", version: "2.3.1", settings: {} },
  ],
  migrations: ["0001_initial.sql"],
};
const NEXT: ProjectLock = {
  ...PREVIOUS,
  bricks: [
    { id: "alpha", version: "1.1.0", settings: { limit: 10 } },
    { id: "beta", version: "2.3.1", settings: {} },
  ],
  migrations: ["0001_initial.sql", "0002_add_col.sql"],
};
const M1 = { name: "0001_initial.sql", sql: "CREATE TABLE items (id TEXT PRIMARY KEY, val TEXT);" };
const M2 = { name: "0002_add_col.sql", sql: "ALTER TABLE items ADD COLUMN note TEXT;" };
const M_DROP = { name: "0003_drop.sql", sql: "DROP TABLE items;" };

function provisioner() {
  const controlPlane = new MockCloudflareControlPlane();
  controlPlane.registerToken({ token: TOKEN, accountId: ACCOUNT_ID, accountName: "Acme BYOC" });
  return createByocProvisioner({ apiClient: controlPlane, resolveToken: async () => TOKEN });
}
const base = { target, project: "demo", buildHash: "sha256_build_2", bundle: { code: "export default {};", sha256: "sha256_code_2" } };

describe("Studio plan consumes the shared planner (UC8.8 AC3)", () => {
  it("reports migration classes, brick moves and setting changes from the shared diff when given a lock", async () => {
    const plan = await provisioner().plan({ ...base, migrations: [M1, M2], lock: NEXT, envState: { databaseExists: true, appliedMigrations: ["0001_initial.sql"], previousLock: PREVIOUS } });
    expect(plan.lockPlan).toEqual({
      migrations: [{ name: "0002_add_col.sql", class: "additive" }],
      bricks: [{ id: "alpha", from: "1.0.0", to: "1.1.0", kind: "minor" }],
      settings: [{ brick: "alpha", key: "limit", from: 5, to: 10 }],
    });
  });

  it("has no lockPlan when no lock is given, so existing plans are unchanged", async () => {
    const plan = await provisioner().plan({ ...base, migrations: [M1], envState: { databaseExists: false, appliedMigrations: [] } });
    expect(plan.lockPlan).toBeUndefined();
  });

  it("blocks an unacknowledged major brick bump and a destructive migration, and allowMajor clears only the major", async () => {
    const major: ProjectLock = { ...PREVIOUS, bricks: [{ id: "alpha", version: "2.0.0", settings: { limit: 5 } }, PREVIOUS.bricks![1]!] };
    const env = { databaseExists: true, appliedMigrations: ["0001_initial.sql"], previousLock: PREVIOUS };
    const blocked = await provisioner().plan({ ...base, migrations: [M1, M_DROP], lock: major, envState: env });
    expect(blocked.blockers.map((b) => b.code)).toContain("BRICK_MAJOR_UNACKNOWLEDGED");
    expect(blocked.lockPlan?.migrations).toEqual([{ name: "0003_drop.sql", class: "destructive" }]);
    const acked = await provisioner().plan({ ...base, migrations: [M1, M_DROP], lock: major, allowMajor: true, envState: env });
    expect(acked.blockers.map((b) => b.code)).not.toContain("BRICK_MAJOR_UNACKNOWLEDGED");
  });
});

describe("formatPlan", () => {
  it("prints every difference of a plan, one line each, and says so when there is none", () => {
    const plan: DeployPlan = {
      migrations: [{ name: "0002_add_col.sql", class: "additive" }],
      bricks: [{ id: "alpha", from: "1.0.0", to: "1.1.0", kind: "minor" }],
      settings: [{ brick: "alpha", key: "limit", from: 5, to: 10 }],
      worker: { changed: true, reasons: ["bundle", "bindings"] },
      workflow: { action: "none" },
      rollbackTo: "ver-1",
      blocking: ["brick beta would move to a major version"],
      empty: false,
    };
    const text = formatPlan(plan);
    for (const part of ["0002_add_col.sql", "additive", "alpha", "1.0.0", "1.1.0", "limit", "bundle", "bindings", "ver-1", "BLOCKED", "major version"]) expect(text).toContain(part);
    expect(formatPlan({ ...plan, migrations: [], bricks: [], settings: [], worker: { changed: false, reasons: [] }, blocking: [], empty: true })).toMatch(/no changes/i);
  });
});
