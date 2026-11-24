import { validateGraph } from "@poc/sdk";
import type {
  BrickManifest,
  ConnectionLookupSelector,
  D1Like,
  ExecutionContext,
  Executors,
  GraphEdge,
  GraphNode,
  Registry,
  ValidationIssue,
} from "@poc/sdk";
import {
  TELEMETRY_SIGNATURE_HEADER,
  collectSecretKeyedValues,
  collectSecretStringsFromValue,
  createStructuredLogger,
  ensureTelemetryTables,
  insertStepEvent,
  insertStructuredLog,
  redactTelemetryString,
  signTelemetryPayload,
  truncateTelemetryPreview,
  upsertRunRecord,
} from "@poc/telemetry";
import type {
  RunRecord,
  StepEvent,
  StepStatus,
  StructuredLogEntry,
  TelemetryWebhookPayload,
} from "@poc/telemetry";
import { resolveCaseAConnection } from "./connections.ts";
import { resolveStepExpressions } from "./expressions.ts";
import {
  collectConnectionSecretValues,
  collectConnectionsMapSecrets,
  getRegisteredTokenUrlsByApp,
} from "./integration-executor.ts";
import { parseDurationMs, stepPolicyFor } from "./step-policy.ts";

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface StepRetryPolicy {
  /** Number of retry attempts after the initial attempt fails (e.g., 2 means up to 3 total attempts). */
  limit: number;
  /** Optional delay in milliseconds between retry attempts. */
  delayMs?: number;
}

export interface TelemetryRunOptions {
  /** D1 database where px_runs and px_step_events are written (defaults to options.env?.DB if present). */
  db?: D1Like;
  /** Run identifier (auto-generated if omitted). */
  runId?: string;
  /** Workflow identifier (defaults to "wf_default"). */
  workflowId?: string;
  /** Blueprint revision number (defaults to 0). */
  revision?: number;
  /** Trigger type (defaults to "manual"). */
  triggerType?: string;
  /** Workspace ID (defaults to "ws_default"). */
  workspaceId?: string;
  /** Project slug used in webhook payloads (optional). */
  project?: string;
  /** Optional parent run ID if this run is a replay/retry. */
  retryOfRunId?: string | null;
  /** Shared HMAC-SHA256 secret (falls back to options.env?.PX_TELEMETRY_SECRET). */
  telemetrySecret?: string;
  /** Target webhook URL (e.g. "http://studio-api/api/projects/my-proj/telemetry/webhook"). */
  webhookUrl?: string;
  /** Custom fetch function for delivering signed webhooks (defaults to globalThis.fetch). */
  webhookFetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Additional secret values to redact (on top of ctx.secret() and ctx.connection() automatic tracking). */
  secretValues?: Iterable<string>;
  /** Additional field names to treat as widget: "secret" (on top of manifest.secretFields). */
  secretFieldNames?: Iterable<string>;
  /** Project-configured additional field keys to redact across step I/O, logs, and errors. */
  additionalRedactKeys?: Iterable<string>;
  /** Target environment name (e.g., "preview" | "production"). */
  envName?: string;
  /** When false in production, omits step inputPreview and outputPreview payloads ("{}") while keeping status, durationMs, retries, and errorStack. */
  captureStepIoInProd?: boolean;
  /** Optional retry policy per node or globally across nodes. Can be true to inherit stepPolicyFor limits. */
  stepRetries?: boolean | StepRetryPolicy | Readonly<Record<string, StepRetryPolicy>>;
}

export interface RunResult {
  /** False when any node threw. Nodes skipped because the trigger never reaches them do not count. */
  ok: boolean;
  /** What each node that ran returned, by node id. */
  outputs: Record<string, Record<string, unknown>>;
  /** Error message for each node that threw or had no executor. */
  failed: Record<string, string>;
  /** Nodes that did not run: not connected to the trigger, or downstream of a failure. */
  skipped: string[];
  /** Populated when telemetry is enabled or explicit runId is provided. */
  runId?: string;
  /** Whether the run has durable workflow backing. */
  durable?: boolean;
  /** Final RunRecord persisted to px_runs when telemetry is enabled. */
  runRecord?: RunRecord;
  /** Ordered StepEvents emitted during the run when telemetry is enabled. */
  stepEvents?: StepEvent[];
  /** Ordered StructuredLogEntries emitted during the run when telemetry is enabled. */
  logs?: StructuredLogEntry[];
}

/**
 * Lets a host decide HOW a node's executor is run, without the interpreter knowing why. The deployed Workflow passes one
 * that runs each node as its own durable `step.do`, so a node whose step already finished is not executed again after a
 * pause. It must return what `run` returns (or throw what `run` throws) and must call `run` at most once. Without it,
 * nodes are simply called.
 */
export type RunStep = (nodeId: string, run: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>;

export class GraphInvalidError extends Error {
  issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(`graph is invalid: ${issues.map((i) => i.code).join(", ")}`);
    this.issues = issues;
  }
}

