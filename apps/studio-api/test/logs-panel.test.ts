import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import {
  REDACTED_PLACEHOLDER,
  createStructuredLogger,
} from "@poc/telemetry";
import {
  createFakeGateway,
  createWallet,
  createWalletRoutes,
} from "@poc/credit-wallet";
import type { WalletEnv } from "@poc/credit-wallet";
import { catalog } from "@poc/assembler/catalog";
import studioAuthOrgsSql from "../migrations/0001_studio_auth_orgs.sql?raw";
import studioSecretVaultSql from "../migrations/0002_studio_secret_vault.sql?raw";
import cp5DeployTokensSql from "../migrations/0003_cp5_deploy_tokens.sql?raw";
import cp6DataBrowserSql from "../migrations/0005_cp6_data_browser.sql?raw";
import { ensureStudioD1Schema } from "../src/index.ts";
// Story 0.9: brick action placeholders are injected explicitly so the debit fails for insufficient balance.
import { appWithPlaceholderExecutors as studioApp } from "./placeholder-executors.ts";
import type { StudioApiEnv } from "../src/index.ts";
import { seedPreviewWorkspace } from "./preview-workspace-seed.ts";

const rawEnv = env as unknown as StudioApiEnv;
const studioDb = rawEnv.STUDIO_DB as D1Like;

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

