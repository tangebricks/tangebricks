import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { parseHypotheses, verdict } from "@poc/harness";
import { BURSTS, REST_SPACING_MS, RUNS, UNKNOWN_SHARE_LIMIT, canonicalHosted, classifyDeduct, classifyTopup, evaluateHostedH5, hostedViolations, makeSpacer, restD1, runHostedH5 } from "../src/h5-hosted.ts";
import type { HostedCalls, HostedDeps, HostedResult, HostedRun } from "../src/h5-hosted.ts";
import { createRedactor, findSecrets } from "../src/provisioner/index.ts";
import type { Breaks } from "../client/support/rehearsal-world.ts";
import { ACCOUNT, KEY, TOKEN, URL_BASE, names, rehearsalWorld } from "../client/support/rehearsal-world.ts";

// Story 5.8, rehearsed. The hosted protocol runs against a stand-in for the deployed project (the same routes and gate, Node's SQLite
// instead of D1, the REST endpoint played by a bridge to the same database), then its files are re-read the way `pnpm poc:verify`
// re-reads them and every way of editing them is tried. The stand-in's database runs one statement at a time, so this shows the
// protocol, the adapter and the judging are right; only the real run shows what Cloudflare's D1 does under overlap.
const root = resolve(import.meta.dirname, "..", "..", "..");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const h5 = parseHypotheses(JSON.parse(readFileSync(join(root, "hypotheses.json"), "utf8"))).hypotheses.find((h) => h.id === "H5")!;
const LOCAL_CHECKS = { controlLosesUpdates: true, orderCreditedOnce: true, insufficientRefusesUnchanged: true, graphDeductChangesBalanceOnce: true, portedTestsPass: true };
const SMALL = { runs: 4, bursts: 2, restSpacingMs: 1 };

async function hosted(breaks: Breaks = {}, over: Partial<HostedDeps> = {}) {
  const world = await rehearsalWorld(breaks);
  const lines: string[] = [];
  const { calls, result } = await runHostedH5({
    clock: () => performance.now(),
    commandStart: performance.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 3))),
    createClient: (now) => world.cloudflareClient(now),
    names,
    databaseId: "db-1",
    url: URL_BASE,
    accessKey: KEY,
    fetchUrl: world.fetchUrl,
    hide: createRedactor([TOKEN, ACCOUNT, KEY]),
    nowIso: () => "2026-10-21T00:00:00.000Z",
    log: (line) => lines.push(line),
    deployedVersionFromH10: null,
    ...SMALL,
    ...over,
  });
  return { world, calls, result, lines };
}
const evaluate = (calls: HostedCalls | string, result: HostedResult, requiredRuns: number = SMALL.runs) => evaluateHostedH5({ callsText: typeof calls === "string" ? calls : canonicalHosted(calls), result, requiredRuns });

let clean: Awaited<ReturnType<typeof hosted>>;
beforeAll(async () => {
  clean = await hosted();
}, 120_000);
const tampered = (edit: (c: HostedCalls) => void) => {
  const calls = clone(clean.calls);
  edit(calls);
  const text = canonicalHosted(calls);
  return evaluate(text, { ...clean.result, callsSha256: sha(text) });
};
type Edit = (c: HostedCalls) => void;
const run1 = (c: HostedCalls): HostedRun => c.facts.runs[0]!;

