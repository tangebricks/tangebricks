import { expect, test } from "@playwright/test";

test.describe("Workspace-Scoped Data Browser & Read-Only Production Guardrails (Real Backend)", () => {
  test("enforces workspace_A vs workspace_B row isolation across 20 seeded rows, hides system tables, blocks ledger/production writes, shows the no-data-store state in production, and persists confirmed preview entity edits + audit log across F5 reload", async ({
    page,
  }) => {
    await page.goto("/");

    // 1. Sign in as Alice (Owner) against real Better Auth + STUDIO_DB
    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await expect(page.getByTestId("project-selector")).toHaveValue("acme-saas");

    // 2. Story 17: the project's data lives in its own data store, the active preview sandbox D1 (never STUDIO_DB).
    // Deploy a preview sandbox, then seed 10 rows in workspace_A and 10 in workspace_B into the blueprint's invoices
    // entity table (real columns only; the seed refuses raw DDL and non-entity tables).
    const sandboxDeployRes = await page.request.post("/api/projects/acme-saas/sandbox/deploy", { data: {} });
    expect(sandboxDeployRes.status()).toBe(200);

    const workspaceAInvoices = Array.from({ length: 10 }, (_, idx) => {
      const n = idx + 1;
      return {
        id: `inv_a_${n}`,
        workspace_id: "workspace_A",
        title: `INV-A-${n}`,
        amount_cents: n * 100,
        created_at: `2026-04-19T10:${String(n).padStart(2, "0")}:00Z`,
      };
    });
    const workspaceBInvoices = Array.from({ length: 10 }, (_, idx) => {
      const n = idx + 1;
      return {
        id: `inv_b_${n}`,
        workspace_id: "workspace_B",
        title: `INV-B-${n}`,
        amount_cents: n * 1000,
        created_at: `2026-04-19T11:${String(n).padStart(2, "0")}:00Z`,
      };
    });

    const seedRes = await page.request.post("/api/projects/acme-saas/environments/preview/data/seed", {
      data: {
        tables: {
          ent_invoices: [...workspaceAInvoices, ...workspaceBInvoices],
        },
      },
    });
    expect(seedRes.status()).toBe(200);

    // 3. Navigate to Data -> Data Browser sub-tab
    await page.getByTestId("nav-tab-data").click();
    await expect(page.getByTestId("view-data")).toBeVisible();
    await page.getByTestId("data-subtab-browser").click();
    await expect(page.getByTestId("data-browser-view")).toBeVisible();

    // 4. Verify non-trivial computed styles on Data Browser view, workspace select, and grid table
    await expect(page.getByTestId("data-browser-grid")).toBeVisible();
    const browserStyles = await page.evaluate(() => {
      const view = document.querySelector('[data-testid="data-browser-view"]');
      const wsSelect = document.querySelector('[data-testid="data-browser-workspace-select"]');
      const grid = document.querySelector('[data-testid="data-browser-grid"]');
      const badge = document.querySelector('[data-testid="data-browser-preview-badge"]');
      if (!view || !wsSelect || !grid || !badge) return null;
      return {
        viewDisplay: window.getComputedStyle(view).display,
        viewWidth: view.getBoundingClientRect().width,
        gridDisplay: window.getComputedStyle(grid).display,
        wsSelectBg: window.getComputedStyle(wsSelect).backgroundColor,
        badgeBg: window.getComputedStyle(badge).backgroundColor,
      };
    });
    expect(browserStyles).not.toBeNull();
    expect(browserStyles!.viewWidth).toBeGreaterThan(600);
    expect(browserStyles!.gridDisplay).toBe("table");
    expect(browserStyles!.wsSelectBg).not.toBe("rgba(0, 0, 0, 0)");
    expect(browserStyles!.badgeBg).not.toBe("rgba(0, 0, 0, 0)");

    // 5. Verify workspace_A is selected and strictly isolates workspace_A's 10 invoice rows
    const wsSelect = page.getByTestId("data-browser-workspace-select");
    await expect(wsSelect).toHaveValue("workspace_A");

    await expect(page.getByTestId("data-browser-table-invoices")).toBeVisible();
    await expect(page.getByTestId("data-browser-table-px_connections")).toHaveCount(0);

    await page.getByTestId("data-browser-table-invoices").click();
    await expect(page.getByTestId("data-browser-row-inv_a_1")).toBeVisible();
    await expect(page.getByTestId("data-browser-row-inv_a_10")).toBeVisible();
    await expect(page.getByTestId("data-browser-row-inv_b_1")).toHaveCount(0);

    // 6. Switch Workspace selector to workspace_B -> only workspace_B's 10 rows are visible
    await wsSelect.selectOption("workspace_B");
    await expect(page.getByTestId("data-browser-row-inv_b_1")).toBeVisible();
    await expect(page.getByTestId("data-browser-row-inv_b_10")).toBeVisible();
    await expect(page.getByTestId("data-browser-row-inv_a_1")).toHaveCount(0);

    // Switch back to workspace_A and test filter (gt 800 -> only inv_a_9 and inv_a_10)
    await wsSelect.selectOption("workspace_A");
    await expect(page.getByTestId("data-browser-row-inv_a_1")).toBeVisible();
    await page.getByTestId("data-browser-filter-column").selectOption("amount_cents");
    await page.getByTestId("data-browser-filter-op").selectOption("gt");
    await page.getByTestId("data-browser-filter-value").fill("800");
    await page.getByTestId("data-browser-filter-apply").click();

    await expect(page.getByTestId("data-browser-row-inv_a_9")).toBeVisible();
    await expect(page.getByTestId("data-browser-row-inv_a_10")).toBeVisible();
    await expect(page.getByTestId("data-browser-row-inv_a_1")).toHaveCount(0);

    await page.getByTestId("data-browser-filter-clear").click();
    await expect(page.getByTestId("data-browser-row-inv_a_1")).toBeVisible();

    // 7. Ledger tables are immutable in the API whatever the data store holds
    const ledgerWriteRes = await page.request.post("/api/projects/acme-saas/environments/preview/data/tables/wallet_ledger/rows?workspaceId=workspace_A", {
      data: {
        workspaceId: "workspace_A",
        confirmWrite: true,
        row: {
          id: "led_illegal",
          entry_type: "grant",
          delta_credits: 999999,
          balance_after: 999999,
          reason: "Tamper",
        },
      },
    });
    expect(ledgerWriteRes.status()).toBe(403);
    const ledgerWriteJson = (await ledgerWriteRes.json()) as { error: { code: string } };
    expect(ledgerWriteJson.error.code).toBe("LEDGER_IMMUTABLE_READ_ONLY");

    // 8. Switch to production -> "Read-only in production" badge; Studio cannot reach production data (story 17), so
    // the browser shows the no-data-store state instead of rows; writes are still refused with 403
    await page.getByTestId("data-browser-table-invoices").click();
    await page.getByTestId("data-browser-env-production").click();
    await expect(page.getByTestId("data-browser-readonly-badge")).toContainText("Read-only in production");
    await expect(page.getByTestId("data-browser-no-data-store")).toBeVisible();
    await expect(page.getByTestId("data-browser-error-alert")).toHaveCount(0);
    await expect(page.getByTestId("data-browser-add-row-button")).toHaveCount(0);
    await expect(page.getByTestId("data-browser-edit-row-inv_a_1")).toHaveCount(0);

    const prodWriteRes = await page.request.post("/api/projects/acme-saas/environments/production/data/tables/ent_invoices/rows?workspaceId=workspace_A", {
      data: {
        workspaceId: "workspace_A",
        confirmWrite: true,
        row: {
          id: "inv_prod_blocked",
          title: "Blocked Prod Write",
          amount_cents: 500,
          created_at: "2026-04-19T12:00:00Z",
        },
      },
    });
    expect(prodWriteRes.status()).toBe(403);
    const prodWriteJson = (await prodWriteRes.json()) as { error: { code: string } };
    expect(prodWriteJson.error.code).toBe("PRODUCTION_DATA_WRITE_FORBIDDEN");

    // 9. Switch back to preview -> edit dynamic entity row inv_a_1 with confirmation modal -> verify audit log & F5 reload persistence
    await page.getByTestId("data-browser-env-preview").click();
    await expect(page.getByTestId("data-browser-preview-badge")).toBeVisible();
    await expect(page.getByTestId("data-browser-no-data-store")).toHaveCount(0);
    await page.getByTestId("data-browser-table-invoices").click();
    await expect(page.getByTestId("data-browser-row-inv_a_1")).toBeVisible();

    await page.getByTestId("data-browser-edit-row-inv_a_1").click();
    await page.getByTestId("data-browser-inline-input-title").fill("Invoice A-1 Updated E2E");
    await page.getByTestId("data-browser-inline-input-amount_cents").fill("2500");
    await page.getByTestId("data-browser-save-edit-inv_a_1").click();

    await expect(page.getByTestId("data-browser-confirm-modal")).toBeVisible();
    await page.getByTestId("data-browser-confirm-submit").click();

    await expect(page.getByTestId("data-browser-confirm-modal")).toHaveCount(0);
    await expect(page.getByTestId("data-browser-row-inv_a_1")).toContainText("Invoice A-1 Updated E2E");
    await expect(page.getByTestId("data-browser-row-inv_a_1")).toContainText("2500");
    await expect(page.getByTestId("data-browser-audit-panel")).toContainText("update");
    await expect(page.getByTestId("data-browser-audit-panel")).toContainText("inv_a_1");

    // 10. Reload page (F5) and confirm updated row and audit log persist from real D1
    await page.reload();
    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await page.getByTestId("nav-tab-data").click();
    await page.getByTestId("data-subtab-browser").click();
    await expect(page.getByTestId("data-browser-view")).toBeVisible();

    await page.getByTestId("data-browser-table-invoices").click();
    await expect(page.getByTestId("data-browser-row-inv_a_1")).toContainText("Invoice A-1 Updated E2E");
    await expect(page.getByTestId("data-browser-audit-panel")).toContainText("update");
    await expect(page.getByTestId("data-browser-audit-panel")).toContainText("inv_a_1");
  });

  test("Story 6.2: renders Read-Only Credit Wallet & Usage Ledger viewer from the preview sandbox, shows the no-data-store state in production, enforces LEDGER_IMMUTABLE_READ_ONLY in preview & production, and persists across F5 reload", async ({
    page,
  }) => {
    await page.goto("/");

    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();

    // 1. Story 17: the ledger reads the project's own data store, the active preview sandbox D1 (never STUDIO_DB)
    const sandboxDeployRes = await page.request.post("/api/projects/acme-saas/sandbox/deploy", { data: {} });
    expect(sandboxDeployRes.status()).toBe(200);

    // 2. Navigate to Data -> Wallet & Usage Ledger tab
    await page.getByTestId("nav-tab-data").click();
    await expect(page.getByTestId("view-data")).toBeVisible();
    await page.getByTestId("data-subtab-ledger").click();
    await expect(page.getByTestId("wallet-ledger-view")).toBeVisible();

    // 3. The preview sandbox's credit-wallet tables are empty: the immutable ledger renders with a zero balance
    await expect(page.getByTestId("ledger-immutable-badge")).toContainText("Immutable Ledger (Read-only)");
    await expect(page.getByTestId("ledger-current-balance-value")).toContainText("0");
    await expect(page.getByTestId("ledger-no-data-store")).toHaveCount(0);
    await expect(page.getByTestId("ledger-error-alert")).toHaveCount(0);
    const ledgerStyles = await page.evaluate(() => {
      const view = document.querySelector('[data-testid="wallet-ledger-view"]');
      const badge = document.querySelector('[data-testid="ledger-immutable-badge"]');
      const balanceCard = document.querySelector('[data-testid="ledger-current-balance"]');
      if (!view || !badge || !balanceCard) return null;
      return {
        viewDisplay: window.getComputedStyle(view).display,
        viewWidth: view.getBoundingClientRect().width,
        badgeBg: window.getComputedStyle(badge).backgroundColor,
        balanceBg: window.getComputedStyle(balanceCard).backgroundColor,
      };
    });
    expect(ledgerStyles).not.toBeNull();
    expect(ledgerStyles!.viewDisplay).toBe("flex");
    expect(ledgerStyles!.viewWidth).toBeGreaterThan(600);
    expect(ledgerStyles!.badgeBg).not.toBe("rgba(0, 0, 0, 0)");
    expect(ledgerStyles!.balanceBg).not.toBe("rgba(0, 0, 0, 0)");

    // 4. Production has no data store Studio can reach: the API answers 503 NOT_CONFIGURED
    const prodLedgerRes = await page.request.get("/api/projects/acme-saas/environments/production/ledger?workspaceId=workspace_A");
    expect(prodLedgerRes.status()).toBe(503);
    const prodLedgerBody = (await prodLedgerRes.json()) as { error: { code: string } };
    expect(prodLedgerBody.error.code).toBe("NOT_CONFIGURED");

    // 5. Verify LEDGER_IMMUTABLE_READ_ONLY on direct write attempts in both preview and production
    for (const envName of ["preview", "production"] as const) {
      const ledgerWrite = await page.request.post(`/api/projects/acme-saas/environments/${envName}/ledger?workspaceId=workspace_A`, {
        data: { workspaceId: "workspace_A", confirmWrite: true, balance: 999999 },
      });
      expect(ledgerWrite.status()).toBe(403);
      const ledgerWriteBody = (await ledgerWrite.json()) as { error: { code: string } };
      expect(ledgerWriteBody.error.code).toBe("LEDGER_IMMUTABLE_READ_ONLY");
    }

    // 6. Reload page (F5) and verify the Wallet & Usage Ledger tab persists
    await page.reload();
    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await page.getByTestId("nav-tab-data").click();
    await expect(page.getByTestId("wallet-ledger-view")).toBeVisible();
    await expect(page.getByTestId("ledger-immutable-badge")).toBeVisible();
  });
});
