import { describe, expect, test } from "vitest";
import {
  NO_WORKERS_DEV_SUBDOMAIN_MESSAGE,
  createByocProvisioner,
  createHttpCloudflareApiClient,
  isHttpWriteCall,
  verifyCloudflareToken,
} from "../src/index.ts";
import type { DeployTarget, HttpCloudflareApiClient } from "../src/index.ts";
import { createClient, createRequestBudget, deploy, memoryStore, openLedger, resourceNames } from "../src/provisioner/index.ts";
import type { DeployInput } from "../src/provisioner/index.ts";
import { KEY_HEADER } from "../src/worker/gate.ts";
import { runSmokeCheck } from "../src/provisioner/deploy.ts";
import { createFakeCloudflare } from "./support/fake-cloudflare.ts";

// Story R53 (1.2): the real CloudflareApiClient over HTTP, checked against the fake Cloudflare (no network). What it proves:
// the mapping onto Cloudflare's documented REST shapes, the rate budget, real token verification and the smoke check's key.

const TOKEN = "cfut_R53hTtPcLiEnTtEsT0kEn9x8w7v6u5t4s3r2q1p0oNmLkJi";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ALL_GROUPS = ["Account Settings Read", "Workers Scripts Write", "D1 Write", "Queues Write"];

function freeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

function setup(fakeOptions: Partial<Parameters<typeof createFakeCloudflare>[0]> = {}) {
  const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT, tokenGroups: ALL_GROUPS, ...fakeOptions });
  const clock = freeClock();
  const budget = createRequestBudget({ now: clock.now, sleep: clock.sleep });
  const cp = createHttpCloudflareApiClient({ fetch: fake.fetch, now: clock.now, sleep: clock.sleep, budgetFor: () => budget });
  return { fake, cp, clock, budget };
}

describe("request budget (1,200 per five minutes per account, kept below at 1,100)", () => {
  test("requests wait for budget instead of failing, on an injected clock", async () => {
    const clock = freeClock();
    const budget = createRequestBudget({ limit: 3, windowMs: 3_000, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 6; i += 1) await budget.take();
    // three immediately, then one per second of refill
    expect(clock.sleeps.length).toBeGreaterThanOrEqual(3);
    expect(clock.now()).toBeGreaterThanOrEqual(3_000);
    expect(budget.waitedMs()).toBeGreaterThanOrEqual(3_000);
  });

  test("a frozen clock still ends: the wait itself is credited", async () => {
    const sleeps: number[] = [];
    const budget = createRequestBudget({ limit: 1, windowMs: 1_000, now: () => 0, sleep: async (ms) => void sleeps.push(ms) });
    await budget.take();
    await budget.take();
    expect(sleeps.length).toBeGreaterThan(0);
  });

  test("the default budget is 1,100 per five minutes, below Cloudflare's 1,200", () => {
    const budget = createRequestBudget();
    expect(budget.limit).toBe(1_100);
    expect(budget.limit).toBeLessThan(1_200);
    expect(budget.windowMs).toBe(300_000);
  });

  test("every REST attempt draws from the budget; a burst beyond it waits, none fails", async () => {
    const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT });
    const clock = freeClock();
    const budget = createRequestBudget({ limit: 2, windowMs: 2_000, now: clock.now, sleep: clock.sleep });
    const client = createClient({ credentials: { token: TOKEN, accountId: ACCOUNT }, fetch: fake.fetch, now: clock.now, sleep: clock.sleep, budget });
    for (let i = 0; i < 5; i += 1) await client.listScripts();
    expect(client.calls.filter((c) => c.outcome === "ok")).toHaveLength(5);
    expect(budget.waitedMs()).toBeGreaterThan(0);
  });

  test("a 429 is still retried after Retry-After, with the budget in place", async () => {
    const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT });
    fake.fail({
      when: (m, p) => m === "GET" && p.endsWith("/workers/scripts"),
      times: 1,
      respond: { status: 429, body: { success: false, errors: [{ code: 971, message: "rate limited" }] }, headers: { "retry-after": "2" } },
    });
    const clock = freeClock();
    const client = createClient({
      credentials: { token: TOKEN, accountId: ACCOUNT },
      fetch: fake.fetch,
      now: clock.now,
      sleep: clock.sleep,
      budget: createRequestBudget({ now: clock.now, sleep: clock.sleep }),
    });
    expect(await client.listScripts()).toEqual([]);
    expect(client.calls.map((c) => c.status)).toEqual([429, 200]);
    expect(clock.sleeps).toContain(2_000);
  });
});

