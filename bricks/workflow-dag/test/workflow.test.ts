import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { assemble } from "@poc/assembler";
import { catalog } from "@poc/assembler/catalog";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
// workflow-dag is quarantined (story 0.11) and so not in max-compatible; test/support/global-setup.ts assembles this
// small shell for it instead (WORKFLOW_SHELL_BLUEPRINT).
import shellWorker from "../../../out/wf-shell/src/index.ts";
import migration from "../migrations/0001_workflow_dag.sql?raw";
import { createWorkflowRoutes, WorkflowService } from "../src/index.ts";
import type { WorkflowEnv } from "../src/routes.ts";
import { WORKFLOW_SHELL_BLUEPRINT } from "../../../test/support/blueprints.ts";

const db = env.DB as D1Like;
const WS_A = "ws_wf_alpha";
const WS_B = "ws_wf_beta";

async function resetDb(): Promise<void> {
  for (const table of ["wf_step_logs", "wf_runs", "wf_definitions"]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

const validGraph = {
  nodes: [
    { id: "t", type: "trigger.manual", data: {} },
    { id: "p", type: "transform.pick", data: { path: "user.name" } },
  ],
  edges: [{ id: "e1", source: "t", target: "p", sourceHandle: "out", targetHandle: "in" }],
};

const failingGraph = {
  nodes: [
    { id: "t", type: "trigger.manual", data: {} },
    { id: "boom", type: "util.boom", data: {} },
  ],
  edges: [{ id: "e1", source: "t", target: "boom", sourceHandle: "out", targetHandle: "in" }],
};

describe("Workflow DAG Engine & Interpreted Execution", () => {
  it("rejects invalid graph with cyclic or missing connections on creation", async () => {
    const service = new WorkflowService(db);
    // Graph with missing node reference
    const invalidGraph = {
      nodes: [{ id: "t", type: "trigger.manual", data: {} }],
      edges: [{ id: "e1", source: "t", target: "nonexistent", sourceHandle: "out", targetHandle: "in" }],
    };

    const res = await service.createWorkflow(WS_A, "Broken Workflow", invalidGraph);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(400);
    expect(res.error).toMatch(/Invalid workflow graph/i);
  });

  it("creates valid workflow definition and executes it with step logs in D1", async () => {
    const service = new WorkflowService(db);
    const created = await service.createWorkflow(WS_A, "Profile Picker", validGraph);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Execute workflow
    const runRes = await service.executeWorkflow(WS_A, created.workflow.id, {
      user: { name: "Alice Wonderland", age: 30 },
    });

    expect(runRes.ok).toBe(true);
    if (!runRes.ok) return;

    expect(runRes.run.status).toBe("completed");
    expect((runRes.run.output?.p as { out: string })?.out).toBe("Alice Wonderland");
    expect(runRes.steps).toHaveLength(2); // trigger + pick

    // Inspect persisted run in D1
    const stored = await service.getRun(WS_A, runRes.run.id);
    expect(stored).not.toBeNull();
    expect(stored?.run.status).toBe("completed");
    expect(stored?.steps).toHaveLength(2);
    expect(stored?.steps[1].status).toBe("completed");
    expect(stored?.steps[1].output).toEqual({ out: "Alice Wonderland" });
  });

  it("handles failing step cleanly: marks run failed and logs error", async () => {
    const service = new WorkflowService(db);
    const created = await service.createWorkflow(WS_A, "Boom Workflow", failingGraph);
    if (!created.ok) return;

    const runRes = await service.executeWorkflow(WS_A, created.workflow.id, { test: 123 });
    expect(runRes.ok).toBe(true);
    if (!runRes.ok) return;

    expect(runRes.run.status).toBe("failed");
    expect(runRes.run.error).toMatch(/boom/i);

    // Verify stored logs
    const stored = await service.getRun(WS_A, runRes.run.id);
    expect(stored?.run.status).toBe("failed");
    const failingStep = stored?.steps.find((s) => s.node_id === "boom");
    expect(failingStep?.status).toBe("failed");
  });

  it("enforces multi-tenant isolation: Workspace B cannot see or trigger Workspace A workflows", async () => {
    const service = new WorkflowService(db);
    const created = await service.createWorkflow(WS_A, "Classified Pipeline", validGraph);
    if (!created.ok) return;

    // Workspace B cannot view
    expect(await service.getWorkflow(WS_B, created.workflow.id)).toBeNull();

    // Workspace B cannot execute
    const execRes = await service.executeWorkflow(WS_B, created.workflow.id, {});
    expect(execRes.ok).toBe(false);
    if (execRes.ok) return;
    expect(execRes.code).toBe(404);
  });
});

describe("Workflow Route Handlers (/api/workflows/*, /api/runs/*)", () => {
  const createApp = (wsId = WS_A) => {
    const app = new Hono<WorkflowEnv>();

    // Mock workspace & user context
    app.use("*", async (c, next) => {
      c.set("workspace", { id: wsId, role: "member" });
      c.set("user", { uid: "usr_alice", email: "alice@test.com" });
      await next();
    });

    app.route("/api", createWorkflowRoutes());
    return app;
  };

  it("POST /api/workflows -> creates workflow and returns 201", async () => {
    const app = createApp(WS_A);
    const res = await app.fetch(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "API Pipeline", graph: validGraph }),
      }),
      { DB: db }
    );

    expect(res.status).toBe(201);
    const json = (await res.json()) as { workflow: { id: string; name: string } };
    expect(json.workflow.name).toBe("API Pipeline");
    expect(json.workflow.id).toBeDefined();

    // Trigger execution via POST /api/workflows/:id/run
    const runRes = await app.fetch(
      new Request(`http://localhost/api/workflows/${json.workflow.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: { name: "Bob Builder" } }),
      }),
      { DB: db }
    );

    expect(runRes.status).toBe(200);
    const runJson = (await runRes.json()) as { run: { id: string; status: string; output: { p: { out: string } } } };
    expect(runJson.run.status).toBe("completed");
    expect(runJson.run.output.p.out).toBe("Bob Builder");

    // Fetch run logs via GET /api/runs/:id
    const logsRes = await app.fetch(
      new Request(`http://localhost/api/runs/${runJson.run.id}`),
      { DB: db }
    );
    expect(logsRes.status).toBe(200);
    const logsJson = (await logsRes.json()) as { run: { id: string }; steps: unknown[] };
    expect(logsJson.run.id).toBe(runJson.run.id);
    expect(logsJson.steps.length).toBeGreaterThan(0);
  });
});

