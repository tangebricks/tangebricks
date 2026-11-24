import { createHash } from "node:crypto";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { assemble } from "@poc/assembler";
import { catalog } from "@poc/assembler/catalog";
import { projectHash } from "../../mcp-server/src/index.ts";
import type { CallRecord } from "./provisioner/cloudflare.ts";

// The deployed MCP endpoint, measured (epic 5, story 9). The plan it follows is in H9's note in hypotheses.json and was committed
// before this file existed. It is INFORMATION about H9, not a check: H9's pass was measured in Node and stays that. This answers a
// different question, whether assembly fits a deployed Worker on the owner's plan, and it reports what it saw without judging it.
//
// What it does, over the real network: tries the endpoint without a token and with a wrong one; plays the scored four-call session
// with the official MCP client; reads the stored files back and compares them with a direct assembly; calls build_project ten more
// times, each one classed as built, stopped by Cloudflare's resource limit (error 1102), or some other failure; and, only if the
// full project did not build every time, builds smaller projects to show where it stops fitting.

export const SESSION_PROJECT = "invoice-flow";
export const FULL_REPEATS = 10;
export const LADDER_BUILDS = 5;
export const PROTOCOL_VERSION = "2025-11-25";
const EXCERPT = 1000;
const REQUEST_TIMEOUT_MS = 30_000;

/** The table the scored session declares, exactly as packages/mcp-server/test/support/session.ts does (a test holds the two together). */
export const INVOICES = {
  name: "invoices",
  fields: [
    { name: "client_name", type: "text", required: true },
    { name: "amount", type: "number" },
    { name: "status", type: "enum", values: ["draft", "paid", "overdue"] },
    { name: "pdf_r2_url", type: "text" },
  ],
};
const THREE = ["multi-workspace", "credit-wallet", "dynamic-entities"];
export interface Step {
  tool: string;
  args: Record<string, unknown>;
}
export const FULL_STEPS: Step[] = [
  { tool: "list_bricks", args: {} },
  { tool: "enable_brick", args: { project: SESSION_PROJECT, bricks: THREE } },
  { tool: "define_entity", args: { project: SESSION_PROJECT, entities: [INVOICES] } },
  { tool: "build_project", args: { project: SESSION_PROJECT } },
];
export const FULL_BLUEPRINT = { project: SESSION_PROJECT, bricks: THREE, entities: [INVOICES] };

export interface LadderRung {
  label: string;
  project: string;
  bricks: string[];
  entities: unknown[];
}
export const LADDER: LadderRung[] = [
  { label: "1 brick", project: "ladder-1", bricks: ["multi-workspace"], entities: [] },
  { label: "2 bricks", project: "ladder-2", bricks: ["multi-workspace", "credit-wallet"], entities: [] },
  { label: "3 bricks", project: "ladder-3", bricks: THREE, entities: [] },
  { label: "3 bricks and the table", project: "ladder-3t", bricks: THREE, entities: [INVOICES] },
];

/** Every project the measurement touches; the deployed Worker holds one token per project (story 0.15). */
export const MEASURED_PROJECTS: readonly string[] = [SESSION_PROJECT, ...LADDER.map((rung) => rung.project)];

export type Outcome = "built" | "resource_limit" | "other";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * What an answer to build_project means. Cloudflare's own refusal for a Worker that used too much (error 1102, "Worker exceeded
 * resource limits") is the only thing counted as the limit; a built project is a 200 whose tool result carries the summary and is
 * not an error; anything else (a wrong token, a rate limit, a tool error, no answer, a page that is not Cloudflare's) is "other",
 * which is not a finding but a fault to find.
 */
export function classifyBuild(status: number | null, body: string): { outcome: Outcome; hash?: string } {
  if (status === null) return { outcome: "other" };
  if (/error code:?\s*1102|\berror 1102\b|worker exceeded resource limits/i.test(body)) return { outcome: "resource_limit" };
  if (status !== 200) return { outcome: "other" };
  try {
    const message = JSON.parse(body) as { result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> } };
    if (message.result?.isError === true) return { outcome: "other" };
    const summary = JSON.parse(message.result?.content?.[0]?.text ?? "") as { hash?: unknown; files?: unknown };
    if (typeof summary.hash === "string" && /^[0-9a-f]{64}$/.test(summary.hash) && typeof summary.files === "number") return { outcome: "built", hash: summary.hash };
  } catch {
    // not the shape of a build summary
  }
  return { outcome: "other" };
}

