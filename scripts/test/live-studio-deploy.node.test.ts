import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createFakeCloudflare } from "../../packages/deploy/test/support/fake-cloudflare.ts";
import type { FakeCloudflare } from "../../packages/deploy/test/support/fake-cloudflare.ts";
import { checkControlPlaneSignature, signControlPlaneRequest } from "../../packages/telemetry/src/index.ts";
import { KEY_HEADER } from "../../packages/deploy/src/worker/gate.ts";
import { WORKFLOW_RUNS_PATH } from "../../packages/deploy/src/worker/proof-routes.ts";
import { isTenantWorkspaceId } from "../../packages/deploy/src/worker/graph-run.ts";
import { RequestGuardError, STUDIO_TEST_NAME_POLICY, createClient, memoryStore, openLedger } from "../../packages/deploy/src/provisioner/index.ts";
import { CALLS_FILE, LIVE_PROOF_USER_ID, LiveProofRefusal, RESULT_FILE, createGuardedFetch, liveProofRunPayload, runLiveStudioDeploy, runTeardownOnly } from "../live-studio-deploy.ts";
import type { CallLine } from "../live-studio-deploy.ts";

// Story R53: the live Studio deploy proof's whole flow, offline. Cloudflare's API is the fake (real SQLite D1, documented
// shapes); the deployed Worker is stood in for by a small simulator that checks what the real gate and signed route check
// (the access key, the control-plane signature, the workspace) against the secrets the fake says the Worker was given, and
// debits the wallet in the fake's D1. What this proves: the script's logic (Studio's routes on the real client, the guard,
// the ledger, the evidence, the teardown). What it does not: that Cloudflare and the bundled Worker behave as documented;
// the live run settles that.

const TOKEN = "cfut_LiveStudioProofOfflineTokenR53aaaaaaaaaaaaaaaaaaaa";
const REVOKED = "cfut_RevokedStudioProofOfflineTokenR53bbbbbbbbbbbbbbbbbb";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ROOT_SECRET = "offline-root-secret-r53-0123456789abcdef";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** Stands in for the deployed Worker: the gate's key check, the signed /__px/workflow-runs route, and the debit it runs. */
/** Cloudflare's record of each simulated Workflow run, by instance id, as GET .../instances/{id} answers it. */
type RunRecords = Map<string, Record<string, unknown>>;

function workerSimulator(fake: FakeCloudflare, runs: RunRecords = new Map()) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const script = url.hostname.split(".")[0]!;
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const key = fake.secretOf(script, "POC_ACCESS_KEY");
    if (!key || request.headers.get(KEY_HEADER) !== key) return json(401, { error: "unauthorized" });
    if (url.pathname === "/healthz") return json(200, { ok: true });
    if (url.pathname !== WORKFLOW_RUNS_PATH || request.method !== "POST") return json(404, {});
    const secret = fake.secretOf(script, "PX_TELEMETRY_SECRET")!;
    const body = await request.text();
    const refusal = await checkControlPlaneSignature(request, { secret, body, nowMs: Date.now(), path: WORKFLOW_RUNS_PATH });
    if (refusal) return json(refusal.status, { error: { code: refusal.code } });
    const parsed = JSON.parse(body) as { requestId: string; graphId: string; workspaceId?: string; payload?: { userId?: unknown } };
    if (!parsed.workspaceId) return json(400, { error: { code: "NO_WORKSPACE" } });
    if (!isTenantWorkspaceId(parsed.workspaceId)) return json(400, { error: { code: "BAD_WORKSPACE" } });
    const dbName = `${script}-db`;
    const graph = JSON.parse(String(fake.rows(dbName, `SELECT graph FROM poc_graphs WHERE workspace_id = '__app__' AND id = '${parsed.graphId}'`)[0]!.graph)) as { nodes: Array<{ type: string; data: { amount?: number } }> };
    const amount = graph.nodes.find((n) => n.type === "credit-wallet.debit")!.data.amount! * 1000;
    // As the real executor: credit-wallet.debit needs a userId in the run's input. Without one the run is accepted (202) and the
    // Workflow completes with the debit node failed, so nothing is charged: what live run 1 met.
    if (typeof parsed.payload?.userId !== "string") {
      runs.set(parsed.requestId, { status: "complete", success: true, error: null, output: { ok: false, outputs: {}, failed: { debit: "invalid input: userId: Invalid input: expected string, received undefined" }, skipped: [] }, params: {}, start: null, end: null, steps: [{ type: "step", name: "load graph-1", success: true, attempts: [{}] }] });
      return json(202, { id: parsed.requestId, workspaceId: parsed.workspaceId });
    }
    const balance = Number(fake.rows(dbName, `SELECT balance_milli FROM credit_wallets WHERE workspace_id = '${parsed.workspaceId}'`)[0]!.balance_milli);
    fake.exec(dbName, "UPDATE credit_wallets SET balance_milli = ? WHERE workspace_id = ?", [balance - amount, parsed.workspaceId]);
    fake.exec(dbName, "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount_milli, balance_after_milli, reason) VALUES (?, ?, ?, 'deduction', ?, ?, 'graph run')", [crypto.randomUUID(), parsed.workspaceId, parsed.payload.userId, amount, balance - amount]);
    return json(202, { id: parsed.requestId, workspaceId: parsed.workspaceId });
  };
}

