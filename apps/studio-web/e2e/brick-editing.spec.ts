import { expect, test } from "@playwright/test";

test.describe("Brick Catalog Enable/Disable & JSON-Schema Settings Inspector (Real Backend)", () => {
  test("enables bricks with transitive requires, blocks conflicts, gates experimental bricks, configures 3 distinct settings shapes in Right Dock Inspector, persists across F5 reload, and disables bricks", async ({
    page,
  }) => {
    await page.goto("/");

    // Sign in as owner against real Better Auth + STUDIO_DB
    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();

    // Create a dedicated empty project for brick editing E2E
    await page.getByTestId("new-project-button").click();
    await expect(page.getByTestId("project-selector")).toHaveValue("project-3");
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r0");

    // Navigate to Bricks view
    await page.getByTestId("nav-tab-bricks").click();
    await expect(page.getByTestId("view-bricks")).toBeVisible();

    // Verify experimental bricks are hidden by default (AD-S8)
    await expect(
      page.getByTestId("catalog-brick-card-scripting-sandbox"),
    ).toHaveCount(0);

    // 1. Click Turn on on credit-wallet -> Dependency & Impact Preview modal shows multi-workspace required
    await page.getByTestId("catalog-brick-enable-credit-wallet").click();
    const enableModal = page.getByTestId("brick-enable-modal");
    await expect(enableModal).toBeVisible();
    await expect(page.getByTestId("brick-enable-requires")).toContainText(
      "Also turns on: multi-workspace (required)",
    );
    await expect(page.getByTestId("brick-enable-req-multi-workspace")).toContainText(
      "provides workspace-context",
    );
    await expect(page.getByTestId("brick-enable-adds")).toContainText(
      "migrations/0001_credit_wallet.sql",
    );
    await expect(page.getByTestId("brick-enable-adds")).toContainText("/api/wallet");
    await expect(page.getByTestId("brick-enable-adds")).toContainText(
      "credit-wallet.debit (action)",
    );

    // Assert computed styles on brick card and enable modal
    const modalStyles = await page.evaluate(() => {
      const card = document.querySelector(
        '[data-testid="catalog-brick-card-credit-wallet"]',
      );
      const modal = document.querySelector('[data-testid="brick-enable-modal"]');
      if (!card || !modal) return null;
      const cardStyle = window.getComputedStyle(card);
      const modalStyle = window.getComputedStyle(modal);
      return {
        cardDisplay: cardStyle.display,
        cardBorderRadius: cardStyle.borderRadius,
        modalPosition: modalStyle.position,
        modalDisplay: modalStyle.display,
      };
    });
    expect(modalStyles).not.toBeNull();
    expect(modalStyles!.cardDisplay).toBe("flex");
    expect(modalStyles!.modalPosition).toBe("fixed");
    expect(modalStyles!.modalDisplay).toBe("flex");

    // Confirm enabling credit-wallet (+ multi-workspace in one atomic batch)
    await page.getByTestId("brick-enable-confirm").click();
    await expect(enableModal).toHaveCount(0);
    await expect(page.getByTestId("enabled-brick-card-multi-workspace")).toBeVisible();
    await expect(page.getByTestId("enabled-brick-card-credit-wallet")).toBeVisible();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r1");

    // 2. Turn on subscription-plans, then verify conflict blocking on outbound-webhooks
    await page.getByTestId("catalog-brick-enable-subscription-plans").click();
    await page.getByTestId("brick-enable-confirm").click();
    await expect(
      page.getByTestId("enabled-brick-card-subscription-plans"),
    ).toBeVisible();

    await page.getByTestId("catalog-brick-enable-outbound-webhooks").click();
    await expect(page.getByTestId("brick-enable-conflicts")).toContainText(
      "Both mount routes under the /api/subscriptions prefix",
    );
    await expect(page.getByTestId("brick-enable-confirm")).toBeDisabled();
    await page.getByTestId("brick-enable-cancel").click();

    // 3. Toggle Include experimental and verify explicit checkbox required for scripting-sandbox
    await page.getByTestId("bricks-experimental-toggle").click();
    await expect(
      page.getByTestId("catalog-brick-card-scripting-sandbox"),
    ).toBeVisible();
    await page.getByTestId("catalog-brick-enable-scripting-sandbox").click();
    await expect(page.getByTestId("brick-enable-confirm")).toBeDisabled();
    await expect(page.getByTestId("experimental-confirm-box")).toContainText(
      "I understand this brick is experimental:",
    );
    await page.getByTestId("experimental-confirm-checkbox").check();
    await expect(page.getByTestId("brick-enable-confirm")).toBeEnabled();
    await page.getByTestId("brick-enable-confirm").click();
    await expect(
      page.getByTestId("enabled-brick-card-scripting-sandbox"),
    ).toBeVisible();

    // 4. Turn on omnichannel-outbound and rbac-policy so we have 3 distinct settings shapes enabled
    await page.getByTestId("catalog-brick-enable-omnichannel-outbound").click();
    await page.getByTestId("brick-enable-confirm").click();
    await expect(
      page.getByTestId("enabled-brick-card-omnichannel-outbound"),
    ).toBeVisible();

    await page.getByTestId("catalog-brick-enable-rbac-policy").click();
    await page.getByTestId("brick-enable-confirm").click();
    await expect(page.getByTestId("enabled-brick-card-rbac-policy")).toBeVisible();

    // 5. Configure Brick 1 (credit-wallet: integer input + slider + live validation)
    await page.getByTestId("enabled-brick-card-credit-wallet").click();
    await expect(page.getByTestId("inspector-brick-detail")).toBeVisible();

    const creditsInput = page.getByTestId("setting-input-creditsPerUnit");
    const creditsSlider = page.getByTestId("setting-slider-creditsPerUnit");
    await expect(creditsInput).toBeVisible();
    await expect(creditsSlider).toBeVisible();

    // Assert computed styles on Inspector form controls
    const inspectorStyles = await page.evaluate(() => {
      const input = document.querySelector(
        '[data-testid="setting-input-creditsPerUnit"]',
      );
      const saveBtn = document.querySelector('[data-testid="brick-settings-save"]');
      if (!input || !saveBtn) return null;
      return {
        inputWidth: input.getBoundingClientRect().width,
        saveFontWeight: window.getComputedStyle(saveBtn).fontWeight,
      };
    });
    expect(inspectorStyles).not.toBeNull();
    expect(inspectorStyles!.inputWidth).toBeGreaterThan(100);
    expect(Number(inspectorStyles!.saveFontWeight)).toBeGreaterThanOrEqual(600);

    // Out-of-range value (0 < min 1) immediately displays field error and disables Save
    await creditsInput.fill("0");
    await expect(page.getByTestId("setting-error-creditsPerUnit")).toContainText(
      "between 1 and 1000000",
    );
    await expect(page.getByTestId("brick-settings-save")).toBeDisabled();

    // Valid integer value (25) enables Save and commits configure_brick to BlueprintDO
    await creditsInput.fill("25");
    await expect(page.getByTestId("setting-error-creditsPerUnit")).toHaveCount(0);
    await expect(page.getByTestId("brick-settings-save")).toBeEnabled();
    await page.getByTestId("brick-settings-save").click();
    await expect(page.getByTestId("brick-settings-saved-badge")).toBeVisible();

    // 6. Configure Brick 2 (omnichannel-outbound: enum select dropdown)
    await page.getByTestId("enabled-brick-card-omnichannel-outbound").click();
    const channelSelect = page.getByTestId("setting-select-defaultChannel");
    await expect(channelSelect).toHaveValue("email");
    await channelSelect.selectOption("slack");
    await page.getByTestId("brick-settings-save").click();
    await expect(page.getByTestId("brick-settings-saved-badge")).toBeVisible();

    // 7. Configure Brick 3 (rbac-policy: boolean toggle switch)
    await page.getByTestId("enabled-brick-card-rbac-policy").click();
    const roleToggle = page.getByTestId("setting-toggle-allowCustomRoles");
    await expect(roleToggle).toHaveAttribute("aria-checked", "true");
    await roleToggle.click();
    await expect(roleToggle).toHaveAttribute("aria-checked", "false");
    await page.getByTestId("brick-settings-save").click();
    await expect(page.getByTestId("brick-settings-saved-badge")).toBeVisible();

    // 8. Reload page (F5) and verify all enabled bricks and configured settings persist from BlueprintDO
    await page.reload();
    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await expect(page.getByTestId("project-selector")).toHaveValue("project-3");

    await page.getByTestId("nav-tab-bricks").click();
    await expect(page.getByTestId("enabled-brick-card-credit-wallet")).toBeVisible();
    await expect(
      page.getByTestId("enabled-brick-card-omnichannel-outbound"),
    ).toBeVisible();
    await expect(page.getByTestId("enabled-brick-card-rbac-policy")).toBeVisible();
    await expect(
      page.getByTestId("enabled-brick-card-scripting-sandbox"),
    ).toBeVisible();

    // Verify persisted settings on all 3 bricks after reload
    await page.getByTestId("enabled-brick-card-credit-wallet").click();
    await expect(page.getByTestId("setting-input-creditsPerUnit")).toHaveValue("25");

    await page.getByTestId("enabled-brick-card-omnichannel-outbound").click();
    await expect(page.getByTestId("setting-select-defaultChannel")).toHaveValue("slack");

    await page.getByTestId("enabled-brick-card-rbac-policy").click();
    await expect(
      page.getByTestId("setting-toggle-allowCustomRoles"),
    ).toHaveAttribute("aria-checked", "false");

    // 9. Turn off scripting-sandbox via Disable modal and verify removal
    await page.getByTestId("enabled-brick-disable-scripting-sandbox").click();
    await expect(page.getByTestId("brick-disable-modal")).toBeVisible();
    await page.getByTestId("brick-disable-confirm").click();
    await expect(
      page.getByTestId("enabled-brick-card-scripting-sandbox"),
    ).toHaveCount(0);
  });
});
