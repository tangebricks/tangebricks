import { describe, expect, test } from "vitest";
import { assemble, hashFiles } from "@poc/assembler";
import { catalog } from "@poc/assembler/catalog";
import { attach, record } from "@poc/harness";
import { INVOICE_FLOW_BLUEPRINT } from "../../../test/support/blueprints.ts";
import { TOKENIZER, countTokens, firstPartySource } from "../../../test/support/tokens.ts";
import { projectHash } from "../src/index.ts";
import { FULL_SESSION, INVOICES, ONE_AT_A_TIME_SESSION, SMALL_SESSION, proposeBricks, runSession } from "./support/session.ts";

// H9: an MCP session builds the project at a fraction of the source it produces.
//
// A scripted session (the official MCP client, the real server, Node's SQLite for the database) builds the invoices project.
// The conversation is every HTTP request and response body of the session, counted with one tokenizer. It is compared with
// the project's first-party code (see test/support/tokens.ts for exactly what is and is not counted). The rule was fixed
// before any of this existed: pass at 15 percent or less, kill above 40, at most five tool calls.
const BRICK_PACKAGES: Record<string, string> = {
  "multi-workspace": "bricks/multi-workspace",
  "credit-wallet": "bricks/credit-wallet",
  "dynamic-entities": "bricks/dynamic-entities",
};

async function measure(steps: typeof FULL_SESSION, bricks: string[], blueprint: unknown) {
  const session = await runSession(steps);
  const direct = assemble(blueprint, catalog);
  if (!direct.ok) throw new Error(`the direct assembly failed: ${direct.errors.join("; ")}`);
  const source = firstPartySource({ packageDirs: bricks.map((b) => BRICK_PACKAGES[b]!), generated: session.stored });
  const sameFiles = JSON.stringify(session.stored) === JSON.stringify(direct.files);
  const sameHash = (await projectHash(session.stored)) === (await projectHash(direct.files)) && session.summary?.hash === (await projectHash(direct.files));
  return { session, direct, source, sameFiles, sameHash, percent: (session.rawTokens / source.total) * 100 };
}

const full = await measure(FULL_SESSION, ["multi-workspace", "credit-wallet", "dynamic-entities"], { ...INVOICE_FLOW_BLUEPRINT, entities: [INVOICES] });
const filteredFull = await measure(
  [{ tool: "list_bricks", args: { query: "workspace" } }, ...FULL_SESSION.slice(1)],
  ["multi-workspace", "credit-wallet", "dynamic-entities"],
  { ...INVOICE_FLOW_BLUEPRINT, entities: [INVOICES] },
);
const small = await measure(SMALL_SESSION, ["multi-workspace", "dynamic-entities"], {
  project: "invoice-lite",
  bricks: ["multi-workspace", "dynamic-entities"],
  entities: [INVOICES],
});
const oneAtATime = await measure(ONE_AT_A_TIME_SESSION, ["multi-workspace", "credit-wallet", "dynamic-entities"], {
  ...INVOICE_FLOW_BLUEPRINT,
  entities: [INVOICES],
});

const TEN_BRICKS = [
  "multi-workspace",
  "credit-wallet",
  "dynamic-entities",
  "core-auth",
  "audit-trail",
  "feature-flags",
  "checkout-gateway",
  "binary-assets",
  "public-api-keys",
  "rbac-policy",
];
const tenSession = await runSession([
  { tool: "list_bricks", args: {} },
  proposeBricks("ten-bricks", TEN_BRICKS),
  { tool: "define_entity", args: { project: "ten-bricks", entities: [INVOICES] } },
  { tool: "build_project", args: { project: "ten-bricks" } },
]);
const tenSource = firstPartySource({ packageDirs: TEN_BRICKS.map((b) => `bricks/${b}`), generated: tenSession.stored });
const tenPercent = (tenSession.rawTokens / tenSource.total) * 100;

