import {
  handleStepRehearsalRequest,
  handleTelemetryEventsPullRequest,
  handleTelemetryLogsPullRequest,
  handleTelemetryMetricsRequest,
  handleWorkflowRerunRequest,
  handleWorkflowRunRequest,
  TELEMETRY_SIGNATURE_HEADER,
  signTelemetryPayload,
  verifyTelemetrySignature,
} from "@poc/runtime";
import type { D1Like, Executors, Registry } from "@poc/sdk";
import { APP_WORKSPACE, GRAPH_TABLE, ID_PATTERN, LATENCY_TABLE, WORKFLOW_BINDING, isTenantWorkspaceId } from "./graph-run.ts";
import { handleDataBrowserRequest } from "./data-browser.ts";
import { createDeployBricks } from "./catalog-bricks.ts";

// The few routes the proof adds to the deployed Worker, all under /poc/ and all behind the access key (the gate runs first):
//
//   GET  /poc/graphs/:id      returns the app-wide (APP_WORKSPACE) row of that graph; no other workspace's row is visible
//   POST /poc/runs            refused, 403 NO_VERIFIED_WORKSPACE, and no Workflow instance is created. The shared key says
//                             nothing about a workspace, and a run without a verified workspace is refused (story 1.1).
//   GET  /poc/runs/:id        returns the Workflow's status for that run (and its output once it has finished). Since story
//                             1.1 runs belong to tenants and their output can hold balances, so the shared key is not
//                             enough: the request must also carry a control-plane signature (see below, empty body).
//   POST /poc/write-latency   writes a scratch row ten times, one after another, timing each write from inside the Worker.
//                             The row is in its own scratch table, never in the graph table.
//
// The way to start a deployed run is the signed control-plane route (also behind the access key):
//
//   POST /__px/workflow-runs  {requestId, graphId, workspaceId, payload?}, signed with PX_TELEMETRY_SECRET. Starts the
//                             Workflow with params {graphId, workspaceId, payload} under the instance id requestId (a UUID);
//                             returns 202 {id, workspaceId}. A requestId that was already used is 409 DUPLICATE_REQUEST and
//                             nothing new runs, so a replayed request cannot run (or debit) twice. The signed body's
//                             workspaceId is the run's verified workspace: it is whatever the signer put there. Studio
//                             authorises its caller for the project before it signs; the workspace inside that project's
//                             preview data is the one the Studio client names. A body without workspaceId gets 400
//                             NO_WORKSPACE. The signing secret must be PX_TELEMETRY_SECRET itself, distinct from the shared
//                             access key, so holding the access key alone can never start a run for a workspace it chooses.
//
// The control-plane signature on these two routes (story 1.1): header x-px-signed-at (epoch seconds) and x-px-signature, the
// HMAC-SHA256 of `${method}\n${path}\n${signedAt}\n${body}`. A timestamp more than 300 s from the Worker's clock is refused,
// and a signature made for another method, path or body does not verify. The other /__px routes keep their body-only
// signature (deferred).
//
// None of them writes a graph. Graphs are written only by the Studio deploy path (and the owner's own way into their data,
// the D1 REST query endpoint); there is no shared-key route that stores one. A graph is checked when it is run.
// These are reachable only with the per-deploy access key; with no usable key the gate refuses everything.

export interface WorkflowInstanceLike {
  id: string;
  status(): Promise<unknown>;
}
export interface WorkflowBindingLike {
  create(options: { id?: string; params: unknown }): Promise<WorkflowInstanceLike>;
  get(id: string): Promise<WorkflowInstanceLike>;
}
export interface ProofEnv {
  DB: D1Like;
  [binding: string]: unknown;
}

export const LATENCY_WRITES = 10;
export const LATENCY_ROW = "__latency__";
const INSTANCE_ID = /^[A-Za-z0-9_-]{1,100}$/;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const round = (ms: number) => Math.round(ms * 10) / 10;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

async function writeScratch(db: D1Like, id: string, body: string) {
  await db
    .prepare(`INSERT INTO ${LATENCY_TABLE} (id, body, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`)
    .bind(id, body, new Date().toISOString())
    .run();
}