describe("verifyCloudflareToken with the real client asks Cloudflare", () => {
  test("a valid scoped token: active, all four permissions from its own policies", async () => {
    const { fake, cp } = setup({ accountName: "Owner Account" });
    const report = await verifyCloudflareToken(TOKEN, ACCOUNT, { client: cp });
    expect(report).toMatchObject({ ok: true, status: "active", accountId: ACCOUNT, accountName: "Owner Account", missingPermissionIds: [] });
    expect(report.permissions.every((p) => p.granted)).toBe(true);
    expect(fake.requests.some((r) => r.method === "GET" && r.path.endsWith("/tokens/verify"))).toBe(true);
  });

  test("a token without D1 Edit is refused and the missing permission is named", async () => {
    const { cp } = setup({ tokenGroups: ["Account Settings Read", "Workers Scripts Write", "Queues Write"] });
    const report = await verifyCloudflareToken(TOKEN, ACCOUNT, { client: cp });
    expect(report.ok).toBe(false);
    expect(report.status).toBe("active");
    expect(report.missingPermissionLabels).toEqual(["D1: Edit"]);
  });

  test("a token that cannot read its own policies is checked with harmless reads, and a refused read names the permission", async () => {
    const { fake, cp } = setup({ tokenGroups: null });
    fake.fail({
      when: (m, p) => m === "GET" && p.endsWith("/queues"),
      respond: { status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] } },
    });
    const report = await verifyCloudflareToken(TOKEN, ACCOUNT, { client: cp });
    expect(report.ok).toBe(false);
    expect(report.missingPermissionLabels).toEqual(["Queues: Edit"]);
    const reads = fake.requests.filter((r) => r.method === "GET").map((r) => r.path);
    expect(reads).toEqual(
      expect.arrayContaining([
        "/client/v4/accounts/{account}/workers/scripts",
        "/client/v4/accounts/{account}/d1/database",
        "/client/v4/accounts/{account}/queues",
      ]),
    );
    expect(fake.requests.every((r) => r.method === "GET")).toBe(true); // verification never writes
  });

  test("a revoked token is refused as invalid by Cloudflare's answer", async () => {
    const { cp } = setup({ tokenStatus: "revoked" });
    const report = await verifyCloudflareToken(TOKEN, ACCOUNT, { client: cp });
    expect(report).toMatchObject({ ok: false, status: "invalid" });
  });

  test("a disabled token reports Cloudflare's own status", async () => {
    const { cp } = setup({ tokenStatus: "disabled" });
    const report = await verifyCloudflareToken(TOKEN, ACCOUNT, { client: cp });
    expect(report).toMatchObject({ ok: false, status: "disabled" });
  });

  test("a fake prefix is not trusted: 'cf_scoped_valid_token' is a token Cloudflare does not know (invalid), judged by Cloudflare", async () => {
    const { fake, cp } = setup();
    const report = await verifyCloudflareToken("cf_scoped_valid_token_story53_least_privilege", ACCOUNT, { client: cp });
    expect(report).toMatchObject({ ok: false, status: "invalid" });
    expect(fake.requests.filter((r) => r.path.endsWith("/tokens/verify")).map((r) => r.path)).toEqual([
      "/client/v4/accounts/{account}/tokens/verify",
      "/client/v4/user/tokens/verify",
    ]);
  });

  test("a legacy Global API Key is refused without being sent anywhere", async () => {
    const { fake, cp } = setup();
    const report = await verifyCloudflareToken("0123456789abcdef0123456789abcdef01234", ACCOUNT, { client: cp });
    expect(report).toMatchObject({ ok: false, isGlobalApiKey: true });
    expect(fake.requests).toHaveLength(0);
  });

  test("there is no verification without a client", async () => {
    await expect(verifyCloudflareToken(TOKEN, ACCOUNT)).rejects.toThrow(/needs a Cloudflare client/);
  });
});

