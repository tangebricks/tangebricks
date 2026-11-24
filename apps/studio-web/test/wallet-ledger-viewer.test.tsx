import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { D1Like, D1Result, D1Statement } from "@poc/sdk";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDataBrowserRequest } from "../../../packages/deploy/src/worker/data-browser.ts";
import { EntitiesView } from "../src/components/EntitiesView.tsx";
import { useStudioStore } from "../src/store.ts";
import { DEFAULT_CATALOG } from "../src/types.ts";

function createTestD1(sqlite: DatabaseSync): D1Like {
  const inside = new WeakMap<object, { sql: string; params: SQLInputValue[] }>();
  const execute = ({ sql, params }: { sql: string; params: SQLInputValue[] }): D1Result => {
    const prepared = sqlite.prepare(sql);
    if (/^\s*(pragma|select|explain)\b/i.test(sql) || /\breturning\b/i.test(sql)) {
      const rows = prepared.all(...params).map((r) => ({ ...r }));
      return { results: rows, success: true, meta: { changes: 0 } };
    }
    const res = prepared.run(...params);
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(res.changes),
        last_row_id: Number(res.lastInsertRowid ?? 0),
      } as D1Result["meta"],
    };
  };
  const statement = (sql: string, params: SQLInputValue[] = []): D1Statement => {
    const stmt: D1Statement = {
      bind: (...values) => statement(sql, values as SQLInputValue[]),
      async first<Row>() {
        const row = sqlite.prepare(sql).get(...params);
        return row ? ({ ...row } as Row) : null;
      },
      async run() {
        return execute({ sql, params });
      },
      async all<Row>() {
        const rows = sqlite.prepare(sql).all(...params).map((r) => ({ ...r }) as Row);
        return { results: rows, success: true, meta: { changes: 0 } };
      },
    };
    inside.set(stmt, { sql, params });
    return stmt;
  };
  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      return statements.map((s) => execute(inside.get(s)!));
    },
    async exec(sql) {
      sqlite.exec(sql);
    },
  };
}

