import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createStudioApiApp } from "../../apps/studio-api/src/index.ts";
import { createFakeCloudflare } from "../../packages/deploy/test/support/fake-cloudflare.ts";
import { createClient } from "../../packages/deploy/src/provisioner/index.ts";
import { createNodeStudioEnv } from "../lib/studio-node-env.ts";

// Story R53, second review: a rollback on the real client keeps the real path's bookkeeping (the secrets it bound, the hash
// of the bundle it uploaded), so the drift check sees no false out-of-band change afterwards, and the next deploy still
// deletes a secret that is no longer bound. Studio runs in-process under Node on the real HTTP client; Cloudflare is the
// fake (no network); the workers.dev check goes to the fake too.

const TOKEN = "cfut_R53RollbackTokenffffffffffffffffffffffffffffffffff";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

describe("rollback on the real client", () => {
  test(
    "carries secretHashes and liveCodeHash, shows no false drift, never exposes the hashes, and the next deploy removes an unbound secret",
    { timeout: 120_000 },
    async () => {
      const fake = createFakeCloudflare({
        token: TOKEN,
        accountId: ACCOUNT,
        tokenGroups: ["Account Settings Read", "Workers Scripts Write", "D1 Write", "Queues Write"],
      });
      const app = createStudioApiApp({
        deploy: {
          fetch: fake.fetch,
          workerFetch: fake.fetch,
          sleep: async () => {},
          // a bundle that differs with the assembled files, as the real one does
          bundle: async ({ files }) => {
            const digest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
            return { code: `export class GraphRunner {}\nexport default { fetch() { return new Response("${digest}"); } };`, sha256: digest };
          },
        },
      });
      const studio = createNodeStudioEnv({ rootSecret: "rollback-root-secret-0123456789abcdef" });
      try {
        const call = async (method: string, path: string, body?: unknown, session?: string, orgId?: string) => {
          const res = await app.fetch(
            new Request(`https://studio.local${path}`, {
              method,
              headers: {
                "content-type": "application/json",
                ...(session ? { authorization: `Bearer ${session}` } : {}),
                ...(orgId ? { "x-org-id": orgId } : {}),
              },
              ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            }),
            studio.env,
          );
          const text = await res.text();
          return { status: res.status, text, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
        };
        const signup = await call("POST", "/api/auth/signup", { email: "rollback@r53.test", password: "Password12345!", name: "Rollback" });
        const session = String(signup.body.token);
        const orgId = String((await call("POST", "/api/orgs", { name: "R53 Rollback", slug: "r53-rollback" }, session)).body.id);
        const project = "r53-rollback";
        await call("POST", `/api/orgs/${orgId}/projects`, { project }, session);
        expect(
          (await call("POST", `/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, { token: TOKEN, accountId: ACCOUNT, projectId: project }, session))
            .status,
        ).toBe(201);
        const ops = (amount: number, extra: unknown[] = []) =>
          call(
            "POST",
            `/api/projects/${project}/ops`,
            {
              summary: `v amount ${amount}`,
              ops: [
                ...extra,
                {
                  opId: `op_wf_${amount}`,
                  type: amount === 5 ? "add_workflow" : "update_node",
                  ...(amount === 5
                    ? {
                        workflow: {
                          id: "wf-debit",
                          name: "Debit",
                          nodes: [
                            { id: "trigger", type: "trigger.manual", label: "T", data: {} },
                            { id: "debit", type: "credit-wallet.debit", label: "D", data: { amount } },
                          ],
                          edges: [{ id: "e1", source: "trigger", target: "debit", sourceHandle: "out", targetHandle: "in" }],
                        },
                      }
                    : { workflowId: "wf-debit", nodeId: "debit", data: { amount } }),
                },
              ],
            },
            session,
            orgId,
          );
        expect(
          (
            await ops(5, [
              { opId: "op_ws", type: "enable_brick", brickId: "multi-workspace", config: {} },
              { opId: "op_wallet", type: "enable_brick", brickId: "credit-wallet", config: {} },
            ])
          ).status,
        ).toBe(200);
        const v1 = await call("POST", `/api/projects/${project}/environments/preview/deploy`, {}, session, orgId);
        expect(v1.status, v1.text).toBe(200);
        expect((await ops(9)).status).toBe(200);
        const v2 = await call("POST", `/api/projects/${project}/environments/preview/deploy`, {}, session, orgId);
        expect(v2.status, v2.text).toBe(200);

        let rollback = await call("POST", `/api/projects/${project}/environments/preview/rollback`, { targetDeploymentId: v1.body.deployId }, session, orgId);
        if (rollback.status === 422)
          rollback = await call(
            "POST",
            `/api/projects/${project}/environments/preview/rollback`,
            { targetDeploymentId: v1.body.deployId, confirmDestructive: true },
            session,
            orgId,
          );
        expect(rollback.status, rollback.text).toBe(200);
        expect(rollback.text).not.toContain("secretHashes");

        // the bookkeeping survived the rollback
        const row = await studio.env.STUDIO_DB.prepare("SELECT deployed_state_json FROM project_environments WHERE project_id = ? AND env_name = 'preview'")
          .bind(project)
          .first<{ deployed_state_json: string }>();
        const state = JSON.parse(row!.deployed_state_json) as { secretHashes?: Record<string, string>; liveCodeHash?: string };
        expect(Object.keys(state.secretHashes ?? {})).toEqual(expect.arrayContaining(["POC_ACCESS_KEY", "PX_TELEMETRY_SECRET", "PX_TELEMETRY_WEBHOOK_SECRET"]));
        expect(state.liveCodeHash).toMatch(/^[0-9a-f]{64}$/);

        // drift after the rollback: the account's Worker is what Studio says it uploaded
        const envs = await call("GET", `/api/projects/${project}/environments`, undefined, session, orgId);
        expect(envs.status).toBe(200);
        expect(envs.text).not.toContain("secretHashes");
        const preview = (
          envs.body.environments as Array<{ envName: string; drift: { status: string }; driftReport: { outOfBandDrift: Array<{ resource: string }> } }>
        ).find((e) => e.envName === "preview")!;
        expect(preview.drift.status).toBe("checked");
        expect(preview.driftReport.outOfBandDrift.filter((d) => d.resource === "worker")).toEqual([]);

        // a secret Studio once bound and no longer binds is deleted by the next deploy
        const rest = createClient({ credentials: { token: TOKEN, accountId: ACCOUNT }, fetch: fake.fetch, sleep: async () => {} });
        const script = `px-${project}-preview`;
        await rest.putScriptSecret(script, "OLD_SECRET", "old-value-0123456789");
        const stale = { ...state, secretHashes: { ...state.secretHashes, OLD_SECRET: "0".repeat(64) } };
        await studio.env.STUDIO_DB.prepare("UPDATE project_environments SET deployed_state_json = ? WHERE project_id = ? AND env_name = 'preview'")
          .bind(JSON.stringify(stale), project)
          .run();
        const next = await call("POST", `/api/projects/${project}/environments/preview/deploy`, {}, session, orgId);
        expect(next.status, next.text).toBe(200);
        expect(fake.secretOf(script, "OLD_SECRET")).toBeUndefined();
        expect((next.body.appliedActions as Array<{ name: string; action: string }>).some((a) => a.name === "OLD_SECRET" && a.action === "delete")).toBe(true);
        expect(next.text).not.toContain("secretHashes");
      } finally {
        studio.close();
      }
    },
  );

  test("a Cloudflare read failure while listing environments degrades to drift unknown, never a 500", { timeout: 120_000 }, async () => {
    const fake = createFakeCloudflare({
      token: TOKEN,
      accountId: ACCOUNT,
      tokenGroups: ["Account Settings Read", "Workers Scripts Write", "D1 Write", "Queues Write"],
    });
    // Once the deployed Worker has been smoke-checked (the deploy is done), every read of a Worker's settings is refused.
    let deployDone = false;
    const refused = () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    const cloudflare = (request: Request) =>
      deployDone && request.method === "GET" && /\/workers\/scripts\/[^/]+\/settings$/.test(new URL(request.url).pathname)
        ? Promise.resolve(refused())
        : fake.fetch(request);
    const app = createStudioApiApp({
      deploy: {
        fetch: cloudflare,
        workerFetch: (request) => {
          deployDone = true;
          return fake.fetch(request);
        },
        sleep: async () => {},
        bundle: async () => ({ code: "export class GraphRunner {}\nexport default {};" }),
      },
    });
    const studio = createNodeStudioEnv({ rootSecret: "degrade-root-secret-0123456789abcdef" });
    try {
      const call = async (method: string, path: string, body?: unknown, session?: string, orgId?: string) => {
        const res = await app.fetch(
          new Request(`https://studio.local${path}`, {
            method,
            headers: {
              "content-type": "application/json",
              ...(session ? { authorization: `Bearer ${session}` } : {}),
              ...(orgId ? { "x-org-id": orgId } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          }),
          studio.env,
        );
        const text = await res.text();
        return { status: res.status, text, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
      };
      const session = String((await call("POST", "/api/auth/signup", { email: "degrade@r53.test", password: "Password12345!", name: "D" })).body.token);
      const orgId = String((await call("POST", "/api/orgs", { name: "R53 D", slug: "r53-d" }, session)).body.id);
      const project = "r53-degrade";
      await call("POST", `/api/orgs/${orgId}/projects`, { project }, session);
      await call("POST", `/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, { token: TOKEN, accountId: ACCOUNT, projectId: project }, session);
      await call(
        "POST",
        `/api/projects/${project}/ops`,
        { summary: "s", ops: [{ opId: "op_ws", type: "enable_brick", brickId: "multi-workspace", config: {} }] },
        session,
        orgId,
      );
      // The deploy completes (its smoke check is the last thing it does); the drift check that follows cannot read the account.
      const dep = await call("POST", `/api/projects/${project}/environments/preview/deploy`, {}, session, orgId);
      expect(deployDone).toBe(true);
      expect(dep.status, dep.text).toBe(200);
      const depDrift = (dep.body.environment as { drift: { status: string; error?: string } }).drift;
      expect(depDrift.status).toBe("unknown");
      expect(depDrift.error).toMatch(/HTTP 403/);
      // and the environments list degrades the same way, never a 500
      const envs = await call("GET", `/api/projects/${project}/environments`, undefined, session, orgId);
      expect(envs.status).toBe(200);
      const preview = (envs.body.environments as Array<{ envName: string; drift: { status: string; error?: string } }>).find((e) => e.envName === "preview")!;
      expect(preview.drift.status).toBe("unknown");
    } finally {
      studio.close();
    }
  });
});
