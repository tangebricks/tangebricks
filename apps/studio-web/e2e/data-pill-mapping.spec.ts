import { expect, test } from "@playwright/test";

test.describe("Data-Pill Expression Mode Validation & Dynamic Placeholder Ports (Real Backend)", () => {
  test("exposes ph-* template placeholder ports, validates raw step expressions against upstream ancestors, and removes pill chips", async ({
    page,
  }) => {
    await page.goto("/");

    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();

    await page.getByTestId("new-project-button").click();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r0");

    await page.getByTestId("nav-tab-workflows").click();
    await expect(page.getByTestId("view-workflows")).toBeVisible();

    await page.getByTestId("new-workflow-button").click();
    await page.getByTestId("new-workflow-name-input").fill("Template Pill Validation Flow");
    await page.getByTestId("create-workflow-confirm").click();

    await page.getByTestId("palette-add-node-core.webhook").click();
    await expect(page.getByTestId("canvas-node-node-webhook-1")).toBeVisible();

    await page.getByTestId("palette-add-node-core.format_template").click();
    await expect(page.getByTestId("canvas-node-node-format-template-2")).toBeVisible();

    // Connect webhook -> format_template
    await page.getByTestId("wire-source-select").selectOption("node-webhook-1::out");
    await page
      .getByTestId("wire-target-select")
      .selectOption("node-format-template-2::in");
    await page.getByTestId("wire-connect-button").click();

    // Select format_template and verify dynamic ph-* placeholder port when typing a placeholder
    await page.getByTestId("canvas-node-node-format-template-2").click();
    await page
      .getByTestId("node-config-input-template")
      .fill("Hello {{customer_name}}");
    await expect(
      page.getByTestId("dynamic-port-in-ph-customer_name"),
    ).toContainText("ph-customer_name:string");

    // Pick `out` from `node-webhook-1` via Data-Pill Picker
    await page.getByTestId("open-pill-picker-to").click();
    await page.getByTestId("pill-option-node-webhook-1-out").click();
    await expect(page.getByTestId("data-pill-chip-to-out")).toBeVisible();

    // Toggle "Advanced: Edit raw expression" and verify ancestor validation
    await page.getByTestId("toggle-raw-expression-to").click();
    const rawInput = page.getByTestId("raw-expression-input-to");
    await rawInput.fill("{{steps.unknown_step.output.email}}");
    await expect(
      page.getByTestId("expression-validation-error-to"),
    ).toContainText("Node 'unknown_step' is not an upstream ancestor");

    // Restore valid pill via raw mode and save
    await rawInput.fill("{{steps.node-webhook-1.output.out}}");
    await expect(page.getByTestId("expression-validation-error-to")).toHaveCount(0);
    await page.getByTestId("inspector-node-save").click();
    await expect(page.getByTestId("inspector-node-saved-badge")).toBeVisible();
  });
});
