import { describe, expect, test } from "vitest";
import { checkEnvironmentDrift, createByocProvisioner, createHttpCloudflareApiClient } from "../src/index.ts";
import type { DeployTarget } from "../src/index.ts";
import { STUDIO_TEST_NAME_POLICY, createClient, createRequestBudget, findUnledgered, memoryStore, openLedger } from "../src/provisioner/index.ts";
import { createFakeCloudflare } from "./support/fake-cloudflare.ts";

// Story R53, second review: where the code-hash annotation sits in Cloudflare's version list is not yet checked live, so the
// real client reads every plausible shape; unknown code is never "unchanged"; lists never stop early without saying so.

const TOKEN = "cfut_R53AnnotationsTokeneeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const target: DeployTarget = { type: "byoc", accountId: ACCOUNT, tokenRef: "tok_r53_reference", envName: "preview" };

function setup(fakeOptions: Partial<Parameters<typeof createFakeCloudflare>[0]> = {}, waits: number[] = []) {
  const fake = createFakeCloudflare({
    token: TOKEN,
    accountId: ACCOUNT,
    tokenGroups: ["Account Settings Read", "Workers Scripts Write", "D1 Write", "Queues Write"],
    ...fakeOptions,
  });
  const sleep = async (ms: number) => {
    waits.push(ms);
  };
  const cp = createHttpCloudflareApiClient({ fetch: fake.fetch, sleep, budgetFor: () => createRequestBudget({ sleep }) });
  const provisioner = createByocProvisioner({ apiClient: cp, resolveToken: async () => TOKEN });
  const rest = createClient({ credentials: { token: TOKEN, accountId: ACCOUNT }, fetch: fake.fetch, sleep });
  const deployOnce = (project: string, code = "code_1") =>
    provisioner.apply({
      target,
      project,
      buildHash: "build_1",
      codeHash: code,
      graphHash: "graph_1",
      bundle: { code: `export default {}; // ${code}`, sha256: code },
    } as never);
  return { fake, cp, provisioner, rest, deployOnce };
}

describe("the code-hash annotation, wherever the version list puts it", () => {
  for (const shape of ["metadata", "top-level", "detail-only"] as const) {
    test(`shape "${shape}": the uploaded code hash is read back`, async () => {
      const { fake, cp, deployOnce } = setup({ versionAnnotations: shape });
      await deployOnce("r53-shape");
      const script = await cp.getScript(ACCOUNT, TOKEN, "px-r53-shape-preview");
      expect(script?.codeHash).toBe("code_1");
      const detailReads = fake.requests.filter((r) => /\/versions\/[^/]+$/.test(r.path)).length;
      expect(detailReads > 0).toBe(shape === "detail-only");
    });
  }

  test("behind many later versions STUDIO made (trusted ids, e.g. its secret puts), the annotated version is found, across pages", async () => {
    const { fake, cp, deployOnce } = setup({ maxPerPage: 3 });
    await deployOnce("r53-behind");
    for (let i = 0; i < 8; i += 1) fake.tamperWithScript("px-r53-behind-preview"); // versions with no annotation
    const trusted = ((await cp.listScriptVersionIds!(ACCOUNT, TOKEN, "px-r53-behind-preview")) ?? []).slice(0, 8);
    expect((await cp.getScript(ACCOUNT, TOKEN, "px-r53-behind-preview", { trustedVersionIds: trusted }))?.codeHash).toBe("code_1");
    expect(fake.requests.some((r) => r.path.endsWith("/versions") && r.query.includes("page=3"))).toBe(true);
  });

  test("a newer unannotated version Studio did NOT make (wrangler, dashboard) is unknown code: drift shows it, and the deploy uploads", async () => {
    const { fake, cp, provisioner, deployOnce } = setup();
    await deployOnce("r53-oob");
    const ours = (await cp.listScriptVersionIds!(ACCOUNT, TOKEN, "px-r53-oob-preview")) ?? [];
    fake.tamperWithScript("px-r53-oob-preview"); // an out-of-band edit with no message
    // without trust, and with Studio's own ids only: the newer version is not Studio's, so the code is unknown
    expect((await cp.getScript(ACCOUNT, TOKEN, "px-r53-oob-preview"))?.codeHash).toBeUndefined();
    expect((await cp.getScript(ACCOUNT, TOKEN, "px-r53-oob-preview", { trustedVersionIds: ours }))?.codeHash).toBeUndefined();
    const drift = await checkEnvironmentDrift(
      target,
      { project: "r53-oob", deployedRev: 1, buildHash: "build_1", codeHash: "code_1", graphHash: "graph_1", trustedVersionIds: ours },
      { currentRev: 1, buildHash: "build_1", codeHash: "code_1", graphHash: "graph_1" },
      cp,
      { token: TOKEN },
    );
    expect(drift.outOfBandDrift.map((d) => d.resource)).toContain("worker");
    const again = await provisioner.apply({
      target,
      project: "r53-oob",
      buildHash: "build_1",
      codeHash: "code_1",
      graphHash: "graph_1",
      bundle: { code: "export default {}; // code_1", sha256: "code_1" },
      trustedVersionIds: ours,
      envState: { deployedRev: 1 },
    } as never);
    expect(again.action).not.toBe("noop");
    expect(again.rebuiltWorker).toBe(true);
  });

  test("a Worker with no annotated version is unknown code: the deploy uploads, it is never a no-op", async () => {
    const { fake, provisioner } = setup();
    fake.seedScript("px-r53-unknown-preview", "export default {}; // someone else's");
    const result = await provisioner.apply({
      target,
      project: "r53-unknown",
      buildHash: "build_1",
      codeHash: "code_1",
      graphHash: "graph_1",
      bundle: { code: "export default {}; // ours", sha256: "code_1" },
      envState: { deployedRev: 1, currentBuildHash: "build_1", currentCodeHash: "code_1", currentGraphHash: "graph_1", databaseExists: true },
    } as never);
    expect(result.action).not.toBe("noop");
    expect(result.rebuiltWorker).toBe(true);
    expect(fake.codeOf("px-r53-unknown-preview")).toContain("ours");
  });
});

