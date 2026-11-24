import { expect, test } from "@playwright/test";
import { e2eProjectToken } from "./project-token.ts";

test.describe("Inline Validation, Multi-Step Undo/Redo, Canvas Visual Diff & Conflict Resolution (Real Backend)", () => {
  test("validates broken pills via Issues Drawer click-to-jump, executes multi-step Undo/Redo + Ledger Undo, renders Canvas Visual Diff overlay, and resolves Human + AI same-object conflicts", async ({
    page,
    request,
  }) => {
    await page.goto("/");

    // Sign in as owner against real Better Auth + STUDIO_DB
    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();

    // Create a dedicated empty project
    await page.getByTestId("new-project-button").click();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r0");
    const projectSlug = await page.getByTestId("project-selector").inputValue();
    expect(projectSlug).toMatch(/^project-\d+$/);

    // Enable multi-workspace brick so project has a base brick enabled
    const enableRes = await request.post(
      `http://127.0.0.1:8787/api/projects/${encodeURIComponent(projectSlug)}/ops`,
      {
        headers: {
          authorization: `Bearer ${await e2eProjectToken(projectSlug)}`,
          "content-type": "application/json",
        },
        data: {
          author: { type: "human", id: "alice" },
          summary: "Enable multi-workspace brick",
          ops: [
            {
              opId: "e2e-init-brick",
              type: "enable_brick",
              brickId: "multi-workspace",
              config: {},
            },
          ],
        },
      },
    );
    expect(enableRes.ok()).toBe(true);
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r1");

    // 1. Navigate to Workflows and create a workflow with Webhook Trigger + Noop + Format Template + HTTP Request
    await page.getByTestId("nav-tab-workflows").click();
    await expect(page.getByTestId("view-workflows")).toBeVisible();

    await page.getByTestId("new-workflow-button").click();
    await page.getByTestId("new-workflow-name-input").fill("Validation & Diff Flow");
    await page.getByTestId("create-workflow-confirm").click();

    const trigNodeId = "node-webhook-1";
    const noopNodeId = "node-noop-2";
    const tplNodeId = "node-format-template-3";
    const httpNodeId = "node-http-request-4";

    await page.getByTestId("palette-add-node-core.webhook").click();
    await expect(page.getByTestId(`canvas-node-${trigNodeId}`)).toBeVisible();

    await page.getByTestId("palette-add-node-core.noop").click();
    await expect(page.getByTestId(`canvas-node-${noopNodeId}`)).toBeVisible();

    await page.getByTestId("palette-add-node-core.format_template").click();
    await expect(page.getByTestId(`canvas-node-${tplNodeId}`)).toBeVisible();

    await page.getByTestId("palette-add-node-core.http_request").click();
    await expect(page.getByTestId(`canvas-node-${httpNodeId}`)).toBeVisible();

    // Wire trigNodeId -> noopNodeId -> tplNodeId -> httpNodeId
    const wireSource = page.getByTestId("wire-source-select");
    const wireTarget = page.getByTestId("wire-target-select");
    const wireConnectBtn = page.getByTestId("wire-connect-button");

    await wireSource.selectOption(`${trigNodeId}::out`);
    await wireTarget.selectOption(`${noopNodeId}::in`);
    await wireConnectBtn.click();

    await wireSource.selectOption(`${noopNodeId}::out`);
    await wireTarget.selectOption(`${tplNodeId}::in`);
    await wireConnectBtn.click();

    await wireSource.selectOption(`${tplNodeId}::out`);
    await wireTarget.selectOption(`${httpNodeId}::in`);
    await wireConnectBtn.click();

    // 2. Configure Format Template node to reference upstream `noopNodeId` (`{{steps.node-noop-2.output.out}}`) and save
    await page.getByTestId(`canvas-node-${tplNodeId}`).click();
    await expect(page.getByTestId("inspector-node-id")).toHaveText(tplNodeId);

    const rawToggle = page.getByTestId("toggle-raw-expression-template");
    if (await rawToggle.isVisible()) {
      await rawToggle.click();
      await page
        .getByTestId("raw-expression-input-template")
        .fill(`Hello {{steps.${noopNodeId}.output.out}}`);
    } else {
      await page
        .getByTestId("node-config-input-template")
        .fill(`Hello {{steps.${noopNodeId}.output.out}}`);
    }
    await page.getByTestId("inspector-node-save").click();
    await expect(page.getByTestId("inspector-node-saved-badge")).toBeVisible();

    // Delete `noopNodeId` and wire `trigNodeId -> tplNodeId` so `tplNodeId` now has a broken pill reference to deleted `noopNodeId`
    await page.getByTestId(`canvas-node-${noopNodeId}`).click();
    await page.getByTestId("delete-selected-button").click();

    await wireSource.selectOption(`${trigNodeId}::out`);
    await wireTarget.selectOption(`${tplNodeId}::in`);
    await wireConnectBtn.click();

    // Verify inline validation badge on canvas node + Top Bar Readiness badge shows 1 issue
    await expect(page.getByTestId(`inline-issue-badge-${tplNodeId}`)).toBeVisible();
    const readinessBadge = page.getByTestId("readiness-badge");
    await expect(readinessBadge).toContainText("1 issue");

    // Navigate to Overview, open Top Bar Issues Drawer, and click the issue to jump back to offending node & field
    await page.getByTestId("nav-tab-overview").click();
    await expect(page.getByTestId("view-overview")).toBeVisible();

    await readinessBadge.click();
    const issuesDrawer = page.getByTestId("studio-issues-drawer");
    await expect(issuesDrawer).toBeVisible();
    await expect(issuesDrawer).toContainText(noopNodeId);

    // Verify computed style of the Issues Drawer
    const drawerStyle = await issuesDrawer.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        bg: cs.backgroundColor,
        width: rect.width,
        height: rect.height,
      };
    });
    expect(drawerStyle.bg).toBe("rgb(15, 23, 42)");
    expect(drawerStyle.width).toBeGreaterThan(280);
    expect(drawerStyle.height).toBeGreaterThan(80);

    await page.getByTestId("issue-jump-item-0").click();
    await expect(page.getByTestId("view-workflows")).toBeVisible();
    await expect(page.getByTestId("inspector-node-id")).toHaveText(tplNodeId);
    await expect(page.getByTestId("inspector-highlighted-field")).toHaveAttribute(
      "data-field-key",
      "template",
    );

    // Fix the broken expression in the Inspector and save -> readiness badge transitions to Ready
    const rawInput = page.getByTestId("raw-expression-input-template");
    if (await rawInput.isVisible()) {
      await rawInput.fill("Hello clean template v1");
    } else {
      const toggleRawAgain = page.getByTestId("toggle-raw-expression-template");
      if (await toggleRawAgain.isVisible()) {
        await toggleRawAgain.click();
        await page
          .getByTestId("raw-expression-input-template")
          .fill("Hello clean template v1");
      } else {
        await page
          .getByTestId("node-config-input-template")
          .fill("Hello clean template v1");
      }
    }
    await page.getByTestId("inspector-node-save").click();
    await expect(readinessBadge).toContainText("Ready");

    // 3. Test Top Bar Undo / Redo + Ctrl+Z / Ctrl+Shift+Z
    const revBeforeUndo = await page.getByTestId("topbar-revision-badge").textContent();
    await page.getByTestId("topbar-undo-button").click();
    await expect(readinessBadge).toContainText("1 issue");
    await expect(page.getByTestId("topbar-redo-button")).toBeEnabled();

    await page.getByTestId("topbar-redo-button").click();
    await expect(readinessBadge).toContainText("Ready");
    await expect(page.getByTestId("topbar-undo-button")).toBeEnabled();
    expect(await page.getByTestId("topbar-revision-badge").textContent()).not.toBe(
      revBeforeUndo,
    );

    // Test keyboard Ctrl+Z and Ctrl+Shift+Z on window
    await page.locator("body").click({ position: { x: 10, y: 10 } });
    await page.keyboard.press("Control+z");
    await expect(readinessBadge).toContainText("1 issue");
    await expect(page.getByTestId("topbar-redo-button")).toBeEnabled();

    await page.keyboard.press("Control+Shift+Z");
    await expect(readinessBadge).toContainText("Ready");
    await expect(page.getByTestId("topbar-undo-button")).toBeEnabled();

    // 4. Visual Diff Overlay on the Workflow Canvas
    const revBeforeAiDiffText =
      (await page.getByTestId("topbar-revision-badge").textContent()) ?? "r10";
    const revBeforeAiDiff = Number(revBeforeAiDiffText.replace(/^r/, ""));

    // AI commits a revision that removes httpNodeId, adds node-ai-added, and updates tplNodeId
    const aiDiffRes = await request.post(
      `http://127.0.0.1:8787/api/projects/${encodeURIComponent(projectSlug)}/ops`,
      {
        headers: {
          authorization: `Bearer ${await e2eProjectToken(projectSlug)}`,
          "content-type": "application/json",
        },
        data: {
          author: { type: "agent", id: "claude-1", client: "Claude Desktop" },
          summary: "AI refactored workflow nodes",
          ops: [
            {
              opId: "ai-diff-2",
              type: "remove_node",
              workflowId: "wf-validation-diff-flow",
              nodeId: httpNodeId,
            },
            {
              opId: "ai-diff-3",
              type: "update_node",
              workflowId: "wf-validation-diff-flow",
              nodeId: tplNodeId,
              patch: {
                label: "Format Template v2",
                data: { template: "Hello AI updated template v2" },
              },
            },
            {
              opId: "ai-diff-4",
              type: "add_node",
              workflowId: "wf-validation-diff-flow",
              node: {
                id: "node-ai-added",
                type: "core.http_request",
                label: "AI Webhook Dispatch",
                data: { method: "post", timeoutMs: 5000, url: "https://ai.example.com/hook" },
              },
            },
            {
              opId: "ai-diff-5",
              type: "connect_edges",
              workflowId: "wf-validation-diff-flow",
              edges: [
                {
                  id: "e-tpl-ai-added",
                  source: tplNodeId,
                  target: "node-ai-added",
                  sourceHandle: "out",
                  targetHandle: "in",
                },
              ],
            },
          ],
        },
      },
    );
    expect(aiDiffRes.ok()).toBe(true);
    const aiDiffPayload = (await aiDiffRes.json()) as { revision: number };
    const revAfterAiDiff = aiDiffPayload.revision;
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText(
      `r${revAfterAiDiff}`,
    );

    // Open History & AI Change Ledger and click Compare on Canvas between revBeforeAiDiff and revAfterAiDiff
    await page.getByTestId("nav-tab-history").click();
    await expect(page.getByTestId("view-history")).toBeVisible();

    await page
      .getByTestId("diff-from-select")
      .selectOption(String(revBeforeAiDiff));
    await page.getByTestId("diff-to-select").selectOption(String(revAfterAiDiff));
    await page.getByTestId("compare-on-canvas-button").click();

    await expect(page.getByTestId("view-workflows")).toBeVisible();
    await expect(page.getByTestId("canvas-visual-diff-banner")).toBeVisible();

    // Verify + Added, - Removed (ghosted dashed), and ~ Changed badges on canvas
    await expect(page.getByTestId("diff-badge-added-node-ai-added")).toContainText(
      "+ Added",
    );
    await expect(page.getByTestId(`diff-badge-removed-${httpNodeId}`)).toContainText(
      "- Removed",
    );
    await expect(page.getByTestId(`diff-badge-changed-${tplNodeId}`)).toContainText(
      "~ Changed",
    );

    // Click ~ Changed node to inspect side-by-side field diff in Right Dock Inspector
    await page.getByTestId(`canvas-node-${tplNodeId}`).click();
    const sideBySide = page.getByTestId("inspector-node-side-by-side-diff");
    await expect(sideBySide).toBeVisible();
    await expect(sideBySide).toContainText("Hello clean template v1");
    await expect(sideBySide).toContainText("Hello AI updated template v2");

    // Exit Visual Diff mode
    await page.getByTestId("exit-canvas-visual-diff-button").click();
    await expect(page.getByTestId("canvas-visual-diff-banner")).toHaveCount(0);

    // 5. Human + AI Same-Object Conflict Resolution Card
    // Human edits `tplNodeId` in the Right Dock Inspector without saving yet (dirtyTarget)
    await page.getByTestId(`canvas-node-${tplNodeId}`).click();
    const tplRaw = page.getByTestId("raw-expression-input-template");
    if (await tplRaw.isVisible()) {
      await tplRaw.fill("Human draft template v3");
    } else {
      const toggleBtn = page.getByTestId("toggle-raw-expression-template");
      if (await toggleBtn.isVisible()) {
        await toggleBtn.click();
        await page
          .getByTestId("raw-expression-input-template")
          .fill("Human draft template v3");
      } else {
        await page
          .getByTestId("node-config-input-template")
          .fill("Human draft template v3");
      }
    }

    // Concurrently, AI commits a conflicting update to the same node (`tplNodeId`)
    const conflictRes = await request.post(
      `http://127.0.0.1:8787/api/projects/${encodeURIComponent(projectSlug)}/ops`,
      {
        headers: {
          authorization: `Bearer ${await e2eProjectToken(projectSlug)}`,
          "content-type": "application/json",
        },
        data: {
          author: { type: "agent", id: "claude-1", client: "Claude Desktop" },
          summary: "AI concurrent edit to Format Template",
          ops: [
            {
              opId: "ai-conflict-1",
              type: "update_node",
              workflowId: "wf-validation-diff-flow",
              nodeId: tplNodeId,
              patch: {
                data: {
                  template: "AI concurrent template v3",
                },
              },
            },
          ],
        },
      },
    );
    expect(conflictRes.ok()).toBe(true);

    // Same-Object Conflict Card appears in the Right Dock Inspector
    const conflictCard = page.getByTestId("same-object-conflict-card");
    await expect(conflictCard).toBeVisible();
    await expect(conflictCard).toContainText("Human draft template v3");
    await expect(conflictCard).toContainText("AI concurrent template v3");

    // Resolve via Keep mine and verify persistence across reload
    await page.getByTestId("conflict-keep-mine-button").click();
    await expect(conflictCard).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await page.getByTestId("project-selector").selectOption(projectSlug);
    await page.getByTestId("nav-tab-workflows").click();
    await page.getByTestId(`canvas-node-${tplNodeId}`).click();
    await expect(page.getByTestId("inspector-node-detail")).toContainText(
      "Human draft template v3",
    );
  });
});
