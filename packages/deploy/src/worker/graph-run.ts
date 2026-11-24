import { PX_TELEMETRY_MIGRATION_SQL, isTenantWorkspaceId as isRuntimeTenantWorkspaceId, runGraph, stepPolicyFor } from "@poc/runtime";
import type { Graph, RunResult, TelemetryRunOptions } from "@poc/runtime";
import { checkGraphBudget, validateGraph } from "@poc/sdk";
import type { D1Like, Executors, Registry } from "@poc/sdk";

// How a stored graph is run as a Workflow. Everything here is plain code with no Cloudflare import, so it is tested in
// Node against a fake step as well as in workerd against the real Workflow engine (graph-workflow.ts is the thin class
// that connects it to the engine).
//
// The shape of a run:
//   1. ONE step reads the graph row from D1 and checks it with the repository's validator. A step's result is kept by the
//      engine, so if the run is paused and replayed it gets this same graph back, not whatever the row says by then.
//      A missing row, text that is not a graph, or a graph the validator rejects ends the run here with the reasons and
//      no node having run.
//   2. The repository's interpreter then runs the graph, each node's executor inside its own step named `node:<id>`.
//      Nodes whose inputs are ready start together; a node whose step already finished is not run again after a replay.

/** The name the Workflow is bound under in the Worker, and the class that implements it. The deploy tool sends both. */
export const WORKFLOW_BINDING = "GRAPH_RUNNER";
export const WORKFLOW_CLASS = "GraphRunner";

export const GRAPH_TABLE = "poc_graphs";
/** Added after the project's own migrations. It belongs to the deploy, not to the assembled project. */
export const GRAPH_MIGRATION = {
  name: "9000_poc_graphs.sql",
  sql: `CREATE TABLE ${GRAPH_TABLE} (\n  id TEXT PRIMARY KEY,\n  graph TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\n`,
};

/**
 * The graph table gets a tenant dimension: a row belongs to one workspace, and the key is (workspace_id, id). Rows written
 * before this migration were app-wide definitions, so they move to the reserved workspace APP_WORKSPACE. Applied after
 * 9000 on every database, fresh or upgraded, so both end in the same state. It also adds the scratch table the timed-write
 * route uses, so that route never touches a graph row.
 */
