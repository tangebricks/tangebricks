import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { assemble } from "@poc/assembler";
import { parseHypotheses, verdict } from "@poc/harness";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { catalog } from "../../assembler/catalog.generated.ts";
import { INVOICE_FLOW_BLUEPRINT } from "../../../test/support/blueprints.ts";
import { OUT_DIR, writeProject } from "../../../test/support/emitted.ts";
import { bundleWorker } from "../src/bundle.ts";
import { GATE_PROBES, canonical, evaluateH10, runH10, withLeakScan } from "../src/h10.ts";
import type { H10Calls, H10Deps, H10Result } from "../src/h10.ts";
import { scanTreesForSecrets } from "../src/leak-scan.ts";
import { GRAPH_MIGRATIONS } from "../src/worker/graph-run.ts";
import type { CallRecord } from "../src/provisioner/index.ts";
import { createClient, createRedactor, findSecrets, memoryStore, migrationsFrom, openLedger, resourceNames } from "../src/provisioner/index.ts";
import { createFakeCloudflare } from "./support/fake-cloudflare.ts";
import type { FakeOptions } from "./support/fake-cloudflare.ts";

// Story 5.5, rehearsed. The H10 protocol (first deploy from nothing, a second run that changes nothing, a third after a
// setting changed, a fourth that puts it back, the gate probes) is run against the fake Cloudflare, with the deployed
// address served by the same bundle running in a real workerd. Then the files it wrote are re-read the way
// `pnpm poc:verify` re-reads them, and every way of editing them is tried.
//
// What this cannot show: how Cloudflare itself answers (that is the real run), and how long anything takes there.
const root = resolve(import.meta.dirname, "..", "..", "..");
const TOKEN = "cfut_Zq8rLm3VxN2pTb7YkWd4HsJc9GaE5uRo6QiXf1BvPn0AyMt";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const KEY = "9f".repeat(32);
const SUFFIX = "0a1b2c3d";
const LEAK_CLEAN = { filesScanned: 120, found: [], scannedFor: ["token", "accountId", "accessKey"] };

const h10 = parseHypotheses(JSON.parse(readFileSync(join(root, "hypotheses.json"), "utf8"))).hypotheses.find((h) => h.id === "H10")!;

// ---- the project, built once and reused: the bundle is byte-identical on a rebuild (checked in bundle.node.test.ts)
type Built = Awaited<ReturnType<H10Deps["build"]>>;
const built = new Map<"base" | "changed", Promise<Built>>();
const blueprint = (variant: "base" | "changed") => ({
  ...INVOICE_FLOW_BLUEPRINT,
  bricks:
    variant === "base" ? [...INVOICE_FLOW_BLUEPRINT.bricks] : ["multi-workspace", { id: "credit-wallet", config: { creditsPerUnit: 2 } }, "dynamic-entities"],
});
const build = (variant: "base" | "changed"): Promise<Built> => {
  if (!built.has(variant)) {
    built.set(
      variant,
      (async () => {
        const assembled = assemble(blueprint(variant) as never, catalog);
        if (!assembled.ok) throw new Error(assembled.errors.join("; "));
        const projectDir = join(OUT_DIR, "deploy-test", `h10-${variant}`);
        await writeProject(projectDir, assembled.files);
        const bundle = await bundleWorker({ projectDir });
        return { bundle: { code: bundle.code, sha256: bundle.sha256, bytes: bundle.bytes }, migrations: migrationsFrom(assembled.files) };
      })(),
    );
  }
  return built.get(variant)!;
};

// ---- the deployed address: a workerd running exactly the code the fake was last given
const running = new Map<string, Promise<Miniflare>>();
async function workerdFor(code: string): Promise<Miniflare> {
  if (!running.has(code)) {
    running.set(
      code,
      (async () => {
        const mf = new Miniflare(
          convertV4MiniflareOptions({ modules: true, script: code, compatibilityDate: "2026-10-01", d1Databases: ["DB"], bindings: { POC_ACCESS_KEY: KEY } }),
        );
        await mf.ready;
        const db = (await mf.getD1Database("DB")) as unknown as D1Like;
        for (const m of [...(await build("base")).migrations, ...GRAPH_MIGRATIONS]) await applyMigration(db, m.sql);
        return mf;
      })(),
    );
  }
  return running.get(code)!;
}
afterAll(async () => {
  for (const mf of running.values()) await (await mf).dispose();
});

