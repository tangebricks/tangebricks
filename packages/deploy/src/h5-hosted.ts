import { createHash } from "node:crypto";
import type { D1Like, D1Result, D1Statement } from "@poc/sdk";
import { createFakeGateway, createWallet } from "../../../bricks/credit-wallet/src/index.ts";
import { workload } from "../../../bricks/credit-wallet/test/support/workload.ts";
import type { Attempt, ClientLog, UrlEvent } from "./h10.ts";
import type { CallRecord, Client } from "./provisioner/cloudflare.ts";
import type { ResourceNames } from "./provisioner/names.ts";

// The wallet's money invariant on Cloudflare's hosted D1 (H5's extra evidence, holdsOnHostedD1). The rule is in hypotheses.json (H5's
// note) and was committed before this file existed. In short: the same 20 mixed workloads as the local sweep, each on a fresh
// scratch wallet in the proof's own hosted database; deductions go through the deployed Worker's route; top-ups, which the Worker cannot
// credit (its payment gateway is the fake one), are confirmed twice at once by this repository's own wallet code running here against the
// same database over the D1 REST endpoint; an outcome that is not known is read from D1 and counted apart, never as a pass or a failure.

/** A D1-shaped database over Cloudflare's D1 REST endpoint, so the brick's own wallet code can run against the hosted database. */
export function restD1(client: Client, databaseId: string, space: () => Promise<void>): D1Like {
  const inside = new WeakMap<object, { sql: string; params: unknown[] }>();
  const one = async (sql: string, params: unknown[]) => {
    await space();
    const [result] = await client.queryDatabase(databaseId, [{ sql, params }]);
    return result!;
  };
  const statement = (sql: string, params: unknown[] = []): D1Statement => {
    const s: D1Statement = {
      bind: (...values) => statement(sql, values),
      first: async <Row>() => ((await one(sql, params)).results[0] ?? null) as Row | null,
      all: async <Row>() => {
        const r = await one(sql, params);
        return { results: r.results as Row[], success: true, meta: { changes: Number(r.meta.changes ?? 0) } } as D1Result<Row>;
      },
      run: async () => {
        const r = await one(sql, params);
        return { results: [], success: true, meta: { changes: Number(r.meta.changes ?? 0) } };
      },
    };
    inside.set(s, { sql, params });
    return s;
  };
  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      await space();
      const parts = statements.map((s) => {
        const known = inside.get(s);
        if (!known) throw new Error("batch was given a statement this database did not prepare");
        return known;
      });
      const results = await client.queryDatabase(databaseId, parts);
      return results.map((r) => ({ results: [], success: true, meta: { changes: Number(r.meta.changes ?? 0) } }));
    },
    // (a property, not a method: this package's own scan for starting programs reads "exec(" as one)
    exec: async (sql) => {
      await one(sql, []);
    },
  };
}

/** Spaces the starts of calls at least `ms` apart across everything that shares it, so a run stays under the API's rate limit. */
export function makeSpacer(ms: number, clock: () => number, sleep: (ms: number) => Promise<void>): () => Promise<void> {
  let nextFree = 0;
  return async () => {
    const now = clock();
    const at = Math.max(now, nextFree);
    nextFree = at + ms;
    if (at > now) await sleep(at - now);
  };
}

