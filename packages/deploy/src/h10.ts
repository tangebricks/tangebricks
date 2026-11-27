import { createHash } from "node:crypto";
import { codeLines } from "@poc/harness";
import { GRAPH_MIGRATIONS, WORKFLOW_BINDING, WORKFLOW_CLASS } from "./worker/graph-run.ts";
import { SCRIPTED_EXPECTED, runScriptedCheck, scriptedCheckPasses } from "./scripted-check.ts";
import type { Observation } from "./scripted-check.ts";
import { CloudflareApiError } from "./provisioner/cloudflare.ts";
import type { CallRecord, Client } from "./provisioner/cloudflare.ts";
import { UploadFailed, deploy, isWriteCall, readAccountState } from "./provisioner/deploy.ts";
import type { AccountState, DeployResult, Migration, TelemetryWebhookConfig } from "./provisioner/deploy.ts";
import type { Ledger } from "./provisioner/ledger.ts";
import type { ResourceNames } from "./provisioner/names.ts";

// The H10 protocol: the first deploy from nothing (timed), a second run that must change nothing, a third after one setting
// changed that must add exactly one version, and a fourth that puts the setting back. It is a library so that the same
// steps run against the real account (scripts/poc-deploy.ts) and against the fake in the tests.
//
// What it records is split in two files so that neither is the evidence on its own:
//   - the CALLS file: every Cloudflare call each run made (method, path, status, time, no body), every request made to the
//     deployed address, and the facts the checks stand on (the account as read before and after each run by clients of their
//     own, the answers to the scripted check, what Cloudflare reports the Worker is bound to);
//   - the RESULT file: the seconds claimed, a hash of the calls file, and the leak scan.
// evaluateH10 below recomputes every check from those files and from the source, and believes a claim only if it matches.
// Editing either file alone therefore changes nothing but the belief. (Editing both consistently is not detected; the files
// are evidence of a run, not a signature of it.)

export interface UrlEvent {
  n: number;
  /** Milliseconds from the start of the deploy command to the start of this request. */
  atMs: number;
  ms: number;
  phase: string;
  note?: string;
  method: string;
  path: string;
  status: number | null;
}
export interface ClientLog {
  label: string;
  /** Milliseconds from the start of the deploy command to the creation of this client. */
  startedAtMs: number;
  calls: CallRecord[];
}
export interface Attempt {
  n: number;
  phase: string;
  atMs: number;
  outcome: "ok" | "failed";
  detail: string;
}
export interface RunFacts {
  client: string;
  changes: string[];
  uploadFingerprint?: string;
  bundleSha256: string;
}
export interface UploadFacts {
  /** accepted: Cloudflare took the upload. Otherwise the class the provisioner gave the failure. */
  outcome: "accepted" | "platform_refusal" | "not_the_workflow_binding" | "not_a_refusal" | "not_attempted";
  /** Cloudflare's answer to the upload that carried the Workflow binding, when it refused (secrets hidden). */
  refusal?: { status: number; codes: number[]; body: string };
  control?: { accepted: boolean; refusal?: { status: number; codes: number[]; body: string } };
  message?: string;
}
export interface H10Facts {
  names: ResourceNames;
  url: string | null;
  builds: { base?: { sha256: string; bytes: number }; rebuilt?: { sha256: string }; changed?: { sha256: string } };
  runs: Partial<Record<"first" | "second" | "third" | "fourth", RunFacts>>;
  upload: UploadFacts;
  bindingsReadBack: { bindings: Array<{ type: string; name: string; workflowName?: string; className?: string }> | null; workflowsListed: string[] | null };
  readings: Partial<Record<"beforeSecond" | "afterSecond" | "beforeThird" | "afterThird" | "afterFourth", AccountState>>;
  observations: Partial<Record<"first" | "third" | "fourth", Observation[]>>;
  /** The phase of the scripted check whose last answer ended the timed window. */
  timedCheckPhase: string | null;
  attempts: Attempt[];
}
export interface H10Calls {
  schema: 1;
  commandStartedAt: string;
  clients: ClientLog[];
  urlEvents: UrlEvent[];
  facts: H10Facts;
}
export interface H10Result {
  schema: 1;
  commandStartedAt: string;
  finishedAt: string;
  completed: boolean;
  /** Claimed; believed only if it equals what the calls file says (see evaluateH10). */
  secondsToCorrectAnswer: number | null;
  callsSha256: string;
  /** What stopped the run, if it did not complete (secrets hidden). */
  stoppedBecause?: string;
  leakScan?: { filesScanned: number; found: string[]; scannedFor: string[] };
}