describe("the adapter and the protocol, on a clean rehearsal", () => {
  test("every run was made, none stopped it, and the numbers are the local sweep's workloads", () => {
    expect(clean.result.completed).toBe(true);
    expect(clean.result.stoppedBecause).toBeUndefined();
    expect(clean.calls.facts.runs).toHaveLength(SMALL.runs);
    expect(clean.calls.facts.runs.map((r) => r.ops.length)).toEqual([50, 50, 50, 50]);
    expect(clean.calls.facts.runs.every((r) => r.workspaceId !== "")).toBe(true);
    expect(new Set(clean.calls.facts.runs.map((r) => r.workspaceId)).size).toBe(SMALL.runs);
  });

  test("the brick's own wallet code ran through the adapter: each order was confirmed twice at once and credited exactly once", () => {
    for (const r of clean.calls.facts.runs) {
      expect(r.topups.length).toBeGreaterThan(5);
      for (const t of r.topups) {
        expect(t.result).toBe("accepted");
        expect(t.confirmations).toHaveLength(2);
        expect(t.confirmations.filter((c) => "credited" in c && c.credited)).toHaveLength(1);
        expect(r.final!.ledger.filter((row) => row.type === "topup" && JSON.parse(row.metadata ?? "{}").order_id === t.orderId)).toHaveLength(1);
      }
    }
  });

  test("the second confirmation of an order is refused by the database itself, not by a check in the adapter", () => {
    const statuses = clean.calls.facts.runs.flatMap((r) => r.topups.flatMap((t) => t.confirmations.map((c) => ("status" in c ? c.status : "error"))));
    expect(statuses).toContain("PAID");
    expect(statuses.some((s) => s === "already_processed")).toBe(true);
  });

  test("deductions went through the Worker's route and were accepted or refused for insufficient balance, none unknown", () => {
    const all = clean.calls.facts.runs.flatMap((r) => r.deducts);
    expect(all.length).toBeGreaterThan(40);
    expect(all.every((d) => d.result === "accepted" || d.result === "refused")).toBe(true);
    const events = clean.calls.urlEvents.filter((e) => e.phase === "deduct");
    expect(events).toHaveLength(all.length);
    expect(events.every((e) => e.path === "/api/wallet/deduct" && e.method === "POST")).toBe(true);
  });

  test("what D1 holds was read by a client of its own, and every run is clean by the rule's definition", () => {
    for (const r of clean.calls.facts.runs) {
      expect(clean.calls.clients.some((c) => c.label === `reader-run-${r.run}`)).toBe(true);
      expect(hostedViolations(r)).toEqual([]);
      const accepted = r.deducts.filter((d) => d.result === "accepted").length + r.topups.filter((t) => t.result === "accepted").length;
      expect(r.final!.ledger).toHaveLength(accepted);
    }
  });

  test("the wallet's start is the workload's start, as locally", () => {
    expect(clean.calls.facts.runs.map((r) => r.start)).toEqual([1, 2, 3, 4].map((run) => clean.calls.facts.runs[run - 1]!.start));
    expect(clean.calls.facts.runs.every((r) => r.start >= 0 && r.start < 40)).toBe(true);
  });

  test("the Worker's version was read before and after and is unchanged; nothing but reads and database rows went to Cloudflare", () => {
    expect(clean.calls.facts.versions.before).toEqual(clean.calls.facts.versions.after);
    for (const c of clean.calls.clients.flatMap((x) => x.calls)) expect(c.method === "GET" || /\/query$/.test(c.path)).toBe(true);
  });

  test("neither the token, the account id nor the access key is in the files or the lines printed", () => {
    expect(findSecrets(canonicalHosted(clean.calls) + JSON.stringify(clean.result) + clean.lines.join("\n"), { token: TOKEN, accountId: ACCOUNT, accessKey: KEY })).toEqual([]);
  });

  test("the rule's constants are the ones the rule states", () => {
    expect([RUNS, BURSTS, UNKNOWN_SHARE_LIMIT]).toEqual([20, 5, 0.1]);
    expect(REST_SPACING_MS * 4).toBeGreaterThan(1000); // under 4 calls a second, Cloudflare's limit being 1200 in 5 minutes
    expect(REST_SPACING_MS).toBeLessThanOrEqual(300);
  });
});

