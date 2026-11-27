// What the live Studio scripts share (story R53's live deploy proof and story R55's agent benchmark): Studio's own API run
// in-process on the REAL Cloudflare client, behind a guard that refuses every write outside one run's own prefix, a ledger
// written before each create, the owner's sign-up -> org -> project -> verify-and-save flow, the Worker bundler, and the
// teardown that removes exactly what the ledger lists. One implementation; scripts/live-studio-deploy.ts and
// scripts/agent-bench.ts both build on it.
import { join } from "node:path";
import { createStudioApiApp } from "../../apps/studio-api/src/index.ts";
import type { StudioApiEnv, StudioDeployOptions } from "../../apps/studio-api/src/index.ts";
import {
  STUDIO_TEST_NAME_POLICY,
  RequestGuardError,
  createClient,
  createRequestBudget,
  findUnledgered,
  openLedger,
  studioTestProject,
  teardown,
} from "../../packages/deploy/src/provisioner/index.ts";
import type { Client, LedgerStore, RequestBudget, TeardownResult } from "../../packages/deploy/src/provisioner/index.ts";
import { createNodeStudioEnv } from "./studio-node-env.ts";

/** A live run refused or stopped by one of its own checks (never a Cloudflare error passed through). */
export class LiveProofRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveProofRefusal";
  }
}

