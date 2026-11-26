import { describe, expect, test } from "vitest";
import { createStudioApiApp } from "../../../apps/studio-api/src/index.ts";
import { createNodeStudioEnv } from "../../../scripts/lib/studio-node-env.ts";
import { createFakeCloudflare } from "../../deploy/test/support/fake-cloudflare.ts";

// Story R53: MCP's deploy_plan / deploy_apply proxy to Studio's own routes, so when Studio is configured with the real
// Cloudflare client, an agent's deploy reaches that client. Cloudflare is the fake (a fetch, no network); Studio runs
// in-process under Node with no PX_DEPLOY_CLIENT, which means the real HTTP client.

const TOKEN = "cfut_McpRealClientDeployTokenR53cccccccccccccccccccccc";
const ACCOUNT = "fedcba9876543210fedcba9876543210";

describe("MCP deploy through Studio's real Cloudflare client", () => {
  test("deploy_plan and deploy_apply over /mcp reach the HTTP client and upload to (fake) Cloudflare", { timeout: 120_000 }, async () => {
    const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT });
    const bundled: string[] = [];
    const app = createStudioApiApp({
      deploy: {
        fetch: fake.fetch,
        // the smoke check after the upload reaches the (fake) workers.dev address, never the network
        workerFetch: fake.fetch,
        sleep: async () => {},
        bundle: async ({ project, envName }) => {
          bundled.push(`${project}:${envName}`);
          return { code: `export class GraphRunner {}\nexport default { fetch() { return new Response("${project}"); } };` };
        },
      },
    });
    const studio = createNodeStudioEnv({ rootSecret: "mcp-real-client-root-secret-0123456789" });
    try {
      const call = async (path: string, body: unknown, bearer?: string, orgId?: string) => {
        const res = await app.fetch(
          new Request(`https://studio.local${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(orgId ? { "x-org-id": orgId } : {}) },
            body: JSON.stringify(body),
          }),
          studio.env,
        );
        return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
      };
      const signup = await call("/api/auth/signup", { email: "mcp-owner@r53.test", password: "Password12345!", name: "MCP Owner" });
      expect(signup.status).toBe(201);
      const session = String(signup.body.token);
      const org = await call("/api/orgs", { name: "MCP R53", slug: "mcp-r53" }, session);
      const orgId = String(org.body.id);
      const project = "mcp-r53-proj";
      await call(`/api/orgs/${orgId}/projects`, { project }, session);
      const connect = await call(`/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, { token: TOKEN, accountId: ACCOUNT, projectId: project }, session);
      expect(connect.status).toBe(201);
      expect(fake.requests.some((r) => r.path.endsWith("/tokens/verify"))).toBe(true);
      const ops = await call(
        `/api/projects/${project}/ops`,
        {
          summary: "seed",
          ops: [
            { opId: "op_ws", type: "enable_brick", brickId: "multi-workspace", config: {} },
            { opId: "op_wallet", type: "enable_brick", brickId: "credit-wallet", config: {} },
          ],
        },
        session,
        orgId,
      );
      expect(ops.status).toBe(200);
      const mcpToken = await call(`/api/orgs/${orgId}/mcp-tokens`, { name: "agent", projectId: project, scopes: ["read", "edit", "deploy"] }, session);
      expect(mcpToken.status).toBe(201);
      const agent = String(mcpToken.body.token);

      const tool = async (name: string, args: Record<string, unknown>) => {
        const reply = await call("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, agent);
        const result = reply.body.result as { isError?: boolean; content?: Array<{ text: string }> } | undefined;
        return { reply, result, text: result?.content?.[0]?.text ?? JSON.stringify(reply.body) };
      };
      const plan = await tool("deploy_plan", { project, env: "preview" });
      expect(plan.result?.isError, plan.text).toBeFalsy();

      // AD-V8: the agent's deploy is refused until a person approves it in Studio; nothing is written to Cloudflare.
      const before = fake.requests.length;
      const refused = await tool("deploy_apply", { project, env: "preview" });
      expect(refused.result?.isError).toBe(true);
      const approvalId = String((JSON.parse(refused.text) as { error: { code: string; approvalId: string } }).error.approvalId);
      expect(JSON.parse(refused.text).error.code).toBe("APPROVAL_REQUIRED");
      expect(fake.requests.slice(before).filter((r) => r.method !== "GET")).toEqual([]);
      const approved = await call(`/api/projects/${project}/approvals/${approvalId}/approve`, {}, session);
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      const applied = await tool("deploy_apply", { project, env: "preview", approvalId });
      expect(applied.result?.isError, applied.text).toBeFalsy();
      const writes = fake.requests.slice(before).filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);
      expect(writes).toContain(`PUT /client/v4/accounts/{account}/workers/scripts/px-${project}-preview`);
      expect(writes).toContain("POST /client/v4/accounts/{account}/d1/database");
      expect(bundled).toEqual([`${project}:preview`]);
      expect(fake.codeOf(`px-${project}-preview`)).toContain(project);
      expect(fake.state().scripts.find((s) => s.name === `px-${project}-preview`)?.addressEnabled).toBe(true);
    } finally {
      studio.close();
    }
  });
});
