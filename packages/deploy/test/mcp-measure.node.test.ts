import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { INVOICE_FLOW_BLUEPRINT } from "../../../test/support/blueprints.ts";
import { FULL_SESSION, INVOICES as H9_INVOICES } from "../../mcp-server/test/support/session.ts";
import { MCP_MIGRATION_NAME, MCP_TOKEN_BINDING, bundleMcpWorker, mcpMigration, mcpTokenRecords } from "../src/mcp-bundle.ts";
import { FULL_BLUEPRINT, FULL_STEPS, INVOICES, LADDER, MEASURED_PROJECTS, SESSION_PROJECT, canonicalMcp, classifyBuild, evaluateMcp, runMcpMeasurement } from "../src/mcp-measure.ts";
import type { McpDeps, McpFacts, McpResult } from "../src/mcp-measure.ts";
import { findSecrets } from "../src/provisioner/index.ts";
import { mcpResourceNames } from "../src/provisioner/names.ts";

// Story 5.9: the MCP endpoint as its own Worker, and the measurement that runs against it. The real bundle runs in a real workerd
// started by Miniflare, so the endpoint is the one that will be uploaded; what it cannot show is the free plan's CPU limit, which
// only Cloudflare enforces, so the limit itself is imitated here by an answer in the shape Cloudflare gives.
const TOKEN = "story9-test-token-0123456789abcdef0123";
// Story 0.15: one token per project. TOKEN is bound to the session project; each ladder project has its own.
const projectToken = (project: string) => (project === SESSION_PROJECT ? TOKEN : `${TOKEN}-${project}`);
const TOKEN_RECORDS = mcpTokenRecords(Object.fromEntries(MEASURED_PROJECTS.map((p) => [p, projectToken(p)])));
const URL_BASE = "http://mcp.invalid";
let mf: Miniflare;
let db: D1Like;
let bundleBytes = 0;

const BUILD_LIMIT_PAGE = `<!DOCTYPE html><html><head><title>Worker exceeded resource limits | Cloudflare</title></head><body><h1>Error 1102</h1><p>Worker exceeded resource limits</p></body></html>`;

type Wrap = (request: Request, forward: () => Promise<Response>, body: string) => Promise<Response> | null;
function deps(over: Partial<McpDeps> = {}, wrap?: Wrap): McpDeps {
  const forward = async (request: Request, body: string) =>
    (await mf.dispatchFetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body: body || undefined } as never)) as unknown as Response;
  let clock = 0;
  return {
    url: URL_BASE,
    token: TOKEN,
    tokenFor: projectToken,
    fetchUrl: async (url, init) => {
      const request = new Request(url, init);
      const body = init.body ? String(init.body) : "";
      const replaced = wrap?.(request, () => forward(request, body), body);
      return replaced ? await replaced : forward(request, body);
    },
    clock: () => (clock += 3),
    nowIso: () => "2026-10-21T12:00:00.000Z",
    readStoredFiles: async (project) => {
      const rows = (await db.prepare("SELECT path, content FROM mcp_files WHERE project = ? ORDER BY path").bind(project).all<{ path: string; content: string }>()).results;
      return rows.length === 0 ? null : Object.fromEntries(rows.map((r) => [r.path, r.content]));
    },
    hide: (text) => text.split(TOKEN).join("[hidden]"),
    log: () => undefined,
    deploy: null,
    ...over,
  };
}
const isBuild = (body: string) => /"name":"build_project"/.test(body);
const run = async (over: Partial<McpDeps> = {}, wrap?: Wrap) => {
  await db.prepare("DELETE FROM mcp_rate").run(); // the endpoint's own limit is 120 tool calls a minute; each run here makes a few dozen
  return runMcpMeasurement(deps(over, wrap));
};
const evaluate = (facts: McpFacts, result: McpResult) => evaluateMcp({ callsText: canonicalMcp(facts), result });