export interface CallLine {
  phase: string;
  method: string;
  path: string;
  status: number | null;
  write: boolean;
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
  const ledgeredDbIds = () =>
    new Set(
      ledger
        .entries()
        .filter((e) => e.kind === "d1_database" && e.status !== "removed" && e.id)
        .map((e) => e.id!),
    );
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
        if (b.script_name !== undefined && !ownName(b.script_name))
          refuse(`binding ${String(b.name)} points at Worker "${String(b.script_name)}", which is not this run's`);
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

/** A Global API Key (37 hex characters) is never used: only a scoped API token. */
export const GLOBAL_API_KEY = /^[0-9a-f]{37}$/i;

/** One way to call Studio's routes in-process (app.fetch), as a JSON client with an optional session and org. */
export type StudioCall = (
  method: string,
  path: string,
  body?: unknown,
  session?: string,
  orgId?: string,
) => Promise<{ status: number; body: Record<string, unknown> }>;

export function createStudioCall(app: ReturnType<typeof createStudioApiApp>, env: StudioApiEnv): StudioCall {
  return async (method, path, body, session, orgId) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (session) headers.authorization = `Bearer ${session}`;
    if (orgId) headers["x-org-id"] = orgId;
    const res = await app.fetch(
      new Request(`https://studio.local${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
      env,
    );
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { text: text.slice(0, 300) };
    }
    return { status: res.status, body: json };
  };
}

export interface ConnectedOwner {
  session: string;
  orgId: string;
  connect: { httpStatus: number; status: string | undefined; permissions: Array<{ label: string; granted: boolean }> | undefined };
}

/**
 * The owner's way in, through Studio's own routes: sign up, create an org and the project, then connect the Cloudflare
 * token with verify-and-save (Cloudflare itself checks it is active with every required permission). `must` stops the
 * caller's run with its own error type when a step fails.
 */
export async function connectStudioOwner(params: {
  call: StudioCall;
  suffix: string;
  project: string;
  token: string;
  accountId: string;
  randomHex: (bytes: number) => string;
  name: string;
  must: (what: string, ok: boolean, detail: unknown) => void;
  /** Told what verify-and-save answered before that answer is checked, so a refused token is still on record. */
  onConnect?: (connect: ConnectedOwner["connect"]) => void;
}): Promise<ConnectedOwner> {
  const { call, suffix, project, must } = params;
  const signup = await call("POST", "/api/auth/signup", {
    email: `owner-${suffix}@tangebricks.test`,
    password: `Pw-${params.randomHex(12)}!`,
    name: params.name,
  });
  must("signing up the run's Studio owner", signup.status === 201, signup);
  const session = String(signup.body.token);
  const org = await call("POST", "/api/orgs", { name: params.name, slug: `tangebricks-test-${suffix}` }, session);
  must("creating the org", org.status === 200 || org.status === 201, org);
  const orgId = String(org.body.id);
  const proj = await call("POST", `/api/orgs/${orgId}/projects`, { project }, session);
  must("creating the project", proj.status === 200 || proj.status === 201, proj);
  const connect = await call(
    "POST",
    `/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`,
    { token: params.token, accountId: params.accountId, projectId: project },
    session,
  );
  const verification = connect.body.verification as { ok?: boolean; status?: string; permissions?: Array<{ label: string; granted: boolean }> } | undefined;
  const summary = {
    httpStatus: connect.status,
    status: verification?.status,
    permissions: verification?.permissions?.map((p) => ({ label: p.label, granted: p.granted })),
  };
  params.onConnect?.(summary);
  must(
    "verify-and-save (the token must be active with every required permission)",
    connect.status === 201 && verification?.ok === true && (verification.permissions ?? []).every((p) => p.granted),
    { status: connect.status, error: connect.body.error },
  );
  return { session, orgId, connect: summary };
}

export type TeardownRecord = Omit<TeardownResult, "unledgered"> & { leftBehind: Array<{ kind: string; name: string }> };

/** Removes exactly what the ledger lists, then reads the account to check nothing of the run's is left. */
export async function teardownAndVerify(rest: Client, ledger: ReturnType<typeof openLedger>): Promise<TeardownRecord> {
  const removed = await teardown(rest, ledger, STUDIO_TEST_NAME_POLICY);
  const leftBehind = await findUnledgered(rest, ledger, STUDIO_TEST_NAME_POLICY);
  const stillListed = ledger
    .entries()
    .filter((e) => e.status !== "removed")
    .map((e) => ({ kind: e.kind, name: e.name }));
  return { removed: removed.removed, alreadyGone: removed.alreadyGone, leftBehind: [...leftBehind, ...stillListed] };
}

/** Only teardown: removes what the ledger lists (an interrupted run), through the same guard. */
export async function runTeardownOnly(deps: {
  credentials: { token: string; accountId: string };
  cloudflareFetch: (request: Request) => Promise<Response>;
  ledgerStore: LedgerStore;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<TeardownResult> {
  const data = deps.ledgerStore.read();
  if (!data) throw new LiveProofRefusal("there is no ledger in this state folder: nothing to tear down");
  const ledger = openLedger(
    deps.ledgerStore,
    () => data.suffix,
    () => new Date(),
    STUDIO_TEST_NAME_POLICY,
  );
  const calls: CallLine[] = [];
  const guarded = createGuardedFetch({
    fetch: deps.cloudflareFetch,
    accountId: deps.credentials.accountId,
    ownPrefix: `px-${studioTestProject(ledger.suffix)}-`,
    ledger,
    log: calls,
    phase: () => "teardown",
  });
  const client = createClient({ credentials: deps.credentials, fetch: guarded, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
  return teardown(client, ledger, STUDIO_TEST_NAME_POLICY);
}

/** The bundler the live commands give Studio: the assembled files written under out/, then bundleWorker (esbuild). */
export async function nodeBundler(input: { project: string; envName: string; files: Record<string, string> }) {
  const { bundleWorker } = await import("../../packages/deploy/src/bundle.ts");
  const { OUT_DIR, writeProject } = await import("../../test/support/emitted.ts");
  const projectDir = join(OUT_DIR, "live-studio", `${input.project}-${input.envName}`);
  await writeProject(projectDir, input.files);
  const bundle = await bundleWorker({ projectDir, environment: input.envName, resolveRepoBricks: true });
  return { code: bundle.code, sha256: bundle.sha256, bytes: bundle.bytes, gzipBytes: bundle.gzipBytes, compatibilityFlags: bundle.compatibilityFlags };
}

/**
 * Studio booted for one live run: the guarded way to Cloudflare (every write checked against the run's prefix and written
 * to the ledger first), a REST client on it for the run's own reads and teardown, and, once the caller's preflight has
 * passed, Studio in-process on Node with the REAL Cloudflare client behind the same guard.
 */
export function openGuardedStudio(params: {
  credentials: { token: string; accountId: string };
  cloudflareFetch: (request: Request) => Promise<Response>;
  workerFetch: (request: Request) => Promise<Response>;
  bundle: NonNullable<StudioDeployOptions["bundle"]>;
  rootSecret: string;
  ownPrefix: string;
  ledger: ReturnType<typeof openLedger>;
  calls: CallLine[];
  phase: () => string;
  sleep: (ms: number) => Promise<void>;
  budget?: RequestBudget;
  alsoHide: string[];
}) {
  const { sleep } = params;
  const budget = params.budget ?? createRequestBudget({ sleep });
  const guardedFetch = createGuardedFetch({
    fetch: params.cloudflareFetch,
    accountId: params.credentials.accountId,
    ownPrefix: params.ownPrefix,
    ledger: params.ledger,
    log: params.calls,
    phase: params.phase,
  });
  const rest: Client = createClient({ credentials: params.credentials, fetch: guardedFetch, sleep, budget, alsoHide: params.alsoHide });
  return {
    budget,
    guardedFetch,
    rest,
    boot() {
      const studio = createNodeStudioEnv({ rootSecret: params.rootSecret });
      const app = createStudioApiApp({
        deploy: { fetch: guardedFetch, workerFetch: params.workerFetch, bundle: params.bundle, sleep, budgetFor: () => budget },
      });
      return { studio, app, call: createStudioCall(app, studio.env) };
    },
  };
}