export interface H10Deps {
  clock(): number;
  /** The clock reading at the start of the deploy command. All times in the files are relative to it. */
  commandStart: number;
  sleep(ms: number): Promise<void>;
  /** A fresh client with its own call log, using this clock. */
  createClient(now: () => number): Client;
  names: ResourceNames;
  ledger: Ledger;
  accessKey: string;
  /** Assembles and bundles the project; "changed" is the same project with one brick setting changed. */
  build(
    variant: "base" | "changed",
  ): Promise<{ bundle: { code: string; sha256: string; bytes: number }; migrations: Migration[]; compatibilityFlags?: string[] }>;
  fetchUrl(request: Request): Promise<Response>;
  compatibilityDate: string;
  hide(text: string): string;
  nowIso(): string;
  log?(line: string): void;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  checkTries?: number;
  /** Where this deploy goes (default dev) and the project's lock; production refuses a stub identity. */
  environment?: "dev" | "preview" | "production";
  lock?: { identity?: string };
  /** Story 1.17: the project's derived control-plane and webhook secrets (telemetryWebhookConfig), bound to the Worker. */
  telemetryWebhook?: TelemetryWebhookConfig;
}

const DEFAULT_POLL_TIMEOUT_MS = 700_000;
const WRONG_KEY = createHash("sha256").update("not the key").digest("hex");

export const GATE_PROBES: Array<{ note: string; method: string; path: string; key: "none" | "wrong"; expect: number }> = [
  ...(["none", "wrong"] as const).flatMap((key) =>
    [
      { method: "GET", path: "/api/invoices" },
      { method: "GET", path: "/api/wallet" },
      { method: "GET", path: "/poc/graphs/x" },
      { method: "POST", path: "/poc/runs" },
      { method: "GET", path: "/" },
    ].map((p) => ({ ...p, key, note: key === "none" ? "no-key" : "wrong-key", expect: 401 })),
  ),
  { note: "demo-open", method: "GET", path: "/demo", key: "none", expect: 200 },
  { note: "demo-post-refused", method: "POST", path: "/demo", key: "none", expect: 401 },
];

const errorFacts = (error: unknown, hide: (t: string) => string) =>
  error instanceof CloudflareApiError ? { status: error.status, codes: error.codes, body: hide(error.body).slice(0, 4000) } : undefined;