interface WorldOptions {
  fake?: Partial<FakeOptions>;
  /** Make the address look unreachable for this many requests, as a new Worker's address is for a moment. */
  unreachableFor?: number;
}
function world(options: WorldOptions = {}) {
  const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT, ...options.fake });
  const names = resourceNames(SUFFIX);
  const store = memoryStore();
  const ledger = openLedger(
    store,
    () => SUFFIX,
    () => new Date("2026-10-21T00:00:00Z"),
  );
  const hide = createRedactor([TOKEN, ACCOUNT, KEY]);
  const lines: string[] = [];
  let unreachable = options.unreachableFor ?? 0;
  const deps: H10Deps = {
    clock: () => performance.now(),
    commandStart: performance.now(),
    sleep: async () => undefined,
    createClient: (now) =>
      createClient({ credentials: { token: TOKEN, accountId: ACCOUNT }, fetch: fake.fetch, now, sleep: async () => undefined, alsoHide: [KEY] }),
    names,
    ledger,
    accessKey: KEY,
    build,
    fetchUrl: async (request) => {
      if (unreachable > 0) {
        unreachable -= 1;
        throw new TypeError("fetch failed (the address is not reachable yet)");
      }
      const url = new URL(request.url);
      if (url.hostname !== `${names.script}.fake-subdomain.workers.dev`) throw new Error(`the protocol sent a request to ${url.hostname}`);
      const code = fake.codeOf(names.script);
      if (code === undefined) return new Response("no such Worker", { status: 404 });
      const mf = await workerdFor(code);
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
      return (await mf.dispatchFetch(`http://deployed.invalid${url.pathname}${url.search}`, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body,
      } as never)) as unknown as Response;
    },
    compatibilityDate: "2026-10-01",
    hide,
    nowIso: () => "2026-10-21T00:00:00.000Z",
    log: (line) => lines.push(line),
  };
  return { fake, names, store, ledger, deps, lines, hide };
}

/** What `pnpm poc:verify` does with the files: read them back and recompute. */
const sources = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const file of [
    "scripts/poc-deploy.ts",
    "packages/deploy/src/h10.ts",
    ...["access-key", "cloudflare", "credentials", "deploy", "index", "ledger", "names", "redact", "teardown"].map(
      (n) => `packages/deploy/src/provisioner/${n}.ts`,
    ),
  ])
    out[file] = readFileSync(join(root, file), "utf8");
  return out;
};
const evaluate = (calls: H10Calls | string, result: H10Result, over: Partial<{ sources: Record<string, string>; evidenceTexts: string[] }> = {}) => {
  const callsText = typeof calls === "string" ? calls : canonical(calls);
  return evaluateH10({ callsText, result, sources: over.sources ?? sources(), evidenceTexts: over.evidenceTexts ?? [callsText, JSON.stringify(result)] });
};
const rehash = (calls: H10Calls, result: H10Result): { calls: H10Calls; result: H10Result } => {
  const text = canonical(calls);
  return { calls, result: { ...result, callsSha256: require_sha(text) } };
};
import { createHash } from "node:crypto";
const require_sha = (text: string) => createHash("sha256").update(text).digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

let complete: Awaited<ReturnType<typeof runComplete>>;
async function runComplete() {
  const w = world({ unreachableFor: 2 });
  const { calls, result } = await runH10(w.deps);
  return { w, calls, result: withLeakScan(result, LEAK_CLEAN) };
}

beforeEach(async () => {
  complete ??= await runComplete();
}, 120_000);