describe("what the files say when re-read", () => {
  test("a clean rehearsal reports holdsOnHostedD1 true, and with the local checks gives H5 a pass", () => {
    const e = evaluate(clean.calls, clean.result);
    expect(e.checks).toEqual({ holdsOnHostedD1: true });
    expect(e.summary).toMatchObject({ runs: SMALL.runs, violatingRuns: 0, unknown: 0, unknownShare: 0 });
    expect(verdict(h5, { measured: 0, checks: { ...LOCAL_CHECKS, ...e.checks } }).verdict).toBe("pass");
  });

  test("not reported, H5 passes and says the extra check has not been run; reported false, it is a kill", () => {
    const withoutIt = verdict(h5, { measured: 0, checks: LOCAL_CHECKS });
    expect(withoutIt.verdict).toBe("pass");
    expect(withoutIt.reasons.join(" ")).toMatch(/extra check not yet run: holdsOnHostedD1/);
    expect(verdict(h5, { measured: 0, checks: { ...LOCAL_CHECKS, holdsOnHostedD1: false } }).verdict).toBe("kill");
  });

  test("an edited calls file, or a hash that points at another one, is not believed at all", () => {
    expect(evaluate(canonicalHosted(clean.calls).replace('"balance":', '"balanceX":'), clean.result).checks).toEqual({});
    expect(evaluate(clean.calls, { ...clean.result, callsSha256: "0".repeat(64) }).checks).toEqual({});
    expect(evaluate("not json", clean.result).notes.join(" ")).toMatch(/not valid JSON/);
  });

  const violations: Array<[string, Edit, RegExp]> = [
    ["a balance that is not start plus the ledger", (c: HostedCalls) => void (run1(c).final!.balance! += 1), /final balance .* but the starting balance/],
    ["a negative balance", (c: HostedCalls) => void (run1(c).final!.balance = -3), /negative/],
    ["a ledger row lost (an accepted deduction without its row)", (c: HostedCalls) => void run1(c).final!.ledger.splice(run1(c).final!.ledger.findIndex((r) => r.type === "deduction"), 1), /accepted but only|does not match a replay|final balance/],
    ["a deduction row invented", (c: HostedCalls) => void run1(c).final!.ledger.push({ type: "deduction", amount: -3, balance_after: 0, metadata: "{}", idempotency_key: null }), /ledger rows for deductions of 3|final balance|replay/],
    ["a balance_after that a replay does not reproduce", (c: HostedCalls) => void (run1(c).final!.ledger[0]!.balance_after += 7), /does not match a replay/],
    ["a negative balance_after", (c: HostedCalls) => void (run1(c).final!.ledger[0]!.balance_after = -1), /negative balance_after|replay/],
    ["an order credited twice", (c: HostedCalls) => void run1(c).final!.ledger.push({ ...run1(c).final!.ledger.find((r) => r.type === "topup")! }), /orders credited more than once|final balance/],
    ["an order credited for another amount", (c: HostedCalls) => void (run1(c).final!.ledger.find((r) => r.type === "topup")!.amount += 1), /credited .*, not the/],
    ["a top-up row for an order nobody asked for", (c: HostedCalls) => void (run1(c).final!.ledger.find((r) => r.type === "topup")!.metadata = JSON.stringify({ order_id: "order_nobody" })), /never requested/],
    ["an accepted top-up with no row", (c: HostedCalls) => void run1(c).final!.ledger.splice(run1(c).final!.ledger.findIndex((r) => r.type === "topup"), 1), /reported credited once but has 0|final balance|replay/],
    ["a top-up confirmed twice that did not credit exactly once", (c: HostedCalls) => void ((run1(c).topups[0]!.result = "violation"), (run1(c).topups[0]!.confirmations = [{ status: "PAID", credited: true }, { status: "PAID", credited: true }])), /confirmed twice with no error/],
    ["a refused deduction that left a trace", (c: HostedCalls) => void ((run1(c).deducts.find((d) => d.result === "accepted")!.result = "refused"), (run1(c).deducts.find((d) => d.result === "refused")!.status = 402)), /ledger rows for deductions of/],
    ["a ledger row of a kind no operation makes", (c: HostedCalls) => void (run1(c).final!.ledger[0]!.type = "refund"), /kind no operation makes|final balance|replay/],
    ["a wallet that is gone", (c: HostedCalls) => void (run1(c).final!.balance = null), /wallet row is missing/],
  ];
  test.each(violations)("%s is a violation, so holdsOnHostedD1 is false (a kill of H5)", (_name, edit, reason) => {
    const e = tampered(edit);
    expect(e.checks.holdsOnHostedD1).toBe(false);
    expect(e.notes.join(" | ")).toMatch(reason);
    expect(verdict(h5, { measured: 0, checks: { ...LOCAL_CHECKS, ...e.checks } }).verdict).toBe("kill");
  });

  test("a state that was not read leaves the run unjudged, which is inconclusive and never a pass", () => {
    const e = tampered((c) => void (run1(c).final = null));
    expect("holdsOnHostedD1" in e.checks).toBe(false);
    expect(e.notes.join(" ")).toMatch(/inconclusive/);
  });

  test("fewer runs than wanted, or a run that could not be set up, is inconclusive", () => {
    expect("holdsOnHostedD1" in tampered((c) => void c.facts.runs.pop()).checks).toBe(false);
    expect("holdsOnHostedD1" in tampered((c) => void (run1(c).setupError = "boom")).checks).toBe(false);
  });

  test("a run that wrote to anything but rows, or whose Worker moved, or is not the deploy's, says nothing", () => {
    for (const edit of [
      (c: HostedCalls) => void c.clients[0]!.calls.push({ n: 99, atMs: 0, method: "PUT", path: "/accounts/{account}/workers/scripts/x", status: 200, ms: 1, outcome: "ok", attempt: 1 }),
      (c: HostedCalls) => void (c.facts.versions.after = ["other"]),
      (c: HostedCalls) => void (c.facts.versions.before = null),
      (c: HostedCalls) => void (c.facts.deployedVersionFromH10 = "not-this-one"),
    ]) {
      const e = tampered(edit);
      expect(e.checks).toEqual({});
      expect(e.notes.join(" ")).toMatch(/says nothing about the deployed wallet/);
    }
  });
});

