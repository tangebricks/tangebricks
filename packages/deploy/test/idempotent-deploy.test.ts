import { describe, expect, it } from "vitest";
import {
  MockCloudflareControlPlane,
  createByocProvisioner,
} from "../src/index.ts";
import type { DeployTarget } from "../src/index.ts";

describe("Story 5.4 — Idempotent Re-Deploy & Step-by-Step Ledger (packages/deploy)", () => {
  it("executes first deploy with full provisioning ledger and completes second re-deploy of the same rev with action: noop, 0 mutating API calls, and < 1 s latency", async () => {
    const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
    const TOKEN_REF = "tok_idempotent_test_01";

    const controlPlane = new MockCloudflareControlPlane();
    controlPlane.registerToken({
      token: "cf_valid_idempotent_deploy_token_1234",
      accountId: ACCOUNT_ID,
      accountName: "Idempotent Test Account",
    });

    const provisioner = createByocProvisioner({
      apiClient: controlPlane,
      resolveToken: async () => "cf_valid_idempotent_deploy_token_1234",
    });

    const target: DeployTarget = {
      type: "byoc",
      accountId: ACCOUNT_ID,
      tokenRef: TOKEN_REF,
      envName: "preview",
    };

    const firstSteps: string[] = [];
    const firstDeploy = await provisioner.apply({
      target,
      project: "acme-saas",
      actor: "usr_alice",
      deployId: "dep_first_01",
      buildHash: "sha256_build_rev1_111111111111",
      codeHash: "sha256_code_rev1_222222222222",
      graphHash: "sha256_graph_rev1_333333333333",
      bundle: {
        code: "export default { fetch() { return new Response('rev1'); } };",
        sha256: "sha256_code_rev1_222222222222",
      },
      migrations: [
        {
          name: "0001_init.sql",
          sql: "CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, total REAL NOT NULL);",
          sha256: "sha256_mig_0001",
        },
      ],
      queues: ["px-acme-saas-preview-events"],
      cronTriggers: ["0 * * * *"],
      workflows: [{ name: "wf-invoice", className: "GraphRunner" }],
      graphs: {
        "wf-invoice": JSON.stringify({
          id: "wf-invoice",
          name: "Invoice Workflow",
          nodes: [{ id: "n1", type: "trigger.manual", data: {} }],
          edges: [],
        }),
      },
      schedules: ["0 * * * *"],
      secrets: { STRIPE_SECRET_KEY: "sealed:sec_stripe" },
      onStep: (step) => {
        firstSteps.push(`${step.stepName}:${step.action}`);
      },
    });

    expect(firstDeploy.action).toBe("create");
    expect(firstDeploy.noChanges).toBe(false);
    expect(firstDeploy.rebuiltWorker).toBe(true);
    expect(firstDeploy.liveWithoutRedeploy).toBe(false);
    expect(firstDeploy.mutatingCallCount).toBeGreaterThan(0);
    expect(firstDeploy.steps.length).toBeGreaterThanOrEqual(5);
    expect(firstSteps).toContain("worker_bundle:create");
    expect(controlPlane.scriptUploadCount).toBe(1);

    const mutatingBeforeSecondRun = controlPlane.mutatingCalls.length;
    const secondSteps: string[] = [];

    const startMs = performance.now();
    const secondPlan = await provisioner.plan({
      target,
      project: "acme-saas",
      buildHash: "sha256_build_rev1_111111111111",
      codeHash: "sha256_code_rev1_222222222222",
      graphHash: "sha256_graph_rev1_333333333333",
      bundle: {
        code: "export default { fetch() { return new Response('rev1'); } };",
        sha256: "sha256_code_rev1_222222222222",
      },
      migrations: [
        {
          name: "0001_init.sql",
          sql: "CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, total REAL NOT NULL);",
          sha256: "sha256_mig_0001",
        },
      ],
      queues: ["px-acme-saas-preview-events"],
      cronTriggers: ["0 * * * *"],
      workflows: [{ name: "wf-invoice", className: "GraphRunner" }],
    });

    expect(secondPlan.action).toBe("noop");
    expect(secondPlan.noChanges).toBe(true);
    expect(secondPlan.d1.pendingMigrations).toEqual([]);
    // Even planning makes zero mutating calls
    expect(controlPlane.mutatingCalls.length).toBe(mutatingBeforeSecondRun);

    const secondDeploy = await provisioner.apply(target, secondPlan, {
      project: "acme-saas",
      actor: "usr_alice",
      deployId: "dep_second_02",
      buildHash: "sha256_build_rev1_111111111111",
      codeHash: "sha256_code_rev1_222222222222",
      graphHash: "sha256_graph_rev1_333333333333",
      bundle: {
        code: "export default { fetch() { return new Response('rev1'); } };",
        sha256: "sha256_code_rev1_222222222222",
      },
      migrations: [
        {
          name: "0001_init.sql",
          sql: "CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, total REAL NOT NULL);",
          sha256: "sha256_mig_0001",
        },
      ],
      queues: ["px-acme-saas-preview-events"],
      cronTriggers: ["0 * * * *"],
      workflows: [{ name: "wf-invoice", className: "GraphRunner" }],
      graphs: {
        "wf-invoice": JSON.stringify({
          id: "wf-invoice",
          name: "Invoice Workflow",
          nodes: [{ id: "n1", type: "trigger.manual", data: {} }],
          edges: [],
        }),
      },
      schedules: ["0 * * * *"],
      onStep: (step) => {
        secondSteps.push(`${step.stepName}:${step.action}`);
      },
    });
    const elapsedMs = performance.now() - startMs;

    expect(secondDeploy.action).toBe("noop");
    expect(secondDeploy.noChanges).toBe(true);
    expect(secondDeploy.rebuiltWorker).toBe(false);
    expect(secondDeploy.mutatingCallCount).toBe(0);
    expect(controlPlane.mutatingCalls.length).toBe(mutatingBeforeSecondRun);
    expect(controlPlane.scriptUploadCount).toBe(1);
    expect(secondDeploy.versionId).toBe(firstDeploy.versionId);
    expect(secondSteps).toContain("d1_database:noop");
    expect(elapsedMs).toBeLessThan(1000);
  });
});