describe("a complete run", () => {
  test("goes through all four runs and the gate probes, and says so", () => {
    expect(complete.result.completed).toBe(true);
    expect(complete.result.stoppedBecause).toBeUndefined();
    const phases = complete.calls.facts.attempts.map((a) => a.phase);
    expect(phases).toEqual([
      "build",
      "first deploy",
      "address answers",
      "scripted check",
      "second run",
      "third run (one setting changed)",
      "fourth run (setting restored)",
      "gate probes",
    ]);
    expect(complete.calls.facts.attempts.every((a) => a.outcome === "ok")).toBe(true);
  });

  test("the first run makes everything from nothing, in order, and puts the Worker's address on", () => {
    expect(complete.calls.facts.runs.first!.changes).toEqual([
      "database_created",
      "bookkeeping_created",
      "migration_applied",
      "migration_applied",
      "migration_applied",
      "migration_applied",
      "migration_applied",
      "migration_applied",
      "migration_applied",
      "migration_applied",
      "migration_applied",
      "migration_applied",
      "script_uploaded",
      "workflow_registered",
      "address_enabled",
    ]);
    expect(complete.calls.facts.url).toBe(`https://${complete.w.names.script}.fake-subdomain.workers.dev`);
  });

  test("the second run reports nothing, the third one upload, the fourth one upload with the first run's own bundle", () => {
    const runs = complete.calls.facts.runs;
    expect(runs.second!.changes).toEqual([]);
    expect(runs.third!.changes).toEqual(["script_uploaded", "workflow_registered"]);
    expect(runs.fourth!.changes).toEqual(["script_uploaded", "workflow_registered"]);
    expect(runs.fourth!.bundleSha256).toBe(runs.first!.bundleSha256);
    expect(runs.fourth!.uploadFingerprint).toBe(runs.first!.uploadFingerprint);
    expect(runs.third!.bundleSha256).not.toBe(runs.first!.bundleSha256);
  });

  test("the account ends with one database, one Worker with three versions (not four: the second run uploaded nothing), one Workflow", () => {
    const state = complete.w.fake.state();
    expect(state.databases.map((d) => d.name)).toEqual([complete.w.names.database]);
    expect(state.scripts).toHaveLength(1);
    expect(state.scripts[0]!.versionIds).toHaveLength(3);
    expect(state.scripts[0]!.bindingTypes).toEqual(["d1", "secret_text", "workflow"]);
    expect(state.workflows.map((w) => w.name)).toEqual([complete.w.names.workflow]);
    expect(state.scripts[0]!.codeSha256).toBe(createHash("sha256").update(complete.w.fake.codeOf(complete.w.names.script)!).digest("hex"));
  });

  test("the ledger lists the three resources as created, none still 'creating'", () => {
    expect(complete.w.ledger.entries().map((e) => [e.kind, e.status])).toEqual([
      ["d1_database", "created"],
      ["worker_script", "created"],
      ["workflow", "created"],
    ]);
  });

  test("the address was not answering at first: those requests are in the log with no status, and the run still came out right", () => {
    const wait = complete.calls.urlEvents.filter((e) => e.phase === "wait-for-address");
    expect(wait.length).toBe(3);
    expect(wait.map((e) => e.status)).toEqual([null, null, 200]);
  });

  test("the gate probes were made without the key and with a wrong one, and the demo page is open to a GET only", () => {
    const gate = complete.calls.urlEvents.filter((e) => e.phase === "gate");
    expect(gate.map((e) => [e.note, e.method, e.path, e.status])).toEqual(GATE_PROBES.map((p) => [p.note, p.method, p.path, p.expect]));
  });

  test("each Cloudflare run has its own log, and the readers' logs hold only reads", () => {
    const labels = complete.calls.clients.map((c) => c.label);
    expect(labels).toEqual([
      "first-deploy",
      "read-back",
      "reader-before-second",
      "second-deploy",
      "reader-after-second",
      "reader-before-third",
      "third-deploy",
      "reader-after-third",
      "fourth-deploy",
      "reader-after-fourth",
    ]);
    for (const c of complete.calls.clients.filter((x) => x.label.startsWith("reader") || x.label === "read-back"))
      expect(c.calls.every((x) => x.method === "GET" || x.sqlKind === "select")).toBe(true);
    for (const c of complete.calls.clients) expect(c.calls.every((x) => x.path.startsWith("/accounts/{account}/"))).toBe(true);
  });

  test("the Worker's bindings, read back from Cloudflare, include the Workflow binding for the class the bundle exports", () => {
    expect(complete.calls.facts.bindingsReadBack.bindings).toContainEqual({
      type: "workflow",
      name: "GRAPH_RUNNER",
      workflowName: complete.w.names.workflow,
      className: "GraphRunner",
    });
    expect(JSON.stringify(complete.calls.facts.bindingsReadBack)).not.toContain(KEY);
  });
});

