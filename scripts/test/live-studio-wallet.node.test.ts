import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { applyMigration } from "../../packages/sdk/src/index.ts";
import type { D1Like } from "../../packages/sdk/src/index.ts";
import { createStudioApiApp, deriveWorkerAccessKey } from "../../apps/studio-api/src/index.ts";
import { createFakeCloudflare } from "../../packages/deploy/test/support/fake-cloudflare.ts";
import { KEY_HEADER } from "../../packages/deploy/src/worker/gate.ts";
import { WORKFLOW_RUNS_PATH } from "../../packages/deploy/src/worker/proof-routes.ts";
import { GRAPH_MIGRATIONS, TELEMETRY_MIGRATION, WORKFLOW_BINDING, WORKFLOW_CLASS } from "../../packages/deploy/src/worker/graph-run.ts";
import { migrationsFrom } from "../../packages/deploy/src/provisioner/index.ts";
import { deriveProjectSecret, signControlPlaneRequest } from "../../packages/telemetry/src/index.ts";
import { FUNDED_MILLI, GRAPH_ID, LIVE_PROOF_BRICK_SECRETS, liveProofOps, liveProofRunPayload, nodeBundler } from "../live-studio-deploy.ts";
import { createNodeStudioEnv } from "../lib/studio-node-env.ts";

// Story 1.2, live run 1, step 5: the signed run was accepted (202) but no debit landed. This replays step 5 offline with the
// pieces the live run used: Studio's assembled files for the live blueprint, the live command's own bundler (production), the
// graph row exactly as Studio stored it, the wallet funded exactly as the script funds it, and the script's signed run body,
// in a local workerd with a real Workflow and D1. Nothing reaches Cloudflare.

const TOKEN = "cfut_R53WalletReplayTokeniiiiiiiiiiiiiiiiiiiiiiiiiiiiiii";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ROOT = "wallet-replay-root-0123456789abcdef";
let mf: Miniflare | undefined;
afterAll(async () => {
  await mf?.dispose();
});

