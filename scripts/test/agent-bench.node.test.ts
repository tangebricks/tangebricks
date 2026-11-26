import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { catalog } from "../../packages/assembler/catalog.generated.ts";
import { generateOpenApiSpec } from "../../packages/assembler/src/openapi.ts";
import { KEY_HEADER } from "../../packages/deploy/src/worker/gate.ts";
import { memoryStore } from "../../packages/deploy/src/provisioner/index.ts";
import { createFakeCloudflare } from "../../packages/deploy/test/support/fake-cloudflare.ts";
import { LiveProofRefusal, runTeardownOnly } from "../lib/live-studio.ts";
import type { StudioCall } from "../lib/live-studio.ts";
import type { FakeCloudflare } from "../../packages/deploy/test/support/fake-cloudflare.ts";
import {
  BenchmarkFileSchema,
  BenchRefusal,
  DEFAULT_BRIEF_IDS,
  CHANGE_LIVE_APP_BRIEF,
  MAX_IDENTICAL_BLOCKED_REPLIES,
  UPGRADED_PRE_OWNER_ACTIONS,
  bindUnboundSecrets,
  agentProgress,
  latestDeployedRun,
  loadReview,
  namedSecrets,
  secretStatusFor,
  reviewProposal,
  startOwnerLoop,
  upgradeRunRecord,
  CHANGE_DEBIT_CREDITS,
  FREE_PLAN_UNSUPPORTED_REASON,
  KILL_RULE_VERSION,
  RunRecordSchema,
  GENERIC_OWNER_REPLY,
  claudeArgs,
  claudeSessionDir,
  defaultClaudeBin,
  evaluateKillRule,
  loadBrief,
  ownerReply,
  UPGRADED_PRE_AGENT_CALLS,
  COST_NOTE,
  repairCostsInFolder,
  parseCliResult,
  privatePathRefusal,
  saveRun,
  runAgentBench,
  sampleValue,
  updatedValue,
  writeBenchmarkResult,
} from "../agent-bench.ts";
import type { AgentBenchDeps, ClaudeRunInput, ClaudeRunner, ReviewFile, RunRecord } from "../agent-bench.ts";

// Story R55: the benchmark harness, offline. Cloudflare's API is the fake (real SQLite D1, documented shapes); the deployed
// preview Worker is a small simulator (access key, stub identity, workspaces, generic entity CRUD, the project's
// openapi.json); the Claude Code CLI is a fake that replays MCP calls through the official MCP client against Studio's real
// /mcp over the loopback listener. Nothing reaches the network: global fetch refuses every non-loopback address.

const TOKEN = "cfut_AgentBenchOfflineTokenR55aaaaaaaaaaaaaaaaaaaaaaaaa";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ROOT_SECRET = "offline-root-secret-r55-0123456789abcdef";
const FIXTURE_BRIEF = "# Product brief\n\nA tiny catalogue of things, for the offline test only. It has one entity, kept per workspace.\n";
const FIXTURE_ANSWERS = "# Owner answers\n\n1. Name: Offline Fixture\n2. Entities: books (title, pages)\n";
const ENTITY = { name: "books", workspaceScoped: true, fields: [{ name: "title", type: "text", required: true }, { name: "pages", type: "number" }] };
const BRICKS = ["multi-workspace", "credit-wallet", "dynamic-entities"];

const roots: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1") throw new Error(`offline test: refused a request to ${url.host}`);
    return realFetch(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** The deployed preview Worker, simulated: the gate's key check, the stub identity, workspaces and entity CRUD. */
function workerSimulator(fake: FakeCloudflare) {
  const workspaces = new Map<string, string>();
  const rows = new Map<string, Map<string, Record<string, unknown>>>();
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const script = url.hostname.split(".")[0]!;
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const key = fake.secretOf(script, "POC_ACCESS_KEY");
    if (!key || request.headers.get(KEY_HEADER) !== key) return json(401, { error: "unauthorized" });
    if (url.pathname === "/healthz") return json(200, { ok: true });
    if (url.pathname === "/openapi.json") return json(200, generateOpenApiSpec({ project: script, bricks: BRICKS, entities: [ENTITY] } as never, catalog as never));
    const user = request.headers.get("x-test-user");
    if (!user) return json(401, { error: "unauthenticated" });
    if (url.pathname === "/api/workspaces" && request.method === "POST") {
      const id = `ws_${randomBytes(6).toString("hex")}`;
      workspaces.set(id, user);
      return json(201, { workspace: { id } });
    }
    const m = url.pathname.match(/^\/api\/([a-z_]+)(?:\/([^/]+))?$/);
    if (!m || m[1] !== ENTITY.name) return json(404, {});
    const ws = request.headers.get("x-workspace-id") ?? "";
    if (workspaces.get(ws) !== user) return json(403, { error: "workspace" });
    const table = rows.get(ws) ?? new Map<string, Record<string, unknown>>();
    rows.set(ws, table);
    const id = m[2] ? decodeURIComponent(m[2]) : null;
    if (!id && request.method === "POST") {
      const body = (await request.json()) as Record<string, unknown>;
      if (typeof body.title !== "string") return json(400, { error: "title" });
      const item = { id: `row_${randomBytes(6).toString("hex")}`, workspace_id: ws, ...body };
      table.set(item.id, item);
      return json(201, { item });
    }
    if (!id && request.method === "GET") return json(200, { items: [...table.values()] });
    const item = id ? table.get(id) : undefined;
    if (!item) return json(404, { error: "not found" });
    if (request.method === "GET") return json(200, { item });
    if (request.method === "PATCH") {
      Object.assign(item, (await request.json()) as Record<string, unknown>);
      return json(200, { item });
    }
    if (request.method === "DELETE") {
      table.delete(id!);
      return json(200, { ok: true });
    }
    return json(405, {});
  };
}

const testBundle = async (input: { project: string; envName: string; files: Record<string, string> }) => ({
  code: `// bundled ${input.project} ${input.envName} (${Object.keys(input.files).length} files)\nexport class GraphRunner {}\nexport default { fetch() { return new Response("ok"); } };`,
});

type ToolAnswer = { isError: boolean; body: Record<string, any> };
interface Agent {
  tool(name: string, args: Record<string, unknown>): Promise<ToolAnswer>;
  log: Array<{ name: string; args: Record<string, unknown>; answer: ToolAnswer }>;
}
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A fake `claude -p`: checks what it was given, then plays `script` through the official MCP client, and prints a result. */
function fakeCli(
  script: (agent: Agent, input: ClaudeRunInput) => Promise<void>,
  options: {
    result?: Record<string, unknown> | ((call: number) => Record<string, unknown>);
    timedOut?: boolean;
    exitCode?: number;
    throwAfter?: boolean;
    /** What the agent does on a resumed call (an owner reply); nothing by default. */
    resumed?: (agent: Agent, input: ClaudeRunInput, call: number) => Promise<void>;
  } = {},
): ClaudeRunner & { inputs: ClaudeRunInput[]; log: Agent["log"] } {
  const inputs: ClaudeRunInput[] = [];
  const log: Agent["log"] = [];
  return {
    inputs,
    log,
    async version() {
      return "9.9.9 (Fake Claude Code)";
    },
    async run(input) {
      inputs.push(input);
      const callNumber = inputs.length;
      expect(readdirSync(input.cwd)).toEqual([]);
      const config = JSON.parse(readFileSync(input.mcpConfigPath, "utf8")) as { mcpServers: Record<string, { type: string; url: string }> };
      expect(Object.keys(config.mcpServers)).toEqual(["projectx"]);
      const client = new Client({ name: "fake-claude", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(input.mcp.url), { requestInit: { headers: input.mcp.headers } }));
      const agent: Agent = {
        log,
        async tool(name, args) {
          const r = await client.callTool({ name, arguments: args });
          const text = (r.content as Array<{ text: string }>)[0]!.text;
          let body: Record<string, any>;
          try {
            body = JSON.parse(text) as Record<string, any>;
          } catch {
            body = { text };
          }
          const answer = { isError: r.isError === true, body };
          log.push({ name, args, answer });
          return answer;
        },
      };
      try {
        if (callNumber === 1) await script(agent, input);
        else await options.resumed?.(agent, input, callNumber);
      } finally {
        await client.close();
      }
      if (options.throwAfter) throw new Error("the fake CLI crashed");
      const result = (typeof options.result === "function" ? options.result(callNumber) : options.result) ?? { type: "result", subtype: "success", is_error: false, num_turns: 12, total_cost_usd: 0.42, duration_ms: 1234, result: "PREVIEW: done", session_id: "sess-fake-1", modelUsage: { "claude-fake-model-20261126": { inputTokens: 1, outputTokens: 1 } } };
      return { exitCode: options.exitCode ?? 0, stdout: options.timedOut ? "" : JSON.stringify(result), stderr: "", timedOut: options.timedOut ?? false };
    },
  };
}