// A larger project, for information: the three bricks and eight tables, asked for in lists and one item per call.
const TABLES = ["invoices", "clients", "projects", "tasks", "receipts", "notes", "tags", "files"].map((name) => ({
  name,
  fields: [
    { name: "title", type: "text", required: true },
    { name: "amount", type: "number" },
    { name: "status", type: "enum", values: ["open", "done"] },
  ],
}));
const BRICKS = ["multi-workspace", "credit-wallet", "dynamic-entities"];
const bigBatched = await runSession([
  { tool: "list_bricks", args: {} },
  proposeBricks("big", BRICKS),
  { tool: "define_entity", args: { project: "big", entities: TABLES } },
  { tool: "build_project", args: { project: "big" } },
]);
const bigOneEach = await runSession([
  { tool: "list_bricks", args: {} },
  // AD-V8: the money brick is proposed and accepted by the reviewer; the others are applied directly.
  ...BRICKS.map((b) => (b === "credit-wallet" ? proposeBricks("big", [b]) : { tool: "enable_brick", args: { project: "big", bricks: [b] } })),
  ...TABLES.map((t) => ({ tool: "define_entity", args: { project: "big", entities: [t] } })),
  { tool: "build_project", args: { project: "big" } },
]);

const round = (n: number, places = 1) => Math.round(n * 10 ** places) / 10 ** places;

