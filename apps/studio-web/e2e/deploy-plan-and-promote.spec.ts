import { expect, test } from "@playwright/test";

test.describe("Story 5.3: Pre-deploy Plan & Diff Modal, Destructive-Migration Guard & Stub-Identity Blocker (Real Backend)", () => {
  test("verifies first-time create plan, SQL preview, noop repeat plan, production stub-identity blocker + switch to core-auth, inline secret addition, destructive migration confirmation guard, computed styles, and F5 reload persistence", async ({
    page,
  }) => {
    const VALID_TOKEN = "cf_scoped_valid_token_e2e_story53_8899";

    const pageErrors: string[] = [];
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    await page.goto("/");

    // 1. Sign in as Alice (Owner) against real Better Auth + STUDIO_DB
    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await expect(page.getByTestId("project-selector")).toHaveValue("acme-saas");

    // Clean up any org deploy tokens so this test starts from a clean, deterministic BYOC state
    await page.evaluate(async () => {
      const orgsRes = await fetch("/api/orgs", { credentials: "include" });
      if (!orgsRes.ok) return;
      const { orgs } = (await orgsRes.json()) as { orgs: Array<{ id: string }> };
      for (const org of orgs ?? []) {
        const tokensRes = await fetch(`/api/orgs/${encodeURIComponent(org.id)}/cloudflare-tokens`, {
          credentials: "include",
        });
        if (!tokensRes.ok) continue;
        const { tokens } = (await tokensRes.json()) as { tokens: Array<{ tokenRef: string }> };
        for (const t of tokens ?? []) {
          await fetch(`/api/orgs/${encodeURIComponent(org.id)}/cloudflare-tokens/${encodeURIComponent(t.tokenRef)}`, {
            method: "DELETE",
            credentials: "include",
          });
        }
      }
    });

    // 2. Connect Cloudflare token on acme-saas via Guided Wizard
    await page.getByTestId("nav-tab-connections").click();
    await expect(page.getByTestId("view-connections")).toBeVisible();

    const connectBtn = page.getByTestId("connect-cloudflare-button");
    const connectedAccount = page.getByTestId("cloudflare-connected-account-name");
    await expect(connectBtn.or(connectedAccount)).toBeVisible({ timeout: 10_000 });

    if (await connectBtn.isVisible()) {
      await connectBtn.click();
      await expect(page.getByTestId("connect-cloudflare-modal")).toBeVisible();
      await page.getByTestId("cf-token-input").fill(VALID_TOKEN);
      await page.getByTestId("cf-verify-submit-button").click();
    }
    await expect(connectedAccount).toBeVisible({ timeout: 10_000 });

    // 3. Open Pre-deploy Plan & Diff modal for preview
    await page.getByTestId("open-deploy-plan-preview-button").click();
    const modal = page.getByTestId("deploy-plan-modal");
    await expect(modal).toBeVisible();

    // Verify computed styles on modal & preflight section
    const modalStyles = await modal.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        display: cs.display,
        position: cs.position,
        backgroundColor: cs.backgroundColor,
      };
    });
    expect(modalStyles.display).toBe("flex");
    expect(modalStyles.position).toBe("fixed");

    await expect(page.getByTestId("deploy-plan-preflight")).toBeVisible();
    await expect(page.getByTestId("deploy-plan-action-badge")).toContainText("Action: create");
    await expect(page.getByTestId("deploy-plan-card-worker")).toBeVisible();
    await expect(page.getByTestId("deploy-plan-card-d1")).toBeVisible();
    await expect(page.getByTestId("deploy-plan-card-queues")).toBeVisible();
    await expect(page.getByTestId("deploy-plan-card-crons")).toBeVisible();
    await expect(page.getByTestId("deploy-plan-card-workflows")).toBeVisible();

    // Toggle expandable SQL preview on a pending D1 migration
    const firstSqlToggle = page.locator('[data-testid^="deploy-plan-migration-sql-toggle-"]').first();
    await expect(firstSqlToggle).toBeVisible();
    await firstSqlToggle.click();
    const firstSqlPreview = page.locator('pre[data-testid^="deploy-plan-migration-sql-"]').first();
    await expect(firstSqlPreview).toContainText("CREATE TABLE");

    // 4. Deploy to preview -> verify noop banner on repeat plan
    const confirmDeployBtn = page.getByTestId("confirm-and-deploy-button");
    await expect(confirmDeployBtn).toBeEnabled();
    await confirmDeployBtn.click();

    await expect(page.getByTestId("deploy-execution-success")).toBeVisible();
    await expect(page.getByTestId("deploy-plan-noop-banner")).toContainText("No changes — environment is already at revision r");

    // 5. Switch to production tab -> verify PRODUCTION_IDENTITY_STUB_FORBIDDEN blocker banner
    await page.getByTestId("deploy-plan-env-tab-production").click();
    const stubBlocker = page.getByTestId("deploy-plan-stub-identity-blocker");
    await expect(stubBlocker).toBeVisible();
    await expect(stubBlocker).toContainText("PRODUCTION_IDENTITY_STUB_FORBIDDEN");
    await expect(confirmDeployBtn).toBeDisabled();

    // Verify computed style on the red blocking banner
    const blockerStyle = await stubBlocker.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        borderStyle: cs.borderStyle,
        backgroundColor: cs.backgroundColor,
      };
    });
    expect(blockerStyle.borderStyle).toBe("solid");
    expect(blockerStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

    // Click "Switch to Better Auth (core-auth)" -> clears stub identity blocker
    await page.getByTestId("switch-to-core-auth-button").click();
    await expect(stubBlocker).toHaveCount(0);

    // 6. Add the required core-auth secret inline via the preflight checklist. Production never generates
    // BETTER_AUTH_SECRET (story 1.19), so the owner supplies it here; the GitHub OAuth secrets are optional and get
    // no input.
    for (const secName of ["BETTER_AUTH_SECRET"]) {
      const input = page.getByTestId(`inline-secret-input-${secName}`);
      await expect(input).toBeVisible();
      await input.fill(`val_${secName.toLowerCase()}_e2e_123456`);
      await page.getByTestId(`inline-secret-save-${secName}`).click();
      await expect(page.getByTestId(`preflight-secret-row-${secName}`)).toContainText("present ✓");
    }
    for (const secName of ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]) {
      await expect(page.getByTestId(`inline-secret-input-${secName}`)).toHaveCount(0);
      await expect(page.getByTestId(`preflight-secret-row-${secName}`)).toContainText("optional, not configured");
    }

    // 7. Register a pending destructive migration on preview and verify Destructive Migration Guard
    await page.evaluate(async () => {
      await fetch("/api/projects/acme-saas/environments/preview/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          migrations: [
            {
              name: "9901_drop_legacy_sessions.sql",
              sql: "DROP TABLE IF EXISTS legacy_sessions; ALTER TABLE invoices DROP COLUMN title;",
            },
          ],
        }),
      });
    });

    await page.getByTestId("deploy-plan-env-tab-preview").click();
    const destructiveGuard = page.getByTestId("destructive-migration-guard");
    await expect(destructiveGuard).toBeVisible();
    await expect(destructiveGuard).toContainText("drop_table");
    await expect(destructiveGuard).toContainText("drop_column");
    await expect(confirmDeployBtn).toBeDisabled();

    // Check confirmation checkbox -> Confirm & Deploy button enables
    const confirmCheckbox = page.getByTestId("destructive-migration-confirm-checkbox");
    await confirmCheckbox.check();
    await expect(confirmDeployBtn).toBeEnabled();
    await confirmDeployBtn.click();

    await expect(page.getByTestId("deploy-execution-success")).toBeVisible();

    // 8. Promote cached preview build to production -> verify reusedCachedBuild badge & identical buildHash
    await page.getByTestId("deploy-plan-env-tab-production").click();
    await expect(page.getByTestId("deploy-reused-cached-build-badge")).toContainText("Reuses cached build");
    await page.getByTestId("promote-to-production-button").click();
    await expect(page.getByTestId("deploy-execution-success")).toContainText("Promoted revision r");

    // 9. Commit a workflow-only edit and verify "Live without redeploy" hot-apply path on preview
    await page.evaluate(async () => {
      await fetch("/api/projects/acme-saas/ops", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          summary: "Update workflow node to hot-apply graph",
          ops: [
            {
              opId: `op_hot_wf_${Date.now()}`,
              type: "update_node",
              workflowId: "wf-billing",
              nodeId: "node-pick",
              data: { path: "amount_cents", hotApplied: true },
            },
          ],
        }),
      });
    });

    await page.getByTestId("deploy-plan-env-tab-preview").click();
    await expect(page.getByTestId("deploy-plan-hot-apply-banner")).toContainText("Live without redeploy");
    await expect(page.getByTestId("deploy-live-without-redeploy-badge")).toHaveText("Live without redeploy");
    await expect(page.getByTestId("deploy-plan-action-badge")).toContainText("Action: hot_apply_graphs");

    await confirmDeployBtn.click();
    await expect(page.getByTestId("deploy-execution-success")).toContainText("Live without redeploy");

    // Re-promote updated build to production so both preview & production share the latest buildHash
    await page.getByTestId("deploy-plan-env-tab-production").click();
    await page.getByTestId("promote-to-production-button").click();
    await expect(page.getByTestId("deploy-execution-success")).toContainText("Promoted revision r");

    await page.getByTestId("close-deploy-plan-modal").click();

    // 10. Reload page (F5) and verify deployed environment state & identical buildHash persist in D1
    await page.reload();
    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await page.getByTestId("nav-tab-connections").click();
    await expect(page.getByTestId("view-connections")).toBeVisible();

    const previewBadge = page.getByTestId("cloudflare-env-badge-preview");
    const productionBadge = page.getByTestId("cloudflare-env-badge-production");
    await expect(previewBadge).toContainText("preview · byoc · r");
    await expect(productionBadge).toContainText("production · byoc · r");

    const previewBuildHash = await previewBadge.getAttribute("data-build-hash");
    const productionBuildHash = await productionBadge.getAttribute("data-build-hash");
    expect(previewBuildHash).toBeTruthy();
    expect(previewBuildHash).toBe(productionBuildHash);

    expect(pageErrors).toEqual([]);
  });
});
