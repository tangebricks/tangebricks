import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Like } from "@poc/sdk";
import {
  TELEMETRY_SIGNATURE_HEADER,
  signTelemetryPayload,
} from "@poc/telemetry";
import { createProofRoutes } from "../src/worker/proof-routes.ts";

const TELEMETRY_SECRET = "px_test_data_browser_secret_key_0123456789";
const db = env.DB as D1Like;

const TEST_TABLES = [
  "ent_invoices",
  "webhooks",
  "credit_ledger",
  "px_connections",
  "int_connections",
  "_px_migrations",
];

describe("Story 6.1 — Worker Data Browser (/__px/data/*) cross-workspace isolation, secret stripping & write guardrails", () => {
  const routes = createProofRoutes();

  beforeEach(async () => {
    for (const table of TEST_TABLES) {
      await db.prepare(`DROP TABLE IF EXISTS "${table}"`).run();
    }

    await db.batch([
      db.prepare(`
        CREATE TABLE ent_invoices (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          invoice_number TEXT NOT NULL,
          amount INTEGER NOT NULL,
          status TEXT NOT NULL,
          secret_token TEXT,
          password_hash TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `),
      db.prepare(`
        CREATE TABLE webhooks (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          target_url TEXT NOT NULL,
          event_type TEXT NOT NULL,
          signing_secret TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1
        )
      `),
      db.prepare(`
        CREATE TABLE credit_ledger (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          delta INTEGER NOT NULL,
          balance_after INTEGER NOT NULL,
          reason TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `),
      db.prepare(`
        CREATE TABLE px_connections (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          ciphertext TEXT NOT NULL
        )
      `),
      db.prepare(`
        CREATE TABLE int_connections (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          access_token TEXT NOT NULL
        )
      `),
      db.prepare(`
        CREATE TABLE _px_migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL
        )
      `),
    ]);

    const statements = [];
    for (let i = 1; i <= 10; i += 1) {
      const padded = String(i).padStart(2, "0");
      statements.push(
        db
          .prepare(
            `INSERT INTO ent_invoices (id, workspace_id, invoice_number, amount, status, secret_token, password_hash, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            `inv_A_${padded}`,
            "workspace_A",
            `INV-A-${padded}`,
            i * 100,
            i % 2 === 0 ? "paid" : "open",
            `secret_tok_A_${padded}`,
            `bcrypt_hash_A_${padded}`,
            `2026-10-${padded}T10:00:00.000Z`,
          ),
        db
          .prepare(
            `INSERT INTO ent_invoices (id, workspace_id, invoice_number, amount, status, secret_token, password_hash, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            `inv_B_${padded}`,
            "workspace_B",
            `INV-B-${padded}`,
            i * 250,
            i % 2 === 0 ? "paid" : "void",
            `secret_tok_B_${padded}`,
            `bcrypt_hash_B_${padded}`,
            `2026-10-${padded}T12:00:00.000Z`,
          ),
        db
          .prepare(
            `INSERT INTO webhooks (id, workspace_id, target_url, event_type, signing_secret, active)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            `wh_A_${padded}`,
            "workspace_A",
            `https://a.example.com/hook/${padded}`,
            "invoice.paid",
            `whsec_secret_A_${padded}`,
            1,
          ),
        db
          .prepare(
            `INSERT INTO webhooks (id, workspace_id, target_url, event_type, signing_secret, active)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            `wh_B_${padded}`,
            "workspace_B",
            `https://b.example.com/hook/${padded}`,
            "invoice.void",
            `whsec_secret_B_${padded}`,
            1,
          ),
      );
    }

    statements.push(
      db
        .prepare(
          `INSERT INTO credit_ledger (id, workspace_id, delta, balance_after, reason, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          "led_A_01",
          "workspace_A",
          500,
          500,
          "Initial grant",
          "idem_A_01",
          "2026-10-01T00:00:00.000Z",
        ),
      db
        .prepare(
          `INSERT INTO px_connections (id, workspace_id, provider, ciphertext) VALUES (?, ?, ?, ?)`,
        )
        .bind("conn_1", "workspace_A", "stripe", "super_secret_cipher_xyz"),
    );

    await db.batch(statements);
  });

  async function callDataRoute(
    pathAndQuery: string,
    init: {
      method?: string;
      body?: Record<string, unknown>;
      pxEnv?: "preview" | "production";
      omitSignature?: boolean;
    } = {},
  ): Promise<Response> {
    const method = init.method ?? "GET";
    const bodyText = init.body ? JSON.stringify(init.body) : undefined;
    const fullUrl = new URL(`http://deployed.invalid${pathAndQuery}`);
    const payloadToSign = bodyText ?? `${fullUrl.pathname}${fullUrl.search}`;
    const signature = init.omitSignature
      ? "invalid_signature"
      : await signTelemetryPayload(payloadToSign, TELEMETRY_SECRET);

    const req = new Request(fullUrl.toString(), {
      method,
      headers: {
        ...(bodyText ? { "content-type": "application/json" } : {}),
        [TELEMETRY_SIGNATURE_HEADER]: signature,
      },
      ...(bodyText ? { body: bodyText } : {}),
    });

    const res = await routes(req, {
      DB: db,
      PX_TELEMETRY_SECRET: TELEMETRY_SECRET,
      PX_ENV: init.pxEnv ?? "preview",
      PX_DECLARED_ENTITIES: ["invoices"],
    });
    if (!res) {
      throw new Error(`Route not handled: ${method} ${pathAndQuery}`);
    }
    return res;
  }

  it("rejects unauthenticated requests without valid HMAC X-Px-Signature (401)", async () => {
    const res = await callDataRoute("/__px/data/tables", {
      omitSignature: true,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED_TELEMETRY_SIGNATURE");
  });

  it("lists distinct workspaces and returns table catalog excluding secret tables and secret columns (AC 1, AC 5)", async () => {
    const wsRes = await callDataRoute("/__px/data/workspaces");
    expect(wsRes.status).toBe(200);
    const wsJson = (await wsRes.json()) as { workspaces: string[] };
    expect(wsJson.workspaces).toContain("workspace_A");
    expect(wsJson.workspaces).toContain("workspace_B");

    const tablesRes = await callDataRoute(
      "/__px/data/tables?workspaceId=workspace_A",
    );
    expect(tablesRes.status).toBe(200);
    const tablesJson = (await tablesRes.json()) as {
      tables: Array<{
        name: string;
        tableName: string;
        category: "entity" | "brick";
        readOnly: boolean;
        columns: Array<{ name: string }>;
        rowCount?: number;
      }>;
    };

    const tableNames = tablesJson.tables.map((t) => t.name);
    expect(tableNames).toContain("invoices");
    expect(tableNames).toContain("webhooks");
    expect(tableNames).toContain("credit_ledger");

    // System secret tables are completely excluded
    expect(tableNames).not.toContain("px_connections");
    expect(tableNames).not.toContain("int_connections");
    expect(tableNames).not.toContain("_px_migrations");

    const invoicesTable = tablesJson.tables.find((t) => t.name === "invoices")!;
    expect(invoicesTable.category).toBe("entity");
    expect(invoicesTable.readOnly).toBe(false);
    expect(invoicesTable.rowCount).toBe(10);

    const invoiceColNames = invoicesTable.columns.map((c) => c.name);
    expect(invoiceColNames).toContain("id");
    expect(invoiceColNames).toContain("workspace_id");
    expect(invoiceColNames).toContain("invoice_number");
    expect(invoiceColNames).toContain("amount");
    expect(invoiceColNames).toContain("status");
    // Secret columns omitted
    expect(invoiceColNames).not.toContain("secret_token");
    expect(invoiceColNames).not.toContain("password_hash");

    const webhooksTable = tablesJson.tables.find((t) => t.name === "webhooks")!;
    expect(webhooksTable.category).toBe("brick");
    expect(webhooksTable.readOnly).toBe(true);
    expect(webhooksTable.columns.map((c) => c.name)).not.toContain(
      "signing_secret",
    );

    // Direct query to px_connections is forbidden
    const forbiddenRes = await callDataRoute(
      "/__px/data/tables/px_connections/rows?workspaceId=workspace_A",
    );
    expect(forbiddenRes.status).toBe(403);
  });

  it("enforces mandatory workspaceId (400 WORKSPACE_ID_REQUIRED) and proves strict cross-workspace isolation under adversarial filters (AC 1, AC 5)", async () => {
    const missingWsRes = await callDataRoute("/__px/data/tables/invoices/rows");
    expect(missingWsRes.status).toBe(400);
    const missingWsBody = (await missingWsRes.json()) as {
      error: { code: string };
    };
    expect(missingWsBody.error.code).toBe("WORKSPACE_ID_REQUIRED");

    // Query workspace_A across dynamic entity `invoices`
    const rowsARes = await callDataRoute(
      "/__px/data/tables/invoices/rows?workspaceId=workspace_A&limit=50",
    );
    expect(rowsARes.status).toBe(200);
    const rowsABody = (await rowsARes.json()) as {
      rows: Array<Record<string, unknown>>;
      totalCount: number;
      compiledSql: string;
    };
    expect(rowsABody.totalCount).toBe(10);
    expect(rowsABody.rows).toHaveLength(10);
    expect(
      rowsABody.rows.every((r) => r.workspace_id === "workspace_A"),
    ).toBe(true);
    expect(
      rowsABody.rows.some((r) => r.workspace_id === "workspace_B"),
    ).toBe(false);
    expect(rowsABody.compiledSql).toContain('WHERE "workspace_id" = ?1');
    expect(rowsABody.compiledSql).not.toContain("secret_token");
    expect(rowsABody.compiledSql).not.toContain("password_hash");
    for (const row of rowsABody.rows) {
      expect(row).not.toHaveProperty("secret_token");
      expect(row).not.toHaveProperty("password_hash");
    }

    // Query workspace_A across brick table `webhooks`
    const whARes = await callDataRoute(
      "/__px/data/tables/webhooks/rows?workspaceId=workspace_A",
    );
    expect(whARes.status).toBe(200);
    const whABody = (await whARes.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(whABody.rows).toHaveLength(10);
    expect(whABody.rows.every((r) => r.workspace_id === "workspace_A")).toBe(
      true,
    );
    for (const row of whABody.rows) {
      expect(row).not.toHaveProperty("signing_secret");
    }

    // Adversarial filter 1: SQL injection attempt in filterVal (`' OR 1=1 --`)
    const advRes1 = await callDataRoute(
      `/__px/data/tables/invoices/rows?workspaceId=workspace_A&filterCol=status&filterOp=eq&filterVal=${encodeURIComponent("' OR 1=1 --")}`,
    );
    expect(advRes1.status).toBe(200);
    const advBody1 = (await advRes1.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(
      advBody1.rows.some((r) => r.workspace_id === "workspace_B"),
    ).toBe(false);
    expect(advBody1.rows).toHaveLength(0);

    // Adversarial filter 2: attempting to override workspace_id via filter parameter (`workspace_id != 'workspace_A'`)
    const advRes2 = await callDataRoute(
      `/__px/data/tables/invoices/rows?workspaceId=workspace_A&filterCol=${encodeURIComponent("workspace_id != 'workspace_A'")}&filterVal=workspace_B&filter=${encodeURIComponent("workspace_id != 'workspace_A'")}`,
    );
    expect(advRes2.status).toBe(200);
    const advBody2 = (await advRes2.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(advBody2.rows).toHaveLength(10);
    expect(
      advBody2.rows.every((r) => r.workspace_id === "workspace_A"),
    ).toBe(true);

    // Valid allowlisted filter + sort + pagination
    const filteredRes = await callDataRoute(
      "/__px/data/tables/invoices/rows?workspaceId=workspace_A&filterCol=amount&filterOp=gt&filterVal=500&sortCol=amount&sortDir=desc&limit=3&offset=0",
    );
    expect(filteredRes.status).toBe(200);
    const filteredBody = (await filteredRes.json()) as {
      rows: Array<{ id: string; amount: number; workspace_id: string }>;
      totalCount: number;
      hasMore: boolean;
      nextCursor: string | null;
    };
    expect(filteredBody.totalCount).toBe(5); // 600, 700, 800, 900, 1000
    expect(filteredBody.rows.map((r) => r.amount)).toEqual([1000, 900, 800]);
    expect(filteredBody.hasMore).toBe(true);
    expect(filteredBody.nextCursor).toBe("3");
  });

  it("enforces production read-only (403 PRODUCTION_DATA_WRITE_FORBIDDEN), brick/ledger read-only, cross-workspace write isolation (404), and confirmed preview entity writes (AC 2, AC 5)", async () => {
    // 1. Production environment rejects POST, PATCH, and DELETE with 403 PRODUCTION_DATA_WRITE_FORBIDDEN
    for (const method of ["POST", "PATCH", "DELETE"] as const) {
      const prodRes = await callDataRoute("/__px/data/tables/invoices/rows", {
        method,
        pxEnv: "production",
        body: {
          workspaceId: "workspace_A",
          rowId: "inv_A_01",
          confirmWrite: true,
          row: { invoice_number: "INV-PROD-HACK", amount: 999, status: "open" },
        },
      });
      expect(prodRes.status).toBe(403);
      const prodErr = (await prodRes.json()) as { error: { code: string } };
      expect(prodErr.error.code).toBe("PRODUCTION_DATA_WRITE_FORBIDDEN");
    }

    // 2. Preview rejects writes to brick tables (403 TABLE_READ_ONLY) and wallet ledger tables (403 LEDGER_IMMUTABLE_READ_ONLY)
    const brickWriteRes = await callDataRoute(
      "/__px/data/tables/webhooks/rows",
      {
        method: "POST",
        pxEnv: "preview",
        body: {
          workspaceId: "workspace_A",
          confirmWrite: true,
          row: { target_url: "https://evil.example.com", event_type: "all" },
        },
      },
    );
    expect(brickWriteRes.status).toBe(403);
    expect(
      ((await brickWriteRes.json()) as { error: { code: string } }).error.code,
    ).toBe("TABLE_READ_ONLY");

    const ledgerWriteRes = await callDataRoute(
      "/__px/data/tables/credit_ledger/rows",
      {
        method: "PATCH",
        pxEnv: "preview",
        body: {
          workspaceId: "workspace_A",
          rowId: "led_A_01",
          confirmWrite: true,
          patch: { balance_after: 999999 },
        },
      },
    );
    expect(ledgerWriteRes.status).toBe(403);
    expect(
      ((await ledgerWriteRes.json()) as { error: { code: string } }).error.code,
    ).toBe("LEDGER_IMMUTABLE_READ_ONLY");

    // 3. Preview entity write without confirmWrite: true fails with 422 CONFIRM_WRITE_REQUIRED
    const unconfirmedRes = await callDataRoute(
      "/__px/data/tables/invoices/rows",
      {
        method: "PATCH",
        pxEnv: "preview",
        body: {
          workspaceId: "workspace_A",
          rowId: "inv_A_01",
          confirmWrite: false,
          patch: { status: "paid" },
        },
      },
    );
    expect(unconfirmedRes.status).toBe(422);
    expect(
      ((await unconfirmedRes.json()) as { error: { code: string } }).error.code,
    ).toBe("CONFIRM_WRITE_REQUIRED");

    // 4. Cross-workspace write isolation: attempting to PATCH or DELETE workspace_B row while scoped to workspace_A returns 404 and modifies 0 rows
    const crossPatchRes = await callDataRoute(
      "/__px/data/tables/invoices/rows",
      {
        method: "PATCH",
        pxEnv: "preview",
        body: {
          workspaceId: "workspace_A",
          rowId: "inv_B_01",
          confirmWrite: true,
          patch: { amount: 0, status: "hacked" },
        },
      },
    );
    expect(crossPatchRes.status).toBe(404);

    const crossDeleteRes = await callDataRoute(
      "/__px/data/tables/invoices/rows",
      {
        method: "DELETE",
        pxEnv: "preview",
        body: {
          workspaceId: "workspace_A",
          rowId: "inv_B_01",
          confirmWrite: true,
        },
      },
    );
    expect(crossDeleteRes.status).toBe(404);

    // Verify inv_B_01 in workspace_B is completely untouched
    const verifyBRes = await callDataRoute(
      "/__px/data/tables/invoices/rows?workspaceId=workspace_B&filterCol=id&filterOp=eq&filterVal=inv_B_01",
    );
    const verifyBBody = (await verifyBRes.json()) as {
      rows: Array<{ id: string; amount: number; status: string }>;
    };
    expect(verifyBBody.rows).toHaveLength(1);
    expect(verifyBBody.rows[0]!.amount).toBe(250);
    expect(verifyBBody.rows[0]!.status).toBe("void");

    // 5. Confirmed insert, update, and delete on workspace_A in preview succeed and return beforeSnapshot / afterSnapshot
    const insertRes = await callDataRoute("/__px/data/tables/invoices/rows", {
      method: "POST",
      pxEnv: "preview",
      body: {
        workspaceId: "workspace_A",
        confirmWrite: true,
        row: {
          id: "inv_A_11",
          invoice_number: "INV-A-11",
          amount: 1100,
          status: "open",
        },
      },
    });
    expect(insertRes.status).toBe(201);
    const insertJson = (await insertRes.json()) as {
      rowId: string;
      beforeSnapshot: null;
      afterSnapshot: Record<string, unknown>;
    };
    expect(insertJson.rowId).toBe("inv_A_11");
    expect(insertJson.beforeSnapshot).toBeNull();
    expect(insertJson.afterSnapshot).toMatchObject({
      id: "inv_A_11",
      workspace_id: "workspace_A",
      invoice_number: "INV-A-11",
      amount: 1100,
      status: "open",
    });

    const updateRes = await callDataRoute("/__px/data/tables/invoices/rows", {
      method: "PATCH",
      pxEnv: "preview",
      body: {
        workspaceId: "workspace_A",
        rowId: "inv_A_11",
        confirmWrite: true,
        patch: {
          amount: 1250,
          status: "paid",
        },
      },
    });
    expect(updateRes.status).toBe(200);
    const updateJson = (await updateRes.json()) as {
      beforeSnapshot: Record<string, unknown>;
      afterSnapshot: Record<string, unknown>;
    };
    expect(updateJson.beforeSnapshot.amount).toBe(1100);
    expect(updateJson.afterSnapshot.amount).toBe(1250);
    expect(updateJson.afterSnapshot.status).toBe("paid");

    const deleteRes = await callDataRoute("/__px/data/tables/invoices/rows", {
      method: "DELETE",
      pxEnv: "preview",
      body: {
        workspaceId: "workspace_A",
        rowId: "inv_A_11",
        confirmWrite: true,
      },
    });
    expect(deleteRes.status).toBe(200);
    const deleteJson = (await deleteRes.json()) as {
      beforeSnapshot: Record<string, unknown>;
      afterSnapshot: null;
    };
    expect(deleteJson.beforeSnapshot.id).toBe("inv_A_11");
    expect(deleteJson.afterSnapshot).toBeNull();
  });
});
