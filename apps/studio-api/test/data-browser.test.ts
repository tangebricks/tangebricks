import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import { seedRowsDirectly } from "./seed-direct.ts";
import { activateTestSandbox, dropAllTables } from "./sandbox-data-store.ts";
import type { D1Like } from "@poc/sdk";
import studioAuthOrgsSql from "../migrations/0001_studio_auth_orgs.sql?raw";
import studioSecretVaultSql from "../migrations/0002_studio_secret_vault.sql?raw";
import cp5DeployTokensSql from "../migrations/0003_cp5_deploy_tokens.sql?raw";
import cp6DataBrowserSql from "../migrations/0005_cp6_data_browser.sql?raw";
import { app as studioApp, ensureStudioD1Schema, resetStudioDeployTestState } from "../src/index.ts";
import type { StudioApiEnv } from "../src/index.ts";

const rawEnv = env as unknown as StudioApiEnv;
const studioDb = rawEnv.STUDIO_DB as D1Like;
// Story 17: the project's data lives in its own data store (the active sandbox D1), never in STUDIO_DB. The test D1
// binding `DB` stands in for that sandbox database.
const sandboxDb = (env as unknown as { DB: D1Like }).DB;

const TEST_ENV: StudioApiEnv = {
  ...rawEnv,
  BETTER_AUTH_SECRET: "studio-test-better-auth-secret-0123456789abcdef",
  PX_VAULT_KEY: "studio-test-aes-gcm-256-vault-master-key-99887766",
  PX_TOKEN_KEK: "studio-cp6-test-master-kek-v1-256bit-key-material-0001",
  PX_TOKEN_KEK_VERSION: "1",
  GITHUB_CLIENT_ID: "studio-gh-test-client-id",
  GITHUB_CLIENT_SECRET: "studio-gh-test-client-secret",
};

interface CallOptions {
  method?: string;
  token?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

async function callStudio(path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);

  let rawBody: string | undefined;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    rawBody = JSON.stringify(options.body);
  }

  return studioApp.fetch(
    new Request(`https://example.test${path}`, {
      method: options.method ?? (rawBody !== undefined ? "POST" : "GET"),
      headers,
      body: rawBody,
    }),
    TEST_ENV,
  );
}

