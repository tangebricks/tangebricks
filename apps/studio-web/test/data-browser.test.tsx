// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signedDataBrowserRequest } from "../../studio-api/src/telemetry-reads.ts";
import { handleDataBrowserRequest } from "../../../packages/deploy/src/worker/data-browser.ts";

/** The data routes take only the control-plane signature (story 1.4); the harness signs as Studio does. */
const DATA_BROWSER_SECRET = "studio_web_data_browser_test_secret_0123456789";

/**
 * Requests the mocked Studio API is still answering. Signing and verifying each request is asynchronous, so the view's
 * catalog and row loads can finish in either order; the test waits for them to settle before it starts an edit (a load
 * that lands afterwards re-renders the rows and closes the inline editor).
 */
let inflight = 0;
function trackInflight<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    inflight += 1;
    try {
      return await fn(...args);
    } finally {
      inflight -= 1;
    }
  };
}
const settled = () =>
  waitFor(() => {
    expect(inflight).toBe(0);
  });
import { sqliteD1 } from "../../../test/support/sqlite-d1.ts";
import { EntitiesView } from "../src/components/EntitiesView.tsx";
import { useStudioStore } from "../src/store.ts";

describe("Story 6.1 — Studio Web Workspace-Scoped Data Browser (Data -> Data Browser)", () => {
  const originalFetch = globalThis.fetch;
  let world: ReturnType<typeof sqliteD1>;

  beforeEach(() => {
    window.sessionStorage.clear();
    world = sqliteD1();

    world.db.exec(`
      CREATE TABLE ent_invoices (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        invoice_number TEXT NOT NULL,
        amount INTEGER NOT NULL,
        status TEXT NOT NULL,
        secret_token TEXT,
        password_hash TEXT
      );

      CREATE TABLE webhooks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        target_url TEXT NOT NULL,
        event_type TEXT NOT NULL,
        signing_secret TEXT NOT NULL
      );

      CREATE TABLE px_connections (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        ciphertext TEXT NOT NULL
      );

      CREATE TABLE data_browser_audit_log (
        audit_id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        env_name TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        table_name TEXT NOT NULL,
        row_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        actor TEXT NOT NULL,
        before_snapshot TEXT,
        after_snapshot TEXT,
        created_at TEXT NOT NULL
      );
    `);

    const insertInv = world.db.prepare(
      `INSERT INTO ent_invoices (id, workspace_id, invoice_number, amount, status, secret_token, password_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertWh = world.db.prepare(
      `INSERT INTO webhooks (id, workspace_id, target_url, event_type, signing_secret)
       VALUES (?, ?, ?, ?, ?)`,
    );

    insertInv.run(
      "inv_A_01",
      "workspace_A",
      "INV-A-01",
      150,
      "open",
      "sec_A_1",
      "hash_A_1",
    );
    insertInv.run(
      "inv_A_02",
      "workspace_A",
      "INV-A-02",
      450,
      "paid",
      "sec_A_2",
      "hash_A_2",
    );
    insertInv.run(
      "inv_B_01",
      "workspace_B",
      "INV-B-01",
      900,
      "void",
      "sec_B_1",
      "hash_B_1",
    );

    insertWh.run(
      "wh_A_01",
      "workspace_A",
      "https://a.example.com/hook",
      "invoice.paid",
      "whsec_A",
    );
    insertWh.run(
      "wh_B_01",
      "workspace_B",
      "https://b.example.com/hook",
      "invoice.void",
      "whsec_B",
    );

    useStudioStore.setState({
      user: {
        id: "user_owner",
        name: "Ada Lovelace",
        email: "ada@example.com",
      },
      orgs: [
        {
          id: "org_default",
          slug: "default-org",
          name: "Default Org",
          role: "owner",
        },
      ],
      activeOrgId: "org_default",
      projects: [
        {
          project: "acme-billing",
          orgId: "org_default",
          revision: 1,
          semanticHash: "sem_r1",
          updatedAt: "2026-10-31T10:00:00Z",
        },
      ],
      activeProjectId: "acme-billing",
      currentRevision: 1,
      projectState: {
        project: "acme-billing",
        identity: "core-auth",
        bricks: [
          { id: "core-auth", config: {} },
          { id: "multi-workspace", config: {} },
          { id: "dynamic-entities", config: {} },
          { id: "outbound-webhooks", config: {} },
        ],
        entities: [
          {
            name: "invoices",
            workspaceScoped: true,
            fields: [
              { name: "invoice_number", type: "text", required: true },
              { name: "amount", type: "integer", required: true },
              {
                name: "status",
                type: "enum",
                required: true,
                values: ["open", "paid", "void"],
              },
            ],
          },
        ],
        workflows: [],
        secretRefs: [],
        metadata: {},
      },
      readiness: { ready: true, needs: [] },
      activeNav: "data",
      secrets: [],
    });

    globalThis.fetch = vi.fn(trackInflight(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const parsedUrl = new URL(rawUrl, "http://localhost");
        const m =
          /^\/api\/projects\/([^/]+)\/environments\/(preview|production)\/data\/(.*)$/.exec(
            parsedUrl.pathname,
          );
        if (m) {
          const projectId = decodeURIComponent(m[1]!);
          const envName = m[2] as "preview" | "production";
          const subPath = m[3]!;

          if (subPath === "audit-log") {
            const ws = parsedUrl.searchParams.get("workspaceId");
            const rows = world.db
              .prepare(
                `SELECT * FROM data_browser_audit_log WHERE project_id = ? AND env_name = ? ${ws ? "AND workspace_id = ?" : ""} ORDER BY created_at DESC`,
              )
              .all(
                ...(ws ? [projectId, envName, ws] : [projectId, envName]),
              ) as Array<Record<string, unknown>>;
            return new Response(
              JSON.stringify({
                ok: true,
                entries: rows.map((r) => ({
                  auditId: r.audit_id,
                  orgId: r.org_id,
                  projectId: r.project_id,
                  envName: r.env_name,
                  workspaceId: r.workspace_id,
                  tableName: r.table_name,
                  rowId: r.row_id,
                  operation: r.operation,
                  actor: r.actor,
                  beforeSnapshot: r.before_snapshot
                    ? JSON.parse(String(r.before_snapshot))
                    : null,
                  afterSnapshot: r.after_snapshot
                    ? JSON.parse(String(r.after_snapshot))
                    : null,
                  createdAt: r.created_at,
                })),
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }

          const method = init?.method ?? "GET";
          const bodyText =
            typeof init?.body === "string" ? init.body : undefined;
          // The request studio-api's data browser forwarder builds (workspace into the signed query, signed).
          const workerRes = await handleDataBrowserRequest(
            await signedDataBrowserRequest({
              method,
              workerPathAndQuery: `/__px/data/${subPath}${parsedUrl.search}`,
              ...(bodyText ? { rawBody: bodyText } : {}),
              signingSecret: DATA_BROWSER_SECRET,
            }),
            {
              db: world.d1,
              pxEnv: envName,
              declaredEntities: ["invoices"],
              telemetrySecret: DATA_BROWSER_SECRET,
            },
          );
          if (!workerRes) {
            return new Response(JSON.stringify({ error: "not found" }), {
              status: 404,
            });
          }
          if (
            (method === "POST" || method === "PATCH" || method === "DELETE") &&
            (workerRes.status === 200 || workerRes.status === 201)
          ) {
            const payload = (await workerRes.json()) as Record<string, unknown>;
            const auditId = `dba_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            world.db
              .prepare(
                `INSERT INTO data_browser_audit_log (audit_id, org_id, project_id, env_name, workspace_id, table_name, row_id, operation, actor, before_snapshot, after_snapshot, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                auditId,
                "org_default",
                projectId,
                envName,
                String(payload.workspaceId),
                String(payload.tableName),
                String(payload.rowId),
                String(payload.operation),
                "user_owner",
                payload.beforeSnapshot
                  ? JSON.stringify(payload.beforeSnapshot)
                  : null,
                payload.afterSnapshot
                  ? JSON.stringify(payload.afterSnapshot)
                  : null,
                new Date().toISOString(),
              );
            return new Response(JSON.stringify({ ...payload, auditId }), {
              status: workerRes.status,
              headers: { "content-type": "application/json" },
            });
          }
          return workerRes;
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    )) as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("switches to Data Browser sub-tab, isolates rows by workspace selector, hides secret columns, enforces read-only in production, and commits confirmed preview entity writes with audit log (AC 4, AC 5)", async () => {
    render(<EntitiesView />);

    // Switch from Schema Designer to Data Browser sub-tab
    fireEvent.click(screen.getByTestId("data-subtab-browser"));

    await waitFor(() => {
      expect(screen.getByTestId("data-browser-view")).toBeDefined();
      expect(screen.getByTestId("data-browser-row-inv_A_01")).toBeDefined();
    });
    await settled();

    // Verify workspace_A rows are shown and workspace_B rows are absent
    expect(screen.getByTestId("data-browser-row-inv_A_01")).toBeDefined();
    expect(screen.getByTestId("data-browser-row-inv_A_02")).toBeDefined();
    expect(screen.queryByTestId("data-browser-row-inv_B_01")).toBeNull();

    // Verify secret columns & tables are absent
    expect(screen.queryByTestId("data-browser-table-px_connections")).toBeNull();
    expect(screen.queryByTestId("data-browser-sort-secret_token")).toBeNull();
    expect(screen.queryByTestId("data-browser-sort-password_hash")).toBeNull();

    // Switch workspace selector to workspace_B -> only workspace_B row appears
    fireEvent.change(screen.getByTestId("data-browser-workspace-select"), {
      target: { value: "workspace_B" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("data-browser-row-inv_B_01")).toBeDefined();
    });
    expect(screen.queryByTestId("data-browser-row-inv_A_01")).toBeNull();

    // Switch back to workspace_A
    fireEvent.change(screen.getByTestId("data-browser-workspace-select"), {
      target: { value: "workspace_A" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("data-browser-row-inv_A_01")).toBeDefined();
    });

    // Switch environment to production -> Read-only badge appears and Add/Edit/Delete controls disappear
    fireEvent.click(screen.getByTestId("data-browser-env-production"));
    await waitFor(() => {
      expect(screen.getByTestId("data-browser-readonly-badge")).toBeDefined();
      expect(screen.queryByTestId("data-browser-add-row-button")).toBeNull();
      expect(screen.queryByTestId("data-browser-edit-row-inv_A_01")).toBeNull();
    });

    // Switch back to preview -> Preview badge appears and Add/Edit/Delete controls are enabled on dynamic entity
    fireEvent.click(screen.getByTestId("data-browser-env-preview"));
    await screen.findByTestId("data-browser-preview-badge");
    await settled();

    // Inline edit inv_A_01 in preview with Confirmation Dialog
    await waitFor(async () => {
      const editBtn = await screen.findByTestId("data-browser-edit-row-inv_A_01");
      fireEvent.click(editBtn);
      expect(screen.getByTestId("data-browser-inline-input-amount")).toBeDefined();
    });

    const amountInput = screen.getByTestId(
      "data-browser-inline-input-amount",
    ) as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "275" } });
    const saveBtn = await screen.findByTestId("data-browser-save-edit-inv_A_01");
    fireEvent.click(saveBtn);

    // Confirmation dialog opens
    const confirmModal = await screen.findByTestId("data-browser-confirm-modal");
    expect(confirmModal).toBeDefined();
    const submitBtn = await screen.findByTestId("data-browser-confirm-submit");
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.queryByTestId("data-browser-confirm-modal")).toBeNull();
      expect(
        screen.getByTestId("data-browser-cell-inv_A_01-amount").textContent,
      ).toBe("275");
    });

    // Audit log panel shows the recorded update mutation
    await waitFor(() => {
      expect(
        screen.getByTestId("data-browser-audit-panel").textContent,
      ).toContain("update");
      expect(
        screen.getByTestId("data-browser-audit-panel").textContent,
      ).toContain("invoices/inv_A_01");
    });
  });
});