export interface RunGraphOptions {
  /** Explicit stable runId (e.g. from Workflow instanceId). */
  runId?: string;
  payload?: unknown;
  /** Immutable workspace ID established at workflow run start from the authenticated trigger context (AD-S19). */
  workspaceId?: string;
  env?: Readonly<Record<string, unknown>>;
  connections?: Readonly<Record<string, Record<string, unknown>>>;
  runStep?: RunStep;
  telemetry?: TelemetryRunOptions;
  /** Pinned node outputs keyed by nodeId (`usePinnedOutputs` / "Use pinned data"). */
  pinnedOutputs?: Readonly<Record<string, unknown>>;
  /** Recorded outputs from a prior run keyed by nodeId for partial re-run from a node. */
  seededOutputs?: Readonly<Record<string, unknown>>;
  /** Set of strict upstream ancestor nodeIds whose executors must not run during a partial re-run. */
  reusedNodeIds?: ReadonlySet<string>;
  /** Target nodeId when running a partial re-run (`fromNodeId`). */
  fromNodeId?: string;
  /** Optional custom fetcher for network operations. */
  fetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Optional custom fetcher for OAuth token refresh operations. */
  oauthFetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export function computeStrictUpstreamAncestors(
  graph: Graph,
  fromNodeId: string,
): Set<string> {
  const byId = new Set(graph.nodes.map((n) => n.id));
  const incomingByTarget = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    const list = incomingByTarget.get(edge.target) ?? [];
    list.push(edge.source);
    incomingByTarget.set(edge.target, list);
  }

  const ancestors = new Set<string>();
  const queue: string[] = [...(incomingByTarget.get(fromNodeId) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === fromNodeId || ancestors.has(current)) continue;
    ancestors.add(current);
    for (const parent of incomingByTarget.get(current) ?? []) {
      if (!ancestors.has(parent)) {
        queue.push(parent);
      }
    }
  }
  return ancestors;
}

export function computeDownstreamSubgraph(
  graph: Graph,
  fromNodeId: string,
): Set<string> {
  const byId = new Set(graph.nodes.map((n) => n.id));
  const outgoingBySource = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    const list = outgoingBySource.get(edge.source) ?? [];
    list.push(edge.target);
    outgoingBySource.set(edge.source, list);
  }

  const downstream = new Set<string>();
  if (!byId.has(fromNodeId)) return downstream;
  const queue: string[] = [fromNodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (downstream.has(current)) continue;
    downstream.add(current);
    for (const child of outgoingBySource.get(current) ?? []) {
      if (!downstream.has(child)) {
        queue.push(child);
      }
    }
  }
  return downstream;
}

export function normalizeNodePortOutput(
  rawOutput: unknown,
): Record<string, unknown> {
  if (
    typeof rawOutput === "object" &&
    rawOutput !== null &&
    !Array.isArray(rawOutput)
  ) {
    const rec = rawOutput as Record<string, unknown>;
    if (Object.hasOwn(rec, "out")) {
      return structuredClone(rec);
    }
    return {
      out: structuredClone(rec),
      ...structuredClone(rec),
    };
  }
  return {
    out: structuredClone(rawOutput),
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isD1Like(candidate: unknown): candidate is D1Like {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as D1Like).prepare === "function" &&
    typeof (candidate as D1Like).batch === "function"
  );
}

function resolveNodeRetryPolicy(
  nodeId: string,
  stepRetries: TelemetryRunOptions["stepRetries"],
  manifest?: Pick<BrickManifest, "sideEffects" | "retry" | "idempotent"> | null,
): StepRetryPolicy {
  const canonical = stepPolicyFor(manifest ?? {}, { idempotent: manifest?.idempotent === true });
  if (canonical.retries.limit === 0) {
    return { limit: 0, delayMs: 0 };
  }
  if (!stepRetries) {
    return { limit: 0, delayMs: 0 };
  }
  if (stepRetries === true) {
    return {
      limit: canonical.retries.limit,
      delayMs: parseDurationMs(canonical.retries.delay),
    };
  }
  let configured: StepRetryPolicy | undefined;
  if (typeof (stepRetries as StepRetryPolicy).limit === "number") {
    configured = stepRetries as StepRetryPolicy;
  } else {
    const map = stepRetries as Readonly<Record<string, StepRetryPolicy>>;
    configured = map[nodeId];
  }
  if (!configured) {
    return { limit: 0, delayMs: 0 };
  }
  const limit = Math.min(Math.max(0, configured.limit), canonical.retries.limit);
  const delayMs =
    typeof configured.delayMs === "number"
      ? configured.delayMs
      : parseDurationMs(canonical.retries.delay);
  return { limit, delayMs };
}

