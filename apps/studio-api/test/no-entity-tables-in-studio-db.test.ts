// Story 17: a generated app's entity tables, and every enabled brick's migration tables, live in the project's own
// data store (the active sandbox D1 for preview), never in the control-plane database (STUDIO_DB). Covers every row of
// the story's I/O matrix: NO_STUDIO_DDL, SEED_SANDBOX, SEED_NO_STORE, TWO_ORGS_SAME_ENTITY, COPY_SAMPLE_DATA,
// PROMOTE_PLAIN and BROWSER_NO_STORE, plus workflow runs with no app DB binding.
//
// Sandbox databases here are real D1s (SANDBOX_DB_A, SANDBOX_DB_B), handed out in order as sandboxes are created, so
// wrong columns or constraints fail and two orgs' sandboxes are genuinely separate databases.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import type { D1Like } from "@poc/sdk";
import {
  app as studioApp,
  ensureStudioD1Schema,
  getStudioSandboxPlatform,
  resetStudioDeployTestState,
} from "../src/index.ts";
import type { StudioApiEnv } from "../src/index.ts";
import { activateTestSandbox, dropAllTables, listTableNames } from "./sandbox-data-store.ts";

const studioEnv = env as unknown as StudioApiEnv;
const studioDb = studioEnv.STUDIO_DB as D1Like;
const sandboxDbA = (env as unknown as { SANDBOX_DB_A: D1Like }).SANDBOX_DB_A;
const sandboxDbB = (env as unknown as { SANDBOX_DB_B: D1Like }).SANDBOX_DB_B;
/** The deployed Studio Worker binds only STUDIO_DB (wrangler.jsonc): no app `DB`. */
const envWithoutAppDb: StudioApiEnv = { ...studioEnv, DB: undefined };

/** Tables a generated app (entities or bricks) would create; none may ever appear in STUDIO_DB. */
const APP_TABLES = ["ent_usage_ledgers", "ent_invoices", "credit_wallets", "credit_ledger"];

interface TestUser {
  userId: string;
  orgId: string;
  req: (path: string, init?: { method?: string; body?: unknown; env?: StudioApiEnv }) => Promise<Response>;
}

async function createUser(label: string): Promise<TestUser> {
  const suffix = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const regRes = await studioApp.request(
    "/api/auth/signup",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `s17-${suffix}@example.test`, password: "Password12345!", name: `S17 ${label}` }),
    },
    studioEnv,
  );
  expect(regRes.status).toBe(201);
  const regBody = (await regRes.json()) as { token: string; user: { id: string } };
  const req: TestUser["req"] = async (path, init = {}) => {
    const headers = new Headers({ authorization: `Bearer ${regBody.token}` });
    if (init.body !== undefined) headers.set("content-type", "application/json");
    return await studioApp.request(
      path,
      {
        method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      },
      init.env ?? studioEnv,
    );
  };
  const orgsRes = await req("/api/orgs");
  expect(orgsRes.status).toBe(200);
  const orgId = ((await orgsRes.json()) as { orgs: Array<{ id: string }> }).orgs[0]?.id ?? "";
  expect(orgId).not.toBe("");
  return { userId: regBody.user.id, orgId, req };
}

async function createTemplateProject(user: TestUser, prefix: string): Promise<string> {
  const project = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const res = await user.req("/api/projects", {
    body: { project, orgId: user.orgId, templateId: "ai-credits-saas" },
  });
  expect(res.status).toBe(201);
  return project;
}

