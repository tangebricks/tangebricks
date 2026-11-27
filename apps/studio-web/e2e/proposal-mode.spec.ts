import { expect, test } from "@playwright/test";
import { E2E_MCP_TOKEN } from "./global-setup.ts";

test.describe("Story 7.2 — Draft Branch / Proposal Mode, Visual Diff Review & Unified Activity Feed (Real Backend)", () => {
  test("renders added/modified/removed visual diff across Canvas + Bricks + Entities + Inspector, enforces per-op dependency validation, commits partial accept, rejects a second proposal, survives F5 reload, and filters Unified Activity Feed by human vs agent", async ({
    page,
  }) => {
    await page.goto("/");

    // 1. Sign in as Alice (Owner) against real Better Auth + STUDIO_DB
    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await expect(page.getByTestId("project-selector")).toHaveValue("acme-saas");
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText(/^r\d+$/);
    const initBadgeText = await page.getByTestId("topbar-revision-badge").textContent();
    const baseRev = Number((initBadgeText ?? "r2").replace("r", ""));
    const rPlus1 = baseRev + 1;
    const rPlus2 = baseRev + 2;

    // 2. Commit next revision as human Alice adding `node-legacy` to `wf-billing` so the agent proposal can propose removing it
    const r3Res = await page.request.post("/api/projects/acme-saas/ops", {
      data: {
        baseRevision: baseRev,
        author: { type: "human", id: "alice" },
        summary: "Add legacy transform node to wf-billing",
        ops: [
          {
            opId: "r3-add-legacy",
            type: "add_node",
            workflowId: "wf-billing",
            node: {
              id: "node-legacy",
              type: "transform.pick",
              label: "Legacy Audit Node",
              data: { path: "legacy_field" },
            },
          },
          {
            opId: "r3-connect-legacy",
            type: "connect_edges",
            workflowId: "wf-billing",
            edges: [
              {
                id: "edge-legacy",
                source: "node-pick",
                target: "node-legacy",
                sourceHandle: "out",
                targetHandle: "in",
              },
            ],
          },
        ],
      },
    });
    expect(r3Res.status()).toBe(200);
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText(`r${rPlus1}`);

    // Switch to Workflows canvas view and confirm baseline r3 nodes
    await page.getByTestId("nav-tab-workflows").click();
    await expect(page.getByTestId("canvas-node-node-trigger")).toBeVisible();
    await expect(page.getByTestId("canvas-node-node-pick")).toBeVisible();
    await expect(page.getByTestId("canvas-node-node-legacy")).toBeVisible();

    // 3. Agent submits Proposal #1 via real MCP JSON-RPC `/mcp` with `mode: "propose"`
    // Includes 4 ops: add_node (`node-added`), update_node (`node-pick`), remove_node (`node-legacy`), connect_edges (`edge-added`)
    const mcpRes1 = await page.request.post("/mcp", {
      headers: {
        authorization: `Bearer ${E2E_MCP_TOKEN}`,
        "content-type": "application/json",
        "x-mcp-client-id": "agent:claude-code",
        "x-mcp-client-name": "Claude Desktop",
      },
      data: {
        jsonrpc: "2.0",
        id: 702,
        method: "tools/call",
        params: {
          name: "apply_ops",
          arguments: {
            project: "acme-saas",
            baseRev: rPlus1,
            mode: "propose",
            summary: "Add node-added, update node-pick, and remove node-legacy",
            ops: [
              {
                opId: "prop-add-node",
                type: "add_node",
                workflowId: "wf-billing",
                node: {
                  id: "node-added",
                  type: "transform.pick",
                  label: "Calculate Invoice Tax",
                  data: { path: "amount_cents" },
                },
              },
              {
                opId: "prop-update-node",
                type: "update_node",
                workflowId: "wf-billing",
                nodeId: "node-pick",
                data: { path: "invoice.normalized_title" },
              },
              {
                opId: "prop-remove-node",
                type: "remove_node",
                workflowId: "wf-billing",
                nodeId: "node-legacy",
              },
              {
                opId: "prop-connect-edge",
                type: "connect_edges",
                workflowId: "wf-billing",
                edges: [
                  {
                    id: "edge-added",
                    source: "node-pick",
                    target: "node-added",
                    sourceHandle: "out",
                    targetHandle: "in",
                  },
                ],
              },
            ],
          },
        },
      },
    });
    expect(mcpRes1.status()).toBe(200);
    const mcpRpc1 = (await mcpRes1.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(mcpRpc1.result.isError).not.toBe(true);
    const proposalPayload1 = JSON.parse(mcpRpc1.result.content[0]!.text) as {
      proposalId: string;
      status: string;
      revision: number;
    };
    expect(proposalPayload1.status).toBe("pending");
    expect(proposalPayload1.revision).toBe(rPlus1);

    // 4. Mainline revision badge remains while proposal is pending, and WS broadcast surfaces Pending Proposals Banner
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText(`r${rPlus1}`);
    await expect(page.getByTestId("pending-proposals-banner")).toBeVisible({
      timeout: 5000,
    });

    // 5. Click "Review Visual Diff" -> enters Visual Diff Review Mode
    await page.getByTestId("review-latest-proposal-button").click();
    await expect(page.getByTestId("proposal-review-bar")).toBeVisible();
    await expect(page.getByTestId("proposal-accept-selected")).toContainText("Accept selected (4/4)");

    // Verify added node (+ Added), modified node (~ Changed), and removed node (- Removed) on canvas
    const addedNode = page.getByTestId("canvas-node-node-added");
    const modifiedNode = page.getByTestId("canvas-node-node-pick");

    await expect(addedNode).toBeVisible();
    await expect(page.getByTestId("diff-badge-added-node-added")).toHaveText("+ Added");
    await expect(page.getByTestId("diff-badge-changed-node-pick")).toHaveText("~ Changed");
    await expect(page.getByTestId("diff-badge-removed-node-legacy")).toHaveText("- Removed");

    // Verify computed visual styles (border colors + strikethrough on removed node label)
    const styles = await page.evaluate(() => {
      const addedEl = document.querySelector('[data-testid="canvas-node-node-added"]') as HTMLElement | null;
      const modifiedEl = document.querySelector('[data-testid="canvas-node-node-pick"]') as HTMLElement | null;
      const removedEl = document.querySelector('[data-testid="canvas-node-node-legacy"]') as HTMLElement | null;
      const removedLabelEl = removedEl?.querySelector(".line-through") as HTMLElement | null;

      return {
        addedBorderColor: addedEl ? window.getComputedStyle(addedEl).borderColor : "",
        modifiedBorderColor: modifiedEl ? window.getComputedStyle(modifiedEl).borderColor : "",
        removedBorderStyle: removedEl ? window.getComputedStyle(removedEl).borderStyle : "",
        removedTextDecoration: removedLabelEl ? window.getComputedStyle(removedLabelEl).textDecorationLine : "",
      };
    });
    expect(styles.addedBorderColor).not.toBe("");
    expect(styles.addedBorderColor).not.toBe(styles.modifiedBorderColor);
    expect(styles.removedBorderStyle).toBe("dashed");
    expect(styles.removedTextDecoration).toContain("line-through");

    // Click modified node -> verify side-by-side parameter diff in RightDock Inspector
    await modifiedNode.click();
    await expect(page.getByTestId("inspector-node-side-by-side-diff")).toBeVisible();
    await expect(page.getByTestId("inspector-node-side-by-side-diff")).toContainText("title");
    await expect(page.getByTestId("inspector-node-side-by-side-diff")).toContainText("invoice.normalized_title");

    // 6. Verify Visual Diff Review Mode survives full page reload (F5)
    await page.reload();
    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText(`r${rPlus1}`);
    await expect(page.getByTestId("proposal-review-bar")).toBeVisible();
    await expect(page.getByTestId("diff-badge-added-node-added")).toHaveText("+ Added");

    // 7. Per-op dependency guard: deselect `prop-add-node` while keeping `prop-connect-edge`
    await page.getByTestId("proposal-op-checkbox-prop-add-node").uncheck();
    await expect(page.getByTestId("proposal-validation-error")).toBeVisible();
    await expect(page.getByTestId("proposal-validation-error")).toContainText('references missing target node "node-added"');
    await expect(page.getByTestId("proposal-validation-error")).toContainText("422 VALIDATION_FAILED");
    await expect(page.getByTestId("proposal-accept-selected")).toBeDisabled();

    // 8. Re-select `prop-add-node` and deselect `prop-remove-node` (keep `node-legacy`) -> Accept selected (3/4)
    await page.getByTestId("proposal-op-checkbox-prop-add-node").check();
    await page.getByTestId("proposal-op-checkbox-prop-remove-node").uncheck();
    await expect(page.getByTestId("proposal-validation-error")).toHaveCount(0);
    await expect(page.getByTestId("proposal-accept-selected")).toBeEnabled();
    await expect(page.getByTestId("proposal-accept-selected")).toContainText("Accept selected (3/4)");

    await page.getByTestId("proposal-accept-selected").click();

    // Mainline revision advances, review bar closes, and both `node-added` and `node-legacy` are on mainline canvas
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText(`r${rPlus2}`);
    await expect(page.getByTestId("proposal-review-bar")).toHaveCount(0);
    await expect(page.getByTestId("canvas-node-node-added")).toBeVisible();
    await expect(page.getByTestId("canvas-node-node-legacy")).toBeVisible();

    // 9. Agent submits Proposal #2 modifying Bricks + Entities (`configure_brick: credit-wallet`, `add_entity: audit_logs`)
    const mcpRes2 = await page.request.post("/mcp", {
      headers: {
        authorization: `Bearer ${E2E_MCP_TOKEN}`,
        "content-type": "application/json",
        "x-mcp-client-id": "agent:claude-code",
        "x-mcp-client-name": "Claude Desktop",
      },
      data: {
        jsonrpc: "2.0",
        id: 703,
        method: "tools/call",
        params: {
          name: "apply_ops",
          arguments: {
            project: "acme-saas",
            baseRev: rPlus2,
            mode: "propose",
            summary: "Reconfigure credit-wallet and add audit_logs entity",
            ops: [
              {
                opId: "p2-config-brick",
                type: "configure_brick",
                brickId: "credit-wallet",
                config: { creditsPerUnit: 25, minOrderAmount: 250 },
              },
              {
                opId: "p2-add-entity",
                type: "add_entity",
                entity: {
                  name: "audit_logs",
                  workspaceScoped: true,
                  fields: [{ name: "action_name", type: "text", required: true, maxLength: 120 }],
                },
              },
            ],
          },
        },
      },
    });
    expect(mcpRes2.status()).toBe(200);
    const mcpRpc2 = (await mcpRes2.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    const proposalPayload2 = JSON.parse(mcpRpc2.result.content[0]!.text) as {
      proposalId: string;
    };

    // Enter review for Proposal #2, inspect Bricks diff + Entities diff, then Reject it
    await expect(page.getByTestId("pending-proposals-banner")).toBeVisible();
    await page.getByTestId("review-latest-proposal-button").click();
    await expect(page.getByTestId("proposal-review-bar")).toBeVisible();

    // Jump to Bricks Diff view and verify `diff-badge-brick-changed-credit-wallet`
    await page.getByTestId("proposal-jump-bricks").click();
    await expect(page.getByTestId("diff-badge-brick-changed-credit-wallet").first()).toBeVisible();

    // Jump to Entities Diff view and verify `diff-badge-entity-added-audit_logs`
    await page.getByTestId("proposal-jump-entities").click();
    await expect(page.getByTestId("diff-badge-entity-added-audit_logs")).toBeVisible();

    // Reject Proposal #2 -> mainline rev stays unchanged
    await page.getByTestId("proposal-reject").click();
    await expect(page.getByTestId("proposal-review-bar")).toHaveCount(0);
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText(`r${rPlus2}`);

    // 10. Navigate to History & Activity Feed view and verify proposal statuses + Unified Activity Feed author filters
    await page.getByTestId("nav-tab-history").click();
    await expect(page.getByTestId("history-proposals-section")).toBeVisible();
    await expect(page.getByTestId(`proposal-status-badge-${proposalPayload1.proposalId}`)).toContainText("partially accepted");
    await expect(page.getByTestId(`proposal-status-badge-${proposalPayload2.proposalId}`)).toContainText("rejected");

    const activityFeed = page.getByTestId("unified-activity-feed");
    await expect(activityFeed).toBeVisible();

    // Filter by AI Agents only -> shows agent proposals & commits, 0 human events
    await page.getByTestId("activity-author-filter-agents").click();
    const agentEvents = activityFeed.locator('[data-actor-type="agent"]');
    await expect(agentEvents.first()).toBeVisible();
    await expect(activityFeed.locator('[data-actor-type="human"]')).toHaveCount(0);

    // Filter by Humans only -> shows human commits & reviews, 0 agent events
    await page.getByTestId("activity-author-filter-humans").click();
    const humanEvents = activityFeed.locator('[data-actor-type="human"]');
    await expect(humanEvents.first()).toBeVisible();
    await expect(activityFeed.locator('[data-actor-type="agent"]')).toHaveCount(0);
  });
});
