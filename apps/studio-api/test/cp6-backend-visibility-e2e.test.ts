import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { REDACTED_PLACEHOLDER } from "@poc/telemetry";
import type { EnvironmentHealthSummary } from "@poc/telemetry";
import studioAuthOrgsSql from "../migrations/0001_studio_auth_orgs.sql?raw";
import studioSecretVaultSql from "../migrations/0002_studio_secret_vault.sql?raw";
import cp5DeployTokensSql from "../migrations/0003_cp5_deploy_tokens.sql?raw";
import cp6DataBrowserSql from "../migrations/0005_cp6_data_browser.sql?raw";
import { ensureStudioD1Schema, resetStudioDeployTestState } from "../src/index.ts";
import { activateTestSandbox, dropAllTables } from "./sandbox-data-store.ts";
import { appWithPlaceholderExecutors as studioApp } from "./placeholder-executors.ts";
import type { StudioApiEnv } from "../src/index.ts";

const rawEnv = env as unknown as StudioApiEnv;
const studioDb = rawEnv.STUDIO_DB as D1Like;
// Story 17: the project's entity and brick tables live in its own data store (the active sandbox D1), never in
// STUDIO_DB. The test D1 binding `DB` stands in for that sandbox database.
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
  env?: Partial<StudioApiEnv>;
}

async function callStudio(
  path: string,
  options: CallOptions = {},
): Promise<Response> {
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
    { ...TEST_ENV, ...options.env },
  );
}