const testBundle = async (input: { project: string; envName: string; files: Record<string, string> }) => ({
  code: `// bundled ${input.project} ${input.envName} (${Object.keys(input.files).length} files)\nexport class GraphRunner {}\nexport default { fetch() { return new Response("ok"); } };`,
});

function world(fakeOptions: Partial<Parameters<typeof createFakeCloudflare>[0]> = {}) {
  const runs: RunRecords = new Map();
  const instanceReads: string[] = [];
  const fake = createFakeCloudflare({
    token: TOKEN,
    accountId: ACCOUNT,
    tokenKind: "user",
    instanceDetails: (workflowName, instanceId) => {
      instanceReads.push(`${workflowName}/${instanceId}`);
      return runs.get(instanceId) ?? null;
    },
    ...fakeOptions,
  });
  const root = mkdtempSync(join(tmpdir(), "live-studio-"));
  roots.push(root);
  const store = memoryStore();
  const lines: string[] = [];
  const deps = {
    credentials: { token: TOKEN, accountId: ACCOUNT },
    rootSecret: ROOT_SECRET,
    revokedToken: REVOKED,
    cloudflareFetch: fake.fetch,
    workerFetch: workerSimulator(fake, runs),
    bundle: testBundle,
    ledgerStore: store,
    randomHex: (n: number) => randomBytes(n).toString("hex"),
    root,
    log: (line: string) => lines.push(line),
    sleep: async () => {},
    pollTimeoutMs: 5_000,
    pollIntervalMs: 1,
  };
  return { fake, root, store, lines, deps, runs, instanceReads };
}

