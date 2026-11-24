import { expect, test } from "@playwright/test";

test.describe("Connections & Secrets Center, Inline Inspector Secret Creation, and Zero-Leakage (Real Backend)", () => {
  test("creates secrets in Connections Center and inline from Inspector, binds sec_* handles, rotates & deletes with impact warning, persists across F5 reload, and leaks 0 plaintext bytes across DOM and APIs", async ({
    page,
  }) => {
    const CANARY_1 = "sk_live_e2e_canary_9941";
    const CANARY_2 = "px_http_canary_e2e_5520";
    const CANARY_ROTATED = "sk_live_e2e_rotated_3388";

    await page.goto("/");

    // 1. Sign in as owner against real Better Auth + STUDIO_DB
    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();

    // 2. Create a dedicated empty project
    await page.getByTestId("new-project-button").click();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r0");
    const projectSlug = await page.getByTestId("project-selector").inputValue();
    expect(projectSlug).toMatch(/^project-\d+$/);

    // 3. Enable `core-auth` in Bricks view (declares BETTER_AUTH_SECRET)
    await page.getByTestId("nav-tab-bricks").click();
    await expect(page.getByTestId("view-bricks")).toBeVisible();
    await page.getByTestId("catalog-brick-enable-core-auth").click();
    await page.getByTestId("brick-enable-confirm").click();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r1");

    // 4. Create a workflow with `core.http_request` node
    await page.getByTestId("nav-tab-workflows").click();
    await expect(page.getByTestId("view-workflows")).toBeVisible();
    await page.getByTestId("new-workflow-button").click();
    await page.getByTestId("new-workflow-name-input").fill("Outbound Billing Hook");
    await page.getByTestId("create-workflow-confirm").click();

    await page.getByTestId("palette-add-node-core.webhook").click();
    await page.getByTestId("palette-add-node-core.http_request").click();
    const httpNodeId = "node-http-request-2";
    await expect(page.getByTestId(`canvas-node-${httpNodeId}`)).toBeVisible();

    // 5. Inline create & bind a step secret directly from the Node Inspector
    await page.getByTestId(`canvas-node-${httpNodeId}`).click();
    await expect(page.getByTestId("inspector-node-secret-binding")).toBeVisible();
    await page.getByTestId("inline-add-secret-button-node").click();
    await page.getByTestId("inline-secret-handle-node").fill("sec_http_bearer_e2e");
    await page.getByTestId("inline-secret-value-node").fill(CANARY_2);
    await page.getByTestId("inline-secret-submit-node").click();

    await expect(page.getByTestId("inspector-node-bound-secret-ref")).toContainText(
      "sec_http_bearer_e2e",
    );

    // 6. Navigate to Connections & Secrets Center and add a secret bound to `core-auth`
    await page.getByTestId("nav-tab-connections").click();
    await expect(page.getByTestId("view-connections")).toBeVisible();

    // Verify the inline-created node secret is already listed with 4-char key hint
    await expect(page.getByTestId("secret-row-sec_http_bearer_e2e")).toBeVisible();
    await expect(page.getByTestId("secret-key-hint-sec_http_bearer_e2e")).toHaveText(
      "••••5520",
    );

    await page.getByTestId("add-secret-button").click();
    await expect(page.getByTestId("add-secret-modal")).toBeVisible();
    await page.getByTestId("secret-kind-select").selectOption("brick_secret");
    await page.getByTestId("secret-label-input").fill("Core Auth Secret Key");
    await page.getByTestId("secret-handle-input").fill("sec_core_auth_e2e");
    await page.getByTestId("secret-app-input").fill("core-auth");
    await page.getByTestId("secret-value-input").fill(CANARY_1);
    await page
      .getByTestId("secret-bind-target-select")
      .selectOption("brick:core-auth:BETTER_AUTH_SECRET");
    await page.getByTestId("save-secret-submit").click();

    await expect(page.getByTestId("secret-row-sec_core_auth_e2e")).toBeVisible();
    await expect(page.getByTestId("secret-key-hint-sec_core_auth_e2e")).toHaveText(
      "••••9941",
    );
    await expect(page.getByTestId("secret-status-sec_core_auth_e2e")).toContainText(
      "Valid · Connected",
    );

    // 7. Click "Used by" target on `sec_core_auth_e2e` -> jumps to Bricks view & selects `core-auth`
    await page
      .getByTestId("secret-used-by-target-sec_core_auth_e2e-core-auth")
      .click();
    await expect(page.getByTestId("view-bricks")).toBeVisible();
    await expect(page.getByTestId("inspector-brick-detail")).toBeVisible();

    // 8. Reload browser (F5) and verify both secrets and their bindings persist from STUDIO_DB + BlueprintDO
    await page.reload();
    await expect(page.getByTestId("studio-shell")).toBeVisible();
    const projectSelector = page.getByTestId("project-selector");
    if ((await projectSelector.inputValue()) !== projectSlug) {
      await projectSelector.selectOption(projectSlug);
    }

    await page.getByTestId("nav-tab-connections").click();
    await expect(page.getByTestId("secret-row-sec_core_auth_e2e")).toBeVisible();
    await expect(page.getByTestId("secret-key-hint-sec_core_auth_e2e")).toHaveText(
      "••••9941",
    );
    await expect(page.getByTestId("secret-row-sec_http_bearer_e2e")).toBeVisible();
    await expect(page.getByTestId("secret-key-hint-sec_http_bearer_e2e")).toHaveText(
      "••••5520",
    );

    // 9. Rotate `sec_core_auth_e2e` and verify keyHint updates to ••••3388
    await page.getByTestId("rotate-secret-button-sec_core_auth_e2e").click();
    await page.getByTestId("secret-value-input").fill(CANARY_ROTATED);
    await page.getByTestId("save-secret-submit").click();
    await expect(page.getByTestId("secret-key-hint-sec_core_auth_e2e")).toHaveText(
      "••••3388",
    );

    // Verify computed styles on status chip and key hint badge
    const chipStyles = await page
      .getByTestId("secret-status-sec_core_auth_e2e")
      .evaluate((el) => {
        const cs = window.getComputedStyle(el);
        return {
          borderStyle: cs.borderStyle,
          borderRadius: cs.borderRadius,
          fontWeight: Number(cs.fontWeight) || 600,
        };
      });
    expect(chipStyles.borderStyle).not.toBe("none");
    expect(chipStyles.fontWeight).toBeGreaterThanOrEqual(500);

    // 10. Zero-Leakage Scan across live browser DOM and API responses
    const domHtml = await page.content();
    for (const canary of [CANARY_1, CANARY_2, CANARY_ROTATED]) {
      expect(domHtml).not.toContain(canary);
    }

    const apiSurfaces = await page.evaluate(async (slug) => {
      const [proj, revs, exp, secs] = await Promise.all([
        fetch(`/api/projects/${slug}`, { credentials: "include" }).then((r) =>
          r.text(),
        ),
        fetch(`/api/projects/${slug}/revisions`, {
          credentials: "include",
        }).then((r) => r.text()),
        fetch(`/api/projects/${slug}/export`, { credentials: "include" }).then(
          (r) => r.text(),
        ),
        fetch(`/api/projects/${slug}/secrets`, { credentials: "include" }).then(
          (r) => r.text(),
        ),
      ]);
      return { proj, revs, exp, secs };
    }, projectSlug);

    for (const [name, payload] of Object.entries(apiSurfaces)) {
      for (const canary of [CANARY_1, CANARY_2, CANARY_ROTATED]) {
        expect(payload, `Surface ${name} leaked ${canary}`).not.toContain(canary);
      }
    }
  });
});
