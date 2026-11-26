// The live proof of Studio's one real deploy path (story R53 / 1.2). It runs Studio's own API in-process (app.fetch) with
// the REAL Cloudflare client and a local Studio database, and drives Studio's own routes against the owner's account:
//
//   node --env-file=<path-outside-repo>/.env scripts/live-studio-deploy.ts --state-dir <path-outside-repo>/studio-state [--revoked-token-env CF_REVOKED_TOKEN]
//   (pnpm live:studio-deploy -- --state-dir ... is the same command when the variables are already in the environment)
//   pnpm live:studio-deploy -- --state-dir <same folder> --teardown     removes what an interrupted run left, from its ledger
//
// Env (from an env file OUTSIDE the repositories, never printed): CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (the scoped
// deploy token), PX_TELEMETRY_SECRET (Studio's root secret; the Workers get only values derived from it).
//
// THIS CREATES THINGS IN THE ACCOUNT, all named px-tangebricks-test-<8 hex>-...: per environment (preview, production) one
// D1 database, one Worker with its workers.dev address switched on, one Workflow. Before anything is created the script
// refuses to run if the account already holds px-tangebricks-test-* resources its ledger does not list. Every write Studio or
// this script sends passes a guard that refuses any name without this run's own prefix, and every create is written to the
// ledger before it is sent. At the end (and on failure) it tears down exactly what the ledger lists, and checks nothing is left.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createStudioApiApp, deriveWorkerAccessKey } from "../apps/studio-api/src/index.ts";
import type { StudioDeployOptions } from "../apps/studio-api/src/index.ts";
import {
  STUDIO_TEST_NAME_POLICY,
  createClient,
  createRedactor,
  createRequestBudget,
  fileStore,
  findSecrets,
  findUnledgered,
  CloudflareApiError,
  RequestGuardError,
  isCloudflareError,
  openLedger,
  studioTestProject,
  teardown,
} from "../packages/deploy/src/provisioner/index.ts";
import type { Client, LedgerStore, RequestBudget, TeardownResult } from "../packages/deploy/src/provisioner/index.ts";
import { KEY_HEADER } from "../packages/deploy/src/worker/gate.ts";
import { WORKFLOW_RUNS_PATH } from "../packages/deploy/src/worker/proof-routes.ts";
import { deriveProjectSecret, signControlPlaneRequest } from "../packages/telemetry/src/index.ts";
import { INVOICE_FLOW_BLUEPRINT } from "../test/support/blueprints.ts";
import { recordLiveIntegrity } from "./lib/live-evidence.ts";
import { redactWorkersDevSubdomains } from "./lib/redact-subdomain.ts";
import { createNodeStudioEnv } from "./lib/studio-node-env.ts";

export const RESULT_FILE = "studio-deploy-result.json";
export const CALLS_FILE = "studio-deploy-calls.json";
export const GRAPH_ID = "wf-debit";
export const DEBIT_AMOUNT = 5;
export const FUNDED_MILLI = 100_000;

/**
 * The live proof's blueprint as Studio ops: INVOICE_FLOW_BLUEPRINT (multi-workspace, credit-wallet, dynamic-entities and its
 * invoices entity), oidc-verify as the identity (production refuses the stub), and the graph trigger.manual -> credit-wallet.debit.
 *
 * Not core-auth: it pulls in better-auth, whose password helpers import node:crypto, and the Worker bundler refuses every
 * Node-only import (it targets Workers without nodejs_compat; scripts/test/live-studio-bundle.node.test.ts showed the build
 * failing on it). oidc-verify depends only on the SDK, the runtime and hono, and needs no brick secret.
 */
export function liveProofOps(): Array<Record<string, unknown>> {
  return [
    ...INVOICE_FLOW_BLUEPRINT.bricks.map((brickId, i) => ({ opId: `op_brick_${i}`, type: "enable_brick", brickId, config: {} })),
    { opId: "op_brick_auth", type: "enable_brick", brickId: "oidc-verify", config: {} },
    { opId: "op_identity", type: "set_identity", identity: "oidc-verify" },
    ...INVOICE_FLOW_BLUEPRINT.entities.map((entity, i) => ({ opId: `op_entity_${i}`, type: "add_entity", entity: { ...entity, fields: entity.fields.map((f) => ({ ...f })) } })),
    {
      opId: "op_graph",
      type: "add_workflow",
      workflow: {
        id: GRAPH_ID,
        name: "Debit on manual trigger",
        nodes: [
          { id: "trigger", type: "trigger.manual", label: "Manual", data: {} },
          { id: "debit", type: "credit-wallet.debit", label: "Debit", data: { amount: DEBIT_AMOUNT } },
        ],
        edges: [{ id: "e1", source: "trigger", target: "debit", sourceHandle: "out", targetHandle: "in" }],
      },
    },
  ];
}
/** Who the proof's debit is charged as: credit-wallet.debit records a user on every ledger row and requires one. */
export const LIVE_PROOF_USER_ID = "tangebricks-live-proof";
/**
 * The payload of the signed run that must debit the funded workspace. credit-wallet.debit takes its user from the run's input
 * and refuses a run without one ("invalid input: userId"); live run 1 sent only { workspaceId }, so the Workflow completed with
 * the debit node failed and nothing was charged. The workspace itself comes from the signed body, never from this payload.
 */
export function liveProofRunPayload(workspaceId: string): Record<string, unknown> {
  return { userId: LIVE_PROOF_USER_ID, workspaceId };
}

/** Brick secrets the live blueprint needs in Studio's vault before the deploy: none for oidc-verify. */
export const LIVE_PROOF_BRICK_SECRETS: readonly string[] = [];

export class LiveProofRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveProofRefusal";
  }
}