describe("scripts/live-studio-deploy.ts, offline against the fake Cloudflare", () => {
  test("the whole flow passes: connect, deploy preview and production, redeploy with no writes, wallet proof, revoked token, evidence, teardown", { timeout: 120_000 }, async () => {
    const { fake, root, lines, deps } = world();
    const result = await runLiveStudioDeploy(deps);
    expect(result.stoppedBecause, lines.join("\n")).toBeNull();
    expect(result.completed).toBe(true);
    expect(result.project).toMatch(/^tangebricks-test-[0-9a-f]{8}$/);

    const steps = result.steps as Record<string, Record<string, unknown>>;
    expect(steps.connect).toMatchObject({ httpStatus: 201, status: "active" });
    expect(steps.deploy_preview).toMatchObject({ action: "create", healthzStatus: 200 });
    expect(steps.deploy_production).toMatchObject({ healthzStatus: 200 });
    expect(String(steps.deploy_production!.workerUrl)).toBe(`https://px-${result.project}-production.fake-subdomain.workers.dev`);
    expect(steps.redeploy).toMatchObject({ preview: { action: "noop", changes: [], mutatingCallCount: 0 }, production: { action: "noop", changes: [], mutatingCallCount: 0 }, writeCalls: 0 });
    expect(result.writesDuringRedeploy).toBe(0);
    expect(steps.wallet).toMatchObject({ runStatus: 202, afterRun: { deductions: 1, balanceMilli: 95_000 }, noWorkspace: { status: 400, code: "NO_WORKSPACE" }, badWorkspace: { status: 400, code: "BAD_WORKSPACE" }, final: { deductions: 1, balanceMilli: 95_000 } });
    expect(steps.revoked).toMatchObject({ verifyHttpStatus: 422, deployRefused: true });

    // teardown left nothing, and nothing was ever created outside the prefix
    expect(result.teardown!.leftBehind).toEqual([]);
    expect(fake.state().scripts).toEqual([]);
    expect(fake.state().databases).toEqual([]);
    expect(fake.state().workflows).toEqual([]);
    expect(result.teardown!.removed.map((r) => r.name).every((n) => n.startsWith(`px-${result.project}-`))).toBe(true);
    expect(result.teardown!.removed.map((r) => r.kind).sort()).toEqual(["d1_database", "d1_database", "worker_script", "worker_script", "workflow", "workflow"]);

    // the evidence: written, recorded with integrity, and free of every secret
    const resultText = readFileSync(join(root, "evidence", "deployed", RESULT_FILE), "utf8");
    const callsText = readFileSync(join(root, "evidence", "deployed", CALLS_FILE), "utf8");
    const integrity = JSON.parse(readFileSync(join(root, "evidence", "deployed", "integrity.json"), "utf8")) as { files: Record<string, { runTimestamp: string }> };
    expect(integrity.files[`evidence/deployed/${RESULT_FILE}`]?.runTimestamp).toBe(result.commandStartedAt);
    for (const secret of [TOKEN, REVOKED, ACCOUNT, ROOT_SECRET]) {
      expect(resultText).not.toContain(secret);
      expect(callsText).not.toContain(secret);
      expect(lines.join("\n")).not.toContain(secret);
    }
  });

  test("the debit is charged to the proof's user (the executor requires one), exactly once", { timeout: 120_000 }, async () => {
    const { fake, deps } = world();
    let ledgerUsers: unknown[] = [];
    const original = deps.workerFetch;
    const result = await runLiveStudioDeploy({
      ...deps,
      workerFetch: async (request) => {
        const res = await original(request);
        const host = new URL(request.url).hostname;
        if (request.method === "POST" && host.includes("-production.")) ledgerUsers = fake.rows(`${host.split(".")[0]}-db`, "SELECT user_id FROM credit_ledger WHERE type = 'deduction'").map((r) => r.user_id);
        return res;
      },
    });
    expect(result.completed, result.stoppedBecause ?? "").toBe(true);
    expect(ledgerUsers).toEqual([LIVE_PROOF_USER_ID]);
    expect(liveProofRunPayload("ws_x")).toEqual({ userId: LIVE_PROOF_USER_ID, workspaceId: "ws_x" });
  });

  test("when the run is accepted but the debit does not land, Cloudflare's record of the run says why (read-only, pinned, redacted)", { timeout: 120_000 }, async () => {
    const { fake, deps, instanceReads } = world();
    // a payload without the user, as live run 1 sent: the run is accepted (202), its debit node fails, nothing is charged
    const original = deps.workerFetch;
    const result = await runLiveStudioDeploy({
      ...deps,
      workerFetch: async (request) => {
        if (request.method === "POST" && new URL(request.url).pathname === WORKFLOW_RUNS_PATH) {
          const body = JSON.parse(await request.clone().text()) as { payload?: Record<string, unknown> };
          if (body.payload) {
            delete body.payload.userId;
            const text = JSON.stringify(body);
            const headers = new Headers(request.headers);
            // re-sign the altered body, as a client that sent it so would have
            const secret = fake.secretOf(new URL(request.url).hostname.split(".")[0]!, "PX_TELEMETRY_SECRET")!;
            for (const [k, v] of Object.entries(await signControlPlaneRequest(secret, "POST", WORKFLOW_RUNS_PATH, text))) headers.set(k, v);
            return original(new Request(request.url, { method: "POST", headers, body: text }));
          }
        }
        return original(request);
      },
    });
    expect(result.completed).toBe(false);
    expect(result.stoppedBecause).toMatch(/debited the workspace exactly once/);
    const wallet = (result.steps as Record<string, Record<string, unknown>>).wallet!;
    expect(wallet.instance).toMatchObject({ found: true, status: "complete", ok: false, failed: { debit: expect.stringMatching(/userId/) } });
    expect(instanceReads).toHaveLength(1);
    expect(instanceReads[0]).toMatch(/^px-tangebricks-test-[0-9a-f]{8}-production-graphs\/[0-9a-f-]{36}$/);
    const reads = fake.requests.filter((r) => r.path.includes("/instances/"));
    expect(reads.every((r) => r.method === "GET" && r.path.startsWith("/client/v4/accounts/{account}/workflows/"))).toBe(true);
    expect(JSON.stringify(wallet)).not.toContain(TOKEN);
  });

  test("a second run moves the older evidence to attempts/", { timeout: 120_000 }, async () => {
    const { root, deps } = world();
    await runLiveStudioDeploy(deps);
    const again = await runLiveStudioDeploy({ ...deps, ledgerStore: memoryStore() });
    expect(again.completed).toBe(true);
    expect(existsSync(join(root, "evidence", "deployed", "attempts"))).toBe(true);
  });

  test("an unledgered px-tangebricks-test-* resource in the account stops the run before anything is created", async () => {
    const { fake, deps } = world();
    fake.seedDatabase("px-tangebricks-test-deadbeef-preview-db");
    await expect(runLiveStudioDeploy(deps)).rejects.toThrow(LiveProofRefusal);
    await expect(runLiveStudioDeploy({ ...deps, ledgerStore: memoryStore() })).rejects.toThrow(/does not list/);
    expect(fake.state().databases.map((d) => d.name)).toEqual(["px-tangebricks-test-deadbeef-preview-db"]);
    expect(fake.state().scripts).toEqual([]);
    expect(fake.requests.every((r) => r.method === "GET")).toBe(true);
  });

  test("a token Cloudflare reports without D1 Edit stops at connect (422, D1 named), creates nothing, and keeps the canonical result", { timeout: 60_000 }, async () => {
    const { fake, root, deps } = world({ tokenKind: "account", tokenGroups: ["Account Settings Read", "Workers Scripts Write", "Queues Write"] });
    const result = await runLiveStudioDeploy(deps);
    expect(result.completed).toBe(false);
    expect(result.stoppedBecause).toMatch(/^verify-and-save \(the token must be active with every required permission\) failed/);
    expect(result.stoppedBecause).toMatch(/D1: Edit/);
    expect((result.steps as Record<string, Record<string, unknown>>).connect).toMatchObject({ httpStatus: 422, status: "active" });
    expect(result.steps.deploy_preview).toBeUndefined();
    expect(fake.state().scripts).toEqual([]);
    expect(fake.state().databases).toEqual([]);
    expect(fake.requests.filter((r) => r.method !== "GET")).toEqual([]);
    // a failure is an attempt only: no canonical result is written
    expect(existsSync(join(root, "evidence", "deployed", RESULT_FILE))).toBe(false);
    const attempts = readdirSync(join(root, "evidence", "deployed", "attempts"));
    expect(attempts.some((f) => f.endsWith(`-${RESULT_FILE}`))).toBe(true);
    const integrity = JSON.parse(readFileSync(join(root, "evidence", "deployed", "integrity.json"), "utf8")) as { files: Record<string, unknown> };
    expect(Object.keys(integrity.files).some((k) => k.startsWith("evidence/deployed/attempts/"))).toBe(true);
  });

  test("a failed run after a passing one leaves the passing canonical result in place", { timeout: 120_000 }, async () => {
    const { fake, root, deps } = world();
    const pass = await runLiveStudioDeploy(deps);
    expect(pass.completed).toBe(true);
    const canonical = readFileSync(join(root, "evidence", "deployed", RESULT_FILE), "utf8");
    fake.fail({ when: (m, p) => m === "POST" && p.endsWith("/d1/database"), respond: { status: 500, body: { success: false, errors: [{ code: 7500, message: "simulated D1 outage" }] } } });
    const failed = await runLiveStudioDeploy({ ...deps, ledgerStore: memoryStore() });
    expect(failed.completed).toBe(false);
    expect(failed.stoppedBecause).toMatch(/CLOUDFLARE_ERROR|simulated D1 outage/);
    expect(readFileSync(join(root, "evidence", "deployed", RESULT_FILE), "utf8")).toBe(canonical);
  });

  test("the calls file is covered by the integrity record through its hash in the result", { timeout: 120_000 }, async () => {
    const { root, deps } = world();
    await runLiveStudioDeploy(deps);
    const resultJson = JSON.parse(readFileSync(join(root, "evidence", "deployed", RESULT_FILE), "utf8")) as { callsSha256: string };
    const callsText = readFileSync(join(root, "evidence", "deployed", CALLS_FILE), "utf8");
    expect(resultJson.callsSha256).toBe(createHash("sha256").update(callsText).digest("hex"));
  });

  test("the account's workers.dev subdomain never reaches a written evidence file; the hashes cover the redacted bytes", { timeout: 120_000 }, async () => {
    const { root, deps } = world({ subdomain: "example-acct" });
    const result = await runLiveStudioDeploy(deps);
    expect(result.completed, result.stoppedBecause ?? "").toBe(true);
    // the run itself used the real address
    const steps = result.steps as Record<string, Record<string, unknown>>;
    expect(String(steps.deploy_production!.workerUrl)).toBe(`https://px-${result.project}-production.example-acct.workers.dev`);

    const dir = join(root, "evidence", "deployed");
    const written: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk : (p: string) => written.push(p))(join(d, e.name));
    };
    walk(dir);
    expect(written.length).toBeGreaterThan(0);
    for (const file of written) expect(readFileSync(file, "utf8"), file).not.toContain("example-acct");

    const resultText = readFileSync(join(dir, RESULT_FILE), "utf8");
    const callsText = readFileSync(join(dir, CALLS_FILE), "utf8");
    const parsed = JSON.parse(resultText) as { callsSha256: string; steps: Record<string, { workerUrl?: string }> };
    expect(parsed.steps.deploy_production!.workerUrl).toBe(`https://px-${result.project}-production.<account-subdomain>.workers.dev`);
    expect(parsed.callsSha256).toBe(createHash("sha256").update(callsText).digest("hex"));
    const integrity = JSON.parse(readFileSync(join(dir, "integrity.json"), "utf8")) as { files: Record<string, { sha256: string }> };
    expect(integrity.files[`evidence/deployed/${RESULT_FILE}`]!.sha256).toBe(createHash("sha256").update(resultText).digest("hex"));
  });

  test("a Global API Key, or a 'revoked' token that is the deploy token itself, is refused before anything is sent", async () => {
    const { fake, deps } = world();
    await expect(runLiveStudioDeploy({ ...deps, credentials: { token: "0123456789abcdef0123456789abcdef01234", accountId: ACCOUNT } })).rejects.toThrow(/Global API Key/);
    await expect(runLiveStudioDeploy({ ...deps, revokedToken: TOKEN })).rejects.toThrow(/CLOUDFLARE_API_TOKEN itself/);
    expect(fake.requests).toEqual([]);
  });

  test("a 'revoked' token Cloudflare still says is active stops step 6 with no upload made with it", { timeout: 120_000 }, async () => {
    const { fake, deps } = world();
    const other = createFakeCloudflare({ token: REVOKED, accountId: ACCOUNT, tokenKind: "user" });
    // requests carrying the "revoked" token reach a second fake that knows it as active
    const both = (request: Request) => (request.headers.get("authorization") === `Bearer ${REVOKED}` ? other.fetch(request) : fake.fetch(request));
    const result = await runLiveStudioDeploy({ ...deps, cloudflareFetch: both });
    expect(result.completed).toBe(false);
    expect(result.stoppedBecause).toMatch(/ACTIVE at Cloudflare/);
    expect(other.requests.filter((r) => r.method !== "GET")).toEqual([]);
    expect(other.state().scripts).toEqual([]);
    expect(result.teardown!.leftBehind).toEqual([]);
  });

  test("a ledger that still lists resources refuses a new run; --teardown removes exactly them", async () => {
    const { fake, deps } = world();
    const ledger = openLedger(deps.ledgerStore, () => "a1b2c3d4", () => new Date(), STUDIO_TEST_NAME_POLICY);
    ledger.planned("d1_database", "px-tangebricks-test-a1b2c3d4-preview-db");
    const id = fake.seedDatabase("px-tangebricks-test-a1b2c3d4-preview-db");
    ledger.created("d1_database", "px-tangebricks-test-a1b2c3d4-preview-db", id);
    fake.seedDatabase("px-tangebricks-test-ffffffff-preview-db"); // someone else's: never touched
    await expect(runLiveStudioDeploy(deps)).rejects.toThrow(/run with --teardown first/);
    const removed = await runTeardownOnly(deps);
    expect(removed.removed).toEqual([{ kind: "d1_database", name: "px-tangebricks-test-a1b2c3d4-preview-db" }]);
    expect(removed.unledgered).toEqual([{ kind: "d1_database", name: "px-tangebricks-test-ffffffff-preview-db" }]);
    expect(fake.state().databases.map((d) => d.name)).toEqual(["px-tangebricks-test-ffffffff-preview-db"]);
  });
});

