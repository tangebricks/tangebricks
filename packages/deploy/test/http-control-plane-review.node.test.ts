import { describe, expect, test } from "vitest";
import { createByocProvisioner, createHttpCloudflareApiClient, isHttpWriteCall, verifyCloudflareToken } from "../src/index.ts";
import type { DeployTarget } from "../src/index.ts";
import {
  STUDIO_TEST_NAME_POLICY,
  createClient,
  createRequestBudget,
  findUnledgered,
  loadCredentials,
  memoryStore,
  openLedger,
  sharedRequestBudget,
} from "../src/provisioner/index.ts";
import { SHARED_BUDGET_ACCOUNTS, sharedBudgetCount } from "../src/provisioner/cloudflare.ts";
import { createFakeCloudflare } from "./support/fake-cloudflare.ts";

// Story R53, review fixes: an unreachable Cloudflare is not a refusal, a read is not Edit, lists are read across pages, and
// "no changes" is judged in the account. All against the fake Cloudflare; no network.

const TOKEN = "cfut_R53ReviewFixesTokenddddddddddddddddddddddddddddddd";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ALL_GROUPS = ["Account Settings Read", "Workers Scripts Write", "D1 Write", "Queues Write"];

function setup(fakeOptions: Partial<Parameters<typeof createFakeCloudflare>[0]> = {}) {
  const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT, tokenGroups: ALL_GROUPS, ...fakeOptions });
  const sleep = async () => {};
  const cp = createHttpCloudflareApiClient({ fetch: fake.fetch, sleep, budgetFor: () => createRequestBudget({ sleep }) });
  const rest = createClient({ credentials: { token: TOKEN, accountId: ACCOUNT }, fetch: fake.fetch, sleep });
  return { fake, cp, rest };
}

describe("verification: unreachable is not a refusal", () => {
  test("a 5xx from the user endpoint propagates as unreachable, never as an invalid token", async () => {
    const { fake, cp, rest } = setup({ tokenKind: "user" });
    fake.fail({ when: (m, p) => m === "GET" && p === "/client/v4/user/tokens/verify", respond: { status: 503, body: { success: false, errors: [{ code: 10013, message: "service unavailable" }] } } });
    await expect(verifyCloudflareToken(TOKEN, ACCOUNT, { client: cp })).rejects.toThrow(/HTTP 503/);
    await expect(rest.verifyToken()).rejects.toMatchObject({ status: 503 });
  });

  test("a network failure at the user endpoint propagates too", async () => {
    const { fake, cp } = setup({ tokenKind: "user" });
    fake.fail({ when: (m, p) => m === "GET" && p === "/client/v4/user/tokens/verify", respond: "network-error" });
    await expect(verifyCloudflareToken(TOKEN, ACCOUNT, { client: cp })).rejects.toThrow(/could not reach Cloudflare/);
  });

  test("a 4xx from both endpoints is a refusal (invalid)", async () => {
    const { fake, cp } = setup({ tokenKind: "user" });
    fake.fail({ when: (m, p) => m === "GET" && p === "/client/v4/user/tokens/verify", respond: { status: 403, body: { success: false, errors: [{ code: 9109, message: "no" }] } } });
    expect(await verifyCloudflareToken(TOKEN, ACCOUNT, { client: cp })).toMatchObject({ ok: false, status: "invalid" });
  });
});