export interface LiveStudioDeployDeps {
  credentials: { token: string; accountId: string };
  /** Studio's root PX_TELEMETRY_SECRET. */
  rootSecret: string;
  /** A token the owner revoked, to show it is refused (step 6). */
  revokedToken?: string;
  /** How requests reach Cloudflare's API. */
  cloudflareFetch: (request: Request) => Promise<Response>;
  /** How requests reach the deployed workers.dev addresses. */
  workerFetch: (request: Request) => Promise<Response>;
  /** Builds the uploaded Worker from the assembled project (bundleWorker in the CLI). */
  bundle: NonNullable<StudioDeployOptions["bundle"]>;
  ledgerStore: LedgerStore;
  randomHex: (bytes: number) => string;
  /** The repository root the evidence is written under (evidence/deployed). */
  root: string;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  budget?: RequestBudget;
  /** How long to wait for a new address to answer and a run to debit. */
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface CallLine {
  phase: string;
  method: string;
  path: string;
  status: number | null;
  write: boolean;
}

export interface LiveStudioDeployResult {
  commandStartedAt: string;
  finishedAt: string;
  completed: boolean;
  stoppedBecause: string | null;
  project: string;
  prefix: string;
  steps: Record<string, unknown>;
  teardown: (Omit<TeardownResult, "unledgered"> & { leftBehind: Array<{ kind: string; name: string }> }) | null;
  writesDuringRedeploy: number;
}

const isWrite = (method: string, path: string, body: string): boolean => {
  if (method === "GET") return false;
  if (method === "POST" && /\/d1\/database\/[^/]+\/query$/.test(path)) {
    try {
      const parsed = JSON.parse(body) as { sql?: string; batch?: Array<{ sql: string }> };
      const statements = parsed.batch ?? (parsed.sql ? [{ sql: parsed.sql }] : []);
      return !(statements.length > 0 && statements.every((s) => /^\s*select\b/i.test(s.sql)));
    } catch {
      return true;
    }
  }
  return true;
};

/**
 * Wraps the way to Cloudflare so that no write can touch anything but this run's own resources: a Worker, Workflow, database
 * or queue must carry `px-<project>-`, a database or queue addressed by id must be one this run created or saw listed under
 * that prefix. A create is written to the ledger before it is sent. Reads pass, and teach the guard ids of its own resources.
 */
export function createGuardedFetch(params: {
  fetch: (request: Request) => Promise<Response>;
  /** The only account any request may address. */
  accountId: string;
  ownPrefix: string;
  ledger: ReturnType<typeof openLedger>;
  log: CallLine[];
  phase: () => string;
}) {
  const { ownPrefix, ledger } = params;
  const ownName = (name: unknown): name is string => typeof name === "string" && name.startsWith(ownPrefix) && STUDIO_TEST_NAME_POLICY.isName(name);
  const knownDbIds = new Set<string>();
  const knownQueueIds = new Set<string>();
  const ledgeredDbIds = () => new Set(ledger.entries().filter((e) => e.kind === "d1_database" && e.status !== "removed" && e.id).map((e) => e.id!));
  /** Binding types that address no other resource. */
  const PLAIN_BINDINGS = new Set(["plain_text", "secret_text", "secret_key", "json", "version_metadata"]);
  /** What an upload binds to must be this run's own: a ledgered database, its own Workflow, Worker or queue. */
  const inspectUploadMetadata = (metadata: Record<string, unknown>) => {
    const bindings = Array.isArray(metadata.bindings) ? (metadata.bindings as Array<Record<string, unknown>>) : [];
    const dbIds = ledgeredDbIds();
    for (const b of bindings) {
      const type = String(b.type);
      if (PLAIN_BINDINGS.has(type)) continue;
      if (type === "d1") {
        if (!dbIds.has(String(b.database_id))) refuse(`binding ${String(b.name)} names D1 ${String(b.database_id)}, which is not a database this run ledgered`);
      } else if (type === "workflow") {
        if (!ownName(b.workflow_name)) refuse(`binding ${String(b.name)} names Workflow "${String(b.workflow_name)}", which is not this run's`);
        if (b.script_name !== undefined && !ownName(b.script_name)) refuse(`binding ${String(b.name)} points at Worker "${String(b.script_name)}", which is not this run's`);
        if (typeof b.class_name !== "string" || !/^[A-Za-z_$][\w$]*$/.test(b.class_name)) refuse(`binding ${String(b.name)} has no valid class_name`);
      } else if (type === "service") {
        if (!ownName(b.service)) refuse(`binding ${String(b.name)} names Worker "${String(b.service)}", which is not this run's`);
      } else if (type === "queue") {
        if (!ownName(b.queue_name)) refuse(`binding ${String(b.name)} names queue "${String(b.queue_name)}", which is not this run's`);
      } else {
        refuse(`binding ${String(b.name)} of type ${type} is not one this proof uploads`);
      }
    }
    const tails = Array.isArray(metadata.tail_consumers) ? (metadata.tail_consumers as Array<{ service?: unknown }>) : [];
    for (const t of tails) if (!ownName(t.service)) refuse(`tail consumer "${String(t.service)}" is not this run's`);
  };
  // A refusal is its own error type (RequestGuardError): the REST client rethrows it unchanged, and Studio answers it as
  // 403 GUARD_REFUSED, never as Cloudflare being unreachable.
  const refuse = (why: string): never => {
    throw new RequestGuardError(`guard: refused a request to Cloudflare: ${why}`);
  };
  /** The write subpaths of a Worker this run uses, by method; any other (for example PUT .../content) is refused. */
  const SCRIPT_WRITES: Array<{ method: string; sub: RegExp }> = [
    { method: "PUT", sub: /^$/ },
    { method: "DELETE", sub: /^$/ },
    { method: "POST", sub: /^\/versions$/ },
    { method: "POST", sub: /^\/deployments$/ },
    { method: "PUT", sub: /^\/secrets$/ },
    { method: "DELETE", sub: /^\/secrets\/[^/]+$/ },
    { method: "PUT", sub: /^\/schedules$/ },
    { method: "POST", sub: /^\/subdomain$/ },
    { method: "PATCH", sub: /^\/settings$/ },
  ];
  /** A write's JSON body; one that does not parse (or is not an object) is a guard refusal, never a SyntaxError. */
  const jsonBody = <T extends object>(body: string, shown: string): T => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      return refuse(`the body of ${shown} is not JSON`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return refuse(`the body of ${shown} is not a JSON object`);
    return parsed as T;
  };
  /** Upload or settings metadata: a multipart part ("metadata" or "settings") or a JSON body. */
  const readMetadata = async (request: Request, name: string): Promise<Record<string, unknown>> => {
    const type = request.headers.get("content-type") ?? "";
    try {
      if (type.includes("multipart/form-data")) {
        const form = await request.clone().formData();
        const part = form.get("metadata") ?? form.get("settings");
        return JSON.parse(typeof part === "string" ? part : part ? await (part as Blob).text() : "{}") as Record<string, unknown>;
      }
      return JSON.parse((await request.clone().text()) || "{}") as Record<string, unknown>;
    } catch {
      return refuse(`the write to "${name}" has no readable metadata`);
    }
  };
  const learn = async (path: string, response: Response) => {
    if (!response.ok) return;
    if (path !== "/d1/database" && path !== "/queues") return;
    try {
      const body = (await response.clone().json()) as { result?: Array<Record<string, unknown>> };
      for (const item of body.result ?? []) {
        if (path === "/d1/database" && ownName(item.name) && typeof item.uuid === "string") knownDbIds.add(item.uuid);
        if (path === "/queues" && ownName(item.queue_name) && typeof item.queue_id === "string") knownQueueIds.add(item.queue_id);
      }
    } catch {
      // not a list; nothing to learn
    }
  };
  return async function guardedFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Cloudflare's API only, over https, with no redirect followed (the deployed Worker's address is reached separately).
    if (url.protocol !== "https:" || url.hostname !== "api.cloudflare.com") refuse(`${url.protocol}//${url.hostname} is not Cloudflare's API`);
    // No empty segment (`//`), which a server may collapse into another path than the one checked here.
    if (url.pathname.includes("//")) refuse(`the path ${url.pathname} has an empty segment`);
    const accountPath = url.pathname.match(/^\/client\/v4\/accounts\/([^/]+)(\/.*)?$/);
    // Pinned to one account: a request that names any other is refused, read or write. A path that mentions /accounts/
    // anywhere must be this exact shape, so no other spelling of an account address slips through as a non-account read.
    if (!accountPath && /\/accounts(\/|$)/i.test(url.pathname)) refuse(`${url.pathname} names an account outside the pinned shape`);
    if (accountPath && decodeURIComponent(accountPath[1]!).toLowerCase() !== params.accountId.toLowerCase()) refuse("the request addresses another account");
    const path = accountPath ? (accountPath[2] ?? "") : url.pathname;
    const shown = url.pathname.replace(/\/accounts\/[^/]+/, "/accounts/{account}");
    const method = request.method;
    const body = method === "GET" || method === "HEAD" ? "" : await request.clone().text();
    const write = isWrite(method, path, body);
    let created: { kind: "worker_script" | "workflow" | "d1_database" | "queue"; name: string } | null = null;