export interface ProofRoutesOptions {
  now?: () => number;
  /** Wall clock in epoch milliseconds, for checking signed timestamps (default Date.now). */
  clock?: () => number;
  /** Default: the real catalog registry and executors (createDeployBricks). Tests may inject fixtures. */
  registry?: Registry;
  executors?: Executors;
}

/** The secret a control-plane request is signed with: PX_TELEMETRY_SECRET, never the shared access key. */
export const MIN_SIGNING_SECRET_LENGTH = 16;
function controlPlaneSecret(env: ProofEnv): string | null {
  const secret = env.PX_TELEMETRY_SECRET;
  if (typeof secret !== "string" || secret.length < MIN_SIGNING_SECRET_LENGTH) return null;
  if (typeof env.POC_ACCESS_KEY === "string" && secret === env.POC_ACCESS_KEY) return null;
  return secret;
}

export const WORKFLOW_RUNS_PATH = "/__px/workflow-runs";
export const SIGNED_AT_HEADER = "x-px-signed-at";
/** How far a signed request's timestamp may be from the Worker's clock, either way. */
export const SIGNATURE_WINDOW_SECONDS = 300;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a control-plane signature covers: the method, the path, the signing time and the body. */
export const controlPlaneCanonical = (method: string, path: string, signedAt: string, body: string) => `${method.toUpperCase()}\n${path}\n${signedAt}\n${body}`;

/** The headers that sign one control-plane request (used by the H11 driver and the tests). */
export async function signControlPlaneRequest(secret: string, method: string, path: string, body = "", nowMs = Date.now()): Promise<Record<string, string>> {
  const signedAt = String(Math.floor(nowMs / 1000));
  return { [SIGNED_AT_HEADER]: signedAt, [TELEMETRY_SIGNATURE_HEADER]: await signTelemetryPayload(controlPlaneCanonical(method, path, signedAt, body), secret) };
}

/** Null when the request carries a fresh, valid control-plane signature over its method, path and body; else the refusal. */
async function refuseUnsignedControlPlane(request: Request, path: string, body: string, secret: string, nowMs: number): Promise<Response | null> {
  const signedAt = request.headers.get(SIGNED_AT_HEADER) ?? "";
  const seconds = /^\d{1,12}$/.test(signedAt) ? Number(signedAt) : NaN;
  if (!Number.isFinite(seconds) || Math.abs(nowMs / 1000 - seconds) > SIGNATURE_WINDOW_SECONDS) {
    return json(401, { error: { code: "STALE_OR_MISSING_SIGNED_AT", message: `${SIGNED_AT_HEADER} must be the signing time in epoch seconds, within ${SIGNATURE_WINDOW_SECONDS} s` } });
  }
  if (!(await verifyTelemetrySignature(controlPlaneCanonical(request.method, path, signedAt, body), request.headers.get(TELEMETRY_SIGNATURE_HEADER), secret))) {
    return json(401, { error: { code: "UNAUTHORIZED_TELEMETRY_SIGNATURE", message: "Missing or invalid X-Px-Signature" } });
  }
  return null;
}

