// The real-model benchmark (story R55). For one run it boots Studio in-process on the REAL Cloudflare client (behind the
// live-deploy guard and a ledger), serves it on a loopback HTTP port, issues a project-bound MCP token, and runs Claude
// Code (`claude -p`) with ProjectX MCP as its only tool source against a brief. A scripted owner accepts proposals and
// approves deploys through Studio's session routes, as a person would. When the CLI exits, the harness (never the agent)
// scores the twelve checks against what exists, records the CLI's own numbers, and tears the run's resources down.
//
//   node scripts/agent-bench.ts --brief <id> --env-file <outside-repo>/.env --state-dir <outside-repo>/bench-state
//   node scripts/agent-bench.ts --task change-live-app --from-run <run id> --env-file ... --state-dir ...
//   node scripts/agent-bench.ts --teardown --env-file ... --state-dir ...     removes what an interrupted run left
//
// Options: --briefs-dir <dir> (default: the private briefs folder), --out <file> (default: the private benchmark-v0.json),
// --model <id or alias>, --max-budget-usd <n> (default 10, shared by every agent call), --max-agent-calls <n> (default 8),
// --iteration <n> (the owner's fix iteration, default 1),
// --claude-bin <path> (see docs/benchmark.md for how it is found on Windows).
//
// Briefs, owner answers and results are private: they are read from and written to paths outside the tracked tree, and no
// committed file holds brief text. See docs/benchmark.md.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { deriveWorkerAccessKey } from "../apps/studio-api/src/index.ts";
import type { StudioDeployOptions } from "../apps/studio-api/src/index.ts";
import {
  STUDIO_TEST_NAME_POLICY,
  createRedactor,
  fileStore,
  findSecrets,
  findUnledgered,
  openLedger,
  studioTestProject,
} from "../packages/deploy/src/provisioner/index.ts";
import type { LedgerStore, RequestBudget } from "../packages/deploy/src/provisioner/index.ts";
import { KEY_HEADER } from "../packages/deploy/src/worker/gate.ts";
import { GLOBAL_API_KEY, connectStudioOwner, nodeBundler, openGuardedStudio, runTeardownOnly, teardownAndVerify } from "./lib/live-studio.ts";
import type { CallLine, StudioCall } from "./lib/live-studio.ts";
import { redactWorkersDevSubdomains } from "./lib/redact-subdomain.ts";
import { serveStudioOverHttp } from "./lib/studio-http.ts";
import type { StudioHttpServer } from "./lib/studio-http.ts";

const repoRoot = resolve(import.meta.dirname, "..");
export const PRIVATE_BENCHMARK_DIR = join(repoRoot, "_bmad-output", "initiative-projectx-roadmap", "benchmark");
export const DEFAULT_BRIEFS_DIR = join(PRIVATE_BENCHMARK_DIR, "briefs");
export const DEFAULT_OUT = join(PRIVATE_BENCHMARK_DIR, "benchmark-v0.json");
export const DEFAULT_MAX_BUDGET_USD = 10;
export const WALL_TIME_CAP_MS = 45 * 60 * 1000;
export const MCP_SERVER_NAME = "projectx";
/** The kill rule as the roadmap writes it; evaluated from the numbers, the decision is the owner's. */
export const KILL_RULE =
  "If the real model cannot build any brief end to end (deployed, >= 9/12 checks) after two fix iterations, pivot MCP toward 'agent edits an existing template'.";
/** The literal bar: 9 of the 12 lines. */
export const KILL_RULE_PASSES_NEEDED = 9;
/** The primary bar (owner decision 2026-11-26): the same 75% as 9/12, over the applicable lines only. */
export const APPLICABLE_SHARE_NEEDED = 0.75;
export const KILL_RULE_VERSION = "v0-applicable-lines (owner decision 2026-11-26)";
/** The debit the change-live-app task asks for, in credits. */
export const CHANGE_DEBIT_CREDITS = 5;
export const FREE_PLAN_UNSUPPORTED_REASON =
  "subscription-plans has no link from a plan to a credit grant: no op, brick setting or node sets the credits a plan gives, so 'set the free plan to 100 credits' cannot be expressed in a ProjectX blueprint";

// ---------------------------------------------------------------------------------------------------------------------
// Briefs

export interface LoadedBrief {
  id: string;
  brief: string;
  answers: string;
  briefSha256: string;
  answersSha256: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Reads `<briefsDir>/<id>/brief.md` and `answers.md` at run time; their text is never written anywhere but the prompt. */
export function loadBrief(briefsDir: string, id: string): LoadedBrief {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new BenchRefusal(`brief id "${id}" must be a lowercase slug`);
  const dir = join(briefsDir, id);
  const briefPath = join(dir, "brief.md");
  const answersPath = join(dir, "answers.md");
  if (!existsSync(briefPath)) throw new BenchRefusal(`no brief at ${briefPath}`);
  if (!existsSync(answersPath)) throw new BenchRefusal(`no owner answers at ${answersPath}`);
  const brief = readFileSync(briefPath, "utf8");
  const answers = readFileSync(answersPath, "utf8");
  return { id, brief, answers, briefSha256: sha256(brief), answersSha256: sha256(answers) };
}

export class BenchRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchRefusal";
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Prompts

export function briefPrompt(project: string, brief: LoadedBrief): string {
  return [
    `Build the SaaS MVP described below with ProjectX, through the "${MCP_SERVER_NAME}" MCP tools only. You have no file or shell tools.`,
    "",
    `Your ProjectX project is "${project}": pass project "${project}" to every tool.`,
    "",
    "How ProjectX works:",
    "- Discover what exists with search_bricks, get_brick, search_nodes and get_node; read the project with get_blueprint_summary and get_blueprint_slice.",
    "- Change the blueprint with apply_ops (enable_brick, add_entity, set_identity, add_workflow and the other ops the tools describe). The product's records are entities (dynamic-entities), kept per workspace (multi-workspace).",
    "- Some changes (money bricks, destructive ops) come back as a pending proposal. The owner reviews proposals in Studio within seconds; check get_blueprint_summary and carry on once it is accepted.",
    "- Check the project with validate_blueprint, then deploy it with deploy_plan and deploy_apply, env \"preview\". The first deploy_apply answers APPROVAL_REQUIRED with an approvalId: the owner approves it in Studio within seconds. Call deploy_apply again with that approvalId (if it answers APPROVAL_PENDING, call it again).",
    "- Deploy to preview only, never production. The preview keeps the stub identity (leave identity as \"stub\").",
    "- This Cloudflare account offers D1, Workers and Workflows only: a brick that needs KV or R2 cannot be deployed.",
    "",
    "The owner answered the setup questions up front; there is no interview. The answers were written for another tool: where they conflict with these instructions (about deploying, a database driver or a local setup), these instructions win. When the preview deploy succeeds, end your reply with one line `PREVIEW: <workerUrl>`.",
    "",
    "<owner-answers>",
    brief.answers.trim(),
    "</owner-answers>",
    "",
    "<product-brief>",
    brief.brief.trim(),
    "</product-brief>",
    "",
  ].join("\n");
}

export function changeLiveAppPrompt(project: string): string {
  return [
    `The app in ProjectX project "${project}" is live on its preview environment (pass project "${project}" to every tool). Change it through the "${MCP_SERVER_NAME}" MCP tools only (you have no file or shell tools):`,
    "",
    `1. The workflow that produces the app's reports must charge ${CHANGE_DEBIT_CREDITS} credits per run: add a credit-wallet debit of ${CHANGE_DEBIT_CREDITS} to it. If the app has no such workflow, add one (a manual trigger, then the debit) named for reports.`,
    "2. Set the free plan to 100 credits.",
    "",
    "Make the change live on preview with deploy_plan and deploy_apply (env \"preview\"); a change to workflows only goes live without a redeploy. The first deploy_apply answers APPROVAL_REQUIRED with an approvalId: the owner approves it in Studio within seconds, then call deploy_apply again with that approvalId. A change that comes back as a pending proposal is reviewed by the owner within seconds.",
    "",
    "If part of the request cannot be done with ProjectX, say so on its own line: `UNSUPPORTED: <part>: <why>`.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// The Claude Code CLI (injectable)

export interface ClaudeRunInput {
  prompt: string;
  /** An empty folder the CLI runs in. */
  cwd: string;
  /** The MCP config file (`--mcp-config`) naming only the ProjectX server. */
  mcpConfigPath: string;
  /** The same server, for a runner that talks to it directly (the offline tests' fake CLI). */
  mcp: { url: string; headers: Record<string, string> };
  model?: string;
  maxBudgetUsd: number;
  timeoutMs: number;
  /** Continue this CLI session (`--resume`): the owner's reply to the agent's last message. */
  resumeSessionId?: string;
}

export interface ClaudeRunOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** The wall-time cap stopped the CLI. */
  timedOut: boolean;
}

export interface ClaudeRunner {
  /** `claude --version` as printed; null when it cannot be read. */
  version(): Promise<string | null>;
  run(input: ClaudeRunInput): Promise<ClaudeRunOutput>;
  /** Deletes the sessions the CLI kept for this working folder (after the run). */
  forgetSessions?(cwd: string): void;
}

/**
 * Where Claude Code keeps the sessions of a working folder: <config dir>/projects/<the folder's path with every character
 * that is not a letter or digit turned into "-">. The config dir is the user's own (CLAUDE_CONFIG_DIR, else ~/.claude); it
 * is never changed, so the login stays intact.
 */
export function claudeSessionDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(configDir, "projects", resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"));
}

/** The flags every real run gets: print mode with JSON, the ProjectX server only, no built-in tools, the budget cap. */
export function claudeArgs(input: Pick<ClaudeRunInput, "mcpConfigPath" | "model" | "maxBudgetUsd" | "resumeSessionId">): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--mcp-config",
    input.mcpConfigPath,
    "--strict-mcp-config",
    "--tools",
    "",
    "--allowedTools",
    `mcp__${MCP_SERVER_NAME}`,
    "--permission-mode",
    "dontAsk",
    "--max-budget-usd",
    String(input.maxBudgetUsd),
    // Sessions persist (so the owner's reply can --resume them); they are kept per working folder, which is the run's own
    // temporary folder, and forgetSessions() deletes them after the run.
    ...(input.resumeSessionId ? ["--resume", input.resumeSessionId] : []),
    ...(input.model ? ["--model", input.model] : []),
  ];
}

/** Variables the agent's process never needs: the deploy token and Studio's root secret stay with the harness. */
const WITHHELD_ENV = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "PX_TELEMETRY_SECRET", "CF_REVOKED_TOKEN", "REVOKED_CF_TOKEN"];