describe("live step 5, offline: the signed run debits the funded workspace exactly once with the real executor", () => {
  test("Studio's stored graph + the script's run payload debit the wallet once in the real production bundle", { timeout: 300_000 }, async () => {
    const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT, tokenGroups: ["Account Settings Read", "Workers Scripts Write", "D1 Write", "Queues Write"] });
    let files: Record<string, string> | null = null;
    const app = createStudioApiApp({
      deploy: {
        fetch: fake.fetch,
        workerFetch: fake.fetch,
        sleep: async () => {},
        bundle: async (input) => {
          files = input.files;
          return { code: "export class GraphRunner {}\nexport default {};" };
        },
      },
    });
    const studio = createNodeStudioEnv({ rootSecret: ROOT });
    const project = "tangebricks-test-0c0c0c0c";
    try {
      const call = async (path: string, body: unknown, session?: string, orgId?: string) => {
        const res = await app.fetch(new Request(`https://studio.local${path}`, { method: "POST", headers: { "content-type": "application/json", ...(session ? { authorization: `Bearer ${session}` } : {}), ...(orgId ? { "x-org-id": orgId } : {}) }, body: JSON.stringify(body) }), studio.env);
        const text = await res.text();
        return { status: res.status, text, body: JSON.parse(text || "{}") as Record<string, unknown> };
      };
      const session = String((await call("/api/auth/signup", { email: "wallet@r53.test", password: "Password12345!", name: "W" })).body.token);
      const orgId = String((await call("/api/orgs", { name: "R53 W", slug: "r53-w" }, session)).body.id);
      await call(`/api/orgs/${orgId}/projects`, { project }, session);
      expect((await call(`/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, { token: TOKEN, accountId: ACCOUNT, projectId: project }, session)).status).toBe(201);
      expect((await call(`/api/projects/${project}/ops`, { summary: "live blueprint", ops: liveProofOps() }, session, orgId)).status).toBe(200);
      expect(LIVE_PROOF_BRICK_SECRETS).toEqual([]);
      const dep = await call(`/api/projects/${project}/environments/preview/deploy`, {}, session, orgId);
      expect(dep.status, dep.text.slice(0, 400)).toBe(200);
    } finally {
      studio.close();
    }
    expect(files).not.toBeNull();
    // the graph row exactly as Studio stored it in the environment's D1
    const storedGraph = fake.rows(`px-${project}-preview-db`, `SELECT workspace_id, id, graph FROM poc_graphs WHERE id = '${GRAPH_ID}'`)[0]!;
    expect(storedGraph.workspace_id).toBe("__app__");

    const bundle = await nodeBundler({ project, envName: "production", files: files! });
    const accessKey = await deriveWorkerAccessKey(ROOT, project, "production");
    const controlPlaneSecret = await deriveProjectSecret(ROOT, project, "control-plane");
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: bundle.code,
        compatibilityDate: "2026-10-01",
        d1Databases: ["DB"],
        bindings: { POC_ACCESS_KEY: accessKey, PX_TELEMETRY_SECRET: controlPlaneSecret, PX_ENVIRONMENT: "production", PX_PROJECT_ID: project },
        workflows: { [WORKFLOW_BINDING]: { name: `px-${project}-production-graphs`, className: WORKFLOW_CLASS } },
      } as never),
    );
    await mf.ready;
    const db = (await mf.getD1Database("DB")) as unknown as D1Like;
    for (const m of [...migrationsFrom(files!), ...GRAPH_MIGRATIONS, TELEMETRY_MIGRATION]) await applyMigration(db, m.sql);
    await db.prepare("INSERT INTO poc_graphs (workspace_id, id, graph, updated_at) VALUES (?1, ?2, ?3, ?4)").bind(storedGraph.workspace_id, storedGraph.id, storedGraph.graph, new Date().toISOString()).run();

    // funded exactly as the script funds it
    const workspaceId = "ws_live_0c0c0c0c";
    await db.prepare("INSERT INTO credit_wallets (workspace_id, balance_milli) VALUES (?, ?) ON CONFLICT(workspace_id) DO UPDATE SET balance_milli = excluded.balance_milli").bind(workspaceId, FUNDED_MILLI).run();

    const signed = async (method: string, path: string, body = "") => (await mf!.dispatchFetch(`http://deployed.invalid${path}`, { method, headers: { [KEY_HEADER]: accessKey, "content-type": "application/json", ...(await signControlPlaneRequest(controlPlaneSecret, method, path, body)) }, ...(body ? { body } : {}) } as never)) as unknown as Response;
    // the script's own run body
    const runBody = JSON.stringify({ requestId: randomUUID(), graphId: GRAPH_ID, workspaceId, payload: liveProofRunPayload(workspaceId) });
    const started = await signed("POST", WORKFLOW_RUNS_PATH, runBody);
    expect(started.status).toBe(202);
    const { id } = (await started.json()) as { id: string };
    let status: { status: string; output?: { ok?: boolean; failed?: Record<string, string> } | null; error?: unknown } = { status: "queued" };
    for (const deadline = Date.now() + 30_000; Date.now() < deadline; await new Promise((r) => setTimeout(r, 50))) {
      status = (await (await signed("GET", `/poc/runs/${id}`)).json()) as typeof status;
      if (["complete", "errored", "terminated"].includes(status.status)) break;
    }
    expect(status.status, JSON.stringify(status)).toBe("complete");
    expect(status.output?.ok, JSON.stringify(status.output)).toBe(true);
    const balance = await db.prepare("SELECT balance_milli FROM credit_wallets WHERE workspace_id = ?").bind(workspaceId).first<{ balance_milli: number }>();
    const deductions = await db.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE workspace_id = ? AND type = 'deduction'").bind(workspaceId).first<{ n: number }>();
    expect(deductions?.n).toBe(1);
    expect(balance?.balance_milli).toBe(FUNDED_MILLI - 5_000);
  });
});