function checkMissingStepInputFields(
  nodeId: string,
  nodeData: Readonly<Record<string, unknown>>,
  stepOutputs: Readonly<Record<string, Record<string, unknown>>>,
): void {
  const pillRe = /\{\{\s*steps\.([a-zA-Z0-9_-]+)\.output\.([a-zA-Z0-9_.-]+)\s*\}\}/g;
  for (const [dataKey, rawVal] of Object.entries(nodeData ?? {})) {
    if (typeof rawVal !== "string") continue;
    pillRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pillRe.exec(rawVal)) !== null) {
      const srcNode = m[1]!;
      const fieldPath = m[2]!;
      const rootField = fieldPath.split(".")[0]!;
      if (rootField === "__proto__" || rootField === "constructor" || rootField === "prototype") {
        continue;
      }
      const rawStepOut = stepOutputs[srcNode];
      if (!rawStepOut) continue;
      const outObj =
        typeof rawStepOut.out === "object" && rawStepOut.out !== null && !Array.isArray(rawStepOut.out)
          ? (rawStepOut.out as Record<string, unknown>)
          : rawStepOut;
      const availableKeys = Object.keys(outObj).filter((k) => k !== "fromPinned");
      if (availableKeys.length > 0 && !(rootField in outObj)) {
        throw new Error(
          `RUN_STEP_MISSING_INPUT: Step "${nodeId}" field "${dataKey}" mapped to "{{steps.${srcNode}.output.${fieldPath}}}", but field "${fieldPath}" does not exist on upstream node "${srcNode}" output (available fields: ${availableKeys.join(", ")})`,
        );
      }
    }
  }
}

/**
 * Runs a graph by calling the registered executor for each node. There is no code generation: a node
 * waits for the promises of the nodes feeding it and then calls its executor, so branches that do not
 * depend on each other start in the same tick and overlap.
 */
