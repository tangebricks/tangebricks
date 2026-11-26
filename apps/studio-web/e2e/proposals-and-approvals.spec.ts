import { expect, test } from "@playwright/test";
import { e2eOwnerApi, e2eProjectToken } from "./project-token.ts";

// AD-V8 / R56 ("done when"): an MCP edit becomes a proposal that a person reviews and accepts in Studio before the
// blueprint changes; an MCP deploy is refused with APPROVAL_REQUIRED until a person approves it in Studio; the retry with
// the approval id deploys once, and reusing the approval is refused.
// (Named to run after the specs that count Acme's projects or expect no Cloudflare token: it adds a project and connects one.)
const API = "http://127.0.0.1:8787";
const PROJECT = "approvals-e2e";
const CF_TOKEN = "cf_scoped_valid_token_e2e_approvals_7731";

test.describe("AD-V8: agent proposals and approvals for destructive actions", () => {
  test("an MCP edit is reviewed and accepted in Studio; an MCP deploy needs an approval, which is single-use", async ({ page, request }) => {
    // The project (in Acme), Alice's agent token for it, a connected (fake) Cloudflare target, and a base blueprint.
    const token = await e2eProjectToken(PROJECT);
    const orgs = (await e2eOwnerApi("/api/orgs")).body.orgs as Array<{ id: string; slug?: string }>;
    const acme = orgs.find((o) => o.slug === "acme") ?? orgs[0]!;
    const connected = await e2eOwnerApi(`/api/orgs/${encodeURIComponent(acme.id)}/cloudflare-tokens/verify-and-save`, {
      token: CF_TOKEN,
      projectId: PROJECT,
    });
    expect([200, 201]).toContain(connected.status);
    const seeded = await e2eOwnerApi(`/api/projects/${PROJECT}/ops`, {
      summary: "Base blueprint",
      ops: [
        { opId: "ap-ws", type: "enable_brick", brickId: "multi-workspace", config: {} },
        { opId: "ap-ent", type: "enable_brick", brickId: "dynamic-entities", config: {} },
        {
          opId: "ap-inv",
          type: "add_entity",
          entity: { name: "invoices", workspaceScoped: true, fields: [{ name: "title", type: "text", required: true }] },
        },
      ],
    });
    expect(seeded.status).toBe(200);
    const baseRevision = Number(seeded.body.revision);

    const mcp = async (name: string, args: Record<string, unknown>) => {
      const res = await request.post(`${API}/mcp`, {
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        data: { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: { project: PROJECT, ...args } } },
      });
      expect(res.status()).toBe(200);
      const rpc = (await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
      return { isError: rpc.result.isError === true, json: JSON.parse(rpc.result.content[0]!.text) as Record<string, any> };
    };

    // Alice opens the project in Studio.
    await page.goto(`/?project=${PROJECT}`);
    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();
    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await page.getByTestId("project-selector").selectOption(PROJECT);
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText(`r${baseRevision}`);

    // 1. The agent edits without a mode: a pending proposal; the live blueprint does not change.
    const proposed = await mcp("apply_ops", {
      ops: [
        {
          opId: "ap-notes",
          type: "add_entity",
          entity: { name: "notes", workspaceScoped: true, fields: [{ name: "body", type: "text", required: true }] },
        },
      ],
    });
    expect(proposed.isError).toBe(false);
    expect(proposed.json.status).toBe("pending");
    await expect(page.getByTestId("pending-proposals-banner")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText(`r${baseRevision}`);

    // 2. Alice reviews the diff and accepts (merges) it: the blueprint now has the change.
    await page.getByTestId("review-latest-proposal-button").click();
    await expect(page.getByTestId("proposal-review-bar")).toBeVisible();
    await page.getByTestId("proposal-accept-all").click();
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText(`r${baseRevision + 1}`, { timeout: 5_000 });
    const state = await e2eOwnerApi(`/api/projects/${PROJECT}`);
    expect(((state.body.state as { entities: Array<{ name: string }> }).entities ?? []).map((e) => e.name)).toContain("notes");

    // 3. The agent deploys: refused with APPROVAL_REQUIRED and remediation; nothing is deployed.
    const refused = await mcp("deploy_apply", { env: "preview" });
    expect(refused.isError).toBe(true);
    expect(refused.json.error.code).toBe("APPROVAL_REQUIRED");
    expect(refused.json.error.remediation).toMatch(/retry .* approvalId/);
    const approvalId = refused.json.error.approvalId as string;
    const before = await e2eOwnerApi(`/api/projects/${PROJECT}/environments`);
    const previewBefore = ((before.body.environments as Array<{ envName: string; deployedRev: number | null }>) ?? []).find((e) => e.envName === "preview");
    expect(previewBefore?.deployedRev ?? null).toBeNull();

    // 4. Alice approves the request in Studio.
    const card = page.getByTestId(`approval-${approvalId}`);
    await expect(card).toBeVisible({ timeout: 5_000 });
    await expect(card.getByTestId("approval-action")).toContainText("Deploy");
    await expect(card.getByTestId("approval-requested-by")).toContainText("Claude Desktop");
    await card.getByTestId("approval-approve").click();
    await expect(card).toHaveCount(0, { timeout: 5_000 });

    // 5. The agent retries with the approval id: the deploy runs once.
    const deployed = await mcp("deploy_apply", { env: "preview", approvalId });
    expect(deployed.isError, JSON.stringify(deployed.json)).toBe(false);
    expect(typeof deployed.json.deploymentId).toBe("string");

    // 6. Reusing the approval is refused.
    const reused = await mcp("deploy_apply", { env: "preview", approvalId });
    expect(reused.isError).toBe(true);
    expect(reused.json.error.code).toBe("APPROVAL_USED");
  });
});
