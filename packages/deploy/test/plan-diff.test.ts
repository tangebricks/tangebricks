import { describe, expect, it } from "vitest";
import { MockCloudflareControlPlane, computeDeployPlan, createByocProvisioner, validateDeployPlan } from "../src/index.ts";
import type { DeployTarget } from "../src/index.ts";

describe("Story 5.3 — Deterministic Pre-Deploy Plan & Diff (plan-diff)", () => {
  const ACCOUNT_ID = "abcdef0123456789abcdef0123456789";
  const TOKEN_REF = "tok_0192b8e4-5a6c-7f12-8b3d-0123456789ab";
  const PLAINTEXT_TOKEN = "cf_live_token_plan_diff_test_12345";

  const previewTarget: DeployTarget = {
    type: "byoc",
    accountId: ACCOUNT_ID,
    tokenRef: TOKEN_REF,
    envName: "preview",
  };

  const productionTarget: DeployTarget = {
    type: "byoc",
    accountId: ACCOUNT_ID,
    tokenRef: TOKEN_REF,
    envName: "production",
  };

  it("computes action = 'create' on first-time deploy, 'update' on incremental brick/migration addition, 'hot_apply_graphs' on graph-only edit, and 'noop' on repeat deploy", async () => {
    const controlPlane = new MockCloudflareControlPlane();
    controlPlane.registerToken({
      token: PLAINTEXT_TOKEN,
      accountId: ACCOUNT_ID,
      accountName: "Acme BYOC",
    });

    const provisioner = createByocProvisioner({
      apiClient: controlPlane,
      resolveToken: async () => PLAINTEXT_TOKEN,
    });

    // 1. First-time deploy plan -> action === "create"
    const initialPlan = await provisioner.plan(
      previewTarget,
      {
        project: "acme-saas",
        buildHash: "sha256_build_r1",
        codeHash: "sha256_code_r1",
        graphHash: "sha256_graph_r1",
        identity: "stub",
        migrations: [
          {
            name: "0001_core_auth.sql",
            sql: "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL);",
          },
          {
            name: "0002_entity__invoices.sql",
            sql: "CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, amount TEXT NOT NULL);",
          },
        ],
        queues: ["px-acme-saas-preview-events"],
        cronTriggers: ["0 * * * *"],
        workflows: [{ workflowName: "invoice-flow", className: "GraphRunner" }],
        requiredSecrets: [{ name: "STRIPE_SECRET_KEY", requiredByBrick: "stripe-billing" }],
        configuredSecrets: ["STRIPE_SECRET_KEY"],
      },
      {
        databaseExists: false,
        appliedMigrations: [],
      },
    );

    expect(initialPlan.action).toBe("create");
    expect(initialPlan.worker).toEqual({
      scriptName: "px-acme-saas-preview",
      currentBuildHash: null,
      nextBuildHash: "sha256_build_r1",
      changed: true,
    });
    expect(initialPlan.d1.createDatabase).toBe(true);
    expect(initialPlan.d1.pendingMigrations).toEqual(["0001_core_auth.sql", "0002_entity__invoices.sql"]);
    expect(initialPlan.d1.destructiveWarnings).toEqual([]);
    expect(initialPlan.queues).toEqual([{ queueName: "px-acme-saas-preview-events", action: "create" }]);
    expect(initialPlan.cronTriggers).toEqual({
      currentCrons: [],
      nextCrons: ["0 * * * *"],
      schedulesCount: 1,
      changed: true,
    });
    expect(initialPlan.workflows).toEqual([
      {
        workflowName: "invoice-flow",
        className: "GraphRunner",
        action: "create",
      },
    ]);
    expect(initialPlan.secrets).toEqual([
      {
        name: "STRIPE_SECRET_KEY",
        requiredByBrick: "stripe-billing",
        status: "present",
      },
    ]);
    // stub identity is permitted on preview
    expect(initialPlan.blockers).toEqual([]);

    // 2. Repeat deploy of the exact same state -> action === "noop"
    const noopPlan = computeDeployPlan(
      previewTarget,
      {
        project: "acme-saas",
        buildHash: "sha256_build_r1",
        codeHash: "sha256_code_r1",
        graphHash: "sha256_graph_r1",
        identity: "stub",
        migrations: [
          {
            name: "0001_core_auth.sql",
            sql: "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL);",
          },
          {
            name: "0002_entity__invoices.sql",
            sql: "CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, amount TEXT NOT NULL);",
          },
        ],
        queues: ["px-acme-saas-preview-events"],
        cronTriggers: ["0 * * * *"],
        workflows: [{ workflowName: "invoice-flow", className: "GraphRunner" }],
        requiredSecrets: [{ name: "STRIPE_SECRET_KEY", requiredByBrick: "stripe-billing" }],
      },
      {
        deployedRev: 1,
        currentBuildHash: "sha256_build_r1",
        currentCodeHash: "sha256_code_r1",
        currentGraphHash: "sha256_graph_r1",
        databaseExists: true,
        appliedMigrations: ["0001_core_auth.sql", "0002_entity__invoices.sql"],
        existingQueues: ["px-acme-saas-preview-events"],
        currentCrons: ["0 * * * *"],
        existingWorkflows: [{ workflowName: "invoice-flow", className: "GraphRunner" }],
        configuredSecrets: ["STRIPE_SECRET_KEY"],
      },
    );

    expect(noopPlan.action).toBe("noop");
    expect(noopPlan.noChanges).toBe(true);
    expect(noopPlan.worker.changed).toBe(false);
    expect(noopPlan.d1.createDatabase).toBe(false);
    expect(noopPlan.d1.pendingMigrations).toEqual([]);

    // 3. Incremental brick addition -> action === "update"
    const updatePlan = computeDeployPlan(
      previewTarget,
      {
        project: "acme-saas",
        buildHash: "sha256_build_r2",
        codeHash: "sha256_code_r2",
        graphHash: "sha256_graph_r1",
        identity: "core-auth",
        migrations: [
          {
            name: "0001_core_auth.sql",
            sql: "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL);",
          },
          {
            name: "0002_entity__invoices.sql",
            sql: "CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, amount TEXT NOT NULL);",
          },
          {
            name: "0003_credit_wallet.sql",
            sql: "CREATE TABLE IF NOT EXISTS wallets (id TEXT PRIMARY KEY, balance INTEGER NOT NULL);",
          },
        ],
        queues: ["px-acme-saas-preview-events", "px-acme-saas-preview-wallet"],
        cronTriggers: ["0 * * * *", "*/5 * * * *"],
        workflows: [{ workflowName: "invoice-flow", className: "GraphRunner" }],
      },
      {
        deployedRev: 1,
        currentBuildHash: "sha256_build_r1",
        currentCodeHash: "sha256_code_r1",
        currentGraphHash: "sha256_graph_r1",
        databaseExists: true,
        appliedMigrations: ["0001_core_auth.sql", "0002_entity__invoices.sql"],
        existingQueues: ["px-acme-saas-preview-events"],
        currentCrons: ["0 * * * *"],
        existingWorkflows: [{ workflowName: "invoice-flow", className: "GraphRunner" }],
      },
    );

    expect(updatePlan.action).toBe("update");
    expect(updatePlan.worker.changed).toBe(true);
    expect(updatePlan.worker.currentBuildHash).toBe("sha256_build_r1");
    expect(updatePlan.worker.nextBuildHash).toBe("sha256_build_r2");
    expect(updatePlan.d1.createDatabase).toBe(false);
    expect(updatePlan.d1.pendingMigrations).toEqual(["0003_credit_wallet.sql"]);
    expect(updatePlan.queues).toEqual([
      { queueName: "px-acme-saas-preview-events", action: "unchanged" },
      { queueName: "px-acme-saas-preview-wallet", action: "create" },
    ]);
    expect(updatePlan.cronTriggers.changed).toBe(true);
    expect(updatePlan.cronTriggers.schedulesCount).toBe(2);

    // 4. Graph-only edit -> action === "hot_apply_graphs"
    const graphHotApplyPlan = computeDeployPlan(
      previewTarget,
      {
        project: "acme-saas",
        buildHash: "sha256_build_r3",
        codeHash: "sha256_code_r2",
        graphHash: "sha256_graph_r3_edited",
        identity: "core-auth",
        migrations: [
          {
            name: "0001_core_auth.sql",
            sql: "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL);",
          },
        ],
      },
      {
        deployedRev: 2,
        currentBuildHash: "sha256_build_r2",
        currentCodeHash: "sha256_code_r2",
        currentGraphHash: "sha256_graph_r1",
        databaseExists: true,
        appliedMigrations: ["0001_core_auth.sql"],
      },
    );

    expect(graphHotApplyPlan.action).toBe("hot_apply_graphs");
    expect(graphHotApplyPlan.worker.changed).toBe(false);
  });

  it("blocks production deploy when identity === 'stub' with PRODUCTION_IDENTITY_STUB_FORBIDDEN, and reports MISSING_REQUIRED_SECRETS & READINESS_NOT_READY", () => {
    const blockedProdPlan = computeDeployPlan(
      productionTarget,
      {
        project: "acme-saas",
        buildHash: "sha256_build_prod_1",
        identity: "stub",
        requiredSecrets: [{ name: "STRIPE_WEBHOOK_SECRET", requiredByBrick: "stripe-billing" }],
        configuredSecrets: [],
        readinessIssues: [
          {
            code: "MISSING_CAPABILITY",
            message: "Brick credit-wallet requires user-identity provider",
          },
        ],
      },
      {
        databaseExists: false,
      },
    );

    const blockerCodes = blockedProdPlan.blockers.map((b) => b.code);
    expect(blockerCodes).toContain("PRODUCTION_IDENTITY_STUB_FORBIDDEN");
    expect(blockerCodes).toContain("MISSING_REQUIRED_SECRETS");
    expect(blockerCodes).toContain("READINESS_NOT_READY");

    // Switching identity to core-auth and providing secret clears blockers
    const unblockedProdPlan = computeDeployPlan(
      productionTarget,
      {
        project: "acme-saas",
        buildHash: "sha256_build_prod_2",
        identity: "core-auth",
        requiredSecrets: [{ name: "STRIPE_WEBHOOK_SECRET", requiredByBrick: "stripe-billing" }],
        configuredSecrets: ["STRIPE_WEBHOOK_SECRET"],
        readinessIssues: [],
      },
      {
        databaseExists: false,
      },
    );

    expect(unblockedProdPlan.blockers).toEqual([]);
  });

  it("refuses over-budget graph deploy plan with blockers and validateDeployPlan throws (AC3)", () => {
    // 1 trigger + 1,199 steps = 1,200 steps (1,201 with load step)
    const nodes = [{ id: "trig", type: "trigger.manual", data: {} }];
    const edges = [];
    for (let i = 1; i < 1200; i++) {
      const prevId = i === 1 ? "trig" : `n_${i - 1}`;
      const currId = `n_${i}`;
      nodes.push({ id: currId, type: "transform.pick", data: { path: "x" } });
      edges.push({
        id: `e_${i}`,
        source: prevId,
        target: currId,
        sourceHandle: "out",
        targetHandle: "in",
      });
    }

    const overBudgetGraph = { nodes, edges };

    // 1. Free plan deploy plan catches BUDGET_STEPS_EXCEEDED
    const freePlan = computeDeployPlan(
      {
        ...previewTarget,
        accountPlan: "free",
      },
      {
        project: "acme-saas",
        buildHash: "sha256_build_budget_1",
        identity: "stub",
        graph: overBudgetGraph,
      },
      {
        databaseExists: false,
      },
    );

    const stepBlocker = freePlan.blockers.find((b) => b.code === "BUDGET_STEPS_EXCEEDED");
    expect(stepBlocker).toBeDefined();
    expect(stepBlocker!.message).toContain("BUDGET_STEPS_EXCEEDED");
    expect(stepBlocker!.remediation).toBeTruthy();

    // Deploy cannot proceed: validateDeployPlan throws
    expect(() => validateDeployPlan(freePlan)).toThrow(/BUDGET_STEPS_EXCEEDED/);

    // 2. Paid plan deploy plan allows 1,200 steps (limit 4,096)
    const paidPlan = computeDeployPlan(
      {
        ...previewTarget,
        accountPlan: "paid",
      },
      {
        project: "acme-saas",
        buildHash: "sha256_build_budget_2",
        identity: "stub",
        graph: overBudgetGraph,
      },
      {
        databaseExists: false,
      },
    );

    expect(paidPlan.blockers.filter((b) => b.code === "BUDGET_STEPS_EXCEEDED")).toHaveLength(0);
  });
});