describe("Assembled Shell 2-node GraphWorkflow Execution in workerd (AC 5)", () => {
  it("runs a 2-node DAG through GraphWorkflow via POST /api/workflows/:id/run and enforces workspace isolation", async () => {
    const assembled = assemble(WORKFLOW_SHELL_BLUEPRINT, catalog);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;

    for (const table of ["wf_step_logs", "wf_runs", "wf_definitions", "profile_users", "auth_sessions", "auth_users", "mw_workspace_members", "mw_workspaces"]) {
      await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
    }
    const migrations = Object.entries(assembled.files)
      .filter(([p]) => p.startsWith("migrations/"))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [, sql] of migrations) {
      await applyMigration(db, sql);
    }

    const createWs = async (user: string, name: string): Promise<string> => {
      const res = await shellWorker.fetch(
        new Request("https://example.test/api/workspaces", {
          method: "POST",
          headers: { "content-type": "application/json", "x-test-user": user },
          body: JSON.stringify({ name }),
        }),
        { DB: db },
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { workspace: { id: string } }).workspace.id;
    };

    const wsAlpha = await createWs("alice", "Alpha Workflow Workspace");
    const wsBeta = await createWs("bob", "Beta Workflow Workspace");

    // Create 2-node DAG in Workspace Alpha
    const createRes = await shellWorker.fetch(
      new Request("https://example.test/api/workflows", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-user": "alice",
          "x-workspace-id": wsAlpha,
        },
        body: JSON.stringify({ name: "Two-Node Picker", graph: validGraph }),
      }),
      { DB: db },
    );
    expect(createRes.status).toBe(201);
    const wfId = ((await createRes.json()) as { workflow: { id: string } }).workflow.id;

    // Trigger 2-node DAG via POST /api/workflows/:id/run
    const runRes = await shellWorker.fetch(
      new Request(`https://example.test/api/workflows/${wfId}/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-user": "alice",
          "x-workspace-id": wsAlpha,
        },
        body: JSON.stringify({ user: { name: "Grace Hopper" } }),
      }),
      { DB: db },
    );
    expect(runRes.status).toBe(200);
    const runData = (await runRes.json()) as {
      run: { id: string; status: string; output: { p: { out: string } } };
      steps: Array<{ node_id: string; status: string }>;
    };
    expect(runData.run.status).toBe("completed");
    expect(runData.run.output.p.out).toBe("Grace Hopper");
    expect(runData.steps.map((s) => `${s.node_id}:${s.status}`)).toEqual(["t:completed", "p:completed"]);

    // Workspace Beta cannot read Workspace Alpha's run
    const crossRead = await shellWorker.fetch(
      new Request(`https://example.test/api/runs/${runData.run.id}`, {
        headers: { "x-test-user": "bob", "x-workspace-id": wsBeta },
      }),
      { DB: db },
    );
    expect(crossRead.status).toBe(404);
  });
});
