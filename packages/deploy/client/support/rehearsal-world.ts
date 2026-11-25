import { Hono } from "hono";
import { createWorkspaceRoutes, workspaceMiddleware } from "@poc/multi-workspace";
import type { WorkspaceEnv } from "@poc/multi-workspace";
import { applyMigration } from "@poc/sdk";
import mwMigration from "../../../../bricks/multi-workspace/migrations/0001_multi_workspace.sql?raw";
import { stubIdentity } from "../../../../bricks/multi-workspace/test/support/stub-identity.ts";
import walletMigration from "../../../../bricks/credit-wallet/migrations/0001_credit_wallet.sql?raw";
import walletMigration0002 from "../../../../bricks/credit-wallet/migrations/0002_workspace_scoped_idempotency.sql?raw";
import walletMigration0003 from "../../../../bricks/credit-wallet/migrations/0003_order_currency.sql?raw";
import { createFakeGateway, createWalletRoutes } from "../../../../bricks/credit-wallet/src/index.ts";
import { createSqliteD1 } from "../../../../bricks/credit-wallet/client/test/support/sqlite-d1.ts";
import { existsSync, readFileSync } from "node:fs";
import { DEMO_PAGE_FILE } from "../../../../test/support/demo-page-path.ts";
import { createGatedWorker } from "../../src/worker/gate.ts";
import { createClient, resourceNames } from "../../src/provisioner/index.ts";
import { createFakeCloudflare } from "../../test/support/fake-cloudflare.ts";

// A stand-in for the deployed project, for rehearsing H12 offline: the same routes the assembled project mounts (workspaces and
// the wallet, with the same stub identity), behind the same access-key gate that serves the real demo page, on Node's SQLite
// instead of D1, with Cloudflare's REST side played by the fake and its D1 query endpoint carried out on that same database.
// It shows that the protocol, the widget and the page work together; only the real account shows they work on Cloudflare.

export const TOKEN = "cfut_Zq8rLm3VxN2pTb7YkWd4HsJc9GaE5uRo6QiXf1BvPn0AyMt";
export const ACCOUNT = "0123456789abcdef0123456789abcdef";
export const KEY = "9f".repeat(32);
export const names = resourceNames("0a1b2c3d");
export const URL_BASE = `https://${names.script}.fake-subdomain.workers.dev`;

/** Hooks a test can set to break the stand-in on purpose: the Worker answering with an error after doing the work, or never answering, and the REST side failing. */
export interface Breaks {
  /** Called for every request the Worker receives; return "lose" to do the work and answer 502, "drop" to answer 502 without doing it. */
  worker?: (request: { method: string; path: string; n: number }) => "lose" | "drop" | undefined;
  /** Called for every D1 query sent over REST; return "drop" to fail it before it is carried out, "lose" to carry it out and then fail it (the answer is lost). */
  rest?: (call: { n: number; sql: string; params: string }) => "drop" | "lose" | undefined;
}

export async function rehearsalWorld(breaks: Breaks = {}) {
  const db = createSqliteD1();
  await applyMigration(db, mwMigration);
  await applyMigration(db, walletMigration);
  await applyMigration(db, walletMigration0002);
  await applyMigration(db, walletMigration0003);
  const app = new Hono<WorkspaceEnv>();
  app.use("/api/*", stubIdentity);
  app.route("/api", createWorkspaceRoutes());
  app.use("/api/wallet", workspaceMiddleware);
  app.use("/api/wallet/*", workspaceMiddleware);
  app.use("/api/payments/create-order", workspaceMiddleware);
  app.route("/api", createWalletRoutes({ gateway: createFakeGateway(), currency: "INR", creditsPerUnit: 1, minOrderAmount: 1 }));
  const gated = createGatedWorker({ app: app as never, demoHtml: existsSync(DEMO_PAGE_FILE) ? readFileSync(DEMO_PAGE_FILE, "utf8") : "<!doctype html><title>stand-in</title>" });
  const env = { DB: db, POC_ACCESS_KEY: KEY };
  const requestsToWorker: Array<{ method: string; path: string }> = [];
  let workerCalls = 0;
  const fetchUrl = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    requestsToWorker.push({ method: request.method, path: url.pathname });
    workerCalls += 1;
    const broken = breaks.worker?.({ method: request.method, path: url.pathname, n: workerCalls });
    if (broken === "drop") return new Response("bad gateway", { status: 502 });
    // built field by field: copying a Request object into another drops its headers in this environment
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
    const answer = await gated.fetch(new Request(`http://deployed.invalid${url.pathname}${url.search}`, { method: request.method, headers: Object.fromEntries(request.headers), body }), env, {});
    return broken === "lose" ? new Response("bad gateway", { status: 502 }) : answer;
  };

  const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT });
  fake.seedScript(names.script, "export class GraphRunner {}");
  let restCalls = 0;
  const bridge = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "POST" && /\/d1\/database\/[^/]+\/query$/.test(url.pathname)) {
      restCalls += 1;
      const body = (await request.json()) as { sql?: string; params?: unknown[]; batch?: Array<{ sql: string; params?: unknown[] }> };
      const statements = body.batch ?? [{ sql: body.sql!, params: body.params }];
      const brokenRest = breaks.rest?.({ n: restCalls, sql: statements.map((s) => s.sql).join(" ; "), params: JSON.stringify(statements.map((s) => s.params ?? [])) });
      if (brokenRest === "drop") throw new TypeError("fetch failed (simulated dropped connection)");
      const prepared = statements.map((s) => db.prepare(s.sql).bind(...(s.params ?? [])));
      try {
        let result;
        if (statements.every((s) => /^\s*select/i.test(s.sql))) result = await Promise.all(prepared.map(async (p) => ({ results: (await p.all()).results, success: true, meta: {} })));
        else result = (await db.batch(prepared)).map((r) => ({ results: [], success: true, meta: { changes: r.meta.changes } }));
        if (brokenRest === "lose") throw new TypeError("fetch failed (simulated: the work was done and the answer lost)");
        return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { status: 200, headers: { "content-type": "application/json" } });
      } catch (error) {
        if (error instanceof TypeError) throw error;
        // like the real endpoint: a failed statement is a 400 carrying the database's own message, and the batch was rolled back
        return new Response(JSON.stringify({ success: false, errors: [{ code: 7500, message: `D1_ERROR: ${error instanceof Error ? error.message : String(error)}: SQLITE_ERROR` }], messages: [], result: null }), { status: 400, headers: { "content-type": "application/json" } });
      }
    }
    return fake.fetch(request);
  };
  const cloudflareClient = (now: () => number) => createClient({ credentials: { token: TOKEN, accountId: ACCOUNT }, fetch: bridge, now, sleep: async () => undefined, alsoHide: [KEY] });
  return { db, fetchUrl, requestsToWorker, fake, cloudflareClient };
}