export interface Exchange {
  /** What the call was: the JSON-RPC method, and for a tool call the tool's name. */
  what: string;
  status: number | null;
  ms: number;
  /** The first part of the answer, for reading and for judging again. */
  body: string;
  error?: string;
}
export interface Attempt extends Exchange {
  n: number;
  outcome: Outcome;
  hash?: string;
}
export interface StoredCheck {
  read: boolean;
  fileCount: number;
  projectHash: string | null;
  directHash: string;
  sameFiles: boolean;
  differing: string[];
}
export interface RungResult {
  label: string;
  project: string;
  setup: Exchange[];
  setupOk: boolean;
  builds: Attempt[];
}
export interface McpFacts {
  schema: 1;
  commandStartedAt: string;
  url: string;
  deploy: { bytes: number; gzipBytes: number; sha256: string; percentOfLimit: number; limitBytes: number; startupTimeMs: number | null; changes: string[]; reachableAfterMs: number | null } | null;
  /** Set when Cloudflare refused the upload: the refusal is itself the finding, and nothing else could be measured. */
  uploadError: string | null;
  /** The project Worker (the one H10 to H12 describe) must not change: its versions before this story's deploy and after the measurement. */
  projectWorker: { before: string[] | null; after: string[] | null };
  closed: { noToken: number | null; wrongToken: number | null };
  session: { connected: boolean; exchanges: Exchange[]; answers: Array<{ tool: string; isError: boolean; text: string; threw?: string }>; toolCalls: number; stoppedAt?: string };
  storedAfterSession: StoredCheck | null;
  repeats: Attempt[];
  storedAfterRepeats: StoredCheck | null;
  ladderRun: boolean;
  ladder: RungResult[];
  /** Every call made to Cloudflare's API for the deploy and for reading the stored files back. Empty in the rehearsal tests. */
  account: CallRecord[];
  directFiles: number;
  directHash: string;
}
export interface McpResult {
  schema: 1;
  commandStartedAt: string;
  finishedAt: string;
  completed: boolean;
  callsSha256: string;
  stoppedBecause?: string;
  leakScan?: { filesScanned: number; found: string[]; scannedFor: string[] };
}
export const canonicalMcp = (facts: McpFacts): string => `${JSON.stringify(facts, null, 2)}\n`;

export interface McpDeps {
  url: string;
  /** The token bound to SESSION_PROJECT; the scored session and the repeats use it. */
  token: string;
  /** The token bound to another project (the ladder's). Tokens are per project since story 0.15; without this, `token` is used. */
  tokenFor?(project: string): string;
  fetchUrl(url: string, init: RequestInit): Promise<Response>;
  clock(): number;
  nowIso(): string;
  /** The files the endpoint stored for a project, read from its database; null if it cannot be read. */
  readStoredFiles(project: string): Promise<Record<string, string> | null>;
  hide(text: string): string;
  log(line: string): void;
  deploy: McpFacts["deploy"];
  uploadError?: string;
  projectWorkerBefore?: string[] | null;
  readProjectWorkerVersions?: () => Promise<string[] | null>;
  /** The calls the Cloudflare client has made so far (the deploy and the reads); read once, at the end. */
  accountCalls?: () => readonly CallRecord[];
  repeats?: number;
  ladderBuilds?: number;
}