describe("account tokens and user tokens: both verify endpoints", () => {
  const verifyPaths = (fake: ReturnType<typeof createFakeCloudflare>) => fake.requests.filter((r) => r.path.endsWith("/tokens/verify")).map((r) => r.path);
  const rest = (fake: ReturnType<typeof createFakeCloudflare>) =>
    createClient({ credentials: { token: TOKEN, accountId: ACCOUNT }, fetch: fake.fetch, sleep: async () => {} });

  test("an account token is verified at the account endpoint alone, and its permissions come from its own policies", async () => {
    const { fake, cp } = setup({ tokenKind: "account" });
    expect(await rest(fake).verifyToken()).toMatchObject({ status: "active", kind: "account" });
    fake.requests.length = 0;
    const report = await verifyCloudflareToken(TOKEN, ACCOUNT, { client: cp });
    expect(report).toMatchObject({ ok: true, status: "active" });
    expect(verifyPaths(fake)).toEqual(["/client/v4/accounts/{account}/tokens/verify"]);
    expect(fake.requests.some((r) => r.path.endsWith("/tokens/fake-token-id"))).toBe(true);
  });

  test("a user token (My Profile): the account endpoint says 1000 Invalid API Token, the user endpoint says active, and the token is accepted", async () => {
    const { fake, cp } = setup({ tokenKind: "user", tokenGroups: ALL_GROUPS });
    expect(await rest(fake).verifyToken()).toMatchObject({ status: "active", kind: "user", id: "fake-user-token-id" });
    fake.requests.length = 0;
    const report = await verifyCloudflareToken(TOKEN, ACCOUNT, { client: cp });
    expect(report).toMatchObject({ ok: true, status: "active", missingPermissionIds: [] });
    expect(verifyPaths(fake)).toEqual(["/client/v4/accounts/{account}/tokens/verify", "/client/v4/user/tokens/verify"]);
    // a user token's policies are not read at /accounts/{id}/tokens/{id}: the capability reads decide
    expect(fake.requests.some((r) => /\/tokens\/fake-(user-)?token-id$/.test(r.path))).toBe(false);
    const reads = fake.requests.map((r) => r.path);
    expect(reads).toEqual(
      expect.arrayContaining([
        "/client/v4/accounts/{account}",
        "/client/v4/accounts/{account}/workers/scripts",
        "/client/v4/accounts/{account}/d1/database",
        "/client/v4/accounts/{account}/queues",
      ]),
    );
    expect(fake.requests.every((r) => r.method === "GET")).toBe(true);
  });

  test("a user token missing a capability is refused, naming it", async () => {
    const { fake, cp } = setup({ tokenKind: "user" });
    fake.fail({
      when: (m, p) => m === "GET" && p.endsWith("/d1/database"),
      respond: { status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] } },
    });
    const report = await verifyCloudflareToken(TOKEN, ACCOUNT, { client: cp });
    expect(report.ok).toBe(false);
    expect(report.missingPermissionLabels).toEqual(["D1: Edit"]);
  });

  test("an invalid token fails both endpoints and is refused", async () => {
    const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT });
    const cp = createHttpCloudflareApiClient({ fetch: fake.fetch, sleep: async () => {}, budgetFor: () => createRequestBudget() });
    const report = await verifyCloudflareToken("cfut_not_a_token_cloudflare_knows_000000000000000", ACCOUNT, { client: cp });
    expect(report).toMatchObject({ ok: false, status: "invalid" });
    expect(verifyPaths(fake)).toEqual(["/client/v4/accounts/{account}/tokens/verify", "/client/v4/user/tokens/verify"]);
    const other = createClient({
      credentials: { token: "cfut_not_a_token_cloudflare_knows_000000000000000", accountId: ACCOUNT },
      fetch: fake.fetch,
      sleep: async () => {},
    });
    await expect(other.verifyToken()).rejects.toThrow(/Invalid API Token|HTTP 401/);
  });

  test("a revoked user token: the user endpoint reports status revoked, and the token is refused", async () => {
    const { fake, cp } = setup({ tokenKind: "user", tokenStatus: "revoked" });
    const report = await verifyCloudflareToken(TOKEN, ACCOUNT, { client: cp });
    expect(report.ok).toBe(false);
    expect(report.status).not.toBe("active");
    expect(verifyPaths(fake)).toEqual(["/client/v4/accounts/{account}/tokens/verify", "/client/v4/user/tokens/verify"]);
  });

  test("a revoked user token: the user endpoint answers with an error, and the token is refused", async () => {
    const { fake, cp } = setup({ tokenKind: "user" });
    fake.fail({
      when: (m, p) => m === "GET" && p === "/client/v4/user/tokens/verify",
      respond: { status: 401, body: { success: false, errors: [{ code: 1000, message: "Invalid API Token" }] } },
    });
    const report = await verifyCloudflareToken(TOKEN, ACCOUNT, { client: cp });
    expect(report).toMatchObject({ ok: false, status: "invalid" });
  });
});

