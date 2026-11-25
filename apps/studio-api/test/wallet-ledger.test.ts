import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import studioAuthOrgsSql from "../migrations/0001_studio_auth_orgs.sql?raw";
import studioSecretVaultSql from "../migrations/0002_studio_secret_vault.sql?raw";
import cp5DeployTokensSql from "../migrations/0003_cp5_deploy_tokens.sql?raw";
import cp6DataBrowserSql from "../migrations/0005_cp6_data_browser.sql?raw";
import { app as studioApp, ensureStudioD1Schema, resetStudioDeployTestState } from "../src/index.ts";
import type { StudioApiEnv } from "../src/index.ts";
import { seedRowsDirectly } from "./seed-direct.ts";
import { activateTestSandbox, dropAllTables } from "./sandbox-data-store.ts";

const rawEnv = env as unknown as StudioApiEnv;
const studioDb = rawEnv.STUDIO_DB as D1Like;
// Story 17: the project's wallet and usage tables live in its own data store (the active sandbox D1), never in
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
    TEST_ENV,
  );
}

describe("Story 6.2 — Studio API Read-Only Credit Wallet & Usage Ledger (/api/projects/:project/environments/:envName/ledger)", () => {
  let ownerToken = "";
  let viewerToken = "";
  let orgId = "";
  let project = "";
  let testCounter = 0;

  beforeEach(async () => {
    testCounter += 1;
    project = `proj-wallet-ledger-${testCounter}`;
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
        email: `owner-s62-${testCounter}@example.com`,
        password: "OwnerPassword123!",
        displayName: "Owner S62",
      },
    });
    const ownerData = (await ownerSignup.json()) as {
      token: string;
      user: { id: string };
    };
    ownerToken = ownerData.token;

    const viewerSignup = await callStudio("/api/auth/signup", {
      body: {
        email: `viewer-s62-${testCounter}@example.com`,
        password: "ViewerPassword123!",
        displayName: "Viewer S62",
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
        name: `Org S62 ${testCounter}`,
        slug: `org-s62-${testCounter}`,
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

    await callStudio(`/api/orgs/${orgId}/projects`, {
      token: ownerToken,
      body: { project },
    });

    await callStudio(`/api/projects/${project}/ops`, {
      token: ownerToken,
      headers: { "x-org-id": orgId },
      body: {
        author: { type: "human", id: "owner-s62" },
        summary: "Enable multi-workspace and credit-wallet bricks",
        ops: [
          { opId: "op-mw", type: "enable_brick", brickId: "multi-workspace", config: {} },
          {
            opId: "op-cw",
            type: "enable_brick",
            brickId: "credit-wallet",
            config: { creditsPerUnit: 10, minOrderAmount: 100 },
          },
        ],
      },
    });

    // Story 16: the seed route only seeds blueprint entity tables and refuses raw DDL; it still builds the project's
    // environment schema (the credit-wallet brick tables). Story 17: that schema is built in the project's sandbox D1,
    // not STUDIO_DB, and the fixture rows are written straight to that sandbox D1.
    await activateTestSandbox(studioDb, { project, orgId });
    const seedRes = await callStudio(`/api/projects/${project}/environments/preview/data/seed`, {
      token: ownerToken,
      body: { orgId },
    });
    expect(seedRes.status).toBe(200);
    await seedRowsDirectly(sandboxDb, {
        ddl: [
          `CREATE TABLE IF NOT EXISTS "usage_rollups" (
            "id" TEXT PRIMARY KEY,
            "workspace_id" TEXT NOT NULL,
            "metric_key" TEXT NOT NULL,
            "period_start" TEXT NOT NULL,
            "period_end" TEXT NOT NULL,
            "total_quantity" INTEGER NOT NULL
          )`,
        ],
        tables: {
          credit_wallets: [
            { workspace_id: "workspace_A", balance_milli: 650_000, created_at: "2026-04-19T10:00:00Z" },
            { workspace_id: "workspace_B", balance_milli: 3_000_000, created_at: "2026-04-19T11:00:00Z" },
          ],
          credit_ledger: [
            {
              id: "led_a_1",
              workspace_id: "workspace_A",
              user_id: "alice",
              type: "topup",
              amount_milli: 1_000_000,
              balance_after_milli: 1_000_000,
              reason: "Initial credit grant",
              metadata: JSON.stringify({ orderId: "ord_a_1" }),
              idempotency_key: "idem_a_1",
              created_at: "2026-04-19T10:01:00Z",
            },
            {
              id: "led_a_2",
              workspace_id: "workspace_A",
              user_id: "alice",
              type: "deduction",
              amount_milli: -350_000,
              balance_after_milli: 650_000,
              reason: "Workflow step execution",
              metadata: JSON.stringify({ runId: "run_inv_01", nodeId: "node-pick" }),
              idempotency_key: "idem_a_2",
              created_at: "2026-04-19T10:05:00Z",
            },
            {
              id: "led_b_1",
              workspace_id: "workspace_B",
              user_id: "bob",
              type: "topup",
              amount_milli: 3_000_000,
              balance_after_milli: 3_000_000,
              reason: "Workspace B credit grant",
              metadata: JSON.stringify({ orderId: "ord_b_1" }),
              idempotency_key: "idem_b_1",
              created_at: "2026-04-19T11:01:00Z",
            },
          ],
          usage_rollups: [
            {
              id: "ur_a_1",
              workspace_id: "workspace_A",
              metric_key: "ai_tokens_used",
              period_start: "2026-04-01",
              period_end: "2026-04-30",
              total_quantity: 12500,
            },
            {
              id: "ur_b_1",
              workspace_id: "workspace_B",
              metric_key: "ai_tokens_used",
              period_start: "2026-04-01",
              period_end: "2026-04-30",
              total_quantity: 99999,
            },
          ],
        },
    });
  });

  it("allows viewer role to read workspace-scoped ledger balance, usage summary, and journal entries for workspace_A with zero workspace_B leakage (AC 3, AC 5)", async () => {
    const res = await callStudio(
      `/api/projects/${project}/environments/preview/ledger?workspaceId=workspace_A&orgId=${orgId}`,
      { token: viewerToken },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      workspaceId: string;
      readOnly: boolean;
      immutable: boolean;
      wallet: { balance: number; netChange30d: number; balanceMilli?: number; netChange30dMilli?: number };
      usageSummary: Array<{ metricKey: string; totalQuantity: number }>;
      journalEntries: Array<{
        entryId: string;
        workspaceId: string;
        delta: number;
        balanceAfter: number;
        reason: string;
        idempotencyKey: string;
        runId: string | null;
        nodeId: string | null;
      }>;
    };

    expect(body.ok).toBe(true);
    expect(body.workspaceId).toBe("workspace_A");
    expect(body.readOnly).toBe(true);
    expect(body.immutable).toBe(true);
    expect(body.wallet.balance).toBe(650);
    expect(body.wallet.netChange30d).toBe(650);
    // Story 2.5: credit-wallet holds thousandths; the ledger reads them exactly and also returns them.
    expect(body.wallet).toMatchObject({ balanceMilli: 650_000, netChange30dMilli: 650_000 });
    expect(body.usageSummary).toEqual([
      expect.objectContaining({
        metricKey: "ai_tokens_used",
        totalQuantity: 12500,
      }),
    ]);
    expect(body.journalEntries).toHaveLength(2);
    expect(body.journalEntries.map((e) => e.entryId)).toEqual(["led_a_2", "led_a_1"]);
    expect(body.journalEntries[0]?.runId).toBe("run_inv_01");
    expect(body.journalEntries[0]?.nodeId).toBe("node-pick");
  });

  it("refuses POST, PATCH, PUT, and DELETE against /ledger and wallet/usage tables in both preview and production with HTTP 403 LEDGER_IMMUTABLE_READ_ONLY (AC 2, AC 3, AC 5)", async () => {
    for (const envName of ["preview", "production"] as const) {
      for (const method of ["POST", "PATCH", "PUT", "DELETE"] as const) {
        const directRes = await callStudio(
          `/api/projects/${project}/environments/${envName}/ledger?workspaceId=workspace_A&orgId=${orgId}`,
          {
            method,
            token: ownerToken,
            body: { workspaceId: "workspace_A", confirmWrite: true, balance: 999999 },
          },
        );
        expect(directRes.status).toBe(403);
        const directJson = (await directRes.json()) as { error: { code: string } };
        expect(directJson.error.code).toBe("LEDGER_IMMUTABLE_READ_ONLY");
      }

      for (const table of ["credit_wallets", "credit_ledger", "usage_rollups"] as const) {
        const tableRes = await callStudio(
          `/api/projects/${project}/environments/${envName}/data/tables/${table}/rows?workspaceId=workspace_A&orgId=${orgId}`,
          {
            method: "POST",
            token: ownerToken,
            body: {
              orgId,
              workspaceId: "workspace_A",
              confirmWrite: true,
              row: { id: "tamper_1", balance: 999999 },
            },
          },
        );
        expect(tableRes.status).toBe(403);
        const tableJson = (await tableRes.json()) as { error: { code: string } };
        expect(tableJson.error.code).toBe("LEDGER_IMMUTABLE_READ_ONLY");
      }
    }
  });
});