async function createInvoicesProject(user: TestUser, prefix: string, extraOps: unknown[] = []): Promise<string> {
  const project = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const createRes = await user.req(`/api/orgs/${user.orgId}/projects`, { body: { project } });
  expect([200, 201]).toContain(createRes.status);
  const opsRes = await user.req(`/api/projects/${project}/ops`, {
    body: {
      orgId: user.orgId,
      summary: "invoices entity",
      ops: [
        { opId: "op_ws", type: "enable_brick", brickId: "multi-workspace", config: {} },
        { opId: "op_ent", type: "enable_brick", brickId: "dynamic-entities", config: {} },
        {
          opId: "op_invoices",
          type: "add_entity",
          entity: {
            name: "invoices",
            workspaceScoped: true,
            fields: [
              { name: "invoice_number", type: "text", required: true, maxLength: 100 },
              { name: "amount", type: "number", required: true },
            ],
          },
        },
        ...extraOps,
      ],
    },
  });
  expect(opsRes.status).toBe(200);
  return project;
}

function expectNoAppTables(tables: string[]): void {
  for (const t of APP_TABLES) expect(tables).not.toContain(t);
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe("story 17: generated-app entity tables stay out of STUDIO_DB", () => {
  beforeEach(async () => {
    await ensureStudioD1Schema(studioDb);
    await dropAllTables(sandboxDbA);
    await dropAllTables(sandboxDbB);
    // Each new sandbox database gets the next real D1: the first is SANDBOX_DB_A, the second SANDBOX_DB_B.
    const queue = [sandboxDbA, sandboxDbB];
    resetStudioDeployTestState({
      createSandboxD1: () => {
        const next = queue.shift();
        if (!next) throw new Error("test provides only two sandbox D1s");
        return next;
      },
    });
  });

  test("NO_STUDIO_DDL + SEED_SANDBOX + COPY_SAMPLE_DATA + PROMOTE_PLAIN: sandbox deploy, data browser, seed and promote leave the STUDIO_DB table set unchanged", async () => {
    const user = await createUser("flow");
    const project = await createTemplateProject(user, "s17-flow");

    const before = await listTableNames(studioDb);
    expectNoAppTables(before);

    // Sandbox deploy: the project's schema (entity and brick tables) is applied to the sandbox D1 only.
    const deployRes = await user.req(`/api/projects/${project}/sandbox/deploy`, { body: { orgId: user.orgId } });
    expect(deployRes.status).toBe(200);
    const deploy = (await deployRes.json()) as { sandboxId: string };
    expect(getStudioSandboxPlatform().getDatabase(deploy.sandboxId)?.rawD1).toBe(sandboxDbA);
    const sandboxTables = await listTableNames(sandboxDbA);
    expect(sandboxTables).toContain("ent_usage_ledgers");
    expect(sandboxTables).toContain("credit_wallets");
    expectNoAppTables(await listTableNames(studioDb));

    // Data browser list and read go to the sandbox D1.
    const tablesRes = await user.req(
      `/api/projects/${project}/environments/preview/data/tables?workspaceId=ws_s17&orgId=${user.orgId}`,
    );
    expect(tablesRes.status).toBe(200);
    const rowsRes = await user.req(
      `/api/projects/${project}/environments/preview/data/tables/usage_ledgers/rows?workspaceId=ws_s17&orgId=${user.orgId}`,
    );
    expect(rowsRes.status).toBe(200);

    // SEED_SANDBOX: rows (real entity columns) land in the sandbox D1, not STUDIO_DB.
    const seedRes = await user.req(`/api/projects/${project}/environments/preview/data/seed`, {
      body: {
        orgId: user.orgId,
        tables: {
          ent_usage_ledgers: [
            { id: "s17_row_1", workspace_id: "ws_s17", title: "Seeded into the sandbox", status: "active" },
          ],
        },
      },
    });
    expect(seedRes.status).toBe(200);
    const seedBody = (await seedRes.json()) as { insertedCount: number; dataStore: { kind: string; sandboxId: string } };
    expect(seedBody.insertedCount).toBe(1);
    expect(seedBody.dataStore).toEqual({ kind: "sandbox", sandboxId: deploy.sandboxId });
    const sandboxRows = await sandboxDbA
      .prepare("SELECT id, title, status FROM ent_usage_ledgers")
      .all<{ id: string; title: string; status: string }>();
    expect(sandboxRows.results).toEqual([{ id: "s17_row_1", title: "Seeded into the sandbox", status: "active" }]);
    const readBackRes = await user.req(
      `/api/projects/${project}/environments/preview/data/tables/usage_ledgers/rows?workspaceId=ws_s17&orgId=${user.orgId}`,
    );
    expect(readBackRes.status).toBe(200);
    const readBack = (await readBackRes.json()) as { rows: Array<{ id: string }> };
    expect(readBack.rows.map((r) => r.id)).toEqual(["s17_row_1"]);
    expectNoAppTables(await listTableNames(studioDb));

    // COPY_SAMPLE_DATA: the removed option is refused whatever its value, and nothing is copied or destroyed.
    const promoteBody = {
      orgId: user.orgId,
      token: "cf_valid_token_s17_promote_0123456789",
      accountId: "c3d4e5f60718293a4b5c6d7e8f90a1b2",
    };
    for (const copySampleData of [true, false, "true", 1, null]) {
      const copyRes = await user.req(`/api/projects/${project}/sandbox/promote-to-byoc`, {
        body: { ...promoteBody, copySampleData },
      });
      expect(copyRes.status, `copySampleData: ${JSON.stringify(copySampleData)}`).toBe(400);
      expect(await errorCode(copyRes)).toBe("COPY_SAMPLE_DATA_REMOVED");
    }
    expect(getStudioSandboxPlatform().getDatabase(deploy.sandboxId)).not.toBeNull();
    const sbxStillActive = await studioDb
      .prepare("SELECT status FROM studio_sandboxes WHERE sandbox_id = ?")
      .bind(deploy.sandboxId)
      .first<{ status: string }>();
    expect(sbxStillActive?.status).toBe("active");

    // PROMOTE_PLAIN: works as before, minus the copied counts.
    const plainRes = await user.req(`/api/projects/${project}/sandbox/promote-to-byoc`, { body: promoteBody });
    expect(plainRes.status).toBe(200);
    const plain = (await plainRes.json()) as Record<string, unknown>;
    expect(plain.ok).toBe(true);
    expect(plain.sandboxDestroyed).toBe(true);
    expect(plain.buildHashMatched).toBe(true);
    for (const removed of ["copySampleData", "copiedSampleRows", "copiedRowsCount", "copiedTables"]) {
      expect(plain).not.toHaveProperty(removed);
    }

    // NO_STUDIO_DDL: the STUDIO_DB table set is exactly what it was before any data route ran.
    expect(await listTableNames(studioDb)).toEqual(before);
  });

  test("SEED_NO_STORE: with no sandbox, or for production, the seed answers 503 NOT_CONFIGURED and writes nothing", async () => {
    const user = await createUser("nostore");
    const project = await createInvoicesProject(user, "s17-nostore");
    const seedBody = {
      orgId: user.orgId,
      tables: { ent_invoices: [{ id: "inv_x", workspace_id: "ws_x", invoice_number: "X-1", amount: 1 }] },
    };

    const before = await listTableNames(studioDb);
    const noSandboxRes = await user.req(`/api/projects/${project}/environments/preview/data/seed`, { body: seedBody });
    expect(noSandboxRes.status).toBe(503);
    expect(await errorCode(noSandboxRes)).toBe("NOT_CONFIGURED");
    expect(await listTableNames(studioDb)).toEqual(before);

    // Even with an active sandbox, production has no data store Studio can reach.
    const sandbox = await activateTestSandbox(studioDb, { project, orgId: user.orgId });
    expect(sandbox.rawD1).toBe(sandboxDbA);
    const sandboxTablesBefore = await listTableNames(sandboxDbA);
    const prodRes = await user.req(`/api/projects/${project}/environments/production/data/seed`, { body: seedBody });
    expect(prodRes.status).toBe(503);
    expect(await errorCode(prodRes)).toBe("NOT_CONFIGURED");

    // Nothing was written anywhere: STUDIO_DB and the sandbox D1 have exactly the tables they had.
    expect(await listTableNames(studioDb)).toEqual(before);
    expectNoAppTables(before);
    expect(await listTableNames(sandboxDbA)).toEqual(sandboxTablesBefore);
    expect(sandboxTablesBefore).not.toContain("ent_invoices");
  });

  test("SEED_NO_STORE: the 0.16 seed guards still refuse raw DDL and control-plane tables before any store lookup", async () => {
    const user = await createUser("guards");
    const project = await createInvoicesProject(user, "s17-guards");
    await activateTestSandbox(studioDb, { project, orgId: user.orgId });
    const ddlRes = await user.req(`/api/projects/${project}/environments/preview/data/seed`, {
      body: { orgId: user.orgId, ddl: ["CREATE TABLE evil (id TEXT)"] },
    });
    expect(ddlRes.status).toBe(400);
    expect(await errorCode(ddlRes)).toBe("SEED_DDL_REFUSED");
    const cpRes = await user.req(`/api/projects/${project}/environments/preview/data/seed`, {
      body: { orgId: user.orgId, tables: { studio_org_members: [{ org_id: "x", user_id: "y", role: "owner" }] } },
    });
    expect(cpRes.status).toBe(403);
    expect(await errorCode(cpRes)).toBe("SEED_TABLE_FORBIDDEN");
  });

  test("TWO_ORGS_SAME_ENTITY: org A and org B both declare invoices; each seeds its own sandbox and reads back only its own rows", async () => {
    const alice = await createUser("org-a");
    const bob = await createUser("org-b");
    expect(alice.orgId).not.toBe(bob.orgId);
    const projectA = await createInvoicesProject(alice, "s17-a");
    const projectB = await createInvoicesProject(bob, "s17-b");
    const sandboxA = await activateTestSandbox(studioDb, { project: projectA, orgId: alice.orgId });
    const sandboxB = await activateTestSandbox(studioDb, { project: projectB, orgId: bob.orgId });
    expect(sandboxA.rawD1).toBe(sandboxDbA);
    expect(sandboxB.rawD1).toBe(sandboxDbB);
    const before = await listTableNames(studioDb);

    for (const [user, project, prefix] of [
      [alice, projectA, "A"],
      [bob, projectB, "B"],
    ] as const) {
      const res = await user.req(`/api/projects/${project}/environments/preview/data/seed`, {
        body: {
          orgId: user.orgId,
          tables: {
            ent_invoices: [1, 2].map((n) => ({
              id: `inv_${prefix}_${n}`,
              workspace_id: "ws_shared_name",
              invoice_number: `${prefix}-${n}`,
              amount: n * 100,
            })),
          },
        },
      });
      expect(res.status).toBe(200);
    }

    for (const [user, project, own] of [
      [alice, projectA, "A"],
      [bob, projectB, "B"],
    ] as const) {
      const res = await user.req(
        `/api/projects/${project}/environments/preview/data/tables/invoices/rows?workspaceId=ws_shared_name&orgId=${user.orgId}`,
      );
      expect(res.status).toBe(200);
      const ids = ((await res.json()) as { rows: Array<{ id: string }> }).rows.map((r) => r.id).sort();
      expect(ids).toEqual([`inv_${own}_1`, `inv_${own}_2`]);
    }

    const rowsA = await sandboxDbA.prepare("SELECT id, invoice_number, amount FROM ent_invoices ORDER BY id").all();
    const rowsB = await sandboxDbB.prepare("SELECT id, invoice_number, amount FROM ent_invoices ORDER BY id").all();
    expect(rowsA.results).toEqual([
      { id: "inv_A_1", invoice_number: "A-1", amount: 100 },
      { id: "inv_A_2", invoice_number: "A-2", amount: 200 },
    ]);
    expect(rowsB.results).toEqual([
      { id: "inv_B_1", invoice_number: "B-1", amount: 100 },
      { id: "inv_B_2", invoice_number: "B-2", amount: 200 },
    ]);

    // Org B cannot read org A's project at all.
    const crossRes = await bob.req(
      `/api/projects/${projectA}/environments/preview/data/tables/invoices/rows?workspaceId=ws_shared_name`,
    );
    expect([403, 404]).toContain(crossRes.status);

    expect(await listTableNames(studioDb)).toEqual(before);
    expectNoAppTables(before);
  });

  test("BROWSER_NO_STORE: with no sandbox and no deployed worker the data browser answers NOT_CONFIGURED and creates no STUDIO_DB table", async () => {
    const user = await createUser("browser");
    const project = await createInvoicesProject(user, "s17-browser");
    const before = await listTableNames(studioDb);

    for (const envName of ["preview", "production"] as const) {
      for (const path of [
        `/api/projects/${project}/environments/${envName}/data/workspaces?orgId=${user.orgId}`,
        `/api/projects/${project}/environments/${envName}/data/tables?workspaceId=ws_x&orgId=${user.orgId}`,
        `/api/projects/${project}/environments/${envName}/data/tables/invoices/rows?workspaceId=ws_x&orgId=${user.orgId}`,
        `/api/projects/${project}/environments/${envName}/ledger?workspaceId=ws_x&orgId=${user.orgId}`,
      ]) {
        const res = await user.req(path);
        expect(res.status, path).toBe(503);
        expect(await errorCode(res)).toBe("NOT_CONFIGURED");
      }
    }

    const writeRes = await user.req(`/api/projects/${project}/environments/preview/data/tables/invoices/rows`, {
      body: {
        orgId: user.orgId,
        workspaceId: "ws_x",
        confirmWrite: true,
        row: { id: "inv_w", invoice_number: "W-1", amount: 1 },
      },
    });
    expect(writeRes.status).toBe(503);
    expect(await errorCode(writeRes)).toBe("NOT_CONFIGURED");

    expect(await listTableNames(studioDb)).toEqual(before);
    expectNoAppTables(before);
  });

  test("RUN_NO_APP_DB: with no app DB binding a workflow run never falls back to STUDIO_DB (NOT_CONFIGURED without a sandbox, the sandbox D1 with one)", async () => {
    const user = await createUser("run");
    const project = await createInvoicesProject(user, "s17-run", [
      { opId: "op_cw", type: "enable_brick", brickId: "credit-wallet", config: {} },
      {
        opId: "op_wf",
        type: "add_workflow",
        workflow: {
          id: "wf_s17_debit",
          name: "S17 debit",
          trigger: { kind: "manual" },
          nodes: [
            { id: "node_trigger", type: "trigger.manual", data: {} },
            { id: "node_debit", type: "credit-wallet.debit", data: { amount: 5 } },
          ],
          edges: [{ id: "e1", source: "node_trigger", target: "node_debit" }],
        },
      },
    ]);
    const before = await listTableNames(studioDb);
    expectNoAppTables(before);
    const runPath = `/api/projects/${project}/workflows/wf_s17_debit/runs`;
    const runBody = { orgId: user.orgId, input: { workspaceId: "ws_run" } };

    const noStoreRes = await user.req(runPath, { body: runBody, env: envWithoutAppDb });
    expect(noStoreRes.status).toBe(503);
    expect(await errorCode(noStoreRes)).toBe("NOT_CONFIGURED");
    expect(await listTableNames(studioDb)).toEqual(before);

    await activateTestSandbox(studioDb, { project, orgId: user.orgId });
    const sandboxRes = await user.req(runPath, { body: runBody, env: envWithoutAppDb });
    expect(sandboxRes.status).not.toBe(503);
    expect(sandboxRes.status).toBeLessThan(500);
    // The run's brick tables are the sandbox's; STUDIO_DB's table set is unchanged.
    expect(await listTableNames(sandboxDbA)).toContain("credit_wallets");
    expect(await listTableNames(studioDb)).toEqual(before);
  });
});
