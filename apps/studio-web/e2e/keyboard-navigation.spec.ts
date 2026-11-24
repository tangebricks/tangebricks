import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signInViaKeyboard(page: Page) {
  await page.goto("/");
  const authScreen = page.getByTestId("auth-screen");
  const shell = page.getByTestId("studio-shell");
  await expect(authScreen.or(shell)).toBeVisible({ timeout: 15_000 });

  if (await authScreen.isVisible()) {
    const emailInput = page.getByTestId("auth-email-input");
    await emailInput.focus();
    await page.keyboard.type("alice@example.com");
    await page.keyboard.press("Tab");
    await page.keyboard.type("password12345");
    await page.keyboard.press("Enter");
  }

  await expect(shell).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("overview-backend-map")).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("Story 8.3 — Full Keyboard-Only Navigation & Canvas Flow", () => {
  test("AC 2 & AC 3: completes Command Palette focus trap, node creation, 'Connect to...' port wiring, Arrow traversal, Inspector Test Step, Alt+O Outline View, and Delete + Undo without mouse clicks", async ({
    page,
  }) => {
    await signInViaKeyboard(page);

    // 1. Focus trigger element, open Command Palette (Ctrl+K), verify Tab focus trap, and Escape restores focus
    const overviewTab = page.getByTestId("nav-tab-overview");
    await overviewTab.focus();
    await expect(overviewTab).toBeFocused();

    await page.keyboard.press("Control+k");
    const cmdModal = page.getByTestId("command-palette-modal");
    const cmdInput = page.getByTestId("command-palette-input");
    const cmdClose = page.getByTestId("command-palette-close");
    await expect(cmdModal).toBeVisible();
    await expect(cmdInput).toBeFocused();

    // Tab traps focus inside command-palette-modal
    await page.keyboard.press("Tab");
    await expect(cmdClose).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(cmdInput).toBeFocused();

    // Escape closes modal and restores focus to trigger element
    await page.keyboard.press("Escape");
    await expect(cmdModal).toBeHidden();
    await expect(overviewTab).toBeFocused();

    // Create a dedicated empty project via keyboard so shared seeded projects remain untouched
    const newProjectBtn = page.getByTestId("new-project-button");
    await newProjectBtn.focus();
    await expect(newProjectBtn).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r0");

    // 2. Re-open Command Palette (Ctrl+K) and navigate to Workflows view via keyboard
    await page.keyboard.press("Control+k");
    await expect(cmdInput).toBeFocused();
    await page.keyboard.type("Switch to Workflows View");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("view-workflows")).toBeVisible();

    // 3. Create a dedicated workflow for the keyboard-only canvas flow
    const newWfBtn = page.getByTestId("new-workflow-button");
    await newWfBtn.focus();
    await page.keyboard.press("Enter");

    const wfNameInput = page.getByTestId("new-workflow-name-input");
    await wfNameInput.focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("Keyboard Only Flow");
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("create-workflow-confirm")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(wfNameInput).toBeHidden();

    // 4. Add a Trigger node ("core.webhook") via Node Palette search + Enter
    const paletteSearch = page.getByTestId("palette-search-input");
    await paletteSearch.focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("core.webhook");
    await page.keyboard.press("Enter");

    const triggerNode = page.getByTestId("canvas-node-node-webhook-1");
    await expect(triggerNode).toBeVisible();

    // 5. Add an Action node ("core.http_request") via Node Palette search + Enter
    await paletteSearch.focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("core.http_request");
    await page.keyboard.press("Enter");

    const actionNode = page.getByTestId("canvas-node-node-http-request-2");
    await expect(actionNode).toBeVisible();

    // 6. Focus Trigger node on canvas, press 'C' to open "Connect to..." port menu
    await triggerNode.focus();
    await expect(triggerNode).toBeFocused();
    await page.keyboard.press("c");

    const connectMenu = page.getByTestId("keyboard-connect-to-menu");
    await expect(connectMenu).toBeVisible();

    // Verify incompatible port option is disabled and shows type-mismatch reason
    const incompatibleOption = page.getByTestId(
      "connect-to-option-node-http-request-2-strict_number",
    );
    await expect(incompatibleOption).toBeDisabled();
    await expect(incompatibleOption).toHaveAttribute("aria-disabled", "true");
    await expect(
      page.getByTestId(
        "connect-to-incompatible-reason-node-http-request-2-strict_number",
      ),
    ).toContainText(/Cannot connect .* output to number input/i);

    // Compatible port option is focused; press Enter to wire the edge
    const compatibleOption = page.getByTestId(
      "connect-to-option-node-http-request-2-in",
    );
    await expect(compatibleOption).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(connectMenu).toBeHidden();

    // Verify aria-live polite announcement of connection
    await expect(page.getByTestId("studio-aria-live-region")).toContainText(
      /Connected .* to/i,
    );

    // 7. Traverse connected nodes on canvas using ArrowRight and ArrowLeft
    await triggerNode.focus();
    await page.keyboard.press("ArrowRight");
    await expect(actionNode).toBeFocused();

    await page.keyboard.press("ArrowLeft");
    await expect(triggerNode).toBeFocused();

    await page.keyboard.press("ArrowRight");
    await expect(actionNode).toBeFocused();

    // 8. Press Enter on Action node to move focus into the Inspector, edit Params, switch to I/O & Test Step, and run Test Step
    await page.keyboard.press("Enter");
    const paramsTab = page.getByTestId("inspector-node-tab-params");
    await expect(paramsTab).toBeFocused();

    // Edit URL field in Params
    const urlInput = page.getByTestId("node-config-input-url");
    await urlInput.focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("https://api.example.com/v1/charge");
    const saveNodeBtn = page.getByTestId("inspector-node-save");
    await saveNodeBtn.focus();
    await page.keyboard.press("Enter");

    // Switch to I/O & Test Step tab via ArrowRight on the subtab bar
    await paramsTab.focus();
    await page.keyboard.press("ArrowRight");
    const ioTab = page.getByTestId("inspector-node-tab-io");
    await expect(ioTab).toBeFocused();

    // Run Test Step via Enter on run-test-step-button and focus output preview
    const runTestBtn = page.getByTestId("run-test-step-button");
    await runTestBtn.focus();
    await page.keyboard.press("Enter");

    const outputPreview = page.getByTestId("test-step-output-preview");
    await expect(outputPreview).toBeVisible({ timeout: 10_000 });
    await outputPreview.focus();
    await expect(outputPreview).toBeFocused();

    // 9. Toggle Accessible Outline View via Alt+O, navigate steps, and press Enter to focus Inspector
    await page.keyboard.press("Alt+o");
    const outlineRegion = page.getByTestId("workflow-outline-region");
    await expect(outlineRegion).toBeVisible();

    const outlineStep1 = page.getByTestId(
      "workflow-outline-step-node-webhook-1",
    );
    const outlineStep2 = page.getByTestId(
      "workflow-outline-step-node-http-request-2",
    );
    await outlineStep1.focus();
    await expect(outlineStep1).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(outlineStep2).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("inspector-node-id")).toHaveText(
      "node-http-request-2",
    );

    // Toggle Outline View off via Alt+O
    await page.keyboard.press("Alt+o");
    await expect(outlineRegion).toBeHidden();

    // 10. Focus Action node on canvas, press Delete to remove it, and press Ctrl+Z to undo
    await actionNode.focus();
    await page.keyboard.press("Delete");
    await expect(page.getByTestId("canvas-undo-toast")).toBeVisible();
    await expect(actionNode).toBeHidden();

    await page.keyboard.press("Control+z");
    await expect(actionNode).toBeVisible({ timeout: 10_000 });
  });
});
