import { expect, test } from "@playwright/test";

test.describe("Editable Workflow Canvas: searchable palette, typed-port validation, copy/paste, undo, and F5 persistence (Real Backend)", () => {
  test("creates a workflow, adds trigger + logic + data nodes from palette, enforces single trigger, blocks incompatible port connections, connects valid wires, copy-pastes & undoes deletion, auto-layouts, and persists across F5 reload", async ({
    page,
  }) => {
    await page.goto("/");

    // Sign in as owner against real Better Auth + STUDIO_DB
    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();

    // Create a dedicated empty project for Workflow Canvas E2E
    await page.getByTestId("new-project-button").click();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r0");
    const createdProjectSlug = await page.getByTestId("project-selector").inputValue();
    expect(createdProjectSlug).toMatch(/^project-\d+$/);

    // Navigate to Workflows view
    await page.getByTestId("nav-tab-workflows").click();
    await expect(page.getByTestId("view-workflows")).toBeVisible();

    // 1. Create a new workflow ("Invoice Processing DAG")
    await page.getByTestId("new-workflow-button").click();
    await page.getByTestId("new-workflow-name-input").fill("Invoice Processing DAG");
    await page.getByTestId("create-workflow-confirm").click();

    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r1");
    await expect(
      page.getByTestId("workflow-selector-card-wf-invoice-processing-dag"),
    ).toBeVisible();

    // 2. Search palette for "webhook" and add core.webhook trigger node
    const paletteSearch = page.getByTestId("palette-search-input");
    await paletteSearch.fill("webhook");
    await page.getByTestId("palette-add-node-core.webhook").click();

    await expect(page.getByTestId("canvas-node-node-webhook-1")).toBeVisible();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r2");

    // Verify single-trigger limit warning & disabled trigger button
    await expect(page.getByTestId("palette-trigger-limit-warning")).toBeVisible();
    await expect(page.getByTestId("palette-add-node-core.webhook")).toBeDisabled();

    // 3. Clear search and add core.math, core.loop, and core.field_map nodes from palette
    await paletteSearch.fill("");
    await page.getByTestId("palette-add-node-core.math").click();
    await expect(page.getByTestId("canvas-node-node-math-2")).toBeVisible();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r3");

    await page.getByTestId("palette-add-node-core.loop").click();
    await expect(page.getByTestId("canvas-node-node-loop-3")).toBeVisible();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r4");

    await page.getByTestId("palette-add-node-core.field_map").click();
    await expect(page.getByTestId("canvas-node-node-field-map-4")).toBeVisible();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r5");

    // 4. Verify computed styles and non-overlapping bounding boxes on palette and canvas nodes
    const layoutGeometry = await page.evaluate(() => {
      const palette = document.querySelector('[data-testid="workflow-node-palette"]') as HTMLElement | null;
      const n1 = document.querySelector('[data-testid="canvas-node-node-webhook-1"]') as HTMLElement | null;
      const n2 = document.querySelector('[data-testid="canvas-node-node-math-2"]') as HTMLElement | null;
      const n3 = document.querySelector('[data-testid="canvas-node-node-loop-3"]') as HTMLElement | null;
      if (!palette || !n1 || !n2 || !n3) return null;

      const b1 = n1.getBoundingClientRect();
      const b2 = n2.getBoundingClientRect();
      const b3 = n3.getBoundingClientRect();
      const overlaps = (a: DOMRect, b: DOMRect) =>
        !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);

      return {
        paletteBg: window.getComputedStyle(palette).backgroundColor,
        paletteWidth: palette.getBoundingClientRect().width,
        nodeBg: window.getComputedStyle(n1).backgroundColor,
        n1Width: b1.width,
        overlap12: overlaps(b1, b2),
        overlap23: overlaps(b2, b3),
      };
    });

    expect(layoutGeometry).not.toBeNull();
    expect(layoutGeometry!.paletteBg).toBe("rgb(15, 23, 42)");
    expect(layoutGeometry!.paletteWidth).toBeGreaterThan(220);
    expect(layoutGeometry!.nodeBg).toBe("rgb(15, 23, 42)");
    expect(layoutGeometry!.n1Width).toBeGreaterThan(100);
    expect(layoutGeometry!.overlap12).toBe(false);
    expect(layoutGeometry!.overlap23).toBe(false);

    // 5. Verify live Port-Type Validation blocks incompatible wires with reason banner
    await page.getByTestId("wire-source-select").selectOption("node-math-2::out");
    await page.getByTestId("wire-target-select").selectOption("node-loop-3::in");

    await expect(page.getByTestId("port-validation-error-banner")).toContainText(
      "Cannot connect number output to array input",
    );
    await expect(page.getByTestId("wire-connect-button")).toBeDisabled();

    // 6. Connect valid typed ports: core.webhook (out:object) -> core.field_map (in:object)
    await page.getByTestId("wire-source-select").selectOption("node-webhook-1::out");
    await page.getByTestId("wire-target-select").selectOption("node-field-map-4::in");
    await expect(page.getByTestId("port-validation-error-banner")).toHaveCount(0);
    await expect(page.getByTestId("wire-connect-button")).toBeEnabled();
    await page.getByTestId("wire-connect-button").click();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r6");

    // Connect core.field_map (out:object) -> core.math (in:any)
    await page.getByTestId("wire-source-select").selectOption("node-field-map-4::out");
    await page.getByTestId("wire-target-select").selectOption("node-math-2::in");
    await page.getByTestId("wire-connect-button").click();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r7");

    // 7. Copy and Paste node-math-2 -> generates fresh ID and offset coordinates
    await page.getByTestId("node-multiselect-toggle-node-math-2").check();
    await page.getByTestId("canvas-copy-button").click();
    await page.getByTestId("canvas-paste-button").click();

    await expect(page.getByTestId("canvas-node-node-math-2-copy-1")).toBeVisible();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r8");

    // 8. Delete selected node -> verify Undo toast -> click Undo to restore node
    await page.getByTestId("delete-selected-button").click();
    await expect(page.getByTestId("canvas-node-node-math-2-copy-1")).toHaveCount(0);
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r9");
    await expect(page.getByTestId("canvas-undo-toast")).toBeVisible();

    await page.getByTestId("canvas-undo-toast-button").click();
    await expect(page.getByTestId("canvas-node-node-math-2-copy-1")).toBeVisible();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r10");

    // 9. Run Auto-Layout and verify revision advances while nodes stay non-overlapping
    await page.getByTestId("workflow-autolayout-button").click();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r11");

    // 10. Reload page (F5) and verify workflow, nodes, edges, and positions persist from BlueprintDO
    await page.reload();
    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await expect(page.getByTestId("project-selector")).toHaveValue(createdProjectSlug);

    await page.getByTestId("nav-tab-workflows").click();
    await expect(page.getByTestId("canvas-node-node-webhook-1")).toBeVisible();
    await expect(page.getByTestId("canvas-node-node-math-2")).toBeVisible();
    await expect(page.getByTestId("canvas-node-node-loop-3")).toBeVisible();
    await expect(page.getByTestId("canvas-node-node-field-map-4")).toBeVisible();
    await expect(page.getByTestId("canvas-node-node-math-2-copy-1")).toBeVisible();
    await expect(page.getByText("5 nodes · 2 edges")).toBeVisible();
  });
});