async function waitFor<T>(fn: () => Promise<T | null>, what: string): Promise<T> {
  for (let i = 0; i < 400; i += 1) {
    const v = await fn();
    if (v !== null) return v;
    await pause(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The build an agent does: bricks (a proposal the owner accepts), the entity, a report workflow, each its own revision. */
async function build(agent: Agent) {
  const bricks = await agent.tool("apply_ops", { ops: BRICKS.map((brickId) => ({ opId: `enable-${brickId}`, type: "enable_brick", brickId, config: {} })) });
  expect(bricks.isError, JSON.stringify(bricks.body)).toBe(false);
  expect(bricks.body.status).toBe("pending");
  await waitFor(async () => {
    const summary = await agent.tool("get_blueprint_summary", {});
    return JSON.stringify(summary.body).includes("dynamic-entities") ? true : null;
  }, "the owner to accept the bricks proposal");
  const entity = await agent.tool("apply_ops", { ops: [{ opId: "entity-books", type: "add_entity", entity: ENTITY }] });
  expect(entity.isError, JSON.stringify(entity.body)).toBe(false);
  const workflow = await agent.tool("apply_ops", {
    ops: [
      {
        opId: "wf-report",
        type: "add_workflow",
        workflow: {
          id: "wf-report",
          name: "Monthly report",
          nodes: [
            { id: "trigger", type: "trigger.manual", label: "Manual", data: {} },
            { id: "debit", type: "credit-wallet.debit", label: "Debit", data: { amount: 1 } },
          ],
          edges: [{ id: "e1", source: "trigger", target: "debit", sourceHandle: "out", targetHandle: "in" }],
        },
      },
    ],
  });
  if (workflow.body.status === "pending") {
    await waitFor(async () => (JSON.stringify((await agent.tool("get_blueprint_summary", {})).body).includes("wf-report") ? true : null), "the workflow proposal");
  } else expect(workflow.isError, JSON.stringify(workflow.body)).toBe(false);
}

/** A build without a money brick, applied directly (mode "apply"): bricks, then (optionally) the entity. */
async function buildPlain(agent: Agent, options: { entity: boolean }) {
  const bricks = await agent.tool("apply_ops", { mode: "apply", ops: ["multi-workspace", "dynamic-entities"].map((brickId) => ({ opId: `enable-${brickId}`, type: "enable_brick", brickId, config: {} })) });
  expect(bricks.isError, JSON.stringify(bricks.body)).toBe(false);
  if (options.entity) {
    const entity = await agent.tool("apply_ops", { mode: "apply", ops: [{ opId: "entity-books", type: "add_entity", entity: ENTITY }] });
    expect(entity.isError, JSON.stringify(entity.body)).toBe(false);
  }
}

/** deploy_plan, then deploy_apply: APPROVAL_REQUIRED, the owner approves in Studio, the retry carries the approvalId. */
async function deployPreview(agent: Agent): Promise<ToolAnswer> {
  const valid = await agent.tool("validate_blueprint", {});
  expect(valid.isError).toBe(false);
  const plan = await agent.tool("deploy_plan", { env: "preview" });
  expect(plan.isError, JSON.stringify(plan.body)).toBe(false);
  let answer = await agent.tool("deploy_apply", { env: "preview" });
  const approvalId = answer.body.error?.approvalId as string | undefined;
  for (let i = 0; i < 400 && answer.isError && ["APPROVAL_REQUIRED", "APPROVAL_PENDING"].includes(answer.body.error?.code); i += 1) {
    await pause(10);
    answer = await agent.tool("deploy_apply", { env: "preview", ...(approvalId ? { approvalId } : {}) });
  }
  return answer;
}

function world() {
  const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT, tokenKind: "user" });
  const root = mkdtempSync(join(tmpdir(), "agent-bench-"));
  roots.push(root);
  const lines: string[] = [];
  const deps = (runner: ClaudeRunner, extra: Partial<AgentBenchDeps> = {}): AgentBenchDeps => ({
    task: "brief",
    brief: { id: "fixture", brief: FIXTURE_BRIEF, answers: FIXTURE_ANSWERS, briefSha256: "a".repeat(64), answersSha256: "b".repeat(64) },
    credentials: { token: TOKEN, accountId: ACCOUNT },
    rootSecret: ROOT_SECRET,
    cloudflareFetch: fake.fetch,
    workerFetch: workerSimulator(fake),
    bundle: testBundle,
    ledgerStore: memoryStore(),
    randomHex: (n: number) => randomBytes(n).toString("hex"),
    runner,
    maxBudgetUsd: 10,
    workRoot: root,
    ownerIntervalMs: 5,
    log: (line: string) => lines.push(line),
    sleep: async () => {},
    ...extra,
  });
  return { fake, root, lines, deps };
}

const expectNothingLeft = (fake: FakeCloudflare, record: RunRecord) => {
  expect(record.teardown!.leftBehind).toEqual([]);
  expect(fake.state().scripts).toEqual([]);
  expect(fake.state().databases).toEqual([]);
  expect(fake.state().workflows).toEqual([]);
  expect(record.teardown!.removed.every((r) => r.name.startsWith(`px-${record.project}-`))).toBe(true);
};
const outcome = (record: RunRecord, line: number) => record.checks!.find((c) => c.line === line)!.outcome;

describe("scripts/agent-bench.ts, offline with a fake CLI and a fake Cloudflare", () => {
  test("a full brief run: a schema-valid record with all 12 checks, the CLI's own numbers, owner reviews, and everything torn down", { timeout: 120_000 }, async () => {
    const { fake, root, lines, deps } = world();
    const cli = fakeCli(async (agent) => {
      await build(agent);
      const deployed = await deployPreview(agent);
      expect(deployed.isError, JSON.stringify(deployed.body)).toBe(false);
    });
    const record = await runAgentBench(deps(cli));
    expect(record.incompleteReason, lines.join("\n")).toBeNull();
    expect(record.status).toBe("complete");
    expect(RunRecordSchema.parse(record)).toBeTruthy();
    expect(record.checks).toHaveLength(12);

    // the CLI ran with ProjectX as its only tool source, in an empty folder, with the budget cap
    const args = claudeArgs(cli.inputs[0]!);
    expect(args).toEqual(expect.arrayContaining(["-p", "--strict-mcp-config"]));
    expect(args).not.toContain("--no-session-persistence");
    expect(args).not.toContain("--resume");
    expect(cli.inputs).toHaveLength(1); // deployed in the first call: no owner reply
    expect(record.cli.agentCalls).toBe(1);
    expect(record.agentCalls[0]).toMatchObject({ call: 1, prompt: "brief", reply: null, resumed: false, resultText: "PREVIEW: done", numTurns: 12, maxBudgetUsd: 10 });
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("10");
    expect(cli.inputs[0]!.prompt).toContain(FIXTURE_BRIEF.trim());
    expect(cli.inputs[0]!.prompt).toContain(FIXTURE_ANSWERS.trim());
    // the first call gets what is left of the 45-minute cap; a millisecond may already have passed
    expect(cli.inputs[0]!.timeoutMs).toBeLessThanOrEqual(45 * 60 * 1000);
    expect(cli.inputs[0]!.timeoutMs).toBeGreaterThan(45 * 60 * 1000 - 5_000);

    // the CLI's numbers, as it reported them
    expect(record.cli).toMatchObject({ version: "9.9.9 (Fake Claude Code)", modelIds: ["claude-fake-model-20261126"], modelIdSource: "modelUsage", costUsd: 0.42, costLabel: "client-estimated", numTurns: 12, missingFields: [] });
    // bricks, entity and workflow each came back as a proposal once a money brick was in the project; one deploy approval
    expect(record.ownerReview).toMatchObject({ proposalsAccepted: 3, proposalsRejected: 0, approvalsApproved: 1, count: 4, refused: 0, rejectedNotPreview: [] });
    // no review file: every proposal is accepted and recorded as unreviewed; the approval is recorded too
    expect(record.ownerActions.map((a) => a.kind).sort()).toEqual(["accept-unreviewed", "accept-unreviewed", "accept-unreviewed", "approve"]);
    expect(record.ownerActions.every((a) => !Number.isNaN(Date.parse(a.at)))).toBe(true);

    // the harness's scoring
    expect(record.deployed).toBe(true);
    expect(record.previewUrl).toBe(`https://px-${record.project}-preview.<account-subdomain>.workers.dev`);
    for (const line of [4, 5, 6, 7, 9, 10]) expect(outcome(record, line), JSON.stringify(record.checks)).toBe("pass");
    expect(outcome(record, 2)).toBe("partial");
    expect(outcome(record, 12)).toBe("partial");
    for (const line of [1, 3, 8, 11]) expect(outcome(record, line)).toBe("n/a");
    expect(record.score).toEqual({ passes: 6, partials: 2, notApplicable: 4, fails: 0, applicable: 8 });
    expect(record.blueprint).toBeTruthy();

    expectNothingLeft(fake, record);
    const text = JSON.stringify(record);
    for (const secret of [TOKEN, ACCOUNT, ROOT_SECRET]) {
      expect(text).not.toContain(secret);
      expect(lines.join("\n")).not.toContain(secret);
    }
    expect(text).not.toContain(FIXTURE_BRIEF.trim());

    // an older results file (a run recorded before agent calls) is upgraded on load, and the new run merges beside it
    const oldDir = join(root, "old");
    const oldOut = join(oldDir, "benchmark-v0.json");
    const old = JSON.parse(JSON.stringify({ ...record, runId: "brief-fixture-old-run" })) as Record<string, any>;
    delete old.agentCalls;
    delete old.cli.agentCalls;
    delete old.limits.maxAgentCalls;
    delete old.ownerReview.secretsBound;
    delete old.ownerActions;
    delete old.ownerReview.proposalsRejected;
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(oldOut, JSON.stringify({ benchmark: "real-model-benchmark-v0", internal: true, note: "old", runs: [old], killRule: { status: "from an older schema" } }));
    const saved = saveRun({ out: oldOut, record, refusal: () => null, log: () => {} });
    expect(saved.ok).toBe(true);
    expect(existsSync(join(oldDir, "runs", `${record.runId}.json`))).toBe(true);
    const merged = BenchmarkFileSchema.parse(JSON.parse(readFileSync(oldOut, "utf8")));
    expect(merged.runs.map((r) => r.runId)).toEqual(["brief-fixture-old-run", record.runId]);
    expect(merged.runs[0]).toMatchObject({ agentCalls: [], cli: { agentCalls: 1 }, limits: { maxAgentCalls: 1 }, ownerReview: { secretsBound: [], proposalsRejected: 0 }, ownerActions: [], schemaNote: UPGRADED_PRE_AGENT_CALLS });
    expect(merged.runs[1]!.schemaNote).toBeUndefined();
    expect(merged.killRule.ruleVersion).toBe(KILL_RULE_VERSION);

    // a merge that fails keeps the run's own record and says so; the caller exits non-zero
    const errors: string[] = [];
    const failed = saveRun({ out: join(root, "broken", "benchmark-v0.json"), record, refusal: () => null, log: () => {}, error: (l) => errors.push(l), merge: () => { throw new Error("forced merge failure"); } });
    expect(failed.ok).toBe(false);
    expect(failed.runPath).toBe(join(root, "broken", "runs", `${record.runId}.json`));
    expect(RunRecordSchema.parse(JSON.parse(readFileSync(failed.runPath!, "utf8"))).runId).toBe(record.runId);
    expect(errors.join("\n")).toMatch(/the run is kept at .*forced merge failure/);
    // a refused per-run path writes nothing
    const refused = saveRun({ out: join(root, "evidence", "benchmark-v0.json"), record, refusal: () => "top level of evidence", log: () => {}, error: () => {} });
    expect(refused).toMatchObject({ ok: false, runPath: null });

    // the private results file: schema-valid, judged on applicable lines with the literal 12-line score beside it
    expect(record.iteration).toBe(1);
    const out = join(root, "private", "benchmark-v0.json");
    const file = writeBenchmarkResult(out, record);
    expect(BenchmarkFileSchema.parse(JSON.parse(readFileSync(out, "utf8")))).toBeTruthy();
    expect(file.killRule).toMatchObject({ ruleVersion: KILL_RULE_VERSION, latestIteration: 1, status: { applicableLines: "met", literalAsWritten: "not-met" }, decision: "left to the owner", excludedRuns: [] });
    expect(file.killRule.notApplicable.map((n) => n.line)).toEqual([1, 3, 8, 11]);
    expect(file.killRule.iterations[0]!.perBrief[0]).toMatchObject({
      briefId: "fixture",
      deployed: true,
      applicableLines: { passes: 6, of: 8, met: true },
      literalAsWritten: { passes: 6, of: 12, met: false },
    });
  });

  test("a deploy asks for approval: the owner approves in Studio, the agent's retry with the approvalId deploys, and deploy_apply reports the address", { timeout: 120_000 }, async () => {
    const { fake, deps } = world();
    const cli = fakeCli(async (agent) => {
      await build(agent);
      await deployPreview(agent);
    });
    const record = await runAgentBench(deps(cli));
    const applies = cli.log.filter((l) => l.name === "deploy_apply");
    expect(applies[0]!.answer.isError).toBe(true);
    expect(applies[0]!.answer.body.error.code).toBe("APPROVAL_REQUIRED");
    const approvalId = applies[0]!.answer.body.error.approvalId as string;
    const last = applies.at(-1)!;
    expect(last.args.approvalId).toBe(approvalId);
    expect(last.answer.isError).toBe(false);
    expect(last.answer.body.workerUrl).toBe(`https://px-${record.project}-preview.fake-subdomain.workers.dev`);
    expect(String(last.answer.body.deploymentId)).toMatch(/^dep_/);
    expect(record.ownerReview.approvalsApproved).toBe(1);
    expect(record.ownerReview.waitMs).toBeGreaterThanOrEqual(0);
    expectNothingLeft(fake, record);
  });

  test("a cap hit: the wall-time cap stops the CLI; the run is recorded incomplete, scored on what exists, and torn down", { timeout: 120_000 }, async () => {
    const { fake, deps } = world();
    const cli = fakeCli(async (agent) => {
      await build(agent);
    }, { timedOut: true, exitCode: null as unknown as number });
    const record = await runAgentBench(deps(cli));
    expect(record.status).toBe("incomplete");
    expect(record.incompleteReason).toMatch(/wall-time cap hit/);
    expect(record.cli.timedOut).toBe(true);
    expect(record.cli.missingFields).toEqual(["json"]);
    expect(record.cli.modelIds).toEqual([]);
    expect(record.checks).toHaveLength(12);
    expect(record.deployed).toBe(false);
    expect(outcome(record, 10)).toBe("fail");
    expect(outcome(record, 6)).toBe("pass"); // the revisions it did make are there
    expectNothingLeft(fake, record);
  });

  test("a budget cap hit is recorded from the CLI's own result subtype", { timeout: 120_000 }, async () => {
    const { fake, deps } = world();
    const cli = fakeCli(async () => {}, { exitCode: 1, result: { type: "result", subtype: "error_max_budget_usd", is_error: true, num_turns: 40, total_cost_usd: 10.02 } });
    const record = await runAgentBench(deps(cli));
    expect(record.status).toBe("incomplete");
    expect(record.incompleteReason).toMatch(/budget cap hit/);
    expect(record.cli).toMatchObject({ subtype: "error_max_budget_usd", costUsd: 10.02, numTurns: 40, modelIdSource: "missing", missingFields: expect.arrayContaining(["modelUsage", "duration_ms"]) });
    expectNothingLeft(fake, record);
  });

  test("a refused deploy: check 10 fails with the refusal, the run still scores and tears down", { timeout: 120_000 }, async () => {
    const { fake, deps } = world();
    fake.set({ refuseAllUploads: true });
    let refused: ToolAnswer | null = null;
    const cli = fakeCli(async (agent) => {
      await build(agent);
      refused = await deployPreview(agent);
    });
    const record = await runAgentBench(deps(cli));
    expect(refused!.isError).toBe(true);
    expect(record.deployed).toBe(false);
    expect(record.deployRefusal).toBeTruthy();
    expect(outcome(record, 10)).toBe("fail");
    expect(record.checks!.find((c) => c.line === 10)!.evidence).toMatch(/no preview deploy \(last preview deploy /);
    expect(outcome(record, 4)).toBe("fail");
    expect(record.checks).toHaveLength(12);
    expectNothingLeft(fake, record);
  });

  test("teardown on failure: the CLI crashes after deploying; what it made is still removed", { timeout: 120_000 }, async () => {
    const { fake, deps } = world();
    const cli = fakeCli(async (agent) => {
      await build(agent);
      await deployPreview(agent);
      expect(fake.state().scripts.length).toBeGreaterThan(0);
    }, { throwAfter: true });
    const record = await runAgentBench(deps(cli));
    expect(record.status).toBe("incomplete");
    expect(record.incompleteReason).toMatch(/the CLI failed: the fake CLI crashed/);
    expect(record.teardown!.removed.length).toBeGreaterThan(0);
    expect(record.checks).toHaveLength(12);
    expectNothingLeft(fake, record);
  });

  test("line 2 sends the stub-identity probe even when the app has no entity", { timeout: 120_000 }, async () => {
    const { fake, deps } = world();
    const cli = fakeCli(async (agent) => {
      await buildPlain(agent, { entity: false });
      const deployed = await deployPreview(agent);
      expect(deployed.isError, JSON.stringify(deployed.body)).toBe(false);
    });
    const record = await runAgentBench(deps(cli));
    expect(record.deployed).toBe(true);
    expect(outcome(record, 4)).toBe("fail");
    expect(record.checks!.find((c) => c.line === 4)!.evidence).toBe("the blueprint defines no entity");
    expect(outcome(record, 2)).toBe("partial");
    expect(record.checks!.find((c) => c.line === 2)!.evidence).toMatch(/accepted the x-test-user header/);
    expectNothingLeft(fake, record);
  });

  test("line 5 never redeploys a revision the agent left undeployed", { timeout: 120_000 }, async () => {
    const { fake, deps } = world();
    const cli = fakeCli(async (agent) => {
      await buildPlain(agent, { entity: true });
      const deployed = await deployPreview(agent);
      expect(deployed.isError, JSON.stringify(deployed.body)).toBe(false);
      const later = await agent.tool("apply_ops", { mode: "apply", ops: [{ opId: "later", type: "set_metadata", metadata: { description: "changed after the deploy" } }] });
      expect(later.isError, JSON.stringify(later.body)).toBe(false);
    });
    const record = await runAgentBench(deps(cli));
    expect(record.deployed).toBe(true);
    expect(outcome(record, 5)).toBe("fail");
    expect(record.checks!.find((c) => c.line === 5)!.evidence).toMatch(/latest revision never deployed: the blueprint is at r3, preview runs r2, so no redeploy was sent/);
    expectNothingLeft(fake, record);
  });

  test("line 6 reads every page of revisions, not only the newest 100", { timeout: 180_000 }, async () => {
    const { fake, deps } = world();
    const cli = fakeCli(async (agent) => {
      await buildPlain(agent, { entity: true });
      for (let i = 0; i < 101; i += 1) {
        const r = await agent.tool("apply_ops", { mode: "apply", ops: [{ opId: `meta-${i}`, type: "set_metadata", metadata: { description: `revision ${i}` } }] });
        expect(r.isError, JSON.stringify(r.body)).toBe(false);
      }
    });
    const record = await runAgentBench(deps(cli));
    const line6 = record.checks!.find((c) => c.line === 6)!;
    expect(line6.evidence).toMatch(/^103 revision\(s\) \(current r103\); per stage: bricks 1, entities 1;/);
    expect(line6.outcome).toBe("pass");
    expectNothingLeft(fake, record);
  });

  test("the owner rejects any approval that is not a preview deploy, records it, and keeps accepting proposals", { timeout: 120_000 }, async () => {
    const { fake, deps } = world();
    let production: ToolAnswer | null = null;
    const cli = fakeCli(async (agent) => {
      await build(agent);
      const deployed = await deployPreview(agent);
      expect(deployed.isError, JSON.stringify(deployed.body)).toBe(false);
      // production refuses the stub identity before any approval, so the agent switches to a real one first
      const identity = await agent.tool("apply_ops", { ops: [{ opId: "auth", type: "enable_brick", brickId: "oidc-verify", config: {} }, { opId: "identity", type: "set_identity", identity: "oidc-verify" }] });
      expect(identity.isError, JSON.stringify(identity.body)).toBe(false);
      await waitFor(async () => (JSON.stringify((await agent.tool("get_blueprint_summary", {})).body).includes("oidc-verify") ? true : null), "the identity proposal");
      production = await agent.tool("deploy_apply", { env: "production" });
      const approvalId = production.body.error?.approvalId as string | undefined;
      if (approvalId) {
        for (let i = 0; i < 400 && ["APPROVAL_REQUIRED", "APPROVAL_PENDING"].includes(production.body.error?.code); i += 1) {
          await pause(10);
          production = await agent.tool("deploy_apply", { env: "production", approvalId });
        }
      }
    });
    const record = await runAgentBench(deps(cli));
    expect(production!.isError).toBe(true);
    expect(production!.body.error.code).toBe("APPROVAL_REJECTED");
    expect(record.ownerReview.rejectedNotPreview).toEqual([{ approvalId: expect.any(String), action: "deploy", env: "production" }]);
    expect(record.ownerReview).toMatchObject({ approvalsApproved: 1, proposalsAccepted: 4 }); // bricks, entity, workflow, identity
    expect(outcome(record, 6)).toBe("pass"); // production never deployed
    expectNothingLeft(fake, record);
  });

  test("the agent stops short of a deploy: the owner replies from the answers and the same session resumes; calls, turns and cost add up", { timeout: 120_000 }, async () => {
    const { fake, deps } = world();
    const answers = "# Owner answers\n\n## 1. Name\n\nOffline Fixture Name\n\n## 2. Pricing\n\nFree.\n";
    const result = (call: number) => ({ type: "result", subtype: "success", is_error: false, num_turns: call === 1 ? 5 : 9, total_cost_usd: call === 1 ? 0.5 : 0.75, duration_ms: 100, session_id: "sess-resume-1", result: call === 1 ? "I built the bricks and the entity.\nWhat name should the product use?" : "PREVIEW: done", modelUsage: { "claude-fake-model-20261126": {} } });
    const cli = fakeCli(async (agent) => {
      await build(agent);
    }, {
      result,
      resumed: async (agent, input) => {
        expect(input.resumeSessionId).toBe("sess-resume-1");
        expect(input.prompt).toContain("Offline Fixture Name");
        expect(input.prompt).toContain(GENERIC_OWNER_REPLY);
        expect(input.prompt).not.toContain("Free.");
        expect(input.maxBudgetUsd).toBe(9.5);
        expect(claudeArgs(input)).toEqual(expect.arrayContaining(["--resume", "sess-resume-1"]));
        const deployed = await deployPreview(agent);
        expect(deployed.isError, JSON.stringify(deployed.body)).toBe(false);
      },
    });
    const record = await runAgentBench(deps(cli, { brief: { id: "fixture", brief: FIXTURE_BRIEF, answers, briefSha256: "a".repeat(64), answersSha256: "b".repeat(64) } }));
    expect(record.incompleteReason).toBeNull();
    expect(record.deployed).toBe(true);
    // total_cost_usd is the session's running total on a resumed call (0.5, then 0.75): the second call cost 0.25, the run
    // 0.75. Turns and durations are per call and add up.
    expect(record.cli).toMatchObject({ agentCalls: 2, numTurns: 14, costUsd: 0.75, durationMs: 200 });
    expect(record.agentCalls.map((c) => [c.costUsdReported, c.costUsd])).toEqual([[0.5, 0.5], [0.75, 0.25]]);
    expect(record.agentCalls.map((c) => [c.prompt, c.resumed, c.reply])).toEqual([
      ["brief", false, null],
      ["owner-reply", true, { source: "answers", section: "1. Name" }],
    ]);
    expect(record.agentCalls[0]!.resultText).toBe("I built the bricks and the entity.\nWhat name should the product use?");
    expect(JSON.stringify(record)).not.toContain("Offline Fixture Name"); // the reply text itself is not recorded
    expectNothingLeft(fake, record);
  });

  test("the agent-call cap: an agent that never deploys gets the generic reply until --max-agent-calls is reached", { timeout: 120_000 }, async () => {
    const { fake, deps } = world();
    const cli = fakeCli(async (agent) => {
      await buildPlain(agent, { entity: true });
    }, { result: { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0.01, session_id: "sess-cap", result: "Done for now." } });
    const record = await runAgentBench(deps(cli, { maxAgentCalls: 3 }));
    expect(cli.inputs).toHaveLength(3);
    expect(cli.inputs.slice(1).every((i) => i.prompt === GENERIC_OWNER_REPLY && i.resumeSessionId === "sess-cap")).toBe(true);
    expect(record.limits.maxAgentCalls).toBe(3);
    expect(record.cli.agentCalls).toBe(3);
    expect(record.agentCalls[2]!.reply).toEqual({ source: "generic", section: null });
    expect(record.deployed).toBe(false);
    expectNothingLeft(fake, record);
  });

  test("story 1.19: core-auth needs no made-up value from the owner: BETTER_AUTH_SECRET is generated on the approved preview deploy and GitHub is optional", { timeout: 120_000 }, async () => {
    const { fake, deps } = world();
    let firstNeeds = "";
    let deployed: ToolAnswer | undefined;
    const cli = fakeCli(async (agent) => {
      const enabled = await agent.tool("apply_ops", { mode: "apply", ops: ["multi-workspace", "core-auth", "dynamic-entities"].map((brickId) => ({ opId: `enable-${brickId}`, type: "enable_brick", brickId, config: {} })) });
      expect(enabled.isError, JSON.stringify(enabled.body)).toBe(false);
      firstNeeds = JSON.stringify((await agent.tool("validate_blueprint", {})).body);
      const plan = await agent.tool("deploy_plan", { env: "preview" });
      expect(plan.body.willGenerateSecrets).toEqual(["BETTER_AUTH_SECRET"]);
      expect(plan.body.optionalSecretsNotConfigured).toEqual(["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]);
      deployed = await deployPreview(agent);
    });
    const hexes: string[] = [];
    const record = await runAgentBench(deps(cli, { maxAgentCalls: 2, randomHex: (n: number) => { const h = randomBytes(n).toString("hex"); hexes.push(h); return h; } }));
    expect(firstNeeds).toContain("BETTER_AUTH_SECRET");
    expect(firstNeeds).not.toContain("GITHUB_CLIENT"); // optional: never a readiness need
    expect(deployed?.isError, JSON.stringify(deployed?.body)).toBe(false);
    expect(record.deployed).toBe(true);
    expect(record.ownerReview.secretsBound).toEqual([]); // nothing made up by the owner: generated or optional
    expect(record.ownerReview.approvalsApproved).toBeGreaterThanOrEqual(1);
    const text = JSON.stringify(record);
    for (const h of hexes.filter((x) => x.length === 64)) expect(text).not.toContain(h);
    expectNothingLeft(fake, record);
  });

  test("story 1.19: bindUnboundSecrets binds only required secrets a person supplies, never generated or optional ones", async () => {
    const posted: Array<Record<string, unknown>> = [];
    const call: StudioCall = async (method, path, body) => {
      if (method === "GET") {
        return { status: 200, body: { readiness: { needs: [
          { code: "UNBOUND_BRICK_SECRET", path: "bricks.core-auth.secrets.BETTER_AUTH_SECRET" },
          { code: "UNBOUND_BRICK_SECRET", path: "bricks.core-auth.secrets.GITHUB_CLIENT_ID" },
          { code: "UNBOUND_BRICK_SECRET", path: "bricks.some-brick.secrets.THIRD_PARTY_KEY" },
        ] } } };
      }
      posted.push({ path, ...(body as Record<string, unknown>) });
      return { status: 200, body: {} };
    };
    const hide: Record<string, string> = {};
    const benchCatalog = { ...catalog, bricks: { ...catalog.bricks, "some-brick": { ...catalog.bricks["core-auth"]!, manifest: { ...catalog.bricks["core-auth"]!.manifest, id: "some-brick", secrets: ["THIRD_PARTY_KEY"] } } } };
    const res = await bindUnboundSecrets({ call, session: "s", orgId: "o", project: "p", randomHex: (n) => "ab".repeat(n), hideValues: hide, catalog: benchCatalog });
    expect(res).toEqual({
      bound: ["some-brick.THIRD_PARTY_KEY"],
      failed: [],
      needs: [
        { brickId: "core-auth", secretName: "BETTER_AUTH_SECRET", kind: "generated" },
        { brickId: "core-auth", secretName: "GITHUB_CLIENT_ID", kind: "optional" },
        { brickId: "some-brick", secretName: "THIRD_PARTY_KEY", kind: "owner" },
      ],
    });
    expect(posted.map((p) => (p.bindTarget as { secretName: string }).secretName)).toEqual(["THIRD_PARTY_KEY"]);
  });

  test("change a live app: the recorded app is stood up again, the agent adds the 5-credit debit and makes it live; the free-plan part is recorded unsupported", { timeout: 180_000 }, async () => {
    const first = world();
    const built = await runAgentBench(first.deps(fakeCli(async (agent) => {
      await build(agent);
      await deployPreview(agent);
    })));
    expect(built.status).toBe("complete");

    const { fake, deps } = world();
    const cli = fakeCli(async (agent, input) => {
      expect(input.prompt).toMatch(/charge 5 credits per run/);
      expect(input.prompt).toMatch(/free plan to 100 credits/);
      const changed = await agent.tool("apply_ops", { ops: [{ opId: "debit-5", type: "update_node", workflowId: "wf-report", nodeId: "debit", data: { amount: CHANGE_DEBIT_CREDITS } }] });
      expect(changed.isError, JSON.stringify(changed.body)).toBe(false);
      await waitFor(async () => (JSON.stringify((await agent.tool("get_blueprint_slice", { sections: ["workflows"], workflowId: "wf-report" })).body).includes(`"amount":${CHANGE_DEBIT_CREDITS}`) ? true : null), "the debit to be in the blueprint");
      const deployed = await deployPreview(agent);
      expect(deployed.isError, JSON.stringify(deployed.body)).toBe(false);
    }, { result: { type: "result", subtype: "success", is_error: false, num_turns: 7, total_cost_usd: 0.2, duration_ms: 99, result: "Done.\nUNSUPPORTED: free plan 100 credits: no plan-to-credits setting", modelUsage: { "claude-fake-model-20261126": {} } } });
    const record = await runAgentBench(deps(cli, { task: "change-live-app", fromRun: built, brief: { id: built.briefId, briefSha256: built.briefSha256 } }));
    expect(record.incompleteReason).toBeNull();
    expect(RunRecordSchema.parse(record)).toBeTruthy();
    expect(record.fromRunId).toBe(built.runId);
    expect(record.checks).toBeNull();
    expect(record.change!.parts[0]).toMatchObject({ part: `debit ${CHANGE_DEBIT_CREDITS} credits in the report workflow`, outcome: "done" });
    expect(record.change!.parts[1]).toEqual({ part: "free plan 100 credits", outcome: "unsupported", reason: FREE_PLAN_UNSUPPORTED_REASON });
    expect(record.change!.agentFlaggedUnsupported).toBe(true);
    // a graph-only change goes live without a redeploy
    expect(record.change!).toMatchObject({ hotApplies: 1, redeploys: 0 });
    expect(record.change!.timeToLiveMs).not.toBeNull();
    expectNothingLeft(fake, record);
  });
});

describe("the CLI's JSON result, read defensively", () => {
  test("every field it reports is taken as reported; a missing one is listed, never invented", () => {
    const full = parseCliResult(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 3, total_cost_usd: 1.5, duration_ms: 10, modelUsage: { "model-a": {}, "model-b": {} } }));
    expect(full).toMatchObject({ modelIds: ["model-a", "model-b"], modelIdSource: "modelUsage", costUsd: 1.5, numTurns: 3, missingFields: [] });
    const byModel = parseCliResult(`noise\n${JSON.stringify({ subtype: "success", model: "model-c" })}`);
    expect(byModel).toMatchObject({ modelIds: ["model-c"], modelIdSource: "model", costUsd: null, numTurns: null, missingFields: ["total_cost_usd", "num_turns", "duration_ms"] });
    expect(parseCliResult("not json").missingFields).toEqual(["json"]);
  });

  test("the kill rule: applicable lines first (>= 75%), the literal >= 9/12 beside it, explicit iterations, infra-incomplete runs left out", () => {
    const run = (runId: string, passes: number, applicable: number, extra: Partial<RunRecord> = {}) =>
      ({ runId, task: "brief", briefId: "a", iteration: 1, deployed: true, incompleteKind: null, incompleteReason: null, score: { passes, partials: 0, notApplicable: 12 - applicable, fails: applicable - passes, applicable }, ...extra }) as unknown as RunRecord;
    // 6 of 8 applicable is 75%: met on applicable lines, not met as written (6/12)
    expect(evaluateKillRule([run("r1", 6, 8)]).status).toEqual({ applicableLines: "met", literalAsWritten: "not-met" });
    expect(evaluateKillRule([run("r1", 9, 12)]).status).toEqual({ applicableLines: "met", literalAsWritten: "met" });
    expect(evaluateKillRule([run("r1", 5, 8)]).status).toEqual({ applicableLines: "not-met", literalAsWritten: "not-met" });
    // not deployed is never met
    expect(evaluateKillRule([run("r1", 8, 8, { deployed: false })]).status.applicableLines).toBe("not-met");
    // a re-run in the same iteration is not a second iteration, and nothing is derived from repeat counts
    const reruns = evaluateKillRule([run("r1", 5, 8), run("r2", 4, 8)]);
    expect(reruns).toMatchObject({ latestIteration: 1, status: { applicableLines: "not-met" } });
    expect(reruns.iterations).toHaveLength(1);
    expect(reruns.iterations[0]!.perBrief[0]).toMatchObject({ runId: "r1", runs: 2 });
    expect(JSON.stringify(reruns)).not.toContain("kill-condition");
    // iterations are the explicit numbers; an infra-incomplete run is no evidence and is listed
    const judged = evaluateKillRule([run("r1", 5, 8), run("r2", 8, 8, { iteration: 2, incompleteKind: "infra", incompleteReason: "the CLI failed: spawn ENOENT" }), run("r3", 7, 8, { iteration: 2, incompleteKind: "agent" })]);
    expect(judged.excludedRuns).toEqual([{ runId: "r2", briefId: "a", iteration: 2, reason: "the CLI failed: spawn ENOENT" }]);
    expect(judged.iterations.map((i) => i.iteration)).toEqual([1, 2]);
    expect(judged.iterations[1]!.perBrief[0]).toMatchObject({ runId: "r3", applicableLines: { passes: 7, of: 8, met: true } });
    expect(judged.latestIteration).toBe(2);
    expect(evaluateKillRule([]).status).toEqual({ applicableLines: "no-runs", literalAsWritten: "no-runs" });
  });

  test("samples fit the field's constraints: text cut to maxLength, numbers kept in [min, max], updates stay in range", () => {
    expect(sampleValue({ type: "text", maxLength: 3 }, "bench title")).toBe("ben");
    expect(updatedValue({ type: "text", maxLength: 3 }, "ben")).toBe("upd");
    expect(updatedValue({ type: "text", maxLength: 1 }, "u")).toBe("z");
    expect(sampleValue({ type: "text", maxLength: 0 }, "bench")).toBe("b");
    expect(sampleValue({ type: "number", max: 0 }, "")).toBe(0);
    expect(sampleValue({ type: "number", min: 5, max: 10 }, "")).toBe(5);
    expect(updatedValue({ type: "number", min: 1, max: 1 }, 1)).toBe(1);
    expect(updatedValue({ type: "number", max: 3 }, 3)).toBe(2);
    expect(updatedValue({ type: "number", min: 1, max: 10 }, 1)).toBe(2);
    // the OpenAPI spellings (line 12)
    expect(sampleValue({ type: "string", maxLength: 3 }, "second agent title")).toBe("sec");
    expect(sampleValue({ type: "integer", minimum: 2, maximum: 4 }, "")).toBe(2);
    expect(sampleValue({ type: "integer", maximum: 0 }, "")).toBe(0);
  });

  test("the Claude binary on Windows: claude.exe on the PATH, else the native binary beside the npm shim, else the shim", () => {
    const env = { PATH: "C:\\a;C:\\npm" };
    expect(defaultClaudeBin(env, "linux", () => false)).toBe("claude");
    expect(defaultClaudeBin(env, "win32", (p) => p === join("C:\\a", "claude.exe"))).toBe(join("C:\\a", "claude.exe"));
    const native = join("C:\\npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    expect(defaultClaudeBin(env, "win32", (p) => p === join("C:\\npm", "claude.cmd") || p === native)).toBe(native);
    expect(defaultClaudeBin(env, "win32", (p) => p === join("C:\\npm", "claude.cmd"))).toBe(join("C:\\npm", "claude.cmd"));
    expect(() => defaultClaudeBin(env, "win32", () => false)).toThrow(/--claude-bin/);
  });

  test("a private path inside the repository must be git-ignored, and never at the top level of evidence/", () => {
    const root = resolve("/repo");
    expect(privatePathRefusal(join(root, "evidence", "benchmark-v0.json"), root, () => true)).toMatch(/top level of evidence/);
    expect(privatePathRefusal(join(root, "private", "benchmark-v0.json"), root, () => false)).toMatch(/not git-ignored/);
    expect(privatePathRefusal(join(root, "private", "benchmark-v0.json"), root, () => true)).toBeNull();
    expect(privatePathRefusal(resolve("/elsewhere/benchmark-v0.json"), root, () => false)).toBeNull();
  });

  test("cumulative session costs: the budget left for each call and the run total use the true total", { timeout: 120_000 }, async () => {
    const { fake, deps } = world();
    const cumulative = [0.2249302, 0.2554368, 0.2720183, 0.348736];
    // each call makes a new revision, so the owner's identical replies never trip the stop rule
    const progress = (agent: Agent, call: number) => agent.tool("apply_ops", { mode: "apply", ops: [{ opId: `meta-${call}`, type: "set_metadata", metadata: { description: `call ${call}` } }] }).then(() => {});
    const cli = fakeCli((agent) => progress(agent, 1), { resumed: (agent, _input, call) => progress(agent, call), result: (call) => ({ type: "result", subtype: "success", is_error: false, num_turns: [32, 4, 2, 2][call - 1], total_cost_usd: cumulative[call - 1], duration_ms: 1000, session_id: "sess-cum", result: "Still working." }) });
    const record = await runAgentBench(deps(cli, { maxAgentCalls: 4 }));
    expect(record.cli.costUsd).toBeCloseTo(0.348736, 9);
    expect(record.cli.numTurns).toBe(40);
    expect(record.agentCalls.map((c) => c.costUsdReported)).toEqual(cumulative);
    const owns = record.agentCalls.map((c) => c.costUsd!);
    for (const [i, own] of owns.entries()) expect(own).toBeCloseTo(i === 0 ? cumulative[0]! : cumulative[i]! - cumulative[i - 1]!, 9);
    // each call's budget is the cap minus the true total so far
    expect(cli.inputs.map((i) => i.maxBudgetUsd)).toEqual([10, 9.7751, 9.7446, 9.728]);
    expect(record.costNote).toBeUndefined();
    expectNothingLeft(fake, record);
  });

  test("--repair-costs: summed cumulative totals in recorded runs are corrected from the per-call reports, marked, nothing else changed", () => {
    const dir = mkdtempSync(join(tmpdir(), "repair-"));
    roots.push(dir);
    const reported = [0.2249302, 0.2554368, 0.2720183, 0.348736];
    const call = (n: number, raw: number) => ({ call: n, prompt: n === 1 ? "brief" : "owner-reply", reply: n === 1 ? null : { source: "generic", section: null }, resumed: n > 1, exitCode: 0, timedOut: false, subtype: "success", isError: false, costUsd: raw, numTurns: 2, durationMs: 10, wallTimeMs: 20, modelIds: ["m"], maxBudgetUsd: 10, resultText: "x", secretsBoundAfter: [] });
    const base = {
      runId: "brief-x-1", task: "brief", briefId: "x", briefSha256: "a".repeat(64), answersSha256: null, fromRunId: null, startedAt: "s", finishedAt: "f", status: "complete", incompleteReason: null, incompleteKind: null, iteration: 1,
      cli: { version: null, exitCode: 0, timedOut: false, subtype: "success", isError: false, modelIds: ["m"], modelIdSource: "modelUsage", requestedModel: null, costUsd: reported.reduce((x, y) => x + y, 0), costLabel: "client-estimated", numTurns: 8, durationMs: 40, missingFields: [], agentCalls: 4 },
      agentCalls: reported.map((raw, i) => call(i + 1, raw)),
      limits: { maxBudgetUsd: 10, wallTimeCapMs: 1, maxAgentCalls: 8 }, wallTimeMs: 1, agentWallTimeMs: 1,
      ownerReview: { count: 0, proposalsAccepted: 0, proposalsRejected: 0, approvalsApproved: 0, refused: 0, secretsBound: [], rejectedNotPreview: [], waitMs: 0 },
      ownerActions: [],
      project: "p", previewUrl: null, deployed: false, deployRefusal: null, checks: null, score: null, change: null, blueprint: null, teardown: null,
    };
    const single = { ...base, runId: "brief-y-1", briefId: "y", cli: { ...base.cli, costUsd: 0.2, agentCalls: 1 }, agentCalls: [call(1, 0.2)] };
    mkdirSync(join(dir, "runs"));
    writeFileSync(join(dir, "runs", "brief-x-1.json"), JSON.stringify(base));
    writeFileSync(join(dir, "runs", "brief-y-1.json"), JSON.stringify(single));
    const out = join(dir, "benchmark-v0.json");
    writeFileSync(out, JSON.stringify({ benchmark: "real-model-benchmark-v0", internal: true, note: "n", runs: [base, single], killRule: {} }));
    const repaired = repairCostsInFolder(out);
    expect(repaired.map((r) => [r.where, r.runId, Number(r.before!.toFixed(7)), Number(r.after!.toFixed(7))])).toEqual([
      ["runs/brief-x-1.json", "brief-x-1", 1.1011213, 0.348736],
      ["benchmark-v0.json", "brief-x-1", 1.1011213, 0.348736],
    ]);
    const fixed = RunRecordSchema.parse(JSON.parse(readFileSync(join(dir, "runs", "brief-x-1.json"), "utf8")));
    expect(fixed.costNote).toBe(COST_NOTE);
    expect(fixed.agentCalls.map((c) => c.costUsdReported)).toEqual(reported);
    expect(fixed.cli.costUsd).toBeCloseTo(0.348736, 9);
    expect({ ...fixed, cli: { ...fixed.cli, costUsd: 0 }, agentCalls: [], costNote: undefined, schemaNote: undefined }).toEqual({ ...base, cli: { ...base.cli, costUsd: 0 }, agentCalls: [], costNote: undefined, schemaNote: undefined });
    expect(JSON.parse(readFileSync(join(dir, "runs", "brief-y-1.json"), "utf8")).costNote).toBeUndefined();
    const file = BenchmarkFileSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(file.runs.map((r) => [r.runId, r.costNote ?? null])).toEqual([["brief-x-1", COST_NOTE], ["brief-y-1", null]]);
    // running it again changes nothing
    expect(repairCostsInFolder(out)).toEqual([]);
  });

  test("teardown-only with no ledger is refused as a LiveProofRefusal, as before the refactor", async () => {
    await expect(runTeardownOnly({ credentials: { token: TOKEN, accountId: ACCOUNT }, cloudflareFetch: async () => new Response("{}"), ledgerStore: memoryStore() })).rejects.toThrow(LiveProofRefusal);
  });

  test("the owner's reply: the answer whose heading a question names, then the generic line; otherwise the generic line", () => {
    const answers = "# Owner answers\n\n## 1. Name\n\nShelf\n\n## 11. Entities\n\nbooks, with a title\n";
    expect(ownerReply(answers, "Which entities do you want?")).toEqual({ text: `books, with a title\n\n${GENERIC_OWNER_REPLY}`, source: "answers", section: "11. Entities" });
    // only a sentence that asks counts: naming a heading elsewhere is not a question about it
    expect(ownerReply(answers, "I enabled the entities brick. Shall I continue?")).toMatchObject({ source: "generic" });
    expect(ownerReply(answers, "Done. The entities are in place.")).toEqual({ text: GENERIC_OWNER_REPLY, source: "generic", section: null });
    expect(ownerReply(undefined, "What name?")).toEqual({ text: GENERIC_OWNER_REPLY, source: "generic", section: null });
  });

  test("Claude Code keeps a folder's sessions under its own config dir, keyed by the folder path", () => {
    expect(claudeSessionDir("/tmp/px-bench-ab12/cwd", { CLAUDE_CONFIG_DIR: "/cfg" })).toBe(join("/cfg", "projects", resolve("/tmp/px-bench-ab12/cwd").replace(/[^a-zA-Z0-9]/g, "-")));
  });

  test("a brief is read from its folder at run time and recorded by hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "briefs-"));
    roots.push(dir);
    mkdirSync(join(dir, "fixture"));
    writeFileSync(join(dir, "fixture", "brief.md"), FIXTURE_BRIEF);
    writeFileSync(join(dir, "fixture", "answers.md"), FIXTURE_ANSWERS);
    const brief = loadBrief(dir, "fixture");
    expect(brief.briefSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(brief.brief).toBe(FIXTURE_BRIEF);
    expect(() => loadBrief(dir, "../escape")).toThrow(/slug/);
    expect(() => loadBrief(dir, "missing")).toThrow(/no brief/);
  });
});

describe("story 1.22: the scripted owner behaves like a person", () => {
  /** A review file for the offline fixture (no brief text): the fixture's bricks and its one entity. */
  const REVIEW: ReviewFile = { bricks: BRICKS, entities: ["book*"], allowOps: ["set_metadata"], decisions: [] };

  test("an on-brief proposal is accepted; a stray probe on a brick outside the brief is rejected with a reason naming the op, and the record shows it", { timeout: 120_000 }, async () => {
    const { fake, deps, lines } = world();
    let probe: ToolAnswer | null = null;
    const cli = fakeCli(async (agent) => {
      probe = await agent.tool("apply_ops", { ops: [{ opId: "probe-chat", type: "enable_brick", brickId: "live-chat", config: {} }] });
      await build(agent);
      const deployed = await deployPreview(agent);
      expect(deployed.isError, JSON.stringify(deployed.body)).toBe(false);
    });
    const record = await runAgentBench(deps(cli, { brief: { id: "fixture", brief: FIXTURE_BRIEF, answers: FIXTURE_ANSWERS, briefSha256: "a".repeat(64), answersSha256: "b".repeat(64), review: REVIEW } }));
    expect(record.incompleteReason, lines.join("\n")).toBeNull();
    expect(probe!.body.status).toBe("pending");
    expect(record.ownerReview).toMatchObject({ proposalsAccepted: 3, proposalsRejected: 1, approvalsApproved: 1, count: 5, refused: 0 });
    const rejects = record.ownerActions.filter((a) => a.kind === "reject");
    expect(rejects).toHaveLength(1);
    expect(rejects[0]!.detail).toMatch(/op "probe-chat" \(enable_brick\) touches brick "live-chat", which the brief does not need/);
    expect(record.ownerActions.filter((a) => a.kind === "accept")).toHaveLength(3);
    expect(record.ownerActions.some((a) => a.kind === "accept-unreviewed")).toBe(false);
    // the probe never reached the blueprint, and the build log still adds up with the reject in it
    expect(JSON.stringify(record.blueprint)).not.toContain("live-chat");
    expect(outcome(record, 7)).toBe("pass");
    expect(record.checks!.find((c) => c.line === 7)!.evidence).toMatch(/1 reject row\(s\) for 1 rejected proposal\(s\)/);
    expectNothingLeft(fake, record);
  });

  test("the review: listed bricks and entities (prefix match), node types by their brick, allowOps anywhere, the first op outside the brief named", () => {
    expect(reviewProposal(REVIEW, [{ opId: "a", type: "enable_brick", brickId: "credit-wallet" }, { opId: "b", type: "add_entity", entity: { name: "books_archive", fields: [] } }])).toEqual({ accept: true });
    expect(reviewProposal(REVIEW, [{ opId: "m", type: "set_metadata", metadata: {} }])).toEqual({ accept: true });
    expect(reviewProposal(REVIEW, [{ opId: "w", type: "add_workflow", workflow: { id: "w", name: "w", nodes: [{ id: "t", type: "trigger.manual" }, { id: "d", type: "credit-wallet.debit" }] } }])).toEqual({ accept: true });
    expect(reviewProposal(REVIEW, [{ opId: "ok", type: "enable_brick", brickId: "multi-workspace" }, { opId: "stray", type: "add_entity", entity: { name: "tickets", fields: [] } }])).toEqual({ accept: false, reason: 'op "stray" (add_entity) touches entity "tickets", which the brief does not need' });
    expect(reviewProposal(REVIEW, [{ opId: "n", type: "add_node", workflowId: "w", node: { id: "x", type: "live-chat.post" } }])).toMatchObject({ accept: false, reason: expect.stringContaining('brick "live-chat"') });
    expect(reviewProposal(REVIEW, [{ opId: "i", type: "set_identity", identity: "stub" }])).toEqual({ accept: true });
    expect(reviewProposal({ ...REVIEW, allowOps: ["enable_brick"] }, [{ opId: "any", type: "enable_brick", brickId: "live-chat" }])).toEqual({ accept: true });
  });

  test("a reject the route refuses is counted and tried again on the next poll", async () => {
    let rejectCalls = 0;
    let rejected = false;
    const bodies: unknown[] = [];
    const call: StudioCall = async (method, path, body) => {
      if (method === "GET" && path.includes("/proposals")) return { status: 200, body: { proposals: rejected ? [] : [{ proposalId: "prop_1", status: "pending", createdAt: new Date().toISOString(), ops: [{ opId: "probe", type: "enable_brick", brickId: "live-chat" }] }] } };
      if (method === "GET") return { status: 200, body: { approvals: [] } };
      if (path.endsWith("/reject")) {
        rejectCalls += 1;
        bodies.push(body);
        if (rejectCalls === 1) return { status: 500, body: {} };
        rejected = true;
        return { status: 200, body: {} };
      }
      return { status: 404, body: {} };
    };
    const actions: Array<[string, string]> = [];
    const owner = startOwnerLoop({ call, session: "s", orgId: "o", project: "p", intervalMs: 1, now: () => Date.now(), review: REVIEW, act: (kind, detail) => actions.push([kind, detail]) });
    await waitFor(async () => (rejected ? true : null), "the second reject");
    const stats = await owner.stop();
    expect(stats).toMatchObject({ refused: 1, proposalsRejected: 1, proposalsAccepted: 0 });
    // the refused click is in the record, then the reject that went through
    expect(actions).toEqual([
      ["reject-failed", "HTTP 500: proposal prop_1"],
      ["reject", expect.stringMatching(/^proposal prop_1: op "probe" \(enable_brick\) touches brick "live-chat"/)],
    ]);
    expect(bodies[1]).toEqual({ reason: expect.stringContaining("live-chat") });
  });

  test("a named owner-supplied secret: the owner binds it once and replies naming it; the same blocked text again stops the run after two identical replies (owner-stalled), scored and torn down", { timeout: 120_000 }, async () => {
    const { fake, deps } = world();
    const blocked = "I cannot deploy yet.\nblocked: MISSING_REQUIRED_SECRETS: PX_CONN_KEY";
    const cli = fakeCli(async (agent) => {
      const enabled = await agent.tool("apply_ops", { mode: "apply", ops: ["multi-workspace", "integration-connections"].map((brickId) => ({ opId: `enable-${brickId}`, type: "enable_brick", brickId, config: {} })) });
      expect(enabled.isError, JSON.stringify(enabled.body)).toBe(false);
    }, { result: { type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0.01, session_id: "sess-blocked", result: blocked } });
    const hexes: string[] = [];
    const record = await runAgentBench(deps(cli, { randomHex: (n: number) => { const h = randomBytes(n).toString("hex"); hexes.push(h); return h; } }));
    // the first call, then two identical owner replies; a third was not sent
    expect(cli.inputs).toHaveLength(1 + MAX_IDENTICAL_BLOCKED_REPLIES);
    for (const input of cli.inputs.slice(1)) {
      expect(input.prompt).toContain("I added PX_CONN_KEY in Studio.");
      expect(input.prompt).toContain(GENERIC_OWNER_REPLY);
    }
    expect(record.ownerReview.secretsBound).toEqual(["integration-connections.PX_CONN_KEY"]);
    expect(record.ownerActions.map((a) => a.kind)).toEqual(["bind-secret", "reply", "reply", "stop"]);
    expect(record.ownerActions[0]!.detail).toBe("integration-connections.PX_CONN_KEY");
    expect(record.ownerActions[1]!.detail).toBe("secret: PX_CONN_KEY");
    expect(record.agentCalls.slice(1).map((c) => c.reply)).toEqual([{ source: "secret", section: "PX_CONN_KEY" }, { source: "secret", section: "PX_CONN_KEY" }]);
    expect(record.status).toBe("incomplete");
    expect(record.incompleteKind).toBe("owner-stalled");
    expect(record.incompleteReason).toMatch(/owner stalled: the agent stayed blocked .* through 2 identical owner replies/);
    expect(record.checks).toHaveLength(12);
    expect(record.score).not.toBeNull();
    const text = JSON.stringify(record);
    for (const h of hexes.filter((x) => x.length === 64)) expect(text).not.toContain(h);
    expectNothingLeft(fake, record);
  });

  test("a refused approval: the owner records approve-failed, and its reply says Studio refused instead of claiming it approved", async () => {
    let approveCalls = 0;
    const call: StudioCall = async (method, path) => {
      if (method === "GET" && path.includes("/proposals")) return { status: 200, body: { proposals: [] } };
      if (method === "GET") return { status: 200, body: { approvals: approveCalls > 0 ? [] : [{ approvalId: "apr_9", status: "pending", action: "deploy", env: "preview", createdAt: new Date().toISOString() }] } };
      if (path.endsWith("/approve")) {
        approveCalls += 1;
        return { status: 503, body: {} };
      }
      return { status: 404, body: {} };
    };
    const actions: Array<[string, string]> = [];
    const owner = startOwnerLoop({ call, session: "s", orgId: "o", project: "p", intervalMs: 1, now: () => Date.now(), act: (kind, detail) => actions.push([kind, detail]) });
    await owner.passNow();
    const stats = await owner.stop();
    expect(stats).toMatchObject({ refused: 1, approvalsApproved: 0 });
    expect(actions).toEqual([["approve-failed", "HTTP 503: approval apr_9"]]);
    expect(owner.approvalLog).toEqual([{ approvalId: "apr_9", action: "deploy", env: "preview", outcome: "refused", status: 503 }]);
    const r = ownerReply(undefined, "deploy_apply answered APPROVAL_REQUIRED (apr_9).", { approvals: owner.approvalLog });
    expect(r).toMatchObject({ source: "approval", section: "refused" });
    expect(r.text).toMatch(/^I tried to approve apr_9, but Studio refused \(HTTP 503\)/);
    expect(r.text).not.toMatch(/I approved/);
  });

  test("an op kind the owner does not know is outside the brief; a review naming an unknown brick is refused", () => {
    expect(reviewProposal(REVIEW, [{ opId: "x", type: "rewrite_everything" }])).toEqual({ accept: false, reason: 'op "x" (rewrite_everything) is not an op kind the owner knows, so it is outside the brief' });
    const dir = mkdtempSync(join(tmpdir(), "review-"));
    roots.push(dir);
    writeFileSync(join(dir, "review.json"), JSON.stringify({ bricks: ["multi-workspace", "credit-walet"], entities: [] }));
    expect(() => loadReview(dir)).toThrow(BenchRefusal);
    expect(() => loadReview(dir)).toThrow(/brick\(s\) not in the catalog: "credit-walet"/);
  });

  test("a secret's standing is judged per need: added only when every brick needing the name got it; generated or optional from that brick's own declaration", () => {
    const both = [{ brickId: "integration-connections", secretName: "PX_CONN_KEY", kind: "owner" as const }, { brickId: "webhook-gateway", secretName: "PX_CONN_KEY", kind: "owner" as const }];
    expect(secretStatusFor("PX_CONN_KEY", { needs: both, boundNow: ["integration-connections.PX_CONN_KEY", "webhook-gateway.PX_CONN_KEY"], failedNow: [], boundBefore: [] })).toBe("bound");
    expect(secretStatusFor("PX_CONN_KEY", { needs: both, boundNow: ["integration-connections.PX_CONN_KEY"], failedNow: ["webhook-gateway.PX_CONN_KEY"], boundBefore: [] })).toBe("failed");
    // bound for one brick earlier does not make it bound for another brick that needs it now
    expect(secretStatusFor("PX_CONN_KEY", { needs: [both[1]!], boundNow: [], failedNow: [], boundBefore: ["integration-connections.PX_CONN_KEY"] })).toBe("unknown");
    expect(secretStatusFor("PX_CONN_KEY", { needs: [], boundNow: [], failedNow: [], boundBefore: ["integration-connections.PX_CONN_KEY"] })).toBe("bound");
    expect(secretStatusFor("BETTER_AUTH_SECRET", { needs: [{ brickId: "core-auth", secretName: "BETTER_AUTH_SECRET", kind: "generated" }], boundNow: [], failedNow: [], boundBefore: [] })).toBe("generated");
    // with no need, the passed catalog's declarations decide
    const generatedOnly = { ...catalog, bricks: { x: { ...catalog.bricks["core-auth"]!, manifest: { ...catalog.bricks["core-auth"]!.manifest, secrets: [{ name: "X_KEY", generate: "random-32-bytes" }] } } } } as never;
    expect(secretStatusFor("X_KEY", { needs: [], boundNow: [], failedNow: [], boundBefore: [], catalog: generatedOnly })).toBe("generated");
    expect(secretStatusFor("GITHUB_CLIENT_ID", { needs: [], boundNow: [], failedNow: [], boundBefore: [] })).toBe("optional");
  });

  test("the stop rule counts only the agent's progress: revisions made by the owner's session do not count", () => {
    const before = agentProgress([{ revision: 2, author: { type: "agent" } }, { revision: 1, author: { type: "agent" } }], null);
    const afterOwnerBind = agentProgress([{ revision: 3, author: { type: "human" } }, { revision: 2, author: { type: "agent" } }, { revision: 1, author: { type: "agent" } }], null);
    expect(afterOwnerBind).toBe(before);
    expect(agentProgress([{ revision: 4, author: { type: "agent" } }, { revision: 3, author: { type: "human" } }], null)).not.toBe(before);
    expect(agentProgress([{ revision: 2, author: { type: "agent" } }], 2)).not.toBe(before);
  });

  test("an owner-only change between two identical replies does not reset the count: the run still stops after two", { timeout: 120_000 }, async () => {
    const { fake, deps } = world();
    const cli = fakeCli(async (agent) => {
      await buildPlain(agent, { entity: true });
    }, { result: { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0.01, session_id: "sess-owner-change", result: "Waiting." } });
    const ownerChanges: number[] = [];
    const record = await runAgentBench(deps(cli, {
      // after the first identical reply, the owner (its own session) makes a revision of its own
      ownerStep: async ({ call, session, orgId, project, call_ }) => {
        if (call_ !== 2) return;
        const res = await call("POST", `/api/projects/${project}/ops`, { ops: [{ opId: "owner-note", type: "set_metadata", metadata: { description: "owner note" } }] }, session, orgId);
        ownerChanges.push(res.status);
      },
    }));
    expect(ownerChanges).toEqual([200]);
    expect(cli.inputs).toHaveLength(1 + MAX_IDENTICAL_BLOCKED_REPLIES);
    expect(record.incompleteKind).toBe("owner-stalled");
    expect(record.ownerActions.map((a) => a.kind)).toEqual(["reply", "reply", "stop"]);
    expectNothingLeft(fake, record);
  });

  test("a question matching a review decision: the next prompt carries the decision's reply", { timeout: 120_000 }, async () => {
    const { fake, deps } = world();
    const review: ReviewFile = { ...REVIEW, decisions: [{ match: "drop login", reply: "No: keep sign-in; use email and password" }] };
    const cli = fakeCli(async (agent) => {
      await buildPlain(agent, { entity: true });
    }, {
      result: (call) => ({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0.01 * call, session_id: "sess-decision", result: call === 1 ? "The entity is in. Should I drop login to keep the preview simple?" : "PREVIEW: done" }),
      resumed: async (agent, input) => {
        expect(input.prompt).toBe(`No: keep sign-in; use email and password\n\n${GENERIC_OWNER_REPLY}`);
        const deployed = await deployPreview(agent);
        expect(deployed.isError, JSON.stringify(deployed.body)).toBe(false);
      },
    });
    const record = await runAgentBench(deps(cli, { brief: { id: "fixture", brief: FIXTURE_BRIEF, answers: FIXTURE_ANSWERS, briefSha256: "a".repeat(64), answersSha256: "b".repeat(64), review } }));
    expect(cli.inputs).toHaveLength(2);
    expect(record.deployed).toBe(true);
    expect(record.agentCalls[1]!.reply).toEqual({ source: "decision", section: "decision 1" });
    expect(record.ownerActions.filter((a) => a.kind === "reply").map((a) => a.detail)).toEqual(["decision: decision 1"]);
    expect(JSON.stringify(record)).not.toContain("keep sign-in"); // the decision's text stays private
    expectNothingLeft(fake, record);
  });

  test("a named generated secret: nothing is made up; the reply explains Studio generates it on the approved preview deploy", { timeout: 120_000 }, async () => {
    const { fake, deps } = world();
    const cli = fakeCli(async (agent) => {
      const enabled = await agent.tool("apply_ops", { mode: "apply", ops: ["multi-workspace", "core-auth", "dynamic-entities"].map((brickId) => ({ opId: `enable-${brickId}`, type: "enable_brick", brickId, config: {} })) });
      expect(enabled.isError, JSON.stringify(enabled.body)).toBe(false);
    }, {
      result: (call) => ({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0.01 * call, session_id: "sess-generated", result: call === 1 ? "blocked: UNBOUND_BRICK_SECRET: BETTER_AUTH_SECRET" : "PREVIEW: done" }),
      resumed: async (agent, input) => {
        expect(input.prompt).toMatch(/^BETTER_AUTH_SECRET is generated by Studio when I approve the preview deploy/);
        const deployed = await deployPreview(agent);
        expect(deployed.isError, JSON.stringify(deployed.body)).toBe(false);
      },
    });
    const record = await runAgentBench(deps(cli));
    expect(cli.inputs).toHaveLength(2);
    expect(record.deployed).toBe(true);
    expect(record.ownerReview.secretsBound).toEqual([]);
    expect(record.ownerActions.some((a) => a.kind === "bind-secret")).toBe(false);
    expect(record.agentCalls[1]!.reply).toEqual({ source: "secret", section: "BETTER_AUTH_SECRET" });
    expectNothingLeft(fake, record);
  });

  test("an owner-stalled run is evidence about the model: the kill rule keeps it", () => {
    const run = { runId: "r1", task: "brief", briefId: "a", iteration: 1, deployed: false, incompleteKind: "owner-stalled", incompleteReason: "owner stalled", score: { passes: 2, partials: 0, notApplicable: 4, fails: 6, applicable: 8 } } as unknown as RunRecord;
    const judged = evaluateKillRule([run]);
    expect(judged.excludedRuns).toEqual([]);
    expect(judged.iterations[0]!.perBrief[0]).toMatchObject({ runId: "r1" });
  });

  test("the reply order: a named secret, then an approval, then a review decision, then the answers, then the generic line", () => {
    const answers = "# Owner answers\n\n## 1. Login\n\nEmail.\n";
    const decisions = [{ match: "drop login", reply: "No: keep sign-in; use email and password" }, { match: "/delete (all|every) (rows|records)/", reply: "No." }];
    const status = (name: string) => (name === "FOO_KEY" ? "bound" : name === "BETTER_AUTH_SECRET" ? "generated" : name === "GITHUB_CLIENT_ID" ? "optional" : "unknown") as never;
    const ctx = { decisions, secretStatus: status };
    expect(ownerReply(answers, "blocked: MISSING_REQUIRED_SECRETS: FOO_KEY", ctx)).toEqual({ text: `I added FOO_KEY in Studio.\n\n${GENERIC_OWNER_REPLY}`, source: "secret", section: "FOO_KEY" });
    const generated = ownerReply(answers, "UNBOUND_BRICK_SECRET bricks.core-auth.secrets.BETTER_AUTH_SECRET, also APPROVAL_REQUIRED. Should I drop login?", ctx);
    expect(generated.source).toBe("secret");
    expect(generated.text).toMatch(/^BETTER_AUTH_SECRET is generated by Studio when I approve the preview deploy/);
    expect(ownerReply(answers, "UNBOUND_BRICK_SECRET: GITHUB_CLIENT_ID", ctx).text).toMatch(/^GITHUB_CLIENT_ID is optional: leave it unset\./);
    const approved = [{ approvalId: "apr_1", action: "deploy", env: "preview", outcome: "approved" as const, status: 200 }];
    expect(ownerReply(answers, "deploy_apply answered APPROVAL_PENDING. Should I drop login?", { ...ctx, approvals: approved })).toMatchObject({ source: "approval", section: "approved", text: expect.stringMatching(/^I approved the preview deploy in Studio \(apr_1\)/) });
    // the reply says what the owner did: a production approval was declined, a refused one is said so, none pending is said so
    const declined = [{ approvalId: "apr_2", action: "deploy", env: "production", outcome: "rejected-not-preview" as const, status: 200 }];
    expect(ownerReply(answers, "APPROVAL_REQUIRED", { approvals: declined })).toMatchObject({ section: "not-preview", text: expect.stringMatching(/^I did not approve apr_2: it is a deploy on production, and this app deploys to preview only/) });
    expect(ownerReply(answers, "APPROVAL_REQUIRED", { approvals: [] })).toMatchObject({ section: "none", text: expect.stringMatching(/^I found no deploy approval waiting for me/) });
    expect(ownerReply(answers, "Should I drop login to keep it simple?", ctx)).toEqual({ text: `No: keep sign-in; use email and password\n\n${GENERIC_OWNER_REPLY}`, source: "decision", section: "decision 1" });
    expect(ownerReply(answers, "Shall I Delete all records first?", ctx)).toMatchObject({ source: "decision", section: "decision 2" });
    expect(ownerReply(answers, "Which login do you want?", ctx)).toMatchObject({ source: "answers", section: "1. Login" });
    expect(ownerReply(answers, "Done for now.", ctx)).toEqual({ text: GENERIC_OWNER_REPLY, source: "generic", section: null });
    // a code without a name falls through
    expect(ownerReply(answers, "MISSING_REQUIRED_SECRETS", ctx).source).toBe("generic");
    expect(namedSecrets("MISSING_REQUIRED_SECRETS: FOO_KEY, BAR_TOKEN and APPROVAL_REQUIRED\nOTHER_THING")).toEqual(["FOO_KEY", "BAR_TOKEN"]);
  });

  test("the review file: loaded and validated beside the brief; none means unreviewed; a bad one is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "briefs-"));
    roots.push(dir);
    for (const id of ["with-review", "no-review", "bad-op", "bad-regex"]) {
      mkdirSync(join(dir, id));
      writeFileSync(join(dir, id, "brief.md"), FIXTURE_BRIEF);
      writeFileSync(join(dir, id, "answers.md"), FIXTURE_ANSWERS);
    }
    writeFileSync(join(dir, "with-review", "review.json"), JSON.stringify({ bricks: BRICKS, entities: ["book*"], decisions: [{ match: "/drop (the )?login/", reply: "No." }] }));
    writeFileSync(join(dir, "bad-op", "review.json"), JSON.stringify({ bricks: [], entities: [], allowOps: ["drop_everything"] }));
    writeFileSync(join(dir, "bad-regex", "review.json"), JSON.stringify({ bricks: [], entities: [], decisions: [{ match: "/([/", reply: "x" }] }));
    expect(loadBrief(dir, "with-review").review).toEqual({ bricks: BRICKS, entities: ["book*"], decisions: [{ match: "/drop (the )?login/", reply: "No." }] });
    expect(loadBrief(dir, "no-review").review).toBeNull();
    expect(() => loadBrief(dir, "bad-op")).toThrow(BenchRefusal);
    expect(() => loadBrief(dir, "bad-op")).toThrow(/allowOps/);
    expect(() => loadBrief(dir, "bad-regex")).toThrow(/not a valid regular expression/);
  });

  test("an older record without ownerActions is upgraded on load, and says so", () => {
    const raw = { runId: "r", agentCalls: [], cli: { agentCalls: 1 }, limits: { maxAgentCalls: 8 }, ownerReview: { proposalsAccepted: 2, secretsBound: [] } };
    expect(upgradeRunRecord(raw)).toMatchObject({ ownerActions: [], ownerReview: { proposalsAccepted: 2, proposalsRejected: 0 }, schemaNote: UPGRADED_PRE_OWNER_ACTIONS });
  });

  test("the default brief set is our own three; change-live-app targets one of them, its latest deployed run by default", () => {
    expect(DEFAULT_BRIEF_IDS).toHaveLength(3);
    expect(new Set(DEFAULT_BRIEF_IDS).size).toBe(3);
    expect(DEFAULT_BRIEF_IDS).toContain(CHANGE_LIVE_APP_BRIEF);
    const run = (runId: string, briefId: string, startedAt: string, deployed: boolean, blueprint: unknown = {}) => ({ runId, task: "brief", briefId, startedAt, deployed, blueprint }) as unknown as RunRecord;
    const runs = [run("a", CHANGE_LIVE_APP_BRIEF, "2026-11-27T01:00:00Z", true), run("b", CHANGE_LIVE_APP_BRIEF, "2026-11-27T03:00:00Z", false), run("c", CHANGE_LIVE_APP_BRIEF, "2026-11-27T02:00:00Z", true), run("d", "other", "2026-11-27T04:00:00Z", true), run("e", CHANGE_LIVE_APP_BRIEF, "2026-11-27T05:00:00Z", true, null)];
    expect(latestDeployedRun(runs, CHANGE_LIVE_APP_BRIEF)?.runId).toBe("c");
    expect(latestDeployedRun([], CHANGE_LIVE_APP_BRIEF)).toBeUndefined();
  });
});

describe("briefs and results stay private", () => {
  const repo = resolve(import.meta.dirname, "..", "..");
  const privateDir = join(repo, "_bmad-output", "initiative-projectx-roadmap");
  const gitGrep = (needle: string) =>
    spawnSync("git", ["grep", "-I", "-l", "-i", "-F", "--untracked", "--exclude-standard", "-e", needle], { cwd: repo, encoding: "utf8" });

  test("nothing under the private roadmap folder is tracked", () => {
    const tracked = spawnSync("git", ["ls-files", "--", "_bmad-output/initiative-projectx-roadmap"], { cwd: repo, encoding: "utf8" });
    expect(tracked.status).toBe(0);
    expect(tracked.stdout.trim()).toBe("");
  });

  test("no tracked or to-be-committed file holds the source project's name or a brief's distinctive text", () => {
    // Read from the private folder at test time, so this test itself names nothing. Without the private folder (a public
    // clone) there is nothing to compare against.
    const needles: string[] = [];
    const digests = join(privateDir, "research-competitors", "digests");
    if (existsSync(digests)) for (const f of readdirSync(digests)) if (/^web-[a-z0-9-]+\.md$/.test(f)) needles.push(f.slice(4, -3));
    const briefs = join(privateDir, "benchmark", "briefs");
    if (existsSync(briefs)) {
      for (const id of readdirSync(briefs)) {
        for (const name of ["brief.md", "answers.md", "review.json"]) {
          const path = join(briefs, id, name);
          if (!existsSync(path)) continue;
          // our own briefs' ids are public slugs (the default set in the harness); every other id stays private
          if (!(DEFAULT_BRIEF_IDS as readonly string[]).includes(id)) needles.push(id);
          for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
            const t = line.trim();
            if (t.length >= 40 && !t.startsWith("#") && !t.startsWith("---")) needles.push(t.slice(0, 80));
          }
        }
      }
    }
    const found = needles.filter((n) => gitGrep(n).stdout.trim() !== "").map((n) => n.slice(0, 20));
    expect(found).toEqual([]);
  });
});