describe("Story 6.1 — Studio API Data Browser (/api/projects/:project/environments/:envName/data/*) & data_browser_audit_log", () => {
  let ownerToken = "";
  let viewerToken = "";
  let orgId = "";
  let project = "";
  let testCounter = 0;

  beforeEach(async () => {
    testCounter += 1;
    project = `proj-data-browser-${testCounter}`;
    await ensureStudioD1Schema(studioDb);
    await applyMigration(studioDb, studioAuthOrgsSql);
    await applyMigration(studioDb, studioSecretVaultSql);
    await applyMigration(studioDb, cp5DeployTokensSql);
    await applyMigration(studioDb, cp6DataBrowserSql);
    resetStudioDeployTestState({ createSandboxD1: () => sandboxDb });
    await dropAllTables(sandboxDb);

    await studioDb.batch([
      studioDb.prepare("DELETE FROM studio_sandboxes"),
      studioDb.prepare("DELETE FROM data_browser_audit_log"),
      studioDb.prepare("DELETE FROM studio_org_members"),
      studioDb.prepare("DELETE FROM studio_orgs"),
      studioDb.prepare('DELETE FROM "session"'),
      studioDb.prepare('DELETE FROM "account"'),
      studioDb.prepare('DELETE FROM "verification"'),
      studioDb.prepare('DELETE FROM "user"'),
    ]);

    const ownerSignup = await callStudio("/api/auth/signup", {
      body: {
        email: `owner-s61-${testCounter}@example.com`,
        password: "OwnerPassword123!",
        displayName: "Owner S61",
      },
    });
    const ownerData = (await ownerSignup.json()) as {
      token: string;
      user: { id: string };
    };
    ownerToken = ownerData.token;

    const viewerSignup = await callStudio("/api/auth/signup", {
      body: {
        email: `viewer-s61-${testCounter}@example.com`,
        password: "ViewerPassword123!",
        displayName: "Viewer S61",
      },
    });
    const viewerData = (await viewerSignup.json()) as {
      token: string;
      user: { id: string };
    };
    viewerToken = viewerData.token;

    const orgRes = await callStudio("/api/orgs", {
      token: ownerToken,
      body: {
        name: `Org S61 ${testCounter}`,
        slug: `org-s61-${testCounter}`,
      },
    });
    const orgData = (await orgRes.json()) as {
      id?: string;
      org?: { id: string };
    };
    orgId = orgData.id ?? orgData.org?.id ?? "";

    await callStudio(`/api/orgs/${orgId}/members`, {
      token: ownerToken,
      body: {
        userId: viewerData.user.id,
        role: "viewer",
      },
    });

    const createProjRes = await callStudio(`/api/orgs/${orgId}/projects`, {
      token: ownerToken,
      body: { project },
    });
    expect([200, 201]).toContain(createProjRes.status);

    const opsRes = await callStudio(`/api/projects/${project}/ops`, {
      token: ownerToken,
      headers: { "x-org-id": orgId },
      body: {
        summary: "Seed blueprint for Story 6.1",
        ops: [
          {
            opId: "op_brick_ws",
            type: "enable_brick",
            brickId: "multi-workspace",
            config: {},
          },
          {
            opId: "op_brick_auth",
            type: "enable_brick",
            brickId: "core-auth",
            config: {},
          },
          {
            opId: "op_brick_ent",
            type: "enable_brick",
            brickId: "dynamic-entities",
            config: {},
          },
          {
            opId: "op_brick_wh",
            type: "enable_brick",
            brickId: "outbound-webhooks",
            config: {},
          },
          {
            opId: "op_ent_invoices",
            type: "add_entity",
            entity: {
              name: "invoices",
              workspaceScoped: true,
              fields: [
                {
                  name: "invoice_number",
                  type: "text",
                  required: true,
                  maxLength: 100,
                },
                { name: "amount", type: "number", required: true },
                {
                  name: "status",
                  type: "enum",
                  required: true,
                  values: ["open", "paid", "void"],
                },
              ],
            },
          },
        ],
      },
    });
    expect(opsRes.status).toBe(200);

    // Seed 10 rows in workspace_A and 10 rows in workspace_B across ent_invoices and webhooks, plus a secret column & px_connections table
    const invoiceRows: Array<Record<string, unknown>> = [];
    const webhookRows: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= 10; i += 1) {
      const padded = String(i).padStart(2, "0");
      invoiceRows.push(
        {
          id: `inv_A_${padded}`,
          workspace_id: "workspace_A",
          invoice_number: `INV-A-${padded}`,
          amount: i * 100,
          status: i % 2 === 0 ? "paid" : "open",
          secret_token: `tok_secret_A_${padded}`,
          password_hash: `hash_secret_A_${padded}`,
          created_at: `2026-10-${padded}T10:00:00.000Z`,
          updated_at: `2026-10-${padded}T10:00:00.000Z`,
        },
        {
          id: `inv_B_${padded}`,
          workspace_id: "workspace_B",
          invoice_number: `INV-B-${padded}`,
          amount: i * 300,
          status: i % 2 === 0 ? "paid" : "void",
          secret_token: `tok_secret_B_${padded}`,
          password_hash: `hash_secret_B_${padded}`,
          created_at: `2026-10-${padded}T11:00:00.000Z`,
          updated_at: `2026-10-${padded}T11:00:00.000Z`,
        },
      );
      webhookRows.push(
        {
          id: `wh_A_${padded}`,
          workspace_id: "workspace_A",
          target_url: `https://a.example.com/wh/${padded}`,
          event_type: "invoice.paid",
          signing_secret: `whsec_A_${padded}`,
        },
        {
          id: `wh_B_${padded}`,
          workspace_id: "workspace_B",
          target_url: `https://b.example.com/wh/${padded}`,
          event_type: "invoice.void",
          signing_secret: `whsec_B_${padded}`,
        },
      );
    }

    // Story 16: the seed route only seeds blueprint entity tables and refuses raw DDL; it still builds the project's
    // environment schema. Story 17: all of it lands in the project's sandbox D1, not STUDIO_DB. These fixture tables
    // (and the app's px_connections row) are written straight to that sandbox D1 first.
    await activateTestSandbox(studioDb, { project, orgId });
    await seedRowsDirectly(sandboxDb, {
      ddl: [
        `CREATE TABLE IF NOT EXISTS ent_invoices (
              id TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              invoice_number TEXT NOT NULL,
              amount INTEGER NOT NULL,
              status TEXT NOT NULL,
              secret_token TEXT,
              password_hash TEXT,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );`,
        `CREATE TABLE IF NOT EXISTS webhooks (
              id TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              target_url TEXT NOT NULL,
              event_type TEXT NOT NULL,
              signing_secret TEXT NOT NULL
            );`,
        `CREATE TABLE IF NOT EXISTS px_connections (
              id TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              provider TEXT NOT NULL,
              secret_token TEXT NOT NULL
            );`,
      ],
      tables: {
        ent_invoices: invoiceRows,
        webhooks: webhookRows,
        px_connections: [
          {
            id: "conn_1",
            workspace_id: "workspace_A",
            provider: "stripe",
            secret_token: "sk_live_secret_999",
          },
        ],
      },
    });
    const seedRes = await callStudio(`/api/projects/${project}/environments/preview/data/seed`, { token: ownerToken, body: { orgId } });
    expect(seedRes.status).toBe(200);
  });

  it("serves workspaces, table catalog (without px_connections or secret columns), and strictly isolated rows for workspace_A (AC 1, AC 3, AC 5)", async () => {
    const wsRes = await callStudio(`/api/projects/${project}/environments/preview/data/workspaces?orgId=${orgId}`, { token: viewerToken });
    expect(wsRes.status).toBe(200);
    const wsBody = (await wsRes.json()) as { workspaces: string[] };
    expect(wsBody.workspaces).toContain("workspace_A");
    expect(wsBody.workspaces).toContain("workspace_B");

    const tablesRes = await callStudio(`/api/projects/${project}/environments/preview/data/tables?workspaceId=workspace_A&orgId=${orgId}`, {
      token: viewerToken,
    });
    expect(tablesRes.status).toBe(200);
    const tablesBody = (await tablesRes.json()) as {
      tables: Array<{
        name: string;
        category: "entity" | "brick";
        columns: Array<{ name: string }>;
      }>;
    };
    const names = tablesBody.tables.map((t) => t.name);
    expect(names).toContain("invoices");
    expect(names).toContain("webhooks");
    expect(names).not.toContain("px_connections");

    const invCols = tablesBody.tables.find((t) => t.name === "invoices")!.columns.map((c) => c.name);
    expect(invCols).not.toContain("secret_token");
    expect(invCols).not.toContain("password_hash");

    // Query workspace_A with adversarial filter value
    const advRowsRes = await callStudio(
      `/api/projects/${project}/environments/preview/data/tables/invoices/rows?workspaceId=workspace_A&orgId=${orgId}&filter=${encodeURIComponent("workspace_id != 'workspace_A'")}`,
      { token: viewerToken },
    );
    expect(advRowsRes.status).toBe(200);
    const advRowsBody = (await advRowsRes.json()) as {
      rows: Array<Record<string, unknown>>;
      totalCount: number;
    };
    expect(advRowsBody.totalCount).toBe(10);
    expect(advRowsBody.rows).toHaveLength(10);
    expect(advRowsBody.rows.every((r) => r.workspace_id === "workspace_A")).toBe(true);
    for (const r of advRowsBody.rows) {
      expect(r).not.toHaveProperty("secret_token");
      expect(r).not.toHaveProperty("password_hash");
    }
  });

  it("enforces RBAC (viewer rejected on writes), rejects production writes with 403 PRODUCTION_DATA_WRITE_FORBIDDEN, blocks cross-workspace PATCH/DELETE, and records data_browser_audit_log on preview writes (AC 2, AC 3, AC 5)", async () => {
    // 1. Viewer role cannot mutate preview rows (403)
    const viewerWriteRes = await callStudio(`/api/projects/${project}/environments/preview/data/tables/invoices/rows`, {
      method: "POST",
      token: viewerToken,
      body: {
        orgId,
        workspaceId: "workspace_A",
        confirmWrite: true,
        row: { invoice_number: "INV-V-1", amount: 100, status: "open" },
      },
    });
    expect(viewerWriteRes.status).toBe(403);

    // 2. Production environment rejects POST, PATCH, and DELETE with 403 PRODUCTION_DATA_WRITE_FORBIDDEN
    for (const method of ["POST", "PATCH", "DELETE"] as const) {
      const prodRes = await callStudio(`/api/projects/${project}/environments/production/data/tables/invoices/rows`, {
        method,
        token: ownerToken,
        body: {
          orgId,
          workspaceId: "workspace_A",
          rowId: "inv_A_01",
          confirmWrite: true,
          row: { invoice_number: "INV-P-1", amount: 100, status: "open" },
        },
      });
      expect(prodRes.status).toBe(403);
      const prodErr = (await prodRes.json()) as { error: { code: string } };
      expect(prodErr.error.code).toBe("PRODUCTION_DATA_WRITE_FORBIDDEN");
    }

    // 3. Cross-workspace PATCH / DELETE of workspace_B row while scoped to workspace_A returns 404 and records 0 audit rows
    const crossPatchRes = await callStudio(`/api/projects/${project}/environments/preview/data/tables/invoices/rows/inv_B_01`, {
      method: "PATCH",
      token: ownerToken,
      body: {
        orgId,
        workspaceId: "workspace_A",
        confirmWrite: true,
        patch: { status: "paid", amount: 1 },
      },
    });
    expect(crossPatchRes.status).toBe(404);

    // 4. Confirmed insert, update, and delete on workspace_A in preview succeed and write complete data_browser_audit_log rows
    // Story 1.17: a client-supplied requestId is never signed; Studio mints a fresh one for the write.
    const insertRes = await callStudio(`/api/projects/${project}/environments/preview/data/tables/invoices/rows?requestId=x`, {
      method: "POST",
      token: ownerToken,
      body: {
        orgId,
        workspaceId: "workspace_A",
        confirmWrite: true,
        row: {
          id: "inv_A_99",
          invoice_number: "INV-A-99",
          amount: 4200,
          status: "open",
        },
      },
    });
    expect(insertRes.status).toBe(201);
    const insertBody = (await insertRes.json()) as {
      auditId: string;
      rowId: string;
    };
    expect(insertBody.auditId).toMatch(/^dba_/);
    expect(insertBody.rowId).toBe("inv_A_99");
    const claimed = await sandboxDb
      .prepare("SELECT request_id FROM px_control_requests WHERE path = '/__px/data/tables/invoices/rows'")
      .all<{ request_id: string }>();
    expect((claimed.results ?? []).map((r) => r.request_id)).not.toContain("x");
    expect((claimed.results ?? []).some((r) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(r.request_id))).toBe(true);

    const updateRes = await callStudio(`/api/projects/${project}/environments/preview/data/tables/invoices/rows/inv_A_99`, {
      method: "PATCH",
      token: ownerToken,
      body: {
        orgId,
        workspaceId: "workspace_A",
        confirmWrite: true,
        patch: {
          amount: 4500,
          status: "paid",
        },
      },
    });
    expect(updateRes.status).toBe(200);

    const deleteRes = await callStudio(`/api/projects/${project}/environments/preview/data/tables/invoices/rows/inv_A_99`, {
      method: "DELETE",
      token: ownerToken,
      body: {
        orgId,
        workspaceId: "workspace_A",
        confirmWrite: true,
      },
    });
    expect(deleteRes.status).toBe(200);

    // Verify all 3 audit log records in data_browser_audit_log
    const auditRes = await callStudio(`/api/projects/${project}/environments/preview/data/audit-log?workspaceId=workspace_A&orgId=${orgId}`, {
      token: ownerToken,
    });
    expect(auditRes.status).toBe(200);
    const auditBody = (await auditRes.json()) as {
      entries: Array<{
        auditId: string;
        orgId: string;
        projectId: string;
        envName: string;
        workspaceId: string;
        tableName: string;
        rowId: string;
        operation: "insert" | "update" | "delete";
        actor: string;
        beforeSnapshot: Record<string, unknown> | null;
        afterSnapshot: Record<string, unknown> | null;
        createdAt: string;
      }>;
    };
    expect(auditBody.entries).toHaveLength(3);

    const operations = auditBody.entries.map((e) => e.operation).sort();
    expect(operations).toEqual(["delete", "insert", "update"]);

    const insertEntry = auditBody.entries.find((e) => e.operation === "insert")!;
    expect(insertEntry.workspaceId).toBe("workspace_A");
    expect(insertEntry.tableName).toBe("invoices");
    expect(insertEntry.rowId).toBe("inv_A_99");
    expect(insertEntry.beforeSnapshot).toBeNull();
    expect(insertEntry.afterSnapshot).toMatchObject({
      id: "inv_A_99",
      workspace_id: "workspace_A",
      invoice_number: "INV-A-99",
      amount: 4200,
      status: "open",
    });

    const updateEntry = auditBody.entries.find((e) => e.operation === "update")!;
    expect(updateEntry.beforeSnapshot?.amount).toBe(4200);
    expect(updateEntry.afterSnapshot?.amount).toBe(4500);
    expect(updateEntry.afterSnapshot?.status).toBe("paid");

    const deleteEntry = auditBody.entries.find((e) => e.operation === "delete")!;
    expect(deleteEntry.beforeSnapshot?.amount).toBe(4500);
    expect(deleteEntry.afterSnapshot).toBeNull();
  });

  it("story 1.18: an entity with a blueprint-only type no longer hides every entity's table, and the new types get their columns", async () => {
    const opsRes = await callStudio(`/api/projects/${project}/ops`, {
      token: ownerToken,
      headers: { "x-org-id": orgId },
      body: {
        summary: "Story 1.18: blueprint-only and new field types",
        ops: [
          {
            opId: "op_ent_notes",
            type: "add_entity",
            entity: {
              name: "notes_log",
              fields: [
                { name: "title", type: "string" },
                { name: "payload", type: "json" },
                { name: "seen_at", type: "datetime" },
                { name: "invoice_ref", type: "relation", relation: "invoices.id" },
                { name: "due_on", type: "date" },
                { name: "fee", type: "money", currencies: ["INR"] },
                { name: "body", type: "longtext" },
              ],
            },
          },
        ],
      },
    });
    expect(opsRes.status).toBe(200);

    const seedRes = await callStudio(`/api/projects/${project}/environments/preview/data/seed`, {
      token: ownerToken,
      body: {
        orgId,
        tables: {
          ent_notes_log: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              workspace_id: "workspace_A",
              title: "hello",
              invoice_ref: "22222222-2222-4222-8222-222222222222",
              due_on: "2026-11-26",
              fee: 1999,
              fee__currency: "INR",
            },
          ],
          ent_invoices: [{ id: "inv_A_99", workspace_id: "workspace_A", invoice_number: "INV-A-99", amount: 1, status: "open" }],
        },
      },
    });
    expect(seedRes.status).toBe(200);
    const columns = (await sandboxDb.prepare(`SELECT name FROM pragma_table_info('ent_notes_log')`).all<{ name: string }>()).results.map((r) => r.name);
    expect(columns).toEqual(expect.arrayContaining(["title", "payload", "seen_at", "invoice_ref", "due_on", "fee", "fee__currency", "body"]));
  });

  it("story 1.18: a stored relation to an undeclared entity does not hide the other entities' tables", async () => {
    // Write the dangling relation straight into the stored blueprint (ops would refuse it), as an older blueprint
    // relating to core-auth's users would hold it.
    const stub = rawEnv.BLUEPRINT_DO.get(rawEnv.BLUEPRINT_DO.idFromName(project));
    const current = (await (await stub.fetch(`http://blueprint-do/state?project=${encodeURIComponent(project)}`)).json()) as {
      revision: number;
      state: { entities: unknown[] };
    };
    const state = {
      ...current.state,
      entities: [
        ...current.state.entities,
        { name: "tickets", workspaceScoped: true, fields: [{ name: "owner_id", type: "relation", relation: "users.id", required: false }] },
      ],
    };
    const seeded = await stub.fetch("http://blueprint-do/seed", { method: "POST", body: JSON.stringify({ project, state, revision: current.revision + 1 }) });
    expect(seeded.status).toBe(200);

    const seedRes = await callStudio(`/api/projects/${project}/environments/preview/data/seed`, {
      token: ownerToken,
      body: {
        orgId,
        tables: {
          ent_invoices: [{ id: "inv_A_98", workspace_id: "workspace_A", invoice_number: "INV-A-98", amount: 1, status: "open" }],
          ent_tickets: [{ id: "33333333-3333-4333-8333-333333333333", workspace_id: "workspace_A", owner_id: "44444444-4444-4444-8444-444444444444" }],
        },
      },
    });
    expect(seedRes.status).toBe(200);
  });
});
