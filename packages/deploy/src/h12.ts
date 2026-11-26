import { createHash } from "node:crypto";
import { codeLines } from "@poc/harness";
import type { Attempt, ClientLog, UrlEvent } from "./h10.ts";
import type { CallRecord, Client } from "./provisioner/cloudflare.ts";
import type { ResourceNames } from "./provisioner/names.ts";
import { redactWorkersDevText } from "./redact-subdomain.ts";

// The H12 protocol: the credit widget, mounted the way a product would mount it (through the credit-wallet brick's own client,
// with no network code of its own), shows the live balance of a deployed API, follows it as the server's state changes, and
// shows each tenant its own value. Nothing is uploaded: the page and the widget are already in the deployed script.
//
// Where the pieces live, on purpose: what the widget does is driven through the interface below by a test that runs it in jsdom
// (packages/deploy/client/live/H12.live.test.tsx on the real account, client/test/H12.rehearsal.test.tsx offline). Changing the
// SERVER's state (making workspaces, seeding balances, spending, topping up) is this file's job and goes over HTTP from here,
// so the test file that mounts the widget contains no network code at all, which is what the "no glue code" scan looks for.

/** What a test must provide to drive the widget. All it can do is what a user does: look at it and press Refresh. */
export interface MountedWidget {
  /** The balance text the widget shows, or null if it shows an error instead (waits until one of the two is on screen). */
  shown(): Promise<string | null>;
  /** The error text on screen, or null. */
  alert(): Promise<string | null>;
  /** The transaction lines on screen. */
  history(): Promise<string[]>;
  /** Presses the widget's Refresh button and waits for it to finish loading. */
  refresh(): Promise<void>;
  unmount(): void;
}
export interface WalletClientLike {
  getBalance(): Promise<unknown>;
  getHistory(): Promise<unknown>;
}
export interface PageDriver {
  /** Loads the deployed page in jsdom at this address (key, user and workspace in the fragment) and returns the balance text it shows, or null. */
  open(pageUrl: string, fragment: string): Promise<{ shown: string | null; text: string }>;
}

export interface H12Observation {
  step: string;
  tenant: "A" | "B";
  asUser: string;
  workspace: string;
  shown: string | null;
  alert: string | null;
  history: string[];
  /** The balance in D1, read over Cloudflare's REST endpoint just after the widget was looked at; null when there is no such wallet. */
  restBalance: number | null;
}
export interface H12Facts {
  names: ResourceNames;
  url: string;
  databaseId: string;
  workspaces: { A: { id: string; user: string }; B: { id: string; user: string } };
  /** Read back from D1 after seeding, not taken from what was sent. */
  seeds: { A: number | null; B: number | null };
  observations: H12Observation[];
  server: {
    spend: { amount: number; status: number; balanceAfter: number | null } | null;
    createOrder: { status: number; hasOrderId: boolean } | null;
    verifyUnpaid: { status: number; credited: boolean | null; reported: string | null } | null;
    topUp: { via: "d1-rest"; amount: number; client: string; why: string } | null;
  };
  /** The deployed page as served, run in jsdom. Informational: it is not one of H12's four checks. */
  page: { shown: string | null; restBalance: number | null; error?: string } | null;
  versions: { before: string[] | null; after: string[] | null };
  deployedVersionFromH10: string | null;
  attempts: Attempt[];
}
export interface H12Calls {
  schema: 1;
  commandStartedAt: string;
  clients: ClientLog[];
  urlEvents: UrlEvent[];
  facts: H12Facts;
}
export interface H12Result {
  schema: 1;
  commandStartedAt: string;
  finishedAt: string;
  completed: boolean;
  callsSha256: string;
  stoppedBecause?: string;
  /** The sha256 of each file the "no glue code" scan covers, taken when the run happened. */
  scanned: Record<string, string>;
  leakScan?: { filesScanned: number; found: string[]; scannedFor: string[] };
}

