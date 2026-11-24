import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parseHypotheses, verdict } from "@poc/harness";
import { createWalletClient } from "../../../../bricks/credit-wallet/client/wallet-client.ts";
import { GLUE_SCAN_FILES, SEED, SPEND, TOP_UP, canonical12, evaluateH12, formatCredits, runH12 } from "../../src/h12.ts";
import type { H12Calls, H12Result } from "../../src/h12.ts";
import { createRedactor, findSecrets } from "../../src/provisioner/index.ts";
import { mountCreditWidget } from "../support/widget-driver.tsx";
import { jsdomPageDriver } from "../support/page-driver.ts";
import { ACCOUNT, KEY, TOKEN, URL_BASE, names, rehearsalWorld } from "../support/rehearsal-world.ts";

// Story 5.7, rehearsed. The H12 protocol runs the real widget in jsdom against a stand-in for the deployed project (the same routes,
// the same access-key gate, the real demo page), then the files it wrote are re-read the way `pnpm poc:verify` re-reads them and
// every way of editing them is tried. The widget is driven only by looking at it and pressing Refresh.
// This file holds no network code of its own; the server side lives in ../support/rehearsal-world.ts.
const root = resolve(import.meta.dirname, "..", "..", "..", "..");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const h12 = parseHypotheses(JSON.parse(readFileSync(join(root, "hypotheses.json"), "utf8"))).hypotheses.find((h) => h.id === "H12")!;
const FOUR = ["widgetShowsLiveBalance", "balanceFollowsTheServer", "noGlueCode", "tenantBSeesOwnBalance"];

const sources = (): Record<string, string> => Object.fromEntries(GLUE_SCAN_FILES.map((p) => [p, readFileSync(join(root, p), "utf8")]));
const scanned = (): Record<string, string> => Object.fromEntries(Object.entries(sources()).map(([p, text]) => [p, sha(text)]));

let run: { calls: H12Calls; result: H12Result };
let lines: string[];
let world: Awaited<ReturnType<typeof rehearsalWorld>>;

beforeAll(async () => {
  world = await rehearsalWorld();
  lines = [];
  run = await runH12({
    clock: () => performance.now(),
    commandStart: performance.now(),
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
    widgetClient: (o) => createWalletClient({ baseUrl: o.baseUrl, workspaceId: o.workspaceId, headers: o.headers, fetch: o.send }),
    mount: mountCreditWidget,
    page: jsdomPageDriver(world.fetchUrl),
    scanned: scanned(),
  });
}, 180_000);
afterAll(() => world?.db.close());

const evaluate = (calls: H12Calls | string, result: H12Result, over: Record<string, string> = sources()) => evaluateH12({ callsText: typeof calls === "string" ? calls : canonical12(calls), result, sources: over });
const tampered = (edit: (c: H12Calls) => void) => {
  const calls = clone(run.calls);
  edit(calls);
  const text = canonical12(calls);
  return evaluate(text, { ...run.result, callsSha256: sha(text) });
};
const obs = (c: H12Calls, step: string) => c.facts.observations.find((o) => o.step === step)!;

describe("a complete rehearsal", () => {
  test("every step ran and nothing stopped it", () => {
    expect(run.result.stoppedBecause).toBeUndefined();
    expect(run.result.completed).toBe(true);
    expect(run.calls.facts.observations.map((o) => o.step)).toEqual(["A: first view", "A: after spending through the API", "A: after creating an order that is not paid", "A: after a top-up", "B: first view", "B asks for A's wallet"]);
    expect(run.calls.facts.attempts.filter((a) => a.outcome === "failed")).toEqual([]);
  });

  test("two tenants with distinct non-zero balances, read back from D1, not taken from what was sent", () => {
    expect(run.calls.facts.seeds).toEqual({ A: SEED.A, B: SEED.B });
    expect(run.calls.facts.workspaces.A.id).not.toBe(run.calls.facts.workspaces.B.id);
  });

  test("the widget showed what the database held, at every step, in the number format it uses", () => {
    const f = run.calls.facts;
    expect(obs(run.calls, "A: first view").shown).toBe("1,234");
    expect(obs(run.calls, "A: after spending through the API").shown).toBe(formatCredits(SEED.A - SPEND));
    expect(obs(run.calls, "A: after creating an order that is not paid").shown).toBe(formatCredits(SEED.A - SPEND));
    expect(obs(run.calls, "A: after a top-up").shown).toBe(formatCredits(SEED.A - SPEND + TOP_UP));
    expect(obs(run.calls, "B: first view").shown).toBe("567");
    for (const o of f.observations.filter((x) => x.shown !== null)) expect(o.shown).toBe(formatCredits(o.restBalance!));
  });

  test("B asking for A's wallet is refused and the widget shows an error instead of A's number", () => {
    const cross = obs(run.calls, "B asks for A's wallet");
    expect(cross.shown).toBeNull();
    expect(cross.alert).toMatch(/Could not load your balance/);
    expect(JSON.stringify(cross)).not.toMatch(/1,234|1,034|1,534/);
    const refusals = run.calls.urlEvents.filter((e) => e.phase === "widget" && e.note === "B-asks-for-A");
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.every((e) => e.status === 403 || e.status === 404)).toBe(true);
  });

  test("the deployed top-up path cannot complete (the gateway never reports an order as paid), which is recorded, and the credit is added over REST", () => {
    const s = run.calls.facts.server;
    expect(s.createOrder).toMatchObject({ status: 200, hasOrderId: true });
    expect(s.verifyUnpaid).toMatchObject({ credited: false });
    expect(s.topUp).toMatchObject({ via: "d1-rest", amount: TOP_UP });
    expect(s.spend).toMatchObject({ status: 200, balanceAfter: SEED.A - SPEND });
  });

  test("the widget's own requests used the access key and the stub user, and went to the API only", () => {
    const widget = run.calls.urlEvents.filter((e) => e.phase === "widget");
    expect(widget.length).toBeGreaterThan(8);
    expect(widget.every((e) => e.path === "/api/wallet" || e.path === "/api/wallet/history")).toBe(true);
    expect(widget.every((e) => e.method === "GET")).toBe(true);
  });

  test("the deployed page itself, run in jsdom with the key in its address fragment, shows tenant A's balance", () => {
    expect(run.calls.facts.page).toMatchObject({ shown: formatCredits(SEED.A - SPEND + TOP_UP) });
    expect(run.calls.facts.page!.restBalance).toBe(SEED.A - SPEND + TOP_UP);
  });

  test("neither the token, the account id nor the access key is in the files or the lines printed", () => {
    expect(findSecrets(canonical12(run.calls) + JSON.stringify(run.result) + lines.join("\n"), { token: TOKEN, accountId: ACCOUNT, accessKey: KEY })).toEqual([]);
  });

  test("nothing but reads and database rows was sent to Cloudflare", () => {
    for (const c of run.calls.clients.flatMap((x) => x.calls)) expect(c.method === "GET" || /\/query$/.test(c.path)).toBe(true);
  });
});