describe("verification: a read is not Edit", () => {
  test("a token that can only be probed (Read-only evidence): the Edit scopes are reported unconfirmed until the first deploy", async () => {
    const { cp } = setup({ tokenKind: "user", tokenGroups: null });
    const report = await verifyCloudflareToken(TOKEN, ACCOUNT, { client: cp });
    expect(report.ok).toBe(true);
    expect(report.verifiedBy).toBe("read-probe");
    const byLabel = Object.fromEntries(report.permissions.map((p) => [p.label, p]));
    expect(byLabel["Account Settings: Read"]).toMatchObject({ granted: true, confirmed: true });
    for (const label of ["Workers Scripts: Edit", "D1: Edit", "Queues: Edit"]) {
      expect(byLabel[label]).toMatchObject({ granted: true, confirmed: false });
      expect(byLabel[label]!.note).toMatch(/confirmed by the first deploy/);
    }
    expect(report.summaryMessage).toMatch(/will be confirmed by the first deploy/);
    expect(report.summaryMessage).not.toMatch(/all 4 required permissions verified/);
  });

  test("readable policies still name a missing permission, and what is granted is confirmed", async () => {
    const { cp } = setup({ tokenGroups: ["Account Settings Read", "Workers Scripts Write", "D1 Write"] });
    const report = await verifyCloudflareToken(TOKEN, ACCOUNT, { client: cp });
    expect(report.verifiedBy).toBe("policies");
    expect(report.missingPermissionLabels).toEqual(["Queues: Edit"]);
    expect(report.permissions.filter((p) => p.granted).every((p) => p.confirmed === true)).toBe(true);
  });

  test("Queues answering 404 on the probe path is reported unavailable, not an outage", async () => {
    const { cp } = setup({ tokenKind: "user", tokenGroups: null, queuesUnavailable: 404 });
    const report = await verifyCloudflareToken(TOKEN, ACCOUNT, { client: cp });
    expect(report.status).toBe("active");
    expect(report.missingPermissionLabels).toEqual(["Queues: Edit"]);
    expect(report.permissions.find((p) => p.label === "Queues: Edit")!.plainError).toMatch(/unavailable/);
  });
});

describe("lists are read across pages", () => {
  test("scripts, databases, queues and Workflows: every page", async () => {
    const { fake, rest } = setup({ maxPerPage: 2 });
    for (let i = 0; i < 5; i += 1) {
      fake.seedScript(`other-${i}`);
      fake.seedDatabase(`other-db-${i}`);
      fake.seedQueue(`other-q-${i}`);
      fake.seedWorkflow(`other-wf-${i}`);
    }
    expect(await rest.listScripts()).toHaveLength(5);
    expect(await rest.listDatabases()).toHaveLength(5);
    expect(await rest.listQueues()).toHaveLength(5);
    expect(await rest.listWorkflows()).toHaveLength(5);
    expect((await rest.listWorkflowDefinitions()).map((w) => w.name)).toContain("other-wf-4");
    expect(fake.requests.some((r) => r.query.includes("page=3"))).toBe(true);
  });

  test("findUnledgered finds a prefixed database on page 2, by exact prefix over the whole list (no name search)", async () => {
    const { fake, rest } = setup({ maxPerPage: 2 });
    fake.seedDatabase("a-first");
    fake.seedDatabase("b-second");
    fake.seedDatabase("px-tangebricks-test-0badf00d-preview-db");
    const ledger = openLedger(memoryStore(), () => "a1b2c3d4", () => new Date(), STUDIO_TEST_NAME_POLICY);
    expect(await findUnledgered(rest, ledger, STUDIO_TEST_NAME_POLICY)).toEqual([{ kind: "d1_database", name: "px-tangebricks-test-0badf00d-preview-db" }]);
    expect(fake.requests.filter((r) => r.path.endsWith("/d1/database")).every((r) => !r.query.includes("name="))).toBe(true);
  });

  test("a prefixed Workflow and queue on page 2 are found too", async () => {
    const { fake, rest } = setup({ maxPerPage: 1 });
    fake.seedWorkflow("someone-elses");
    fake.seedWorkflow("px-tangebricks-test-0badf00d-preview-graphs");
    fake.seedQueue("q-other");
    fake.seedQueue("px-tangebricks-test-0badf00d-preview-jobs");
    const ledger = openLedger(memoryStore(), () => "a1b2c3d4", () => new Date(), STUDIO_TEST_NAME_POLICY);
    const found = await findUnledgered(rest, ledger, STUDIO_TEST_NAME_POLICY);
    expect(found).toEqual(expect.arrayContaining([
      { kind: "workflow", name: "px-tangebricks-test-0badf00d-preview-graphs" },
      { kind: "queue", name: "px-tangebricks-test-0badf00d-preview-jobs" },
    ]));
  });

  test("findUnledgered tolerates an account without Queues (400)", async () => {
    const { rest } = setup({ queuesUnavailable: 400 });
    const ledger = openLedger(memoryStore(), () => "a1b2c3d4", () => new Date(), STUDIO_TEST_NAME_POLICY);
    expect(await findUnledgered(rest, ledger, STUDIO_TEST_NAME_POLICY)).toEqual([]);
  });
});