describe("the write guard", () => {
  const setup = () => {
    const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT });
    const ledger = openLedger(memoryStore(), () => "a1b2c3d4", () => new Date(), STUDIO_TEST_NAME_POLICY);
    const log: CallLine[] = [];
    const guarded = createGuardedFetch({ fetch: fake.fetch, accountId: ACCOUNT, ownPrefix: "px-tangebricks-test-a1b2c3d4-", ledger, log, phase: () => "test" });
    const req = (method: string, path: string, body?: unknown) =>
      new Request(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { fake, ledger, guarded, req, log };
  };

  test("refuses any write to a name or id that is not this run's own, before it reaches Cloudflare", async () => {
    const { fake, guarded, req } = setup();
    await expect(guarded(req("DELETE", "/workers/scripts/projectx-poc-0a1b2c3d"))).rejects.toThrow(/does not carry/);
    await expect(guarded(req("DELETE", "/workers/scripts/px-tangebricks-test-ffffffff-preview"))).rejects.toThrow(/does not carry/);
    await expect(guarded(req("POST", "/d1/database", { name: "my-production-db" }))).rejects.toThrow(/does not carry/);
    const other = fake.seedDatabase("someone-elses-db");
    await expect(guarded(req("POST", `/d1/database/${other}/query`, { sql: "DROP TABLE x" }))).rejects.toThrow(/not one of this run's databases/);
    await expect(guarded(req("PUT", "/workflows/unrelated", { class_name: "X", script_name: "y" }))).rejects.toThrow(/does not carry/);
    await expect(guarded(req("POST", "/tokens", {}))).rejects.toThrow(/not a write this proof makes/);
    expect(fake.requests).toHaveLength(0);
  });

  test("is pinned to the one account: a request naming any other account is refused, read or write", async () => {
    const { fake, guarded } = setup();
    const other = "ffffffffffffffffffffffffffffffff";
    const at = (method: string, path: string) => new Request(`https://api.cloudflare.com/client/v4/accounts/${other}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}` } });
    await expect(guarded(at("GET", "/workers/scripts"))).rejects.toThrow(/another account/);
    await expect(guarded(at("DELETE", "/workers/scripts/px-tangebricks-test-a1b2c3d4-preview"))).rejects.toThrow(/another account/);
    expect(fake.requests).toHaveLength(0);
  });

  test("inspects what an upload binds to: only ledgered databases and this run's own Workflow, Worker and queue", async () => {
    const { fake, ledger, guarded, req } = setup();
    const own = "px-tangebricks-test-a1b2c3d4-preview";
    const created = await guarded(req("POST", "/d1/database", { name: `${own}-db` }));
    const ownDb = ((await created.json()) as { result: { uuid: string } }).result.uuid;
    const foreignDb = fake.seedDatabase("owners-production-db");
    const upload = (bindings: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => {
      const form = new FormData();
      form.set("metadata", new Blob([JSON.stringify({ main_module: "worker.mjs", compatibility_date: "2026-10-01", bindings, ...extra })], { type: "application/json" }), "metadata.json");
      form.set("worker.mjs", new Blob(["export class GraphRunner {} export default {};"], { type: "application/javascript+module" }), "worker.mjs");
      return new Request(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${own}`, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}` }, body: form });
    };
    const before = fake.requests.length;
    await expect(guarded(upload([{ type: "d1", name: "DB", database_id: foreignDb }]))).rejects.toThrow(/not a database this run ledgered/);
    await expect(guarded(upload([{ type: "workflow", name: "GRAPH_RUNNER", workflow_name: "owners-workflow", class_name: "GraphRunner" }]))).rejects.toThrow(/Workflow "owners-workflow"/);
    await expect(guarded(upload([{ type: "service", name: "S", service: "owners-api" }]))).rejects.toThrow(/Worker "owners-api"/);
    await expect(guarded(upload([{ type: "kv_namespace", name: "KV", namespace_id: "abc" }]))).rejects.toThrow(/type kv_namespace/);
    await expect(guarded(upload([], { tail_consumers: [{ service: "owners-tail" }] }))).rejects.toThrow(/tail consumer/);
    expect(fake.requests.length).toBe(before);
    const ok = await guarded(upload([{ type: "d1", name: "DB", database_id: ownDb }, { type: "plain_text", name: "PX_ENVIRONMENT", text: "preview" }, { type: "workflow", name: "GRAPH_RUNNER", workflow_name: `${own}-graphs`, class_name: "GraphRunner" }]));
    expect(ok.status).toBe(200);
    expect(ledger.has("worker_script", own)).toBe(true);
    // a Workflow may only point at this run's Worker
    await expect(guarded(req("PUT", `/workflows/${own}-graphs`, { class_name: "GraphRunner", script_name: "owners-api" }))).rejects.toThrow(/would point at Worker "owners-api"/);
    const wf = await guarded(req("PUT", `/workflows/${own}-graphs`, { class_name: "GraphRunner", script_name: own }));
    expect(wf.status).toBe(200);
  });

  test("Cloudflare's API host only; a refusal is a RequestGuardError that the REST client passes on unchanged (not 'unreachable')", async () => {
    const { fake, guarded } = setup();
    const elsewhere = new Request(`https://api.example.com/client/v4/accounts/${ACCOUNT}/workers/scripts`, { headers: { authorization: `Bearer ${TOKEN}` } });
    await expect(guarded(elsewhere)).rejects.toBeInstanceOf(RequestGuardError);
    const plain = new Request(`http://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts`, { headers: { authorization: `Bearer ${TOKEN}` } });
    await expect(guarded(plain)).rejects.toThrow(/not Cloudflare's API/);
    const client = createClient({ credentials: { token: TOKEN, accountId: "ffffffffffffffffffffffffffffffff" }, fetch: guarded, sleep: async () => {} });
    const error = await client.listScripts().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestGuardError);
    expect(client.calls).toHaveLength(0); // no retry, no "network_error" record
    expect(fake.requests).toHaveLength(0);
  });

  test("only the Worker and database write subpaths this run uses are allowed; PUT .../content and the like are refused", async () => {
    const { fake, guarded, req } = setup();
    const own = "px-tangebricks-test-a1b2c3d4-preview";
    await expect(guarded(req("PUT", `/workers/scripts/${own}/content`, {}))).rejects.toThrow(/not a write this proof makes/);
    await expect(guarded(req("PUT", `/workers/scripts/${own}/tails`, {}))).rejects.toThrow(/not a write this proof makes/);
    await expect(guarded(req("POST", `/workers/scripts/${own}`, {}))).rejects.toThrow(/not a write this proof makes/);
    const created = await guarded(req("POST", "/d1/database", { name: `${own}-db` }));
    const id = ((await created.json()) as { result: { uuid: string } }).result.uuid;
    await expect(guarded(req("POST", `/d1/database/${id}/time_travel/restore`, {}))).rejects.toThrow(/not a write this proof makes/);
    expect(fake.requests.filter((r) => r.method !== "GET").map((r) => r.path)).toEqual(["/client/v4/accounts/{account}/d1/database"]);
  });

  test("a settings PATCH is inspected for what it binds to", async () => {
    const { fake, guarded } = setup();
    const own = "px-tangebricks-test-a1b2c3d4-preview";
    const foreignDb = fake.seedDatabase("owners-production-db");
    const patch = (settings: Record<string, unknown>) => {
      const form = new FormData();
      form.set("settings", new Blob([JSON.stringify(settings)], { type: "application/json" }), "settings.json");
      return new Request(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${own}/settings`, { method: "PATCH", headers: { authorization: `Bearer ${TOKEN}` }, body: form });
    };
    await expect(guarded(patch({ bindings: [{ type: "d1", name: "DB", database_id: foreignDb }] }))).rejects.toThrow(/not a database this run ledgered/);
    await expect(guarded(patch({ bindings: [{ type: "service", name: "S", service: "owners-api" }] }))).rejects.toThrow(/Worker "owners-api"/);
    expect(fake.requests).toHaveLength(0);
  });

  test("no account address escapes the pin through an empty segment or another spelling, reads included", async () => {
    const { fake, guarded } = setup();
    const other = "ffffffffffffffffffffffffffffffff";
    const at = (path: string) => new Request(`https://api.cloudflare.com${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    await expect(guarded(at(`/client/v4//accounts/${other}/workers/scripts`))).rejects.toBeInstanceOf(RequestGuardError);
    await expect(guarded(at(`/client/v4/accounts/${ACCOUNT}//workers/scripts`))).rejects.toThrow(/empty segment/);
    await expect(guarded(at(`/client/v4/x/accounts/${other}/workers/scripts`))).rejects.toThrow(/outside the pinned shape/);
    await expect(guarded(at(`/client/v4/accounts`))).rejects.toThrow(/outside the pinned shape/);
    expect(fake.requests).toHaveLength(0);
  });

  test("a write body that is not JSON is a guard refusal, not a SyntaxError", async () => {
    const { fake, guarded } = setup();
    const raw = (method: string, path: string, body: string) => new Request(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body });
    for (const [method, path] of [["PUT", "/workflows/px-tangebricks-test-a1b2c3d4-preview-graphs"], ["POST", "/d1/database"], ["POST", "/queues"]] as const) {
      const error = await guarded(raw(method, path, "{not json")).catch((e: unknown) => e);
      expect(error, `${method} ${path}`).toBeInstanceOf(RequestGuardError);
      expect(String((error as Error).message)).toMatch(/is not JSON/);
      const array = await guarded(raw(method, path, "[1]")).catch((e: unknown) => e);
      expect(array).toBeInstanceOf(RequestGuardError);
    }
    expect(fake.requests).toHaveLength(0);
  });

  test("writes a create to the ledger before it is sent, and records its id after", async () => {
    const { fake, ledger, guarded, req } = setup();
    fake.fail({ when: (m, p) => m === "POST" && p.endsWith("/d1/database"), times: 1, respond: "network-error" });
    await expect(guarded(req("POST", "/d1/database", { name: "px-tangebricks-test-a1b2c3d4-preview-db" }))).rejects.toThrow();
    expect(ledger.entries()).toMatchObject([{ kind: "d1_database", name: "px-tangebricks-test-a1b2c3d4-preview-db", status: "creating" }]);
    const res = await guarded(req("POST", "/d1/database", { name: "px-tangebricks-test-a1b2c3d4-preview-db" }));
    expect(res.status).toBe(200);
    expect(ledger.entries()[0]).toMatchObject({ status: "created" });
    expect(ledger.entries()[0]!.id).toMatch(/[0-9a-f-]{36}/);
  });
});