// Hand-built runs, so each rule of the definition is tried on its own: every damage below satisfies all the other rules.
const ok = (balance: number, ledger: HostedRun["final"] extends infer F ? (F extends { ledger: infer L } ? L : never) : never, over: Partial<HostedRun> = {}): HostedRun => ({
  run: 1,
  workspaceId: "w",
  start: 10,
  ops: [],
  deducts: [],
  topups: [],
  final: { balance, ledger, orders: [] },
  ...over,
});
const dedRow = (amount: number, balanceAfter: number) => ({ type: "deduction", amount: -amount, balance_after: balanceAfter, metadata: "{}", idempotency_key: null });
const topRow = (order: string, amount: number, balanceAfter: number) => ({ type: "topup", amount, balance_after: balanceAfter, metadata: JSON.stringify({ order_id: order }), idempotency_key: `order:${order}` });
const credited = { status: "PAID", credited: true };
const already = { status: "already_processed", credited: false };

describe("each rule of the definition, on its own", () => {
  test("a run that is consistent in every respect is clean (the base the damage below is made from)", () => {
    expect(hostedViolations(ok(7, [dedRow(3, 7)], { deducts: [{ amount: 3, result: "accepted", status: 200 }], ops: [{ kind: "deduct", amount: 3 }] }))).toEqual([]);
    expect(hostedViolations(ok(15, [topRow("o1", 5, 15)], { topups: [{ orderId: "o1", amount: 5, result: "accepted", confirmations: [credited, already] }], ops: [{ kind: "topup", amount: 5, orderId: "o1" }] }))).toEqual([]);
    expect(hostedViolations(ok(10, []))).toEqual([]);
  });

  test("story 2.5: a run in thousandths (scale 1000) is judged with the workload's amounts scaled up, in integers", () => {
    const run = ok(7_000, [dedRow(3_000, 7_000)], { scale: 1000, deducts: [{ amount: 3, result: "accepted", status: 200 }], ops: [{ kind: "deduct", amount: 3 }] });
    expect(hostedViolations(run)).toEqual([]);
    // A row of an amount no operation asked for (here 3 thousandths, not 3 credits) is a violation.
    const stray = ok(9_997, [dedRow(3, 9_997)], { scale: 1000, ops: [{ kind: "deduct", amount: 3 }], deducts: [{ amount: 3, result: "refused", status: 402 }] });
    expect(hostedViolations(stray).join("|")).toMatch(/1 ledger rows for deductions of an amount no operation asked for/);
  });

  test("story 2.5: a scale other than absent, 1 or 1000 is not believed", () => {
    for (const scale of [0, 10, 1000.5, -1000, "1000" as unknown as number]) {
      expect(hostedViolations(ok(10, [], { scale }))).toEqual([expect.stringMatching(/unknown scale/)]);
    }
    expect(tampered((c) => void (c.facts.runs[0]!.scale = 100)).checks).toEqual({});
  });

  test("a row whose balance_after is negative in the middle of the run is a violation even when the replay is consistent and the final balance is not negative", () => {
    const run = ok(10, [dedRow(15, -5), topRow("o1", 15, 10)], {
      deducts: [{ amount: 15, result: "accepted", status: 200 }],
      topups: [{ orderId: "o1", amount: 15, result: "accepted", confirmations: [credited, already] }],
      ops: [{ kind: "deduct", amount: 15 }, { kind: "topup", amount: 15, orderId: "o1" }],
    });
    expect(hostedViolations(run)).toEqual(["1 ledger rows with a negative balance_after"]);
  });

  test("a deduction that was accepted but has no row is a violation even when the balance and the replay are consistent", () => {
    const run = ok(10, [], { deducts: [{ amount: 3, result: "accepted", status: 200 }], ops: [{ kind: "deduct", amount: 3 }] });
    expect(hostedViolations(run).join(" ")).toMatch(/1 deductions of 3 were accepted but only 0 ledger rows/);
  });

  test("a deduction that was refused but left a row is a violation", () => {
    const run = ok(7, [dedRow(3, 7)], { deducts: [{ amount: 3, result: "refused", status: 402 }], ops: [{ kind: "deduct", amount: 3 }] });
    expect(hostedViolations(run).join(" ")).toMatch(/but only 0 accepted and 0 unknown/);
  });

  test("a deduction whose outcome is unknown may have a row or not, but not two", () => {
    const unknown = { amount: 3, result: "unknown" as const, status: 502 };
    expect(hostedViolations(ok(10, [], { deducts: [unknown], ops: [{ kind: "deduct", amount: 3 }] }))).toEqual([]);
    expect(hostedViolations(ok(7, [dedRow(3, 7)], { deducts: [unknown], ops: [{ kind: "deduct", amount: 3 }] }))).toEqual([]);
    expect(hostedViolations(ok(4, [dedRow(3, 7), dedRow(3, 4)], { deducts: [unknown], ops: [{ kind: "deduct", amount: 3 }] })).join(" ")).toMatch(/2 ledger rows for deductions of 3 but only 0 accepted and 1 unknown/);
  });

  test("an order credited twice is a violation even when its outcome is unknown and the balance and replay are consistent", () => {
    const run = ok(20, [topRow("o1", 5, 15), topRow("o1", 5, 20)], { topups: [{ orderId: "o1", amount: 5, result: "unknown", confirmations: [{ error: "lost" }, credited] }], ops: [{ kind: "topup", amount: 5, orderId: "o1" }] });
    expect(hostedViolations(run)).toEqual(["1 orders credited more than once"]);
  });

  test("an order reported credited once but with no row is a violation even when the balance and replay are consistent", () => {
    const run = ok(10, [], { topups: [{ orderId: "o1", amount: 5, result: "accepted", confirmations: [credited, already] }], ops: [{ kind: "topup", amount: 5, orderId: "o1" }] });
    expect(hostedViolations(run)).toEqual(["order o1 was reported credited once but has 0 ledger rows"]);
  });

  test("a top-up whose outcome is unknown may have a row or not", () => {
    const unknown = { orderId: "o1", amount: 5, result: "unknown" as const, confirmations: [{ error: "lost" }, already] as never };
    expect(hostedViolations(ok(10, [], { topups: [unknown], ops: [{ kind: "topup", amount: 5, orderId: "o1" }] }))).toEqual([]);
    expect(hostedViolations(ok(15, [topRow("o1", 5, 15)], { topups: [unknown], ops: [{ kind: "topup", amount: 5, orderId: "o1" }] }))).toEqual([]);
  });

  test("an order confirmed twice with no error that credits it twice, or not at all, is a violation by the answers alone", () => {
    for (const confirmations of [[credited, credited], [already, already]]) {
      const run = ok(10, [], { topups: [{ orderId: "o1", amount: 5, result: "violation", confirmations }], ops: [{ kind: "topup", amount: 5, orderId: "o1" }] });
      expect(hostedViolations(run).join(" ")).toMatch(/confirmed twice with no error/);
    }
  });
});

