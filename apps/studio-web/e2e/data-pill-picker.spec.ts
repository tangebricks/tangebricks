import { expect, test } from "@playwright/test";

test.describe("Structured Data-Pill Picker ({{steps.nodeId.output.field}}) and dynamic data-driven ports (Real Backend)", () => {
  test("builds 'When invoice created -> if status == paid -> format & send email to customer_email' with zero typed '{{' expressions and persists across F5 reload", async ({
    page,
  }) => {
    await page.goto("/");

    // Sign in as owner against real Better Auth + STUDIO_DB
    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();

    // Create a dedicated empty project for Data-Pill Picker E2E
    await page.getByTestId("new-project-button").click();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r0");
    const createdProjectSlug = await page.getByTestId("project-selector").inputValue();
    expect(createdProjectSlug).toMatch(/^project-\d+$/);

    // 1. Navigate to Data (Entities) view, turn on dynamic-entities, and create `invoices` entity
    await page.getByTestId("nav-tab-data").click();
    await expect(page.getByTestId("view-data")).toBeVisible();

    await page.getByTestId("turn-on-dynamic-entities-button").click();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r1");

    await page.getByTestId("new-entity-button").click();
    await page.getByTestId("entity-name-input").fill("invoices");

    // Field 0: amount (number)
    await page.getByTestId("field-name-input-0").fill("amount");
    await page.getByTestId("field-type-select-0").selectOption("number");

    // Field 1: status (enum: draft, sent, paid)
    await page.getByTestId("add-field-button").click();
    await page.getByTestId("field-name-input-1").fill("status");
    await page.getByTestId("field-type-select-1").selectOption("enum");
    await page.getByTestId("field-enum-values-input-1").fill("draft, sent, paid");

    // Field 2: customer_email (string)
    await page.getByTestId("add-field-button").click();
    await page.getByTestId("field-name-input-2").fill("customer_email");
    await page.getByTestId("field-type-select-2").selectOption("string");

    await page.getByTestId("save-entity-button").click();
    await expect(page.getByTestId("entity-saved-badge")).toBeVisible();

    // 2. Navigate to Workflows tab and create "Invoice Paid Email Flow"
    await page.getByTestId("nav-tab-workflows").click();
    await expect(page.getByTestId("view-workflows")).toBeVisible();

    await page.getByTestId("new-workflow-button").click();
    await page.getByTestId("new-workflow-name-input").fill("Invoice Paid Email Flow");
    await page.getByTestId("create-workflow-confirm").click();
    await expect(page.getByTestId("workflow-selector")).toHaveValue(
      "wf-invoice-paid-email-flow",
    );

    // 3. Add Brick Event Trigger, If Condition, and Format Template nodes from Palette
    const trigNodeId = "node-brick-event-1";
    const ifNodeId = "node-if-2";
    const formatNodeId = "node-format-template-3";

    await page.getByTestId("palette-add-node-core.brick_event").click();
    await expect(page.getByTestId(`canvas-node-${trigNodeId}`)).toBeVisible();

    await page.getByTestId("palette-add-node-core.if").click();
    await expect(page.getByTestId(`canvas-node-${ifNodeId}`)).toBeVisible();

    await page.getByTestId("palette-add-node-core.format_template").click();
    await expect(page.getByTestId(`canvas-node-${formatNodeId}`)).toBeVisible();

    // 4. Select Trigger node, bind it to `invoices` entity, verify dynamic `col-*` ports, and save
    await page.getByTestId(`canvas-node-${trigNodeId}`).click();
    await expect(page.getByTestId("inspector-node-id")).toHaveText(trigNodeId);
    await page.getByTestId("node-entity-select").selectOption("invoices");

    await expect(page.getByTestId("inspector-node-dynamic-ports")).toBeVisible();
    await expect(page.getByTestId("dynamic-port-out-col-id")).toContainText("col-id:string");
    await expect(page.getByTestId("dynamic-port-out-col-amount")).toContainText(
      "col-amount:number",
    );
    await expect(page.getByTestId("dynamic-port-out-col-status")).toContainText(
      "col-status:string",
    );
    await expect(page.getByTestId("dynamic-port-out-col-customer_email")).toContainText(
      "col-customer_email:string",
    );

    await page.getByTestId("inspector-node-save").click();
    await expect(page.getByTestId("inspector-node-saved-badge")).toBeVisible();

    // 5. Connect wires: trigNodeId::out -> ifNodeId::in, and ifNodeId::true -> formatNodeId::in
    const wireSource = page.getByTestId("wire-source-select");
    const wireTarget = page.getByTestId("wire-target-select");
    const wireConnectBtn = page.getByTestId("wire-connect-button");

    await wireSource.selectOption(`${trigNodeId}::out`);
    await wireTarget.selectOption(`${ifNodeId}::in`);
    await wireConnectBtn.click();

    await wireSource.selectOption(`${ifNodeId}::true`);
    await wireTarget.selectOption(`${formatNodeId}::in`);
    await wireConnectBtn.click();

    // 6. Select `ifNodeId` and pick `status` from Data-Pill Picker with ZERO typed '{{' expressions
    await page.getByTestId(`canvas-node-${ifNodeId}`).click();
    await expect(page.getByTestId("inspector-node-id")).toHaveText(ifNodeId);

    await page.getByTestId("open-pill-picker-field").click();
    const fieldPicker = page.getByTestId("data-pill-picker-field");
    await expect(fieldPicker).toBeVisible();

    // Assert getComputedStyle on Data-Pill Picker popover
    const pickerStyle = await fieldPicker.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        bg: cs.backgroundColor,
        border: cs.borderColor,
      };
    });
    expect(pickerStyle.bg).toBe("rgb(15, 23, 42)");

    await page.getByTestId(`pill-option-${trigNodeId}-status`).click();

    const statusChip = page.getByTestId("data-pill-chip-field-status");
    await expect(statusChip).toBeVisible();
    await expect(statusChip).toContainText("status : string");

    // Assert getComputedStyle on rendered Data Pill chip
    const chipStyle = await statusChip.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        display: cs.display,
        color: cs.color,
      };
    });
    expect(chipStyle.display).toContain("flex");
    expect(chipStyle.color).toBe("rgb(253, 230, 138)");

    await page.getByTestId("node-config-input-value").fill("paid");
    await page.getByTestId("inspector-node-save").click();
    await expect(page.getByTestId("inspector-node-saved-badge")).toBeVisible();

    // 7. Select `formatNodeId` and pick `customer_email`, `id`, and `amount` from Data-Pill Picker with ZERO typed '{{' expressions
    await page.getByTestId(`canvas-node-${formatNodeId}`).click();
    await expect(page.getByTestId("inspector-node-id")).toHaveText(formatNodeId);

    await page.getByTestId("open-pill-picker-to").click();
    await page.getByTestId(`pill-option-${trigNodeId}-customer_email`).click();
    await expect(page.getByTestId("data-pill-chip-to-customer_email")).toBeVisible();

    await page.getByTestId("open-pill-picker-template").click();
    await page.getByTestId(`pill-option-${trigNodeId}-id`).click();
    await page.getByTestId(`pill-option-${trigNodeId}-amount`).click();

    await expect(page.getByTestId("data-pill-chip-template-id")).toBeVisible();
    await expect(page.getByTestId("data-pill-chip-template-amount")).toBeVisible();

    await page.getByTestId("inspector-node-save").click();
    await expect(page.getByTestId("inspector-node-saved-badge")).toBeVisible();

    // 8. Reload page (F5) and verify BlueprintDO persisted all Data-Pill bindings
    await page.reload();
    await expect(page.getByTestId("studio-shell")).toBeVisible();

    const projectSelect = page.getByTestId("project-selector");
    if ((await projectSelect.inputValue()) !== createdProjectSlug) {
      await projectSelect.selectOption(createdProjectSlug);
    }

    await page.getByTestId("nav-tab-workflows").click();
    await expect(page.getByTestId("view-workflows")).toBeVisible();
    await page.getByTestId("workflow-selector").selectOption("wf-invoice-paid-email-flow");

    await page.getByTestId(`canvas-node-${ifNodeId}`).click();
    await expect(page.getByTestId("data-pill-chip-field-status")).toBeVisible();
    const persistedIfConfig = JSON.parse(
      (await page.getByTestId("inspector-node-config").textContent()) ?? "{}",
    ) as Record<string, unknown>;
    expect(persistedIfConfig.field).toBe(`{{steps.${trigNodeId}.output.status}}`);
    expect(persistedIfConfig.value).toBe("paid");

    await page.getByTestId(`canvas-node-${formatNodeId}`).click();
    await expect(page.getByTestId("data-pill-chip-to-customer_email")).toBeVisible();
    await expect(page.getByTestId("data-pill-chip-template-id")).toBeVisible();
    await expect(page.getByTestId("data-pill-chip-template-amount")).toBeVisible();

    const persistedFormatConfig = JSON.parse(
      (await page.getByTestId("inspector-node-config").textContent()) ?? "{}",
    ) as Record<string, unknown>;
    expect(persistedFormatConfig.to).toBe(
      `{{steps.${trigNodeId}.output.customer_email}}`,
    );
    expect(String(persistedFormatConfig.template)).toContain(
      `{{steps.${trigNodeId}.output.id}}`,
    );
    expect(String(persistedFormatConfig.template)).toContain(
      `{{steps.${trigNodeId}.output.amount}}`,
    );
  });
});
