import { expect, test } from "@playwright/test";
import { e2eProjectToken } from "./project-token.ts";

test.describe("Story 2.7: Live WebSocket Sync (p95 <= 2,000 ms), Author Badges, and Node Highlights", () => {
  test("propagates 10 sequential MCP mutations to Chromium within p95 <= 2,000 ms with agent:Claude Desktop badges, canvas node highlights, and Change Ledger entries (AC 1, AC 2, AC 3)", async ({
    page,
    request,
  }) => {
    await page.goto("/");

    // Sign in via Better Auth login screen
    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await expect(page.getByTestId("sync-status-chip")).toContainText("Live");

    // Select the live-sync-proj project
    await page.getByTestId("project-selector").selectOption("live-sync-proj");
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r0");

    // Enable Follow AI toggle and open AI Change Ledger tab in Right Dock
    await page.getByTestId("follow-ai-toggle").click();
    await expect(page.getByTestId("follow-ai-toggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByTestId("right-dock-tab-ledger").click();

    const mutations: Array<{
      step: number;
      tool: string;
      args: Record<string, unknown>;
    }> = [
      {
        step: 1,
        tool: "enable_brick",
        args: {
          project: "live-sync-proj",
          bricks: ["multi-workspace"],
        },
      },
      {
        step: 2,
        tool: "enable_brick",
        args: {
          project: "live-sync-proj",
          bricks: [
            // AD-V8: enable_brick (mode "apply" rules) refuses a money brick for an agent, so this live-sync step
            // enables a non-money brick with settings instead.
            {
              id: "binary-assets",
              config: { maxFileSizeBytes: 15 * 1024, workspaceQuotaBytes: 100 * 1048576 },
            },
          ],
        },
      },
      {
        step: 3,
        tool: "enable_brick",
        args: {
          project: "live-sync-proj",
          bricks: ["dynamic-entities"],
        },
      },
      {
        step: 4,
        tool: "define_entity",
        args: {
          project: "live-sync-proj",
          entities: [
            {
              name: "customers",
              workspaceScoped: true,
              fields: [
                { name: "email", type: "text", required: true, maxLength: 180 },
                { name: "plan", type: "enum", required: true, values: ["free", "pro"] },
              ],
            },
          ],
        },
      },
      {
        step: 5,
        tool: "define_entity",
        args: {
          project: "live-sync-proj",
          entities: [
            {
              name: "customers",
              workspaceScoped: true,
              fields: [
                { name: "email", type: "text", required: true, maxLength: 180 },
                { name: "plan", type: "enum", required: true, values: ["free", "pro"] },
              ],
            },
            {
              name: "orders",
              workspaceScoped: true,
              fields: [
                { name: "total_cents", type: "number", required: true, min: 0 },
                { name: "paid", type: "boolean", required: true },
              ],
            },
          ],
        },
      },
      {
        step: 6,
        tool: "apply_ops",
        args: {
          project: "live-sync-proj",
          mode: "apply", // AD-V8: preview-safe workflow edits an agent may apply directly
          summary: "Create onboarding workflow with trigger node",
          ops: [
            {
              opId: "ls-op-6",
              type: "add_workflow",
              workflow: {
                id: "wf-live",
                name: "Live Onboarding Workflow",
                nodes: [
                  {
                    id: "node-start",
                    type: "trigger.manual",
                    label: "Start Onboarding",
                    data: {},
                  },
                ],
                edges: [],
              },
            },
          ],
        },
      },
      {
        step: 7,
        tool: "apply_ops",
        args: {
          project: "live-sync-proj",
          mode: "apply", // AD-V8: preview-safe workflow edits an agent may apply directly
          summary: "Add validate customer node",
          ops: [
            {
              opId: "ls-op-7a",
              type: "add_node",
              workflowId: "wf-live",
              node: {
                id: "node-validate",
                type: "transform.pick",
                label: "Validate Customer",
                data: { path: "customer" },
              },
            },
            {
              opId: "ls-op-7b",
              type: "connect_edges",
              workflowId: "wf-live",
              edges: [
                {
                  id: "edge-1",
                  source: "node-start",
                  target: "node-validate",
                  sourceHandle: "out",
                  targetHandle: "in",
                },
              ],
            },
          ],
        },
      },
      {
        step: 8,
        tool: "apply_ops",
        args: {
          project: "live-sync-proj",
          mode: "apply", // AD-V8: preview-safe workflow edits an agent may apply directly
          summary: "Add enrich wallet node",
          ops: [
            {
              opId: "ls-op-8a",
              type: "add_node",
              workflowId: "wf-live",
              node: {
                id: "node-wallet",
                type: "transform.pick",
                label: "Provision Wallet",
                data: { path: "wallet" },
              },
            },
            {
              opId: "ls-op-8b",
              type: "connect_edges",
              workflowId: "wf-live",
              edges: [
                {
                  id: "edge-2",
                  source: "node-validate",
                  target: "node-wallet",
                  sourceHandle: "out",
                  targetHandle: "in",
                },
              ],
            },
          ],
        },
      },
      {
        step: 9,
        tool: "apply_ops",
        args: {
          project: "live-sync-proj",
          mode: "apply", // AD-V8: preview-safe workflow edits an agent may apply directly
          summary: "Add audit log node",
          ops: [
            {
              opId: "ls-op-9a",
              type: "add_node",
              workflowId: "wf-live",
              node: {
                id: "node-audit",
                type: "transform.pick",
                label: "Record Audit Event",
                data: { path: "audit" },
              },
            },
            {
              opId: "ls-op-9b",
              type: "connect_edges",
              workflowId: "wf-live",
              edges: [
                {
                  id: "edge-3",
                  source: "node-wallet",
                  target: "node-audit",
                  sourceHandle: "out",
                  targetHandle: "in",
                },
              ],
            },
          ],
        },
      },
      {
        step: 10,
        tool: "apply_ops",
        args: {
          project: "live-sync-proj",
          mode: "apply", // AD-V8: preview-safe workflow edits an agent may apply directly
          summary: "Add output dispatch node and connect final edge",
          ops: [
            {
              opId: "ls-op-10a",
              type: "add_node",
              workflowId: "wf-live",
              node: {
                id: "node-out",
                type: "transform.pick",
                label: "Emit Ready Event",
                data: { path: "ready" },
              },
            },
            {
              opId: "ls-op-10b",
              type: "connect_edges",
              workflowId: "wf-live",
              edges: [
                {
                  id: "edge-4",
                  source: "node-audit",
                  target: "node-out",
                  sourceHandle: "out",
                  targetHandle: "in",
                },
              ],
            },
          ],
        },
      },
    ];

    const latenciesMs: number[] = [];

    // Story 0.15: the MCP token is bound to live-sync-proj.
    const liveSyncToken = await e2eProjectToken("live-sync-proj");
    for (const mut of mutations) {
      const mcpRes = await request.post("/mcp", {
        headers: {
          authorization: `Bearer ${liveSyncToken}`,
        },
        data: {
          jsonrpc: "2.0",
          id: mut.step,
          method: "tools/call",
          params: {
            name: mut.tool,
            arguments: mut.args,
          },
        },
      });
      expect(mcpRes.status()).toBe(200);
      const tCommit = Date.now();

      await expect(page.getByTestId("topbar-revision-badge")).toHaveText(
        `r${mut.step}`,
        { timeout: 2_000 },
      );
      const deltaMs = Date.now() - tCommit;
      latenciesMs.push(deltaMs);
    }

    const sortedLatencies = [...latenciesMs].sort((a, b) => a - b);
    const p95Index = Math.min(
      sortedLatencies.length - 1,
      Math.ceil(sortedLatencies.length * 0.95) - 1,
    );
    const p95Ms = sortedLatencies[p95Index]!;
    const medianMs = sortedLatencies[Math.floor(sortedLatencies.length / 2)]!;

    console.log(
      `[CP2 Live Sync] 10 mutations latencies (ms): ${latenciesMs.join(", ")} | median=${medianMs}ms | p95=${p95Ms}ms`,
    );
    expect(p95Ms).toBeLessThanOrEqual(2_000);

    // Follow AI switched active view to Workflows canvas and highlighted the latest node
    await expect(page.getByTestId("view-workflows")).toBeVisible();
    await expect(page.getByTestId("canvas-node-node-out")).toBeVisible();
    await expect(page.getByTestId("canvas-node-node-out")).toHaveAttribute(
      "data-highlighted",
      "true",
    );
    await expect(page.getByTestId("node-author-badge-node-out")).toContainText(
      "agent:Claude Desktop",
    );

    // Verify AI Change Ledger in Right Dock has all 10 revisions with agent:Claude Desktop badge
    await page.getByTestId("right-dock-tab-ledger").click();
    await expect(page.getByTestId("right-dock-ledger-panel")).toBeVisible();
    await expect(page.getByTestId("ledger-entry-10")).toBeVisible();
    await expect(page.getByTestId("ledger-author-badge-10")).toContainText(
      "agent:Claude Desktop",
    );
  });
});
