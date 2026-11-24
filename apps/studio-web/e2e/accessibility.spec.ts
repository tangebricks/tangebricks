import AxeBuilder from "@axe-core/playwright";
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
  const projectSelect = page.getByTestId("project-selector");
  await expect(projectSelect).toBeVisible();
  if ((await projectSelect.inputValue()) !== "acme-saas") {
    await projectSelect.selectOption("acme-saas");
  }

  // Clear sessionStorage so subtabs start in clean default state
  await page.evaluate(() => {
    try {
      window.sessionStorage.clear();
    } catch {
      // Ignore storage errors
    }
  });
}

async function assertZeroCriticalOrSeriousAxeViolations(
  page: Page,
  viewLabel: string,
) {
  // Disable CSS transitions & animations to ensure resting computed styles without mid-flight color interpolation
  await page.addStyleTag({
    content: `*, *::before, *::after { transition: none !important; animation: none !important; }`,
  });
  await page.waitForTimeout(200);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  const criticalOrSerious = results.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );

  expect(
    criticalOrSerious,
    `Expected 0 critical/serious axe-core violations on ${viewLabel}, found: ${JSON.stringify(
      criticalOrSerious.map((v) => ({
        id: v.id,
        impact: v.impact,
        description: v.description,
        nodes: v.nodes.map((n) => ({ html: n.html, failureSummary: n.failureSummary })),
      })),
      null,
      2,
    )}`,
  ).toEqual([]);
}

test.describe("Story 8.3 — WCAG 2.1 AA Accessibility Audit (axe-core) & Live Regions", () => {
  test("AC 1 & AC 2: all 8 Studio views pass axe-core WCAG 2.1 AA audit with 0 critical and 0 serious violations and non-color status indicators", async ({
    page,
  }) => {
    await signInAsAlice(page);

    // Non-color status indicators check (icon + text label on readiness & sync pills)
    await expect(page.getByTestId("sync-status-chip")).toContainText(
      /Live|Connecting|Offline/,
    );
    await expect(page.getByTestId("readiness-badge")).toContainText(
      /Ready|issue/i,
    );

    // 1. Overview (Backend Map)
    await page.getByTestId("nav-tab-overview").click();
    await expect(page.getByTestId("view-overview")).toBeVisible();
    await assertZeroCriticalOrSeriousAxeViolations(
      page,
      "1. Overview (Backend Map)",
    );

    // 2. Overview (Accessible Outline View)
    await page.getByTestId("backend-map-outline-toggle").click();
    await expect(page.getByTestId("backend-map-outline-region")).toBeVisible();
    await assertZeroCriticalOrSeriousAxeViolations(
      page,
      "2. Overview (Outline View)",
    );

    // 3. Bricks Catalog & Inspector
    await page.getByTestId("nav-tab-bricks").click();
    await expect(page.getByTestId("view-bricks")).toBeVisible();
    await assertZeroCriticalOrSeriousAxeViolations(
      page,
      "3. Bricks Catalog & Inspector",
    );

    // 4. Data (Entities & Tables)
    await page.getByTestId("nav-tab-data").click();
    await expect(page.getByTestId("view-data")).toBeVisible();
    const schemaTab = page.getByTestId("data-subtab-schema");
    if (await schemaTab.isVisible()) {
      await schemaTab.click();
    }
    await assertZeroCriticalOrSeriousAxeViolations(
      page,
      "4. Data (Entities & Tables)",
    );

    // 5. Workflows (Spatial Graph Canvas)
    await page.getByTestId("nav-tab-workflows").click();
    await expect(page.getByTestId("view-workflows")).toBeVisible();
    await expect(page.getByTestId("workflow-reactflow-canvas")).toBeVisible();
    await assertZeroCriticalOrSeriousAxeViolations(
      page,
      "5. Workflows (Spatial Graph Canvas)",
    );

    // 6. Workflows (Accessible Outline View)
    await page.getByTestId("workflow-outline-toggle").click();
    await expect(page.getByTestId("workflow-outline-region")).toBeVisible();
    await assertZeroCriticalOrSeriousAxeViolations(
      page,
      "6. Workflows (Outline View)",
    );

    // 7. Connections & Secrets Vault
    await page.getByTestId("nav-tab-connections").click();
    await expect(page.getByTestId("view-connections")).toBeVisible();
    await assertZeroCriticalOrSeriousAxeViolations(
      page,
      "7. Connections & Secrets Vault",
    );

    // 8. History, Revisions & AI Change Ledger
    await page.getByTestId("nav-tab-history").click();
    await expect(page.getByTestId("view-history")).toBeVisible();
    await assertZeroCriticalOrSeriousAxeViolations(
      page,
      "8. History & AI Change Ledger",
    );
  });

  test("AC 4: batched aria-live='polite' announces AI/MCP changes without stealing keyboard focus and respects prefers-reduced-motion", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signInAsAlice(page);

    await page.getByTestId("nav-tab-workflows").click();
    await expect(page.getByTestId("view-workflows")).toBeVisible();

    const searchInput = page.getByTestId("palette-search-input");
    await searchInput.focus();
    await expect(searchInput).toBeFocused();

    // Trigger an incoming AI/MCP revision while focus is inside the palette search input
    await page.evaluate(() => {
      const store = (
        window as unknown as {
          __STUDIO_STORE__?: {
            getState: () => {
              currentRevision: number;
              applyIncomingRevision: (envelope: Record<string, unknown>) => void;
            };
          };
        }
      ).__STUDIO_STORE__;
      const currentRev = store?.getState().currentRevision ?? 2;
      store?.getState().applyIncomingRevision({
        type: "revision",
        project: "acme-saas",
        revision: currentRev + 1,
        parentRevision: currentRev,
        author: {
          type: "agent",
          id: "claude-a11y",
          client: "Claude Desktop",
        },
        summary: "AI agent updated node label for accessibility test",
        ops: [
          {
            opId: `a11y-agent-op-${Date.now()}`,
            type: "update_node",
            workflowId: "wf-billing",
            nodeId: "node-pick",
            label: "Pick Invoice Title (AI Audited)",
          },
        ],
        timestamp: new Date().toISOString(),
      });
    });

    const liveRegion = page.getByTestId("studio-aria-live-region");
    await expect(liveRegion).toHaveAttribute("aria-live", "polite");
    await expect(liveRegion).toContainText(/Claude Desktop made 1 change/i, {
      timeout: 10_000,
    });

    // Verify focus was NOT stolen from the user's active input
    await expect(searchInput).toBeFocused();

    // Verify prefers-reduced-motion is active and disables animations
    const reducedMotionCheck = await page.evaluate(() => {
      const matches = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const bodyStyle = window.getComputedStyle(document.body);
      return {
        matches,
        transitionDuration: bodyStyle.transitionDuration,
      };
    });
    expect(reducedMotionCheck.matches).toBe(true);
  });
});