/**
 * The real CLI. It runs with the user's own environment (so the existing Claude Code login is used; CLAUDE_CONFIG_DIR is
 * left as it is), minus the harness's secrets. The prompt goes in on stdin. At the wall-time cap the process is killed.
 */
export function createClaudeCliRunner(bin: string): ClaudeRunner {
  // A .cmd shim on Windows only runs through the shell; then every argument is quoted, and one the shell could still
  // reinterpret (a quote, %, ! or a line break) is refused rather than passed.
  const viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
  const command = (args: string[]): [string, string[]] => {
    if (!viaShell) return [bin, args];
    for (const a of [bin, ...args]) if (/["%!\r\n]/.test(a)) throw new BenchRefusal(`cannot pass ${JSON.stringify(a)} safely through cmd.exe: give --claude-bin the claude.exe path`);
    return [`"${bin}"`, args.map((a) => `"${a}"`)];
  };
  const childEnv = () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of WITHHELD_ENV) delete env[name];
    return env;
  };
  return {
    forgetSessions(cwd) {
      // Only a folder named for one of this harness's own temporary run folders is ever removed.
      const dir = claudeSessionDir(cwd);
      if (/px-bench-/.test(dir) && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    },
    async version() {
      const [cmd, args] = command(["--version"]);
      const out = spawnSync(cmd, args, { encoding: "utf8", env: childEnv(), timeout: 30_000, shell: viaShell, windowsHide: true });
      const text = `${out.stdout ?? ""}`.trim();
      return out.status === 0 && text ? text : null;
    },
    run(input) {
      return new Promise((resolveRun, rejectRun) => {
        const [cmd, args] = command(claudeArgs(input));
        const child = spawn(cmd, args, { cwd: input.cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: viaShell });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, input.timeoutMs);
        child.on("error", (error) => {
          clearTimeout(timer);
          rejectRun(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolveRun({ exitCode: code, stdout, stderr: stderr.slice(-4000), timedOut });
        });
        child.stdin.end(input.prompt);
      });
    },
  };
}

/** The CLI's JSON result, read defensively: a field that is missing is recorded as missing, never invented. */
export interface CliNumbers {
  subtype: string | null;
  isError: boolean | null;
  /** The exact model ids the CLI reports using (modelUsage keys, else `model`); never a hard-coded name. */
  modelIds: string[];
  modelIdSource: "modelUsage" | "model" | "missing";
  /** total_cost_usd: Claude Code's own estimate, not provider billing. */
  costUsd: number | null;
  costLabel: "client-estimated";
  numTurns: number | null;
  durationMs: number | null;
  resultText: string | null;
  sessionId: string | null;
  missingFields: string[];
}

export function parseCliResult(stdout: string): CliNumbers {
  let parsed: Record<string, unknown> | null = null;
  const candidates = [stdout.trim(), ...stdout.trim().split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue;
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
        break;
      }
    } catch {
      // not this line
    }
  }
  const p = parsed ?? {};
  const missing: string[] = parsed ? [] : ["json"];
  const num = (name: string): number | null => {
    const v = p[name];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (parsed) missing.push(name);
    return null;
  };
  const usage = p.modelUsage;
  let modelIds: string[] = [];
  let modelIdSource: CliNumbers["modelIdSource"] = "missing";
  if (usage && typeof usage === "object" && !Array.isArray(usage) && Object.keys(usage).length > 0) {
    modelIds = Object.keys(usage);
    modelIdSource = "modelUsage";
  } else if (typeof p.model === "string" && p.model.length > 0) {
    modelIds = [p.model];
    modelIdSource = "model";
  } else if (parsed) missing.push("modelUsage");
  const costUsd = num("total_cost_usd");
  const numTurns = num("num_turns");
  const durationMs = num("duration_ms");
  const subtype = typeof p.subtype === "string" ? p.subtype : null;
  if (parsed && subtype === null) missing.push("subtype");
  return {
    subtype,
    isError: typeof p.is_error === "boolean" ? p.is_error : null,
    modelIds,
    modelIdSource,
    costUsd,
    costLabel: "client-estimated",
    numTurns,
    durationMs,
    resultText: typeof p.result === "string" ? p.result : null,
    sessionId: typeof p.session_id === "string" && p.session_id.length > 0 ? p.session_id : null,
    missingFields: missing,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The scripted owner

export interface OwnerStats {
  proposalsAccepted: number;
  approvalsApproved: number;
  /** Reviews the owner could not complete (the route refused). */
  refused: number;
  /** Brick secrets the owner bound in Studio (names only; values are generated per run and never recorded). */
  secretsBound: string[];
  /** Approvals the owner rejected because they were not a preview deploy (production, a promotion): the run is preview only. */
  rejectedNotPreview: Array<{ approvalId: string; action: string; env: string | null }>;
  /** For each review: from when the request was stored to the owner's decision. */
  waitMs: number;
}

/**
 * Polls Studio as the signed-in owner and accepts every pending proposal and approves every pending approval, through
 * the same session routes a person's clicks use. Nothing here touches the approval gates themselves.
 */
export function startOwnerLoop(params: { call: StudioCall; session: string; orgId: string; project: string; intervalMs: number; now: () => number }) {
  const { call, session, orgId, project } = params;
  const stats: OwnerStats = { proposalsAccepted: 0, approvalsApproved: 0, refused: 0, secretsBound: [], rejectedNotPreview: [], waitMs: 0 };
  let stopped = false;
  const waited = (createdAt: unknown) => {
    const t = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
    return Number.isFinite(t) ? Math.max(0, params.now() - t) : 0;
  };
  const pass = async () => {
    const proposals = await call("GET", `/api/projects/${project}/proposals?status=pending`, undefined, session, orgId);
    for (const p of (proposals.body.proposals as Array<{ proposalId?: string; status?: string; createdAt?: string }> | undefined) ?? []) {
      if (p.status !== "pending" || !p.proposalId) continue;
      const res = await call("POST", `/api/projects/${project}/proposals/${encodeURIComponent(p.proposalId)}/accept`, {}, session, orgId);
      if (res.status === 200) {
        stats.proposalsAccepted += 1;
        stats.waitMs += waited(p.createdAt);
      } else stats.refused += 1;
    }
    const approvals = await call("GET", `/api/projects/${project}/approvals?status=pending`, undefined, session, orgId);
    for (const a of (approvals.body.approvals as Array<{ approvalId?: string; status?: string; createdAt?: string; action?: string; env?: string | null }> | undefined) ?? []) {
      if (a.status !== "pending" || !a.approvalId) continue;
      // Preview only: anything that is not a preview deploy is rejected, the way a person would decline it.
      if (a.env !== "preview" || a.action === "promote") {
        const rejected = await call("POST", `/api/projects/${project}/approvals/${encodeURIComponent(a.approvalId)}/reject`, {}, session, orgId);
        if (rejected.status === 200) stats.rejectedNotPreview.push({ approvalId: a.approvalId, action: String(a.action ?? "unknown"), env: a.env ?? null });
        else stats.refused += 1;
        continue;
      }
      const res = await call("POST", `/api/projects/${project}/approvals/${encodeURIComponent(a.approvalId)}/approve`, {}, session, orgId);
      if (res.status === 200) {
        stats.approvalsApproved += 1;
        stats.waitMs += waited(a.createdAt);
      } else stats.refused += 1;
    }
  };
  const loop = (async () => {
    while (!stopped) {
      try {
        await pass();
      } catch {
        // a failed poll is retried on the next tick
      }
      if (!stopped) await new Promise<void>((r) => setTimeout(r, params.intervalMs));
    }
  })();
  return {
    stats,
    async stop(): Promise<OwnerStats> {
      stopped = true;
      await loop;
      return stats;
    },
  };
}

export const GENERIC_OWNER_REPLY = "Please continue until the app is deployed to preview; the harness instructions win where they conflict with my answers.";
export const DEFAULT_MAX_AGENT_CALLS = 8;

/**
 * The scripted owner's reply when the agent stops before its preview deploy: the answer under `## <n>. <title>` in the
 * brief's answers when a question in the agent's last message names that title, followed by the generic line; otherwise
 * the generic line alone.
 */
export function ownerReply(answers: string | undefined, agentText: string | null): { text: string; source: "answers" | "generic"; section: string | null } {
  const questions = (agentText ?? "").split(/(?<=[?.!])\s+|\n+/).filter((q) => q.includes("?")).map((q) => q.toLowerCase());
  if (answers && questions.length > 0) {
    const sections = [...answers.matchAll(/^## (\d+)\.\s*(.+)$/gm)];
    for (let i = 0; i < sections.length; i += 1) {
      const heading = sections[i]!;
      const title = heading[2]!.trim();
      const words = title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
      if (words.length === 0 || !questions.some((q) => words.some((w) => q.includes(w)))) continue;
      const end = sections[i + 1]?.index ?? answers.length;
      const body = answers.slice(heading.index! + heading[0].length, end).trim();
      if (body) return { text: `${body}\n\n${GENERIC_OWNER_REPLY}`, source: "answers", section: `${heading[1]}. ${title}` };
    }
  }
  return { text: GENERIC_OWNER_REPLY, source: "generic", section: null };
}

/**
 * The owner binds each brick secret the blueprint still needs (readiness UNBOUND_BRICK_SECRET), as a person would in
 * Studio: the session secrets route with a bindTarget, and a fresh random 32-byte value. Returns the names bound; the
 * values are only ever added to `hideValues` (so every record is checked against them) and never recorded.
 */
export async function bindUnboundSecrets(params: { call: StudioCall; session: string; orgId: string; project: string; randomHex: (bytes: number) => string; hideValues: Record<string, string> }): Promise<{ bound: string[]; failed: string[] }> {
  const { call, session, orgId, project } = params;
  const state = await call("GET", `/api/projects/${project}`, undefined, session, orgId);
  const needs = ((state.body.readiness as { needs?: Array<{ code?: string; path?: string }> } | undefined)?.needs ?? []).filter((n) => n.code === "UNBOUND_BRICK_SECRET");
  const bound: string[] = [];
  const failed: string[] = [];
  for (const need of needs) {
    const m = /^bricks\.([^.]+)\.secrets\.(.+)$/.exec(String(need.path ?? ""));
    if (!m) continue;
    const [, brickId, secretName] = m as unknown as [string, string, string];
    const value = params.randomHex(32);
    params.hideValues[`secret_${brickId}_${secretName}`] = value;
    const ref = `sec_${brickId}_${secretName}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const res = await call("POST", `/api/projects/${project}/secrets`, { ref, kind: "brick_secret", label: secretName, appOrBrick: brickId, value, bindTarget: { targetKind: "brick", targetId: brickId, secretName } }, session, orgId);
    (res.status === 200 || res.status === 201 ? bound : failed).push(`${brickId}.${secretName}`);
  }
  return { bound, failed };
}

// ---------------------------------------------------------------------------------------------------------------------
// The record

const OutcomeSchema = z.enum(["pass", "partial", "n/a", "fail"]);
export const CheckSchema = z.strictObject({ line: z.number().int().min(1).max(12), name: z.string().min(1), outcome: OutcomeSchema, evidence: z.string().min(1) });
export type Check = z.infer<typeof CheckSchema>;

const TeardownSchema = z.object({
  removed: z.array(z.object({ kind: z.string(), name: z.string() }).passthrough()),
  alreadyGone: z.array(z.object({ kind: z.string(), name: z.string() }).passthrough()),
  leftBehind: z.array(z.object({ kind: z.string(), name: z.string() })),
});

const ChangeSchema = z.strictObject({
  timeToLiveMs: z.number().nullable(),
  redeploys: z.number().int().min(0),
  hotApplies: z.number().int().min(0),
  noops: z.number().int().min(0),
  parts: z.array(z.strictObject({ part: z.string(), outcome: z.enum(["done", "not-done", "unsupported"]), reason: z.string() })),
  agentFlaggedUnsupported: z.boolean(),
});

export const RunRecordSchema = z.strictObject({
  runId: z.string().min(1),
  task: z.enum(["brief", "change-live-app"]),
  briefId: z.string().min(1),
  briefSha256: z.string().regex(/^[0-9a-f]{64}$/),
  answersSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  fromRunId: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string(),
  status: z.enum(["complete", "incomplete"]),
  incompleteReason: z.string().nullable(),
  /** "infra" runs are left out of the kill-rule evidence (and listed); "agent" and "cleanup" runs count. */
  incompleteKind: z.enum(["infra", "agent", "cleanup"]).nullable(),
  /** The owner's fix iteration this run belongs to (--iteration, default 1). */
  iteration: z.number().int().min(1),
  cli: z.strictObject({
    version: z.string().nullable(),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    subtype: z.string().nullable(),
    isError: z.boolean().nullable(),
    modelIds: z.array(z.string()),
    modelIdSource: z.enum(["modelUsage", "model", "missing"]),
    requestedModel: z.string().nullable(),
    costUsd: z.number().nullable(),
    costLabel: z.literal("client-estimated"),
    numTurns: z.number().nullable(),
    durationMs: z.number().nullable(),
    missingFields: z.array(z.string()),
    /** `claude -p` invocations (the first, then one per owner reply); turns are counted separately, in numTurns. */
    agentCalls: z.number().int().min(0),
  }),
  /** Each `claude -p` call: what prompted it, what the CLI reported, and its final message (redacted, cut to 2000 characters). */
  agentCalls: z.array(
    z.strictObject({
      call: z.number().int().min(1),
      prompt: z.enum(["brief", "change-request", "owner-reply"]),
      reply: z.strictObject({ source: z.enum(["answers", "generic"]), section: z.string().nullable() }).nullable(),
      resumed: z.boolean(),
      exitCode: z.number().int().nullable(),
      timedOut: z.boolean(),
      subtype: z.string().nullable(),
      isError: z.boolean().nullable(),
      costUsd: z.number().nullable(),
      numTurns: z.number().nullable(),
      durationMs: z.number().nullable(),
      wallTimeMs: z.number().int().min(0),
      modelIds: z.array(z.string()),
      maxBudgetUsd: z.number(),
      resultText: z.string().nullable(),
      secretsBoundAfter: z.array(z.string()),
    }),
  ),
  limits: z.strictObject({ maxBudgetUsd: z.number().positive(), wallTimeCapMs: z.number().int().positive(), maxAgentCalls: z.number().int().positive() }),
  wallTimeMs: z.number().int().min(0),
  agentWallTimeMs: z.number().int().min(0).nullable(),
  ownerReview: z.strictObject({
    count: z.number().int().min(0),
    proposalsAccepted: z.number().int().min(0),
    approvalsApproved: z.number().int().min(0),
    refused: z.number().int().min(0),
    secretsBound: z.array(z.string()),
    rejectedNotPreview: z.array(z.strictObject({ approvalId: z.string(), action: z.string(), env: z.string().nullable() })),
    waitMs: z.number().min(0),
  }),
  project: z.string(),
  previewUrl: z.string().nullable(),
  deployed: z.boolean(),
  deployRefusal: z.string().nullable(),
  checks: z.array(CheckSchema).length(12).nullable(),
  score: z.strictObject({ passes: z.number().int(), partials: z.number().int(), notApplicable: z.number().int(), fails: z.number().int(), applicable: z.number().int() }).nullable(),
  change: ChangeSchema.nullable(),
  /** The final blueprint (Studio's export bundle), so change-live-app can stand the same app up again. Private. */
  blueprint: z.unknown().nullable(),
  teardown: TeardownSchema.nullable(),
  /** Set when an older record was upgraded on load: the fields it lacked were filled with honest defaults. */
  schemaNote: z.string().optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

const VerdictSchema = z.strictObject({ passes: z.number().int(), of: z.number().int(), share: z.number(), met: z.boolean() });
export const KillRuleSchema = z.strictObject({
  rule: z.string(),
  ruleVersion: z.literal(KILL_RULE_VERSION),
  primary: z.string(),
  literal: z.string(),
  notApplicable: z.array(z.strictObject({ line: z.number().int(), name: z.string(), reason: z.string() })),
  excludedRuns: z.array(z.strictObject({ runId: z.string(), briefId: z.string(), iteration: z.number().int(), reason: z.string() })),
  iterations: z.array(
    z.strictObject({
      iteration: z.number().int(),
      perBrief: z.array(z.strictObject({ briefId: z.string(), runId: z.string(), runs: z.number().int(), deployed: z.boolean(), applicableLines: VerdictSchema, literalAsWritten: VerdictSchema })),
      anyBriefMet: z.strictObject({ applicableLines: z.boolean(), literalAsWritten: z.boolean() }),
    }),
  ),
  status: z.strictObject({ applicableLines: z.enum(["met", "not-met", "no-runs"]), literalAsWritten: z.enum(["met", "not-met", "no-runs"]) }),
  latestIteration: z.number().int().min(0),
  decision: z.literal("left to the owner"),
});

export const BenchmarkFileSchema = z.strictObject({
  benchmark: z.literal("real-model-benchmark-v0"),
  internal: z.literal(true),
  note: z.string(),
  runs: z.array(RunRecordSchema),
  killRule: KillRuleSchema,
});
export type BenchmarkFile = z.infer<typeof BenchmarkFileSchema>;

/**
 * The kill rule, judged per the owner's decision (KILL_RULE_VERSION). Primary: per brief, a deployed run with at least 75%
 * of its applicable lines passing (the same bar as 9/12). Beside it, the literal score against all 12 lines (>= 9/12),
 * labelled "literal (as written)". Partial lines are never passes. Iterations are the explicit --iteration numbers, never
 * repeat counts; runs incomplete for infra reasons are left out and listed. The pivot decision is the owner's.
 */
export function evaluateKillRule(runs: RunRecord[]): z.infer<typeof KillRuleSchema> {
  const scored = runs.filter((r) => r.task === "brief" && r.score);
  const excludedRuns = scored.filter((r) => r.incompleteKind === "infra").map((r) => ({ runId: r.runId, briefId: r.briefId, iteration: r.iteration, reason: r.incompleteReason ?? "infra" }));
  const evidence = scored.filter((r) => r.incompleteKind !== "infra");
  const verdicts = (r: RunRecord) => {
    const { passes, applicable } = r.score!;
    const share = applicable > 0 ? passes / applicable : 0;
    return {
      applicableLines: { passes, of: applicable, share, met: r.deployed && applicable > 0 && share >= APPLICABLE_SHARE_NEEDED },
      literalAsWritten: { passes, of: 12, share: passes / 12, met: r.deployed && passes >= KILL_RULE_PASSES_NEEDED },
    };
  };
  const iterationNumbers = [...new Set(evidence.map((r) => r.iteration))].sort((x, y) => x - y);
  const iterations = iterationNumbers.map((iteration) => {
    const byBrief = new Map<string, RunRecord[]>();
    for (const r of evidence.filter((x) => x.iteration === iteration)) byBrief.set(r.briefId, [...(byBrief.get(r.briefId) ?? []), r]);
    const perBrief = [...byBrief.entries()].map(([briefId, list]) => {
      // the run shown is the brief's best in this iteration: met first, then the most passes
      const best = [...list].sort((x, y) => Number(verdicts(y).applicableLines.met) - Number(verdicts(x).applicableLines.met) || y.score!.passes - x.score!.passes)[0]!;
      return { briefId, runId: best.runId, runs: list.length, deployed: best.deployed, ...verdicts(best) };
    });
    return { iteration, perBrief, anyBriefMet: { applicableLines: perBrief.some((x) => x.applicableLines.met), literalAsWritten: perBrief.some((x) => x.literalAsWritten.met) } };
  });
  const statusOf = (key: "applicableLines" | "literalAsWritten"): "met" | "not-met" | "no-runs" => (iterations.length === 0 ? "no-runs" : iterations.some((i) => i.anyBriefMet[key]) ? "met" : "not-met");
  return {
    rule: KILL_RULE,
    ruleVersion: KILL_RULE_VERSION,
    primary: "applicable lines: a brief is met when a deployed run passes at least 75% of its applicable lines (partial is not a pass)",
    literal: "literal (as written): a brief is met when a deployed run passes at least 9 of the 12 lines",
    notApplicable: Object.entries(NOT_APPLICABLE).map(([line, na]) => ({ line: Number(line), name: na.name, reason: na.reason })),
    excludedRuns,
    iterations,
    status: { applicableLines: statusOf("applicableLines"), literalAsWritten: statusOf("literalAsWritten") },
    latestIteration: iterationNumbers.at(-1) ?? 0,
    decision: "left to the owner",
  };
}

/** Adds (or replaces, by run id) a run in the private results file, re-evaluates the kill rule, validates, and writes. */
export const UPGRADED_PRE_AGENT_CALLS = "upgraded from a pre-agentCalls record: one agent call, no per-call data, no secrets bound by the owner";

/**
 * An older run record brought up to the current schema. A record from before agent calls were recorded made exactly one
 * `claude -p` call and the owner bound no secrets, so those are its honest defaults; no call data is invented
 * (`agentCalls` stays empty) and `schemaNote` says it was upgraded.
 */
export function upgradeRunRecord(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = { ...(raw as Record<string, unknown>) };
  let upgraded = false;
  const obj = (key: string) => (r[key] && typeof r[key] === "object" && !Array.isArray(r[key]) ? { ...(r[key] as Record<string, unknown>) } : null);
  if (!("agentCalls" in r)) {
    r.agentCalls = [];
    upgraded = true;
  }
  const cli = obj("cli");
  if (cli && !("agentCalls" in cli)) {
    r.cli = { ...cli, agentCalls: 1 };
    upgraded = true;
  }
  const limits = obj("limits");
  if (limits && !("maxAgentCalls" in limits)) {
    r.limits = { ...limits, maxAgentCalls: 1 };
    upgraded = true;
  }
  const ownerReview = obj("ownerReview");
  if (ownerReview && !("secretsBound" in ownerReview)) {
    r.ownerReview = { ...ownerReview, secretsBound: [] };
    upgraded = true;
  }
  if (upgraded && r.schemaNote === undefined) r.schemaNote = UPGRADED_PRE_AGENT_CALLS;
  return r;
}

/** The runs already in the results file, older records upgraded; the kill rule is always evaluated again from them. */
export function loadRuns(outPath: string): RunRecord[] {
  if (!existsSync(outPath)) return [];
  const raw = JSON.parse(readFileSync(outPath, "utf8")) as { runs?: unknown };
  if (!Array.isArray(raw.runs)) throw new BenchRefusal(`${outPath} has no runs list`);
  return z.array(RunRecordSchema).parse(raw.runs.map(upgradeRunRecord));
}

export function writeBenchmarkResult(outPath: string, record: RunRecord): BenchmarkFile {
  let runs: RunRecord[] = loadRuns(outPath);
  runs = [...runs.filter((r) => r.runId !== record.runId), RunRecordSchema.parse(record)];
  const file: BenchmarkFile = BenchmarkFileSchema.parse({
    benchmark: "real-model-benchmark-v0",
    internal: true,
    note: "Internal: never committed. Costs are Claude Code's client-side estimate (total_cost_usd), not provider billing. The pivot decision is the owner's.",
    runs,
    killRule: evaluateKillRule(runs),
  });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(file, null, 2)}\n`);
  return file;
}

/**
 * Never loses a run: the run's own record is written first to `<out dir>/runs/<runId>.json` (after the same private-path
 * check), and only then merged into the results file. When the merge fails the per-run file stays, its path is printed,
 * and the answer is non-zero.
 */
export function saveRun(params: {
  out: string;
  record: RunRecord;
  refusal: (path: string) => string | null;
  merge?: (out: string, record: RunRecord) => BenchmarkFile;
  log?: (line: string) => void;
  error?: (line: string) => void;
}): { ok: true; runPath: string; file: BenchmarkFile } | { ok: false; runPath: string | null; reason: string } {
  const log = params.log ?? ((line: string) => console.log(line));
  const error = params.error ?? ((line: string) => console.error(line));
  const runPath = join(dirname(resolve(params.out)), "runs", `${params.record.runId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  const refused = params.refusal(runPath);
  if (refused) {
    error(`the run record could not be saved: ${refused}`);
    return { ok: false, runPath: null, reason: refused };
  }
  mkdirSync(dirname(runPath), { recursive: true });
  writeFileSync(runPath, `${JSON.stringify(params.record, null, 2)}\n`);
  log(`run record saved to ${runPath}`);
  try {
    return { ok: true, runPath, file: (params.merge ?? writeBenchmarkResult)(params.out, params.record) };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    error(`merging into ${params.out} failed; the run is kept at ${runPath}: ${reason.slice(0, 2000)}`);
    return { ok: false, runPath, reason };
  }
}

export function readRun(outPath: string, runId: string): RunRecord {
  if (!existsSync(outPath)) throw new BenchRefusal(`no results file at ${outPath}`);
  const run = loadRuns(outPath).find((r) => r.runId === runId);
  if (!run) throw new BenchRefusal(`run "${runId}" is not in ${outPath}`);
  if (!run.blueprint) throw new BenchRefusal(`run "${runId}" recorded no blueprint to stand up again`);
  return run;
}

// ---------------------------------------------------------------------------------------------------------------------
// Scoring (the harness's own reads; never the agent's word)

type EntityField = FieldLike & { name: string; type: string; required?: boolean; values?: unknown[] };
type Entity = { name: string; fields: EntityField[] };

/** A value a field accepts, from its blueprint type. */
/** A field as the blueprint (min, max, maxLength) or the OpenAPI schema (minimum, maximum, maxLength) describes it. */
export type FieldLike = { type?: unknown; values?: unknown; enum?: unknown; format?: unknown; min?: unknown; max?: unknown; minimum?: unknown; maximum?: unknown; maxLength?: unknown };

const numberOr = (...vs: unknown[]) => vs.find((v): v is number => typeof v === "number" && Number.isFinite(v));
/** An integer inside the field's [min, max]. */
function fitNumber(want: number, field: FieldLike): number {
  const min = numberOr(field.min, field.minimum);
  const max = numberOr(field.max, field.maximum);
  let v = Math.round(want);
  if (min !== undefined && v < min) v = Math.ceil(min);
  if (max !== undefined && v > max) v = Math.floor(max);
  return v;
}
/** Text cut to the field's maxLength (never below one character). */
function fitText(text: string, field: FieldLike): string {
  const maxLength = numberOr(field.maxLength);
  return maxLength === undefined ? text : text.slice(0, Math.max(1, Math.floor(maxLength)));
}
const isNumeric = (field: FieldLike) => field.type === "number" || field.type === "integer";

/** A value a field accepts, from its type and constraints. */
export function sampleValue(field: FieldLike, label: string): unknown {
  const values = Array.isArray(field.values) ? field.values : Array.isArray(field.enum) ? field.enum : null;
  if (values && values.length > 0) return values[0];
  if (isNumeric(field)) return fitNumber(Math.max(1, numberOr(field.min, field.minimum) ?? 1), field);
  switch (field.type) {
    case "boolean":
      return true;
    case "datetime":
      return new Date().toISOString();
    case "json":
    case "object":
      return {};
    case "string":
      return field.format === "date-time" ? new Date().toISOString() : fitText(label, field);
    default:
      return fitText(label, field);
  }
}

/** A different value for an update, still inside the field's constraints (the same value when the range has only one). */
export function updatedValue(field: FieldLike, current: unknown): unknown {
  if (isNumeric(field)) {
    const base = typeof current === "number" ? current : 0;
    const up = fitNumber(base + 1, field);
    return up !== base ? up : fitNumber(base - 1, field);
  }
  const next = fitText("updated", field);
  return next !== current ? next : fitText("z", field);
}

const NOT_APPLICABLE: Record<number, { name: string; reason: string }> = {
  1: { name: "landing copy", reason: "ProjectX deploys an API Worker from the blueprint; it generates no landing page or marketing copy, so there is nothing to check (recon)." },
  3: { name: "password-reset mail", reason: "The preview runs the stub identity: there is no password, no mail provider and no reset flow to check (recon)." },
  8: { name: "interview read-back", reason: "ProjectX has no interview: the owner's answers are given up front in the prompt, so there is nothing read back (recon)." },
  11: { name: "audit CLI", reason: "The line checks an audit command of the compared starter kit's own CLI; ProjectX has no such CLI (its build log is line 7) (recon)." },
};
const CHECK_NAMES: Record<number, string> = {
  1: NOT_APPLICABLE[1]!.name,
  2: "sign up / sign in",
  3: NOT_APPLICABLE[3]!.name,
  4: "entity end to end",
  5: "check and seed twice",
  6: "commit per stage, nothing pushed",
  7: "build log",
  8: NOT_APPLICABLE[8]!.name,
  9: "entity end to end",
  10: "preview answers",
  11: NOT_APPLICABLE[11]!.name,
  12: "second agent via MCP",
};

/** Every line, when the run stopped before anything could be scored. */
export function unscoredChecks(reason: string): Check[] {
  return Array.from({ length: 12 }, (_, i) => {
    const line = i + 1;
    const na = NOT_APPLICABLE[line];
    return na ? { line, name: na.name, outcome: "n/a" as const, evidence: na.reason } : { line, name: CHECK_NAMES[line]!, outcome: "fail" as const, evidence: `not scored: ${reason}` };
  });
}

export function scoreOf(checks: Check[]) {
  const count = (o: Check["outcome"]) => checks.filter((c) => c.outcome === o).length;
  const notApplicable = count("n/a");
  return { passes: count("pass"), partials: count("partial"), notApplicable, fails: count("fail"), applicable: checks.length - notApplicable };
}

interface ScoreContext {
  call: StudioCall;
  session: string;
  orgId: string;
  project: string;
  workerFetch: (request: Request) => Promise<Response>;
  accessKey: string;
  ownerStats: OwnerStats;
}

export interface PreviewState {
  deployed: boolean;
  url: string | null;
  deployedRev: number | null;
  productionDeployedRev: number | null;
  refusal: string | null;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { text: text.slice(0, 200) };
  }
}

export async function readPreviewState(ctx: Pick<ScoreContext, "call" | "session" | "orgId" | "project">): Promise<PreviewState> {
  const envs = await ctx.call("GET", `/api/projects/${ctx.project}/environments`, undefined, ctx.session, ctx.orgId);
  const list = (envs.body.environments as Array<Record<string, unknown>> | undefined) ?? [];
  const envOf = (name: string) => list.find((e) => e.envName === name);
  const preview = envOf("preview");
  const state = (preview?.deployedState ?? null) as { workerUrl?: unknown } | null;
  const rev = preview?.deployedRev;
  const url = typeof state?.workerUrl === "string" ? state.workerUrl : null;
  const prodRev = envOf("production")?.deployedRev;
  // The last refused or failed preview deploy, from Studio's own audit log (the code the deploy was refused with).
  const audit = await ctx.call("GET", `/api/projects/${ctx.project}/audit-logs?limit=500`, undefined, ctx.session, ctx.orgId);
  const entries = (audit.body.entries as Array<Record<string, unknown>> | undefined) ?? [];
  const isPreview = (e: Record<string, unknown>) => (e.details as { envName?: unknown } | undefined)?.envName === "preview" || String(e.targetRef ?? e.target_ref ?? "").endsWith(":preview");
  const failed = entries.find((e) => e.action === "environment.deploy" && e.status !== "succeeded" && isPreview(e));
  const details = (failed?.details ?? {}) as { code?: unknown; error?: unknown; message?: unknown };
  const refusal = failed ? `${String(failed.status)}: ${String(details.code ?? (details.error as { code?: unknown } | undefined)?.code ?? details.message ?? "no code recorded")}` : null;
  return { deployed: typeof rev === "number" && url !== null, url, deployedRev: typeof rev === "number" ? rev : null, productionDeployedRev: typeof prodRev === "number" ? prodRev : null, refusal };
}

/** Calls a Studio MCP tool as the owner's session (Studio's /mcp takes a session caller too), in-process. */
async function ownerTool(ctx: Pick<ScoreContext, "call" | "session" | "orgId" | "project">, name: string, args: Record<string, unknown>) {
  const res = await ctx.call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { project: ctx.project, ...args } } }, ctx.session, ctx.orgId);
  const result = res.body.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
  } catch {
    body = { text: result?.content?.[0]?.text ?? "" };
  }
  return { isError: result?.isError === true || res.body.error !== undefined, body };
}

export async function scoreRun(ctx: ScoreContext, preview: PreviewState): Promise<Check[]> {
  const checks = new Map<number, Check>();
  const set = (line: number, outcome: Check["outcome"], evidence: string) => checks.set(line, { line, name: CHECK_NAMES[line]!, outcome, evidence });
  for (const [line, na] of Object.entries(NOT_APPLICABLE)) set(Number(line), "n/a", na.reason);

  const stateRes = await ctx.call("GET", `/api/projects/${ctx.project}`, undefined, ctx.session, ctx.orgId);
  const state = (stateRes.body.state ?? {}) as { bricks?: Array<string | { id: string }>; entities?: Entity[]; workflows?: unknown[] };
  const bricks = (state.bricks ?? []).map((b) => (typeof b === "string" ? b : b.id));
  const entities = state.entities ?? [];
  const workflows = state.workflows ?? [];
  const currentRevision = Number(stateRes.body.revision ?? 0);

  // ---- 10: the preview answers /healthz with its access key
  let healthz = 0;
  if (preview.url) {
    healthz = await ctx
      .workerFetch(new Request(`${preview.url}/healthz`, { headers: { [KEY_HEADER]: ctx.accessKey } }))
      .then((r) => r.status)
      .catch(() => 0);
  }
  if (!preview.url) set(10, "fail", `no preview deploy${preview.refusal ? ` (last preview deploy ${preview.refusal})` : ""}`);
  else set(10, healthz === 200 ? "pass" : "fail", `GET /healthz with the access key answered ${healthz}`);

  // ---- 4, 9 and 2: dynamic-entities CRUD on the preview Worker as a stub user in a fresh workspace
  const worker = async (method: string, path: string, user: string | null, workspace: string | null, body?: unknown) => {
    const headers: Record<string, string> = { [KEY_HEADER]: ctx.accessKey, ...(user ? { "x-test-user": user } : {}), ...(workspace ? { "x-workspace-id": workspace } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) };
    try {
      const res = await ctx.workerFetch(new Request(`${preview.url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
      return { status: res.status, body: await readJson(res) };
    } catch (error) {
      return { status: 0, body: { error: error instanceof Error ? error.message : String(error) } };
    }
  };
  // The stub-identity probe (line 2) is sent whenever the preview answers, whatever the blueprint holds.
  const answers = Boolean(preview.url) && healthz === 200;
  const ws = answers ? await worker("POST", "/api/workspaces", "bench-owner", null, { name: "Benchmark" }) : null;
  const wsId = (ws?.body.workspace as { id?: unknown } | undefined)?.id;
  const signedIn = ws !== null && ws.status === 201 && typeof wsId === "string";
  if (!answers) {
    set(4, "fail", "the preview does not answer, so no entity could be used");
    set(9, "fail", "the preview does not answer, so no entity could be used");
  } else if (entities.length === 0) {
    set(4, "fail", "the blueprint defines no entity");
    set(9, "fail", "the blueprint defines no entity");
  } else {
    if (!signedIn) {
      set(4, "fail", `creating a workspace as a stub user answered ${ws!.status}`);
      set(9, "fail", `creating a workspace as a stub user answered ${ws!.status}`);
    } else {
      const entity = entities[0]!;
      const row: Record<string, unknown> = {};
      for (const f of entity.fields) if (f.required) row[f.name] = sampleValue(f, `bench ${f.name}`);
      const editable = entity.fields.find((f) => ["text", "string"].includes(f.type) && !(Array.isArray(f.values) && f.values.length > 0)) ?? entity.fields.find((f) => ["number", "integer"].includes(f.type));
      if (editable && !(editable.name in row)) row[editable.name] = sampleValue(editable, `bench ${editable.name}`);
      const base = `/api/${entity.name}`;
      const steps: string[] = [];
      const created = await worker("POST", base, "bench-owner", wsId as string, row);
      const id = (created.body.item as { id?: unknown } | undefined)?.id;
      steps.push(`create ${created.status}`);
      const ok = { create: created.status === 201 && typeof id === "string", read: false, list: false, update: false, remove: false };
      if (ok.create) {
        const read = await worker("GET", `${base}/${encodeURIComponent(String(id))}`, "bench-owner", wsId as string);
        ok.read = read.status === 200 && (read.body.item as { id?: unknown } | undefined)?.id === id;
        steps.push(`read ${read.status}`);
        const list = await worker("GET", base, "bench-owner", wsId as string);
        ok.list = list.status === 200 && ((list.body.items as Array<{ id?: unknown }> | undefined) ?? []).some((i) => i.id === id);
        steps.push(`list ${list.status}`);
        if (editable) {
          const patched = await worker("PATCH", `${base}/${encodeURIComponent(String(id))}`, "bench-owner", wsId as string, { [editable.name]: updatedValue(editable, row[editable.name]) });
          ok.update = patched.status === 200;
          steps.push(`update ${patched.status}`);
        }
        const removed = await worker("DELETE", `${base}/${encodeURIComponent(String(id))}`, "bench-owner", wsId as string);
        const gone = await worker("GET", `${base}/${encodeURIComponent(String(id))}`, "bench-owner", wsId as string);
        ok.remove = (removed.status === 200 || removed.status === 204) && gone.status === 404;
        steps.push(`delete ${removed.status}, read after delete ${gone.status}`);
      }
      const all = ok.create && ok.read && ok.list && ok.update && ok.remove;
      const outcome: Check["outcome"] = all ? "pass" : ok.create && ok.read ? "partial" : "fail";
      const evidence = `entity "${entity.name}" in workspace as stub user: ${steps.join(", ")}`;
      set(4, outcome, evidence);
      set(9, outcome, evidence);
    }
  }
  set(
    2,
    signedIn ? "partial" : "fail",
    !answers
      ? "the preview does not answer, so no stub-identity request could be sent"
      : signedIn
        ? "stub identity only: the preview accepted the x-test-user header and created a workspace; there is no real sign-up or sign-in"
        : `POST /api/workspaces as a stub user (x-test-user) answered ${ws!.status}`,
  );

  // ---- 5: validate_blueprint ok, then an idempotent preview redeploy reporting noop
  const validated = await ownerTool(ctx, "validate_blueprint", {});
  const valid = !validated.isError && validated.body.ready === true;
  let redeployEvidence = "no preview deploy to repeat";
  let noop = false;
  if (preview.deployed && preview.deployedRev !== currentRevision) {
    // Redeploying now would ship the agent's undeployed changes; the check is about repeating the agent's own deploy.
    redeployEvidence = `latest revision never deployed: the blueprint is at r${currentRevision}, preview runs r${String(preview.deployedRev)}, so no redeploy was sent`;
  } else if (preview.deployed) {
    const again = await ctx.call("POST", `/api/projects/${ctx.project}/environments/preview/deploy`, {}, ctx.session, ctx.orgId);
    noop = again.status === 200 && again.body.action === "noop" && again.body.mutatingCallCount === 0;
    redeployEvidence = `redeploy answered ${again.status}, action ${String(again.body.action ?? (again.body.error as { code?: string } | undefined)?.code)}, ${String(again.body.mutatingCallCount ?? "?")} mutating calls`;
  }
  set(5, valid && noop ? "pass" : "fail", `validate_blueprint ${valid ? "ready" : `not ready (${JSON.stringify(validated.body.needs ?? validated.body.issues ?? validated.body).slice(0, 200)})`}; ${redeployEvidence}`);

  // ---- 6: at least one revision per build stage, and nothing on production
  const revisions: Array<{ revision: number; ops?: Array<{ type?: string }> }> = [];
  for (let before: number | null = null, pages = 0; pages < 1000; pages += 1) {
    const revs = await ctx.call("GET", `/api/projects/${ctx.project}/revisions?limit=100${before !== null ? `&beforeRevision=${before}` : ""}`, undefined, ctx.session, ctx.orgId);
    revisions.push(...((revs.body.revisions as typeof revisions | undefined) ?? []));
    const next = revs.body.nextBeforeRevision;
    if (revs.body.hasMore !== true || typeof next !== "number") break;
    before = next;
  }
  const stages: Array<{ stage: string; present: boolean; ops: RegExp }> = [
    { stage: "bricks", present: bricks.length > 0, ops: /^enable_brick$/ },
    { stage: "entities", present: entities.length > 0, ops: /entit|field/ },
    { stage: "workflows", present: workflows.length > 0, ops: /workflow|node|edge/ },
  ];
  const stageResults = stages.filter((s) => s.present).map((s) => ({ stage: s.stage, revisions: revisions.filter((r) => (r.ops ?? []).some((op) => s.ops.test(String(op.type ?? "")))).length }));
  const perStage = stageResults.length > 0 && stageResults.every((s) => s.revisions >= 1);
  const nothingPushed = preview.productionDeployedRev === null;
  set(6, perStage && nothingPushed ? "pass" : "fail", `${revisions.length} revision(s) (current r${currentRevision}); per stage: ${stageResults.map((s) => `${s.stage} ${s.revisions}`).join(", ") || "no stage built"}; production ${nothingPushed ? "never deployed" : `deployed at r${preview.productionDeployedRev}`}`);

  // ---- 7: the build log: activity rows for the revisions, audit rows for each review the owner made
  const activity = await ctx.call("GET", `/api/projects/${ctx.project}/activity?limit=500`, undefined, ctx.session, ctx.orgId);
  const events = (activity.body.events as Array<{ type?: string }> | undefined) ?? [];
  const audit = await ctx.call("GET", `/api/projects/${ctx.project}/audit-logs?limit=500`, undefined, ctx.session, ctx.orgId);
  const entries = (audit.body.entries as Array<{ action?: string; status?: string }> | undefined) ?? [];
  const revisionEvents = events.filter((e) => e.type === "revision").length;
  const proposalEvents = events.filter((e) => e.type === "proposal").length;
  const approveRows = entries.filter((e) => e.action === "project.approval.approve" && e.status === "succeeded").length;
  const agentRows = entries.filter((e) => typeof e.action === "string" && e.action.startsWith("mcp.")).length;
  const logged = revisionEvents >= Math.min(revisions.length, 1) && revisionEvents > 0 && approveRows >= ctx.ownerStats.approvalsApproved && proposalEvents >= ctx.ownerStats.proposalsAccepted && agentRows > 0;
  set(7, logged ? "pass" : "fail", `activity: ${revisionEvents} revision and ${proposalEvents} proposal event(s); audit: ${agentRows} agent tool row(s), ${approveRows} approval row(s) for ${ctx.ownerStats.approvalsApproved} approval(s) and ${ctx.ownerStats.proposalsAccepted} accepted proposal(s)`);

  // ---- 12: a second HTTP client finds the entity routes in /openapi.json, creates a row and reads it back
  if (!preview.url || healthz !== 200) set(12, "fail", "the preview does not answer");
  else {
    const spec = await worker("GET", "/openapi.json", null, null);
    const paths = (spec.body.paths ?? {}) as Record<string, Record<string, { operationId?: string; requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> } }>>;
    const schemas = ((spec.body.components as { schemas?: Record<string, { properties?: Record<string, Record<string, unknown>>; required?: string[] }> } | undefined)?.schemas ?? {});
    const createPath = Object.keys(paths).find((p) => paths[p]?.post?.operationId?.startsWith("create_") && paths[`${p}/{id}`]?.get);
    if (spec.status !== 200 || !createPath) set(12, "fail", `GET /openapi.json answered ${spec.status}; ${createPath ? "" : "no entity create route found"}`.trim());
    else {
      const ref = paths[createPath]!.post!.requestBody?.content?.["application/json"]?.schema?.$ref ?? "";
      const schema = schemas[ref.split("/").pop() ?? ""] ?? {};
      const row: Record<string, unknown> = {};
      for (const name of schema.required ?? []) row[name] = sampleValue(schema.properties?.[name] ?? {}, `second agent ${name}`);
      const ws = await worker("POST", "/api/workspaces", "second-agent", null, { name: "Second agent" });
      const wsId = (ws.body.workspace as { id?: unknown } | undefined)?.id;
      const created = typeof wsId === "string" ? await worker("POST", createPath, "second-agent", wsId, row) : { status: 0, body: {} as Record<string, unknown> };
      const id = (created.body.item as { id?: unknown } | undefined)?.id;
      const read = typeof id === "string" ? await worker("GET", `${createPath}/${encodeURIComponent(id)}`, "second-agent", wsId as string) : { status: 0, body: {} as Record<string, unknown> };
      const readBack = read.status === 200 && (read.body.item as { id?: unknown } | undefined)?.id === id;
      set(12, readBack ? "partial" : "fail", `openapi.json lists ${createPath}; workspace ${ws.status}, create ${created.status}, read back ${read.status}${readBack ? " (same id). Partial: a plain HTTP client with the access key and stub identity, not a second agent over the app's own MCP server" : ""}`);
    }
  }
  return [...checks.values()].sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------------------------------------------------
// The run

export interface AgentBenchDeps {
  task: "brief" | "change-live-app";
  /** The owner's fix iteration (default 1). */
  iteration?: number;
  /** The brief (task "brief"), or the brief the from-run was built from (task "change-live-app"). */
  brief: Pick<LoadedBrief, "id" | "briefSha256"> & Partial<LoadedBrief>;
  /** Task "change-live-app": the recorded run whose blueprint is stood up again and changed. */
  fromRun?: RunRecord;
  credentials: { token: string; accountId: string };
  rootSecret: string;
  cloudflareFetch: (request: Request) => Promise<Response>;
  workerFetch: (request: Request) => Promise<Response>;
  bundle: NonNullable<StudioDeployOptions["bundle"]>;
  ledgerStore: LedgerStore;
  randomHex: (bytes: number) => string;
  runner: ClaudeRunner;
  model?: string;
  maxBudgetUsd?: number;
  wallTimeCapMs?: number;
  /** The most `claude -p` calls in one run (the first plus owner replies); default 8. */
  maxAgentCalls?: number;
  /** Where the run's empty working folder and MCP config are made (a temp folder by default). */
  workRoot?: string;
  ownerIntervalMs?: number;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  budget?: RequestBudget;
  now?: () => number;
}

export async function runAgentBench(deps: AgentBenchDeps): Promise<RunRecord> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const startedAt = new Date(started).toISOString();
  const log = deps.log ?? ((line: string) => console.log(line));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxBudgetUsd = deps.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD;
  const wallTimeCapMs = deps.wallTimeCapMs ?? WALL_TIME_CAP_MS;
  const maxAgentCalls = deps.maxAgentCalls ?? DEFAULT_MAX_AGENT_CALLS;
  const { token, accountId } = deps.credentials;
  if (GLOBAL_API_KEY.test(token.trim())) throw new BenchRefusal("CLOUDFLARE_API_TOKEN looks like a Global API Key (37 hex characters): use a scoped API token; nothing was sent");
  if (typeof deps.rootSecret !== "string" || deps.rootSecret.trim().length < 16) throw new BenchRefusal("PX_TELEMETRY_SECRET (Studio's root secret, 16+ characters) is required");
  if (deps.task === "brief" && (deps.brief.brief === undefined || deps.brief.answers === undefined)) throw new BenchRefusal("a brief run needs the brief and the owner's answers");
  if (deps.task === "change-live-app" && !deps.fromRun?.blueprint) throw new BenchRefusal("change-live-app needs a recorded run with a blueprint (--from-run)");

  const ledger = openLedger(deps.ledgerStore, () => deps.randomHex(4), () => new Date(), STUDIO_TEST_NAME_POLICY);
  const live = ledger.entries().filter((e) => e.status !== "removed");
  if (live.length > 0) throw new BenchRefusal(`the ledger lists ${live.length} resource(s) not yet removed (${live.map((e) => e.name).join(", ")}): run with --teardown first`);
  const project = studioTestProject(ledger.suffix);
  const ownPrefix = `px-${project}-`;
  const accessKey = await deriveWorkerAccessKey(deps.rootSecret, project, "preview");
  const secrets: Record<string, string> = { token, accountId, rootSecret: deps.rootSecret, accessKeyPreview: accessKey };
  const hide = (text: string) => createRedactor(Object.values(secrets))(text);
  const say = (line: string) => log(hide(line));

  let phase = "preflight";
  const calls: CallLine[] = [];
  const guarded = openGuardedStudio({ credentials: deps.credentials, cloudflareFetch: deps.cloudflareFetch, workerFetch: deps.workerFetch, bundle: deps.bundle, rootSecret: deps.rootSecret, ownPrefix, ledger, calls, phase: () => phase, sleep, ...(deps.budget ? { budget: deps.budget } : {}), alsoHide: Object.values(secrets) });
  const { rest } = guarded;
  const unledgered = await findUnledgered(rest, ledger, STUDIO_TEST_NAME_POLICY);
  if (unledgered.length > 0) {
    throw new BenchRefusal(`the account already holds ${unledgered.length} px-tangebricks-test-* resource(s) this ledger does not list (${unledgered.map((u) => `${u.kind} ${u.name}`).join(", ")}); nothing was created`);
  }

  const record: RunRecord = {
    runId: `${deps.task}-${deps.brief.id}-${startedAt.replace(/[:.]/g, "-")}-${ledger.suffix}`,
    task: deps.task,
    briefId: deps.brief.id,
    briefSha256: deps.brief.briefSha256,
    answersSha256: deps.brief.answersSha256 ?? null,
    fromRunId: deps.fromRun?.runId ?? null,
    startedAt,
    finishedAt: "",
    status: "incomplete",
    incompleteReason: null,
    incompleteKind: null,
    iteration: deps.iteration ?? 1,
    cli: { version: null, exitCode: null, timedOut: false, subtype: null, isError: null, modelIds: [], modelIdSource: "missing", requestedModel: deps.model ?? null, costUsd: null, costLabel: "client-estimated", numTurns: null, durationMs: null, missingFields: [], agentCalls: 0 },
    agentCalls: [],
    limits: { maxBudgetUsd, wallTimeCapMs, maxAgentCalls },
    wallTimeMs: 0,
    agentWallTimeMs: null,
    ownerReview: { count: 0, proposalsAccepted: 0, approvalsApproved: 0, refused: 0, secretsBound: [], rejectedNotPreview: [], waitMs: 0 },
    project,
    previewUrl: null,
    deployed: false,
    deployRefusal: null,
    checks: null,
    score: null,
    change: null,
    blueprint: null,
    teardown: null,
  };
  /** Why the run is incomplete. "infra": the harness or the CLI process failed, so the run is no evidence about the model; "agent": a cap or the CLI's own error result; "cleanup": teardown, after scoring. */
  const reasons: Array<{ text: string; kind: "infra" | "agent" | "cleanup" }> = [];
  const { studio, app, call } = guarded.boot();
  const must = (what: string, ok: boolean, detail: unknown) => {
    if (!ok) throw new BenchRefusal(`${what} failed: ${hide(JSON.stringify(detail)).slice(0, 1200)}`);
  };
  let server: StudioHttpServer | null = null;
  let owner: ReturnType<typeof startOwnerLoop> | null = null;
  const workRoot = mkdtempSync(join(deps.workRoot ?? tmpdir(), "px-bench-"));

  try {
    phase = "connect";
    const connected = await connectStudioOwner({ call, suffix: ledger.suffix, project, token, accountId, randomHex: deps.randomHex, name: "Tangebricks Benchmark", must });
    const { session, orgId } = connected;
    secrets.session = session;
    const issued = await call("POST", `/api/orgs/${orgId}/mcp-tokens`, { clientName: "agent-bench", projectId: project, scopes: ["read", "edit", "deploy"] }, session);
    must("issuing the agent's MCP token", issued.status === 201 && typeof issued.body.token === "string", issued);
    const mcpToken = String(issued.body.token);
    secrets.mcpToken = mcpToken;
    say(`1. Studio owner signed in, token verified (${connected.connect.status}), project ${project}`);

    // change-live-app: the recorded app stood up again and made live on preview by the owner before the agent starts
    let baselineRevision = 0;
    if (deps.task === "change-live-app") {
      phase = "baseline";
      const imported = await call("POST", `/api/projects/${project}/import`, { bundle: deps.fromRun!.blueprint, mode: "replace" }, session, orgId);
      must("importing the recorded blueprint", imported.status === 200 || imported.status === 201, imported);
      const plan = await call("POST", `/api/projects/${project}/environments/preview/plan`, {}, session, orgId);
      must("planning the baseline preview", plan.status === 200, plan);
      const dep = await call("POST", `/api/projects/${project}/environments/preview/deploy`, {}, session, orgId);
      must("deploying the baseline preview", dep.status === 200 && dep.body.ok === true, dep);
      baselineRevision = Number(dep.body.revision ?? 0);
      say(`2. baseline: ${deps.fromRun!.runId} stood up again and live on preview at r${baselineRevision}`);
    }

    server = await serveStudioOverHttp(app, studio.env);
    const mcp = { url: `${server.origin}/mcp`, headers: { Authorization: `Bearer ${mcpToken}` } };
    const cwd = join(workRoot, "cwd");
    mkdirSync(cwd);
    const mcpConfigPath = join(workRoot, "mcp.json");
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: mcp.url, headers: mcp.headers } } }));
    const prompt = deps.task === "brief" ? briefPrompt(project, deps.brief as LoadedBrief) : changeLiveAppPrompt(project);
    owner = startOwnerLoop({ call, session, orgId, project, intervalMs: deps.ownerIntervalMs ?? 1_000, now });

    phase = "agent";
    record.cli.version = await deps.runner.version().catch(() => null);
    const agentStarted = now();
    say(`3. ${record.cli.version ?? "claude"} running (budget $${maxBudgetUsd}, wall cap ${Math.round(wallTimeCapMs / 60_000)} min)`);
    // The agent works in calls: the first with the prompt, then, while it has stopped short of a live preview, one more per
    // owner reply on the same session (--resume). The budget and the wall cap are shared by every call.
    const deadline = agentStarted + wallTimeCapMs;
    let spent = 0;
    let sessionId: string | null = null;
    let nextPrompt = prompt;
    let reply: { source: "answers" | "generic"; section: string | null } | null = null;
    const texts: string[] = [];
    const baselineRev = baselineRevision;
    const done = async () => {
      const preview = await readPreviewState({ call, session, orgId, project });
      if (deps.task === "brief") return preview.deployed;
      const state = await call("GET", `/api/projects/${project}`, undefined, session, orgId);
      const rev = Number(state.body.revision ?? 0);
      return rev > baselineRev && preview.deployedRev === rev;
    };
    for (let n = 1; n <= maxAgentCalls; n += 1) {
      const remainingMs = deadline - now();
      const remainingUsd = Math.round((maxBudgetUsd - spent) * 10_000) / 10_000;
      if (remainingMs <= 0) {
        reasons.push({ kind: "agent", text: `wall-time cap hit: ${Math.round(wallTimeCapMs / 60_000)} min used across ${n - 1} agent call(s)` });
        break;
      }
      if (remainingUsd <= 0.01) {
        reasons.push({ kind: "agent", text: `budget cap hit: $${spent.toFixed(2)} of $${maxBudgetUsd} used across ${n - 1} agent call(s)` });
        break;
      }
      const callStarted = now();
      let out: ClaudeRunOutput | null = null;
      try {
        out = await deps.runner.run({ prompt: nextPrompt, cwd, mcpConfigPath, mcp, ...(deps.model ? { model: deps.model } : {}), maxBudgetUsd: remainingUsd, timeoutMs: remainingMs, ...(sessionId ? { resumeSessionId: sessionId } : {}) });
      } catch (error) {
        reasons.push({ kind: "infra", text: `the CLI failed: ${hide(error instanceof Error ? error.message : String(error))}` });
        break;
      }
      const numbers = parseCliResult(out.stdout);
      spent += numbers.costUsd ?? 0;
      if (numbers.resultText) texts.push(numbers.resultText);
      const entry: RunRecord["agentCalls"][number] = {
        call: n,
        prompt: n === 1 ? (deps.task === "brief" ? "brief" : "change-request") : "owner-reply",
        reply: n === 1 ? null : reply,
        resumed: n > 1,
        exitCode: out.exitCode,
        timedOut: out.timedOut,
        subtype: numbers.subtype,
        isError: numbers.isError,
        costUsd: numbers.costUsd,
        numTurns: numbers.numTurns,
        durationMs: numbers.durationMs,
        wallTimeMs: Math.max(0, Math.round(now() - callStarted)),
        modelIds: numbers.modelIds,
        maxBudgetUsd: remainingUsd,
        resultText: numbers.resultText === null ? null : hide(numbers.resultText).slice(0, 2000),
        secretsBoundAfter: [],
      };
      record.agentCalls.push(entry);
      const sum = (key: "costUsd" | "numTurns" | "durationMs") => {
        const values = record.agentCalls.map((c) => c[key]).filter((v): v is number => typeof v === "number");
        return values.length === 0 ? null : values.reduce((x, y) => x + y, 0);
      };
      record.cli = {
        ...record.cli,
        exitCode: out.exitCode,
        timedOut: record.cli.timedOut || out.timedOut,
        subtype: numbers.subtype,
        isError: numbers.isError,
        modelIds: [...new Set([...record.cli.modelIds, ...numbers.modelIds])],
        modelIdSource: record.cli.modelIdSource !== "missing" ? record.cli.modelIdSource : numbers.modelIdSource,
        costUsd: sum("costUsd"),
        numTurns: sum("numTurns"),
        durationMs: sum("durationMs"),
        missingFields: [...new Set([...record.cli.missingFields, ...numbers.missingFields])],
        agentCalls: record.agentCalls.length,
      };
      say(`4.${n} CLI call ${n}: exit ${String(out.exitCode)}, ${numbers.subtype ?? "?"}, ${numbers.numTurns ?? "?"} turns, $${numbers.costUsd ?? "?"} (client-estimated), models ${numbers.modelIds.join(", ") || "not reported"}`);
      if (out.timedOut) {
        reasons.push({ kind: "agent", text: `wall-time cap hit: the CLI was stopped after ${Math.round(wallTimeCapMs / 60_000)} min` });
        break;
      }
      if (numbers.subtype === "error_max_budget_usd") {
        reasons.push({ kind: "agent", text: `budget cap hit: the CLI stopped at its $${maxBudgetUsd} cap` });
        break;
      }
      if (out.exitCode !== 0 || numbers.isError === true || (numbers.subtype !== null && numbers.subtype !== "success")) {
        reasons.push({ kind: "agent", text: `the CLI ended with exit ${String(out.exitCode)}, ${numbers.subtype ?? "no result subtype"}` });
        break;
      }
      if (await done()) break;
      // The owner's human steps between calls: bind the brick secrets the blueprint still needs, then reply.
      const secrets_ = await bindUnboundSecrets({ call, session, orgId, project, randomHex: deps.randomHex, hideValues: secrets });
      owner.stats.secretsBound.push(...secrets_.bound);
      entry.secretsBoundAfter = secrets_.bound;
      if (secrets_.failed.length > 0) say(`   the owner could not bind ${secrets_.failed.join(", ")}`);
      if (n === maxAgentCalls) break;
      if (!numbers.sessionId) {
        reasons.push({ kind: "infra", text: "the CLI reported no session_id, so the owner could not reply" });
        break;
      }
      sessionId = numbers.sessionId;
      const r = ownerReply(deps.task === "brief" ? deps.brief.answers : undefined, numbers.resultText);
      reply = { source: r.source, section: r.section };
      nextPrompt = r.text;
    }
    deps.runner.forgetSessions?.(cwd);
    const agentEnded = now();
    record.agentWallTimeMs = Math.max(0, Math.round(agentEnded - agentStarted));
    const stats = await owner.stop();
    owner = null;
    record.ownerReview = { count: stats.proposalsAccepted + stats.approvalsApproved + stats.secretsBound.length, ...stats, waitMs: Math.round(stats.waitMs) };
    if (deps.task === "change-live-app") record.change = { timeToLiveMs: null, redeploys: 0, hotApplies: 0, noops: 0, parts: [], agentFlaggedUnsupported: texts.some((t) => /^\s*UNSUPPORTED:/im.test(t)) };

    // ---- scoring, on whatever exists now
    phase = "score";
    const ctx: ScoreContext = { call, session, orgId, project, workerFetch: deps.workerFetch, accessKey, ownerStats: stats };
    const preview = await readPreviewState(ctx);
    record.previewUrl = preview.url;
    record.deployed = preview.deployed;
    record.deployRefusal = preview.deployed ? null : preview.refusal;
    if (deps.task === "brief") {
      try {
        record.checks = await scoreRun(ctx, preview);
      } catch (error) {
        reasons.push({ kind: "infra", text: `scoring failed: ${hide(error instanceof Error ? error.message : String(error))}` });
        record.checks = unscoredChecks("scoring failed");
      }
      record.score = scoreOf(record.checks);
      say(`5. score: ${record.score.passes} pass, ${record.score.partials} partial, ${record.score.notApplicable} n/a, ${record.score.fails} fail`);
      const exported = await call("GET", `/api/projects/${project}/export`, undefined, session, orgId);
      if (exported.status === 200) record.blueprint = exported.body.bundle ?? exported.body;
    } else {
      record.change = { ...(record.change ?? { timeToLiveMs: null, redeploys: 0, hotApplies: 0, noops: 0, parts: [], agentFlaggedUnsupported: false }), ...(await evaluateChange(ctx, preview, agentStarted)) };
      say(`5. change: ${record.change.parts.map((p) => `${p.part} ${p.outcome}`).join("; ")}; ${record.change.hotApplies} hot-apply, ${record.change.redeploys} redeploy`);
    }
  } catch (error) {
    reasons.push({ kind: "infra", text: hide(error instanceof Error ? error.message : String(error)) });
    if (deps.task === "brief" && !record.checks) {
      record.checks = unscoredChecks(`the run stopped (${phase})`);
      record.score = scoreOf(record.checks);
    }
  } finally {
    if (owner) {
      const stats = await owner.stop().catch(() => null);
      if (stats) record.ownerReview = { count: stats.proposalsAccepted + stats.approvalsApproved + stats.secretsBound.length, ...stats, waitMs: Math.round(stats.waitMs) };
    }
    if (server) await server.close().catch(() => undefined);
    phase = "teardown";
    try {
      record.teardown = await teardownAndVerify(rest, ledger);
      if (record.teardown.leftBehind.length > 0) reasons.push({ kind: "cleanup", text: `teardown left ${record.teardown.leftBehind.length} resource(s) behind` });
      say(`6. teardown: ${record.teardown.removed.length} removed, ${record.teardown.alreadyGone.length} already gone, ${record.teardown.leftBehind.length} left behind`);
    } catch (error) {
      reasons.push({ kind: "cleanup", text: `teardown failed: ${hide(error instanceof Error ? error.message : String(error))} (run again with --teardown)` });
    }
    studio.close();
    rmSync(workRoot, { recursive: true, force: true });
  }

  const finished = now();
  record.finishedAt = new Date(finished).toISOString();
  record.wallTimeMs = Math.max(0, Math.round(finished - started));
  record.status = reasons.length === 0 ? "complete" : "incomplete";
  record.incompleteReason = reasons.length === 0 ? null : reasons.map((r) => r.text).join("; ");
  record.incompleteKind = (["infra", "agent", "cleanup"] as const).find((kind) => reasons.some((r) => r.kind === kind)) ?? null;
  // The account's workers.dev subdomain and every secret stay out of the record.
  const redacted = RunRecordSchema.parse(JSON.parse(hide(JSON.stringify(redactWorkersDevSubdomains(record)))));
  const hits = findSecrets(JSON.stringify(redacted), secrets);
  if (hits.length > 0) throw new BenchRefusal(`refusing to return the run record: it contains ${hits.join(" and ")}`);
  return redacted;
}