describe("Story 6.2 — Studio Web Read-Only Credit Wallet & Usage Ledger Viewer", () => {
  let sqlite: DatabaseSync;
  let d1: D1Like;

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    sqlite = new DatabaseSync(":memory:");
    d1 = createTestD1(sqlite);

    sqlite.exec(`
      CREATE TABLE credit_wallets (
        workspace_id TEXT PRIMARY KEY,
        balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
        created_at TEXT NOT NULL
      );
      CREATE TABLE credit_ledger (
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
      );
      CREATE TABLE usage_rollups (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        metric_key TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        total_quantity INTEGER NOT NULL
      );
    `);

    sqlite
      .prepare("INSERT INTO credit_wallets (workspace_id, balance, created_at) VALUES (?, ?, ?)")
      .run("workspace_A", 650, "2026-04-19T10:00:00Z");
    sqlite
      .prepare("INSERT INTO credit_wallets (workspace_id, balance, created_at) VALUES (?, ?, ?)")
      .run("workspace_B", 3000, "2026-04-19T11:00:00Z");

    sqlite
      .prepare(
        "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason, metadata, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "led_a_1",
        "workspace_A",
        "alice",
        "topup",
        1000,
        1000,
        "Initial credit grant",
        JSON.stringify({ orderId: "ord_a_1" }),
        "idem_a_1",
        "2026-04-19T10:01:00Z",
      );

    sqlite
      .prepare(
        "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason, metadata, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "led_a_2",
        "workspace_A",
        "alice",
        "deduction",
        -350,
        650,
        "Invoice Billing Flow execution",
        JSON.stringify({ runId: "run_inv_01", nodeId: "node-pick" }),
        "idem_a_2",
        "2026-04-19T10:05:00Z",
      );

    sqlite
      .prepare(
        "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason, metadata, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "led_b_1",
        "workspace_B",
        "bob",
        "topup",
        3000,
        3000,
        "Workspace B credit grant",
        JSON.stringify({ orderId: "ord_b_1" }),
        "idem_b_1",
        "2026-04-19T11:01:00Z",
      );

    sqlite
      .prepare(
        "INSERT INTO usage_rollups (id, workspace_id, metric_key, period_start, period_end, total_quantity) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("ur_a_1", "workspace_A", "workflow_executions", "2026-04-01", "2026-04-30", 18);

    useStudioStore.getState().resetStore({
      user: { id: "u_alice", email: "alice@example.com", name: "Alice" },
      orgs: [{ id: "org_acme", name: "Acme", slug: "acme", role: "owner" }],
      activeOrgId: "org_acme",
      activeProjectId: "acme-saas",
      currentRevision: 2,
      catalog: DEFAULT_CATALOG,
      projectState: {
        project: "acme-saas",
        identity: "core-auth",
        bricks: [
          { id: "multi-workspace", config: {} },
          { id: "credit-wallet", config: { creditsPerUnit: 10, minOrderAmount: 100 } },
          { id: "dynamic-entities", config: {} },
        ],
        entities: [
          {
            name: "invoices",
            workspaceScoped: true,
            fields: [
              { name: "title", type: "text", required: true, maxLength: 160 },
              { name: "amount_cents", type: "number", required: true, min: 0 },
            ],
          },
        ],
        workflows: [
          {
            id: "wf-billing",
            name: "Invoice Billing Flow",
            nodes: [
              { id: "node-trigger", type: "trigger.manual", label: "Manual Trigger", data: {} },
              {
                id: "node-pick",
                type: "transform.pick",
                label: "Pick Invoice Title",
                data: { path: "title" },
              },
            ],
            edges: [
              {
                id: "edge-1",
                source: "node-trigger",
                target: "node-pick",
                sourceHandle: "out",
                targetHandle: "in",
              },
            ],
          },
        ],
        secretRefs: [],
        metadata: {},
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl = typeof input === "string" ? input : input.toString();
        const url = new URL(rawUrl, "http://localhost");
        const method = init?.method ?? "GET";

        if (url.pathname.includes("/runs/run_inv_01")) {
          return new Response(
            JSON.stringify({
              run: {
                runId: "run_inv_01",
                workflowId: "wf-billing",
                revision: 2,
                triggerType: "manual",
                workspaceId: "workspace_A",
                status: "succeeded",
                durationMs: 38,
                retries: 0,
                startedAt: "2026-04-19T10:05:00Z",
                endedAt: "2026-04-19T10:05:01Z",
                failedNodeId: null,
                stepCount: 2,
              },
              stepEvents: [
                {
                  runId: "run_inv_01",
                  workflowId: "wf-billing",
                  revision: 2,
                  nodeId: "node-pick",
                  status: "succeeded",
                  durationMs: 19,
                  retries: 0,
                  inputPreview: '{"title":"INV-A-1"}',
                  outputPreview: '{"title":"INV-A-1"}',
                  errorStack: null,
                  createdAt: "2026-04-19T10:05:00Z",
                },
              ],
              currentRevision: 2,
              historicalRevision: 2,
              isHistoricalRevision: false,
              historicalState: useStudioStore.getState().projectState,
              historicalWorkflow: useStudioStore.getState().projectState?.workflows[0] ?? null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        const envMatch =
          /^\/api\/projects\/[^/]+\/environments\/(preview|production)\/(?:data\/)?(workspaces|tables|ledger.*)$/.exec(
            url.pathname,
          );
        if (envMatch) {
          const envName = envMatch[1] as "preview" | "production";
          const restPath = envMatch[2]!;
          const workerUrl = `http://worker.internal/__px/data/${restPath}${url.search}`;
          const workerReq = new Request(workerUrl, {
            method,
            headers: init?.headers,
            body: init?.body,
          });
          const workerRes = await handleDataBrowserRequest(workerReq, {
            db: d1,
            pxEnv: envName,
            declaredEntities: ["invoices"],
            skipSignatureVerification: true,
          });
          if (workerRes) return workerRes;
        }
        return new Response("Not Found", { status: 404 });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    sqlite.close();
  });

  it("renders Wallet & Usage Ledger tab, isolates workspace_A balance and journal entries from workspace_B, shows permanent Immutable Ledger badge with zero write controls, and jumps to CP4 Run Replay on clicking Run / Node correlation link (AC 4, AC 5)", async () => {
    render(<EntitiesView />);

    const ledgerTab = screen.getByTestId("data-subtab-ledger");
    fireEvent.click(ledgerTab);

    await waitFor(() => {
      expect(screen.getByTestId("wallet-ledger-view")).toBeTruthy();
      expect(screen.getByTestId("ledger-entry-row-led_a_2")).toBeTruthy();
    });

    expect(screen.getByTestId("ledger-immutable-badge").textContent).toContain(
      "Immutable Ledger (Read-only)",
    );
    expect(screen.getByTestId("ledger-current-balance-value").textContent).toContain(
      "650",
    );
    expect(screen.getByTestId("ledger-net-change-30d-value").textContent).toContain(
      "+650",
    );
    expect(
      screen.getByTestId("ledger-usage-metric-workflow_executions").textContent,
    ).toContain("18");

    // Verify positive delta (+1000) and negative delta (-350) formatting and workspace_B isolation
    expect(screen.getByTestId("ledger-entry-delta-led_a_1").textContent).toBe("+1000");
    expect(screen.getByTestId("ledger-entry-delta-led_a_2").textContent).toBe("-350");
    expect(screen.queryByTestId("ledger-entry-row-led_b_1")).toBeNull();

    // Switch workspace selector to workspace_B -> shows 3000 balance and led_b_1
    const wsSelect = screen.getByTestId(
      "ledger-workspace-select",
    ) as HTMLSelectElement;
    fireEvent.change(wsSelect, { target: { value: "workspace_B" } });

    await waitFor(() => {
      expect(screen.getByTestId("ledger-entry-row-led_b_1")).toBeTruthy();
    });
    expect(screen.queryByTestId("ledger-entry-row-led_a_1")).toBeNull();
    expect(screen.getByTestId("ledger-current-balance-value").textContent).toContain(
      "3000",
    );

    // Switch back to workspace_A and click Run / Node correlation link on led_a_2
    fireEvent.change(wsSelect, { target: { value: "workspace_A" } });
    await waitFor(() => {
      expect(screen.getByTestId("ledger-jump-run-led_a_2")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("ledger-jump-run-led_a_2"));

    await waitFor(() => {
      const st = useStudioStore.getState();
      expect(st.activeNav).toBe("workflows");
      expect(st.activeReplayRun?.run.runId).toBe("run_inv_01");
      expect(st.selection).toEqual({
        kind: "node",
        id: "node-pick",
        workflowId: "wf-billing",
      });
    });
  });
});