/** POST /__px/workflow-runs: the authenticated trigger of a deployed run. See the note at the top of this file. */
async function startSignedWorkflowRun(request: Request, env: ProofEnv, nowMs: number): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: { code: "METHOD_NOT_ALLOWED", message: `Expected POST ${WORKFLOW_RUNS_PATH}` } });
  const secret = controlPlaneSecret(env);
  if (secret === null) return json(503, { error: { code: "NO_SIGNING_SECRET", message: "this deployment has no control-plane signing secret (PX_TELEMETRY_SECRET, distinct from the access key)" } });
  const rawBody = await request.text();
  const unsigned = await refuseUnsignedControlPlane(request, WORKFLOW_RUNS_PATH, rawBody, secret, nowMs);
  if (unsigned) return unsigned;
  let body: { requestId?: unknown; graphId?: unknown; workspaceId?: unknown; payload?: unknown };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return json(400, { error: { code: "INVALID_JSON", message: "the body must be JSON: {graphId, workspaceId, payload?}" } });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return json(400, { error: { code: "INVALID_JSON", message: "the body must be a JSON object" } });
  if (body.workspaceId === undefined || body.workspaceId === null || body.workspaceId === "") {
    return json(400, { error: { code: "NO_WORKSPACE", message: "the signed run names no workspaceId; a run without a verified workspace is refused" } });
  }
  if (!isTenantWorkspaceId(body.workspaceId)) return json(400, { error: { code: "BAD_WORKSPACE", message: "workspaceId must be a tenant workspace id (letters, digits, _ and -, no double underscore)" } });
  if (typeof body.graphId !== "string" || !ID_PATTERN.test(body.graphId)) return json(400, { error: { code: "BAD_GRAPH_ID", message: "graphId is required" } });
  if (typeof body.requestId !== "string" || !REQUEST_ID.test(body.requestId)) return json(400, { error: { code: "BAD_REQUEST_ID", message: "requestId (a UUID, used as the run's id) is required" } });
  const workflow = env[WORKFLOW_BINDING] as WorkflowBindingLike | undefined;
  if (!workflow) return json(500, { error: "this deployment has no Workflow binding" });
  const requestId = body.requestId.toLowerCase();
  const duplicate = json(409, { error: { code: "DUPLICATE_REQUEST", message: "this requestId has already started a run; nothing new was started" } });
  // One requestId, one run: the id is the Workflow instance's own, so a replayed request finds it taken.
  const existing = await workflow.get(requestId).then(() => true, () => false);
  if (existing) return duplicate;
  let instance: WorkflowInstanceLike;
  try {
    instance = await workflow.create({ id: requestId, params: { graphId: body.graphId, workspaceId: body.workspaceId, payload: body.payload } });
  } catch (error) {
    if (/already|exist|duplicate/i.test(error instanceof Error ? error.message : String(error))) return duplicate;
    throw error;
  }
  return json(202, { id: instance.id, workspaceId: body.workspaceId });
}