    if (method !== "GET") {
      if (!accountPath) refuse(`${method} ${url.pathname} is outside the account`);
      let m: RegExpMatchArray | null;
      if ((m = path.match(/^\/workers\/scripts\/([^/]+)(\/.*)?$/))) {
        const name = decodeURIComponent(m[1]!);
        if (!ownName(name)) refuse(`Worker "${name}" does not carry ${ownPrefix}`);
        const sub = m[2] ?? "";
        if (!SCRIPT_WRITES.some((w) => w.method === method && w.sub.test(sub))) refuse(`${method} ${shown} is not a write this proof makes`);
        if (method === "PUT" && !sub) created = { kind: "worker_script", name };
        // an upload (a script or a version) and a settings change are inspected for what they bind to
        if ((method === "PUT" && !sub) || (method === "POST" && sub === "/versions") || (method === "PATCH" && sub === "/settings")) {
          inspectUploadMetadata(await readMetadata(request, name));
        }
      } else if ((m = path.match(/^\/workflows\/([^/]+)$/))) {
        const name = decodeURIComponent(m[1]!);
        if (!ownName(name)) refuse(`Workflow "${name}" does not carry ${ownPrefix}`);
        if (method === "PUT") {
          const scriptName = jsonBody<{ script_name?: unknown }>(body, shown).script_name;
          if (!ownName(scriptName)) refuse(`Workflow "${name}" would point at Worker "${String(scriptName)}", which is not this run's`);
          created = { kind: "workflow", name };
        }
      } else if (path === "/d1/database" && method === "POST") {
        const name = jsonBody<{ name?: unknown }>(body, shown).name;
        if (!ownName(name)) refuse(`database "${String(name)}" does not carry ${ownPrefix}`);
        created = { kind: "d1_database", name: name as string };
      } else if ((m = path.match(/^\/d1\/database\/([^/]+)(\/.*)?$/))) {
        if (!knownDbIds.has(m[1]!)) refuse(`database id ${m[1]} is not one of this run's databases`);
        const sub = m[2] ?? "";
        if (!((method === "POST" && sub === "/query") || (method === "DELETE" && sub === ""))) refuse(`${method} ${shown} is not a write this proof makes`);
      } else if (path === "/queues" && method === "POST") {
        const name = jsonBody<{ queue_name?: unknown }>(body, shown).queue_name;
        if (!ownName(name)) refuse(`queue "${String(name)}" does not carry ${ownPrefix}`);
        created = { kind: "queue", name: name as string };
      } else if ((m = path.match(/^\/queues\/([^/]+)$/))) {
        if (!knownQueueIds.has(m[1]!)) refuse(`queue id ${m[1]} is not one of this run's queues`);
      } else {
        refuse(`${method} ${shown} is not a write this proof makes`);
      }
    }