export const APP_WORKSPACE = "__app__";
export const LATENCY_TABLE = "poc_write_latency";
export const GRAPH_WORKSPACE_MIGRATION = {
  name: "9002_poc_graphs_workspace.sql",
  sql: `CREATE TABLE ${GRAPH_TABLE}_next (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  graph TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
INSERT INTO ${GRAPH_TABLE}_next (workspace_id, id, graph, updated_at) SELECT '${APP_WORKSPACE}', id, graph, updated_at FROM ${GRAPH_TABLE};
DROP TABLE ${GRAPH_TABLE};
ALTER TABLE ${GRAPH_TABLE}_next RENAME TO ${GRAPH_TABLE};
CREATE TABLE IF NOT EXISTS ${LATENCY_TABLE} (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
};

/** Every migration the graph table needs, in order. A deploy appends these after the project's own. */
export const GRAPH_MIGRATIONS = [GRAPH_MIGRATION, GRAPH_WORKSPACE_MIGRATION] as const;

/** A workspace a graph row may be stored under: the reserved app workspace, or an id that is not reserved (no double underscore). */
export function isRunWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && (value === APP_WORKSPACE || (ID_PATTERN.test(value) && !value.includes("__")));
}

/**
 * A workspace a run can execute for: a real tenant's id, never the reserved APP_WORKSPACE (which only chooses which graph
 * rows are visible and is nobody's wallet or data).
 */
export function isTenantWorkspaceId(value: unknown): value is string {
  return isRunWorkspaceId(value) && value !== APP_WORKSPACE && isRuntimeTenantWorkspaceId(value);
}

export const TELEMETRY_MIGRATION = {
  name: "9001_px_telemetry.sql",
  sql: PX_TELEMETRY_MIGRATION_SQL,
};

export const LOAD_STEP = "load graph";
export const nodeStepName = (nodeId: string) => `node:${nodeId}`;
/** Letters, digits, underscore and hyphen, so an id is safe in an address and in a SQL parameter alike. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface StepConfig {
  retries?: { limit: number; delay: number | string; backoff?: "constant" | "linear" | "exponential" };
  timeout?: number | string;
}
/** The part of the Workflow engine's step object this code uses. */
export interface StepLike {
  do<T>(name: string, config: StepConfig, callback: () => Promise<T>): Promise<T>;
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
}
export interface RunParams {
  graphId: string;
  /**
   * The run's verified workspace (AD-S19), set only by an authenticated trigger (the signed `/__px/workflow-runs` route).
   * It loads that workspace's graph, or the app-wide one under APP_WORKSPACE, and is every executor's `ctx.workspaceId`.
   * A run without one, or with APP_WORKSPACE, is refused before any node runs: there is no default workspace.
   */
  workspaceId?: string;
  payload?: unknown;
  telemetry?: TelemetryRunOptions;
  runId?: string;
}

/**
 * A node that throws ends its step, not the run: the interpreter records the failure and skips what depends on it.
 * Whether the engine repeats the step, and how long it may run, comes from what the node declares (stepPolicyFor,
 * UC7.2): reads and side-effect-free nodes are retried with backoff, a write only when the node is idempotent (its
 * step carries the same runId:nodeId key on every attempt), and every step has a timeout.
 */
function isNonRetryable(error: unknown): boolean {
  const e = error as { code?: unknown; status?: unknown; retryable?: unknown } | null;
  if (e === null || typeof e !== "object") return false;
  if (e.retryable === false) return true;
  if (e.code === "INTEGRATION_UNSUPPORTED_FEATURE") return true;
  // A 4xx means the request itself is wrong, so repeating it cannot help (408 and 429 are the transient ones).
  return typeof e.status === "number" && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
}

export type GraphProblem = { ok: false; reason: string } | { ok: true; graph: Graph };

/** Turns the stored text into a graph the interpreter can run, or says why it cannot. Never throws. */
export function readStoredGraph(text: unknown, registry: Registry, plan: "free" | "paid" = "free"): GraphProblem {
  if (typeof text !== "string") return { ok: false, reason: "the stored graph is not text" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the stored graph is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "the stored graph is not an object with nodes and edges" };
  const { nodes, edges } = parsed as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return { ok: false, reason: "the stored graph needs a list of nodes and a list of edges" };
  for (const node of nodes) {
    const n = node as { id?: unknown; type?: unknown; data?: unknown };
    if (typeof n?.id !== "string" || typeof n.type !== "string" || typeof n.data !== "object" || n.data === null || Array.isArray(n.data)) return { ok: false, reason: "every node needs a text id, a text type and a data object" };
  }
  for (const edge of edges) {
    const e = edge as { id?: unknown; source?: unknown; target?: unknown };
    if (typeof e?.id !== "string" || typeof e.source !== "string" || typeof e.target !== "string") return { ok: false, reason: "every edge needs a text id, source and target" };
  }
  const graph = parsed as Graph;
  const errors = validateGraph(graph.nodes, graph.edges, registry).issues.filter((i) => i.severity === "error");
  if (errors.length > 0) return { ok: false, reason: `graph is invalid: ${errors.map((i) => `${i.code} at ${i.nodeId || "the graph"} (${i.message})`).join("; ")}` };
  const budgetErrors = checkGraphBudget(graph, registry, plan).filter((i) => i.severity === "error");
  if (budgetErrors.length > 0) return { ok: false, reason: `graph exceeds budget: ${budgetErrors.map((i) => `${i.code} at ${i.nodeId || "the graph"} (${i.message})`).join("; ")}` };
  return { ok: true, graph };
}

export interface StoredGraphRun {
  step: StepLike;
  db: D1Like;
  params: RunParams;
  runId?: string;
  /** The host's secrets and bindings. Executors never see this object; they get only what their manifest declares. */
  env: Readonly<Record<string, unknown>>;
  registry: Registry;
  executors: Executors;
  /** Makes the error that tells the engine not to retry the step it is thrown in. In workerd this is `NonRetryableError`. */
  nonRetryable: (message: string) => Error;
  telemetry?: TelemetryRunOptions;
}

export async function runStoredGraph(run: StoredGraphRun): Promise<RunResult> {
  const { step, db, params, registry } = run;
  const explicitTelemetry = run.telemetry ?? params?.telemetry;
  const runId =
    run.runId ??
    params?.runId ??
    explicitTelemetry?.runId ??
    (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? `run_${crypto.randomUUID()}`
      : `run_${Date.now()}`);
  if (typeof params?.graphId !== "string" || !ID_PATTERN.test(params.graphId)) throw run.nonRetryable("the run was started without a usable graph id");
  // A run executes for one verified tenant workspace. With none, or with the reserved APP_WORKSPACE (nobody's workspace),
  // it is refused before the table is read and before any node runs. There is no default workspace (AD-S19).
  if (params.workspaceId === undefined || params.workspaceId === APP_WORKSPACE) throw run.nonRetryable("NO_WORKSPACE: the run was started without a verified workspace");
  if (!isTenantWorkspaceId(params.workspaceId)) throw run.nonRetryable("the run was started without a usable workspace id");
  const workspaceId = params.workspaceId;

  // Only the run's own workspace and the app-wide graphs are visible; the workspace's own row wins over the app's.
  const graph = await step.do(LOAD_STEP, async () => {
    const row = await db
      .prepare(`SELECT graph FROM ${GRAPH_TABLE} WHERE id = ?1 AND workspace_id IN (?2, '${APP_WORKSPACE}') ORDER BY CASE WHEN workspace_id = ?2 THEN 0 ELSE 1 END LIMIT 1`)
      .bind(params.graphId, workspaceId)
      .first<{ graph: string }>();
    if (row === null) throw run.nonRetryable(`no graph is stored under "${params.graphId}"`);
    const read = readStoredGraph(row.graph, registry);
    if (!read.ok) throw run.nonRetryable(read.reason.slice(0, 900));
    return read.graph;
  });

  const envTelemetrySecret =
    typeof run.env?.PX_TELEMETRY_SECRET === "string"
      ? run.env.PX_TELEMETRY_SECRET
      : undefined;
  const envWebhookUrl =
    typeof run.env?.PX_TELEMETRY_WEBHOOK_URL === "string"
      ? run.env.PX_TELEMETRY_WEBHOOK_URL
      : undefined;
  const envTelemetryEnabled =
    Boolean(run.env?.PX_TELEMETRY_ENABLED) ||
    Boolean(envTelemetrySecret) ||
    Boolean(envWebhookUrl);
  const telemetry: TelemetryRunOptions | undefined =
    explicitTelemetry || envTelemetryEnabled
      ? {
          db,
          workflowId: params.graphId,
          ...(envTelemetrySecret ? { telemetrySecret: envTelemetrySecret } : {}),
          ...(envWebhookUrl ? { webhookUrl: envWebhookUrl } : {}),
          // Story 1.4: the webhook names this deploy's project and is signed with that project's derived secret
          // (set together with the URL by the provisioner, see telemetryWebhookConfig).
          ...(typeof run.env?.PX_PROJECT_ID === "string" && run.env.PX_PROJECT_ID ? { project: run.env.PX_PROJECT_ID } : {}),
          ...(typeof run.env?.PX_TELEMETRY_WEBHOOK_SECRET === "string" ? { webhookSecret: run.env.PX_TELEMETRY_WEBHOOK_SECRET } : {}),
          ...explicitTelemetry,
          // no telemetry option moves the run's workspace
          workspaceId,
        }
      : undefined;

  return runGraph(graph, registry, run.executors, {
    payload: params.payload,
    env: run.env,
    runId,
    // The run's workspace, fixed when it started: executors (ctx.workspaceId), connections, logs, the run record and
    // telemetry use it, and no telemetry option moves it.
    workspaceId,
    runStep: (nodeId, nodeCall) => {
      const node = graph.nodes.find((n) => n.id === nodeId);
      const manifest = node ? registry.get(node.type) : undefined;
      const policy: StepConfig = stepPolicyFor(manifest ?? {}, { idempotent: manifest?.idempotent === true });
      return step.do(nodeStepName(nodeId), policy, async () => {
        try {
          return await nodeCall();
        } catch (error) {
          if (isNonRetryable(error)) throw run.nonRetryable(error instanceof Error ? error.message : String(error));
          throw error;
        }
      });
    },
    ...(telemetry ? { telemetry } : {}),
  });
}