describe("Studio's provisioner on the real client (createByocProvisioner + createHttpCloudflareApiClient)", () => {
  const target: DeployTarget = { type: "byoc", accountId: ACCOUNT, tokenRef: "tok_r53_reference", envName: "preview" };
  const code = (v: string) => `export class GraphRunner {} export default { fetch() { return new Response(${JSON.stringify(v)}); } };`;
  const apply = (cp: HttpCloudflareApiClient, version: string, extra: Record<string, unknown> = {}) =>
    createByocProvisioner({ apiClient: cp, resolveToken: async () => TOKEN }).apply({
      target,
      project: "r53-proj",
      buildHash: `build_${version}`,
      codeHash: `code_${version}`,
      graphHash: "graph_1",
      bundle: { code: code(version), sha256: `code_${version}` },
      migrations: [{ name: "0001_init.sql", sql: "CREATE TABLE items (id TEXT PRIMARY KEY);", sha256: "m1" }],
      workflows: [{ name: "px-r53-proj-preview-graphs", className: "GraphRunner" }],
      graphs: { wf_one: JSON.stringify({ id: "wf_one", nodes: [], edges: [] }) },
      secrets: { POC_ACCESS_KEY: "k".repeat(64) },
      workerBindings: [
        { type: "plain_text", name: "PX_ENVIRONMENT", text: "preview" },
        { type: "workflow", name: "GRAPH_RUNNER", workflow_name: "px-r53-proj-preview-graphs", class_name: "GraphRunner" },
      ],
      ...extra,
    } as never);

  test("first deploy creates the database, runs the migration, uploads with DB and Workflow bindings, sets the secret and the address", async () => {
    const { fake, cp } = setup();
    const result = await apply(cp, "v1");
    expect(result.action).toBe("create");
    const state = fake.state();
    expect(state.databases.map((d) => d.name)).toEqual(["px-r53-proj-preview-db"]);
    expect(state.databases[0]!.tables).toEqual(expect.arrayContaining(["items", "_projectx_migrations", "_projectx_studio_state", "poc_graphs"]));
    const script = state.scripts.find((s) => s.name === "px-r53-proj-preview")!;
    expect(script.bindingTypes).toEqual(expect.arrayContaining(["d1", "plain_text", "workflow", "secret_text"]));
    expect(script.addressEnabled).toBe(true);
    expect(fake.secretOf("px-r53-proj-preview", "POC_ACCESS_KEY")).toBe("k".repeat(64));
    expect(state.workflows).toEqual([{ name: "px-r53-proj-preview-graphs", className: "GraphRunner", script: "px-r53-proj-preview" }]);
    expect(result.url).toBe("https://px-r53-proj-preview.fake-subdomain.workers.dev");
    expect(fake.rows("px-r53-proj-preview-db", "SELECT workspace_id, id FROM poc_graphs")).toEqual([{ workspace_id: "__app__", id: "wf_one" }]);
    // the secret value never enters the call log
    expect(JSON.stringify(cp.httpCalls)).not.toContain("k".repeat(64));
  });

  test("a redeploy with nothing changed is a no-op with zero write calls", async () => {
    const { cp } = setup();
    await apply(cp, "v1");
    const before = cp.httpCalls.length;
    const again = await apply(cp, "v1", {
      envState: {
        deployedRev: 1,
        currentBuildHash: "build_v1",
        currentCodeHash: "code_v1",
        currentGraphHash: "graph_1",
        databaseExists: true,
        appliedMigrations: ["0001_init.sql"],
      },
    });
    expect(again.action).toBe("noop");
    expect(again.appliedActions).toEqual([]);
    expect(again.mutatingCallCount).toBe(0);
    expect(cp.httpCalls.slice(before).filter(isHttpWriteCall)).toEqual([]);
  });

  test("a code change re-uploads, keeps the secret, and does not re-run the migration", async () => {
    const { fake, cp } = setup();
    await apply(cp, "v1");
    const result = await apply(cp, "v2", {
      envState: {
        deployedRev: 1,
        currentBuildHash: "build_v1",
        currentCodeHash: "code_v1",
        currentGraphHash: "graph_1",
        databaseExists: true,
        appliedMigrations: ["0001_init.sql"],
      },
    });
    expect(result.action).toBe("update");
    expect(result.rebuiltWorker).toBe(true);
    expect(cp.scriptUploadCount).toBe(2);
    expect(fake.state().scripts[0]!.bindingTypes).toContain("secret_text");
    expect(fake.rows("px-r53-proj-preview-db", "SELECT name FROM _projectx_migrations")).toEqual([{ name: "0001_init.sql" }]);
  });

  test("an account without a workers.dev subdomain gets a clear error saying how to enable it, and nothing is uploaded", async () => {
    const { fake, cp } = setup({ subdomain: null });
    await expect(apply(cp, "v1")).rejects.toThrow(NO_WORKERS_DEV_SUBDOMAIN_MESSAGE);
    expect(NO_WORKERS_DEV_SUBDOMAIN_MESSAGE).toMatch(/dashboard/);
    expect(fake.state().scripts).toEqual([]);
  });

  test("queues and cron triggers go to their real endpoints", async () => {
    const { fake, cp } = setup();
    await apply(cp, "v1", { queues: ["px-r53-proj-preview-jobs"], cronTriggers: ["*/5 * * * *"] });
    expect(fake.queues().map((q) => q.name)).toEqual(["px-r53-proj-preview-jobs"]);
    const script = await cp.getScript(ACCOUNT, TOKEN, "px-r53-proj-preview");
    expect(script?.cronTriggers).toEqual(["*/5 * * * *"]);
    await cp.deleteQueue(ACCOUNT, TOKEN, "px-r53-proj-preview-jobs");
    expect(fake.queues()).toEqual([]);
  });
});