export interface H12Deps {
  clock(): number;
  commandStart: number;
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
  /**
   * A client of the credit-wallet brick, built by the test from the brick's own exports. It is handed everything it needs,
   * including the headers (which hold the access key, so the test never touches it); its requests go through `send`, which records them.
   */
  widgetClient(options: { baseUrl: string; workspaceId: string; headers: Record<string, string>; send: (input: string, init?: RequestInit) => Promise<Response> }): WalletClientLike;
  mount(client: WalletClientLike): Promise<MountedWidget>;
  page?: PageDriver;
  scanned: Record<string, string>;
}

export const SEED = { A: 1234, B: 567 } as const;
export const SPEND = 200;
export const TOP_UP = 500;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
export const canonical12 = (calls: H12Calls): string => `${JSON.stringify(calls, null, 2)}\n`;
export const formatCredits = (n: number): string => n.toLocaleString("en-US");

// Story 2.5: D1 holds thousandths of a credit (credit-wallet migration 0004). This proof's facts stay in whole credits:
// what it writes is multiplied by 1000 and what it reads is divided by 1000, here at the edge.
const MILLI = 1000;
const UPSERT_WALLET = `INSERT INTO credit_wallets (workspace_id, balance_milli) VALUES (?1, ?2) ON CONFLICT(workspace_id) DO UPDATE SET balance_milli = excluded.balance_milli`;
const INSERT_LEDGER = `INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount_milli, balance_after_milli, reason, idempotency_key) VALUES (?1, ?2, ?3, 'topup', ?4, ?5, ?6, ?7)`;
const READ_BALANCE = `SELECT balance_milli FROM credit_wallets WHERE workspace_id = ?1`;