describe("lists never stop early silently", () => {
  test("a total_count larger than what was read is refused, after about a minute of re-reads", async () => {
    const waits: number[] = [];
    const { fake, rest } = setup({}, waits);
    let reads = 0;
    fake.fail({
      when: (m, p) => m === "GET" && p.endsWith("/workers/scripts") && ++reads > 0,
      respond: { status: 200, body: { success: true, errors: [], result: [{ id: "one" }], result_info: { page: 1, per_page: 100, count: 1, total_count: 7 } } },
    });
    await expect(rest.listScripts()).rejects.toThrow(/counts 7 items but only 1 were read/);
    expect(reads).toBe(8);
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(60_000);
  });

  test("a total_count that lags a delete for five reads (past the old ~6 s window) settles and the list is returned", async () => {
    const waits: number[] = [];
    const { fake, rest } = setup({}, waits);
    fake.fail({
      when: (m, p) => m === "GET" && p.endsWith("/d1/database"),
      times: 5,
      respond: {
        status: 200,
        body: { success: true, errors: [], result: [{ uuid: "db-1", name: "kept" }], result_info: { page: 1, per_page: 100, count: 1, total_count: 2 } },
      },
    });
    await expect(rest.listDatabases()).resolves.toEqual([]);
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 15_000]);
  });

  test("a total_count that briefly lags a delete is re-read, and the settled list is returned", async () => {
    const { fake, rest } = setup();
    fake.fail({
      when: (m, p) => m === "GET" && p.endsWith("/workers/scripts"),
      times: 2,
      respond: { status: 200, body: { success: true, errors: [], result: [], result_info: { page: 1, per_page: 100, count: 0, total_count: 1 } } },
    });
    await expect(rest.listScripts()).resolves.toEqual([]);
  });

  test("a cursor-paged answer is refused rather than read in part", async () => {
    const { fake, rest } = setup();
    fake.fail({
      when: (m, p) => m === "GET" && p.endsWith("/queues"),
      respond: { status: 200, body: { success: true, errors: [], result: [{ queue_id: "q1", queue_name: "q" }], result_info: { cursor: "next-page-token" } } },
    });
    await expect(rest.listQueues()).rejects.toThrow(/cursor-paged/);
  });

  test("a 400 from the queue list counts as 'no Queues' only when Cloudflare says Queues is not enabled", async () => {
    const { fake, rest } = setup();
    const ledger = openLedger(
      memoryStore(),
      () => "a1b2c3d4",
      () => new Date(),
      STUDIO_TEST_NAME_POLICY,
    );
    fake.fail({
      when: (m, p) => m === "GET" && p.endsWith("/queues"),
      times: 1,
      respond: { status: 400, body: { success: false, errors: [{ code: 10001, message: "bad request: per_page out of range" }] } },
    });
    await expect(findUnledgered(rest, ledger, STUDIO_TEST_NAME_POLICY)).rejects.toThrow(/per_page out of range/);
    fake.fail({
      when: (m, p) => m === "GET" && p.endsWith("/queues"),
      times: 1,
      respond: { status: 400, body: { success: false, errors: [{ code: 11000, message: "Queues is not enabled for this account" }] } },
    });
    await expect(findUnledgered(rest, ledger, STUDIO_TEST_NAME_POLICY)).resolves.toEqual([]);
  });
});
