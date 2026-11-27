import { describe, expect, it } from "vitest";
import { MockCloudflareControlPlane, checkEnvironmentDrift, computeRollbackPlan, createByocProvisioner, deriveEnvironmentResourceNames } from "../src/index.ts";
import type { DeployTarget } from "../src/index.ts";

describe("Story 5.5 — Environment Drift Detection & Rollback Plan (packages/deploy)", () => {
  const target: DeployTarget = {
    type: "byoc",
    accountId: "0123456789abcdef0123456789abcdef",
    tokenRef: "tok_drift_01234567",
    envName: "preview",
  };
  const project = "drift-rollback-app";
  const plainToken = "cf_live_token_drift_01";

  it("reports inSync: true when blueprint hashes and live Cloudflare resources match the deployed revision", async () => {
    const controlPlane = new MockCloudflareControlPlane();
    controlPlane.registerToken({
      token: plainToken,
      accountId: target.accountId,
      accountName: "Drift Test Account",
    });

    const provisioner = createByocProvisioner({
      apiClient: controlPlane,
      resolveToken: async () => plainToken,
    });

    const applyRes = await provisioner.apply({
      target,
      project,
      actor: "user_1",
      deployId: "dep_v1",
      buildHash: "build_r1_hash",
      codeHash: "code_r1_hash",
      graphHash: "graph_r1_hash",
      bundle: {
        code: "export default { fetch() { return new Response('r1'); } };",
        sha256: "code_r1_hash",
      },
      migrations: [
        {
          name: "0001_orders.sql",
          sql: "CREATE TABLE orders (id TEXT PRIMARY KEY);",
          sha256: "mig_0001",
        },
      ],
      queues: ["px-drift-rollback-app-preview-events"],
      cronTriggers: ["*/5 * * * *"],
      workflows: [{ name: "wf_orders", className: "GraphRunner" }],
      graphs: { wf_orders: '{"id":"wf_orders"}' },
      schedules: ["*/5 * * * *"],
      secrets: {},
    });

    expect(applyRes.action).toBe("create");

    const drift = await checkEnvironmentDrift(
      target,
      {
        project,
        deployedRev: 1,
        buildHash: "build_r1_hash",
        codeHash: "code_r1_hash",
        graphHash: "graph_r1_hash",
        appliedMigrations: ["0001_orders.sql"],
        queues: ["px-drift-rollback-app-preview-events"],
        cronTriggers: ["*/5 * * * *"],
      },
      {
        currentRev: 1,
        buildHash: "build_r1_hash",
        codeHash: "code_r1_hash",
        graphHash: "graph_r1_hash",
      },
      controlPlane,
      { token: plainToken },
    );

    expect(drift.inSync).toBe(true);
    expect(drift.blueprintDrift).toEqual({
      hasCodeDrift: false,
      hasGraphDrift: false,
      deployedRev: 1,
      currentRev: 1,
      deployedBuildHash: "build_r1_hash",
      currentBuildHash: "build_r1_hash",
      deployedCodeHash: "code_r1_hash",
      currentCodeHash: "code_r1_hash",
      deployedGraphHash: "graph_r1_hash",
      currentGraphHash: "graph_r1_hash",
    });
    expect(drift.outOfBandDrift).toEqual([]);
  });

  it("detects blueprint code and graph drift when BlueprintDO advances past deployedRev", async () => {
    const controlPlane = new MockCloudflareControlPlane();
    controlPlane.registerToken({
      token: plainToken,
      accountId: target.accountId,
      accountName: "Drift Test Account",
    });

    const provisioner = createByocProvisioner({
      apiClient: controlPlane,
      resolveToken: async () => plainToken,
    });

    await provisioner.apply({
      target,
      project,
      actor: "user_1",
      deployId: "dep_v1",
      buildHash: "build_r1_hash",
      codeHash: "code_r1_hash",
      graphHash: "graph_r1_hash",
      bundle: {
        code: "export default { fetch() { return new Response('r1'); } };",
        sha256: "code_r1_hash",
      },
      migrations: [],
      queues: [],
      cronTriggers: [],
      workflows: [],
      graphs: {},
      schedules: [],
      secrets: {},
    });

    // Graph-only edit in r2
    const graphDrift = await checkEnvironmentDrift(
      target,
      {
        project,
        deployedRev: 1,
        buildHash: "build_r1_hash",
        codeHash: "code_r1_hash",
        graphHash: "graph_r1_hash",
        appliedMigrations: [],
        queues: [],
        cronTriggers: [],
      },
      {
        currentRev: 2,
        buildHash: "build_r2_hash",
        codeHash: "code_r1_hash",
        graphHash: "graph_r2_hash",
      },
      controlPlane,
      { token: plainToken },
    );

    expect(graphDrift.inSync).toBe(false);
    expect(graphDrift.blueprintDrift.hasCodeDrift).toBe(false);
    expect(graphDrift.blueprintDrift.hasGraphDrift).toBe(true);
    expect(graphDrift.blueprintDrift.deployedRev).toBe(1);
    expect(graphDrift.blueprintDrift.currentRev).toBe(2);
    expect(graphDrift.outOfBandDrift).toEqual([]);

    // Code edit in r3
    const codeDrift = await checkEnvironmentDrift(
      target,
      {
        project,
        deployedRev: 1,
        buildHash: "build_r1_hash",
        codeHash: "code_r1_hash",
        graphHash: "graph_r1_hash",
        appliedMigrations: [],
        queues: [],
        cronTriggers: [],
      },
      {
        currentRev: 3,
        buildHash: "build_r3_hash",
        codeHash: "code_r3_hash",
        graphHash: "graph_r2_hash",
      },
      controlPlane,
      { token: plainToken },
    );

    expect(codeDrift.inSync).toBe(false);
    expect(codeDrift.blueprintDrift.hasCodeDrift).toBe(true);
    expect(codeDrift.blueprintDrift.hasGraphDrift).toBe(true);
  });

  it("detects out-of-band drift across Worker script hash, D1 migrations, Queues, and Cron Triggers", async () => {
    const controlPlane = new MockCloudflareControlPlane();
    controlPlane.registerToken({
      token: plainToken,
      accountId: target.accountId,
      accountName: "Drift Test Account",
    });

    const provisioner = createByocProvisioner({
      apiClient: controlPlane,
      resolveToken: async () => plainToken,
    });

    await provisioner.apply({
      target,
      project,
      actor: "user_1",
      deployId: "dep_v1",
      buildHash: "build_r1_hash",
      codeHash: "code_r1_hash",
      graphHash: "graph_r1_hash",
      bundle: {
        code: "export default { fetch() { return new Response('r1'); } };",
        sha256: "code_r1_hash",
      },
      migrations: [
        {
          name: "0001_orders.sql",
          sql: "CREATE TABLE orders (id TEXT PRIMARY KEY);",
          sha256: "mig_0001",
        },
      ],
      queues: ["px-drift-rollback-app-preview-events"],
      cronTriggers: ["*/5 * * * *"],
      workflows: [],
      graphs: {},
      schedules: ["*/5 * * * *"],
      secrets: {},
    });

    const names = deriveEnvironmentResourceNames(project, target);
    controlPlane.mutateWorkerOutOfBand(target.accountId, names.scriptName, {
      sha256: "tampered_worker_hash_999",
    });
    controlPlane.mutateDatabaseOutOfBand(target.accountId, names.databaseName, {
      appliedMigrations: [],
    });
    controlPlane.deleteQueueOutOfBand(target.accountId, "px-drift-rollback-app-preview-events");
    controlPlane.mutateCronTriggersOutOfBand(target.accountId, names.scriptName, ["0 0 * * *"]);

    const drift = await checkEnvironmentDrift(
      target,
      {
        project,
        deployedRev: 1,
        buildHash: "build_r1_hash",
        codeHash: "code_r1_hash",
        graphHash: "graph_r1_hash",
        appliedMigrations: ["0001_orders.sql"],
        queues: ["px-drift-rollback-app-preview-events"],
        cronTriggers: ["*/5 * * * *"],
      },
      {
        currentRev: 1,
        buildHash: "build_r1_hash",
        codeHash: "code_r1_hash",
        graphHash: "graph_r1_hash",
      },
      controlPlane,
      { token: plainToken },
    );

    expect(drift.inSync).toBe(false);
    expect(drift.blueprintDrift.hasCodeDrift).toBe(false);
    expect(drift.outOfBandDrift.map((d) => d.resource)).toEqual(["worker", "d1", "queue", "cron"]);
    expect(drift.outOfBandDrift[0]?.actual).toBe("tampered_worker_hash_999");
  });

  it("computes rollback DeployPlan and flags destructive warnings when current environment has newer schema tables/columns or D1 migrations", () => {
    const cleanPlan = computeRollbackPlan(
      target,
      {
        deployId: "dep_v2",
        revision: 2,
        buildHash: "build_r2",
        codeHash: "code_r1",
        graphHash: "graph_r2",
        appliedMigrations: ["0001_orders.sql"],
        entities: [
          {
            name: "orders",
            fields: [{ name: "id", type: "text", required: true }],
          },
        ],
        queues: [],
        cronTriggers: ["*/10 * * * *"],
        workflows: [{ workflowName: "wf_orders", className: "GraphRunner" }],
        graphs: { wf_orders: '{"v":2}' },
      },
      {
        deployId: "dep_v1",
        revision: 1,
        buildHash: "build_r1",
        codeHash: "code_r1",
        graphHash: "graph_r1",
        appliedMigrations: ["0001_orders.sql"],
        entities: [
          {
            name: "orders",
            fields: [{ name: "id", type: "text", required: true }],
          },
        ],
        queues: [],
        cronTriggers: ["*/5 * * * *"],
        workflows: [{ workflowName: "wf_orders", className: "GraphRunner" }],
        graphs: { wf_orders: '{"v":1}' },
      },
    );

    expect(cleanPlan.action).toBe("hot_apply_graphs");
    expect(cleanPlan.d1.destructiveWarnings).toEqual([]);

    const destructivePlan = computeRollbackPlan(
      target,
      {
        deployId: "dep_v3",
        revision: 3,
        buildHash: "build_r3",
        codeHash: "code_r3",
        graphHash: "graph_r2",
        appliedMigrations: ["0001_orders.sql", "0002_invoices.sql"],
        appliedMigrationSql: {
          "0001_orders.sql": "CREATE TABLE orders (id TEXT PRIMARY KEY);",
          "0002_invoices.sql": "CREATE TABLE invoices (id TEXT PRIMARY KEY, total REAL);",
        },
        entities: [
          {
            name: "orders",
            fields: [
              { name: "id", type: "text", required: true },
              { name: "discount_code", type: "text", required: false },
            ],
          },
          {
            name: "invoices",
            fields: [{ name: "id", type: "text", required: true }],
          },
        ],
        queues: [],
        cronTriggers: [],
        workflows: [],
        graphs: {},
      },
      {
        deployId: "dep_v1",
        revision: 1,
        buildHash: "build_r1",
        codeHash: "code_r1",
        graphHash: "graph_r1",
        appliedMigrations: ["0001_orders.sql"],
        entities: [
          {
            name: "orders",
            fields: [{ name: "id", type: "text", required: true }],
          },
        ],
        queues: [],
        cronTriggers: [],
        workflows: [],
        graphs: {},
      },
    );

    expect(destructivePlan.action).toBe("update");
    expect(destructivePlan.d1.destructiveWarnings.length).toBeGreaterThanOrEqual(2);
    expect(destructivePlan.d1.destructiveWarnings.some((w) => w.affectedTable === "invoices")).toBe(true);
    expect(destructivePlan.d1.destructiveWarnings.some((w) => w.affectedTable === "orders" && w.affectedColumn === "discount_code")).toBe(true);
  });
});