beforeAll(async () => {
  const bundle = await bundleMcpWorker();
  bundleBytes = bundle.bytes;
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.code, compatibilityDate: "2026-10-01", d1Databases: ["DB"], bindings: { [MCP_TOKEN_BINDING]: TOKEN_RECORDS } }));
  await mf.ready;
  db = (await mf.getD1Database("DB")) as unknown as D1Like;
  await applyMigration(db, mcpMigration().sql);
}, 120_000);
afterAll(async () => {
  await mf?.dispose();
});

describe("what is uploaded", () => {
  test("is one module with no import but the runtime's own, well inside the size limit", async () => {
    const bundle = await bundleMcpWorker();
    expect(bundle.warnings).toEqual([]);
    expect(bundle.code.split(/\r?\n/).filter((line) => /^\s*import\b/.test(line))).toEqual([]);
    // one export statement, the default; (a line that starts with "export" inside the identity stub's source text, which is a string, is not one)
    expect(bundle.code.match(/^export \{\s*\n\s*\w+ as default\s*\n\};?$/gm)).toHaveLength(1);
    expect(bundle.limit.within).toBe(true);
    expect(bundle.limit.percentUsed).toBeLessThan(5);
    expect(bundle.bytes).toBe(bundleBytes);
    expect((await bundleMcpWorker()).sha256).toBe(bundle.sha256); // the same bytes every time
  });

  test("has no brick's own route code in it: it assembles, it does not serve a project", async () => {
    const { code } = await bundleMcpWorker();
    expect(code).not.toContain("createWalletRoutes(");
    expect(code).not.toContain("POC_ACCESS_KEY");
  });

  test("is named with the proof's prefix and the same suffix as the project, and the migration is the server's own file", () => {
    const names = mcpResourceNames("c56a65d4");
    expect(names).toMatchObject({ script: "projectx-poc-c56a65d4-mcp", database: "projectx-poc-c56a65d4-mcp-db" });
    expect(mcpMigration().name).toBe(MCP_MIGRATION_NAME);
    expect(mcpMigration().sql).toMatch(/CREATE TABLE IF NOT EXISTS mcp_projects/);
    expect(() => mcpResourceNames("not-hex")).toThrow();
  });
});

describe("the measured session is the scored one", () => {
  test("its four steps and its project are exactly the ones H9 scored", () => {
    expect(FULL_STEPS).toEqual(FULL_SESSION);
    expect(INVOICES).toEqual(H9_INVOICES);
    expect(FULL_BLUEPRINT).toEqual({ ...INVOICE_FLOW_BLUEPRINT, entities: [H9_INVOICES] });
  });

  test("the smaller projects grow one thing at a time", () => {
    expect(LADDER.map((r) => [r.bricks.length, r.entities.length])).toEqual([[1, 0], [2, 0], [3, 0], [3, 1]]);
  });
});

describe("how an answer to build_project is classed", () => {
  const built = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ project: "p", files: 9, bytes: 10, hash: "a".repeat(64) }) }] } });
  test.each([
    ["a summary with a hash", 200, built, "built"],
    ["a tool error", 200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "no brick is enabled yet" }] } }), "other"],
    ["Cloudflare's resource-limit page", 503, BUILD_LIMIT_PAGE, "resource_limit"],
    ["the plain form of the same refusal", 503, "error code: 1102", "resource_limit"],
    ["the same words under another status", 500, "Worker exceeded resource limits", "resource_limit"],
    ["a rate limit", 429, '{"error":{"message":"too many tool calls"}}', "other"],
    ["a server error that is not the limit", 500, "Internal Server Error", "other"],
    ["a 200 that is not a summary", 200, "{}", "other"],
    ["a 200 that is not JSON", 200, "<html>hello</html>", "other"],
    ["a hash that is not 64 hex characters", 200, built.replace("a".repeat(64), "zz"), "other"],
  ] as const)("%s is %s", (_name, status, body, outcome) => {
    expect(classifyBuild(status, body).outcome).toBe(outcome);
  });

  test("no answer at all is not the limit", () => {
    expect(classifyBuild(null, "").outcome).toBe("other");
  });

  test("a built summary whose hash happens to contain 1102 is still a built project", () => {
    const hash = `${"a".repeat(30)}1102${"b".repeat(30)}`;
    expect(classifyBuild(200, built.replace("a".repeat(64), hash.padEnd(64, "c").slice(0, 64))).outcome).toBe("built");
  });

  test("a built project's hash is read from the summary", () => {
    expect(classifyBuild(200, built).hash).toBe("a".repeat(64));
  });
});