export async function runGraph(
  graph: Graph,
  registry: Registry,
  executors: Executors,
  /** `env` is the host's secrets and bindings. Executors never receive it; they get `ctx.secret()` for declared names only. */
  options: RunGraphOptions = {},
): Promise<RunResult> {
  const { issues, order } = validateGraph(graph.nodes, graph.edges, registry);
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length > 0) throw new GraphInvalidError(errors);

  const unreachable = new Set(issues.filter((i) => i.code === "orphan_node").map((i) => i.nodeId));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const result: RunResult = { ok: true, outputs: {}, failed: {}, skipped: [] };
  // Each promise settles to true when its node produced outputs; it never rejects.
  const done = new Map<string, Promise<boolean>>();

  const telemetryCfg = options.telemetry;
  const telemetryDb =
    telemetryCfg?.db ??
    (telemetryCfg && isD1Like(options.env?.DB) ? (options.env.DB as D1Like) : undefined);
  const telemetryActive = Boolean(telemetryCfg || telemetryDb);

  const trackedSecrets = new Set<string>();
  const secretFieldNames = new Set<string>();

  if (telemetryActive) {
    if (telemetryCfg?.secretValues) {
      for (const s of telemetryCfg.secretValues) {
        if (typeof s === "string" && s.trim().length >= 3) {
          trackedSecrets.add(s);
        }
      }
    }
    if (telemetryCfg?.secretFieldNames) {
      for (const f of telemetryCfg.secretFieldNames) {
        if (typeof f === "string" && f.length > 0) {
          secretFieldNames.add(f);
        }
      }
    }
    if (telemetryCfg?.additionalRedactKeys) {
      for (const f of telemetryCfg.additionalRedactKeys) {
        if (typeof f === "string" && f.trim().length > 0) {
          secretFieldNames.add(f.trim());
        }
      }
    }
    if (typeof options.env?.PX_ADDITIONAL_REDACT_KEYS === "string") {
      const rawKeys = options.env.PX_ADDITIONAL_REDACT_KEYS.trim();
      if (rawKeys.startsWith("[")) {
        try {
          const parsed = JSON.parse(rawKeys);
          if (Array.isArray(parsed)) {
            for (const f of parsed) {
              if (typeof f === "string" && f.trim().length > 0) {
                secretFieldNames.add(f.trim());
              }
            }
          }
        } catch {
          // ignore
        }
      } else if (rawKeys.length > 0) {
        for (const f of rawKeys.split(",")) {
          if (f.trim().length > 0) {
            secretFieldNames.add(f.trim());
          }
        }
      }
    }
    if (options.connections) {
      collectConnectionsMapSecrets(options.connections, trackedSecrets);
    }
    for (const node of graph.nodes) {
      const manifest = registry.get(node.type);
      if (!manifest) continue;
      for (const secretName of manifest.secrets ?? []) {
        const val = options.env?.[secretName];
        if (typeof val === "string" && val.trim().length >= 3) {
          trackedSecrets.add(val);
        }
      }
      for (const fieldName of manifest.secretFields ?? []) {
        secretFieldNames.add(fieldName);
        const dataVal = node.data?.[fieldName];
        if (typeof dataVal === "string" && dataVal.trim().length >= 3) {
          trackedSecrets.add(dataVal);
        }
      }
      if (node.data) {
        collectSecretKeyedValues(node.data, trackedSecrets, secretFieldNames);
      }
    }
    if (options.payload !== undefined) {
      collectSecretKeyedValues(options.payload, trackedSecrets, secretFieldNames);
    }
    if (options.pinnedOutputs) {
      collectSecretKeyedValues(options.pinnedOutputs, trackedSecrets, secretFieldNames);
    }
    if (options.seededOutputs) {
      collectSecretKeyedValues(options.seededOutputs, trackedSecrets, secretFieldNames);
    }
  }

  const isDurable = Boolean(options.runId ?? telemetryCfg?.runId);
  // Non-durable local runs: if runId is not provided by options or telemetry,
  // generate a stable collision-resistant identifier for log and trace correlation.
  const runId =
    options.runId ??
    telemetryCfg?.runId ??
    (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? `run_${crypto.randomUUID()}`
      : `run_${Date.now()}`);
  const workflowId = telemetryCfg?.workflowId ?? "wf_default";
  const revision = telemetryCfg?.revision ?? 0;
  const triggerType = telemetryCfg?.triggerType ?? "manual";
  const explicitRunWorkspaceId = options.workspaceId ?? telemetryCfg?.workspaceId;
  const workspaceId = explicitRunWorkspaceId ?? "ws_default";
  const telemetrySecret =
    telemetryCfg?.telemetrySecret ??
    (typeof options.env?.PX_TELEMETRY_SECRET === "string"
      ? options.env.PX_TELEMETRY_SECRET
      : undefined);
  const webhookUrl = telemetryCfg?.webhookUrl;
  const webhookFetcher = telemetryCfg?.webhookFetcher ?? globalThis.fetch;

  const runStartedAt = new Date().toISOString();
  const runStartMs = Date.now();
  let totalRunRetries = 0;
  let firstRedactedErrorStack: string | null = null;
  let eventCounter = 0;
  const stepEvents: StepEvent[] = [];
  const emittedLogs: StructuredLogEntry[] = [];

  if (telemetryDb) {
    await ensureTelemetryTables(telemetryDb);
  }

  const currentRunRecord = (): RunRecord => ({
    runId,
    workflowId,
    revision,
    triggerType,
    workspaceId,
    status: "running",
    durationMs: Math.max(0, Date.now() - runStartMs),
    retries: totalRunRetries,
    retryOfRunId: telemetryCfg?.retryOfRunId ?? null,
    errorStack: firstRedactedErrorStack,
    startedAt: runStartedAt,
    endedAt: null,
    durable: isDurable,
  });

  const deliverWebhook = async (payload: TelemetryWebhookPayload): Promise<void> => {
    if (!webhookUrl || typeof webhookFetcher !== "function") return;
    const bodyText = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (telemetrySecret) {
      headers[TELEMETRY_SIGNATURE_HEADER] = await signTelemetryPayload(
        bodyText,
        telemetrySecret,
      );
    }
    try {
      await webhookFetcher(webhookUrl, {
        method: "POST",
        headers,
        body: bodyText,
      });
    } catch {
      // Telemetry push failures do not abort workflow execution; reconciliation endpoint backfills missed events.
    }
  };

  const emitStepTelemetry = async (params: {
    nodeId: string;
    status: StepStatus;
    durationMs: number;
    retries: number;
    inputValue: unknown;
    outputValue: unknown;
    errorStack?: string | null;
    fromPinned?: boolean;
    reused?: boolean;
  }): Promise<void> => {
    if (!telemetryActive || !runId) return;
    eventCounter += 1;
    const redactOpts = {
      secretValues: trackedSecrets,
      secretFieldNames,
    };
    const effectiveEnvName =
      telemetryCfg?.envName ??
      (typeof options.env?.PX_ENV === "string" ? options.env.PX_ENV : "preview");
    const captureStepIoInProd =
      telemetryCfg?.captureStepIoInProd !== undefined
        ? telemetryCfg.captureStepIoInProd
        : options.env?.PX_CAPTURE_STEP_IO_IN_PROD === false ||
            options.env?.PX_CAPTURE_STEP_IO_IN_PROD === "false"
          ? false
          : true;
    const suppressProdIo = effectiveEnvName === "production" && !captureStepIoInProd;
    const inputPreview = suppressProdIo
      ? "{}"
      : truncateTelemetryPreview(params.inputValue, redactOpts);
    const outputPreview = suppressProdIo
      ? "{}"
      : truncateTelemetryPreview(params.outputValue, redactOpts);
    const redactedErrorStack = params.errorStack
      ? redactTelemetryString(params.errorStack, redactOpts)
      : null;

    let stepEvent: StepEvent = {
      eventId: `${runId}:${params.nodeId}:${params.status}:${eventCounter}`,
      runId,
      workflowId,
      revision,
      nodeId: params.nodeId,
      status: params.status,
      durationMs: Math.round(params.durationMs * 100) / 100,
      retries: params.retries,
      inputPreview,
      outputPreview,
      errorStack: redactedErrorStack,
      createdAt: new Date().toISOString(),
      ...(params.fromPinned ? { fromPinned: true } : {}),
      ...(params.reused ? { reused: true } : {}),
    };

    if (telemetryDb) {
      stepEvent = await insertStepEvent(telemetryDb, stepEvent, {
        envName: effectiveEnvName,
        captureStepIoInProd,
      });
    }
    stepEvents.push(stepEvent);

    await deliverWebhook({
      ...(telemetryCfg?.project ? { project: telemetryCfg.project } : {}),
      run: currentRunRecord(),
      events: [stepEvent],
    });
  };

  const downstreamSubgraph = options.fromNodeId
    ? computeDownstreamSubgraph(graph, options.fromNodeId)
    : null;

  if (telemetryActive && runId) {
    if (telemetryDb) {
      await upsertRunRecord(telemetryDb, currentRunRecord());
    }
    for (const id of order) {
      if (options.reusedNodeIds?.has(id)) continue;
      if (downstreamSubgraph && !downstreamSubgraph.has(id)) continue;
      const node = byId.get(id)!;
      await emitStepTelemetry({
        nodeId: id,
        status: "queued",
        durationMs: 0,
        retries: 0,
        inputValue: { data: node.data },
        outputValue: {},
        errorStack: null,
      });
    }
  }

  for (const id of order) {
    const node = byId.get(id)!;
    const incoming = graph.edges.filter((e) => e.target === id && byId.has(e.source));
    done.set(
      id,
      (async () => {
        const upstream = await Promise.all(incoming.map((e) => done.get(e.source)!));

        if (
          options.reusedNodeIds?.has(id) ||
          (options.seededOutputs &&
            Object.hasOwn(options.seededOutputs, id) &&
            downstreamSubgraph &&
            !downstreamSubgraph.has(id))
        ) {
          const seededVal = options.seededOutputs?.[id] ?? {};
          result.outputs[id] = normalizeNodePortOutput(seededVal);
          await emitStepTelemetry({
            nodeId: id,
            status: "succeeded",
            durationMs: 0,
            retries: 0,
            inputValue: {
              reused: true,
              ...(telemetryCfg?.retryOfRunId
                ? { sourceRunId: telemetryCfg.retryOfRunId }
                : {}),
            },
            outputValue: result.outputs[id],
            errorStack: null,
            reused: true,
          });
          return true;
        }

        if (downstreamSubgraph && !downstreamSubgraph.has(id)) {
          result.skipped.push(id);
          await emitStepTelemetry({
            nodeId: id,
            status: "skipped",
            durationMs: 0,
            retries: 0,
            inputValue: {},
            outputValue: {},
            errorStack: null,
          });
          return false;
        }

        const isEdgeTaken = (e: GraphEdge): boolean => {
          const srcOut = result.outputs[e.source];
          if (!srcOut) return false;
          const handle = e.sourceHandle ?? "out";
          if (handle !== "out") {
            const outObj = srcOut.out as Record<string, unknown> | undefined;
            if (outObj && typeof outObj.branch === "string") {
              return outObj.branch === handle;
            }
            if (handle in srcOut && srcOut[handle] === null) {
              return false;
            }
          }
          return true;
        };
        if (
          unreachable.has(id) ||
          !incoming.every((e, idx) => upstream[idx] && isEdgeTaken(e))
        ) {
          result.skipped.push(id);
          await emitStepTelemetry({
            nodeId: id,
            status: "skipped",
            durationMs: 0,
            retries: 0,
            inputValue: {},
            outputValue: {},
            errorStack: null,
          });
          return false;
        }

        if (options.pinnedOutputs && Object.hasOwn(options.pinnedOutputs, id)) {
          const rawPinned = options.pinnedOutputs[id];
          const normalizedPinned = normalizeNodePortOutput(rawPinned);
          result.outputs[id] = {
            ...normalizedPinned,
            fromPinned: true,
          };
          await emitStepTelemetry({
            nodeId: id,
            status: "succeeded",
            durationMs: 0,
            retries: 0,
            inputValue: { fromPinned: true, data: node.data },
            outputValue: result.outputs[id],
            errorStack: null,
            fromPinned: true,
          });
          return true;
        }

        const nodeStartMs = Date.now();
        let retriesUsed = 0;
        let inputs: Record<string, unknown> = {};
        let resolvedData: Readonly<Record<string, unknown>> = node.data;
        try {
          const nodeManifest = registry.get(node.type);
          const isIsolated = nodeManifest?.isolation === "dispatch";
          const executor =
            executors.get(node.type) ??
            (nodeManifest?.executor ? executors.get(nodeManifest.executor) : undefined);
          if (!isIsolated && !executor) throw new Error(`no executor registered for ${node.type}`);
          const declared = nodeManifest?.secrets ?? [];
          const secret = (name: string): string => {
            if (!declared.includes(name)) throw new Error(`secret "${name}" is not declared by ${node.type}`);
            const value = options.env?.[name];
            if (typeof value !== "string") throw new Error(`secret "${name}" is declared by ${node.type} but was not provided`);
            if (value.trim().length >= 3) {
              trackedSecrets.add(value);
            }
            return value;
          };
          const declaredBindings = registry.get(node.type)?.bindings ?? [];
          const binding = <T = unknown>(name: string): T => {
            if (!declaredBindings.includes(name)) throw new Error(`binding "${name}" is not declared by ${node.type}`);
            const value = options.env?.[name];
            if (value === undefined || value === null) throw new Error(`binding "${name}" is declared by ${node.type} but was not provided`);
            return value as T;
          };
          const connectionDb =
            (isD1Like(options.env?.DB) ? (options.env.DB as D1Like) : undefined) ??
            telemetryDb;
          const connKey =
            typeof options.env?.PX_CONN_KEY === "string"
              ? options.env.PX_CONN_KEY
              : typeof options.env?.PX_VAULT_KEY === "string"
                ? options.env.PX_VAULT_KEY
                : typeof options.env?.BETTER_AUTH_SECRET === "string"
                  ? options.env.BETTER_AUTH_SECRET
                  : undefined;
          const oauthFetcher =
            typeof options.oauthFetcher === "function"
              ? options.oauthFetcher
              : typeof options.fetcher === "function"
                ? options.fetcher
                : typeof options.env?.__OAUTH_FETCHER === "function"
                  ? (options.env.__OAUTH_FETCHER as (
                      input: string | URL | Request,
                      init?: RequestInit,
                    ) => Promise<Response>)
                  : undefined;

          const connection = <T = Record<string, unknown>>(
            nameOrSelector: string | ConnectionLookupSelector,
          ): T | Promise<T> => {
            if (typeof nameOrSelector === "string") {
              const fromConnections = options.connections?.[nameOrSelector];
              const fromEnv = options.env?.[nameOrSelector];
              const candidate = fromConnections ?? fromEnv;
              if (candidate !== undefined && candidate !== null && typeof candidate === "object") {
                collectSecretStringsFromValue(candidate, trackedSecrets);
                return candidate as T;
              }
            } else if (options.connections) {
              const wsId =
                explicitRunWorkspaceId !== undefined || connectionDb !== undefined
                  ? workspaceId
                  : (nameOrSelector.workspaceId ?? workspaceId);
              const keysToTry = [
                ...(nameOrSelector.scope === "workspace" && nameOrSelector.app
                  ? [`workspace:${wsId}:${nameOrSelector.app}`, `workspace:${nameOrSelector.app}`]
                  : []),
                ...(nameOrSelector.ref ? [nameOrSelector.ref, `project:${nameOrSelector.ref}`] : []),
                ...(nameOrSelector.app ? [nameOrSelector.app] : []),
              ];
              for (const k of keysToTry) {
                const candidate = options.connections[k];
                if (candidate !== undefined && candidate !== null && typeof candidate === "object") {
                  collectSecretStringsFromValue(candidate, trackedSecrets);
                  return candidate as T;
                }
              }
            }

            if (connectionDb) {
              const inferredApp = node.type.startsWith("int:")
                ? node.type.slice("int:".length).split(".")[0]
                : undefined;
              return resolveCaseAConnection(nameOrSelector, {
                db: connectionDb,
                connKey,
                projectId:
                  telemetryCfg?.project ??
                  (typeof options.env?.PX_PROJECT_ID === "string"
                    ? options.env.PX_PROJECT_ID
                    : "default"),
                envName: typeof options.env?.PX_ENV === "string" ? options.env.PX_ENV : "preview",
                workspaceId,
                defaultApp: inferredApp,
                tokenUrlByApp: getRegisteredTokenUrlsByApp(),
                oauthFetcher,
                trackedSecrets,
                runId: runId ?? null,
                workflowId,
                revision,
                nodeId: id,
                onConnectionExpired: async (ev) => {
                  await nodeLogger.warn(
                    `connection.expired: Connection "${ev.ref}" (${ev.app}) expired: ${ev.reason}`,
                    {
                      event: "connection.expired",
                      ref: ev.ref,
                      app: ev.app,
                      status: "expired",
                      reason: ev.reason,
                    },
                  );
                },
              }) as unknown as T;
            }

            const label =
              typeof nameOrSelector === "string"
                ? nameOrSelector
                : (nameOrSelector.ref ?? nameOrSelector.app ?? "unknown");
            throw new Error(`connection "${label}" was not provided`);
          };
          inputs = gatherInputs(incoming, result.outputs);
          checkMissingStepInputFields(id, node.data, result.outputs);
          resolvedData = resolveStepExpressions(
            node.data,
            result.outputs,
            options.payload,
          ) as Readonly<Record<string, unknown>>;

          await emitStepTelemetry({
            nodeId: id,
            status: "running",
            durationMs: 0,
            retries: 0,
            inputValue: { inputs, data: resolvedData },
            outputValue: {},
            errorStack: null,
          });

          const retryPolicy = resolveNodeRetryPolicy(id, telemetryCfg?.stepRetries, nodeManifest);
          // Durable retries belong to the engine (UC7.2): inside a Workflow a second step.do of the same name is a
          // cached or duplicate step, not a retry. The in-process loop is for local, non-durable runs only.
          const maxRetries = options.runStep ? 0 : retryPolicy.limit;
          const inferredBrickId =
            typeof resolvedData.brickId === "string" && resolvedData.brickId.trim()
              ? resolvedData.brickId.trim()
              : node.type.includes(".")
                ? node.type.split(".")[0]!
                : node.type;
          const inferredWorkspaceId =
            typeof (inputs.in as Record<string, unknown> | undefined)?.workspaceId === "string"
              ? ((inputs.in as Record<string, unknown>).workspaceId as string)
              : typeof (options.payload as Record<string, unknown> | undefined)?.workspaceId === "string"
                ? ((options.payload as Record<string, unknown>).workspaceId as string)
                : workspaceId;

          const nodeLogger = createStructuredLogger({
            db: telemetryDb,
            context: {
              runId: runId ?? null,
              workflowId,
              revision,
              nodeId: id,
              brickId: inferredBrickId,
              workspaceId: inferredWorkspaceId,
            },
            redactOptions: {
              secretValues: trackedSecrets,
              secretFieldNames,
            },
            onLog: async (entry) => {
              emittedLogs.push(entry);
              if (telemetryActive && runId) {
                await deliverWebhook({
                  ...(telemetryCfg?.project ? { project: telemetryCfg.project } : {}),
                  run: currentRunRecord(),
                  events: [],
                  logs: [entry],
                });
              }
            },
          });

          let nodeOutput: Record<string, unknown> | undefined;
          for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
            if (attempt > 0) {
              retriesUsed += 1;
              totalRunRetries += 1;
              if (retryPolicy.delayMs && retryPolicy.delayMs > 0) {
                await sleep(retryPolicy.delayMs);
              }
            }
            try {
              const iteration =
                typeof (resolvedData as Record<string, unknown>)?.iteration === "number" ||
                typeof (resolvedData as Record<string, unknown>)?.iteration === "string"
                  ? (resolvedData as Record<string, unknown>).iteration
                  : typeof (inputs as Record<string, unknown>)?.iteration === "number" ||
                      typeof (inputs as Record<string, unknown>)?.iteration === "string"
                    ? (inputs as Record<string, unknown>).iteration
                    : undefined;
              const idempotencyKey =
                iteration !== undefined
                  ? `${runId}:${id}:${iteration}`
                  : `${runId}:${id}`;

              let call: () => Promise<Record<string, unknown>>;
              if (isIsolated) {
                const brickPart = nodeManifest?.brickId ?? node.type.split(".")[0] ?? "brick";
                const bindingSuffix = brickPart.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
                const bindingName = `BRICK_${bindingSuffix}`;
                const service = (options.env?.[bindingName] ?? (nodeManifest?.brickId ? options.env?.[`BRICK_${nodeManifest.brickId}`] : undefined)) as {
                  execute?: (type: string, snapshot: unknown) => Promise<Record<string, unknown>>;
                };
                if (!service || typeof service.execute !== "function") {
                  throw new Error(`service binding "${bindingName}" for isolated node ${node.type} is not available`);
                }
                const optAny = options as Record<string, unknown> | undefined;
                const ctxSnapshot = {
                  nodeId: id,
                  runId,
                  idempotencyKey: (optAny?.idempotencyKey as string | undefined) ?? idempotencyKey,
                  data: resolvedData,
                  inputs,
                  payload: options.payload,
                };
                call = async () => service.execute!(node.type, ctxSnapshot);
              } else {
                const execCtx: ExecutionContext = {
                  nodeId: id,
                  runId,
                  idempotencyKey,
                  data: resolvedData,
                  inputs,
                  payload: options.payload,
                  secret,
                  binding,
                };
                Object.defineProperty(execCtx, "connection", {
                  value: connection,
                  enumerable: false,
                });
                Object.defineProperty(execCtx, "log", {
                  value: nodeLogger,
                  enumerable: false,
                });
                Object.defineProperty(execCtx, "nodeType", {
                  value: node.type,
                  enumerable: false,
                });
                call = async () => executor!(execCtx);
              }
              nodeOutput = options.runStep ? await options.runStep(id, call) : await call();
              await nodeLogger.flush();
              break;
            } catch (stepErr) {
              await nodeLogger.flush();
              if (attempt >= maxRetries) {
                throw stepErr;
              }
            }
          }

          result.outputs[id] = nodeOutput ?? {};
          const durationMs = Math.max(0, Date.now() - nodeStartMs);
          await emitStepTelemetry({
            nodeId: id,
            status: "succeeded",
            durationMs,
            retries: retriesUsed,
            inputValue: { inputs, data: resolvedData },
            outputValue: result.outputs[id],
            errorStack: null,
          });
          return true;
        } catch (error) {
          const rawMessage = error instanceof Error ? error.message : String(error);
          const rawStack =
            error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
          const redactedMessage = redactTelemetryString(rawMessage, {
            secretValues: trackedSecrets,
            secretFieldNames,
          });
          result.failed[id] = redactedMessage;
          const durationMs = Math.max(0, Date.now() - nodeStartMs);
          const redactedStack = redactTelemetryString(rawStack, {
            secretValues: trackedSecrets,
            secretFieldNames,
          });
          if (!firstRedactedErrorStack) {
            firstRedactedErrorStack = redactedStack;
          }
          if (telemetryActive && runId) {
            const alreadyLoggedErrorForNode = emittedLogs.some(
              (entry) => entry.nodeId === id && entry.level === "error",
            );
            if (!alreadyLoggedErrorForNode) {
              const inferredBrickId =
                typeof resolvedData.brickId === "string" && resolvedData.brickId.trim()
                  ? resolvedData.brickId.trim()
                  : node.type.includes(".")
                    ? node.type.split(".")[0]!
                    : node.type;
              const inferredWorkspaceId =
                typeof (inputs.in as Record<string, unknown> | undefined)?.workspaceId === "string"
                  ? ((inputs.in as Record<string, unknown>).workspaceId as string)
                  : typeof (options.payload as Record<string, unknown> | undefined)?.workspaceId === "string"
                    ? ((options.payload as Record<string, unknown>).workspaceId as string)
                    : workspaceId;
              const autoErrEntry = telemetryDb
                ? await insertStructuredLog(
                    telemetryDb,
                    {
                      level: "error",
                      message: rawMessage,
                      runId,
                      workflowId,
                      revision,
                      nodeId: id,
                      brickId: inferredBrickId,
                      workspaceId: inferredWorkspaceId,
                      fields: {
                        nodeType: node.type,
                        durationMs,
                        retries: retriesUsed,
                      },
                      errorStack: redactedStack,
                    },
                    {
                      secretValues: trackedSecrets,
                      secretFieldNames,
                    },
                  )
                : undefined;
              if (autoErrEntry) {
                emittedLogs.push(autoErrEntry);
                await deliverWebhook({
                  ...(telemetryCfg?.project ? { project: telemetryCfg.project } : {}),
                  run: currentRunRecord(),
                  events: [],
                  logs: [autoErrEntry],
                });
              }
            }
          }
          await emitStepTelemetry({
            nodeId: id,
            status: "failed",
            durationMs,
            retries: retriesUsed,
            inputValue: { inputs, data: resolvedData },
            outputValue: {},
            errorStack: redactedStack,
          });
          return false;
        }
      })(),
    );
  }
  await Promise.all(done.values());
  result.ok = Object.keys(result.failed).length === 0;

  if (telemetryActive && runId) {
    const finalRun: RunRecord = {
      runId,
      workflowId,
      revision,
      triggerType,
      workspaceId,
      status: result.ok ? "succeeded" : "failed",
      durationMs: Math.max(0, Date.now() - runStartMs),
      retries: totalRunRetries,
      retryOfRunId: telemetryCfg?.retryOfRunId ?? null,
      errorStack: firstRedactedErrorStack,
      startedAt: runStartedAt,
      endedAt: new Date().toISOString(),
      durable: isDurable,
    };
    if (telemetryDb) {
      await upsertRunRecord(telemetryDb, finalRun);
    }
    await deliverWebhook({
      ...(telemetryCfg?.project ? { project: telemetryCfg.project } : {}),
      run: finalRun,
      events: [],
    });
    result.runId = runId;
    result.durable = isDurable;
    result.runRecord = finalRun;
    result.stepEvents = stepEvents;
    result.logs = emittedLogs;
  }

  return result;
}