/** change-live-app: is the 5-credit debit in a workflow and live on preview, and how did it get there. */
async function evaluateChange(ctx: ScoreContext, preview: PreviewState, agentStarted: number): Promise<Omit<NonNullable<RunRecord["change"]>, "agentFlaggedUnsupported">> {
  const stateRes = await ctx.call("GET", `/api/projects/${ctx.project}`, undefined, ctx.session, ctx.orgId);
  const state = (stateRes.body.state ?? {}) as { workflows?: Array<{ id?: string; name?: string; nodes?: Array<{ type?: string; data?: { amount?: unknown } }> }> };
  const revision = Number(stateRes.body.revision ?? 0);
  const withDebit = (state.workflows ?? []).filter((w) => (w.nodes ?? []).some((n) => n.type === "credit-wallet.debit" && Number(n.data?.amount) === CHANGE_DEBIT_CREDITS));
  const audit = await ctx.call("GET", `/api/projects/${ctx.project}/audit-logs?limit=500`, undefined, ctx.session, ctx.orgId);
  const entries = (audit.body.entries as Array<{ action?: string; status?: string; actorType?: string; ts?: string; createdAt?: string; details?: { envName?: string; planAction?: string; revision?: number; noChanges?: boolean } }> | undefined) ?? [];
  const at = (e: { ts?: string; createdAt?: string }) => Date.parse(String(e.ts ?? e.createdAt ?? ""));
  // The agent's own deploys (made with its MCP token), not the owner's baseline deploy before it started.
  const deploys = entries.filter((e) => e.action === "environment.deploy" && e.status === "succeeded" && e.actorType === "agent" && e.details?.envName === "preview");
  const hotApplies = deploys.filter((e) => e.details?.planAction === "hot_apply_graphs").length;
  const noops = deploys.filter((e) => e.details?.planAction === "noop").length;
  const redeploys = deploys.length - hotApplies - noops;
  const live = withDebit.length > 0 && preview.deployedRev === revision;
  const liveAt = live ? deploys.filter((e) => e.details?.revision === revision).map(at).filter(Number.isFinite).sort((a, b) => a - b)[0] : undefined;
  return {
    timeToLiveMs: liveAt !== undefined ? Math.max(0, Math.round(liveAt - agentStarted)) : null,
    redeploys,
    hotApplies,
    noops,
    parts: [
      {
        part: `debit ${CHANGE_DEBIT_CREDITS} credits in the report workflow`,
        outcome: live ? "done" : "not-done",
        reason: withDebit.length === 0 ? `no workflow has a credit-wallet.debit of ${CHANGE_DEBIT_CREDITS}` : live ? `workflow ${withDebit.map((w) => w.id ?? w.name).join(", ")} has the debit and preview runs r${revision}` : `the debit is in r${revision} but preview runs r${String(preview.deployedRev)}`,
      },
      { part: "free plan 100 credits", outcome: "unsupported", reason: FREE_PLAN_UNSUPPORTED_REASON },
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The command. Only this part reads the environment, the disk outside the run, and the network.

/**
 * The Claude Code binary when --claude-bin is not given. Elsewhere: `claude` on the PATH. On Windows a bare `claude` cannot
 * be spawned without a shell, so: claude.exe on the PATH, else the native binary next to an npm `claude.cmd` shim on the
 * PATH (or under %APPDATA%\npm), else the claude.cmd shim itself (run through cmd.exe with quoted arguments).
 */
export function defaultClaudeBin(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): string {
  if (platform !== "win32") return "claude";
  const dirs = (env.PATH ?? env.Path ?? "").split(";").filter(Boolean);
  if (env.APPDATA) dirs.push(join(env.APPDATA, "npm"));
  for (const dir of dirs) if (exists(join(dir, "claude.exe"))) return join(dir, "claude.exe");
  for (const dir of dirs) {
    const native = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (exists(join(dir, "claude.cmd")) && exists(native)) return native;
  }
  for (const dir of dirs) if (exists(join(dir, "claude.cmd"))) return join(dir, "claude.cmd");
  throw new BenchRefusal("Claude Code was not found on the PATH: pass --claude-bin <path to claude.exe>");
}

/**
 * Why a private path (the results file, the briefs folder) may not be used, or null when it may. Inside the repository it
 * must be git-ignored (`git check-ignore`), and never at the top level of evidence/ (evidence:refresh owns that folder).
 */
export function privatePathRefusal(path: string, root: string, isIgnored: (path: string) => boolean): string | null {
  const full = resolve(path);
  const within = (child: string, parent: string) => (resolve(child) + sep).toLowerCase().startsWith((resolve(parent) + sep).toLowerCase());
  if (resolve(dirname(full)).toLowerCase() === resolve(root, "evidence").toLowerCase()) return `${full} is at the top level of evidence/, which evidence:refresh owns`;
  if (within(full, root) && !isIgnored(full)) return `${full} is inside the repository but not git-ignored: add it to .gitignore (or .git/info/exclude) first, so it can never be committed`;
  return null;
}

const gitIgnores = (path: string) => spawnSync("git", ["check-ignore", "-q", path], { cwd: repoRoot }).status === 0;

async function main(argv: string[]): Promise<number> {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const inside = (child: string, parent: string) => (resolve(child) + sep).toLowerCase().startsWith((resolve(parent) + sep).toLowerCase());
  const envFile = arg("--env-file");
  if (envFile) {
    if (inside(envFile, repoRoot)) {
      console.error("the env file must be outside the repository");
      return 2;
    }
    process.loadEnvFile(envFile);
  }
  const { CredentialsError, loadCredentials } = await import("../packages/deploy/src/provisioner/index.ts");
  let credentials;
  try {
    credentials = loadCredentials(process.env);
  } catch (error) {
    if (error instanceof CredentialsError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  const stateArg = arg("--state-dir");
  if (!stateArg) {
    console.error("--state-dir <folder> is required: the ledger is kept there, outside the repositories");
    return 2;
  }
  const stateDir = resolve(stateArg);
  if (inside(stateDir, repoRoot)) {
    console.error("the state folder must be outside the repository");
    return 2;
  }
  mkdirSync(stateDir, { recursive: true });
  const ledgerPath = join(stateDir, "bench-ledger.json");
  const ledgerStore = fileStore(ledgerPath);
  const realFetch = (request: Request) => fetch(new Request(request, { signal: AbortSignal.timeout(60_000), redirect: "error" }));

  if (argv.includes("--teardown")) {
    const res = await runTeardownOnly({ credentials, cloudflareFetch: realFetch, ledgerStore });
    console.log(`teardown: removed ${res.removed.length}, already gone ${res.alreadyGone.length}, unledgered ${res.unledgered.length}`);
    return res.unledgered.length === 0 ? 0 : 1;
  }
  const previous = ledgerStore.read();
  if (previous && previous.entries.every((e) => e.status === "removed")) renameSync(ledgerPath, `${ledgerPath}.${new Date().toISOString().replace(/[:.]/g, "-")}.done`);

  const out = resolve(arg("--out") ?? DEFAULT_OUT);
  const outRefusal = privatePathRefusal(out, repoRoot, gitIgnores);
  if (outRefusal) {
    console.error(`--out: ${outRefusal}`);
    return 2;
  }
  const iterationArg = arg("--iteration");
  const iteration = iterationArg === undefined ? 1 : Number(iterationArg);
  if (!Number.isInteger(iteration) || iteration < 1) {
    console.error("--iteration must be a whole number from 1");
    return 2;
  }
  const task = arg("--task") ?? "brief";
  if (task !== "brief" && task !== "change-live-app") {
    console.error(`--task must be "brief" or "change-live-app"`);
    return 2;
  }
  const callsArg = arg("--max-agent-calls");
  const maxAgentCalls = callsArg === undefined ? DEFAULT_MAX_AGENT_CALLS : Number(callsArg);
  if (!Number.isInteger(maxAgentCalls) || maxAgentCalls < 1) {
    console.error("--max-agent-calls must be a whole number from 1");
    return 2;
  }
  const budgetArg = arg("--max-budget-usd");
  const maxBudgetUsd = budgetArg === undefined ? DEFAULT_MAX_BUDGET_USD : Number(budgetArg);
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
    console.error("--max-budget-usd must be a positive number");
    return 2;
  }
  let brief: AgentBenchDeps["brief"];
  let fromRun: RunRecord | undefined;
  if (task === "brief") {
    const id = arg("--brief");
    if (!id) {
      console.error("--brief <id> is required (a folder under --briefs-dir with brief.md and answers.md)");
      return 2;
    }
    const briefsDir = resolve(arg("--briefs-dir") ?? DEFAULT_BRIEFS_DIR);
    const briefsRefusal = privatePathRefusal(join(briefsDir, id), repoRoot, gitIgnores);
    if (briefsRefusal) {
      console.error(`--briefs-dir: ${briefsRefusal}`);
      return 2;
    }
    brief = loadBrief(briefsDir, id);
  } else {
    const fromId = arg("--from-run");
    if (!fromId) {
      console.error("--from-run <run id> is required for change-live-app");
      return 2;
    }
    fromRun = readRun(out, fromId);
    brief = { id: fromRun.briefId, briefSha256: fromRun.briefSha256 };
  }
  const model = arg("--model");
  const record = await runAgentBench({
    task,
    iteration,
    maxAgentCalls,
    brief,
    ...(fromRun ? { fromRun } : {}),
    credentials,
    rootSecret: process.env.PX_TELEMETRY_SECRET?.trim() ?? "",
    cloudflareFetch: realFetch,
    workerFetch: realFetch,
    bundle: nodeBundler,
    ledgerStore,
    randomHex: (n) => randomBytes(n).toString("hex"),
    runner: createClaudeCliRunner(arg("--claude-bin") ?? defaultClaudeBin()),
    ...(model ? { model } : {}),
    maxBudgetUsd,
  });
  console.log(`run ${record.runId}: ${record.status}${record.incompleteReason ? ` (${record.incompleteReason})` : ""}`);
  const saved = saveRun({ out, record, refusal: (path) => privatePathRefusal(path, repoRoot, gitIgnores) });
  if (!saved.ok) return 1;
  const { file } = saved;
  if (record.score) console.log(`score (iteration ${record.iteration}): ${record.score.passes}/${record.score.applicable} applicable lines pass; literal (as written) ${record.score.passes}/12; deployed: ${record.deployed}`);
  console.log(`kill rule (${file.killRule.ruleVersion}): applicable lines ${file.killRule.status.applicableLines}, literal (as written) ${file.killRule.status.literalAsWritten}; decision left to the owner; written to ${out}`);
  return record.status === "complete" ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