describe("what the files say when re-read", () => {
  test("all four checks come out true, and the verdict is a pass", () => {
    const e = evaluate(run.calls, run.result);
    expect(e.checks).toEqual(Object.fromEntries(FOUR.map((n) => [n, true])));
    expect(verdict(h12, { checks: e.checks }).verdict).toBe("pass");
    expect(e.notes.join("\n")).toMatch(/payment check on an unpaid order said "ACTIVE"/);
    expect(e.notes.join("\n")).toMatch(/the owner's look at the page in a browser is recorded with their words and is not a check/);
  });

  test("a calls file edited without the hash being updated, or one that is not JSON, is not believed at all", () => {
    expect(evaluate(canonical12(run.calls).replace('"shown": "1,234"', '"shown": "9,999"'), run.result).checks).toEqual({});
    expect(evaluate("not json", run.result).notes.join(" ")).toMatch(/not valid JSON/);
    expect(evaluate(run.calls, { ...run.result, callsSha256: "0".repeat(64) }).checks).toEqual({});
  });

  test("a widget that showed something other than D1 held fails 'shows the live balance': a constant, a stale value, or the wrong tenant's", () => {
    for (const edit of [(c: H12Calls) => void (obs(c, "A: first view").shown = "1,000"), (c: H12Calls) => void (obs(c, "A: first view").restBalance = 1235), (c: H12Calls) => void (obs(c, "A: first view").alert = "x"), (c: H12Calls) => void (obs(c, "A: first view").history = [])]) {
      expect(tampered(edit).checks.widgetShowsLiveBalance).toBe(false);
    }
  });

  test("a widget that is not shown to have asked the server, or whose requests were refused, does not show a live balance", () => {
    expect(tampered((c) => void (c.urlEvents = c.urlEvents.filter((e) => !(e.phase === "widget" && e.note === "A")))).checks.widgetShowsLiveBalance).toBe(false);
    expect(tampered((c) => void (c.urlEvents.find((e) => e.phase === "widget" && e.note === "A")!.status = 500)).checks.widgetShowsLiveBalance).toBe(false);
  });

  test("seeds that are zero or equal fail both 'live balance' and 'tenant B sees its own'", () => {
    for (const seeds of [{ A: 0, B: 567 }, { A: 1234, B: 1234 }, { A: 1234, B: 0 }, { A: null, B: 567 }] as const) {
      const e = tampered((c) => void (c.facts.seeds = { ...seeds } as never));
      expect(e.checks.tenantBSeesOwnBalance ?? false, JSON.stringify(seeds)).toBe(false);
      expect(e.checks.widgetShowsLiveBalance ?? false, JSON.stringify(seeds)).toBe(false);
    }
  });

  test("a widget that did not follow the server fails: not down after the spend, changed when nothing changed, not up after the top-up", () => {
    for (const edit of [
      (c: H12Calls) => void (obs(c, "A: after spending through the API").shown = obs(c, "A: first view").shown),
      (c: H12Calls) => void (obs(c, "A: after creating an order that is not paid").shown = "5"),
      (c: H12Calls) => void (obs(c, "A: after a top-up").shown = obs(c, "A: after creating an order that is not paid").shown),
      (c: H12Calls) => void (obs(c, "A: after a top-up").restBalance = 1),
      (c: H12Calls) => void (c.facts.server.spend!.balanceAfter = 5),
      (c: H12Calls) => void (c.facts.server.spend!.status = 402),
      (c: H12Calls) => void (c.facts.server.topUp = null),
      (c: H12Calls) => void (c.facts.server.createOrder!.status = 500),
    ]) {
      expect(tampered(edit).checks.balanceFollowsTheServer ?? false).toBe(false);
    }
  });

  test("a tenant B that sees A's number, a different number from its seed, or A's wallet when it asked for it, fails", () => {
    for (const edit of [
      (c: H12Calls) => void (obs(c, "B: first view").shown = "1,234"),
      (c: H12Calls) => void (obs(c, "B: first view").shown = "568"),
      (c: H12Calls) => void (obs(c, "B: first view").restBalance = 568),
      (c: H12Calls) => void (obs(c, "B asks for A's wallet").shown = "1,534"),
      (c: H12Calls) => void (obs(c, "B asks for A's wallet").alert = "could not load 1,534"),
      (c: H12Calls) => void (obs(c, "B asks for A's wallet").alert = null),
      (c: H12Calls) => void (c.urlEvents.filter((e) => e.note === "B-asks-for-A").forEach((e) => (e.status = 200))),
      (c: H12Calls) => void (obs(c, "B: first view").history = ["x: +1,034 (balance 1,034)"]),
    ]) {
      expect(tampered(edit).checks.tenantBSeesOwnBalance ?? false).toBe(false);
    }
  });

  test("network code in the page, the widget or a test that mounts it fails 'no glue code'; a mention in a comment or a string does not", () => {
    const base = sources();
    const stamped = (over: Record<string, string>) => ({ ...run.result, scanned: Object.fromEntries(Object.entries(over).map(([p, t]) => [p, sha(t)])) });
    for (const file of GLUE_SCAN_FILES) {
      for (const bad of ["const r = fe" + "tch(\"/api\");", "new XMLHttp" + "Request()", "navigator.send" + "Beacon(u)"]) {
        const over = { ...base, [file]: `${base[file]}\n${bad}\n` };
        // as scanned, with the hashes brought up to date: the network code is found, and the check is false (a kill)
        expect(evaluate(run.calls, stamped(over), over).checks.noGlueCode, `${file} ${bad}`).toBe(false);
        // the file no longer matches what the run scanned: the check is not reported at all (a fail, never a kill)
        expect("noGlueCode" in evaluate(run.calls, run.result, over).checks, `${file} ${bad}`).toBe(false);
      }
      const commented = { ...base, [file]: `${base[file]}\n// there is no fe` + `tch( call here\n` };
      expect(evaluate(run.calls, stamped(commented), commented).checks.noGlueCode, `${file}: a mention in a comment is not a call`).toBe(true);
      expect("noGlueCode" in evaluate(run.calls, run.result, commented).checks, `${file}: any edit after the run leaves the check unreported`).toBe(false);
    }
    expect(verdict(h12, { checks: { widgetShowsLiveBalance: true, balanceFollowsTheServer: true, tenantBSeesOwnBalance: true } }).verdict).toBe("fail");
  });

  test("a scan that covered fewer files than it should have, or none, is not reported", () => {
    const base = sources();
    const fewer = Object.fromEntries(Object.entries(base).slice(1));
    expect("noGlueCode" in evaluate(run.calls, run.result, fewer).checks).toBe(false);
    expect("noGlueCode" in evaluate(run.calls, run.result, {}).checks).toBe(false);
    expect("noGlueCode" in evaluate(run.calls, { ...run.result, scanned: {} }).checks).toBe(false);
  });
  test("a run that wrote anything but rows, or whose Worker moved, or is not the one the deploy left, says nothing and is not believed", () => {
    for (const edit of [
      (c: H12Calls) => void c.clients[0]!.calls.push({ n: 99, atMs: 0, method: "PUT", path: "/accounts/{account}/workers/scripts/x", status: 200, ms: 1, outcome: "ok", attempt: 1 }),
      (c: H12Calls) => void (c.facts.versions.after = ["another"]),
      (c: H12Calls) => void (c.facts.versions.before = null),
      (c: H12Calls) => void (c.facts.deployedVersionFromH10 = "not-this-one"),
    ]) {
      const e = tampered(edit);
      expect(e.checks).toEqual({});
      expect(e.notes.join(" ")).toMatch(/says nothing about the deployed page and widget/);
    }
  });

  test("the kill rule: any of the first three false is a kill, a false tenant check is a fail", () => {
    const base = Object.fromEntries(FOUR.map((n) => [n, true]));
    for (const name of ["widgetShowsLiveBalance", "balanceFollowsTheServer", "noGlueCode"]) expect(verdict(h12, { checks: { ...base, [name]: false } }).verdict, name).toBe("kill");
    expect(verdict(h12, { checks: { ...base, tenantBSeesOwnBalance: false } }).verdict).toBe("fail");
    expect(verdict(h12, { checks: { widgetShowsLiveBalance: true } }).verdict).toBe("fail");
  });
});