export class RuntimeGraphWorkflow {
  private readonly registry: Registry;
  private readonly executors: Executors;

  constructor(registry: Registry, executors: Executors) {
    this.registry = registry;
    this.executors = executors;
  }

  async start(options: {
    graph: Graph;
    payload?: unknown;
    env?: Readonly<Record<string, unknown>>;
    connections?: Readonly<Record<string, Record<string, unknown>>>;
    runStep?: RunStep;
    telemetry?: TelemetryRunOptions;
    pinnedOutputs?: Readonly<Record<string, unknown>>;
    seededOutputs?: Readonly<Record<string, unknown>>;
    reusedNodeIds?: ReadonlySet<string>;
    fromNodeId?: string;
  }): Promise<RunResult> {
    return runGraph(options.graph, this.registry, this.executors, {
      payload: options.payload,
      env: options.env,
      connections: options.connections,
      runStep: options.runStep,
      telemetry: options.telemetry,
      ...(options.pinnedOutputs ? { pinnedOutputs: options.pinnedOutputs } : {}),
      ...(options.seededOutputs ? { seededOutputs: options.seededOutputs } : {}),
      ...(options.reusedNodeIds ? { reusedNodeIds: options.reusedNodeIds } : {}),
      ...(options.fromNodeId ? { fromNodeId: options.fromNodeId } : {}),
    });
  }
}

// One value per input port; several edges into one port become an array in edge order.
function gatherInputs(incoming: GraphEdge[], outputs: RunResult["outputs"]): Record<string, unknown> {
  const byPort: Record<string, unknown[]> = {};
  for (const edge of incoming) {
    const value = outputs[edge.source]?.[edge.sourceHandle ?? "out"];
    (byPort[edge.targetHandle ?? "in"] ??= []).push(value);
  }
  return Object.fromEntries(Object.entries(byPort).map(([port, values]) => [port, values.length === 1 ? values[0] : values]));
}