describe("the smoke check sends the access key the gate requires", () => {
  const ACCESS_KEY = "a1".repeat(32);
  const gated = (version: string, _code: string, request: Request) =>
    request.headers.get(KEY_HEADER) === ACCESS_KEY
      ? new Response(JSON.stringify({ ok: true, version }), { status: 200 })
      : new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });

  test("without the header the gated Worker answers 401 and the smoke check fails", async () => {
    const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT, healthzStub: gated });
    const client = createClient({ credentials: { token: TOKEN, accountId: ACCOUNT }, fetch: fake.fetch });
    await expect(runSmokeCheck(client, "https://x.fake-subdomain.workers.dev", "x", "v1", undefined, async () => {})).rejects.toThrow(/HTTP 401/);
    await expect(runSmokeCheck(client, "https://x.fake-subdomain.workers.dev", "x", "v1", ACCESS_KEY, async () => {})).resolves.toBeUndefined();
  });

  test("a redeploy that uploads new code passes the smoke check behind the gate", async () => {
    const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT, healthzStub: gated });
    const client = createClient({ credentials: { token: TOKEN, accountId: ACCOUNT }, fetch: fake.fetch, alsoHide: [ACCESS_KEY] });
    const ledger = openLedger(memoryStore(), () => "0a1b2c3d");
    const names = resourceNames("0a1b2c3d");
    const input = (code: string): DeployInput => ({
      client,
      ledger,
      names,
      accessKey: ACCESS_KEY,
      bundle: { code, sha256: code.length.toString(16).padStart(64, "0") },
      migrations: [],
      compatibilityDate: "2026-10-01",
    });
    await deploy(input("export default { fetch() { return new Response('one'); } };"));
    const second = await deploy(input("export default { fetch() { return new Response('two!'); } };"));
    expect(second.changes.map((c) => c.kind)).toContain("script_uploaded");
    const smoke = client.calls.filter((c) => c.path.includes("/smoke/"));
    expect(smoke.length).toBeGreaterThan(0);
    expect(smoke.every((c) => c.status === 200)).toBe(true);
    expect(JSON.stringify(client.calls)).not.toContain(ACCESS_KEY);
  });
});
