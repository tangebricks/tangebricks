import { expect, test } from "@playwright/test";

test.describe("Visual Entity Designer with SQL migration, route, and workspace_id isolation preview (Real Backend)", () => {
  test("turns on dynamic-entities from banner, rejects reserved route prefixes, creates invoices entity with 4 typed fields, previews SQL DDL / CRUD routes / workspace_id isolation, persists across F5 reload, and guards destructive field removal", async ({
    page,
  }) => {
    await page.goto("/");

    // Sign in as owner against real Better Auth + STUDIO_DB
    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();

    // Create a dedicated empty project for Entity Designer E2E
    await page.getByTestId("new-project-button").click();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r0");
    const createdProjectSlug = await page.getByTestId("project-selector").inputValue();
    expect(createdProjectSlug).toMatch(/^project-\d+$/);

    // Navigate to Data (Entities) view
    await page.getByTestId("nav-tab-data").click();
    await expect(page.getByTestId("view-data")).toBeVisible();

    // 1. Verify missing entity handler banner and one-click "Turn on dynamic-entities"
    await expect(page.getByTestId("entity-missing-handler-banner")).toBeVisible();
    await page.getByTestId("turn-on-dynamic-entities-button").click();
    await expect(page.getByTestId("entity-missing-handler-banner")).toHaveCount(0);
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r1");

    // 2. Click + New Entity and verify reserved brick route prefix rejection ("wallet")
    await page.getByTestId("new-entity-button").click();
    const entityNameInput = page.getByTestId("entity-name-input");
    await entityNameInput.fill("wallet");
    await expect(page.getByTestId("entity-name-error")).toContainText(
      "collides with a reserved brick route prefix (/api/wallet)",
    );
    await expect(page.getByTestId("save-entity-button")).toBeDisabled();

    // 3. Enter valid entity name "invoices" and configure 4 fields:
    //    amount: number, status: enum(draft|paid|void), customer_email: string, paid_at: datetime
    await entityNameInput.fill("invoices");
    await expect(page.getByTestId("entity-name-error")).toHaveCount(0);

    // Field 0: amount (number, required)
    await page.getByTestId("field-name-input-0").fill("amount");
    await page.getByTestId("field-type-select-0").selectOption("number");

    // Field 1: status (enum: draft, paid, void, required)
    await page.getByTestId("add-field-button").click();
    await page.getByTestId("field-name-input-1").fill("status");
    await page.getByTestId("field-type-select-1").selectOption("enum");
    await page.getByTestId("field-enum-values-input-1").fill("draft, paid, void");
    await page.getByTestId("field-required-toggle-1").check();

    // Field 2: customer_email (string, required, unique, indexed)
    await page.getByTestId("add-field-button").click();
    await page.getByTestId("field-name-input-2").fill("customer_email");
    await page.getByTestId("field-type-select-2").selectOption("string");
    await page.getByTestId("field-required-toggle-2").check();
    await page.getByTestId("field-unique-toggle-2").check();
    await page.getByTestId("field-indexed-toggle-2").check();

    // Field 3: paid_at (datetime, optional)
    await page.getByTestId("add-field-button").click();
    await page.getByTestId("field-name-input-3").fill("paid_at");
    await page.getByTestId("field-type-select-3").selectOption("datetime");

    // 4. Assert computed styles on the Entity Designer table, field rows, and SQL DDL preview
    const designerStyles = await page.evaluate(() => {
      const table = document.querySelector('[data-testid="entity-fields-table"]');
      const row = document.querySelector('[data-testid="entity-field-row-amount"]');
      const ddl = document.querySelector('[data-testid="entity-sql-ddl-code"]');
      if (!table || !row || !ddl) return null;
      return {
        tableDisplay: window.getComputedStyle(table).display,
        tableWidth: table.getBoundingClientRect().width,
        rowDisplay: window.getComputedStyle(row).display,
        ddlFontFamily: window.getComputedStyle(ddl).fontFamily,
      };
    });
    expect(designerStyles).not.toBeNull();
    expect(designerStyles!.tableDisplay).toBe("table");
    expect(designerStyles!.tableWidth).toBeGreaterThan(400);
    expect(designerStyles!.rowDisplay).toBe("table-row");
    expect(designerStyles!.ddlFontFamily.toLowerCase()).toContain("mono");

    // 5. Verify live SQLite DDL, REST CRUD routes, and workspace_id isolation previews before commit
    const ddlCode = page.getByTestId("entity-sql-ddl-code");
    await expect(ddlCode).toContainText('CREATE TABLE IF NOT EXISTS "ent_invoices"');
    await expect(ddlCode).toContainText('"workspace_id" TEXT NOT NULL');
    await expect(ddlCode).toContainText(
      `"status" TEXT NOT NULL CHECK ("status" IN ('draft', 'paid', 'void'))`,
    );
    await expect(ddlCode).toContainText('UNIQUE("workspace_id", "customer_email")');
    await expect(ddlCode).toContainText(
      'CREATE INDEX IF NOT EXISTS "idx_ent_invoices_workspace_customer_email" ON "ent_invoices"("workspace_id", "customer_email")',
    );

    await expect(page.getByTestId("entity-crud-routes-preview")).toContainText(
      "POST /api/entities/invoices",
    );
    await expect(page.getByTestId("entity-isolation-sql-code")).toContainText(
      'WHERE "workspace_id" = :ctx.workspaceId',
    );

    // 6. Save entity -> persists add_entity to BlueprintDO
    await expect(page.getByTestId("save-entity-button")).toBeEnabled();
    await page.getByTestId("save-entity-button").click();
    await expect(page.getByTestId("entity-saved-badge")).toBeVisible();
    await expect(page.getByTestId("entity-list-item-invoices")).toBeVisible();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r2");

    // 7. Reload page (F5) and verify invoices entity and all 4 fields persist from BlueprintDO
    await page.reload();
    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await expect(page.getByTestId("project-selector")).toHaveValue(createdProjectSlug);

    await page.getByTestId("nav-tab-data").click();
    await expect(page.getByTestId("entity-list-item-invoices")).toBeVisible();
    await expect(page.getByTestId("field-name-input-0")).toHaveValue("amount");
    await expect(page.getByTestId("field-name-input-1")).toHaveValue("status");
    await expect(page.getByTestId("field-name-input-2")).toHaveValue("customer_email");
    await expect(page.getByTestId("field-name-input-3")).toHaveValue("paid_at");

    // 8. Drop paid_at field -> verify live ALTER TABLE DROP COLUMN preview and Destructive Migration Confirmation modal
    await page.getByTestId("field-remove-button-3").click();
    await expect(page.getByTestId("entity-sql-ddl-code")).toContainText(
      'ALTER TABLE "ent_invoices" DROP COLUMN "paid_at";',
    );

    await page.getByTestId("save-entity-button").click();
    const destructiveModal = page.getByTestId("destructive-entity-modal");
    await expect(destructiveModal).toBeVisible();
    await expect(page.getByTestId("destructive-entity-reasons")).toContainText(
      'Drops column "paid_at"',
    );

    await page.getByTestId("destructive-entity-confirm").click();
    await expect(destructiveModal).toHaveCount(0);
    await expect(page.getByTestId("entity-saved-badge")).toBeVisible();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r3");
  });
});