export async function runMcpMeasurement(deps: McpDeps): Promise<{ facts: McpFacts; result: McpResult }> {
  const started = deps.nowIso();
  const repeats = deps.repeats ?? FULL_REPEATS;
  const ladderBuilds = deps.ladderBuilds ?? LADDER_BUILDS;
  const direct = assemble(FULL_BLUEPRINT as never, catalog);
  if (!direct.ok) throw new Error(`the direct assembly of the scored project failed: ${direct.errors.join("; ")}`);
  const directHash = await projectHash(direct.files);
  const endpoint = deps.url.endsWith("/mcp") ? deps.url : `${deps.url.replace(/\/$/, "")}/mcp`;
  const facts: McpFacts = {
    schema: 1,
    commandStartedAt: started,
    url: deps.url,
    deploy: deps.deploy,
    uploadError: deps.uploadError ?? null,
    projectWorker: { before: deps.projectWorkerBefore ?? null, after: null },
    closed: { noToken: null, wrongToken: null },
    session: { connected: false, exchanges: [], answers: [], toolCalls: 0 },
    storedAfterSession: null,
    repeats: [],
    storedAfterRepeats: null,
    ladderRun: false,
    ladder: [],
    account: [],
    directFiles: Object.keys(direct.files).length,
    directHash,
  };
  let stoppedBecause: string | undefined;
  if (deps.uploadError) {
    facts.account = [...(deps.accountCalls?.() ?? [])];
    facts.projectWorker.after = (await deps.readProjectWorkerVersions?.().catch(() => null)) ?? null;
    return { facts, result: { schema: 1, commandStartedAt: started, finishedAt: deps.nowIso(), completed: false, callsSha256: sha256(canonicalMcp(facts)), stoppedBecause: `Cloudflare did not accept the upload: ${deps.uploadError}` } };
  }

  const timed = async (what: string, request: () => Promise<Response>): Promise<Exchange & { response?: Response }> => {
    const t0 = deps.clock();
    try {
      const response = await request();
      const text = await response.clone().text();
      return { what, status: response.status, ms: Math.round((deps.clock() - t0) * 10) / 10, body: deps.hide(text.slice(0, EXCERPT)), response };
    } catch (error) {
      return { what, status: null, ms: Math.round((deps.clock() - t0) * 10) / 10, body: "", error: deps.hide(error instanceof Error ? error.message : String(error)) };
    }
  };
  const headers = (token: string | null): Record<string, string> => ({
    "content-type": "application/json",
    accept: "application/json",
    "mcp-protocol-version": PROTOCOL_VERSION,
    ...(token === null ? {} : { authorization: `Bearer ${token}` }),
  });
  let nextId = 1000;
  const rpc = async (what: string, method: string, params: unknown, token: string | null = deps.token) => {
    const { response: _unused, ...exchange } = await timed(what, () =>
      deps.fetchUrl(endpoint, { method: "POST", headers: headers(token), body: JSON.stringify({ jsonrpc: "2.0", id: (nextId += 1), method, params }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    );
    return exchange;
  };
  const tokenForArgs = (args: unknown): string => {
    const project = typeof args === "object" && args !== null ? (args as { project?: unknown }).project : undefined;
    return typeof project === "string" && project !== SESSION_PROJECT && deps.tokenFor ? deps.tokenFor(project) : deps.token;
  };
  const toolCall = (name: string, args: unknown) => rpc(`tools/call ${name}`, "tools/call", { name, arguments: args }, tokenForArgs(args));
  const attempt = (n: number, exchange: Exchange): Attempt => {
    const verdict = classifyBuild(exchange.status, exchange.body);
    return { n, ...exchange, outcome: verdict.outcome, ...(verdict.hash ? { hash: verdict.hash } : {}) };
  };
  const stored = async (project: string): Promise<StoredCheck> => {
    const files = await deps.readStoredFiles(project).catch(() => null);
    if (!files) return { read: false, fileCount: 0, projectHash: null, directHash, sameFiles: false, differing: [] };
    const paths = new Set([...Object.keys(files), ...Object.keys(direct.files)]);
    const differing = [...paths].filter((p) => files[p] !== direct.files[p]).sort();
    return { read: true, fileCount: Object.keys(files).length, projectHash: await projectHash(files), directHash, sameFiles: differing.length === 0, differing };
  };

  // 1. the endpoint without a token and with a wrong one
  facts.closed.noToken = (await rpc("ping, no token", "ping", {}, null)).status;
  facts.closed.wrongToken = (await rpc("ping, wrong token", "ping", {}, "0".repeat(deps.token.length))).status;
  deps.log(`closed to callers without the token: ${facts.closed.noToken} and ${facts.closed.wrongToken}`);

  // 2. the scored session, with the official client
  const recording = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const body = await request.clone().text();
    let what = request.method;
    try {
      const parsed = JSON.parse(body) as { method?: string; params?: { name?: string } };
      what = parsed.method === "tools/call" ? `tools/call ${parsed.params?.name}` : (parsed.method ?? request.method);
    } catch {
      // a GET or DELETE has no body
    }
    const exchange = await timed(what, () => deps.fetchUrl(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body: body || undefined, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }));
    const { response, ...recorded } = exchange;
    facts.session.exchanges.push(recorded);
    if (response) return response;
    throw new Error(recorded.error ?? "no answer");
  };
  const client = new McpClient({ name: "story-9-session", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { fetch: recording, requestInit: { headers: { authorization: `Bearer ${deps.token}` } } }));
    facts.session.connected = true;
    await client.listTools();
    for (const step of FULL_STEPS) {
      try {
        const result = await client.callTool({ name: step.tool, arguments: step.args });
        const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
        facts.session.answers.push({ tool: step.tool, isError: result.isError === true, text: deps.hide(text.slice(0, EXCERPT)) });
        facts.session.toolCalls += 1;
        deps.log(`session: ${step.tool} answered${result.isError ? " with an error" : ""}`);
        if (result.isError === true) {
          facts.session.stoppedAt = step.tool;
          break;
        }
      } catch (error) {
        facts.session.answers.push({ tool: step.tool, isError: true, text: "", threw: deps.hide(error instanceof Error ? error.message.slice(0, EXCERPT) : String(error)) });
        facts.session.toolCalls += 1;
        facts.session.stoppedAt = step.tool;
        deps.log(`session: ${step.tool} did not get an answer the client could read`);
        break;
      }
    }
  } catch (error) {
    facts.session.stoppedAt = "connect";
    stoppedBecause = `the client could not connect: ${deps.hide(error instanceof Error ? error.message : String(error))}`;
  }
  await client.close().catch(() => undefined);

  // 3. what the endpoint stored
  const sessionBuilt = facts.session.answers.some((a) => a.tool === "build_project" && !a.isError);
  if (sessionBuilt) {
    facts.storedAfterSession = await stored(SESSION_PROJECT);
    deps.log(`stored files read back: ${facts.storedAfterSession.read ? `${facts.storedAfterSession.fileCount} files, ${facts.storedAfterSession.sameFiles ? "equal to the direct assembly" : `DIFFERENT: ${facts.storedAfterSession.differing.join(", ")}`}` : "could not be read"}`);
  }

  // 4. the full project's build, again and again (needs the blueprint to be in place, which the session did unless it stopped early)
  const blueprintInPlace = facts.session.answers.filter((a) => (a.tool === "enable_brick" || a.tool === "define_entity") && !a.isError).length === 2;
  if (blueprintInPlace) {
    for (let n = 1; n <= repeats; n += 1) {
      const a = attempt(n, await toolCall("build_project", { project: SESSION_PROJECT }));
      facts.repeats.push(a);
      deps.log(`build_project ${n}/${repeats}: ${a.outcome}${a.outcome === "built" ? "" : ` (HTTP ${a.status})`} in ${a.ms} ms`);
    }
    if (facts.repeats.some((a) => a.outcome === "built")) facts.storedAfterRepeats = await stored(SESSION_PROJECT);
  } else if (!stoppedBecause) stoppedBecause = `the session stopped before the project was in place (${facts.session.stoppedAt ?? "unknown"}), so the repeats were not made`;

  // 5. smaller projects, only if the full one did not build every time
  const fullBuiltEveryTime = sessionBuilt && facts.repeats.length === repeats && facts.repeats.every((a) => a.outcome === "built");
  const anyOther = facts.repeats.some((a) => a.outcome === "other");
  if (blueprintInPlace && !fullBuiltEveryTime && !anyOther) {
    facts.ladderRun = true;
    for (const rung of LADDER) {
      const setup: Exchange[] = [await toolCall("enable_brick", { project: rung.project, bricks: rung.bricks })];
      if (rung.entities.length > 0) setup.push(await toolCall("define_entity", { project: rung.project, entities: rung.entities }));
      const setupOk = setup.every((s) => s.status === 200 && !/"isError":true/.test(s.body));
      const result: RungResult = { label: rung.label, project: rung.project, setup, setupOk, builds: [] };
      if (setupOk) {
        for (let n = 1; n <= ladderBuilds; n += 1) result.builds.push(attempt(n, await toolCall("build_project", { project: rung.project })));
      }
      facts.ladder.push(result);
      deps.log(`${rung.label}: ${setupOk ? result.builds.map((b) => (b.outcome === "built" ? "built" : b.outcome === "resource_limit" ? "limit" : "other")).join(" ") : "could not be set up"}`);
    }
  }

  facts.account = [...(deps.accountCalls?.() ?? [])];
  facts.projectWorker.after = (await deps.readProjectWorkerVersions?.().catch(() => null)) ?? null;
  const other = [...facts.repeats, ...facts.ladder.flatMap((r) => r.builds)].filter((a) => a.outcome === "other").length;
  const completed = facts.session.connected && blueprintInPlace && facts.repeats.length === repeats && other === 0 && facts.closed.noToken === 401 && facts.closed.wrongToken === 401 && (!facts.ladderRun || facts.ladder.every((r) => r.setupOk));
  if (!completed && !stoppedBecause) stoppedBecause = other > 0 ? `${other} builds ended some way that is neither a built project nor Cloudflare's resource limit: a fault to find, not a finding` : "something did not go as the plan expects; see the log";
  return { facts, result: { schema: 1, commandStartedAt: started, finishedAt: deps.nowIso(), completed, callsSha256: sha256(canonicalMcp(facts)), ...(stoppedBecause ? { stoppedBecause } : {}) } };
}