describe("what each answer means", () => {
  test.each([[200, "accepted"], [402, "refused"], [500, "unknown"], [502, "unknown"], [401, "unknown"], [404, "unknown"], [201, "unknown"], [null, "unknown"]] as const)("a deduction answered %s is %s", (status, meaning) => {
    expect(classifyDeduct(status)).toBe(meaning);
  });

  test("two confirmations: one credited and one not is accepted; an error in either is unknown whatever the other said; any other count with no error is a violation", () => {
    expect(classifyTopup([credited, already])).toBe("accepted");
    expect(classifyTopup([already, credited])).toBe("accepted");
    expect(classifyTopup([{ error: "x" }, credited])).toBe("unknown");
    expect(classifyTopup([credited, { error: "x" }])).toBe("unknown");
    expect(classifyTopup([{ error: "x" }, { error: "y" }])).toBe("unknown");
    expect(classifyTopup([credited, credited])).toBe("violation");
    expect(classifyTopup([already, already])).toBe("violation");
  });

  test("hostedViolations judges the recorded answers, whatever classification is stored beside them", () => {
    const ops = [{ kind: "deduct" as const, amount: 3 }];
    expect(hostedViolations(ok(10, [], { ops, deducts: [{ amount: 3, result: "accepted", status: 500 }] }))).toEqual([]); // a 500 is unknown, so no row is fine
    expect(hostedViolations(ok(10, [], { ops, deducts: [{ amount: 3, result: "unknown", status: 200 }] })).join(" ")).toMatch(/accepted but only 0/); // a 200 is accepted
  });

  test("a stored classification that is not what the recorded answer means is an edited file and is not believed", () => {
    for (const edit of [
      (c: HostedCalls) => void (run1(c).deducts.find((d) => d.result === "refused" || d.result === "accepted")!.status = 500),
      (c: HostedCalls) => void (run1(c).deducts[0]!.result = run1(c).deducts[0]!.result === "accepted" ? "unknown" : "accepted"),
      (c: HostedCalls) => void (run1(c).topups[0]!.result = "unknown"),
      (c: HostedCalls) => void (run1(c).topups[0]!.confirmations = [{ status: "PAID", credited: true }, { status: "PAID", credited: true }]),
    ]) {
      const e = tampered(edit);
      expect(e.checks).toEqual({});
      expect(e.notes.join(" ")).toMatch(/disagrees with the answer recorded beside it/);
    }
  });
});
describe("outcomes that are not known", () => {
  test("a deduction whose answer was lost after the work was done, and one that never reached the Worker, are unknown and the run is still clean", async () => {
    let deducts = 0;
    const r = await hosted({
      worker: ({ path }) => {
        if (path !== "/api/wallet/deduct") return undefined;
        deducts += 1;
        return deducts === 3 ? "lose" : deducts === 8 ? "drop" : undefined;
      },
    });
    const all = r.calls.facts.runs.flatMap((x) => x.deducts);
    expect(all.filter((d) => d.result === "unknown")).toHaveLength(2);
    expect(all.filter((d) => d.result === "unknown").every((d) => d.status === 502)).toBe(true);
    const e = evaluate(r.calls, r.result);
    expect(e.summary).toMatchObject({ unknown: 2, violatingRuns: 0 });
    expect(e.checks).toEqual({ holdsOnHostedD1: true });
    for (const run of r.calls.facts.runs) expect(hostedViolations(run)).toEqual([]);
  });

  test("a top-up whose every confirmation was lost, and one whose first was lost after the credit, are unknown; each credited one has its row and the runs are clean", async () => {
    const seen: string[] = [];
    const lost = new Set<string>();
    const r = await hosted({
      rest: ({ sql, params }) => {
        if (!sql.includes("UPDATE credit_wallets SET balance_milli = balance_milli +")) return undefined;
        const order = /order_[0-9a-f]{16}/.exec(params)?.[0];
        if (!order) return undefined;
        if (!seen.includes(order)) seen.push(order);
        const index = seen.indexOf(order);
        if (index < 3) return "drop"; // every confirmation of the first three orders is dropped before it is carried out: never credited
        if (index < 6 && !lost.has(order)) {
          lost.add(order);
          return "lose"; // the first confirmation of the next three is carried out and its answer lost: credited, and nobody heard
        }
        return undefined;
      },
    });
    const tops = r.calls.facts.runs.flatMap((x) => x.topups.map((t) => ({ t, rows: x.final!.ledger.filter((row) => row.type === "topup" && JSON.parse(row.metadata ?? "{}").order_id === t.orderId).length })));
    const unknown = tops.filter((x) => x.t.result === "unknown");
    expect(unknown.length).toBe(6);
    expect(unknown.every((x) => x.t.confirmations.some((c) => "error" in c))).toBe(true);
    expect(unknown.filter((x) => x.rows === 0)).toHaveLength(3); // never credited
    expect(unknown.filter((x) => x.rows === 1)).toHaveLength(3); // credited though the first answer was lost
    const e = evaluate(r.calls, r.result);
    expect(e.summary).toMatchObject({ violatingRuns: 0, unknown: 6 });
    expect(e.checks).toEqual({ holdsOnHostedD1: true });
    for (const run of r.calls.facts.runs) expect(hostedViolations(run)).toEqual([]);
  });
  test("unknown outcomes widen what is allowed but never excuse an unexplained row: two rows for an unknown deduction is a violation", () => {
    const e = tampered((c) => {
      const run = run1(c);
      const d = run.deducts.find((x) => x.result === "accepted")!;
      d.result = "unknown";
      d.status = 502;
      const row = run.final!.ledger.find((x) => x.type === "deduction" && x.amount === -d.amount * (run.scale ?? 1))!;
      run.final!.ledger.push({ ...row });
      run.final!.balance! += row.amount;
    });
    expect(e.checks.holdsOnHostedD1).toBe(false);
  });

  test("more than a tenth unknown makes the run inconclusive: holdsOnHostedD1 stays unreported even though no run violates", async () => {
    const r = await hosted({ worker: ({ path }) => (path === "/api/wallet/deduct" ? "drop" : undefined) });
    const e = evaluate(r.calls, r.result);
    expect(e.summary!.unknownShare).toBeGreaterThan(UNKNOWN_SHARE_LIMIT);
    expect(e.summary!.violatingRuns).toBe(0);
    expect("holdsOnHostedD1" in e.checks).toBe(false);
    expect(e.notes.join(" ")).toMatch(/inconclusive.*more than 10% of operations had an unknown outcome/);
    expect(verdict(h5, { measured: 0, checks: LOCAL_CHECKS }).reasons.join(" ")).toMatch(/extra check not yet run: holdsOnHostedD1/);
  });

  test("a pilot with fewer runs than the rule's twenty never reports true, however clean", () => {
    const e = evaluate(clean.calls, clean.result, RUNS);
    expect("holdsOnHostedD1" in e.checks).toBe(false);
    expect(e.notes.join(" ")).toMatch(/4 runs were asked for, the rule needs 20/);
  });

  test("exactly a tenth unknown is allowed; just over is not", () => {
    const base = clone(clean.calls);
    const ops = base.facts.runs.reduce((s, r) => s + r.ops.length, 0);
    const allowed = Math.floor(ops * UNKNOWN_SHARE_LIMIT);
    const setUnknown = (calls: HostedCalls, count: number) => {
      let left = count;
      for (const run of calls.facts.runs) for (const d of run.deducts) if (left > 0) {
        d.result = "unknown";
        d.status = 502;
        left -= 1;
      }
    };
    const make = (count: number) => {
      const calls = clone(base);
      setUnknown(calls, count);
      const text = canonicalHosted(calls);
      return evaluate(text, { ...clean.result, callsSha256: sha(text) });
    };
    // marking accepted deductions unknown leaves their rows in place, which the rule allows, so only the share decides
    expect(make(allowed).checks.holdsOnHostedD1).toBe(true);
    expect("holdsOnHostedD1" in make(allowed + 1).checks).toBe(false);
  });
});

