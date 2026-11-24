import { env } from "cloudflare:workers";
import type { D1Like } from "@poc/sdk";
import { signControlPlaneRequest } from "@poc/telemetry";
import { describe, expect, it } from "vitest";
import { handleDataBrowserRequest } from "../src/worker/data-browser.ts";

const TEST_SECRET = "cp6_wallet_ledger_hmac_secret_0123456789abcdef";

async function setupWalletAndUsageSchema(db: D1Like): Promise<void> {
  await db.exec(
    [
      "DROP TABLE IF EXISTS credit_ledger;",
      "DROP TABLE IF EXISTS credit_wallets;",
      "DROP TABLE IF EXISTS credit_orders;",
      "DROP TABLE IF EXISTS wallet_ledger;",
      "DROP TABLE IF EXISTS wallet_balances;",
      "DROP TABLE IF EXISTS usage_rollups;",
      "DROP TABLE IF EXISTS usage_events;",
      "CREATE TABLE credit_wallets (workspace_id TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0), created_at TEXT NOT NULL DEFAULT (datetime('now')));",
      "CREATE TABLE credit_ledger (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('topup', 'deduction')), amount INTEGER NOT NULL, balance_after INTEGER NOT NULL CHECK (balance_after >= 0), reason TEXT NOT NULL, metadata TEXT, idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));",
      "CREATE TABLE usage_rollups (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, metric_key TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, total_quantity INTEGER NOT NULL);",
    ].join(" "),
  );

  // Seed workspace_A: +1000 topup -> -250 deduction (run_bill_a1 / node-charge) -> -150 deduction (run_bill_a2 / node-charge) => balance 600, netChange30d +600
  await db
    .prepare("INSERT INTO credit_wallets (workspace_id, balance, created_at) VALUES (?1, ?2, ?3)")
    .bind("workspace_A", 600, "2026-04-19T10:00:00Z")
    .run();

  await db
    .prepare(
      "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason, metadata, idempotency_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )
    .bind(
      "led_a_1",
      "workspace_A",
      "alice",
      "topup",
      1000,
      1000,
      "Starter credit grant",
      JSON.stringify({ orderId: "ord_a_1" }),
      "idem_a_topup_1",
      "2026-04-19T10:01:00Z",
    )
    .run();

  await db
    .prepare(
      "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason, metadata, idempotency_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )
    .bind(
      "led_a_2",
      "workspace_A",
      "alice",
      "deduction",
      -250,
      750,
      "Workflow AI invoice enrichment",
      JSON.stringify({ runId: "run_bill_a1", nodeId: "node-pick" }),
      "idem_a_deduct_1",
      "2026-04-19T10:05:00Z",
    )
    .run();

  await db
    .prepare(
      "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason, metadata, idempotency_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )
    .bind(
      "led_a_3",
      "workspace_A",
      "alice",
      "deduction",
      -150,
      600,
      "Outbound webhook dispatch",
      JSON.stringify({ runId: "run_bill_a2", nodeId: "node-trigger" }),
      "idem_a_deduct_2",
      "2026-04-19T10:10:00Z",
    )
    .run();

  // Seed workspace_B: +5000 topup -> -800 deduction => balance 4200
  await db
    .prepare("INSERT INTO credit_wallets (workspace_id, balance, created_at) VALUES (?1, ?2, ?3)")
    .bind("workspace_B", 4200, "2026-04-19T11:00:00Z")
    .run();

  await db
    .prepare(
      "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason, metadata, idempotency_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )
    .bind(
      "led_b_1",
      "workspace_B",
      "bob",
      "topup",
      5000,
      5000,
      "Enterprise credit pack",
      JSON.stringify({ orderId: "ord_b_1" }),
      "idem_b_topup_1",
      "2026-04-19T11:01:00Z",
    )
    .run();

  await db
    .prepare(
      "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason, metadata, idempotency_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )
    .bind(
      "led_b_2",
      "workspace_B",
      "bob",
      "deduction",
      -800,
      4200,
      "Batch PDF generation",
      JSON.stringify({ runId: "run_bill_b1", nodeId: "node-pdf" }),
      "idem_b_deduct_1",
      "2026-04-19T11:05:00Z",
    )
    .run();

  // Seed usage_rollups for workspace_A and workspace_B
  await db
    .prepare(
      "INSERT INTO usage_rollups (id, workspace_id, metric_key, period_start, period_end, total_quantity) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind("ur_a_1", "workspace_A", "workflow_executions", "2026-04-01", "2026-04-30", 42)
    .run();
  await db
    .prepare(
      "INSERT INTO usage_rollups (id, workspace_id, metric_key, period_start, period_end, total_quantity) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind("ur_b_1", "workspace_B", "workflow_executions", "2026-04-01", "2026-04-30", 999)
    .run();
}

async function callLedgerRoute(
  db: D1Like,
  pathAndQuery: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
    pxEnv?: "preview" | "production";
  } = {},
): Promise<Response> {
  const method = options.method ?? "GET";
  const rawBody = options.body ? JSON.stringify(options.body) : undefined;
  const fullUrl = new URL(`http://worker.internal${pathAndQuery}`);
  // Story 1.4: the control-plane signature over method, path with query, time and body.
  const signed = await signControlPlaneRequest(TEST_SECRET, method, fullUrl, rawBody ?? "");

  const req = new Request(fullUrl.toString(), {
    method,
    headers: {
      ...(rawBody ? { "content-type": "application/json" } : {}),
      ...signed,
    },
    ...(rawBody ? { body: rawBody } : {}),
  });

  const res = await handleDataBrowserRequest(req, {
    db,
    pxEnv: options.pxEnv ?? "preview",
    telemetrySecret: TEST_SECRET,
  });
  if (!res) {
    throw new Error(`Expected handleDataBrowserRequest to match ${pathAndQuery}`);
  }
  return res;
}

describe("Story 6.2 — Worker Shell Read-Only Credit Wallet & Usage Ledger (/__px/data/ledger)", () => {
  it("returns strictly isolated wallet balance, 30d net change, usage summary, and chronological journal entries with runId/nodeId correlation for workspace_A (AC 1, AC 5)", async () => {
    const db = env.DB as unknown as D1Like;
    await setupWalletAndUsageSchema(db);

    const missingWsRes = await callLedgerRoute(db, "/__px/data/ledger");
    expect(missingWsRes.status).toBe(400);
    const missingWsJson = (await missingWsRes.json()) as { error: { code: string } };
    expect(missingWsJson.error.code).toBe("WORKSPACE_ID_REQUIRED");

    const wsARes = await callLedgerRoute(
      db,
      "/__px/data/ledger?workspaceId=workspace_A",
    );
    expect(wsARes.status).toBe(200);
    const wsABody = (await wsARes.json()) as {
      ok: boolean;
      readOnly: boolean;
      immutable: boolean;
      workspaceId: string;
      wallet: { balance: number; currencyOrUnit: string; netChange30d: number };
      usageSummary: Array<{ metricKey: string; totalQuantity: number }>;
      journalEntries: Array<{
        entryId: string;
        workspaceId: string;
        delta: number;
        balanceAfter: number;
        reason: string;
        idempotencyKey: string | null;
        runId: string | null;
        nodeId: string | null;
      }>;
    };

    expect(wsABody.ok).toBe(true);
    expect(wsABody.readOnly).toBe(true);
    expect(wsABody.immutable).toBe(true);
    expect(wsABody.workspaceId).toBe("workspace_A");
    expect(wsABody.wallet.balance).toBe(600);
    expect(wsABody.wallet.netChange30d).toBe(600);

    expect(wsABody.usageSummary).toHaveLength(1);
    expect(wsABody.usageSummary[0]?.metricKey).toBe("workflow_executions");
    expect(wsABody.usageSummary[0]?.totalQuantity).toBe(42);

    expect(wsABody.journalEntries).toHaveLength(3);
    expect(wsABody.journalEntries.every((e) => e.workspaceId === "workspace_A")).toBe(true);
    expect(wsABody.journalEntries.map((e) => e.entryId)).toEqual([
      "led_a_3",
      "led_a_2",
      "led_a_1",
    ]);
    expect(wsABody.journalEntries[0]?.delta).toBe(-150);
    expect(wsABody.journalEntries[0]?.balanceAfter).toBe(600);
    expect(wsABody.journalEntries[0]?.runId).toBe("run_bill_a2");
    expect(wsABody.journalEntries[0]?.nodeId).toBe("node-trigger");
    expect(wsABody.journalEntries[2]?.delta).toBe(1000);
    expect(wsABody.journalEntries[2]?.balanceAfter).toBe(1000);
  });

  it("unconditionally refuses POST, PATCH, PUT, and DELETE on /__px/data/ledger and all wallet/usage tables in both preview and production with HTTP 403 LEDGER_IMMUTABLE_READ_ONLY (AC 2, AC 5)", async () => {
    const db = env.DB as unknown as D1Like;
    await setupWalletAndUsageSchema(db);

    for (const pxEnv of ["preview", "production"] as const) {
      for (const method of ["POST", "PATCH", "PUT", "DELETE"] as const) {
        const directLedgerRes = await callLedgerRoute(
          db,
          "/__px/data/ledger?workspaceId=workspace_A",
          {
            method,
            pxEnv,
            body: { workspaceId: "workspace_A", confirmWrite: true, balance: 999999 },
          },
        );
        expect(directLedgerRes.status).toBe(403);
        const directBody = (await directLedgerRes.json()) as { error: { code: string } };
        expect(directBody.error.code).toBe("LEDGER_IMMUTABLE_READ_ONLY");
      }

      for (const table of [
        "credit_wallets",
        "credit_ledger",
        "wallet_balances",
        "wallet_ledger",
        "usage_events",
        "usage_rollups",
      ]) {
        const tableWriteRes = await callLedgerRoute(
          db,
          `/__px/data/tables/${table}/rows?workspaceId=workspace_A`,
          {
            method: "POST",
            pxEnv,
            body: {
              workspaceId: "workspace_A",
              confirmWrite: true,
              row: { id: "tamper_1", balance: 999999 },
            },
          },
        );
        expect(tableWriteRes.status).toBe(403);
        const tableBody = (await tableWriteRes.json()) as { error: { code: string } };
        expect(tableBody.error.code).toBe("LEDGER_IMMUTABLE_READ_ONLY");
      }
    }

    // Verify workspace_A balance in D1 is completely untouched
    const row = await db
      .prepare("SELECT balance FROM credit_wallets WHERE workspace_id = ?1")
      .bind("workspace_A")
      .first<{ balance: number }>();
    expect(row?.balance).toBe(600);
  });
});
