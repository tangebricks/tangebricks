import { describe, expect, test } from "vitest";
import { createStudioApiApp } from "../../apps/studio-api/src/index.ts";
import type { StudioDeployOptions } from "../../apps/studio-api/src/index.ts";
import { createFakeCloudflare } from "../../packages/deploy/test/support/fake-cloudflare.ts";
import { createNodeStudioEnv } from "../lib/studio-node-env.ts";

// Story R53, third review: a rollback never deletes a brick secret (it re-binds the vault's value and carries the hash), and a
// retry after a failed first deploy smoke-checks the Worker's real workers.dev address, not a made-up one. Studio runs
// in-process under Node on the real HTTP client; Cloudflare is the fake (no network).

const TOKEN = "cfut_R53RollbackSecretsTokenhhhhhhhhhhhhhhhhhhhhhhhhhhh";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const GROUPS = ["Account Settings Read", "Workers Scripts Write", "D1 Write", "Queues Write"];

async function studioWith(deploy: StudioDeployOptions, rootSecret: string) {
  const app = createStudioApiApp({ deploy });
  const studio = createNodeStudioEnv({ rootSecret });
  const call = async (method: string, path: string, body?: unknown, session?: string, orgId?: string) => {
    const res = await app.fetch(new Request(`https://studio.local${path}`, { method, headers: { "content-type": "application/json", ...(session ? { authorization: `Bearer ${session}` } : {}), ...(orgId ? { "x-org-id": orgId } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), studio.env);
    const text = await res.text();
    return { status: res.status, text, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  const session = String((await call("POST", "/api/auth/signup", { email: `s-${Math.random().toString(36).slice(2, 8)}@r53.test`, password: "Password12345!", name: "S" })).body.token);
  const orgId = String((await call("POST", "/api/orgs", { name: "R53 S", slug: `r53-s-${Math.random().toString(36).slice(2, 8)}` }, session)).body.id);
  return { studio, call, session, orgId };
}

describe("rollback and secrets on the real client", () => {
  test("a rollback keeps a brick secret: no DELETE for it, the value stays on the Worker, and its hash survives", { timeout: 120_000 }, async () => {
    const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT, tokenGroups: GROUPS });
    let n = 0;
    const { studio, call, session, orgId } = await studioWith(
      { fetch: fake.fetch, workerFetch: fake.fetch, sleep: async () => {}, bundle: async () => ({ code: `export class GraphRunner {}\nexport default {}; // build ${++n}` }) },
      "rollback-secrets-root-0123456789abcdef",
    );
    try {
      const project = "r53-rb-secret";
      await call("POST", `/api/orgs/${orgId}/projects`, { project }, session);
      expect((await call("POST", `/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, { token: TOKEN, accountId: ACCOUNT, projectId: project }, session)).status).toBe(201);
      const ops = (opId: string, extra: Array<Record<string, unknown>>) => call("POST", `/api/projects/${project}/ops`, { summary: opId, ops: extra }, session, orgId);
      expect((await ops("bricks", [{ opId: "op_ws", type: "enable_brick", brickId: "multi-workspace", config: {} }, { opId: "op_wallet", type: "enable_brick", brickId: "credit-wallet", config: {} }])).status).toBe(200);
      const secret = await call("POST", `/api/projects/${project}/secrets`, { ref: "sec_stripe_key", kind: "brick_secret", label: "STRIPE_KEY", appOrBrick: "credit-wallet", value: "sk_test_r53_0123456789abcdef", bindTarget: { targetKind: "brick", targetId: "credit-wallet", secretName: "STRIPE_KEY" } }, session, orgId);
      expect(secret.status, secret.text).toBe(200);
      const v1 = await call("POST", `/api/projects/${project}/environments/preview/deploy`, {}, session, orgId);
      expect(v1.status, v1.text).toBe(200);
      const script = `px-${project}-preview`;
      expect(fake.secretOf(script, "STRIPE_KEY")).toBe("sk_test_r53_0123456789abcdef");
      expect((await ops("entity", [{ opId: "op_brick_ent", type: "enable_brick", brickId: "dynamic-entities", config: {} }, { opId: "op_ent", type: "add_entity", entity: { name: "notes", workspaceScoped: true, fields: [{ name: "body", type: "text" }] } }])).status).toBe(200);
      const v2 = await call("POST", `/api/projects/${project}/environments/preview/deploy`, {}, session, orgId);
      expect(v2.status, v2.text).toBe(200);

      const before = fake.requests.length;
      let rollback = await call("POST", `/api/projects/${project}/environments/preview/rollback`, { targetDeploymentId: v1.body.deployId }, session, orgId);
      if (rollback.status === 422) rollback = await call("POST", `/api/projects/${project}/environments/preview/rollback`, { targetDeploymentId: v1.body.deployId, confirmDestructive: true }, session, orgId);
      expect(rollback.status, rollback.text).toBe(200);
      const deletes = fake.requests.slice(before).filter((r) => r.method === "DELETE" && r.path.includes("/secrets/"));
      expect(deletes).toEqual([]);
      expect(fake.secretOf(script, "STRIPE_KEY")).toBe("sk_test_r53_0123456789abcdef");
      const row = await studio.env.STUDIO_DB.prepare("SELECT deployed_state_json FROM project_environments WHERE project_id = ? AND env_name = 'preview'").bind(project).first<{ deployed_state_json: string }>();
      const state = JSON.parse(row!.deployed_state_json) as { secretHashes?: Record<string, string>; studioVersionIds?: string[] };
      expect(Object.keys(state.secretHashes ?? {})).toContain("STRIPE_KEY");
      expect((state.studioVersionIds ?? []).length).toBeGreaterThan(0);
      // the next deploy still binds it (the blueprint still binds it): nothing is deleted
      const after = await call("POST", `/api/projects/${project}/environments/preview/deploy`, {}, session, orgId);
      expect(after.status, after.text).toBe(200);
      expect(fake.secretOf(script, "STRIPE_KEY")).toBe("sk_test_r53_0123456789abcdef");
    } finally {
      studio.close();
    }
  });

  test("a retry after a first deploy failed at the smoke check checks the real workers.dev address, and succeeds", { timeout: 120_000 }, async () => {
    const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT, tokenGroups: GROUPS });
    const smokeUrls: string[] = [];
    let healthy = false;
    const { studio, call, session, orgId } = await studioWith(
      {
        fetch: fake.fetch,
        workerFetch: async (request) => {
          smokeUrls.push(request.url);
          if (!healthy) return new Response("starting", { status: 503 });
          return fake.fetch(request);
        },
        sleep: async () => {},
        smokeTimeoutMs: { firstDeploy: 3_000, redeploy: 3_000 },
        bundle: async () => ({ code: "export class GraphRunner {}\nexport default {};" }),
      },
      "retry-url-root-0123456789abcdef",
    );
    try {
      const project = "r53-retry-url";
      await call("POST", `/api/orgs/${orgId}/projects`, { project }, session);
      await call("POST", `/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, { token: TOKEN, accountId: ACCOUNT, projectId: project }, session);
      await call("POST", `/api/projects/${project}/ops`, { summary: "s", ops: [{ opId: "op_ws", type: "enable_brick", brickId: "multi-workspace", config: {} }] }, session, orgId);
      const first = await call("POST", `/api/projects/${project}/environments/preview/deploy`, {}, session, orgId);
      expect(first.status).toBe(502);
      expect((first.body.error as { code: string }).code).toBe("SMOKE_CHECK_FAILED");
      healthy = true;
      smokeUrls.length = 0;
      const retry = await call("POST", `/api/projects/${project}/environments/preview/deploy`, {}, session, orgId);
      expect(retry.status, retry.text).toBe(200);
      expect(smokeUrls.length).toBeGreaterThan(0);
      for (const url of smokeUrls) expect(url).toBe(`https://px-${project}-preview.fake-subdomain.workers.dev/healthz`);
      expect((retry.body.deployment as { url: string }).url).toBe(`https://px-${project}-preview.fake-subdomain.workers.dev`);
    } finally {
      studio.close();
    }
  });

  test("a secret bound to an explicit ref keeps that value through deploy and rollback, even with another vault row labelled like it", { timeout: 120_000 }, async () => {
    const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT, tokenGroups: GROUPS });
    let n = 0;
    const { studio, call, session, orgId } = await studioWith(
      { fetch: fake.fetch, workerFetch: fake.fetch, sleep: async () => {}, bundle: async () => ({ code: `export class GraphRunner {}
export default {}; // build ${++n}` }) },
      "explicit-ref-root-0123456789abcdef",
    );
    try {
      const project = "r53-explicit-ref";
      await call("POST", `/api/orgs/${orgId}/projects`, { project }, session);
      await call("POST", `/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, { token: TOKEN, accountId: ACCOUNT, projectId: project }, session);
      const ops = (summary: string, list: Array<Record<string, unknown>>) => call("POST", `/api/projects/${project}/ops`, { summary, ops: list }, session, orgId);
      expect((await ops("bricks", [{ opId: "op_ws", type: "enable_brick", brickId: "multi-workspace", config: {} }, { opId: "op_wallet", type: "enable_brick", brickId: "credit-wallet", config: {} }])).status).toBe(200);
      // first in the vault: a decoy row labelled STRIPE_KEY, bound to nothing
      const decoy = await call("POST", `/api/projects/${project}/secrets`, { ref: "sec_decoy", kind: "brick_secret", label: "STRIPE_KEY", appOrBrick: "credit-wallet", value: "sk_test_DECOY_wrong_value_000" }, session, orgId);
      expect(decoy.status, decoy.text).toBe(200);
      // the blueprint binds STRIPE_KEY explicitly to sec_stripe_live
      const live = await call("POST", `/api/projects/${project}/secrets`, { ref: "sec_stripe_live", kind: "brick_secret", label: "Stripe live key", appOrBrick: "credit-wallet", value: "sk_live_RIGHT_value_111", bindTarget: { targetKind: "brick", targetId: "credit-wallet", secretName: "STRIPE_KEY" } }, session, orgId);
      expect(live.status, live.text).toBe(200);
      const v1 = await call("POST", `/api/projects/${project}/environments/preview/deploy`, {}, session, orgId);
      expect(v1.status, v1.text).toBe(200);
      const script = `px-${project}-preview`;
      expect(fake.secretOf(script, "STRIPE_KEY")).toBe("sk_live_RIGHT_value_111");
      expect((await ops("ent", [{ opId: "op_brick_ent", type: "enable_brick", brickId: "dynamic-entities", config: {} }, { opId: "op_ent", type: "add_entity", entity: { name: "notes", workspaceScoped: true, fields: [{ name: "body", type: "text" }] } }])).status).toBe(200);
      expect((await call("POST", `/api/projects/${project}/environments/preview/deploy`, {}, session, orgId)).status).toBe(200);
      let rollback = await call("POST", `/api/projects/${project}/environments/preview/rollback`, { targetDeploymentId: v1.body.deployId }, session, orgId);
      if (rollback.status === 422) rollback = await call("POST", `/api/projects/${project}/environments/preview/rollback`, { targetDeploymentId: v1.body.deployId, confirmDestructive: true }, session, orgId);
      expect(rollback.status, rollback.text).toBe(200);
      expect(fake.secretOf(script, "STRIPE_KEY")).toBe("sk_live_RIGHT_value_111");
      const row = await studio.env.STUDIO_DB.prepare("SELECT deployed_state_json FROM project_environments WHERE project_id = ? AND env_name = 'preview'").bind(project).first<{ deployed_state_json: string }>();
      expect((JSON.parse(row!.deployed_state_json) as { secretRefs?: Record<string, string> }).secretRefs).toEqual({ STRIPE_KEY: "sec_stripe_live" });
      // a response never carries a secret value; the recorded refs are ref ids only
      expect(rollback.text).not.toContain("sk_live_RIGHT_value_111");
    } finally {
      studio.close();
    }
  });
});