describe("the scored session: the whole invoices project", () => {
  test("every call succeeded, and the build produced the project's nine files", () => {
    expect(full.session.answers.every((a) => !a.isError)).toBe(true);
    expect(full.session.summary).toMatchObject({
      project: "invoice-flow",
      files: 16,
      bricks: ["multi-workspace", "credit-wallet", "dynamic-entities"],
      entities: ["invoices"],
    });
    expect(Object.keys(full.session.stored)).toHaveLength(16); // story 2.3: credit-wallet's order currency migration; story 2.8 multi-workspace's 0002
  });

  test("the files it stored are the files a direct assembly of the same blueprint produces, byte for byte and by hash", async () => {
    expect(full.sameFiles).toBe(true);
    expect(full.sameHash).toBe(true);
    expect(await hashFiles(full.session.stored)).toEqual(await hashFiles(full.direct.files));
  });

  test("it used four tool calls: look, propose the three bricks together (one human review, AD-V8), declare the table, build", () => {
    expect(full.session.toolCalls).toBe(4);
    expect(full.session.answers.map((a) => a.tool)).toEqual(["list_bricks", "apply_ops", "define_entity", "build_project"]);
    expect(full.session.reviews).toHaveLength(1);
  });

  test("the conversation is a small number of tokens and the code a larger one, counted the same way", () => {
    expect(full.session.rawTokens).toBeGreaterThan(1000);
    expect(full.source.total).toBeGreaterThan(5000);
    expect(full.source.total).toBeGreaterThan(full.session.rawTokens);
    expect(full.source.generatedOnly).toBeLessThan(full.source.total);
  });

  test("the denominator counts what it says: the three bricks' code plus the generated files, each distinct text once", () => {
    const bricks = new Set(full.source.files.filter((f) => f.origin === "brick").map((f) => f.path.split("/")[1]));
    expect(bricks).toEqual(new Set(["multi-workspace", "credit-wallet", "dynamic-entities"]));
    expect(full.source.files.filter((f) => f.origin === "generated")).toHaveLength(16); // story 0.21: credit-wallet's rate limits add the px_rate_limits migration; story 2.3 its 0003; story 2.8 multi-workspace's 0002
    expect(full.source.deduplicated).toBe(6); // the bricks' six migrations are copied into the project (credit-wallet's 0003 since story 2.3, 0004 since 2.5; multi-workspace's 0002 since 2.8)
    expect(full.source.files.some((f) => /node_modules|\.test\.|client\//.test(f.path))).toBe(false);
  });
});

describe("the other sessions, for information", () => {
  test("a larger project (eight tables) asked for in lists takes four calls and fewer tokens than one item per call, and builds the same files", () => {
    expect(bigBatched.answers.every((a) => !a.isError) && bigOneEach.answers.every((a) => !a.isError)).toBe(true); // a refused call would quietly make the two sessions build different projects
    expect(bigBatched.toolCalls).toBe(4);
    expect(bigBatched.summary?.entities).toHaveLength(TABLES.length);
    expect(bigOneEach.toolCalls).toBe(1 + BRICKS.length + TABLES.length + 1);
    expect(bigBatched.stored).toEqual(bigOneEach.stored);
    expect(Object.keys(bigBatched.stored).length).toBeGreaterThan(9);
    expect(bigBatched.rawTokens).toBeLessThan(bigOneEach.rawTokens);
  });

  test("building the same project one brick per call gives the same files in six calls", () => {
    expect(oneAtATime.session.toolCalls).toBe(6);
    expect(oneAtATime.session.stored).toEqual(full.session.stored);
    expect(oneAtATime.session.summary?.hash).toBe(full.session.summary?.hash);
  });

  test("the smaller session builds a smaller project in four calls, which also equals a direct assembly", () => {
    expect(small.session.toolCalls).toBe(4);
    expect(small.sameFiles && small.sameHash).toBe(true);
    expect(small.session.summary).toMatchObject({ bricks: ["multi-workspace", "dynamic-entities"], entities: ["invoices"] });
  });
});

test("H9 report", ({ task }) => {
  const checks = {
    fiveToolCallsOrFewer: full.session.toolCalls <= 5,
    sessionBuiltTheDirectProject: full.sameFiles && full.sameHash && full.session.summary !== null,
    // Both sides came from the one countTokens, over non-empty texts; the denominator is not zero and not smaller than the conversation's own parts.
    bothSidesCountedTheSameWay:
      full.session.rawTokens > 0 &&
      full.source.total > 0 &&
      full.session.rawTokens === full.session.exchanges.reduce((s, e) => s + countTokens(e.requestBody) + countTokens(e.responseBody), 0),
  };
  attach(task, "h9-session", {
    tokenizer: TOKENIZER,
    rule: { pass: "15 percent or less", kill: "above 40 percent", toolCalls: "at most 5" },
    scored: {
      session: "the whole invoices project (workspaces, wallet, entities)",
      toolCalls: full.session.toolCalls,
      conversationTokens: full.session.rawTokens,
      modelVisibleTokens: full.session.modelVisibleTokens,
      firstPartySourceTokens: full.source.total,
      generatedFilesOnlyTokens: full.source.generatedOnly,
      ratioPercent: round(full.percent),
      ratioAgainstGeneratedFilesOnlyPercent: round((full.session.rawTokens / full.source.generatedOnly) * 100),
      modelVisibleRatioPercent: round((full.session.modelVisibleTokens / full.source.total) * 100),
      projectHash: full.session.summary?.hash,
      files: Object.keys(full.session.stored).length,
      byMessage: full.session.exchanges
        .filter((e) => e.requestBody || e.responseBody)
        .map((e) => ({ what: e.tool ? `tools/call ${e.tool}` : (e.rpc ?? e.httpMethod), requestTokens: e.requestTokens, responseTokens: e.responseTokens })),
      sourceByFile: full.source.files.map((f) => ({ path: f.path, tokens: f.tokens, ...(f.duplicateOf ? { countedOnceAs: f.duplicateOf } : {}) })),
    },
    forInformation: {
      filteredDiscovery: {
        session: "the whole invoices project with filtered list_bricks ({ query: 'workspace' })",
        toolCalls: filteredFull.session.toolCalls,
        conversationTokens: filteredFull.session.rawTokens,
        firstPartySourceTokens: filteredFull.source.total,
        ratioPercent: round(filteredFull.percent),
      },
      tenBricks: {
        session: "ten bricks and the invoices table in four calls",
        toolCalls: tenSession.toolCalls,
        conversationTokens: tenSession.rawTokens,
        firstPartySourceTokens: tenSource.total,
        filesBuilt: Object.keys(tenSession.stored).length,
        ratioPercent: round(tenPercent),
      },
      smallerProject: {
        session: "workspaces and invoices without the wallet",
        toolCalls: small.session.toolCalls,
        conversationTokens: small.session.rawTokens,
        firstPartySourceTokens: small.source.total,
        ratioPercent: round(small.percent),
      },
      eightTables: {
        session: "three bricks and eight tables: in four calls with lists, and one item per call",
        listsToolCalls: bigBatched.toolCalls,
        listsConversationTokens: bigBatched.rawTokens,
        oneItemPerCallToolCalls: bigOneEach.toolCalls,
        oneItemPerCallConversationTokens: bigOneEach.rawTokens,
        tokensSavedByLists: bigOneEach.rawTokens - bigBatched.rawTokens,
        filesBuilt: Object.keys(bigBatched.stored).length,
      },
      oneBrickPerCall: {
        session: "the same project built one brick per call, the way the first version of the tools required",
        toolCalls: oneAtATime.session.toolCalls,
        conversationTokens: oneAtATime.session.rawTokens,
        toolListTokens: oneAtATime.session.exchanges.filter((e) => e.rpc === "tools/list").reduce((s, e) => s + e.requestTokens + e.responseTokens, 0),
        ratioPercent: round(oneAtATime.percent),
      },
    },
  });
  record(task, { id: "H9", measured: round(full.percent), checks });
});