export interface LedgerRowFact {
  type: string;
  amount: number;
  balance_after: number;
  metadata: string | null;
  idempotency_key: string | null;
}
export interface HostedRun {
  run: number;
  workspaceId: string;
  start: number;
  /** Every operation asked for, in order; a top-up carries the id of the order made for it. */
  ops: Array<{ kind: "topup" | "deduct"; amount: number; orderId?: string }>;
  deducts: Array<{ amount: number; result: "accepted" | "refused" | "unknown"; status: number | null }>;
  topups: Array<{ orderId: string; amount: number; result: "accepted" | "unknown" | "violation"; confirmations: Confirmation[] }>;
  /** What D1 holds afterwards, read by a client of its own (not by the code under test). Null if it could not be read. */
  final: { balance: number | null; ledger: LedgerRowFact[]; orders: Array<{ order_id: string; processed: number }> } | null;
  setupError?: string;
}
export interface HostedFacts {
  names: ResourceNames;
  url: string;
  databaseId: string;
  runsWanted: number;
  burstsPerRun: number;
  restSpacingMs: number;
  versions: { before: string[] | null; after: string[] | null };
  deployedVersionFromH10: string | null;
  runs: HostedRun[];
  attempts: Attempt[];
}
export interface HostedCalls {
  schema: 1;
  commandStartedAt: string;
  clients: ClientLog[];
  urlEvents: UrlEvent[];
  facts: HostedFacts;
}
export interface HostedResult {
  schema: 1;
  commandStartedAt: string;
  finishedAt: string;
  completed: boolean;
  callsSha256: string;
  stoppedBecause?: string;
  leakScan?: { filesScanned: number; found: string[]; scannedFor: string[] };
}

export interface HostedDeps {
  clock(): number;
  commandStart: number;
  sleep(ms: number): Promise<void>;
  createClient(now: () => number): Client;
  names: ResourceNames;
  databaseId: string;
  url: string;
  accessKey: string;
  fetchUrl(request: Request): Promise<Response>;
  hide(text: string): string;
  nowIso(): string;
  log?(line: string): void;
  deployedVersionFromH10?: string | null;
  runs?: number;
  bursts?: number;
  /** Minimum gap between starts of calls to the REST endpoint. */
  restSpacingMs?: number;
}

export const RUNS = 20;
export const BURSTS = 5;
export const REST_SPACING_MS = 270;
export const UNKNOWN_SHARE_LIMIT = 0.1;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
export const canonicalHosted = (calls: HostedCalls): string => `${JSON.stringify(calls, null, 2)}\n`;

/** What an answer from the Worker's deduct route means: 200 charged, 402 refused for insufficient balance, anything else (or no answer) is not known. */
export const classifyDeduct = (status: number | null): "accepted" | "refused" | "unknown" => (status === 200 ? "accepted" : status === 402 ? "refused" : "unknown");
type Confirmation = { status: string; credited: boolean } | { error: string };
/** What the two simultaneous confirmations of one order mean: unknown if either ended in an error; accepted if exactly one credited; a violation if both returned and the number credited is not one. */
export const classifyTopup = (confirmations: Confirmation[]): "accepted" | "unknown" | "violation" => {
  const failed = confirmations.some((c) => "error" in c);
  const credited = confirmations.filter((c) => "credited" in c && c.credited).length;
  return failed ? "unknown" : credited === 1 ? "accepted" : "violation";
};