describe("Story 6.5 — CP6 Backend Visibility End-to-End Gate", () => {
  beforeEach(async () => {
    await applyMigration(studioDb, studioAuthOrgsSql);
    await applyMigration(studioDb, studioSecretVaultSql);
    await applyMigration(studioDb, cp5DeployTokensSql);
    await applyMigration(studioDb, cp6DataBrowserSql);
    await ensureStudioD1Schema(studioDb);

    await studioDb.batch([
      studioDb.prepare("DELETE FROM px_http_rollups"),
      studioDb.prepare("DELETE FROM px_queue_metrics"),
      studioDb.prepare("DELETE FROM px_logs"),
      studioDb.prepare("DELETE FROM px_step_events"),
      studioDb.prepare("DELETE FROM px_runs"),
      studioDb.prepare("DELETE FROM data_browser_audit_log"),
      studioDb.prepare("DELETE FROM studio_sandboxes"),
    ]);
    resetStudioDeployTestState({ createSandboxD1: () => sandboxDb });
    await dropAllTables(sandboxDb);
  });

  it("verifies all 6 CP6 Done-when criteria end-to-end across preview and production", async () => {
    const suffix = Date.now();
    const project = `cp6-gate-${suffix}`;
    const CANARY_SECRET = `sk_live_cp6_gate_canary_secret_${suffix}`;
    const baseNow = "2026-06-25T15:00:00.000Z";
    const min10Ago = new Date(Date.parse(baseNow) - 10 * 60_000).toISOString();

    await studioDb.batch([
      studioDb.prepare("DELETE FROM studio_org_members"),
      studioDb.prepare("DELETE FROM studio_orgs"),
      studioDb.prepare('DELETE FROM "session"'),
      studioDb.prepare('DELETE FROM "account"'),
      studioDb.prepare('DELETE FROM "verification"'),
      studioDb.prepare('DELETE FROM "user"'),
    ]);

    // 1. Authenticate Owner & create Org + Project
    const signUpOwner = await callStudio("/api/auth/signup", {
      body: {
        email: `owner-cp6-gate-${suffix}@example.com`,
        password: "Password123!",
        displayName: "CP6 Gate Owner",
      },
    });
    expect(signUpOwner.status).toBe(201);
    const { token: ownerToken, user: ownerUser } = (await signUpOwner.json()) as {
      token: string;
      user: { id: string };
    };
    // Story 16: a health reset wipes every project's rollups in the environment, so only a platform operator may send
    // one; this test's owner is made one for its reset call.
    const operatorEnv = { PX_PLATFORM_OPERATORS: ownerUser.id };

    const createOrgRes = await callStudio("/api/orgs", {
      token: ownerToken,
      body: {
        name: `CP6 Gate Org ${suffix}`,
        slug: `cp6-gate-org-${suffix}`,
      },
    });
    expect(createOrgRes.status).toBe(201);
    const orgPayload = (await createOrgRes.json()) as {
      id?: string;
      org?: { id: string };
    };
    const orgId = orgPayload.id ?? orgPayload.org?.id ?? "";

    const createProjRes = await callStudio(`/api/orgs/${orgId}/projects`, {
      token: ownerToken,
      body: { project },
    });
    expect(createProjRes.status).toBe(201);

    // 2. Configure multi-brick project (core-auth, multi-workspace, credit-wallet, usage-metering, queue-jobs, dynamic-entities + entity `invoices` + 3-node workflow `wf_invoice_settlement`)
    const opsRes = await callStudio(`/api/projects/${project}/ops`, {
      token: ownerToken,
      headers: { "x-org-id": orgId },
      body: {
        orgId,
        baseRevision: 0,
        author: { type: "human", id: "usr-cp6-gate" },
        ops: [
          {
            opId: `op-brick-auth-${suffix}`,
            type: "enable_brick",
            brickId: "core-auth",
            config: {},
          },
          {
            opId: `op-brick-mw-${suffix}`,
            type: "enable_brick",
            brickId: "multi-workspace",
            config: {},
          },
          {
            opId: `op-brick-cw-${suffix}`,
            type: "enable_brick",
            brickId: "credit-wallet",
            config: {},
          },
          {
            opId: `op-brick-um-${suffix}`,
            type: "enable_brick",
            brickId: "metered-usage",
            config: {},
          },
          {
            opId: `op-brick-qj-${suffix}`,
            type: "enable_brick",
            brickId: "outbound-webhooks",
            config: {},
          },
          {
            opId: `op-brick-de-${suffix}`,
            type: "enable_brick",
            brickId: "dynamic-entities",
            config: {},
          },
          {
            opId: `op-ent-invoices-${suffix}`,
            type: "add_entity",
            entity: {
              name: "invoices",
              workspaceScoped: true,
              fields: [
                { name: "title", type: "text", required: true },
                { name: "amount_cents", type: "number", required: true },
                { name: "status", type: "text", required: true },
              ],
            },
          },
          {
            opId: `op-wf-invoices-${suffix}`,
            type: "add_workflow",
            workflow: {
              id: "wf_invoice_settlement",
              name: "Invoice Settlement Workflow",
              trigger: { kind: "manual" },
              nodes: [
                {
                  id: "node_trigger",
                  type: "trigger.manual",
                  data: {},
                },
                {
                  id: "node_debit",
                  type: "credit-wallet.debit",
                  data: { amount: 150 },
                },
                {
                  id: "node_create_invoice",
                  type: "credit-wallet.credit",
                  data: { amount: 10 },
                },
              ],
              edges: [
                {
                  id: "e1",
                  source: "node_trigger",
                  target: "node_debit",
                },
                {
                  id: "e2",
                  source: "node_debit",
                  target: "node_create_invoice",
                },
              ],
            },
          },
        ],
      },
    });
    expect(opsRes.status).toBe(200);

    // Seal canary secret in project vault
    const sealRes = await callStudio(`/api/projects/${project}/secrets`, {
      token: ownerToken,
      headers: { "x-org-id": orgId },
      body: {
        ref: "sec_cp6_canary",
        kind: "api_key",
        label: "CP6 Canary Secret",
        appOrBrick: "credit-wallet",
        envScope: "all",
        value: CANARY_SECRET,
      },
    });
    expect([200, 201]).toContain(sealRes.status);

    // 3. Create tables and seed workspace_A and workspace_B data in the project's sandbox D1 (story 17: never STUDIO_DB)
    await activateTestSandbox(studioDb, { project, orgId });
    await sandboxDb.batch([
      sandboxDb.prepare(
        `CREATE TABLE IF NOT EXISTS ent_invoices (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          title TEXT NOT NULL,
          amount_cents INTEGER NOT NULL,
          status TEXT NOT NULL,
          api_secret_token TEXT DEFAULT 'secret_col_should_be_stripped',
          created_at TEXT NOT NULL
        )`,
      ),
      sandboxDb.prepare(
        `CREATE TABLE IF NOT EXISTS credit_wallets (
          workspace_id TEXT PRIMARY KEY,
          balance INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        )`,
      ),
      sandboxDb.prepare(
        `CREATE TABLE IF NOT EXISTS credit_ledger (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          type TEXT NOT NULL,
          amount INTEGER NOT NULL,
          balance_after INTEGER NOT NULL,
          reason TEXT NOT NULL,
          metadata TEXT,
          idempotency_key TEXT UNIQUE,
          created_at TEXT NOT NULL
        )`,
      ),
      sandboxDb.prepare(
        `CREATE TABLE IF NOT EXISTS usage_events (
          event_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          metric_key TEXT NOT NULL,
          quantity INTEGER NOT NULL,
          created_at TEXT NOT NULL
        )`,
      ),
      sandboxDb.prepare(
        `CREATE TABLE IF NOT EXISTS usage_rollups (
          workspace_id TEXT NOT NULL,
          metric_key TEXT NOT NULL,
          period_start TEXT NOT NULL,
          period_end TEXT NOT NULL,
          total_quantity INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, metric_key, period_start)
        )`,
      ),
      sandboxDb.prepare(
        `CREATE TABLE IF NOT EXISTS px_connections (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          encrypted_payload TEXT NOT NULL
        )`,
      ),
      sandboxDb.prepare(
        `CREATE TABLE IF NOT EXISTS int_connections (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          oauth_refresh_token TEXT NOT NULL
        )`,
      ),
      sandboxDb
        .prepare(
          "INSERT INTO ent_invoices (id, workspace_id, title, amount_cents, status, api_secret_token, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(
          "inv_ws_a_1",
          "workspace_A",
          "Workspace A Enterprise Plan",
          25000,
          "paid",
          CANARY_SECRET,
          min10Ago,
        ),
      sandboxDb
        .prepare(
          "INSERT INTO ent_invoices (id, workspace_id, title, amount_cents, status, api_secret_token, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(
          "inv_ws_b_1",
          "workspace_B",
          "Workspace B Confidential Deal",
          99000,
          "draft",
          CANARY_SECRET,
          min10Ago,
        ),
      sandboxDb
        .prepare(
          "INSERT INTO credit_wallets (workspace_id, balance, updated_at) VALUES (?1, ?2, ?3)",
        )
        .bind("workspace_A", 850, min10Ago),
      sandboxDb
        .prepare(
          "INSERT INTO credit_wallets (workspace_id, balance, updated_at) VALUES (?1, ?2, ?3)",
        )
        .bind("workspace_B", 4200, min10Ago),
      sandboxDb
        .prepare(
          "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason, metadata, idempotency_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )
        .bind(
          "led_ws_a_1",
          "workspace_A",
          "usr_a",
          "debit",
          -150,
          850,
          "workflow:wf_invoice_settlement",
          JSON.stringify({ runId: "run_cp6_pass_01", nodeId: "node_debit" }),
          "idem_a_1",
          min10Ago,
        ),
      sandboxDb
        .prepare(
          "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason, metadata, idempotency_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )
        .bind(
          "led_ws_b_1",
          "workspace_B",
          "usr_b",
          "credit",
          4200,
          4200,
          "topup:enterprise_b",
          "{}",
          "idem_b_1",
          min10Ago,
        ),
      sandboxDb
        .prepare(
          "INSERT INTO usage_rollups (workspace_id, metric_key, period_start, period_end, total_quantity) VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(
          "workspace_A",
          "api_calls",
          "2026-06-01T00:00:00.000Z",
          "2026-06-30T23:59:59.000Z",
          320,
        ),
      sandboxDb
        .prepare(
          "INSERT INTO usage_rollups (workspace_id, metric_key, period_start, period_end, total_quantity) VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(
          "workspace_B",
          "api_calls",
          "2026-06-01T00:00:00.000Z",
          "2026-06-30T23:59:59.000Z",
          9999,
        ),
    ]);

    // 4. Criterion 1 & 2: Cross-workspace isolation & secret/connection table stripping
    const tablesRes = await callStudio(
      `/api/projects/${project}/environments/preview/data/tables?workspaceId=workspace_A`,
      {
        token: ownerToken,
        headers: { "x-org-id": orgId },
      },
    );
    expect(tablesRes.status).toBe(200);
    const tablesBody = (await tablesRes.json()) as {
      tables: Array<{ tableName: string; columns: Array<{ name: string }> }>;
    };
    const tableNames = tablesBody.tables.map((t) => t.tableName);
    expect(tableNames).toContain("ent_invoices");
    expect(tableNames).not.toContain("px_connections");
    expect(tableNames).not.toContain("int_connections");
    expect(tableNames).not.toContain("_px_migrations");

    const rowsARes = await callStudio(
      `/api/projects/${project}/environments/preview/data/tables/ent_invoices/rows?workspaceId=workspace_A`,
      {
        token: ownerToken,
        headers: { "x-org-id": orgId },
      },
    );
    expect(rowsARes.status).toBe(200);
    const rowsABody = (await rowsARes.json()) as {
      rows: Array<Record<string, unknown>>;
      columns: Array<{ name: string }>;
    };
    expect(rowsABody.rows).toHaveLength(1);
    expect(rowsABody.rows[0]?.id).toBe("inv_ws_a_1");
    expect(rowsABody.rows[0]?.workspace_id).toBe("workspace_A");
    expect(rowsABody.rows[0]?.api_secret_token).toBeUndefined();
    expect(JSON.stringify(rowsABody)).not.toContain("Workspace B Confidential Deal");
    expect(JSON.stringify(rowsABody)).not.toContain(CANARY_SECRET);

    const ledgerARes = await callStudio(
      `/api/projects/${project}/environments/preview/ledger?workspaceId=workspace_A`,
      {
        token: ownerToken,
        headers: { "x-org-id": orgId },
      },
    );
    expect(ledgerARes.status).toBe(200);
    const ledgerABody = (await ledgerARes.json()) as {
      wallet: { balance: number };
      usageSummary: Array<{ metricKey: string; totalQuantity: number }>;
      journalEntries: Array<{ entryId: string; workspaceId: string }>;
    };
    expect(ledgerABody.wallet.balance).toBe(850);
    expect(ledgerABody.usageSummary).toEqual([
      expect.objectContaining({ metricKey: "api_calls", totalQuantity: 320 }),
    ]);
    expect(ledgerABody.journalEntries).toHaveLength(1);
    expect(ledgerABody.journalEntries[0]?.entryId).toBe("led_ws_a_1");
    expect(JSON.stringify(ledgerABody)).not.toContain("workspace_B");

    // 5. Criterion 3: Production read-only vs Preview confirmed audited writes
    const prodWriteRes = await callStudio(
      `/api/projects/${project}/environments/production/data/tables/ent_invoices/rows/inv_ws_a_1`,
      {
        method: "PATCH",
        token: ownerToken,
        headers: { "x-org-id": orgId },
        body: {
          workspaceId: "workspace_A",
          confirmWrite: true,
          patch: { status: "refunded" },
        },
      },
    );
    expect(prodWriteRes.status).toBe(403);
    const prodWriteErr = (await prodWriteRes.json()) as {
      error: { code: string };
    };
    expect(prodWriteErr.error.code).toBe("PRODUCTION_DATA_WRITE_FORBIDDEN");

    const previewEditRes = await callStudio(
      `/api/projects/${project}/environments/preview/data/tables/ent_invoices/rows/inv_ws_a_1`,
      {
        method: "PATCH",
        token: ownerToken,
        headers: { "x-org-id": orgId },
        body: {
          workspaceId: "workspace_A",
          confirmWrite: true,
          patch: { status: "settled" },
        },
      },
    );
    expect(previewEditRes.status).toBe(200);

    const auditRes = await callStudio(
      `/api/projects/${project}/environments/preview/data/audit-log?workspaceId=workspace_A`,
      {
        token: ownerToken,
        headers: { "x-org-id": orgId },
      },
    );
    expect(auditRes.status).toBe(200);
    const auditBody = (await auditRes.json()) as {
      entries: Array<{
        tableName: string;
        rowId: string;
        operation: string;
        beforeSnapshot: Record<string, unknown>;
        afterSnapshot: Record<string, unknown>;
      }>;
    };
    expect(auditBody.entries).toHaveLength(1);
    expect(auditBody.entries[0]?.rowId).toBe("inv_ws_a_1");
    expect(auditBody.entries[0]?.beforeSnapshot.status).toBe("paid");
    expect(auditBody.entries[0]?.afterSnapshot.status).toBe("settled");

    // 6. Criterion 4: Wallet & Usage Ledger tables reject all writes in both preview & production
    for (const envTarget of ["preview", "production"] as const) {
      for (const ledgerTable of [
        "credit_wallets",
        "credit_ledger",
        "usage_events",
        "usage_rollups",
      ] as const) {
        const mutRes = await callStudio(
          `/api/projects/${project}/environments/${envTarget}/data/tables/${ledgerTable}/rows`,
          {
            method: "POST",
            token: ownerToken,
            headers: { "x-org-id": orgId },
            body: {
              workspaceId: "workspace_A",
              confirmWrite: true,
              row: { workspace_id: "workspace_A", balance: 999999 },
            },
          },
        );
        expect(mutRes.status).toBe(403);
        const mutBody = (await mutRes.json()) as { error: { code: string } };
        expect(mutBody.error.code).toBe("LEDGER_IMMUTABLE_READ_ONLY");
      }
    }

    // 7. Criterion 5: Run passing & failing workflow; verify structured error log correlation & secret redaction
    const passRunRes = await callStudio(
      `/api/projects/${project}/workflows/wf_invoice_settlement/runs`,
      {
        method: "POST",
        token: ownerToken,
        headers: { "x-org-id": orgId },
        body: {
          env: "preview",
          runId: "run_cp6_pass_01",
          workspaceId: "workspace_A",
          triggerPayload: {
            balance: 500,
            workspaceId: "workspace_A",
            title: "INV-PASS",
          },
        },
      },
    );
    expect(passRunRes.status).toBe(200);
    const passRunBody = (await passRunRes.json()) as { runStatus: string };
    expect(passRunBody.runStatus).toBe("succeeded");

    const failRunRes = await callStudio(
      `/api/projects/${project}/workflows/wf_invoice_settlement/runs`,
      {
        method: "POST",
        token: ownerToken,
        headers: { "x-org-id": orgId },
        body: {
          env: "preview",
          runId: "run_cp6_fail_01",
          workspaceId: "workspace_A",
          secrets: {
            GATEWAY_KEY: CANARY_SECRET,
          },
          triggerPayload: {
            balance: 20, // < 150 => fails on node_debit
            workspaceId: "workspace_A",
            apiKey: CANARY_SECRET,
          },
        },
      },
    );
    expect(failRunRes.status).toBe(200);
    const failRunBody = (await failRunRes.json()) as { runStatus: string };
    expect(failRunBody.runStatus).toBe("failed");

    // Emit a brick-route error log correlated to run_cp6_fail_01 containing the planted canary secret
    const ingestErrLogRes = await callStudio(
      `/api/projects/${project}/environments/preview/logs`,
      {
        method: "POST",
        token: ownerToken,
        headers: { "x-org-id": orgId },
        body: {
          entries: [
            {
              level: "error",
              message: `Settlement webhook failed with gateway secret ${CANARY_SECRET}`,
              runId: "run_cp6_fail_01",
              workflowId: "wf_invoice_settlement",
              nodeId: "node_debit",
              brickId: "credit-wallet",
              workspaceId: "workspace_A",
              fields: {
                authorization: `Bearer ${CANARY_SECRET}`,
              },
            },
          ],
        },
      },
    );
    expect(ingestErrLogRes.status).toBe(201);

    const errorLogsRes = await callStudio(
      `/api/projects/${project}/environments/preview/logs?level=error&runId=run_cp6_fail_01`,
      {
        token: ownerToken,
        headers: { "x-org-id": orgId },
      },
    );
    expect(errorLogsRes.status).toBe(200);
    const errorLogsBody = (await errorLogsRes.json()) as {
      logs: Array<{
        level: string;
        runId: string | null;
        workflowId: string | null;
        nodeId: string | null;
        brickId: string | null;
        workspaceId: string | null;
        message: string;
        fieldsJson: string;
      }>;
    };
    expect(errorLogsBody.logs.length).toBeGreaterThanOrEqual(1);
    const errLog = errorLogsBody.logs[0]!;
    expect(errLog.level).toBe("error");
    expect(errLog.runId).toBe("run_cp6_fail_01");
    expect(errLog.workflowId).toBe("wf_invoice_settlement");
    expect(errLog.nodeId).toBe("node_debit");
    expect(errLog.brickId).toBe("credit-wallet");
    expect(errLog.workspaceId).toBe("workspace_A");
    expect(JSON.stringify(errorLogsBody)).not.toContain(CANARY_SECRET);
    expect(JSON.stringify(errorLogsBody)).toContain(REDACTED_PLACEHOLDER);

    // 8. Criterion 6: 24h Backend Health & Metrics accuracy and drill-down resolution
    const seedHealthRes = await callStudio(
      `/api/projects/${project}/environments/preview/health/seed`,
      {
        method: "POST",
        token: ownerToken,
        headers: { "x-org-id": orgId },
        env: operatorEnv,
        body: {
          // Story 1.4: seeded rows belong to one of the project's own workspaces (its preview workspace here).
          workspaceId: "ws_default",
          reset: true,
          window: "24h",
          samples: [
            ...Array.from({ length: 19 }, (_, idx) => ({
              ts: new Date(Date.now() - 5 * 60_000).toISOString(),
              routePrefix: "/webhooks/invoices",
              brickId: "credit-wallet",
              status: 200,
              latencyMs: 20 + idx * 3,
              d1Queries: 2,
              d1LatencyMs: 4.5,
              d1Errors: 0,
            })),
            {
              ts: new Date(Date.now() - 5 * 60_000).toISOString(),
              routePrefix: "/webhooks/invoices",
              brickId: "credit-wallet",
              status: 500,
              latencyMs: 240,
              d1Queries: 3,
              d1LatencyMs: 12.0,
              d1Errors: 1,
            },
          ],
          queues: [
            {
              queueName: "px-jobs-queue",
              pendingCount: 7,
              dlqCount: 1,
            },
          ],
        },
      },
    );
    expect(seedHealthRes.status).toBe(200);

    const health24hRes = await callStudio(
      `/api/projects/${project}/environments/preview/health?window=24h`,
      {
        token: ownerToken,
        headers: { "x-org-id": orgId },
      },
    );
    expect(health24hRes.status).toBe(200);
    const health24h = (await health24hRes.json()) as EnvironmentHealthSummary;
    expect(health24h.requestCount).toBe(20);
    expect(health24h.error5xxCount).toBe(1);
    expect(health24h.errorRatePercent).toBe(5);
    expect(health24h.latencyP50Ms).toBeGreaterThan(0);
    expect(health24h.latencyP95Ms).toBeGreaterThanOrEqual(health24h.latencyP50Ms);
    expect(health24h.workflows.totalRuns).toBe(2);
    expect(health24h.workflows.succeededRuns).toBe(1);
    expect(health24h.workflows.failedRuns).toBe(1);
    expect(health24h.workflows.topFailingWorkflows[0]).toEqual({
      workflowId: "wf_invoice_settlement",
      failedCount: 1,
      lastFailedRunId: "run_cp6_fail_01",
    });
    expect(health24h.queues).toContainEqual(
      expect.objectContaining({
        queueName: "px-jobs-queue",
        depth: 7,
        dlqCount: 1,
      }),
    );

    // Drill-down to failed runs resolves to run_cp6_fail_01
    const failedRunsRes = await callStudio(
      `/api/projects/${project}/runs?env=preview&status=failed&workflowId=wf_invoice_settlement`,
      {
        token: ownerToken,
        headers: { "x-org-id": orgId },
      },
    );
    expect(failedRunsRes.status).toBe(200);
    const failedRunsBody = (await failedRunsRes.json()) as {
      runs: Array<{ runId: string; failedNodeId: string | null }>;
    };
    expect(failedRunsBody.runs).toHaveLength(1);
    expect(failedRunsBody.runs[0]?.runId).toBe("run_cp6_fail_01");
    expect(failedRunsBody.runs[0]?.failedNodeId).toBe("node_debit");
  });
});