    if (created && !ledger.has(created.kind, created.name)) ledger.planned(created.kind, created.name);
    let response: Response;
    try {
      response = await params.fetch(request);
    } catch (error) {
      params.log.push({ phase: params.phase(), method, path: shown, status: null, write });
      throw error;
    }
    params.log.push({ phase: params.phase(), method, path: shown, status: response.status, write });
    if (method === "GET") await learn(path, response);
    if (created && response.ok) {
      let id: string | undefined;
      try {
        const result = ((await response.clone().json()) as { result?: Record<string, unknown> }).result ?? {};
        id = typeof result.uuid === "string" ? result.uuid : typeof result.queue_id === "string" ? result.queue_id : undefined;
      } catch {
        id = undefined;
      }
      if (created.kind === "d1_database" && id) knownDbIds.add(id);
      if (created.kind === "queue" && id) knownQueueIds.add(id);
      ledger.created(created.kind, created.name, id);
    }
    return response;
  };
}

export async function runLiveStudioDeploy(deps: LiveStudioDeployDeps): Promise<LiveStudioDeployResult> {
  const commandStartedAt = new Date().toISOString();
  const log = deps.log ?? ((line: string) => console.log(line));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollTimeoutMs = deps.pollTimeoutMs ?? 120_000;
  const pollIntervalMs = deps.pollIntervalMs ?? 3_000;
  const { token, accountId } = deps.credentials;
  // Before anything is sent anywhere: a Global API Key is never used, and the "revoked" token must be a different token.
  const GLOBAL_API_KEY = /^[0-9a-f]{37}$/i;
  if (GLOBAL_API_KEY.test(token.trim())) throw new LiveProofRefusal("CLOUDFLARE_API_TOKEN looks like a Global API Key (37 hex characters): use a scoped API token; nothing was sent");
  if (deps.revokedToken !== undefined) {
    if (GLOBAL_API_KEY.test(deps.revokedToken.trim())) throw new LiveProofRefusal("the revoked token looks like a Global API Key: nothing was sent");
    if (deps.revokedToken.trim() === token.trim()) throw new LiveProofRefusal("the revoked token is CLOUDFLARE_API_TOKEN itself: step 6 needs a different, revoked token; nothing was sent");
  }
  if (typeof deps.rootSecret !== "string" || deps.rootSecret.trim().length < 16) throw new LiveProofRefusal("PX_TELEMETRY_SECRET (Studio's root secret, 16+ characters) is required");

  const ledger = openLedger(deps.ledgerStore, () => deps.randomHex(4), () => new Date(), STUDIO_TEST_NAME_POLICY);
  const live = ledger.entries().filter((e) => e.status !== "removed");
  if (live.length > 0) throw new LiveProofRefusal(`the ledger lists ${live.length} resource(s) not yet removed (${live.map((e) => e.name).join(", ")}): run with --teardown first`);
  const project = studioTestProject(ledger.suffix);
  const ownPrefix = `px-${project}-`;

  const accessKeys = { preview: await deriveWorkerAccessKey(deps.rootSecret, project, "preview"), production: await deriveWorkerAccessKey(deps.rootSecret, project, "production") };
  const controlPlaneSecret = await deriveProjectSecret(deps.rootSecret, project, "control-plane");
  const webhookSecret = await deriveProjectSecret(deps.rootSecret, project, "telemetry-webhook");
  const secrets: Record<string, string> = {
    token,
    accountId,
    rootSecret: deps.rootSecret,
    accessKeyPreview: accessKeys.preview,
    accessKeyProduction: accessKeys.production,
    controlPlaneSecret,
    webhookSecret,
    ...(deps.revokedToken ? { revokedToken: deps.revokedToken } : {}),
  };
  // secrets grows (brick secrets are generated below), so the redactor is rebuilt from it each time
  const hide = (text: string) => createRedactor(Object.values(secrets))(text);
  const say = (line: string) => log(hide(line));

  let phase = "preflight";
  const calls: CallLine[] = [];
  const budget = deps.budget ?? createRequestBudget({ sleep });
  const guardedFetch = createGuardedFetch({ fetch: deps.cloudflareFetch, accountId, ownPrefix, ledger, log: calls, phase: () => phase });
  const rest: Client = createClient({ credentials: deps.credentials, fetch: guardedFetch, sleep, budget, alsoHide: Object.values(secrets) });

  const steps: Record<string, unknown> = {};
  const result: LiveStudioDeployResult = { commandStartedAt, finishedAt: "", completed: false, stoppedBecause: null, project, prefix: ownPrefix, steps, teardown: null, writesDuringRedeploy: -1 };

  // ---- safety: nothing of ours may already exist outside the ledger
  const unledgered = await findUnledgered(rest, ledger, STUDIO_TEST_NAME_POLICY);
  if (unledgered.length > 0) {
    throw new LiveProofRefusal(`the account already holds ${unledgered.length} px-tangebricks-test-* resource(s) this ledger does not list (${unledgered.map((u) => `${u.kind} ${u.name}`).join(", ")}); nothing was created. Remove them yourself or point --state-dir at the ledger that made them.`);
  }

  const studio = createNodeStudioEnv({ rootSecret: deps.rootSecret });
  const app = createStudioApiApp({ deploy: { fetch: guardedFetch, workerFetch: deps.workerFetch, bundle: deps.bundle, sleep, budgetFor: () => budget } });
  const call = async (method: string, path: string, body?: unknown, session?: string, orgId?: string) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (session) headers.authorization = `Bearer ${session}`;
    if (orgId) headers["x-org-id"] = orgId;
    const res = await app.fetch(new Request(`https://studio.local${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), studio.env);
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { text: text.slice(0, 300) };
    }
    return { status: res.status, body: json };
  };
  const must = (what: string, ok: boolean, detail: unknown) => {
    if (!ok) throw new LiveProofRefusal(`${what} failed: ${hide(JSON.stringify(detail)).slice(0, 1200)}`);
  };
  const workerCall = async (url: string, init: RequestInit) => {
    const res = await deps.workerFetch(new Request(url, init));
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { text: text.slice(0, 200) };
    }
    return { status: res.status, body: json };
  };

  try {
    // ---- 1. connect the token through Studio's verify-and-save
    phase = "connect";
    const signup = await call("POST", "/api/auth/signup", { email: `owner-${ledger.suffix}@tangebricks.test`, password: `Pw-${deps.randomHex(12)}!`, name: "Tangebricks Live Proof" });
    must("signing up the proof's Studio owner", signup.status === 201, signup);
    const session = String(signup.body.token);
    const org = await call("POST", "/api/orgs", { name: "Tangebricks Live Proof", slug: `tangebricks-test-${ledger.suffix}` }, session);
    must("creating the org", org.status === 200 || org.status === 201, org);
    const orgId = String(org.body.id);
    const proj = await call("POST", `/api/orgs/${orgId}/projects`, { project }, session);
    must("creating the project", proj.status === 200 || proj.status === 201, proj);
    const connect = await call("POST", `/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, { token, accountId, projectId: project }, session);
    const verification = connect.body.verification as { ok?: boolean; status?: string; permissions?: Array<{ label: string; granted: boolean }> } | undefined;
    steps.connect = { httpStatus: connect.status, status: verification?.status, permissions: verification?.permissions?.map((p) => ({ label: p.label, granted: p.granted })) };
    must("verify-and-save (the token must be active with every required permission)", connect.status === 201 && verification?.ok === true && (verification.permissions ?? []).every((p) => p.granted), { status: connect.status, error: connect.body.error });
    say(`1. token verified by Cloudflare through Studio: ${verification?.status}, ${(verification?.permissions ?? []).length} permissions granted`);

    // ---- 2. the project: INVOICE_FLOW_BLUEPRINT with credit-wallet, a real identity, and a stored graph trigger.manual -> credit-wallet.debit
    phase = "blueprint";
    const ops = liveProofOps();
    const opsRes = await call("POST", `/api/projects/${project}/ops`, { summary: "Live Studio deploy proof (R53)", ops }, session, orgId);
    must("applying the blueprint ops", opsRes.status === 200, opsRes);
    for (const name of LIVE_PROOF_BRICK_SECRETS) {
      const value = deps.randomHex(24);
      secrets[`brick_${name}`] = value;
      const sec = await call("POST", `/api/projects/${project}/secrets`, { ref: `sec_${name.toLowerCase()}`, kind: "brick_secret", label: name, appOrBrick: "core-auth", value, bindTarget: { targetKind: "brick", targetId: "core-auth", secretName: name } }, session, orgId);
      must(`storing the ${name} brick secret`, sec.status === 200, sec);
    }
    say(`2. project ${project}: ${INVOICE_FLOW_BLUEPRINT.bricks.join(", ")}, oidc-verify identity, graph ${GRAPH_ID}`);

    // ---- 3. plan and deploy preview, then production
    const deployed: Record<string, { url: string; action: string }> = {};
    for (const envName of ["preview", "production"] as const) {
      phase = `deploy-${envName}`;
      const plan = await call("POST", `/api/projects/${project}/environments/${envName}/plan`, {}, session, orgId);
      must(`planning ${envName}`, plan.status === 200, plan);
      const route = envName === "preview" ? "deploy" : "promote";
      const dep = await call("POST", `/api/projects/${project}/environments/${envName}/${route}`, {}, session, orgId);
      must(`deploying ${envName}`, dep.status === 200 && dep.body.ok === true, dep);
      const url = String((dep.body.deployment as { url?: string } | undefined)?.url ?? "");
      deployed[envName] = { url, action: String(dep.body.action) };
      // the new address may take a little while to answer
      let health = { status: 0, body: {} as Record<string, unknown> };
      for (const started = Date.now(); Date.now() - started < pollTimeoutMs; await sleep(pollIntervalMs)) {
        health = await workerCall(`${url}/healthz`, { headers: { [KEY_HEADER]: accessKeys[envName] } }).catch(() => ({ status: 0, body: {} }));
        if (health.status === 200) break;
      }
      steps[`deploy_${envName}`] = { planAction: plan.body.action, action: dep.body.action, workerUrl: url, healthzStatus: health.status, mutatingCallCount: dep.body.mutatingCallCount };
      must(`${envName} /healthz`, health.status === 200, health);
      say(`3. ${envName}: ${String(dep.body.action)} -> ${url} (/healthz ${health.status})`);
    }

    // ---- 4. redeploy both: nothing changes, nothing is written
    phase = "redeploy";
    const redeploys: Record<string, unknown> = {};
    for (const envName of ["preview", "production"] as const) {
      const route = envName === "preview" ? "deploy" : "promote";
      const again = await call("POST", `/api/projects/${project}/environments/${envName}/${route}`, {}, session, orgId);
      redeploys[envName] = { httpStatus: again.status, action: again.body.action, noChanges: again.body.noChanges, changes: again.body.appliedActions, mutatingCallCount: again.body.mutatingCallCount };
      must(`redeploying ${envName} unchanged`, again.status === 200 && again.body.action === "noop" && Array.isArray(again.body.appliedActions) && (again.body.appliedActions as unknown[]).length === 0 && again.body.mutatingCallCount === 0, again);
    }
    result.writesDuringRedeploy = calls.filter((c) => c.phase === "redeploy" && c.write).length;
    steps.redeploy = { ...redeploys, writeCalls: result.writesDuringRedeploy };
    must("redeploy without write calls", result.writesDuringRedeploy === 0, calls.filter((c) => c.phase === "redeploy" && c.write));
    say(`4. redeploy: changes [] on both, ${result.writesDuringRedeploy} write calls`);

    // ---- 5. the 1.1 live proof on production: a signed run debits a funded workspace once; no/bad workspace is refused
    phase = "wallet";
    const dbName = `${ownPrefix}production-db`;
    const db = (await rest.listDatabases(dbName)).find((d) => d.name === dbName);
    must("finding the production database", Boolean(db), { dbName });
    const workspaceId = `ws_live_${ledger.suffix}`;
    await rest.queryDatabase(db!.uuid, [{ sql: "INSERT INTO credit_wallets (workspace_id, balance_milli) VALUES (?, ?) ON CONFLICT(workspace_id) DO UPDATE SET balance_milli = excluded.balance_milli", params: [workspaceId, FUNDED_MILLI] }]);
    const readWallet = async () => {
      const [balance, ledgerRows] = await rest.queryDatabase(db!.uuid, [
        { sql: "SELECT balance_milli FROM credit_wallets WHERE workspace_id = ?", params: [workspaceId] },
        { sql: "SELECT COUNT(*) AS n FROM credit_ledger WHERE workspace_id = ? AND type = 'deduction'", params: [workspaceId] },
      ]);
      return { balanceMilli: Number(balance?.results[0]?.balance_milli ?? NaN), deductions: Number(ledgerRows?.results[0]?.n ?? NaN) };
    };
    const before = await readWallet();
    const runUrl = `${deployed.production!.url}${WORKFLOW_RUNS_PATH}`;
    const signedRun = async (payload: Record<string, unknown>) => {
      const body = JSON.stringify(payload);
      const signature = await signControlPlaneRequest(controlPlaneSecret, "POST", WORKFLOW_RUNS_PATH, body);
      return workerCall(runUrl, { method: "POST", headers: { "content-type": "application/json", [KEY_HEADER]: accessKeys.production, ...signature }, body });
    };
    const runId = randomUUID();
    const started = await signedRun({ requestId: runId, graphId: GRAPH_ID, workspaceId, payload: liveProofRunPayload(workspaceId) });
    must("starting the signed run", started.status === 202, started);
    let after = before;
    for (const t0 = Date.now(); Date.now() - t0 < pollTimeoutMs; await sleep(pollIntervalMs)) {
      after = await readWallet();
      if (after.deductions >= 1) break;
    }
    // When the debit did not land, say why: Cloudflare's own record of the Workflow run (status, error, the failed nodes and
    // each step), read with one GET on the pinned account, redacted.
    let instance: Record<string, unknown> | undefined;
    if (after.deductions < 1) {
      instance = await describeWorkflowRun(rest, `${ownPrefix}production-graphs`, String((started.body as { id?: unknown }).id ?? runId), hide);
    }
    const noWorkspace = await signedRun({ requestId: randomUUID(), graphId: GRAPH_ID, payload: {} });
    const badWorkspace = await signedRun({ requestId: randomUUID(), graphId: GRAPH_ID, workspaceId: "ws__not_a_tenant", payload: {} });
    await sleep(Math.min(pollIntervalMs * 2, 10_000));
    const final = await readWallet();
    const codeOf = (r: { body: Record<string, unknown> }) => (r.body.error as { code?: string } | undefined)?.code;
    steps.wallet = {
      workspaceId,
      fundedMilli: FUNDED_MILLI,
      before,
      afterRun: after,
      runStatus: started.status,
      ...(instance ? { instance } : {}),
      noWorkspace: { status: noWorkspace.status, code: codeOf(noWorkspace) },
      badWorkspace: { status: badWorkspace.status, code: codeOf(badWorkspace) },
      final,
    };
    must("the signed run debited the workspace exactly once", after.deductions === 1 && after.balanceMilli < before.balanceMilli, steps.wallet);
    must("a run with no workspace is refused (400 NO_WORKSPACE)", noWorkspace.status === 400 && codeOf(noWorkspace) === "NO_WORKSPACE", noWorkspace);
    must("a run with a bad workspace is refused (400 BAD_WORKSPACE)", badWorkspace.status === 400 && codeOf(badWorkspace) === "BAD_WORKSPACE", badWorkspace);
    must("the refused runs debited nothing", final.deductions === 1 && final.balanceMilli === after.balanceMilli, steps.wallet);
    say(`5. wallet: ${before.balanceMilli} -> ${after.balanceMilli} milli-credits, 1 deduction; no workspace ${noWorkspace.status}, bad workspace ${badWorkspace.status}, nothing more debited`);

    // ---- 6. a revoked token is refused by Studio, and a deploy with it is refused by Cloudflare
    if (deps.revokedToken) {
      phase = "revoked";
      const refused = await call("POST", `/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, { token: deps.revokedToken, accountId, projectId: project }, session);
      const refusedStatus = (refused.body.verification as { status?: string } | undefined)?.status;
      const revokedClient = createClient({ credentials: { token: deps.revokedToken, accountId }, fetch: guardedFetch, sleep, budget, alsoHide: Object.values(secrets) });
      // Before any upload: Cloudflare itself must refuse the token at both verify endpoints (or report it not active).
      let directVerify: string;
      try {
        const answer = await revokedClient.verifyToken();
        directVerify = `${answer.kind} endpoint says ${answer.status}`;
        if (answer.status === "active") {
          steps.revoked = { verifyHttpStatus: refused.status, verifyStatus: refusedStatus, directVerify };
          throw new LiveProofRefusal(`the "revoked" token is ACTIVE at Cloudflare (${directVerify}): step 6 stopped and nothing was uploaded with it; revoke it first`);
        }
      } catch (error) {
        if (error instanceof LiveProofRefusal) throw error;
        if (!(error instanceof CloudflareApiError)) throw error; // unreachable is not a refusal
        directVerify = `refused at both endpoints (HTTP ${error.status})`;
      }
      let deployRefused = false;
      let deployRefusal = "";
      try {
        await revokedClient.uploadScript(`${ownPrefix}revoked`, { mainModule: "worker.mjs", code: "export default { fetch() { return new Response('must not exist'); } };", metadata: { compatibility_date: "2026-10-01" } });
      } catch (error) {
        deployRefused = isCloudflareError(error) && "status" in error && ((error as { status: number }).status === 401 || (error as { status: number }).status === 403);
        deployRefusal = hide(error instanceof Error ? error.message : String(error));
      }
      steps.revoked = { verifyHttpStatus: refused.status, verifyStatus: refusedStatus, errorCode: (refused.body.error as { code?: string } | undefined)?.code, directVerify, deployRefused, deployRefusal };
      must("the revoked token is refused by verify-and-save", refused.status === 422 && refusedStatus !== "active", refused);
      must("a deploy with the revoked token is refused", deployRefused, steps.revoked);
      say(`6. revoked token: verify-and-save ${refused.status} (${refusedStatus}); upload refused by Cloudflare`);
    }
    result.completed = true;
  } catch (error) {
    result.stoppedBecause = hide(error instanceof Error ? error.message : String(error));
    say(`stopped: ${result.stoppedBecause}`);
  } finally {
    // ---- 7. teardown: exactly what the ledger lists, then a read that nothing of ours is left
    phase = "teardown";
    try {
      const removed = await teardown(rest, ledger, STUDIO_TEST_NAME_POLICY);
      const leftBehind = await findUnledgered(rest, ledger, STUDIO_TEST_NAME_POLICY);
      const stillListed = ledger.entries().filter((e) => e.status !== "removed").map((e) => ({ kind: e.kind, name: e.name }));
      result.teardown = { removed: removed.removed, alreadyGone: removed.alreadyGone, leftBehind: [...leftBehind, ...stillListed] };
      if (result.teardown.leftBehind.length > 0) {
        result.completed = false;
        result.stoppedBecause = result.stoppedBecause ?? `teardown left ${result.teardown.leftBehind.length} resource(s) behind`;
      }
      say(`7. teardown: ${removed.removed.length} removed, ${removed.alreadyGone.length} already gone, ${result.teardown.leftBehind.length} left behind`);
    } catch (error) {
      result.completed = false;
      result.stoppedBecause = `${result.stoppedBecause ? `${result.stoppedBecause}; ` : ""}teardown failed: ${hide(error instanceof Error ? error.message : String(error))} (run again with --teardown)`;
      say(result.stoppedBecause);
    }
    studio.close();
  }

  // ---- 8. evidence (after the teardown, so it records what was left): checked for secrets in memory, then the integrity record
  result.finishedAt = new Date().toISOString();
  // The account's workers.dev subdomain never reaches the evidence: both files are redacted before any hash is taken.
  const callsText = `${JSON.stringify(redactWorkersDevSubdomains({ commandStartedAt, project, calls }), null, 2)}\n`;
  // The calls file is covered by the integrity record through its hash in the result file (only *-result.json are recorded).
  const resultText = `${JSON.stringify({ ...redactWorkersDevSubdomains(result), callsFile: CALLS_FILE, callsSha256: createHash("sha256").update(callsText).digest("hex") }, null, 2)}\n`;
  for (const [name, text] of [[RESULT_FILE, resultText], [CALLS_FILE, callsText]] as const) {
    const hits = findSecrets(text, secrets);
    if (hits.length > 0) throw new LiveProofRefusal(`refusing to write ${name}: it contains ${hits.join(" and ")}`);
  }
  const dir = join(deps.root, "evidence", "deployed");
  const attempts = join(dir, "attempts");
  mkdirSync(attempts, { recursive: true });
  const stampOf = (iso: string) => iso.replace(/[:.]/g, "-");
  if (result.completed) {
    // A pass becomes the canonical result; the previous canonical pair moves to attempts/ under its own run's time.
    const previous = join(dir, RESULT_FILE);
    if (existsSync(previous)) {
      let previousStart = commandStartedAt;
      try {
        previousStart = String((JSON.parse(readFileSync(previous, "utf8")) as { commandStartedAt?: string }).commandStartedAt ?? commandStartedAt);
      } catch {
        // unreadable: filed under this run's time
      }
      for (const name of [RESULT_FILE, CALLS_FILE]) if (existsSync(join(dir, name))) renameSync(join(dir, name), join(attempts, `${stampOf(previousStart)}-${name}`));
    }
    writeFileSync(join(dir, RESULT_FILE), resultText);
    writeFileSync(join(dir, CALLS_FILE), callsText);
  } else {
    // A failure never replaces a passing canonical result: it is kept as an attempt only.
    writeFileSync(join(attempts, `${stampOf(commandStartedAt)}-${RESULT_FILE}`), resultText);
    writeFileSync(join(attempts, `${stampOf(commandStartedAt)}-${CALLS_FILE}`), callsText);
  }
  const integrity = recordLiveIntegrity(deps.root);
  if (!integrity.ok) {
    result.completed = false;
    say(`evidence:record-live refused: ${integrity.errors.join("; ")}`);
  } else say(`8. evidence written to evidence/deployed/${result.completed ? RESULT_FILE : `attempts/${stampOf(commandStartedAt)}-${RESULT_FILE}`} and recorded in integrity.json`);
  return result;
}

/**
 * Cloudflare's record of one Workflow run (GET /accounts/{id}/workflows/{name}/instances/{id}), reduced to what explains an
 * outcome: its status, its error, the nodes the graph reported failed, and each step's name and success. Every text goes
 * through hide(). A read that fails is reported, never thrown: this only explains a failure already found.
 */
export async function describeWorkflowRun(client: Client, workflowName: string, instanceId: string, hide: (text: string) => string): Promise<Record<string, unknown>> {
  try {
    const record = await client.getWorkflowInstance(workflowName, instanceId);
    if (record === null) return { found: false };
    const output = record.output as { ok?: unknown; failed?: Record<string, unknown> } | null;
    return JSON.parse(
      hide(
        JSON.stringify({
          found: true,
          status: record.status,
          success: record.success,
          error: record.error,
          ...(output && typeof output === "object" ? { ok: output.ok ?? null, failed: output.failed ?? {} } : {}),
          steps: record.steps.map((step) => ({ name: step.name, success: step.success })),
        }),
      ),
    ) as Record<string, unknown>;
  } catch (error) {
    return { found: null, readError: hide(error instanceof Error ? error.message : String(error)) };
  }
}

/** Only teardown: removes what the ledger lists (an interrupted run), through the same guard. */
export async function runTeardownOnly(deps: Pick<LiveStudioDeployDeps, "credentials" | "cloudflareFetch" | "ledgerStore" | "log" | "sleep">): Promise<TeardownResult> {
  const data = deps.ledgerStore.read();
  if (!data) throw new LiveProofRefusal("there is no ledger in this state folder: nothing to tear down");
  const ledger = openLedger(deps.ledgerStore, () => data.suffix, () => new Date(), STUDIO_TEST_NAME_POLICY);
  const calls: CallLine[] = [];
  const guarded = createGuardedFetch({ fetch: deps.cloudflareFetch, accountId: deps.credentials.accountId, ownPrefix: `px-${studioTestProject(ledger.suffix)}-`, ledger, log: calls, phase: () => "teardown" });
  const client = createClient({ credentials: deps.credentials, fetch: guarded, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
  return teardown(client, ledger, STUDIO_TEST_NAME_POLICY);
}

// ---------------------------------------------------------------------------------------------------------------------
// The command. Only this part reads the environment and the network.

const repoRoot = resolve(import.meta.dirname, "..");

/** The bundler the live command gives Studio: the assembled files written under out/, then bundleWorker (esbuild). */
export async function nodeBundler(input: { project: string; envName: string; files: Record<string, string> }) {
  const { bundleWorker } = await import("../packages/deploy/src/bundle.ts");
  const { OUT_DIR, writeProject } = await import("../test/support/emitted.ts");
  const projectDir = join(OUT_DIR, "live-studio", `${input.project}-${input.envName}`);
  await writeProject(projectDir, input.files);
  const bundle = await bundleWorker({ projectDir, environment: input.envName, resolveRepoBricks: true });
  return { code: bundle.code, sha256: bundle.sha256, bytes: bundle.bytes, gzipBytes: bundle.gzipBytes };
}

async function main(argv: string[]): Promise<number> {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
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
  const inside = (child: string, parent: string) => (child + sep).toLowerCase().startsWith((resolve(parent) + sep).toLowerCase());
  if (inside(stateDir, repoRoot)) {
    console.error("the state folder must be outside the repository");
    return 2;
  }
  mkdirSync(stateDir, { recursive: true });
  const ledgerStore = fileStore(join(stateDir, "studio-ledger.json"));
  // No redirect is ever followed: a redirected API answer is an error, not a new destination.
  const realFetch = (request: Request) => fetch(new Request(request, { signal: AbortSignal.timeout(60_000), redirect: "error" }));

  if (argv.includes("--teardown")) {
    const res = await runTeardownOnly({ credentials, cloudflareFetch: realFetch, ledgerStore });
    console.log(`teardown: removed ${res.removed.length}, already gone ${res.alreadyGone.length}, unledgered ${res.unledgered.length}`);
    for (const u of res.unledgered) console.log(`  not in the ledger (left alone): ${u.kind} ${u.name}`);
    return res.unledgered.length === 0 ? 0 : 1;
  }

  // A finished ledger is kept beside a new one, so every run gets its own suffix.
  const ledgerPath = join(stateDir, "studio-ledger.json");
  const previous = ledgerStore.read();
  if (previous && previous.entries.every((e) => e.status === "removed")) renameSync(ledgerPath, `${ledgerPath}.${new Date().toISOString().replace(/[:.]/g, "-")}.done`);

  const revokedEnv = arg("--revoked-token-env");
  const revokedToken = revokedEnv ? process.env[revokedEnv]?.trim() : undefined;
  if (revokedEnv && !revokedToken) {
    console.error(`--revoked-token-env ${revokedEnv}: that variable is not set`);
    return 2;
  }
  const rootSecret = process.env.PX_TELEMETRY_SECRET?.trim() ?? "";
  const result = await runLiveStudioDeploy({
    credentials,
    rootSecret,
    ...(revokedToken ? { revokedToken } : {}),
    cloudflareFetch: realFetch,
    workerFetch: realFetch,
    bundle: nodeBundler,
    ledgerStore,
    randomHex: (n) => randomBytes(n).toString("hex"),
    root: repoRoot,
  });
  console.log(result.completed ? "live Studio deploy proof: PASSED" : `live Studio deploy proof: FAILED (${result.stoppedBecause})`);
  return result.completed ? 0 : 1;
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