describe("what the files say when they are re-read", () => {
  test("all seven checks come out true, and the seconds equal what the log says", () => {
    const e = evaluate(complete.calls, complete.result);
    expect(e.checks).toEqual({
      restUploadAccepted: true,
      deployedOverRestOnly: true,
      urlAnswersCorrectly: true,
      secondRunChangesNothing: true,
      changedProjectChangesOneThing: true,
      publicAccessGated: true,
      tokenNeverLeaked: true,
    });
    expect(e.measured).toBe(complete.result.secondsToCorrectAnswer);
    expect(e.measured).toBeGreaterThan(0);
    expect(verdict(h10, { measured: e.measured, checks: e.checks }).verdict).toBe("pass");
  });

  test("the seconds are the end of the last answer to the scripted check, counted from the start of the command", () => {
    const phase = complete.calls.facts.timedCheckPhase!;
    const mine = complete.calls.urlEvents.filter((e) => e.phase === phase);
    expect(mine).toHaveLength(10);
    const last = mine.at(-1)!;
    expect(complete.result.secondsToCorrectAnswer).toBe(Math.round(last.atMs + last.ms) / 1000);
    // the check started after the first deploy's last Cloudflare call ended
    const first = complete.calls.clients[0]!;
    expect(mine[0]!.atMs).toBeGreaterThanOrEqual(first.startedAtMs + Math.max(...first.calls.map((c) => c.atMs + c.ms)) - 5);
  });

  test("a result file that claims fewer seconds than the log shows is not believed", () => {
    const e = evaluate(complete.calls, { ...complete.result, secondsToCorrectAnswer: 3.2 });
    expect(e.measured).toBeUndefined();
    expect(e.notes.join(" ")).toMatch(/claims 3\.2 seconds but the calls file gives/);
    expect(verdict(h10, { checks: e.checks }).verdict).toBe("fail");
  });

  test("a calls file edited without the result file's hash is not believed at all", () => {
    const edited = canonical(complete.calls).replace('"status": 401', '"status": 200');
    const e = evaluate(edited, complete.result);
    expect(e.measured).toBeUndefined();
    expect(e.checks).toEqual({});
    expect(e.notes.join(" ")).toMatch(/does not match the hash/);
    expect(verdict(h10, { checks: e.checks }).verdict).toBe("fail");
  });

  test("a calls file that is not JSON, or has been reformatted, is not believed", () => {
    expect(evaluate("{ nope", complete.result).notes.join(" ")).toMatch(/not valid JSON/);
    const reformatted = JSON.stringify(complete.calls);
    expect(evaluate(reformatted, complete.result).checks).toEqual({});
  });

  test("when both files are rewritten to agree, what the data says is what is believed: a second run that changed the account fails", () => {
    const calls = clone(complete.calls);
    calls.facts.readings.afterSecond!.versionCount += 1;
    const { calls: c, result } = rehash(calls, complete.result);
    const e = evaluate(c, result);
    expect(e.checks.secondRunChangesNothing).toBe(false);
    expect(verdict(h10, { measured: e.measured, checks: e.checks }).verdict).toBe("fail");
  });

  test("a second run with a write call in its log fails, whatever the readings say", () => {
    const calls = clone(complete.calls);
    calls.clients
      .find((c) => c.label === "second-deploy")!
      .calls.push({ n: 99, atMs: 0, method: "PUT", path: "/accounts/{account}/workers/scripts/x", status: 200, ms: 1, outcome: "ok", attempt: 1 });
    const { calls: c, result } = rehash(calls, complete.result);
    expect(evaluate(c, result).checks.secondRunChangesNothing).toBe(false);
  });

  test("a second run compared with readings of an empty account proves nothing and fails", () => {
    const calls = clone(complete.calls);
    const empty = { databaseId: null, appliedMigrations: [], latestVersionId: null, versionCount: 0, addressEnabled: null };
    calls.facts.readings.beforeSecond = empty;
    calls.facts.readings.afterSecond = empty;
    const { calls: c, result } = rehash(calls, complete.result);
    expect(evaluate(c, result).checks.secondRunChangesNothing).toBe(false);
  });

  test("a third run that added no version, or two, or changed the database, fails", () => {
    for (const edit of [
      (r: NonNullable<H10Calls["facts"]["readings"]["afterThird"]>) => void (r.versionCount -= 1),
      (r: NonNullable<H10Calls["facts"]["readings"]["afterThird"]>) => void (r.versionCount += 1),
      (r: NonNullable<H10Calls["facts"]["readings"]["afterThird"]>) => void (r.latestVersionId = complete.calls.facts.readings.beforeThird!.latestVersionId),
      (r: NonNullable<H10Calls["facts"]["readings"]["afterThird"]>) => void (r.databaseId = "another-database"),
      (r: NonNullable<H10Calls["facts"]["readings"]["afterThird"]>) => void r.appliedMigrations.pop(),
    ]) {
      const calls = clone(complete.calls);
      edit(calls.facts.readings.afterThird!);
      const { calls: c, result } = rehash(calls, complete.result);
      expect(evaluate(c, result).checks.changedProjectChangesOneThing).toBe(false);
    }
  });

  test("a third run whose log has two uploads, or none, fails", () => {
    const isUpload = (c: CallRecord) =>
      (c.method === "PUT" && c.path.endsWith(`/workers/scripts/${complete.w.names.script}`)) ||
      (c.method === "POST" && c.path.endsWith(`/workers/scripts/${complete.w.names.script}/versions`));
    for (const mutate of [
      (list: H10Calls["clients"][number]["calls"]) => list.push({ ...list.find(isUpload)! }),
      (list: H10Calls["clients"][number]["calls"]) => void list.splice(0, list.length, ...list.filter((c) => !isUpload(c))),
    ]) {
      const calls = clone(complete.calls);
      mutate(calls.clients.find((c) => c.label === "third-deploy")!.calls);
      const { calls: c, result } = rehash(calls, complete.result);
      expect(evaluate(c, result).checks.changedProjectChangesOneThing).toBe(false);
    }
  });

  test("a gate probe that is missing, or answered with anything but what is expected, fails", () => {
    const missing = clone(complete.calls);
    missing.urlEvents.splice(
      missing.urlEvents.findIndex((e) => e.phase === "gate"),
      1,
    );
    expect(evaluate(...(Object.values(rehash(missing, complete.result)) as [H10Calls, H10Result])).checks.publicAccessGated).toBe(false);
    const open = clone(complete.calls);
    open.urlEvents.filter((e) => e.phase === "gate")[0]!.status = 200;
    expect(evaluate(...(Object.values(rehash(open, complete.result)) as [H10Calls, H10Result])).checks.publicAccessGated).toBe(false);
    const closedDemo = clone(complete.calls);
    closedDemo.urlEvents.find((e) => e.note === "demo-open")!.status = 401;
    expect(evaluate(...(Object.values(rehash(closedDemo, complete.result)) as [H10Calls, H10Result])).checks.publicAccessGated).toBe(false);
  });

  test("a scripted check whose answers differ, in the observations or in the log's statuses, fails", () => {
    const wrongObservation = clone(complete.calls);
    wrongObservation.facts.observations.first![2]!.facts.balance = 5;
    expect(evaluate(...(Object.values(rehash(wrongObservation, complete.result)) as [H10Calls, H10Result])).checks.urlAnswersCorrectly).toBe(false);
    const wrongStatus = clone(complete.calls);
    wrongStatus.urlEvents.filter((e) => e.phase === wrongStatus.facts.timedCheckPhase)[7]!.status = 200;
    expect(evaluate(...(Object.values(rehash(wrongStatus, complete.result)) as [H10Calls, H10Result])).checks.urlAnswersCorrectly).toBe(false);
  });

  test("an upload that is not in the log is not 'accepted': the check is left unreported, not defaulted", () => {
    const calls = clone(complete.calls);
    const first = calls.clients.find((c) => c.label === "first-deploy")!;
    first.calls = first.calls.filter((c) => c.method !== "PUT");
    const { calls: c, result } = rehash(calls, complete.result);
    const e = evaluate(c, result);
    expect("restUploadAccepted" in e.checks).toBe(false);
    expect(verdict(h10, { measured: e.measured, checks: e.checks }).verdict).toBe("fail");
  });

  test("an upload with no Workflow binding to show for it is not 'accepted' either", () => {
    const calls = clone(complete.calls);
    calls.facts.bindingsReadBack = { bindings: [{ type: "d1", name: "DB" }], workflowsListed: [] };
    const { calls: c, result } = rehash(calls, complete.result);
    expect("restUploadAccepted" in evaluate(c, result).checks).toBe(false);
  });

  test("a source that starts a program, or names wrangler in code, fails 'over REST only'; a mention in a comment does not", () => {
    const withSpawn = { ...sources(), "scripts/poc-deploy.ts": `import { spawn } from "node:child_process";\nspawn("wrangler", ["deploy"]);` };
    expect(evaluate(complete.calls, complete.result, { sources: withSpawn }).checks.deployedOverRestOnly).toBe(false);
    const withComment = { ...sources(), "scripts/poc-deploy.ts": `// no child_process and no wrangler here\nexport const x = 1;` };
    expect(evaluate(complete.calls, complete.result, { sources: withComment }).checks.deployedOverRestOnly).toBe(true);
    expect(evaluate(complete.calls, complete.result, { sources: { "a.ts": "export const x = 1;" } }).checks.deployedOverRestOnly).toBe(false); // too few files were looked at to say
  });

  test("a call to anything but the account's own address fails 'over REST only'", () => {
    const calls = clone(complete.calls);
    calls.clients[0]!.calls.push({ n: 99, atMs: 0, method: "GET", path: "/somewhere/else", status: 200, ms: 1, outcome: "ok", attempt: 1 });
    const { calls: c, result } = rehash(calls, complete.result);
    expect(evaluate(c, result).checks.deployedOverRestOnly).toBe(false);
  });

  test("the leak scan: a hit fails, no scan is unreported, a scan of too little fails, and a credential in an evidence file fails", () => {
    expect(evaluate(complete.calls, withLeakScan(complete.result, { ...LEAK_CLEAN, found: ["token in notes.md"] })).checks.tokenNeverLeaked).toBe(false);
    const noScan = evaluate(complete.calls, { ...complete.result, leakScan: undefined });
    expect("tokenNeverLeaked" in noScan.checks).toBe(false);
    expect(evaluate(complete.calls, withLeakScan(complete.result, { ...LEAK_CLEAN, filesScanned: 3 })).checks.tokenNeverLeaked).toBe(false);
    expect(evaluate(complete.calls, withLeakScan(complete.result, { ...LEAK_CLEAN, scannedFor: ["token"] })).checks.tokenNeverLeaked).toBe(false);
    expect(evaluate(complete.calls, complete.result, { evidenceTexts: ["Authorization: Bearer abc"] }).checks.tokenNeverLeaked).toBe(false);
    expect(evaluate(complete.calls, complete.result, { evidenceTexts: ['{"x-poc-key": "abc"}'] }).checks.tokenNeverLeaked).toBe(false);
  });

  test("the time decides the verdict: 121 seconds is a fail, 601 a kill", () => {
    const e = evaluate(complete.calls, complete.result);
    expect(verdict(h10, { measured: 120, checks: e.checks }).verdict).toBe("pass");
    expect(verdict(h10, { measured: 121, checks: e.checks }).verdict).toBe("fail");
    expect(verdict(h10, { measured: 601, checks: e.checks }).verdict).toBe("kill");
  });
});