export async function runH12(deps: H12Deps): Promise<{ calls: H12Calls; result: H12Result }> {
  const rel = () => deps.clock() - deps.commandStart;
  const say = deps.log ?? (() => undefined);
  const clients: ClientLog[] = [];
  const urlEvents: UrlEvent[] = [];
  const commandStartedAt = deps.nowIso();
  // the address is recorded with the account's workers.dev subdomain redacted (callsSha256 below covers the redacted calls)
  const facts: H12Facts = { names: deps.names, url: redactWorkersDevText(deps.url), databaseId: deps.databaseId, workspaces: { A: { id: "", user: "alice" }, B: { id: "", user: "bob" } }, seeds: { A: null, B: null }, observations: [], server: { spend: null, createOrder: null, verifyUnpaid: null, topUp: null }, page: null, versions: { before: null, after: null }, deployedVersionFromH10: deps.deployedVersionFromH10 ?? null, attempts: [] };
  let stoppedBecause: string | undefined;

  const attempt = (phase: string, outcome: "ok" | "failed", detail: string) => {
    facts.attempts.push({ n: facts.attempts.length + 1, phase, atMs: Math.round(rel()), outcome, detail: deps.hide(detail).slice(0, 600) });
    say(`[${(rel() / 1000).toFixed(1)}s] ${phase}: ${outcome}${detail ? ` - ${deps.hide(detail).slice(0, 200)}` : ""}`);
  };
  const newClient = (label: string) => {
    const client = deps.createClient(deps.clock);
    clients.push({ label, startedAtMs: Math.round(rel()), calls: client.calls as CallRecord[] });
    return client;
  };
  /** Every request to the deployed Worker goes through here and is written down. */
  const record = async (phase: string, note: string | undefined, request: Request): Promise<Response> => {
    const started = rel();
    const url = new URL(request.url);
    const event: UrlEvent = { n: urlEvents.length + 1, atMs: Math.round(started), ms: 0, phase, ...(note ? { note } : {}), method: request.method, path: `${url.pathname}${url.search}`, status: null };
    urlEvents.push(event);
    try {
      const response = await deps.fetchUrl(request);
      event.status = response.status;
      return response;
    } finally {
      event.ms = Math.round(rel() - started);
    }
  };
  /** Server-side set-up and changes, with the key and a stub identity. Not the widget's path. */
  const api = async (phase: string, method: string, path: string, user: string, workspace: string | null, body?: unknown) => {
    const headers: Record<string, string> = { "x-poc-key": deps.accessKey, "x-test-user": user, ...(workspace ? { "x-workspace-id": workspace } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) };
    const response = await record(phase, undefined, new Request(`${deps.url}${path}`, { method, headers, body: body === undefined ? null : JSON.stringify(body) }));
    const text = await response.text();
    let json: Record<string, any> | null = null;
    try {
      json = JSON.parse(text) as Record<string, any>;
    } catch {
      // not JSON
    }
    return { status: response.status, json };
  };
  const widgetSend = (label: string) => (input: string, init?: RequestInit) => record(`widget`, label, new Request(input, init));
  const clientFor = (workspaceId: string, user: string, label: string) => deps.widgetClient({ baseUrl: `${deps.url}/api`, workspaceId, headers: { "x-poc-key": deps.accessKey, "x-test-user": user }, send: widgetSend(label) });
  const restBalance = async (label: string, workspaceId: string): Promise<number | null> => {
    const [read] = await newClient(label).queryDatabase(deps.databaseId, [{ sql: READ_BALANCE, params: [workspaceId] }]);
    const row = read!.results[0] as { balance_milli?: unknown } | undefined;
    return typeof row?.balance_milli === "number" ? row.balance_milli / MILLI : null;
  };
  const look = async (step: string, tenant: "A" | "B", user: string, workspace: string, widget: MountedWidget) => {
    const shown = await widget.shown();
    const observation: H12Observation = { step, tenant, asUser: user, workspace, shown, alert: await widget.alert(), history: await widget.history(), restBalance: await restBalance(`owner-read-${facts.observations.length + 1}`, workspace) };
    facts.observations.push(observation);
    attempt(step, "ok", `the widget shows ${shown ?? `an error (${observation.alert})`}; D1 holds ${observation.restBalance}`);
    return observation;
  };
  const finish = (completed: boolean): { calls: H12Calls; result: H12Result } => {
    const calls: H12Calls = { schema: 1, commandStartedAt, clients, urlEvents, facts };
    return { calls, result: { schema: 1, commandStartedAt, finishedAt: deps.nowIso(), completed, callsSha256: sha256(canonical12(calls)), scanned: deps.scanned, ...(stoppedBecause ? { stoppedBecause } : {}) } };
  };

  try {
    facts.versions.before = (await newClient("bracket-before").listVersions(deps.names.script))?.map((v) => v.id) ?? null;
    if (!facts.versions.before?.length) throw new Error("Cloudflare lists no version for the Worker");

    // ---- two tenants, through the deployed API
    for (const tenant of ["A", "B"] as const) {
      const w = facts.workspaces[tenant];
      const made = await api("setup", "POST", "/api/workspaces", w.user, null, { name: `H12 ${tenant}` });
      if (made.status !== 201 || typeof made.json?.workspace?.id !== "string") throw new Error(`making workspace ${tenant} gave HTTP ${made.status}`);
      w.id = made.json.workspace.id;
    }
    // ---- distinct, non-zero balances, put in over the D1 REST endpoint (the owner's own way into their data)
    for (const tenant of ["A", "B"] as const) {
      const w = facts.workspaces[tenant];
      const amount = SEED[tenant];
      await newClient(`owner-seed-${tenant}`).queryDatabase(deps.databaseId, [
        { sql: UPSERT_WALLET, params: [w.id, amount * MILLI] },
        { sql: INSERT_LEDGER, params: [`seed-${w.id}`, w.id, "proof-seed", amount * MILLI, amount * MILLI, "seeded by the proof", `h12-seed-${w.id}`] },
      ]);
      facts.seeds[tenant] = await restBalance(`owner-check-seed-${tenant}`, w.id);
    }
    attempt("seed two tenants", "ok", `A holds ${facts.seeds.A}, B holds ${facts.seeds.B} (read back from D1)`);

    // ---- tenant A: the widget, then the server changes under it
    const { A, B } = facts.workspaces;
    const widgetA = await deps.mount(clientFor(A.id, A.user, "A"));
    try {
      await look("A: first view", "A", A.user, A.id, widgetA);

      const spent = await api("server-change", "POST", "/api/wallet/deduct", A.user, A.id, { amount: SPEND, reason: "h12 spend" });
      facts.server.spend = { amount: SPEND, status: spent.status, balanceAfter: typeof spent.json?.balanceAfter === "number" ? spent.json.balanceAfter : null };
      await widgetA.refresh();
      await look("A: after spending through the API", "A", A.user, A.id, widgetA);

      // The deployed project's payment gateway is the fake one, which never reports an order as paid, so a top-up cannot be
      // completed through the API. An order is created and checked to show that, and the credit itself is added over REST.
      const order = await api("server-change", "POST", "/api/payments/create-order", A.user, A.id, { amount: 100 });
      facts.server.createOrder = { status: order.status, hasOrderId: typeof order.json?.order_id === "string" };
      if (typeof order.json?.order_id === "string") {
        const verified = await api("server-change", "POST", "/api/payments/verify", A.user, null, { order_id: order.json.order_id });
        facts.server.verifyUnpaid = { status: verified.status, credited: typeof verified.json?.credited === "boolean" ? verified.json.credited : null, reported: typeof verified.json?.status === "string" ? verified.json.status : null };
      }
      await widgetA.refresh();
      await look("A: after creating an order that is not paid", "A", A.user, A.id, widgetA);

      const before = facts.observations.at(-1)!.restBalance ?? 0;
      const after = before + TOP_UP;
      const owner = newClient("owner-topup");
      await owner.queryDatabase(deps.databaseId, [
        { sql: `UPDATE credit_wallets SET balance_milli = balance_milli + ?2 WHERE workspace_id = ?1`, params: [A.id, TOP_UP * MILLI] },
        { sql: INSERT_LEDGER, params: [`topup-${A.id}`, A.id, "proof-topup", TOP_UP * MILLI, after * MILLI, "topped up by the proof", `h12-topup-${A.id}`] },
      ]);
      facts.server.topUp = { via: "d1-rest", amount: TOP_UP, client: "owner-topup", why: "the deployed project's gateway is the fake one, which never reports an order as paid, so the API cannot complete a top-up" };
      await widgetA.refresh();
      await look("A: after a top-up", "A", A.user, A.id, widgetA);
    } finally {
      widgetA.unmount();
    }

    // ---- tenant B sees its own value
    const widgetB = await deps.mount(clientFor(B.id, B.user, "B"));
    try {
      await look("B: first view", "B", B.user, B.id, widgetB);
    } finally {
      widgetB.unmount();
    }
    // ---- and B asking for A's wallet is refused, and the widget shows that and not A's number
    const widgetCross = await deps.mount(clientFor(A.id, B.user, "B-asks-for-A"));
    try {
      await look("B asks for A's wallet", "B", B.user, A.id, widgetCross);
    } finally {
      widgetCross.unmount();
    }

    // ---- the deployed page itself, as served, run in jsdom (informational)
    if (deps.page) {
      try {
        const opened = await deps.page.open(`${deps.url}/demo`, `key=${deps.accessKey}&user=${A.user}&workspace=${A.id}`);
        facts.page = { shown: opened.shown, restBalance: await restBalance("owner-read-page", A.id) };
        attempt("the deployed page", opened.shown ? "ok" : "failed", `the page shows ${opened.shown ?? "no balance"}`);
      } catch (error) {
        facts.page = { shown: null, restBalance: null, error: deps.hide(error instanceof Error ? error.message : String(error)).slice(0, 300) };
        attempt("the deployed page", "failed", facts.page.error ?? "");
      }
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

/** Direct network use in code (comments and strings that merely mention it do not count). */
const NETWORK_CODE = new RegExp(["\\bfetch\\s*\\(", "XMLHttp" + "Request", "\\bWeb" + "Socket\\b", "EventSource", "sendBeacon"].join("|"));
/** The files "no glue code" is judged over, by the end of the path; the verify step reads them from the repository. */
export const GLUE_SCAN_FILES = ["packages/deploy/client/demo-entry.tsx", "bricks/credit-wallet/client/CreditWidget.tsx", "packages/deploy/client/support/widget-driver.tsx", "packages/deploy/client/live/H12.live.test.tsx", "packages/deploy/client/test/H12.rehearsal.test.tsx"] as const;

export interface H12EvaluationInput {
  callsText: string;
  result: H12Result;
  /** The text of each file in GLUE_SCAN_FILES, as it is now. */
  sources: Record<string, string>;
}
export interface H12Evaluation {
  checks: Record<string, boolean>;
  notes: string[];
}
const isQuery = (c: CallRecord) => c.method === "POST" && /\/d1\/database\/[^/]+\/query$/.test(c.path);

export function evaluateH12(input: H12EvaluationInput): H12Evaluation {
  const notes: string[] = [];
  const checks: Record<string, boolean> = {};
  let calls: H12Calls;
  try {
    calls = JSON.parse(input.callsText) as H12Calls;
  } catch {
    return { checks, notes: ["the calls file is not valid JSON; nothing in it is believed"] };
  }
  if (sha256(input.callsText) !== input.result.callsSha256 || input.callsText !== canonical12(calls)) {
    return { checks, notes: ["the calls file does not match the hash in the result file (one of them was edited, or they come from different runs); nothing in them is believed"] };
  }
  const f = calls.facts;
  notes.push(`from the run that started ${calls.commandStartedAt}${input.result.completed ? "" : " (it did not complete)"}`);

  // A run that wrote to anything but rows, or whose Worker moved, is not evidence about the deployed page and widget.
  const all = calls.clients.flatMap((c) => c.calls);
  const uploaded = all.some((c) => c.method !== "GET" && !isQuery(c));
  const sameVersion = f.versions.before !== null && f.versions.after !== null && f.versions.before.length > 0 && f.versions.before[0] === f.versions.after[0] && f.versions.before.length === f.versions.after.length && (f.deployedVersionFromH10 === null || f.deployedVersionFromH10 === f.versions.before[0]);
  if (uploaded || !sameVersion) return { checks, notes: [...notes, "the run's log shows a write other than a database row, or the Worker's version moved or is not the one the deploy left: this run says nothing about the deployed page and widget"] };

  const obs = (step: string) => f.observations.find((o) => o.step === step);
  const a1 = obs("A: first view");
  const spent = obs("A: after spending through the API");
  const ordered = obs("A: after creating an order that is not paid");
  const topped = obs("A: after a top-up");
  const b1 = obs("B: first view");
  const cross = obs("B asks for A's wallet");
  const { seeds, server } = f;
  const distinctNonZero = seeds.A !== null && seeds.B !== null && Number.isInteger(seeds.A) && Number.isInteger(seeds.B) && seeds.A > 0 && seeds.B > 0 && seeds.A !== seeds.B;
  const widgetRequests = (label: string) => calls.urlEvents.filter((e) => e.phase === "widget" && e.note === label);

  // 1. the widget shows the live balance: exactly what D1 holds, read independently
  if (a1 && seeds.A !== null) {
    const seedA: number = seeds.A;
    checks.widgetShowsLiveBalance = distinctNonZero && a1.alert === null && a1.shown === formatCredits(seedA) && a1.restBalance === seedA && a1.history.some((line) => line.includes("seeded by the proof") && line.includes(formatCredits(seedA))) && widgetRequests("A").length >= 2 && widgetRequests("A").every((e) => e.status === 200) && a1.workspace === f.workspaces.A.id && a1.tenant === "A";
  }

  // 2. it follows the server: down through the API, unchanged when nothing changed, up when D1 is credited
  if (a1 && spent && ordered && topped && seeds.A !== null && server.spend && server.createOrder && server.topUp) {
    const afterSpend = seeds.A - SPEND;
    const afterTop = afterSpend + TOP_UP;
    checks.balanceFollowsTheServer =
      server.spend.status === 200 && server.spend.amount === SPEND && server.spend.balanceAfter === afterSpend &&
      spent.shown === formatCredits(afterSpend) && spent.restBalance === afterSpend && spent.shown !== a1.shown &&
      server.createOrder.status === 200 && server.createOrder.hasOrderId && ordered.shown === spent.shown && ordered.restBalance === afterSpend &&
      server.topUp.via === "d1-rest" && server.topUp.amount === TOP_UP && topped.shown === formatCredits(afterTop) && topped.restBalance === afterTop && topped.shown !== ordered.shown &&
      spent.history[0]?.includes("h12 spend") === true && topped.history[0]?.includes("topped up by the proof") === true;
    if (server.verifyUnpaid) notes.push(`the deployed project's payment check on an unpaid order said "${server.verifyUnpaid.reported}" (credited: ${server.verifyUnpaid.credited}), so a top-up through the API cannot complete here; the credit was added over the D1 REST endpoint`);
  }

  // 3. no glue code: the page, the widget and the tests that mount it contain no network code of their own
  {
    const files = GLUE_SCAN_FILES.filter((p) => input.sources[p] !== undefined);
    const hashesAgree = files.length === GLUE_SCAN_FILES.length && files.every((p) => input.result.scanned[p] === sha256(input.sources[p]!));
    const clean = files.every((p) => !NETWORK_CODE.test(codeLines(input.sources[p]!).map((l) => l.text).join("\n")));
    // A file that changed since the run (or was not scanned) means the run no longer describes it: that is lost evidence, so the check is
    // left unreported (a fail), never false (a kill). False is reserved for network code actually found in the files as they were scanned.
    if (hashesAgree) checks.noGlueCode = clean;
    else notes.push("a file the glue scan covers has changed since the run (or was not scanned): the check is not reported until the live test is run again");
  }

  // 4. tenant B sees its own balance, and cannot see A's
  if (b1 && cross && seeds.B !== null && seeds.A !== null) {
    const aNumbers = [seeds.A, seeds.A - SPEND, seeds.A - SPEND + TOP_UP].map(formatCredits);
    const leaks = (o: H12Observation) => [o.shown ?? "", o.alert ?? "", ...o.history].some((text) => aNumbers.some((n) => text.includes(n)));
    checks.tenantBSeesOwnBalance = distinctNonZero && b1.alert === null && b1.shown === formatCredits(seeds.B) && b1.restBalance === seeds.B && !leaks(b1) && b1.workspace === f.workspaces.B.id && f.workspaces.A.id !== f.workspaces.B.id && cross.shown === null && cross.alert !== null && cross.alert.length > 0 && !leaks(cross) && widgetRequests("B-asks-for-A").every((e) => e.status === 403 || e.status === 404);
  }

  if (f.page) notes.push(f.page.shown ? `the deployed page, run in jsdom with the key in its address fragment, shows ${f.page.shown} (D1 holds ${f.page.restBalance})` : `the deployed page, run in jsdom, showed no balance${f.page.error ? `: ${f.page.error}` : ""}`);
  notes.push("the owner's look at the page in a browser is recorded with their words and is not a check");
  return { checks, notes };
}