/** Returns null for any path outside /poc/ and /__px/, so the project's own routes are never shadowed. */
export function createProofRoutes(
  nowOrOptions: (() => number) | ProofRoutesOptions = () => performance.now(),
) {
  const opts: ProofRoutesOptions =
    typeof nowOrOptions === "function" ? { now: nowOrOptions } : nowOrOptions;
  const now = opts.now ?? (() => performance.now());
  const clock = opts.clock ?? (() => Date.now());
  const defaults = opts.registry && opts.executors ? null : createDeployBricks();
  const registry = opts.registry ?? defaults!.registry;
  const executors = opts.executors ?? defaults!.executors;

  return async function proofRoutes(request: Request, env: ProofEnv): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__px/")) {
      if (url.pathname === WORKFLOW_RUNS_PATH) return startSignedWorkflowRun(request, env, clock());
      const telemetrySecret =
        typeof env.PX_TELEMETRY_SECRET === "string"
          ? env.PX_TELEMETRY_SECRET
          : typeof env.POC_ACCESS_KEY === "string"
            ? env.POC_ACCESS_KEY
            : undefined;
      const pxEnv = env.PX_ENV === "production" ? "production" : "preview";
      const telemetryWebhookUrl =
        typeof env.PX_TELEMETRY_WEBHOOK_URL === "string"
          ? env.PX_TELEMETRY_WEBHOOK_URL
          : undefined;

      // The routes that execute bricks (rehearse, runs, rerun) accept only a signature made with PX_TELEMETRY_SECRET itself,
      // never the shared access key: the signed body names the workspace, so the key alone must not be able to name one.
      const executionSecret = controlPlaneSecret(env) ?? undefined;
      const rehearsed = await handleStepRehearsalRequest(request, {
        registry,
        executors,
        env,
        db: env.DB,
        pxEnv,
        telemetrySecret: executionSecret,
      });
      if (rehearsed) return rehearsed;

      const ran = await handleWorkflowRunRequest(request, {
        registry,
        executors,
        env,
        db: env.DB,
        pxEnv,
        telemetrySecret: executionSecret,
        telemetryWebhookUrl,
      });
      if (ran) return ran;

      const reran = await handleWorkflowRerunRequest(request, {
        registry,
        executors,
        env,
        db: env.DB,
        pxEnv,
        telemetrySecret: executionSecret,
        telemetryWebhookUrl,
      });
      if (reran) return reran;

      const pulled = await handleTelemetryEventsPullRequest(request, {
        db: env.DB,
        telemetrySecret,
      });
      if (pulled) return pulled;

      const pulledLogs = await handleTelemetryLogsPullRequest(request, {
        db: env.DB,
        telemetrySecret,
        pxEnv,
      });
      if (pulledLogs) return pulledLogs;

      const pulledMetrics = await handleTelemetryMetricsRequest(request, {
        db: env.DB,
        telemetrySecret,
        pxEnv,
      });
      if (pulledMetrics) return pulledMetrics;

      const declaredEntities = Array.isArray(env.PX_DECLARED_ENTITIES)
        ? (env.PX_DECLARED_ENTITIES as string[])
        : undefined;
      const secretColumns = Array.isArray(env.PX_SECRET_COLUMNS)
        ? (env.PX_SECRET_COLUMNS as string[])
        : undefined;
      const browsed = await handleDataBrowserRequest(request, {
        db: env.DB,
        pxEnv,
        telemetrySecret,
        declaredEntities,
        secretColumns,
      });
      if (browsed) return browsed;

      return json(404, { error: "no such route" });
    }

    if (!url.pathname.startsWith("/poc/")) return null;
    const parts = url.pathname.split("/").filter(Boolean); // ["poc", area, id?]
    const [, area, id] = parts;
    const workflow = env[WORKFLOW_BINDING] as WorkflowBindingLike | undefined;

    if (area === "graphs" && parts.length === 3 && id !== undefined) {
      if (!ID_PATTERN.test(id)) return json(400, { error: "graph ids are letters, digits, _ and -, up to 64 characters" });
      if (request.method === "GET") {
        const row = await env.DB.prepare(`SELECT graph, updated_at FROM ${GRAPH_TABLE} WHERE workspace_id = ?1 AND id = ?2`).bind(APP_WORKSPACE, id).first<{ graph: string; updated_at: string }>();
        return row === null ? json(404, { error: "no such graph" }) : json(200, { id, graph: row.graph, updatedAt: row.updated_at });
      }
      return json(405, { error: "graphs are read-only here: use GET" });
    }

    if (area === "runs" && parts.length === 2 && request.method === "POST") {
      // The shared key verifies no workspace, and a run without a verified workspace is refused: nothing is started.
      return json(403, { error: { code: "NO_VERIFIED_WORKSPACE", message: `a run without a verified workspace is refused; start it with a signed POST ${WORKFLOW_RUNS_PATH}` } });
    }

    if (area === "runs" && parts.length === 3 && id !== undefined && request.method === "GET") {
      // A run's output belongs to its tenant: the shared key alone does not read it (story 1.1).
      const secret = controlPlaneSecret(env);
      if (secret === null) return json(503, { error: { code: "NO_SIGNING_SECRET", message: "this deployment has no control-plane signing secret (PX_TELEMETRY_SECRET, distinct from the access key)" } });
      const unsigned = await refuseUnsignedControlPlane(request, url.pathname, "", secret, clock());
      if (unsigned) return unsigned;
      if (!workflow) return json(500, { error: "this deployment has no Workflow binding" });
      if (!INSTANCE_ID.test(id)) return json(400, { error: "not a run id" });
      let instance: WorkflowInstanceLike;
      try {
        instance = await workflow.get(id);
      } catch {
        return json(404, { error: "no such run" });
      }
      return json(200, { id, ...((await instance.status()) as object) });
    }

    if (area === "write-latency" && parts.length === 2 && request.method === "POST") {
      const timings: number[] = [];
      for (let i = 0; i < LATENCY_WRITES; i += 1) {
        const start = now();
        await writeScratch(env.DB, LATENCY_ROW, JSON.stringify({ write: i }));
        timings.push(round(now() - start));
      }
      return json(200, { writes: LATENCY_WRITES, timingsMs: timings, medianMs: round(median(timings)), slowestMs: Math.max(...timings) });
    }

    return json(404, { error: "no such route" });
  };
}