describe("against the real bundle in workerd", () => {
  test("the endpoint is closed without the token and the session builds the project, which equals the direct assembly", async () => {
    const { facts, result } = await run();
    expect(facts.closed).toEqual({ noToken: 401, wrongToken: 401 });
    expect(facts.session.connected).toBe(true);
    expect(facts.session.answers.map((a) => [a.tool, a.isError])).toEqual([["list_bricks", false], ["enable_brick", false], ["define_entity", false], ["build_project", false]]);
    expect(facts.session.toolCalls).toBe(4);
    expect(facts.storedAfterSession).toMatchObject({ read: true, fileCount: 12, sameFiles: true, differing: [] });
    expect(facts.storedAfterSession!.projectHash).toBe(facts.directHash);
    expect(facts.repeats).toHaveLength(10);
    expect(facts.repeats.every((a) => a.outcome === "built" && a.hash === facts.directHash)).toBe(true);
    expect(facts.ladderRun).toBe(false);
    expect(result).toMatchObject({ completed: true });
    expect(result.stoppedBecause).toBeUndefined();
  });

  test("the notes say what happened, without judging it", async () => {
    const { facts, result } = await run({ deploy: { bytes: 864402, gzipBytes: 144355, sha256: "x".repeat(64), percentOfLimit: 1.29, limitBytes: 64 * 1024 * 1024, startupTimeMs: 12, changes: [], reachableAfterMs: null } });
    const e = evaluate(facts, result);
    expect(e.believed).toBe(true);
    expect(e.summary).toEqual({ fullBuilt: 10, fullLimit: 0, fullOther: 0, sessionBuilt: true, sameAsDirect: true });
    const text = e.notes.join("\n");
    expect(text).toMatch(/bundle 844\.1 KiB \(141\.0 KiB gzipped\), 1\.29% of the 64 MiB limit; Cloudflare reported a start-up time of 12 ms/);
    expect(text).toMatch(/without a token the endpoint answered 401, with a wrong one 401/);
    expect(text).toMatch(/the scored session \(4 tool calls, official client\): initialize ok in \d+ ms; tools\/list ok/);
    expect(text).toMatch(/12 files, equal to the direct assembly in Node/);
    expect(text).toMatch(/10 more times: 10 built, 0 stopped by Cloudflare's resource limit \(error 1102\), 0 some other way; built in a median of/);
    expect(text).toMatch(/smaller projects were not built: the full project built every time/);
    expect(text).toMatch(/not shown: the CPU time itself/);
  });

  test("the token is nowhere in what is recorded", async () => {
    const { facts, result } = await run();
    expect(findSecrets(canonicalMcp(facts) + JSON.stringify(result), { token: TOKEN })).toEqual([]);
  });
});

describe("when Cloudflare stops the build", () => {
  const limitOnFull: Wrap = (request, forward, body) => (isBuild(body) && /"project":"invoice-flow"/.test(body) ? Promise.resolve(new Response(BUILD_LIMIT_PAGE, { status: 503 })) : null);

  test("every build of the full project is counted as the limit, the session says where it stopped, and the smaller projects are built", async () => {
    const { facts, result } = await run({}, limitOnFull);
    expect(facts.session.stoppedAt).toBe("build_project");
    expect(facts.session.answers.at(-1)).toMatchObject({ tool: "build_project", isError: true });
    expect(facts.session.answers.at(-1)!.threw).toMatch(/Error 1102/);
    expect(facts.storedAfterSession).toBeNull();
    expect(facts.repeats.map((a) => a.outcome)).toEqual(Array(10).fill("resource_limit"));
    expect(facts.ladderRun).toBe(true);
    expect(facts.ladder.map((r) => [r.label, r.setupOk, r.builds.length, r.builds.every((b) => b.outcome === "built")])).toEqual([["1 brick", true, 5, true], ["2 bricks", true, 5, true], ["3 bricks", true, 5, true], ["3 bricks and the table", true, 5, true]]);
    expect(result.completed).toBe(true); // a limit is a finding, not a fault
    const text = evaluate(facts, result).notes.join("\n");
    expect(text).toMatch(/it stopped at build_project/);
    expect(text).toMatch(/10 more times: 0 built, 10 stopped by Cloudflare's resource limit \(error 1102\), 0 some other way/);
    expect(text).toMatch(/smaller project, 3 bricks and the table: 5 built, 0 stopped by the limit, 0 other, of 5; built in a median of/);
  });

  test("a limit that bites only the biggest projects shows where it starts", async () => {
    const onlyTable: Wrap = (request, forward, body) => (isBuild(body) && /"project":"(invoice-flow|ladder-3t|ladder-3)"/.test(body) ? Promise.resolve(new Response("error code: 1102", { status: 503 })) : null);
    const { facts } = await run({}, onlyTable);
    expect(facts.ladder.map((r) => r.builds.map((b) => b.outcome === "built").every(Boolean))).toEqual([true, true, false, false]);
    expect(facts.ladder[2]!.builds.every((b) => b.outcome === "resource_limit")).toBe(true);
  });

  test("a limit that only sometimes bites is counted each time, and the stored files are still read when some builds worked", async () => {
    let seen = 0;
    const sometimes: Wrap = (request, forward, body) => (isBuild(body) && /"project":"invoice-flow"/.test(body) && (seen += 1) % 3 === 0 ? Promise.resolve(new Response(BUILD_LIMIT_PAGE, { status: 503 })) : null);
    const { facts, result } = await run({}, sometimes);
    const outcomes = facts.repeats.map((a) => a.outcome);
    expect(outcomes.filter((o) => o === "resource_limit").length).toBeGreaterThanOrEqual(3);
    expect(outcomes.filter((o) => o === "built").length).toBeGreaterThanOrEqual(5);
    expect(facts.storedAfterRepeats).toMatchObject({ read: true, sameFiles: true });
    expect(facts.ladderRun).toBe(true);
    expect(result.completed).toBe(true);
  });
});

describe("when something is wrong that is not the limit", () => {
  test("a server error on a build is 'some other way', the run does not complete and says so, and the smaller projects are not built on top of a fault", async () => {
    const boom: Wrap = (request, forward, body) => (isBuild(body) ? Promise.resolve(new Response("Internal Server Error", { status: 500 })) : null);
    const { facts, result } = await run({}, boom);
    expect(facts.repeats.every((a) => a.outcome === "other")).toBe(true);
    expect(facts.ladderRun).toBe(false);
    expect(result.completed).toBe(false);
    expect(result.stoppedBecause).toMatch(/neither a built project nor Cloudflare's resource limit: a fault to find, not a finding/);
  });

  test("an endpoint that lets a caller in without the token is not a completed run", async () => {
    const open: Wrap = (request, forward, body) => (!request.headers.get("authorization") && /"method":"ping"/.test(body) ? Promise.resolve(new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { status: 200 })) : null);
    const { facts, result } = await run({}, open);
    expect(facts.closed.noToken).toBe(200);
    expect(result.completed).toBe(false);
  });

  test("a stored file that differs from the direct assembly is reported by name", async () => {
    const real = deps().readStoredFiles;
    const { facts } = await run({ readStoredFiles: async (p) => ({ ...(await real(p))!, "src/index.ts": "// tampered" }) });
    expect(facts.storedAfterSession).toMatchObject({ read: true, sameFiles: false, differing: ["src/index.ts"] });
  });

  test("a project whose files cannot be read back is said to be unread, not equal", async () => {
    const { facts, result } = await run({ readStoredFiles: async () => null });
    expect(facts.storedAfterSession).toMatchObject({ read: false, sameFiles: false });
    expect(evaluate(facts, result).notes.join("\n")).toMatch(/could not be read/);
    expect(evaluate(facts, result).summary!.sameAsDirect).toBe(false);
  });

  test("no answer at all (the network failed) is recorded with the reason and is 'some other way'", async () => {
    const down: Wrap = (request, forward, body) => (isBuild(body) ? Promise.reject(new Error(`connection reset while sending ${TOKEN}`)) : null);
    const { facts } = await run({}, down);
    const first = facts.repeats[0]!;
    expect(first).toMatchObject({ status: null, outcome: "other" });
    expect(first.error).toMatch(/connection reset/);
    expect(first.error).not.toContain(TOKEN);
  });

  test("a session that cannot connect makes no further calls and says why", async () => {
    const { facts, result } = await run({ token: "wrong-token-wrong-token-wrong-token-1" });
    expect(facts.session.connected).toBe(false);
    expect(facts.repeats).toEqual([]);
    expect(result.completed).toBe(false);
    expect(result.stoppedBecause).toMatch(/could not connect/);
  });
});

describe("reading the evidence again", () => {
  test("a file that was edited is not believed, whether the hash was left alone or rewritten to agree with a changed class", async () => {
    const { facts, result } = await run({}, (request, forward, body) => (isBuild(body) && /"project":"invoice-flow"/.test(body) ? Promise.resolve(new Response(BUILD_LIMIT_PAGE, { status: 503 })) : null));
    const good = canonicalMcp(facts);
    expect(evaluateMcp({ callsText: good, result }).believed).toBe(true);
    // 1. a class edited, the hash left alone
    const edited = structuredClone(facts);
    edited.repeats[0]!.outcome = "built";
    expect(evaluateMcp({ callsText: canonicalMcp(edited), result }).notes.join(" ")).toMatch(/does not match the hash/);
    // 2. the hash rewritten to agree: the class no longer agrees with the answer beside it
    const { createHash } = await import("node:crypto");
    const rewritten = { ...result, callsSha256: createHash("sha256").update(canonicalMcp(edited)).digest("hex") };
    const e = evaluateMcp({ callsText: canonicalMcp(edited), result: rewritten });
    expect(e.believed).toBe(false);
    expect(e.notes.join(" ")).toMatch(/disagrees with the answer recorded beside it/);
    // 3. text that is not JSON, and text that differs only in layout
    expect(evaluateMcp({ callsText: "nope", result }).believed).toBe(false);
    expect(evaluateMcp({ callsText: JSON.stringify(facts), result }).believed).toBe(false);
  });

  test("the class of every attempt is judged again from its answer, in the smaller projects too", async () => {
    const { facts, result } = await run({}, (request, forward, body) => (isBuild(body) && /"project":"invoice-flow"/.test(body) ? Promise.resolve(new Response(BUILD_LIMIT_PAGE, { status: 503 })) : null));
    const edited = structuredClone(facts);
    edited.ladder[1]!.builds[2]!.outcome = "resource_limit";
    const { createHash } = await import("node:crypto");
    const e = evaluateMcp({ callsText: canonicalMcp(edited), result: { ...result, callsSha256: createHash("sha256").update(canonicalMcp(edited)).digest("hex") } });
    expect(e.believed).toBe(false);
  });
});
