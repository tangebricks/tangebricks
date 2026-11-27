import { expect, test } from "@playwright/test";

test.describe("Story 5.2: Guided Connect Cloudflare Wizard & Per-Permission Verifier (Real Backend)", () => {
  test("verifies Connect Cloudflare wizard UI, missing-permission error diagnostics, valid least-privilege token connection, computed styles, F5 reload persistence of preview & production targets, and zero plaintext token leakage", async ({
    page,
  }) => {
    const MISSING_WORKERS_TOKEN = "cf_missing_workers_edit_e2e_9911";
    const VALID_CANARY_TOKEN = "cf_valid_least_priv_e2e_canary_8842";

    await page.goto("/");

    // 1. Sign in as owner against real Better Auth + STUDIO_DB
    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();

    // 2. Create a dedicated project for the Connect Cloudflare E2E flow
    await page.getByTestId("new-project-button").click();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r0");
    const projectSlug = await page.getByTestId("project-selector").inputValue();
    expect(projectSlug).toMatch(/^project-\d+$/);

    // 3. Click Top Bar Deploy button -> opens Zero-Credential Choice Modal -> choose Connect BYOC
    await page.getByTestId("deploy-button").click();
    const zeroModal = page.getByTestId("zero-credential-deploy-modal");
    await expect(zeroModal).toBeVisible();
    await page.getByTestId("deploy-connect-byoc-button").click();
    await expect(zeroModal).toBeHidden();

    await expect(page.getByTestId("view-connections")).toBeVisible();
    await expect(page.getByTestId("cloudflare-connection-card")).toBeVisible();
    await expect(page.getByTestId("cloudflare-byoc-explanation")).toHaveText("Your backend runs in your own Cloudflare account. We never host it.");
    await expect(page.getByTestId("cloudflare-connection-status")).toContainText("Not connected");

    // 4. Verify Connect Cloudflare wizard modal
    await expect(page.getByTestId("connect-cloudflare-modal")).toBeVisible();
    await expect(page.getByTestId("cf-wizard-explanation")).toHaveText("Your backend runs in your own Cloudflare account. We never host it.");

    const templateHref = await page.getByTestId("cf-create-token-link").getAttribute("href");
    expect(templateHref).toContain("https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=");
    expect(templateHref).toContain("name=ProjectX+Studio+Deploy");

    // 5. Submit a token missing Workers Scripts: Edit -> verify HTTP 422 diagnostic and Fix in Cloudflare link
    await page.getByTestId("cf-token-input").fill(MISSING_WORKERS_TOKEN);
    await page.getByTestId("cf-verify-submit-button").click();

    await expect(page.getByTestId("cf-verification-error")).toBeVisible();
    await expect(page.getByTestId("cf-perm-status-account_settings_read")).toHaveText("Account found ✓");
    await expect(page.getByTestId("cf-perm-status-workers_scripts_edit")).toHaveText("Workers Scripts: Edit missing ✕");
    await expect(page.getByTestId("cf-perm-error-workers_scripts_edit")).toContainText("Workers Scripts: Edit missing ✕");
    await expect(page.getByTestId("cf-fix-in-cloudflare-link")).toBeVisible();

    // Verify computed styles on the failing permission row
    const errorRowStyles = await page.getByTestId("cf-perm-row-workers_scripts_edit").evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        borderStyle: cs.borderStyle,
        borderRadius: cs.borderRadius,
      };
    });
    expect(errorRowStyles.borderStyle).not.toBe("none");

    // 6. Paste a valid least-privilege token and click Re-check -> connects and closes modal
    await page.getByTestId("cf-token-input").fill(VALID_CANARY_TOKEN);
    await page.getByTestId("cf-account-name-input").fill("Acme BYOC Production");
    await page.getByTestId("cf-recheck-button").click();

    await expect(page.getByTestId("connect-cloudflare-modal")).toHaveCount(0);
    await expect(page.getByTestId("cloudflare-connection-status")).toContainText("Connected");
    await expect(page.getByTestId("cloudflare-connected-account-name")).toHaveText("Acme BYOC Production");
    await expect(page.getByTestId("cloudflare-env-badge-preview")).toContainText("preview · byoc");
    await expect(page.getByTestId("cloudflare-env-badge-production")).toContainText("production · byoc");
    await expect(page.getByTestId("cloudflare-connected-token-ref")).toContainText("••••8842");

    // Verify computed styles on connected status badge and environment badges
    const badgeStyles = await page.getByTestId("cloudflare-connection-status").evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        borderStyle: cs.borderStyle,
        fontWeight: Number(cs.fontWeight) || 600,
      };
    });
    expect(badgeStyles.borderStyle).not.toBe("none");
    expect(badgeStyles.fontWeight).toBeGreaterThanOrEqual(500);

    // 7. Reload browser (F5) and verify connected Cloudflare account & preview/production targets persist from STUDIO_DB
    await page.reload();
    await expect(page.getByTestId("studio-shell")).toBeVisible();
    const projectSelector = page.getByTestId("project-selector");
    if ((await projectSelector.inputValue()) !== projectSlug) {
      await projectSelector.selectOption(projectSlug);
    }

    await page.getByTestId("nav-tab-connections").click();
    await expect(page.getByTestId("cloudflare-connection-status")).toContainText("Connected");
    await expect(page.getByTestId("cloudflare-connected-account-name")).toHaveText("Acme BYOC Production");
    await expect(page.getByTestId("cloudflare-env-badge-preview")).toContainText("preview · byoc");
    await expect(page.getByTestId("cloudflare-env-badge-production")).toContainText("production · byoc");

    // 8. Verify zero plaintext token leakage in DOM
    const domHtml = await page.content();
    expect(domHtml).not.toContain(VALID_CANARY_TOKEN);
    expect(domHtml).not.toContain(MISSING_WORKERS_TOKEN);
  });
});