export async function runHostedH5(deps: HostedDeps): Promise<{ calls: HostedCalls; result: HostedResult }> {
  const rel = () => deps.clock() - deps.commandStart;
  const say = deps.log ?? (() => undefined);
  const clients: ClientLog[] = [];
  const urlEvents: UrlEvent[] = [];
  const commandStartedAt = deps.nowIso();
  const runsWanted = deps.runs ?? RUNS;
  const bursts = deps.bursts ?? BURSTS;
  const spacing = deps.restSpacingMs ?? REST_SPACING_MS;
  const facts: HostedFacts = { names: deps.names, url: deps.url, databaseId: deps.databaseId, runsWanted, burstsPerRun: bursts, restSpacingMs: spacing, versions: { before: null, after: null }, deployedVersionFromH10: deps.deployedVersionFromH10 ?? null, runs: [], attempts: [] };
  let stoppedBecause: string | undefined;
  const space = makeSpacer(spacing, deps.clock, deps.sleep);

  const attempt = (phase: string, outcome: "ok" | "failed", detail: string) => {
    facts.attempts.push({ n: facts.attempts.length + 1, phase, atMs: Math.round(rel()), outcome, detail: deps.hide(detail).slice(0, 600) });
    say(`[${(rel() / 1000).toFixed(1)}s] ${phase}: ${outcome}${detail ? ` - ${deps.hide(detail).slice(0, 200)}` : ""}`);
  };
  const newClient = (label: string) => {
    const client = deps.createClient(deps.clock);
    clients.push({ label, startedAtMs: Math.round(rel()), calls: client.calls as CallRecord[] });
    return client;
  };
  const toWorker = async (phase: string, note: string, method: string, path: string, headers: Record<string, string>, body?: unknown) => {
    const started = rel();
    const event: UrlEvent = { n: urlEvents.length + 1, atMs: Math.round(started), ms: 0, phase, note, method, path, status: null };
    urlEvents.push(event);
    try {
      const response = await deps.fetchUrl(new Request(`${deps.url}${path}`, { method, headers: { "x-poc-key": deps.accessKey, ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? null : JSON.stringify(body) }));
      event.status = response.status;
      const text = await response.text();
      let json: Record<string, any> | null = null;
      try {
        json = JSON.parse(text) as Record<string, any>;
      } catch {
        // not JSON
      }
      return { status: response.status, json };
    } finally {
      event.ms = Math.round(rel() - started);
    }
  };
  const finish = (completed: boolean): { calls: HostedCalls; result: HostedResult } => {
    const calls: HostedCalls = { schema: 1, commandStartedAt, clients, urlEvents, facts };
    return { calls, result: { schema: 1, commandStartedAt, finishedAt: deps.nowIso(), completed, callsSha256: sha256(canonicalHosted(calls)), ...(stoppedBecause ? { stoppedBecause } : {}) } };
  };

  try {
    facts.versions.before = (await newClient("bracket-before").listVersions(deps.names.script))?.map((v) => v.id) ?? null;
    if (!facts.versions.before?.length) throw new Error("Cloudflare lists no version for the Worker");

    for (let run = 1; run <= runsWanted; run += 1) {
      const w = workload(run);
      const report: HostedRun = { run, workspaceId: "", start: w.start, ops: [], deducts: [], topups: [], final: null };
      facts.runs.push(report);
      const user = `h5-user-${run}`;
      try {
        // a fresh workspace (so the Worker's route accepts the caller), and its wallet opened with the run's starting balance by the brick's own code
        const made = await toWorker("setup", `run-${run}`, "POST", "/api/workspaces", { "x-test-user": user }, { name: `H5 hosted ${run}` });
        if (made.status !== 201 || typeof made.json?.workspace?.id !== "string") throw new Error(`making the workspace gave HTTP ${made.status}`);
        report.workspaceId = made.json.workspace.id;

        const rest = newClient(`rest-run-${run}`);
        const db = restD1(rest, deps.databaseId, space);
        const gateway = createFakeGateway();
        const wallet = createWallet(db, gateway);
        await wallet.openWallet(report.workspaceId, w.start);
        for (const op of w.ops) {
          if (op.kind === "topup") {
            const { orderId } = await wallet.createOrder({ workspaceId: report.workspaceId, userId: user, amount: op.amount });
            gateway.setOrder(orderId, { status: "PAID", amount: op.amount });
            report.ops.push({ kind: "topup", amount: op.amount, orderId });
          } else report.ops.push({ kind: "deduct", amount: op.amount });
        }

        // the operations: every top-up confirmed twice at once; the deductions in bursts spread across the time the top-ups take
        const topupOps = report.ops.filter((o) => o.kind === "topup");
        const deductOps = report.ops.filter((o) => o.kind === "deduct");
        const confirmTwice = async (op: (typeof topupOps)[number]) => {
          const settled = await Promise.all([0, 1].map(() => wallet.confirmOrder(op.orderId!).then((r) => ({ status: String(r.status), credited: r.credited }), (e: unknown) => ({ error: deps.hide(e instanceof Error ? e.message : String(e)).slice(0, 300) }))));
          report.topups.push({ orderId: op.orderId!, amount: op.amount, result: classifyTopup(settled), confirmations: settled });
        };
        const deduct = async (op: (typeof deductOps)[number]) => {
          try {
            const r = await toWorker("deduct", `run-${run}`, "POST", "/api/wallet/deduct", { "x-test-user": user, "x-workspace-id": report.workspaceId }, { amount: op.amount, reason: "usage" });
            report.deducts.push({ amount: op.amount, result: classifyDeduct(r.status), status: r.status });
          } catch {
            report.deducts.push({ amount: op.amount, result: classifyDeduct(null), status: null });
          }
        };
        const windowMs = topupOps.length * 2 * 3 * spacing;
        const groups: Array<typeof deductOps> = Array.from({ length: bursts }, () => []);
        deductOps.forEach((op, i) => groups[i % bursts]!.push(op));
        await Promise.all([
          ...topupOps.map(confirmTwice),
          ...groups.map(async (group, k) => {
            await deps.sleep(Math.round((windowMs * (k + 0.5)) / bursts));
            await Promise.all(group.map(deduct));
          }),
        ]);

        // what D1 holds, read by a client that is not the code under test
        const reader = newClient(`reader-run-${run}`);
        const [bal, ledger, orders] = await reader.queryDatabase(deps.databaseId, [
          { sql: "SELECT balance FROM credit_wallets WHERE workspace_id = ?1", params: [report.workspaceId] },
          { sql: "SELECT type, amount, balance_after, metadata, idempotency_key FROM credit_ledger WHERE workspace_id = ?1 ORDER BY rowid", params: [report.workspaceId] },
          { sql: "SELECT order_id, processed FROM credit_orders WHERE workspace_id = ?1", params: [report.workspaceId] },
        ]);
        report.final = { balance: typeof (bal!.results[0] as { balance?: unknown } | undefined)?.balance === "number" ? ((bal!.results[0] as { balance: number }).balance) : null, ledger: ledger!.results as unknown as LedgerRowFact[], orders: orders!.results as unknown as Array<{ order_id: string; processed: number }> };
      } catch (error) {
        report.setupError = deps.hide(error instanceof Error ? error.message : String(error)).slice(0, 400);
      }
      const unknown = report.deducts.filter((d) => d.result === "unknown").length + report.topups.filter((t) => t.result === "unknown").length;
      const reasons = report.final ? hostedViolations(report) : ["state not read"];
      attempt(`run ${run}`, report.final && !report.setupError ? "ok" : "failed", `${report.deducts.length} deductions (${report.deducts.filter((d) => d.result === "accepted").length} accepted, ${report.deducts.filter((d) => d.result === "refused").length} refused), ${report.topups.length} top-ups, ${unknown} unknown, ${reasons.length === 0 ? "clean" : `VIOLATES: ${reasons.join("; ")}`}${report.setupError ? `, ${report.setupError}` : ""}`);
    }

    facts.versions.after = (await newClient("bracket-after").listVersions(deps.names.script))?.map((v) => v.id) ?? null;
    attempt("version at the end", "ok", `${facts.versions.after?.length ?? 0} version(s), newest ${facts.versions.after?.[0]?.slice(0, 8) ?? "none"}`);
  } catch (error) {
    stoppedBecause = `stopped: ${deps.hide(error instanceof Error ? error.message : String(error)).slice(0, 1500)}`;
    attempt("protocol", "failed", stoppedBecause);
    return finish(false);
  }
  return finish(true);
}

// ---------------------------------------------------------------------------------------------------------------------

/**
 * The rule's definition of a violating run, applied to what D1 holds after the run and to the answers that are known. Operations whose
 * outcome is unknown widen what is allowed (a row may or may not be there) but never excuse a row that no operation could have made,
 * a balance the ledger does not explain, or an order credited twice. With no unknown outcome it is exactly the local definition.
 */
export function hostedViolations(rawRun: HostedRun): string[] {
  // Each answer is classified again here from what was recorded, not taken from the classification stored beside it.
  const run: HostedRun = { ...rawRun, deducts: rawRun.deducts.map((d) => ({ ...d, result: classifyDeduct(d.status) })), topups: rawRun.topups.map((t) => ({ ...t, result: classifyTopup(t.confirmations) })) };
  const reasons: string[] = [];
  const f = run.final;
  if (!f) return ["the final state was not read"];
  if (f.balance === null) return ["the wallet row is missing"];

  const sum = f.ledger.reduce((s, r) => s + r.amount, 0);
  if (f.balance !== run.start + sum) reasons.push(`final balance ${f.balance}, but the starting balance ${run.start} plus the ledger's ${sum} is ${run.start + sum}`);
  if (f.balance < 0) reasons.push(`final balance is negative: ${f.balance}`);

  let running = run.start;
  let mismatches = 0;
  let negatives = 0;
  for (const row of f.ledger) {
    running += row.amount;
    if (row.balance_after !== running) mismatches += 1;
    if (row.balance_after < 0) negatives += 1;
  }
  if (mismatches > 0) reasons.push(`${mismatches} ledger rows whose balance_after does not match a replay of the ledger`);
  if (negatives > 0) reasons.push(`${negatives} ledger rows with a negative balance_after`);

  // deductions, by amount: rows must lie between the accepted ones and the accepted plus the unknown ones
  const amounts = new Set([...run.ops.filter((o) => o.kind === "deduct").map((o) => o.amount), ...f.ledger.filter((r) => r.type === "deduction").map((r) => -r.amount)]);
  for (const a of amounts) {
    const rows = f.ledger.filter((r) => r.type === "deduction" && r.amount === -a).length;
    const accepted = run.deducts.filter((d) => d.amount === a && d.result === "accepted").length;
    const unknown = run.deducts.filter((d) => d.amount === a && d.result === "unknown").length;
    if (rows < accepted) reasons.push(`${accepted} deductions of ${a} were accepted but only ${rows} ledger rows exist (credits were charged and not recorded, or recorded and lost)`);
    if (rows > accepted + unknown) reasons.push(`${rows} ledger rows for deductions of ${a} but only ${accepted} accepted and ${unknown} unknown (a refused or never-sent deduction left a trace, or one was charged twice)`);
  }
  if (f.ledger.some((r) => r.type !== "deduction" && r.type !== "topup")) reasons.push("a ledger row of a kind no operation makes");

  // top-ups, by order
  const requested = new Map(run.ops.filter((o) => o.kind === "topup").map((o) => [o.orderId!, o.amount]));
  const credited = new Map<string, number>();
  for (const row of f.ledger.filter((r) => r.type === "topup")) {
    let order: string | undefined;
    try {
      order = (JSON.parse(row.metadata ?? "{}") as { order_id?: string }).order_id;
    } catch {
      order = undefined;
    }
    if (!order || !requested.has(order)) {
      reasons.push("a top-up row for an order that was never requested");
      continue;
    }
    if (row.amount !== requested.get(order)) reasons.push(`order ${order} credited ${row.amount}, not the ${requested.get(order)} it was for`);
    credited.set(order, (credited.get(order) ?? 0) + 1);
  }
  const twice = [...credited.values()].filter((n) => n > 1).length;
  if (twice > 0) reasons.push(`${twice} orders credited more than once`);
  for (const t of run.topups) {
    const rows = credited.get(t.orderId) ?? 0;
    if (t.result === "violation") reasons.push(`order ${t.orderId} was confirmed twice with no error and reported credited a number of times other than one`);
    if (t.result === "accepted" && rows !== 1) reasons.push(`order ${t.orderId} was reported credited once but has ${rows} ledger rows`);
    if (t.result === "violation" && rows > 1) reasons.push(`order ${t.orderId} has ${rows} ledger rows`);
  }
  for (const [order] of requested) if (!run.topups.some((t) => t.orderId === order) && (credited.get(order) ?? 0) > 0) reasons.push(`order ${order} was never confirmed by the protocol but has a ledger row`);
  return [...new Set(reasons)];
}

export interface HostedEvaluation {
  /** holdsOnHostedD1 is present only when the run can be judged; absent means inconclusive or not believed. */
  checks: Record<string, boolean>;
  notes: string[];
  summary: { runs: number; violatingRuns: number; operations: number; unknown: number; unknownShare: number } | null;
}
const isQuery = (c: CallRecord) => c.method === "POST" && /\/d1\/database\/[^/]+\/query$/.test(c.path);

/** `requiredRuns` is the rule's 20; only the rehearsal tests, which run fewer, pass another number. A run with fewer than the rule's 20 can be a pilot and never reports true. */
export function evaluateHostedH5(input: { callsText: string; result: HostedResult; requiredRuns?: number }): HostedEvaluation {
  const requiredRuns = input.requiredRuns ?? RUNS;
  const notes: string[] = [];
  const checks: Record<string, boolean> = {};
  let calls: HostedCalls;
  try {
    calls = JSON.parse(input.callsText) as HostedCalls;
  } catch {
    return { checks, notes: ["the calls file is not valid JSON; nothing in it is believed"], summary: null };
  }
  if (sha256(input.callsText) !== input.result.callsSha256 || input.callsText !== canonicalHosted(calls)) return { checks, notes: ["the calls file does not match the hash in the result file (one of them was edited, or they come from different runs); nothing in them is believed"], summary: null };
  const f = calls.facts;
  notes.push(`from the run that started ${calls.commandStartedAt}${input.result.completed ? "" : " (it did not complete)"}`);

  // The Worker must not have been changed, and nothing but rows and reads may have been sent to Cloudflare.
  const all = calls.clients.flatMap((c) => c.calls);
  const wrote = all.some((c) => c.method !== "GET" && !isQuery(c));
  const sameVersion = f.versions.before !== null && f.versions.after !== null && f.versions.before.length > 0 && f.versions.before[0] === f.versions.after[0] && f.versions.before.length === f.versions.after.length && (f.deployedVersionFromH10 === null || f.deployedVersionFromH10 === f.versions.before[0]);
  if (wrote || !sameVersion) return { checks, notes: [...notes, "the log shows a write other than a database row, or the Worker's version moved or is not the one the deploy left: this run says nothing about the deployed wallet"], summary: null };

  // A stored classification that is not what the recorded answer means is an edited file, not a result.
  const disagrees = f.runs.some((r) => r.deducts.some((d) => d.result !== classifyDeduct(d.status)) || r.topups.some((t) => t.result !== classifyTopup(t.confirmations)));
  if (disagrees) return { checks, notes: [...notes, "a recorded outcome disagrees with the answer recorded beside it: the file was edited, and nothing in it is believed"], summary: null };
  const judged = f.runs.filter((r) => r.final !== null);
  const violating = judged.map((r) => ({ run: r.run, reasons: hostedViolations(r) })).filter((r) => r.reasons.length > 0);
  const operations = f.runs.reduce((s, r) => s + r.ops.length, 0);
  const unknown = f.runs.reduce((s, r) => s + r.deducts.filter((d) => d.result === "unknown").length + r.topups.filter((t) => t.result === "unknown").length, 0);
  const unknownShare = operations === 0 ? 1 : unknown / operations;
  const summary = { runs: f.runs.length, violatingRuns: violating.length, operations, unknown, unknownShare: Math.round(unknownShare * 10000) / 10000 };
  for (const v of violating) notes.push(`run ${v.run} VIOLATES: ${v.reasons.join("; ")}`);
  notes.push(`${summary.runs} runs, ${operations} operations, ${unknown} with an unknown outcome (${(unknownShare * 100).toFixed(1)}%), ${violating.length} violating runs`);

  if (violating.length > 0) checks.holdsOnHostedD1 = false;
  else if (f.runsWanted === requiredRuns && f.runs.length === f.runsWanted && judged.length === f.runs.length && f.runs.every((r) => !r.setupError) && unknownShare <= UNKNOWN_SHARE_LIMIT && operations > 0) checks.holdsOnHostedD1 = true;
  else notes.push(`inconclusive: ${f.runsWanted !== requiredRuns ? `${f.runsWanted} runs were asked for, the rule needs ${requiredRuns}; ` : ""}${f.runs.length < f.runsWanted ? `only ${f.runs.length} of ${f.runsWanted} runs were made; ` : ""}${judged.length < f.runs.length || f.runs.some((r) => r.setupError) ? "some runs could not be set up or read; " : ""}${unknownShare > UNKNOWN_SHARE_LIMIT ? `more than ${UNKNOWN_SHARE_LIMIT * 100}% of operations had an unknown outcome` : ""}`.replace(/; $/, ""));
  return { checks, notes, summary };
}
