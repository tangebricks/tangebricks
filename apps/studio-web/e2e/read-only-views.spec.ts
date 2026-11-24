import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

// Story 0.11: brick tiers are derived honestly and recorded in evidence/brick-tiers.json. The badges must show exactly
// that tier, so the expected text is read from the evidence rather than hard-coded.
const brickTiers = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../evidence/brick-tiers.json"), "utf8")) as {
    bricks: Array<{ id: string; tier: "production" | "beta" | "experimental" }>;
  }
).bricks;
const TIER_BADGE = { production: "Production ✓", beta: "Beta ◆", experimental: "Experimental ⚠" } as const;
function tierBadge(brickId: string): string {
  const entry = brickTiers.find((b) => b.id === brickId);
  if (!entry) throw new Error(`${brickId} is not in evidence/brick-tiers.json`);
  return TIER_BADGE[entry.tier];
}

test.describe("CP2 Read-Only Studio Views End-to-End Verification", () => {
  test("verifies compiled Tailwind tokens, 3-panel horizontal layout, F5 session restoration, Overview Backend Map, Bricks with maturity badges, Entities DDL preview, Workflow Canvas, and History/Semantic Diff Drawer", async ({
    page,
  }) => {
    await page.goto("/");

    // Verify compiled Tailwind CSS base background token (#020617 -> rgb(2, 6, 23))
    const bodyBg = await page.evaluate(
      () => window.getComputedStyle(document.body).backgroundColor,
    );
    expect(bodyBg).toBe("rgb(2, 6, 23)");

    // Sign in as owner
    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();

    // Verify Top Bar computed height is 56px and 3-panel shell lays out horizontally with non-zero bounding boxes (AC 1)
    const layoutMetrics = await page.evaluate(() => {
      const topbar = document.querySelector('[data-testid="studio-topbar"]');
      const leftNav = document.querySelector('[data-testid="studio-left-nav"]');
      const mainArea = document.querySelector('[data-testid="main-area"]');
      const rightDock = document.querySelector('[data-testid="right-dock"]');
      if (!topbar || !leftNav || !mainArea || !rightDock) return null;
      return {
        topbarHeight: window.getComputedStyle(topbar).height,
        leftBox: leftNav.getBoundingClientRect(),
        mainBox: mainArea.getBoundingClientRect(),
        rightBox: rightDock.getBoundingClientRect(),
      };
    });
    expect(layoutMetrics).not.toBeNull();
    expect(layoutMetrics!.topbarHeight).toBe("56px");
    expect(layoutMetrics!.leftBox.width).toBeGreaterThan(200);
    expect(layoutMetrics!.mainBox.width).toBeGreaterThan(400);
    expect(layoutMetrics!.rightBox.width).toBeGreaterThan(200);
    expect(layoutMetrics!.leftBox.x).toBeLessThan(layoutMetrics!.mainBox.x);
    expect(layoutMetrics!.mainBox.x).toBeLessThan(layoutMetrics!.rightBox.x);

    await page.getByTestId("project-selector").selectOption("acme-saas");

    // 1. Overview & Backend Map
    await expect(page.getByTestId("overview-backend-map")).toBeVisible();
    await expect(page.getByTestId("backend-map-brick-card-credit-wallet")).toBeVisible();
    await expect(page.getByTestId("backend-map-entity-card-invoices")).toBeVisible();
    await expect(page.getByTestId("backend-map-workflow-card-wf-billing")).toBeVisible();

    // Verify F5 page reload keeps user signed in and restores the active project (AC 5)
    await page.reload();
    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await expect(page.getByTestId("overview-backend-map")).toBeVisible();
    await expect(page.getByTestId("backend-map-brick-card-credit-wallet")).toBeVisible();

    // Toggle Accessible Outline View on Backend Map
    await page.getByTestId("backend-map-outline-toggle").click();
    await expect(
      page.getByRole("region", { name: "Backend Map Outline" }),
    ).toBeVisible();

    // 2. Bricks View & Maturity Badges (Production, Beta, Experimental)
    await page.getByTestId("nav-tab-bricks").click();
    await expect(page.getByTestId("view-bricks")).toBeVisible();
    // One enabled brick of each honest tier present on acme-saas: dynamic-entities (Production), credit-wallet (Beta)
    expect(tierBadge("dynamic-entities")).toBe("Production ✓");
    await expect(
      page.getByTestId("enabled-brick-maturity-dynamic-entities"),
    ).toHaveText(tierBadge("dynamic-entities"));
    await expect(
      page.getByTestId("enabled-brick-maturity-credit-wallet"),
    ).toHaveText(tierBadge("credit-wallet"));
    await expect(
      page.getByTestId("catalog-brick-maturity-document-parsing"),
    ).toHaveText(tierBadge("document-parsing"));

    // Experimental bricks hidden by default until toggled
    await expect(
      page.getByTestId("catalog-brick-card-scripting-sandbox"),
    ).toHaveCount(0);
    await page.getByTestId("bricks-experimental-toggle").click();
    expect(tierBadge("scripting-sandbox")).toBe("Experimental ⚠");
    await expect(
      page.getByTestId("catalog-brick-maturity-scripting-sandbox"),
    ).toHaveText(tierBadge("scripting-sandbox"));

    // Clicking a brick opens its read-only Inspector
    await page.getByTestId("enabled-brick-card-credit-wallet").click();
    await expect(page.getByTestId("inspector-brick-detail")).toBeVisible();

    // 3. Data (Entities) View
    await page.getByTestId("nav-tab-data").click();
    await expect(page.getByTestId("view-data")).toBeVisible();
    await expect(page.getByTestId("entity-list-item-invoices")).toBeVisible();
    await expect(page.getByTestId("entity-sql-ddl-code")).toContainText(
      'CREATE TABLE IF NOT EXISTS "ent_invoices"',
    );

    // 4. Workflows Canvas View
    await page.getByTestId("nav-tab-workflows").click();
    await expect(page.getByTestId("view-workflows")).toBeVisible();
    await expect(page.getByTestId("workflow-reactflow-canvas")).toBeVisible();
    await page.getByTestId("canvas-node-node-pick").dispatchEvent("click");
    await expect(page.getByTestId("inspector-node-id")).toHaveText("node-pick");

    // 5. History View & Semantic Diff Drawer
    await page.getByTestId("nav-tab-history").click();
    await expect(page.getByTestId("view-history")).toBeVisible();
    await expect(page.getByTestId("ledger-entry-2")).toBeVisible();
    await page.getByTestId("view-diff-rev-2").click();
    await expect(page.getByTestId("semantic-diff-viewer")).toBeVisible();
    await expect(page.getByTestId("semantic-diff-range")).toHaveText("r1 → r2");
  });
});