describe("when the first deploy does not go through", () => {
  const stopped = async (options: WorldOptions) => {
    const w = world(options);
    const { calls, result } = await runH10(w.deps);
    return { w, calls, result: withLeakScan(result, LEAK_CLEAN), e: undefined as ReturnType<typeof evaluate> | undefined };
  };

  test("Cloudflare refusing the Workflow binding while taking the plain script is the one thing that is false, with its answer kept: a kill", async () => {
    const r = await stopped({ fake: { refuseWorkflowBindings: true } });
    expect(r.result.completed).toBe(false);
    expect(r.calls.facts.upload.outcome).toBe("platform_refusal");
    expect(r.calls.facts.upload.control).toMatchObject({ accepted: true });
    expect(r.calls.facts.upload.refusal).toMatchObject({ status: 400, codes: [10021] });
    expect(r.calls.facts.upload.refusal!.body).toContain("binding type workflow is not accepted");
    const e = evaluate(r.calls, r.result);
    expect(e.checks.restUploadAccepted).toBe(false);
    expect(verdict(h10, { measured: e.measured, checks: e.checks }).verdict).toBe("kill");
    expect(r.w.fake.state().scripts).toEqual([]); // the throw-away control Worker is gone
  });

  test("an upload refused with and without the binding is NOT a refusal of the idea: unreported, a fail, never a kill", async () => {
    const r = await stopped({ fake: { refuseAllUploads: true } });
    expect(r.calls.facts.upload.outcome).toBe("not_the_workflow_binding");
    const e = evaluate(r.calls, r.result);
    expect("restUploadAccepted" in e.checks).toBe(false);
    expect(verdict(h10, { measured: e.measured, checks: e.checks }).verdict).toBe("fail");
  });

  test("a network failure during the upload is unreported too, and no control upload is made", async () => {
    const w = world();
    w.fake.fail({ when: (m, p) => m === "PUT" && p.includes("/workers/scripts/"), respond: "network-error" });
    const { calls, result } = await runH10(w.deps);
    expect(calls.facts.upload.outcome).toBe("not_a_refusal");
    const e = evaluate(calls, withLeakScan(result, LEAK_CLEAN));
    expect("restUploadAccepted" in e.checks).toBe(false);
    expect(verdict(h10, { measured: e.measured, checks: e.checks }).verdict).toBe("fail");
    expect(w.fake.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  });

  test("a forged 'refusal' (platform_refusal with a control that was refused too) is not a kill, even when the log shows no accepted upload", () => {
    const calls = clone(complete.calls);
    const first = calls.clients.find((c) => c.label === "first-deploy")!;
    first.calls = first.calls.filter((c) => c.method !== "PUT");
    calls.facts.upload = { outcome: "platform_refusal", control: { accepted: false }, refusal: { status: 400, codes: [10021], body: "refused" } };
    const { calls: c, result } = rehash(calls, complete.result);
    expect(evaluate(c, result).checks.restUploadAccepted).toBeUndefined();
    // the same data with the control accepted is a refusal by Cloudflare, which is what the rule means
    const real = clone(calls);
    real.facts.upload.control = { accepted: true };
    const { calls: c2, result: r2 } = rehash(real, complete.result);
    expect(evaluate(c2, r2).checks.restUploadAccepted).toBe(false);
  });

  test("a refusal with no saved answer from Cloudflare is not a kill", () => {
    const calls = clone(complete.calls);
    const first = calls.clients.find((c) => c.label === "first-deploy")!;
    first.calls = first.calls.filter((c) => c.method !== "PUT");
    calls.facts.upload = { outcome: "platform_refusal", control: { accepted: true }, refusal: { status: 400, codes: [10021], body: "" } };
    const { calls: c, result } = rehash(calls, complete.result);
    expect(evaluate(c, result).checks.restUploadAccepted).toBeUndefined();
  });

  test("a refusal claimed while the log shows the upload was accepted is not a kill either", () => {
    const calls = clone(complete.calls);
    calls.facts.upload = { outcome: "platform_refusal", control: { accepted: true }, refusal: { status: 400, codes: [10021], body: "refused" } };
    const { calls: c, result } = rehash(calls, complete.result);
    expect(evaluate(c, result).checks.restUploadAccepted).not.toBe(false);
  });

  test("an address that never answers ends the run with a reason and no time", async () => {
    const w = world({ unreachableFor: 10_000 });
    w.deps.pollTimeoutMs = 50;
    w.deps.sleep = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
    const { calls, result } = await runH10(w.deps);
    expect(result.completed).toBe(false);
    expect(result.secondsToCorrectAnswer).toBeNull();
    expect(result.stoppedBecause).toMatch(/never answered GET \/demo with 200/);
    expect(evaluate(calls, withLeakScan(result, LEAK_CLEAN)).measured).toBeUndefined();
  });

  test("a failure after the clock stopped keeps the measurement and reports what did not happen", async () => {
    const w = world();
    w.fake.fail({ when: (m, p) => m === "PUT" && p.includes("/workers/scripts/"), times: 1000, respond: "network-error" });
    // let the first upload through, break every later one
    w.fake.clearFaults();
    let uploads = 0;
    const inner = w.fake.fetch;
    const isWorkerUpload = (req: Request) =>
      (req.method === "PUT" && req.url.includes("/workers/scripts/")) || (req.method === "POST" && req.url.includes("/versions"));
    w.deps.createClient = (now) =>
      createClient({
        credentials: { token: TOKEN, accountId: ACCOUNT },
        fetch: async (request) => (isWorkerUpload(request) && ++uploads > 1 ? Promise.reject(new TypeError("fetch failed")) : inner(request)),
        now,
        sleep: async () => undefined,
        alsoHide: [KEY],
      });
    const { calls, result } = await runH10(w.deps);
    expect(result.completed).toBe(false);
    expect(result.stoppedBecause).toMatch(/a later run stopped/);
    const e = evaluate(calls, withLeakScan(result, LEAK_CLEAN));
    expect(e.measured).toBe(result.secondsToCorrectAnswer);
    expect(e.checks.urlAnswersCorrectly).toBe(true);
    expect("changedProjectChangesOneThing" in e.checks).toBe(false);
    expect(verdict(h10, { measured: e.measured, checks: e.checks }).verdict).toBe("fail");
  });
});

describe("secrets", () => {
  test("the token, the account id and the access key are in neither file, nor in any line printed, nor in the ledger", () => {
    const text = [canonical(complete.calls), JSON.stringify(complete.result), complete.w.lines.join("\n"), JSON.stringify(complete.w.store.snapshot())].join(
      "\n",
    );
    expect(findSecrets(text, { token: TOKEN, accountId: ACCOUNT, accessKey: KEY })).toEqual([]);
  });

  test("the access key goes to Cloudflare once per upload, as a secret binding, and nowhere else", () => {
    const carrying = complete.w.fake.bodies.filter((b) => b.includes(KEY));
    expect(carrying).toHaveLength(3); // the first, third and fourth uploads
    for (const body of carrying) expect(body).toContain('"type":"secret_text"');
  });

  test("a failure whose message echoes the secrets has them hidden in the file", async () => {
    const w = world();
    w.fake.fail({
      when: (m, p) => m === "GET" && p.endsWith("/workers/subdomain"),
      respond: { status: 403, body: { success: false, errors: [{ code: 10000, message: `no access for ${TOKEN} / ${ACCOUNT} / ${KEY}` }] } },
    });
    const { calls, result } = await runH10(w.deps);
    expect(result.stoppedBecause).toContain("[hidden]");
    expect(findSecrets(canonical(calls) + JSON.stringify(result) + w.lines.join("\n"), { token: TOKEN, accountId: ACCOUNT, accessKey: KEY })).toEqual([]);
  });
});

describe("scanning the repositories", () => {
  test("finds a secret in any file by name and path, never the value, and skips the folders it is told not to read", () => {
    const dir = mkdtempSync(join(tmpdir(), "leak-scan-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
      writeFileSync(join(dir, "src", "a.txt"), `nothing here`);
      writeFileSync(join(dir, "src", "b.log"), `the token is ${TOKEN} oops`);
      writeFileSync(join(dir, "src", "c.json"), JSON.stringify({ account: encodeURIComponent(ACCOUNT) }));
      writeFileSync(join(dir, "node_modules", "x", "d.txt"), `${KEY}`);
      const scan = scanTreesForSecrets([dir], { token: TOKEN, accountId: ACCOUNT, accessKey: KEY });
      expect(scan.filesScanned).toBe(3);
      expect([...scan.found].sort()).toEqual(["accountId in src/c.json", "token in src/b.log"]);
      expect(scan.scannedFor).toEqual(["token", "accountId", "accessKey"]);
      expect(JSON.stringify(scan)).not.toContain(TOKEN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a clean tree has nothing found", () => {
    const dir = mkdtempSync(join(tmpdir(), "leak-scan-"));
    try {
      writeFileSync(join(dir, "a.txt"), "clean");
      expect(scanTreesForSecrets([dir], { token: TOKEN, accountId: ACCOUNT, accessKey: KEY })).toMatchObject({ filesScanned: 1, found: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