describe("no changes is judged in the account", () => {
  const target: DeployTarget = { type: "byoc", accountId: ACCOUNT, tokenRef: "tok_r53_reference", envName: "preview" };

  test("a plan that says noop while the Worker is gone from the account redeploys it", async () => {
    const { fake, cp } = setup();
    const provisioner = createByocProvisioner({ apiClient: cp, resolveToken: async () => TOKEN });
    const input = { target, project: "r53-gone", buildHash: "build_1", codeHash: "code_1", graphHash: "graph_1", bundle: { code: "export class GraphRunner {} export default {};", sha256: "code_1" } };
    await provisioner.apply(input as never);
    await cp.deleteScript(ACCOUNT, TOKEN, "px-r53-gone-preview");
    const again = await provisioner.apply({ ...input, envState: { deployedRev: 1, currentBuildHash: "build_1", currentCodeHash: "code_1", currentGraphHash: "graph_1", databaseExists: true } } as never);
    expect(again.action).not.toBe("noop");
    expect(again.rebuiltWorker).toBe(true);
    expect(fake.state().scripts.map((s) => s.name)).toContain("px-r53-gone-preview");
  });

  test("without the caller's memory, the account's own state makes an unchanged redeploy a no-op with zero writes", async () => {
    const { cp } = setup();
    const provisioner = createByocProvisioner({ apiClient: cp, resolveToken: async () => TOKEN });
    const input = { target, project: "r53-acct", buildHash: "build_1", codeHash: "code_1", graphHash: "graph_1", bundle: { code: "export default {};", sha256: "code_1" } };
    await provisioner.apply(input as never);
    const before = cp.httpCalls.length;
    const again = await provisioner.apply({ ...input, envState: { deployedRev: 1 } } as never);
    expect(again.action).toBe("noop");
    expect(cp.httpCalls.slice(before).filter(isHttpWriteCall)).toEqual([]);
  });

  test("a changed bundle hash (the gate or runtime layer) uploads again", async () => {
    const { cp } = setup();
    const provisioner = createByocProvisioner({ apiClient: cp, resolveToken: async () => TOKEN });
    const input = { target, project: "r53-layer", buildHash: "build_1", codeHash: "bundle_a", graphHash: "graph_1", bundle: { code: "export default {}; // a", sha256: "bundle_a" } };
    await provisioner.apply(input as never);
    const again = await provisioner.apply({ ...input, codeHash: "bundle_b", bundle: { code: "export default {}; // b", sha256: "bundle_b" }, envState: { deployedRev: 1 } } as never);
    expect(again.rebuiltWorker).toBe(true);
    expect((await cp.getScript(ACCOUNT, TOKEN, "px-r53-layer-preview"))?.codeHash).toBe("bundle_b");
  });
});

describe("bounded state and credentials", () => {
  test("the shared budgets are a bounded LRU", () => {
    for (let i = 0; i < SHARED_BUDGET_ACCOUNTS + 20; i += 1) sharedRequestBudget(`acct-${i}`);
    expect(sharedBudgetCount()).toBeLessThanOrEqual(SHARED_BUDGET_ACCOUNTS);
  });

  test("a Global API Key in CLOUDFLARE_API_TOKEN is refused by loadCredentials", () => {
    expect(() => loadCredentials({ CLOUDFLARE_API_TOKEN: "0123456789abcdef0123456789abcdef01234", CLOUDFLARE_ACCOUNT_ID: ACCOUNT })).toThrow(/Global API Key/);
  });
});
