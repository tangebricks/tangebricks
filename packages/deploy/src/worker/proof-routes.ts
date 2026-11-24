import {
  handleStepRehearsalRequest,
  handleTelemetryEventsPullRequest,
  handleTelemetryLogsPullRequest,
  handleTelemetryMetricsRequest,
  handleWorkflowRerunRequest,
  handleWorkflowRunRequest,
} from "@poc/runtime";
import type { D1Like, Executors, Registry } from "@poc/sdk";
import { APP_WORKSPACE, GRAPH_TABLE, ID_PATTERN, LATENCY_TABLE, WORKFLOW_BINDING } from "./graph-run.ts";
import { handleDataBrowserRequest } from "./data-browser.ts";
import { proofExecutors, proofRegistry } from "./proof-bricks.ts";

// The few routes the proof adds to the deployed Worker, all under /poc/ and all behind the access key (the gate runs first):
//
//   GET  /poc/graphs/:id      returns the app-wide (APP_WORKSPACE) row of that graph; no other workspace's row is visible
//   POST /poc/runs            {graphId, payload?} starts the Workflow for APP_WORKSPACE, returns {id}. The workspace is never
//                             taken from the body: this is the operator's proof path, not a tenant's.
//   GET  /poc/runs/:id        returns the Workflow's status for that run (and its output once it has finished)
//   POST /poc/write-latency   writes a scratch row ten times, one after another, timing each write from inside the Worker.
//                             The row is in its own scratch table, never in the graph table.
//
// None of them writes a graph. Graphs are written only by the Studio deploy path (and the owner's own way into their data,
// the D1 REST query endpoint); there is no shared-key route that stores one. A graph is checked when it is run.
// These are reachable only with the per-deploy access key; with no usable key the gate refuses everything.

export interface WorkflowInstanceLike {
  id: string;
  status(): Promise<unknown>;
}
export interface WorkflowBindingLike {
  create(options: { params: unknown }): Promise<WorkflowInstanceLike>;
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
  registry?: Registry;
  executors?: Executors;
}

/** Returns null for any path outside /poc/ and /__px/, so the project's own routes are never shadowed. */
export function createProofRoutes(
  nowOrOptions: (() => number) | ProofRoutesOptions = () => performance.now(),
) {
  const opts: ProofRoutesOptions =
    typeof nowOrOptions === "function" ? { now: nowOrOptions } : nowOrOptions;
  const now = opts.now ?? (() => performance.now());
  const registry = opts.registry ?? proofRegistry;
  const executors = opts.executors ?? proofExecutors;

  return async function proofRoutes(request: Request, env: ProofEnv): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__px/")) {
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

      const rehearsed = await handleStepRehearsalRequest(request, {
        registry,
        executors,
        env,
        db: env.DB,
        pxEnv,
        telemetrySecret,
      });
      if (rehearsed) return rehearsed;

      const ran = await handleWorkflowRunRequest(request, {
        registry,
        executors,
        env,
        db: env.DB,
        pxEnv,
        telemetrySecret,
        telemetryWebhookUrl,
      });
      if (ran) return ran;

      const reran = await handleWorkflowRerunRequest(request, {
        registry,
        executors,
        env,
        db: env.DB,
        pxEnv,
        telemetrySecret,
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
      if (!workflow) return json(500, { error: "this deployment has no Workflow binding" });
      let body: { graphId?: unknown; payload?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json(400, { error: "the body must be JSON: {graphId, payload?}" });
      }
      if (typeof body?.graphId !== "string" || !ID_PATTERN.test(body.graphId)) return json(400, { error: "graphId is required" });
      const instance = await workflow.create({ params: { graphId: body.graphId, workspaceId: APP_WORKSPACE, payload: body.payload } });
      return json(202, { id: instance.id });
    }

    if (area === "runs" && parts.length === 3 && id !== undefined && request.method === "GET") {
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