export async function runH10(deps: H10Deps): Promise<{ calls: H10Calls; result: H10Result }> {
  const rel = () => deps.clock() - deps.commandStart;
  const say = deps.log ?? (() => undefined);
  const clients: ClientLog[] = [];
  const urlEvents: UrlEvent[] = [];
  const facts: H10Facts = {
    names: deps.names,
    url: null,
    builds: {},
    runs: {},
    upload: { outcome: "not_attempted" },
    bindingsReadBack: { bindings: null, workflowsListed: null },
    readings: {},
    observations: {},
    timedCheckPhase: null,
    attempts: [],
  };
  const commandStartedAt = deps.nowIso();
  let secondsToCorrectAnswer: number | null = null;
  let stoppedBecause: string | undefined;

  const attempt = (phase: string, outcome: "ok" | "failed", detail: string) => {
    facts.attempts.push({ n: facts.attempts.length + 1, phase, atMs: Math.round(rel()), outcome, detail: deps.hide(detail).slice(0, 600) });
    say(`[${(rel() / 1000).toFixed(1)}s] ${phase}: ${outcome}${detail ? ` - ${deps.hide(detail).slice(0, 200)}` : ""}`);
  };
  const newClient = (label: string) => {
    const client = deps.createClient(deps.clock);
    const log: ClientLog = { label, startedAtMs: Math.round(rel()), calls: client.calls as CallRecord[] };
    clients.push(log);
    return client;
  };
  const input = (client: Client, build: { bundle: { code: string; sha256: string }; migrations: Migration[]; compatibilityFlags?: string[] }) => ({
    client,
    ledger: deps.ledger,
    names: deps.names,
    accessKey: deps.accessKey,
    bundle: build.bundle,
    migrations: [...build.migrations, ...GRAPH_MIGRATIONS],
    compatibilityDate: deps.compatibilityDate,
    // story 1.19: nodejs_compat when the bundle imports node:* (bundleWorker reports it); otherwise the metadata is unchanged
    ...(build.compatibilityFlags && build.compatibilityFlags.length > 0 ? { compatibilityFlags: build.compatibilityFlags } : {}),
    workflow: { binding: WORKFLOW_BINDING, className: WORKFLOW_CLASS },
    nowIso: deps.nowIso,
    ...(deps.environment ? { environment: deps.environment } : {}),
    ...(deps.lock ? { lock: deps.lock } : {}),
    ...(deps.telemetryWebhook ? { telemetryWebhook: deps.telemetryWebhook } : {}),
  });
  const reading = async (label: string) => readAccountState(newClient(label), deps.names);

  /** Sends to the deployed address, writing down every request. */
  const sendFor =
    (phase: string, note?: string) =>
    async (request: Request): Promise<Response> => {
      const started = rel();
      const url = new URL(request.url);
      const event: UrlEvent = {
        n: urlEvents.length + 1,
        atMs: Math.round(started),
        ms: 0,
        phase,
        ...(note ? { note } : {}),
        method: request.method,
        path: `${url.pathname}${url.search}`,
        status: null,
      };
      urlEvents.push(event);
      try {
        const response = await deps.fetchUrl(request);
        event.status = response.status;
        return response;
      } finally {
        event.ms = Math.round(rel() - started);
      }
    };

  const finish = (completed: boolean): { calls: H10Calls; result: H10Result } => {
    const calls: H10Calls = { schema: 1, commandStartedAt, clients, urlEvents, facts };
    const result: H10Result = {
      schema: 1,
      commandStartedAt,
      finishedAt: deps.nowIso(),
      completed,
      secondsToCorrectAnswer,
      callsSha256: sha256(canonical(calls)),
      ...(stoppedBecause ? { stoppedBecause } : {}),
    };
    return { calls, result };
  };

  // ---- 1. the first deploy, from nothing: this is the timed part --------------------------------------------------
  let base: Awaited<ReturnType<H10Deps["build"]>>;
  try {
    base = await deps.build("base");
  } catch (error) {
    stoppedBecause = `the project could not be assembled or bundled: ${deps.hide(error instanceof Error ? error.message : String(error))}`;
    attempt("build", "failed", stoppedBecause);
    return finish(false);
  }
  facts.builds.base = { sha256: base.bundle.sha256, bytes: base.bundle.bytes };
  attempt("build", "ok", `bundle ${base.bundle.sha256.slice(0, 12)}, ${base.bundle.bytes} bytes`);

  let first: DeployResult;
  try {
    first = await deploy(input(newClient("first-deploy"), base));
    facts.upload = { outcome: "accepted" };
    facts.runs.first = {
      client: "first-deploy",
      changes: first.changes.map((c) => c.kind),
      uploadFingerprint: first.uploadFingerprint,
      bundleSha256: base.bundle.sha256,
    };
    facts.url = first.url;
    attempt("first deploy", "ok", first.changes.map((c) => c.kind).join(", "));
  } catch (error) {
    if (error instanceof UploadFailed) {
      facts.upload = {
        outcome: error.classification,
        refusal: errorFacts(error.withWorkflow, deps.hide),
        ...(error.control
          ? { control: { accepted: error.control.accepted, ...(error.control.error ? { refusal: errorFacts(error.control.error, deps.hide) } : {}) } }
          : {}),
        message: deps.hide(error.message).slice(0, 1000),
      };
    }
    stoppedBecause = `the first deploy stopped: ${deps.hide(error instanceof Error ? error.message : String(error)).slice(0, 1500)}`;
    attempt("first deploy", "failed", stoppedBecause);
    return finish(false);
  }

  // wait for the address to answer, then run the scripted check until it comes out right
  const url = first.url;
  const keyHeader = { "x-poc-key": deps.accessKey };
  const pollUntil = rel() + (deps.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);
  let upAt: number | null = null;
  for (let tries = 1; rel() < pollUntil; tries += 1) {
    try {
      const response = await sendFor("wait-for-address")(new Request(`${url}/demo`));
      await response.arrayBuffer();
      if (response.status === 200) {
        upAt = rel();
        attempt("address answers", "ok", `GET /demo after ${tries} request(s)`);
        break;
      }
    } catch {
      // not reachable yet: the address is new
    }
    await deps.sleep(deps.pollIntervalMs ?? 1000);
  }
  if (upAt === null) {
    stoppedBecause = `the address ${deps.hide(url)} never answered GET /demo with 200`;
    attempt("address answers", "failed", stoppedBecause);
    return finish(false);
  }
  const tries = deps.checkTries ?? 6;
  let timedEnd: number | null = null;
  for (let k = 1; k <= tries; k += 1) {
    const phase = `first-check-${k}`;
    try {
      const observations = await runScriptedCheck(sendFor(phase), { origin: url, headers: keyHeader });
      if (scriptedCheckPasses(observations)) {
        facts.observations.first = observations;
        facts.timedCheckPhase = phase;
        const mine = urlEvents.filter((e) => e.phase === phase);
        const last = mine[mine.length - 1]!;
        timedEnd = last.atMs + last.ms;
        attempt("scripted check", "ok", `answered correctly on try ${k}`);
        break;
      }
      facts.observations.first = observations;
      attempt("scripted check", "failed", `try ${k}: answers differ from the expected ones`);
    } catch (error) {
      attempt("scripted check", "failed", `try ${k}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await deps.sleep(deps.pollIntervalMs ?? 1000);
  }
  if (timedEnd === null) {
    stoppedBecause = "the deployed project did not give the scripted check's expected answers";
    return finish(false);
  }
  secondsToCorrectAnswer = Math.round(timedEnd) / 1000;
  say(`the first correct answer came ${secondsToCorrectAnswer} seconds after the command started`);

  // ---- 2. what Cloudflare says the Worker is bound to (not timed) ------------------------------------------------
  {
    const reader = newClient("read-back");
    try {
      facts.bindingsReadBack.bindings = await reader.getScriptBindings(deps.names.script);
    } catch (error) {
      attempt("read the Worker's bindings back", "failed", error instanceof Error ? error.message : String(error));
    }
    try {
      facts.bindingsReadBack.workflowsListed = await reader.listWorkflows();
    } catch (error) {
      attempt("list the Workflows", "failed", error instanceof Error ? error.message : String(error));
    }
  }

  // ---- 3. the second run: nothing may change -----------------------------------------------------------------------
  try {
    const rebuilt = await deps.build("base");
    facts.builds.rebuilt = { sha256: rebuilt.bundle.sha256 };
    facts.readings.beforeSecond = await reading("reader-before-second");
    const second = await deploy(input(newClient("second-deploy"), rebuilt));
    facts.runs.second = {
      client: "second-deploy",
      changes: second.changes.map((c) => c.kind),
      uploadFingerprint: second.uploadFingerprint,
      bundleSha256: rebuilt.bundle.sha256,
    };
    facts.readings.afterSecond = await reading("reader-after-second");
    attempt("second run", "ok", `${second.changes.length} change(s) reported`);

    // ---- 4. the third run: one setting changed, exactly one new version ------------------------------------------
    const changed = await deps.build("changed");
    facts.builds.changed = { sha256: changed.bundle.sha256 };
    facts.readings.beforeThird = await reading("reader-before-third");
    const third = await deploy(input(newClient("third-deploy"), changed));
    facts.runs.third = {
      client: "third-deploy",
      changes: third.changes.map((c) => c.kind),
      uploadFingerprint: third.uploadFingerprint,
      bundleSha256: changed.bundle.sha256,
    };
    facts.readings.afterThird = await reading("reader-after-third");
    attempt("third run (one setting changed)", "ok", third.changes.map((c) => c.kind).join(", "));
    facts.observations.third = await runScriptedCheck(sendFor("third-check"), { origin: url, headers: keyHeader }).catch(() => []);

    // ---- 5. the fourth run: the setting put back, so the final script is the first one again ----------------------
    const fourth = await deploy(input(newClient("fourth-deploy"), base));
    facts.runs.fourth = {
      client: "fourth-deploy",
      changes: fourth.changes.map((c) => c.kind),
      uploadFingerprint: fourth.uploadFingerprint,
      bundleSha256: base.bundle.sha256,
    };
    facts.readings.afterFourth = await reading("reader-after-fourth");
    attempt("fourth run (setting restored)", "ok", fourth.changes.map((c) => c.kind).join(", "));
    facts.observations.fourth = await runScriptedCheck(sendFor("fourth-check"), { origin: url, headers: keyHeader }).catch(() => []);
  } catch (error) {
    stoppedBecause = `a later run stopped: ${deps.hide(error instanceof Error ? error.message : String(error)).slice(0, 1500)}`;
    attempt("later runs", "failed", stoppedBecause);
    return finish(false);
  }

  // ---- 6. who can get in --------------------------------------------------------------------------------------------
  for (const probe of GATE_PROBES) {
    try {
      const headers: Record<string, string> = probe.key === "wrong" ? { "x-poc-key": WRONG_KEY } : {};
      const response = await sendFor(
        "gate",
        probe.note,
      )(new Request(`${url}${probe.path}`, { method: probe.method, headers, body: probe.method === "POST" ? "{}" : null }));
      await response.arrayBuffer();
    } catch (error) {
      attempt("gate probe", "failed", `${probe.method} ${probe.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  attempt("gate probes", "ok", `${GATE_PROBES.length} requests made without the key or with a wrong one`);
  return finish(true);
}

// ---------------------------------------------------------------------------------------------------------------------

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
/** The calls file as it is hashed: the same text that is written to disk. */
export const canonical = (calls: H10Calls): string => `${JSON.stringify(calls, null, 2)}\n`;

export interface EvaluationInput {
  /** The calls file's exact text, and the result file's parsed content. */
  callsText: string;
  result: H10Result;
  /** Source files whose text decides "over REST only": path to content. */
  sources: Record<string, string>;
  /** Raw text of every evidence file, scanned for things that must never be in them. */
  evidenceTexts: string[];
}
export interface Evaluation {
  /** Undefined when the claim does not match the calls file. */
  measured?: number;
  checks: Record<string, boolean>;
  notes: string[];
}

const EXPECTED_STATUSES = SCRIPTED_EXPECTED.map((o) => o.status);
// What "over REST only" forbids in code: starting a program, and the command-line tool. Written in pieces so that this file,
// which is one of the files that is read, does not contain the very words it looks for.
const STARTS_A_PROGRAM = new RegExp(["child" + "_process", "\\bspawn\\w*\\s*\\(", "\\bexec\\w*\\s*\\(", "\\bwran" + "gler\\b"].join("|"));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const writes = (calls: readonly CallRecord[]) => calls.filter(isWriteCall);
const logOf = (calls: H10Calls, label: string) => calls.clients.find((c) => c.label === label);

/**
 * Recomputes H10's measurement and checks from the files and the source. A check that cannot be recomputed is left out
 * (which the verdict reads as "not reported", a fail), never defaulted to true.
 */
export function evaluateH10(input: EvaluationInput): Evaluation {
  const notes: string[] = [];
  const checks: Record<string, boolean> = {};
  let calls: H10Calls;
  try {
    calls = JSON.parse(input.callsText) as H10Calls;
  } catch {
    return { checks, notes: ["the calls file is not valid JSON; nothing in it is believed"] };
  }
  if (sha256(input.callsText) !== input.result.callsSha256 || input.callsText !== canonical(calls)) {
    return {
      checks,
      notes: [
        "the calls file does not match the hash in the result file (one of them was edited, or they come from different runs); nothing in them is believed",
      ],
    };
  }
  const f = calls.facts;
  notes.push(`from the run that started ${calls.commandStartedAt}${input.result.completed ? "" : " (it did not complete)"}`);

  // ---- the clock
  let measured: number | undefined;
  const phase = f.timedCheckPhase;
  const events = phase ? calls.urlEvents.filter((e) => e.phase === phase) : [];
  if (phase && events.length === SCRIPTED_EXPECTED.length) {
    const last = events[events.length - 1]!;
    const recomputed = Math.round(last.atMs + last.ms) / 1000;
    const firstDeploy = logOf(calls, "first-deploy");
    const deployEnd = firstDeploy ? firstDeploy.startedAtMs + Math.max(0, ...firstDeploy.calls.map((c) => c.atMs + c.ms)) : Infinity;
    if (input.result.secondsToCorrectAnswer !== recomputed)
      notes.push(`the result file claims ${input.result.secondsToCorrectAnswer} seconds but the calls file gives ${recomputed}; the claim is not believed`);
    else if (!(events[0]!.atMs >= deployEnd - 5)) notes.push("the scripted check starts before the first deploy's last call ends; the clock is not believed");
    else measured = recomputed;
  } else notes.push("the calls file has no complete scripted check that ended the clock");

  // ---- restUploadAccepted: only a refusal by Cloudflare itself, with a plain upload accepted, makes this false
  const putOk = (label: string) =>
    logOf(calls, label)?.calls.some(
      (c) => c.method === "PUT" && c.path === `/accounts/{account}/workers/scripts/${f.names.script}` && c.status === 200 && c.outcome === "ok",
    ) === true;
  const bound =
    f.bindingsReadBack.bindings?.some((b) => b.type === "workflow" && b.className === WORKFLOW_CLASS) === true ||
    f.bindingsReadBack.workflowsListed?.includes(f.names.workflow) === true;
  if (
    f.upload.outcome === "platform_refusal" &&
    f.upload.control?.accepted === true &&
    f.upload.refusal &&
    f.upload.refusal.body.length > 0 &&
    !putOk("first-deploy")
  )
    checks.restUploadAccepted = false;
  else if (f.upload.outcome === "accepted" && putOk("first-deploy") && bound) checks.restUploadAccepted = true;
  else
    notes.push(
      "restUploadAccepted is not established either way (the upload was not refused by Cloudflare with a plain upload accepted, and it was not shown accepted with the Workflow binding)",
    );

  // ---- deployedOverRestOnly
  const apiOnly = calls.clients.every((c) => c.calls.every((x) => x.path.startsWith("/accounts/{account}/")));
  const sourcesClean =
    Object.keys(input.sources).length >= 8 &&
    Object.entries(input.sources).every(
      ([, text]) =>
        !STARTS_A_PROGRAM.test(
          codeLines(text)
            .map((l) => l.text)
            .join("\n"),
        ),
    );
  checks.deployedOverRestOnly = apiOnly && sourcesClean && (logOf(calls, "first-deploy")?.calls.length ?? 0) > 0;

  // ---- urlAnswersCorrectly
  const observed = f.observations.first;
  checks.urlAnswersCorrectly =
    observed !== undefined &&
    scriptedCheckPasses(observed) &&
    events.length === EXPECTED_STATUSES.length &&
    same(
      events.map((e) => e.status),
      EXPECTED_STATUSES,
    ) &&
    same(
      observed.map((o) => o.status),
      EXPECTED_STATUSES,
    );

  // ---- secondRunChangesNothing
  const b2 = f.readings.beforeSecond;
  const a2 = f.readings.afterSecond;
  const second = logOf(calls, "second-deploy");
  if (b2 && a2 && second) {
    const real = b2.databaseId !== null && b2.versionCount >= 1 && b2.latestVersionId !== null && b2.appliedMigrations.length >= 1;
    const readersReadOnly = ["reader-before-second", "reader-after-second"].every(
      (l) => (logOf(calls, l)?.calls.length ?? 0) > 0 && writes(logOf(calls, l)!.calls).length === 0,
    );
    checks.secondRunChangesNothing = real && same(b2, a2) && writes(second.calls).length === 0 && second.calls.length > 0 && readersReadOnly;
  }

  // ---- changedProjectChangesOneThing
  const b3 = f.readings.beforeThird;
  const a3 = f.readings.afterThird;
  const third = logOf(calls, "third-deploy");
  if (b3 && a3 && third) {
    const uploads = third.calls.filter(
      (c) =>
        ((c.method === "PUT" && c.path === `/accounts/{account}/workers/scripts/${f.names.script}`) ||
          (c.method === "POST" && c.path === `/accounts/{account}/workers/scripts/${f.names.script}/versions`)) &&
        c.status === 200,
    ).length;
    checks.changedProjectChangesOneThing =
      b3.latestVersionId !== null &&
      a3.latestVersionId !== null &&
      a3.latestVersionId !== b3.latestVersionId &&
      a3.versionCount === b3.versionCount + 1 &&
      uploads === 1 &&
      b3.databaseId !== null &&
      a3.databaseId === b3.databaseId &&
      same(a3.appliedMigrations, b3.appliedMigrations) &&
      b3.appliedMigrations.length >= 1 &&
      f.builds.changed?.sha256 !== f.builds.base?.sha256;
  }

  // ---- publicAccessGated
  const gate = calls.urlEvents.filter((e) => e.phase === "gate");
  checks.publicAccessGated =
    gate.length === GATE_PROBES.length &&
    GATE_PROBES.every((p, i) => gate[i]?.note === p.note && gate[i]?.method === p.method && gate[i]?.path === p.path && gate[i]?.status === p.expect);

  // ---- tokenNeverLeaked
  const scan = input.result.leakScan;
  // Hashes (a bundle's, a fingerprint) are 64 hexadecimal characters like the access key, so a pattern cannot tell them apart;
  // what is checked here is the shape of a credential being recorded (an Authorization value, a key header with a value).
  const structural = input.evidenceTexts.every((t) => !/Bearer\s+\S/i.test(t) && !/x-poc-key["']?\s*:/i.test(t));
  if (scan)
    checks.tokenNeverLeaked =
      scan.found.length === 0 && scan.filesScanned >= 50 && ["token", "accountId", "accessKey"].every((n) => scan.scannedFor.includes(n)) && structural;
  else notes.push("no leak scan is recorded");

  // ---- informational, not checks
  if (f.bindingsReadBack.workflowsListed !== null && !f.bindingsReadBack.workflowsListed.includes(f.names.workflow))
    notes.push("the Workflow is not in Cloudflare's Workflows list: a run cannot be started (found on the real service on the first attempt)");
  if (f.builds.rebuilt)
    notes.push(
      f.builds.rebuilt.sha256 === f.builds.base?.sha256
        ? "the project bundles to the same bytes on a rebuild"
        : "the rebuilt bundle differs from the first one",
    );
  if (f.runs.fourth && f.runs.first)
    notes.push(
      f.runs.fourth.bundleSha256 === f.runs.first.bundleSha256
        ? "the fourth run uploaded the same bundle as the first"
        : "the fourth run's bundle is not the first one's",
    );
  return { ...(measured !== undefined ? { measured } : {}), checks, notes };
}

/** Records the outcome of the scan of the repositories for the token, the account id and the access key. */
export function withLeakScan(result: H10Result, scan: { filesScanned: number; found: string[]; scannedFor: string[] }): H10Result {
  return { ...result, leakScan: scan };
}
