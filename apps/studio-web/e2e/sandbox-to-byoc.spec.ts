import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signInAsAlice(page: Page) {
  await page.goto("/");
  const authScreen = page.getByTestId("auth-screen");
  const shell = page.getByTestId("studio-shell");
  await expect(authScreen.or(shell)).toBeVisible({ timeout: 15_000 });

  if (await authScreen.isVisible()) {
    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();
  }

  await expect(shell).toBeVisible({ timeout: 15_000 });
}

test.describe("Story 9.3 — Zero-Credential Instant Sandbox Preview & One-Click Move to BYOC Promotion", () => {
  test("AC 1, AC 2, AC 3, AC 4: zero-credential user creates ai-credits-saas project, deploys to Instant Sandbox Preview in < 120s, and promotes to BYOC preserving exact buildHash", async ({
    page,
  }) => {
    const t0 = Date.now();
    await signInAsAlice(page);

    // Clean up any org deploy tokens so Alice acts as a fresh zero-credential user
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

    // 1. Create a fresh empty project so no Cloudflare token is connected
    await page.getByTestId("new-project-button").click();
    await expect(page.getByTestId("overview-empty-state")).toBeVisible({
      timeout: 10_000,
    });

    const projectSlug = await page.getByTestId("project-selector").inputValue();
    expect(projectSlug).toBeTruthy();

    // 2. Load the ai-credits-saas starter template
    await page.getByTestId("load-preset-ai-credits-saas").click();
    await expect(page.getByTestId("overview-backend-map")).toBeVisible({
      timeout: 15_000,
    });

    // 3. Click Top Bar Deploy button without a connected Cloudflare account
    await page.getByTestId("deploy-button").click();
    const zeroCredModal = page.getByTestId("zero-credential-deploy-modal");
    await expect(zeroCredModal).toBeVisible();

    const instantSandboxBtn = page.getByTestId("deploy-instant-sandbox-button");
    const connectByocBtn = page.getByTestId("deploy-connect-byoc-button");
    await expect(instantSandboxBtn).toContainText("Try in Instant Sandbox Preview (No Cloudflare account needed — free for 7 days)");
    await expect(connectByocBtn).toContainText("Connect my Cloudflare account (BYOC)");

    // 4. Launch Instant Sandbox Preview
    await instantSandboxBtn.click();
    await expect(zeroCredModal).toBeHidden({ timeout: 15_000 });

    const sandboxBadge = page.getByTestId("topbar-sandbox-badge");
    const previewUrlChip = page.getByTestId("sandbox-preview-url");
    const moveToByocBtn = page.getByTestId("move-to-byoc-button");

    await expect(sandboxBadge).toBeVisible({ timeout: 15_000 });
    await expect(sandboxBadge).toContainText("Sandbox v1 · 7d left");
    await expect(previewUrlChip).toContainText(".sandbox.projectx.dev");
    await expect(moveToByocBtn).toHaveText("Move to my Cloudflare account");

    const timeToPreviewMs = Date.now() - t0;
    expect(timeToPreviewMs).toBeLessThan(120_000);

    const sandboxBuildHash = await sandboxBadge.getAttribute("data-sandbox-build-hash");
    expect(sandboxBuildHash).toBeTruthy();

    // 5. Insert a sample entity row into usage_ledgers in the sandbox preview
    const insertStatus = await page.evaluate(async (slug) => {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/environments/preview/data/tables/usage_ledgers/rows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          workspaceId: "ws_e2e_promote",
          confirmWrite: true,
          row: {
            id: "row_e2e_1",
            metric: "llm_tokens",
            units: 750,
          },
        }),
      });
      return res.status;
    }, projectSlug);
    expect(insertStatus).toBe(201);

    // 6. Click "Move to my Cloudflare account" and promote to BYOC
    await moveToByocBtn.click();
    const moveModal = page.getByTestId("move-to-byoc-modal");
    await expect(moveModal).toBeVisible();

    // Story 17: sandbox rows are no longer copied on promote, so there is no copy option.
    await expect(page.getByTestId("promote-copy-sample-data-checkbox")).toHaveCount(0);

    await page.getByTestId("move-to-byoc-token-input").fill("cf_ut_valid_e2e_promote_token_99887766");
    await page.getByTestId("move-to-byoc-account-id-input").fill("abcdef0123456789abcdef0123456789");
    await page.getByTestId("move-to-byoc-submit-button").click();

    await expect(moveModal).toBeHidden({ timeout: 15_000 });

    // 7. Verify promoted BYOC buildHash === sandboxBuildHash and old sandbox destroyed
    const promotedBanner = page.getByTestId("promoted-byoc-banner");
    await expect(promotedBanner).toBeVisible({ timeout: 15_000 });

    const byocBuildHash = await page.getByTestId("promoted-byoc-build-hash").textContent();
    const promotedSandboxHash = await page.getByTestId("promoted-sandbox-build-hash").textContent();
    expect(byocBuildHash).toBe(sandboxBuildHash);
    expect(promotedSandboxHash).toBe(sandboxBuildHash);

    await expect(page.getByTestId("promoted-old-sandbox-destroyed")).toHaveText("true");
    await expect(sandboxBadge).toBeHidden();
    await expect(page.getByTestId("env-badge")).toContainText(/^Preview r\d+$/);

    // 8. Story 17: with the sandbox destroyed there is no data store Studio can reach (NOT_CONFIGURED, no STUDIO_DB
    // fallback), and the sandbox status is promoted
    const verifyByocData = await page.evaluate(async (slug) => {
      const rowsRes = await fetch(`/api/projects/${encodeURIComponent(slug)}/environments/preview/data/tables/usage_ledgers/rows?workspaceId=ws_e2e_promote`, {
        credentials: "include",
      });
      const rowsBody = (await rowsRes.json()) as { error?: { code?: string } };
      const sbRes = await fetch(`/api/projects/${encodeURIComponent(slug)}/sandbox`, { credentials: "include" });
      const sbText = await sbRes.text();
      let sbBody: { sandbox: { status: string } | null } | null = null;
      try {
        sbBody = JSON.parse(sbText);
      } catch {
        // ignore
      }
      return {
        rowsStatus: rowsRes.status,
        rowsCode: rowsBody.error?.code ?? null,
        sandboxStatus: sbBody?.sandbox?.status ?? null,
      };
    }, projectSlug);

    expect(verifyByocData.rowsStatus).toBe(503);
    expect(verifyByocData.rowsCode).toBe("NOT_CONFIGURED");
    expect(verifyByocData.sandboxStatus).toBe("promoted");
  });
});