// ---------------------------------------------------------------------------------------------------------------------

export interface McpEvaluation {
  /** False when the files cannot be believed; the notes then say so. */
  believed: boolean;
  notes: string[];
  summary: { fullBuilt: number; fullLimit: number; fullOther: number; sessionBuilt: boolean; sameAsDirect: boolean | null } | null;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)]!;
};
const kib = (n: number) => `${(n / 1024).toFixed(1)} KiB`;

/** Reads the two evidence files again and says in words what they show. It re-derives every class from the recorded answer. */
export function evaluateMcp(input: { callsText: string; result: McpResult }): McpEvaluation {
  let facts: McpFacts;
  try {
    facts = JSON.parse(input.callsText) as McpFacts;
  } catch {
    return { believed: false, notes: ["the calls file is not valid JSON; nothing in it is believed"], summary: null };
  }
  if (sha256(input.callsText) !== input.result.callsSha256 || input.callsText !== canonicalMcp(facts)) return { believed: false, notes: ["the calls file does not match the hash in the result file (one of them was edited, or they come from different runs); nothing in them is believed"], summary: null };
  const attempts = [...facts.repeats, ...facts.ladder.flatMap((r) => r.builds)];
  if (attempts.some((a) => a.outcome !== classifyBuild(a.status, a.body).outcome || a.hash !== classifyBuild(a.status, a.body).hash)) return { believed: false, notes: ["a recorded class disagrees with the answer recorded beside it: the file was edited, and nothing in it is believed"], summary: null };

  const worker = facts.projectWorker;
  const unchanged = worker.before !== null && worker.after !== null && worker.before.length > 0 && worker.before.length === worker.after.length && worker.before.every((v, i) => v === worker.after![i]);
  const notes: string[] = [`from the run that started ${facts.commandStartedAt}${input.result.completed ? "" : " (it did not complete)"}`];
  if (facts.uploadError) notes.push(`Cloudflare did not accept the upload: ${facts.uploadError}`);
  if (facts.deploy) {
    const d = facts.deploy;
    notes.push(`the upload: bundle ${kib(d.bytes)} (${kib(d.gzipBytes)} gzipped), ${d.percentOfLimit}% of the ${d.limitBytes / 1024 / 1024} MiB limit${d.startupTimeMs === null ? "; Cloudflare gave no start-up time" : `; Cloudflare reported a start-up time of ${d.startupTimeMs} ms (limit 1000)`}${d.reachableAfterMs === null ? "" : `; the address answered ${(d.reachableAfterMs / 1000).toFixed(1)} seconds after the upload`}`);
  }
  notes.push(worker.before === null || worker.after === null ? "the project Worker's versions were not read before and after: it is not shown to be untouched" : unchanged ? `the project Worker (the one H10 to H12 describe) was not changed: ${worker.after.length} versions, newest ${worker.after[0]?.slice(0, 8)}, before and after` : "THE PROJECT WORKER'S VERSIONS CHANGED between the start and the end of this run");
  notes.push(`without a token the endpoint answered ${facts.closed.noToken}, with a wrong one ${facts.closed.wrongToken}`);
  const s = facts.session;
  const exchangeLine = (what: string) => {
    const e = s.exchanges.find((x) => x.what === what);
    return e ? `${what.replace("tools/call ", "")} ${e.status === 200 ? "ok" : `HTTP ${e.status}`} in ${e.ms} ms` : null;
  };
  const stepLines = ["initialize", "tools/list", ...FULL_STEPS.map((x) => `tools/call ${x.tool}`)].map(exchangeLine).filter((x): x is string => x !== null);
  notes.push(`the scored session (${s.toolCalls} tool calls, official client): ${stepLines.join("; ")}${s.stoppedAt ? `; it stopped at ${s.stoppedAt}` : ""}`);
  const sessionBuilt = s.answers.some((a) => a.tool === "build_project" && !a.isError);
  const sameAsDirect = facts.storedAfterSession ? facts.storedAfterSession.read && facts.storedAfterSession.sameFiles : null;
  if (facts.storedAfterSession) {
    const c = facts.storedAfterSession;
    notes.push(`the files the endpoint stored, read back from its database: ${c.read ? `${c.fileCount} files, ${c.sameFiles ? `equal to the direct assembly in Node (project hash ${c.projectHash?.slice(0, 12)})` : `NOT equal to the direct assembly (${c.differing.join(", ")})`}` : "could not be read"}`);
  } else if (!sessionBuilt) notes.push("the session's build_project did not build the project, so no stored files could be compared");
  const count = (list: Attempt[], outcome: Outcome) => list.filter((a) => a.outcome === outcome).length;
  const full = { built: count(facts.repeats, "built"), limit: count(facts.repeats, "resource_limit"), other: count(facts.repeats, "other") };
  const times = (list: Attempt[]) => {
    const built = list.filter((a) => a.outcome === "built").map((a) => a.ms);
    return built.length === 0 ? "" : `; built in a median of ${median(built)} ms (fastest ${Math.min(...built)}, slowest ${Math.max(...built)}), as seen from outside`;
  };
  if (facts.repeats.length > 0) notes.push(`build_project on the full project, ${facts.repeats.length} more times: ${full.built} built, ${full.limit} stopped by Cloudflare's resource limit (error 1102), ${full.other} some other way${times(facts.repeats)}`);
  if (facts.storedAfterRepeats) notes.push(`after those builds the stored files ${facts.storedAfterRepeats.read ? (facts.storedAfterRepeats.sameFiles ? "were still equal to the direct assembly" : `were NOT equal to the direct assembly (${facts.storedAfterRepeats.differing.join(", ")})`) : "could not be read"}`);
  for (const r of facts.ladder) {
    const b = r.builds;
    notes.push(`smaller project, ${r.label}: ${r.setupOk ? `${count(b, "built")} built, ${count(b, "resource_limit")} stopped by the limit, ${count(b, "other")} other, of ${b.length}${times(b)}` : "could not be set up"}`);
  }
  if (!facts.ladderRun) notes.push("the smaller projects were not built: the full project built every time");
  if (facts.account.length > 0) {
    const writes = facts.account.filter((c) => c.method !== "GET" && !(c.method === "POST" && c.sqlKind === "select" && /\/d1\/database\/[^/]+\/query$/.test(c.path)));
    const foreign = writes.filter((c) => (/\/workers\/scripts\//.test(c.path) && !/\/workers\/scripts\/projectx-poc-[0-9a-f]{8}-mcp(\/|\?|$)/.test(c.path)) || /\/workflows(\/|$)/.test(c.path));
    notes.push(`calls to Cloudflare's API: ${facts.account.length}, of which ${writes.length} could write (${[...new Set(writes.map((c) => `${c.method} ${c.path.replace("/accounts/{account}", "")}`))].join(", ") || "none"}); ${foreign.length === 0 ? "none of them touched another Worker or any Workflow" : `${foreign.length} TOUCHED ANOTHER WORKER OR A WORKFLOW`}`);
  }
  notes.push("not shown: the CPU time itself (no analytics permission), whether an error 1102 was the CPU or the memory limit, any plan but the free one");
  return { believed: true, notes, summary: { fullBuilt: full.built, fullLimit: full.limit, fullOther: full.other, sessionBuilt, sameAsDirect } };
}