describe("pieces", () => {
  test("the spacer starts calls at least the gap apart, across everything that shares it", async () => {
    const starts: number[] = [];
    const space = makeSpacer(100, () => performance.now(), (ms) => new Promise((r) => setTimeout(r, ms)));
    await Promise.all([1, 2, 3, 4, 5].map(async () => {
      await space();
      starts.push(performance.now());
    }));
    starts.sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i += 1) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(80);
  });
  test("the adapter refuses a batch of statements it did not prepare", async () => {
    const world = await rehearsalWorld();
    const db = restD1(world.cloudflareClient(() => performance.now()), "db-1", async () => undefined);
    await expect(db.batch([{} as never])).rejects.toThrow(/did not prepare/);
  });

  test("the adapter carries the database's own error text, which is how the wallet tells a refused overdraw from a failure", async () => {
    const world = await rehearsalWorld();
    const db = restD1(world.cloudflareClient(() => performance.now()), "db-1", async () => undefined);
    await db.prepare("INSERT INTO credit_wallets (workspace_id, balance_milli) VALUES (?, ?)").bind("w", 1).run();
    await expect(db.batch([db.prepare("UPDATE credit_wallets SET balance_milli = balance_milli - ? WHERE workspace_id = ?").bind(5, "w")])).rejects.toThrow(/CHECK constraint failed: balance_milli >= 0/);
    expect((await db.prepare("SELECT balance_milli FROM credit_wallets WHERE workspace_id = ?").bind("w").first<{ balance_milli: number }>())!.balance_milli).toBe(1); // rolled back
  });
});