describe("Story 6.3 — Studio API Structured Logs & Errors Panel (/api/projects/:project/environments/:envName/logs)", () => {
  let ownerToken = "";
  let viewerToken = "";
  let orgId = "";
  let project = "";
  let testCounter = 0;

  beforeEach(async () => {
    testCounter += 1;
    project = `proj-logs-panel-${testCounter}`;
    await ensureStudioD1Schema(studioDb);
    await applyMigration(studioDb, studioAuthOrgsSql);
    await applyMigration(studioDb, studioSecretVaultSql);
    await applyMigration(studioDb, cp5DeployTokensSql);
    await applyMigration(studioDb, cp6DataBrowserSql);

    await studioDb.batch([
      studioDb.prepare("DELETE FROM px_logs"),
      studioDb.prepare("DELETE FROM px_step_events"),
      studioDb.prepare("DELETE FROM px_runs"),
      studioDb.prepare("DROP TABLE IF EXISTS credit_ledger"),
      studioDb.prepare("DROP TABLE IF EXISTS credit_wallets"),
      studioDb.prepare("DROP TABLE IF EXISTS credit_orders"),
      studioDb.prepare(
        "CREATE TABLE IF NOT EXISTS credit_wallets (workspace_id TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0), updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
      ),
      studioDb.prepare(
        "CREATE TABLE IF NOT EXISTS credit_ledger (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, type TEXT NOT NULL, amount INTEGER NOT NULL, balance_after INTEGER NOT NULL CHECK (balance_after >= 0), reason TEXT NOT NULL, metadata TEXT, idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
      ),
      studioDb.prepare(
        "CREATE TABLE IF NOT EXISTS credit_orders (order_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, amount INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
      ),
      studioDb.prepare("DELETE FROM studio_org_members"),
      studioDb.prepare("DELETE FROM studio_orgs"),
      studioDb.prepare('DELETE FROM "session"'),
      studioDb.prepare('DELETE FROM "account"'),
      studioDb.prepare('DELETE FROM "verification"'),
      studioDb.prepare('DELETE FROM "user"'),
    ]);

    const signUpOwner = await callStudio("/api/auth/signup", {
      body: {
        email: `owner-logs-${testCounter}@example.com`,
        password: "Password123!",
        displayName: "Logs Owner",
      },
    });
    expect(signUpOwner.status).toBe(201);
    const ownerData = (await signUpOwner.json()) as { token: string };
    ownerToken = ownerData.token;

    const createOrgRes = await callStudio("/api/orgs", {
      token: ownerToken,
      body: {
        name: `Logs Org ${testCounter}`,
        slug: `logs-org-${testCounter}`,
      },
    });
    expect(createOrgRes.status).toBe(201);
    const orgPayload = (await createOrgRes.json()) as {
      id?: string;
      org?: { id: string };
    };
    orgId = orgPayload.id ?? orgPayload.org?.id ?? "";

    const signUpViewer = await callStudio("/api/auth/signup", {
      body: {
        email: `viewer-logs-${testCounter}@example.com`,
        password: "Password123!",
        displayName: "Logs Viewer",
      },
    });
    expect(signUpViewer.status).toBe(201);
    const viewerData = (await signUpViewer.json()) as {
      token: string;
      user: { id: string };
    };
    viewerToken = viewerData.token;

    const addMemberRes = await callStudio(`/api/orgs/${orgId}/members`, {
      token: ownerToken,
      body: {
        userId: viewerData.user.id,
        role: "viewer",
      },
    });
    expect(addMemberRes.status).toBe(201);

    await callStudio(`/api/orgs/${orgId}/projects`, {
      token: ownerToken,
      body: { project },
    });

    // Initialize project with a workflow containing a credit-wallet.debit step
    const opsRes = await callStudio(`/api/projects/${project}/ops`, {
      token: ownerToken,
      headers: { "x-org-id": orgId },
      body: {
        orgId,
        baseRevision: 0,
        author: { type: "human", id: "user-owner" },
        ops: [
          {
            opId: `op-brick-mw-${testCounter}`,
            type: "enable_brick",
            brickId: "multi-workspace",
            config: {},
          },
          {
            opId: `op-brick-cw-${testCounter}`,
            type: "enable_brick",
            brickId: "credit-wallet",
            config: {},
          },
          {
            opId: `op-wf-${testCounter}`,
            type: "add_workflow",
            workflow: {
              id: "wf_payment_flow",
              name: "Payment Flow",
              trigger: { kind: "manual" },
              nodes: [
                {
                  id: "node_trigger",
                  type: "trigger.manual",
                  data: {},
                },
                {
                  id: "node_charge_wallet",
                  type: "credit-wallet.debit",
                  data: { amount: 250 },
                },
              ],
              edges: [
                {
                  id: "edge_1",
                  source: "node_trigger",
                  target: "node_charge_wallet",
                },
              ],
            },
          },
        ],
      },
    });
    expect(opsRes.status).toBe(200);
  });

  it("persists workflow step and credit-wallet brick route logs into px_logs with secret redaction and filters by level, workspaceId, brickId, and runId", async () => {
    const CANARY_SECRET = "sk_live_canary_gateway_secret_556677";

    // Seal a project secret in the vault so log ingestion also scrubs vault secrets automatically
    const sealRes = await callStudio(`/api/projects/${project}/secrets`, {
      token: ownerToken,
      body: {
        orgId,
        ref: "sec_payment_gateway",
        kind: "api_key",
        label: "Gateway Secret",
        appOrBrick: "credit-wallet",
        envScope: "all",
        value: CANARY_SECRET,
      },
    });
    expect(sealRes.status).toBe(200);

    // Story 1.17: the run names ws_alpha, so ws_alpha must be one of the project's own workspaces (an earlier run names it).
    await seedPreviewWorkspace(studioDb, project, "ws_alpha");
    // 1. Trigger a failing workflow run on wf_payment_flow (balance 40 < amount 250)
    const runRes = await callStudio(
      `/api/projects/${project}/workflows/wf_payment_flow/runs`,
      {
        token: ownerToken,
        body: {
          orgId,
          env: "preview",
          runId: "run_wf_fail_01",
          workspaceId: "ws_alpha",
          triggerPayload: {
            balance: 40,
            workspaceId: "ws_alpha",
          },
        },
      },
    );
    expect(runRes.status).toBe(200);
    // The run fails because the debit is refused for insufficient balance (not NOT_CONFIGURED).
    const runText = await runRes.text();
    expect(runText).toMatch(/insufficient balance/);
    expect(runText).not.toMatch(/NOT_CONFIGURED/);

    // 2. Also emit an explicit ctx.log.error entry from a workflow step with canary secret in message & fields
    const ingestStepLogRes = await callStudio(
      `/api/projects/${project}/environments/preview/logs`,
      {
        token: ownerToken,
        body: {
          orgId,
          entries: [
            {
              level: "error",
              message: `Payment gateway timeout using key ${CANARY_SECRET}`,
              runId: "run_wf_fail_01",
              workflowId: "wf_payment_flow",
              revision: 1,
              nodeId: "node_charge_wallet",
              brickId: "credit-wallet",
              workspaceId: "ws_alpha",
              fields: {
                gatewayKey: CANARY_SECRET,
                authorization: "Bearer eyJ_inline_bearer_secret_token",
                attempt: 1,
              },
              errorStack: `Error: Payment gateway timeout (${CANARY_SECRET})\n    at executeWalletDebit (workflow.ts:24:11)`,
            },
          ],
        },
      },
    );
    expect(ingestStepLogRes.status).toBe(201);

    // 3. Execute a brick route handler from @poc/credit-wallet wired with createStructuredLogger
    const gateway = createFakeGateway();
    const wallet = createWallet(studioDb, gateway);
    await wallet.openWallet("ws_beta");

    // Story 1.4: Studio's logs read is confined to the project, so the brick's lines are stamped with it (as Studio's
    // own ingest stamps every line it stores).
    const brickLogger = createStructuredLogger({
      db: studioDb,
      writeOptions: { projectId: project },
      context: {
        brickId: "credit-wallet",
        workspaceId: "ws_beta",
        requestId: "req_wallet_deduct_01",
        envName: "preview",
      },
      redactOptions: {
        secretValues: [CANARY_SECRET],
      },
    });

    const walletApp = new Hono<WalletEnv>();
    walletApp.use("*", async (c, next) => {
      c.set("user", { uid: "usr_beta_1" });
      c.set("workspace", { id: "ws_beta", role: "owner", suspended: false });
      c.set("log", brickLogger);
      await next();
    });
    walletApp.route("/", createWalletRoutes({ gateway, currency: "INR" }));

    const deductRes = await walletApp.request(
      "http://wallet.local/wallet/deduct",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: 500, reason: "ai_run" }),
      },
      { DB: studioDb },
    );
    expect(deductRes.status).toBe(402);
    await brickLogger.flush();

    // 4. Viewer role can query GET /api/projects/:project/environments/preview/logs
    const allLogsRes = await callStudio(
      `/api/projects/${project}/environments/preview/logs?orgId=${orgId}`,
      { token: viewerToken },
    );
    expect(allLogsRes.status).toBe(200);
    const allLogsBody = (await allLogsRes.json()) as {
      ok: boolean;
      logs: Array<{
        seq: number;
        logId: string;
        level: string;
        message: string;
        runId: string | null;
        nodeId: string | null;
        brickId: string | null;
        workspaceId: string | null;
        fieldsJson: string;
        errorStack: string | null;
      }>;
      nextCursor: number;
    };
    expect(allLogsBody.ok).toBe(true);
    expect(allLogsBody.logs.length).toBeGreaterThanOrEqual(3);

    // Verify canary secret is completely scrubbed across all logs
    const serializedAll = JSON.stringify(allLogsBody.logs);
    expect(serializedAll).not.toContain(CANARY_SECRET);
    expect(serializedAll).not.toContain("eyJ_inline_bearer_secret_token");
    expect(serializedAll).toContain(REDACTED_PLACEHOLDER);

    // Filter by level=error & workspaceId=ws_alpha & runId=run_wf_fail_01
    const errorLogsRes = await callStudio(
      `/api/projects/${project}/environments/preview/logs?orgId=${orgId}&level=error&workspaceId=ws_alpha&brickId=credit-wallet&runId=run_wf_fail_01`,
      { token: viewerToken },
    );
    expect(errorLogsRes.status).toBe(200);
    const errorLogsBody = (await errorLogsRes.json()) as typeof allLogsBody;
    expect(errorLogsBody.logs.length).toBeGreaterThanOrEqual(1);
    for (const entry of errorLogsBody.logs) {
      expect(entry.level).toBe("error");
      expect(entry.workspaceId).toBe("ws_alpha");
      expect(entry.brickId).toBe("credit-wallet");
      expect(entry.runId).toBe("run_wf_fail_01");
      expect(entry.nodeId).toBe("node_charge_wallet");
    }

    // Filter by workspaceId=ws_beta (brick route log)
    const betaLogsRes = await callStudio(
      `/api/projects/${project}/environments/preview/logs?orgId=${orgId}&workspaceId=ws_beta&brickId=credit-wallet`,
      { token: viewerToken },
    );
    expect(betaLogsRes.status).toBe(200);
    const betaLogsBody = (await betaLogsRes.json()) as typeof allLogsBody;
    expect(betaLogsBody.logs).toHaveLength(1);
    expect(betaLogsBody.logs[0]!.level).toBe("warn");
    expect(betaLogsBody.logs[0]!.message).toContain(
      "Insufficient balance for wallet deduction",
    );
    expect(betaLogsBody.logs[0]!.runId).toBeNull();
  });

  it("relays live redacted log frames over the project WebSocket when new logs are ingested", async () => {
    const wsRes = await studioApp.fetch(
      new Request(`https://example.test/api/projects/${project}/ws`, {
        headers: {
          Upgrade: "websocket",
          authorization: `Bearer ${viewerToken}`,
        },
      }),
      TEST_ENV,
    );
    expect(wsRes.status).toBe(101);
    const ws = wsRes.webSocket!;
    ws.accept();

    const receivedFrames: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (ev) => {
      try {
        receivedFrames.push(
          JSON.parse(String(ev.data)) as Record<string, unknown>,
        );
      } catch {
        // Ignore non-JSON frames
      }
    });

    const ingestRes = await callStudio(
      `/api/projects/${project}/environments/preview/logs`,
      {
        token: ownerToken,
        body: {
          orgId,
          entries: [
            {
              level: "error",
              message: "Webhook signature mismatch with token Bearer secret_live_tok_999",
              runId: "run_live_ws_01",
              workflowId: "wf_payment_flow",
              nodeId: "node_trigger",
              brickId: "webhook-gateway",
              workspaceId: "ws_alpha",
              fields: {
                apiKey: "sk_test_inline_secret_123",
              },
            },
          ],
        },
      },
    );
    expect(ingestRes.status).toBe(201);

    const logFrame = receivedFrames.find((f) => f.type === "log") as
      | {
          type: "log";
          project: string;
          envName: string;
          entry: {
            runId: string;
            nodeId: string;
            brickId: string;
            workspaceId: string;
            message: string;
            fieldsJson: string;
          };
        }
      | undefined;

    expect(logFrame).toBeDefined();
    expect(logFrame!.project).toBe(project);
    expect(logFrame!.envName).toBe("preview");
    expect(logFrame!.entry.runId).toBe("run_live_ws_01");
    expect(logFrame!.entry.nodeId).toBe("node_trigger");
    expect(logFrame!.entry.brickId).toBe("webhook-gateway");
    expect(logFrame!.entry.workspaceId).toBe("ws_alpha");
    expect(logFrame!.entry.message).toMatch(/\[REDACTED/);
    expect(logFrame!.entry.message).not.toContain("secret_live_tok_999");
    expect(logFrame!.entry.fieldsJson).not.toContain("sk_test_inline_secret_123");

    ws.close();
  });
});
