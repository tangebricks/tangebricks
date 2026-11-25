import { z } from "zod";
import type {
  ConnectionLookupSelector,
  D1Like,
  ExecutionContext,
  Executors,
  Registry,
} from "@poc/sdk";
import {
  StepEventSchema,
  collectSecretKeyedValues,
  collectSecretStringsFromValue,
  ensureTelemetryTables,
  insertStepEvent,
  isTelemetryPreviewTruncated,
  listStepEventsForRun,
  redactTelemetryPayload,
  redactTelemetryString,
  truncateTelemetryPreview,
  admitExecutingControlRequest,
  upsertRunRecord,
} from "@poc/telemetry";
import type { RunRecord, StepEvent } from "@poc/telemetry";
import { resolveCaseAConnection } from "./connections.ts";
import { resolveStepExpressions } from "./expressions.ts";
import {
  collectConnectionSecretValues,
  collectConnectionsMapSecrets,
  getRegisteredTokenUrlsByApp,
} from "./integration-executor.ts";
import {
  RunRefusedError,
  RuntimeGraphWorkflow,
  computeStrictUpstreamAncestors,
  isTenantWorkspaceId,
} from "./run.ts";
import type { TelemetryRunOptions } from "./run.ts";

export const StepRehearsalRequestSchema = z.object({
  /** Story 1.17: the one-time id of the signed request (a UUID); checked and recorded before anything runs. */
  requestId: z.string().optional(),
  workflowId: z.string().min(1).default("wf_default"),
  revision: z.number().int().min(0).default(0),
  nodeId: z.string().min(1),
  nodeType: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
  input: z.unknown().default({}),
  /** The workspace the signer verified for this request. Required: there is no default workspace. */
  workspaceId: z.string().min(1).max(200),
  upstreamSteps: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional(),
});
export type StepRehearsalInput = z.input<typeof StepRehearsalRequestSchema>;
export type StepRehearsalRequest = z.infer<typeof StepRehearsalRequestSchema>;

export interface StructuredRehearsalError {
  message: string;
  whatHappened: string;
  why: string;
  whatToDo: string;
  field?: string | null;
  stack?: string | null;
}

export interface StepRehearsalResult {
  ok: boolean;
  runId: string;
  workflowId: string;
  revision: number;
  nodeId: string;
  nodeType: string;
  status: "succeeded" | "failed";
  durationMs: number;
  inputPreview: string;
  outputPreview: string;
  output: Record<string, unknown>;
  error?: StructuredRehearsalError;
}

export interface RehearseStepOptions {
  registry: Registry;
  executors: Executors;
  db?: D1Like;
  env?: Readonly<Record<string, unknown>>;
  connections?: Readonly<Record<string, Record<string, unknown>>>;
  pxEnv?: string;
  runId?: string;
  secretValues?: Iterable<string>;
  secretFieldNames?: Iterable<string>;
  /** Optional custom fetcher for network operations. */
  fetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Optional custom fetcher for OAuth token refresh operations. */
  oauthFetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /**
   * Studio only (story 1.4): the authorised project the run's telemetry rows are stamped with, since Studio's one
   * STUDIO_DB holds every project's telemetry. A deployed Worker never sets it. Never read from the request body.
   */
  telemetryProjectId?: string;
  /** Wall clock in epoch milliseconds, for checking signed timestamps on the executing routes (default Date.now). */
  clock?: () => number;
}

/** The project a rehearsal's connection lookups are confined to, when known (story 1.17). */
function projectIdForConnections(options: RehearseStepOptions): string | undefined {
  const bound = options.env?.PX_PROJECT_ID;
  if (typeof bound === "string" && bound.trim()) return bound.trim();
  return options.telemetryProjectId?.trim() || undefined;
}

/** Where an executing route records its one-time request ids: the route's own database. */
function requestLedgerDb(options: { db?: D1Like; env?: Readonly<Record<string, unknown>> }): D1Like | undefined {
  return options.db ?? (isD1Like(options.env?.DB) ? (options.env!.DB as D1Like) : undefined);
}

function isD1Like(candidate: unknown): candidate is D1Like {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as D1Like).prepare === "function" &&
    typeof (candidate as D1Like).batch === "function"
  );
}

function generateRehearsalRunId(): string {
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `rehearsal:${uuid}`;
}

function buildStructuredRehearsalError(
  nodeId: string,
  nodeType: string,
  redactedMessage: string,
  redactedStack: string,
): StructuredRehearsalError {
  const whatHappened = `Step "${nodeId}" (${nodeType}) failed during rehearsal.`;
  const why = redactedMessage;
  let whatToDo =
    "Inspect the node configuration in the Params tab and verify the JSON test input structure before retrying.";
  let field: string | null = null;

  if (/secret\s+"([^"]+)"/i.test(redactedMessage)) {
    const match = redactedMessage.match(/secret\s+"([^"]+)"/i);
    field = match?.[1] ?? null;
    whatToDo =
      "Bind or configure the required secret in the Connections & Secrets drawer, then re-run Test Step.";
  } else if (/insufficient balance/i.test(redactedMessage)) {
    field = "amount";
    whatToDo =
      'Increase the input "balance" value or lower the configured "amount" setting in the Params tab.';
  } else if (/division by zero/i.test(redactedMessage)) {
    field = "b";
    whatToDo =
      'Provide a non-zero divisor ("b") in the Params tab or test input payload.';
  } else if (/invalid ISO timestamp/i.test(redactedMessage)) {
    field = "iso";
    whatToDo =
      'Provide a valid ISO-8601 timestamp string (e.g. "2026-10-01T00:00:00.000Z") in the "iso" field.';
  } else if (/no executor registered/i.test(redactedMessage)) {
    whatToDo =
      "Verify that the node type belongs to an enabled catalog brick or core node pack.";
  }

  return {
    message: redactedMessage,
    whatHappened,
    why,
    whatToDo,
    field,
    stack: redactedStack,
  };
}

function normalizeRehearsalInputs(
  rawInput: unknown,
  declaredInputPortIds: ReadonlySet<string>,
): { inputs: Record<string, unknown>; payload: unknown } {
  if (declaredInputPortIds.size === 0) {
    // Trigger node: receives rawInput as payload
    const unwrapped =
      typeof rawInput === "object" &&
      rawInput !== null &&
      !Array.isArray(rawInput) &&
      Object.hasOwn(rawInput, "in") &&
      Object.keys(rawInput as Record<string, unknown>).length === 1
        ? (rawInput as Record<string, unknown>).in
        : rawInput;
    return { inputs: {}, payload: unwrapped };
  }

  if (
    typeof rawInput === "object" &&
    rawInput !== null &&
    !Array.isArray(rawInput)
  ) {
    const rec = rawInput as Record<string, unknown>;
    const keys = Object.keys(rec);
    // If caller explicitly passed port-keyed object like { in: ... } or { a: ..., b: ... }
    if (
      keys.length > 0 &&
      keys.every((k) => declaredInputPortIds.has(k))
    ) {
      return {
        inputs: rec,
        payload: rec.in ?? rawInput,
      };
    }
    // If upstream output shape `{ out: ... }` was passed directly, unwrap `.out` into `in`
    if (
      keys.length === 1 &&
      keys[0] === "out" &&
      declaredInputPortIds.has("in") &&
      !declaredInputPortIds.has("out")
    ) {
      return {
        inputs: { in: rec.out },
        payload: rec.out,
      };
    }
  }

  return {
    inputs: { in: rawInput },
    payload: rawInput,
  };
}

export async function rehearseStep(
  rawRequest: StepRehearsalInput,
  options: RehearseStepOptions,
): Promise<StepRehearsalResult> {
  const pxEnv =
    options.pxEnv ??
    (typeof options.env?.PX_ENV === "string" ? options.env.PX_ENV : "preview");
  if (pxEnv === "production") {
    throw new Error(
      "REHEARSAL_FORBIDDEN_IN_PRODUCTION: Test Step rehearsal is restricted to preview deployments.",
    );
  }

  const request = StepRehearsalRequestSchema.parse(rawRequest);
  if (!isTenantWorkspaceId(request.workspaceId)) {
    throw new RunRefusedError("NO_WORKSPACE", "the rehearsal names no usable workspace, so nothing was run");
  }
  const runId = options.runId ?? generateRehearsalRunId();
  const db =
    options.db ??
    (isD1Like(options.env?.DB) ? (options.env.DB as D1Like) : undefined);

  const manifest = options.registry.get(request.nodeType);
  const executor =
    options.executors.get(request.nodeType) ??
    (manifest?.executor ? options.executors.get(manifest.executor) : undefined);

  const trackedSecrets = new Set<string>();
  const secretFieldNames = new Set<string>();

  if (options.secretValues) {
    for (const s of options.secretValues) {
      if (typeof s === "string" && s.trim().length >= 3) {
        trackedSecrets.add(s);
      }
    }
  }
  if (options.secretFieldNames) {
    for (const f of options.secretFieldNames) {
      if (typeof f === "string" && f.length > 0) {
        secretFieldNames.add(f);
      }
    }
  }
  if (options.connections) {
    collectConnectionsMapSecrets(options.connections, trackedSecrets);
  }
  if (manifest) {
    for (const secName of manifest.secrets ?? []) {
      const val = options.env?.[secName];
      if (typeof val === "string" && val.trim().length >= 3) {
        trackedSecrets.add(val);
      }
    }
    for (const fieldName of manifest.secretFields ?? []) {
      secretFieldNames.add(fieldName);
      const cfgVal = request.config[fieldName];
      if (typeof cfgVal === "string" && cfgVal.trim().length >= 3) {
        trackedSecrets.add(cfgVal);
      }
    }
  }
  collectSecretKeyedValues(request.config, trackedSecrets, secretFieldNames);
  collectSecretKeyedValues(request.input, trackedSecrets, secretFieldNames);
  if (request.upstreamSteps) {
    collectSecretKeyedValues(request.upstreamSteps, trackedSecrets, secretFieldNames);
  }

  const declaredPortIds = new Set(
    (manifest?.inputs ?? [{ id: "in", dataType: "any" }]).map((p) => p.id),
  );
  const { inputs, payload } = normalizeRehearsalInputs(
    request.input,
    declaredPortIds,
  );

  const resolvedData = resolveStepExpressions(
    request.config,
    request.upstreamSteps ?? {},
    payload,
  ) as Record<string, unknown>;

  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  if (db) {
    await ensureTelemetryTables(db);
  }

  try {
    if (!executor) {
      throw new Error(`no executor registered for ${request.nodeType}`);
    }

    const declaredSecrets = manifest?.secrets ?? [];
    const secret = (name: string): string => {
      if (!declaredSecrets.includes(name)) {
        throw new Error(`secret "${name}" is not declared by ${request.nodeType}`);
      }
      const value = options.env?.[name];
      if (typeof value !== "string") {
        throw new Error(
          `secret "${name}" is declared by ${request.nodeType} but was not provided`,
        );
      }
      if (value.trim().length >= 3) {
        trackedSecrets.add(value);
      }
      return value;
    };

    const declaredBindings = manifest?.bindings ?? [];
    const binding = <T = unknown>(name: string): T => {
      if (!declaredBindings.includes(name)) {
        throw new Error(`binding "${name}" is not declared by ${request.nodeType}`);
      }
      const value = options.env?.[name];
      if (value === undefined || value === null) {
        throw new Error(
          `binding "${name}" is declared by ${request.nodeType} but was not provided`,
        );
      }
      return value as T;
    };

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
      const connectionDb =
        (typeof options.env?.DB === "object" &&
        options.env.DB !== null &&
        "prepare" in options.env.DB
          ? (options.env.DB as D1Like)
          : undefined) ?? db;
      if (typeof nameOrSelector === "string") {
        const candidate =
          options.connections?.[nameOrSelector] ?? options.env?.[nameOrSelector];
        if (candidate !== undefined && candidate !== null && typeof candidate === "object") {
          collectConnectionSecretValues(
            candidate as Record<string, unknown>,
            trackedSecrets,
          );
          return candidate as T;
        }
      } else if (options.connections) {
        // The request's workspace only: a selector's own workspaceId is never used.
        const wsId = request.workspaceId;
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
            collectConnectionSecretValues(
              candidate as Record<string, unknown>,
              trackedSecrets,
            );
            return candidate as T;
          }
        }
      }
      if (connectionDb) {
        const inferredApp = request.nodeType.startsWith("int:")
          ? request.nodeType.slice("int:".length).split(".")[0]
          : undefined;
        return resolveCaseAConnection(nameOrSelector, {
          db: connectionDb,
          connKey,
          telemetryWrite: { projectId: options.telemetryProjectId },
          ...(projectIdForConnections(options) ? { projectId: projectIdForConnections(options) } : {}),
          envName: pxEnv,
          workspaceId: request.workspaceId,
          defaultApp: inferredApp,
          tokenUrlByApp: getRegisteredTokenUrlsByApp(),
          oauthFetcher,
          trackedSecrets,
          runId,
          workflowId: request.workflowId,
          revision: request.revision,
          nodeId: request.nodeId,
        }) as Promise<T>;
      }
      const label =
        typeof nameOrSelector === "string"
          ? nameOrSelector
          : (nameOrSelector.ref ?? nameOrSelector.app ?? "unknown");
      throw new Error(`connection "${label}" was not provided`);
    };

    const execCtx: ExecutionContext = {
      nodeId: request.nodeId,
      runId,
      idempotencyKey: `${runId}:${request.nodeId}`,
      workspaceId: request.workspaceId,
      data: resolvedData,
      inputs,
      payload,
      secret,
      binding,
    };
    Object.defineProperty(execCtx, "connection", {
      value: connection,
      enumerable: false,
    });
    Object.defineProperty(execCtx, "rehearsal", {
      value: true,
      enumerable: false,
    });
    Object.defineProperty(execCtx, "nodeType", {
      value: request.nodeType,
      enumerable: false,
    });

    const rawOutput = (await executor(execCtx)) ?? {};
    const durationMs = Math.max(0, Date.now() - startMs);
    const redactOpts = {
      secretValues: trackedSecrets,
      secretFieldNames,
    };

    const inputPreview = truncateTelemetryPreview(
      { inputs, data: resolvedData },
      redactOpts,
    );
    const outputPreview = truncateTelemetryPreview(rawOutput, redactOpts);
    const redactedOutput = redactTelemetryPayload(
      rawOutput,
      redactOpts,
    ) as Record<string, unknown>;

    if (db) {
      const runRecord: RunRecord = {
        runId,
        workflowId: request.workflowId,
        revision: request.revision,
        triggerType: "rehearsal",
        workspaceId: request.workspaceId,
        status: "succeeded",
        durationMs,
        retries: 0,
        retryOfRunId: null,
        errorStack: null,
        startedAt,
        endedAt: new Date().toISOString(),
      };
      await upsertRunRecord(db, runRecord, { projectId: options.telemetryProjectId });

      const stepEvent: StepEvent = {
        eventId: `${runId}:${request.nodeId}:succeeded:1`,
        runId,
        workflowId: request.workflowId,
        revision: request.revision,
        workspaceId: request.workspaceId,
        nodeId: request.nodeId,
        status: "succeeded",
        durationMs,
        retries: 0,
        inputPreview,
        outputPreview,
        errorStack: null,
        createdAt: new Date().toISOString(),
      };
      await insertStepEvent(db, stepEvent, { projectId: options.telemetryProjectId });
    }

    return {
      ok: true,
      runId,
      workflowId: request.workflowId,
      revision: request.revision,
      nodeId: request.nodeId,
      nodeType: request.nodeType,
      status: "succeeded",
      durationMs,
      inputPreview,
      outputPreview,
      output: redactedOutput,
    };
  } catch (err) {
    const durationMs = Math.max(0, Date.now() - startMs);
    const redactOpts = {
      secretValues: trackedSecrets,
      secretFieldNames,
    };
    const rawMsg = err instanceof Error ? err.message : String(err);
    const rawStack =
      err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
    const redactedMsg = redactTelemetryString(rawMsg, redactOpts);
    const redactedStack = redactTelemetryString(rawStack, redactOpts);

    const inputPreview = truncateTelemetryPreview(
      { inputs, data: resolvedData },
      redactOpts,
    );
    const outputPreview = "{}";

    if (db) {
      const runRecord: RunRecord = {
        runId,
        workflowId: request.workflowId,
        revision: request.revision,
        triggerType: "rehearsal",
        workspaceId: request.workspaceId,
        status: "failed",
        durationMs,
        retries: 0,
        retryOfRunId: null,
        errorStack: redactedStack,
        startedAt,
        endedAt: new Date().toISOString(),
      };
      await upsertRunRecord(db, runRecord, { projectId: options.telemetryProjectId });

      const stepEvent: StepEvent = {
        eventId: `${runId}:${request.nodeId}:failed:1`,
        runId,
        workflowId: request.workflowId,
        revision: request.revision,
        workspaceId: request.workspaceId,
        nodeId: request.nodeId,
        status: "failed",
        durationMs,
        retries: 0,
        inputPreview,
        outputPreview,
        errorStack: redactedStack,
        createdAt: new Date().toISOString(),
      };
      await insertStepEvent(db, stepEvent, { projectId: options.telemetryProjectId });
    }

    const structuredError = buildStructuredRehearsalError(
      request.nodeId,
      request.nodeType,
      redactedMsg,
      redactedStack,
    );

    return {
      ok: false,
      runId,
      workflowId: request.workflowId,
      revision: request.revision,
      nodeId: request.nodeId,
      nodeType: request.nodeType,
      status: "failed",
      durationMs,
      inputPreview,
      outputPreview,
      output: {},
      error: structuredError,
    };
  }
}

/**
 * A signed request names the workspace its signer verified; one that names none is refused with 400 NO_WORKSPACE before
 * anything runs. There is no default workspace (AD-S19).
 */
export function refuseMissingWorkspace(parsedJson: unknown): Response | null {
  const ws = (parsedJson as { workspaceId?: unknown } | null)?.workspaceId;
  if (ws === undefined || ws === null || ws === "") {
    return Response.json(
      { error: { code: "NO_WORKSPACE", message: "The signed request names no workspaceId; a run without a verified workspace is refused." } },
      { status: 400 },
    );
  }
  if (!isTenantWorkspaceId(ws)) {
    return Response.json(
      { error: { code: "BAD_WORKSPACE", message: "workspaceId must be a tenant workspace id (letters, digits, _ and -, up to 64, no double underscore)." } },
      { status: 400 },
    );
  }
  return null;
}

/** A run the runtime refused (no or mismatched workspace) is the caller's fault: 400 with its code, nothing ran. */
function refusedRunResponse(err: unknown): Response | null {
  if (!(err instanceof RunRefusedError)) return null;
  return Response.json({ error: { code: err.code, message: err.message } }, { status: 400 });
}

export async function handleStepRehearsalRequest(
  request: Request,
  options: RehearseStepOptions & {
    telemetrySecret: string | undefined;
  },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/__px/rehearse") return null;

  if (request.method !== "POST") {
    return Response.json(
      { error: { code: "METHOD_NOT_ALLOWED", message: "Expected POST /__px/rehearse" } },
      { status: 405 },
    );
  }

  const pxEnv =
    options.pxEnv ??
    (typeof options.env?.PX_ENV === "string" ? options.env.PX_ENV : "preview");
  if (pxEnv === "production") {
    return Response.json(
      {
        error: {
          code: "REHEARSAL_FORBIDDEN_IN_PRODUCTION",
          message:
            "Test Step rehearsal is only permitted against preview environments, never production.",
        },
      },
      { status: 403 },
    );
  }

  // Story 1.17: the control-plane signature (domain, method, path, time, body) and a one-time requestId, recorded
  // before any executor runs. A replay of a captured request gets 409 and executes nothing.
  const rawBody = await request.text();
  const admitted = await admitExecutingControlRequest(request, {
    secret: options.telemetrySecret,
    rawBody,
    db: requestLedgerDb(options),
    ...(options.clock ? { nowMs: options.clock() } : {}),
  });
  if (!admitted.ok) return admitted.response;
  const parsedJson: unknown = admitted.body;

  const noWorkspace = refuseMissingWorkspace(parsedJson);
  if (noWorkspace) return noWorkspace;

  const validated = StepRehearsalRequestSchema.safeParse(parsedJson);
  if (!validated.success) {
    return Response.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: validated.error.issues.map((i) => i.message).join("; "),
          issues: validated.error.issues,
        },
      },
      { status: 422 },
    );
  }

  try {
    const result = await rehearseStep(validated.data, options);
    return Response.json(result, { status: 200 });
  } catch (err) {
    const refused = refusedRunResponse(err);
    if (refused) return refused;
    throw err;
  }
}

export const WorkflowRunRequestSchema = z.object({
  /** Story 1.17: the one-time id of the signed request (a UUID); checked and recorded before anything runs. */
  requestId: z.string().optional(),
  runId: z.string().min(1).max(160).optional(),
  project: z.string().min(1).max(120).optional(),
  workflowId: z.string().min(1).max(120).default("wf_default"),
  revision: z.number().int().min(0).default(0),
  triggerType: z.string().min(1).max(60).default("manual"),
  triggerPayload: z.unknown().default({}),
  /** The workspace the signer verified for this run (AD-S19). Required: a run without one is refused with 400. */
  workspaceId: z.string().min(1).max(120),
  retryOfRunId: z.string().nullable().optional(),
  usePinnedOutputs: z.boolean().optional(),
  pinnedOutputs: z.record(z.string(), z.unknown()).optional(),
  seededOutputs: z.record(z.string(), z.unknown()).optional(),
  reusedNodeIds: z.array(z.string()).optional(),
  fromNodeId: z.string().min(1).max(160).optional(),
  graph: z.object({
    nodes: z.array(
      z.object({
        id: z.string().min(1),
        type: z.string().min(1),
        data: z.record(z.string(), z.unknown()).default({}),
      }),
    ),
    edges: z.array(
      z.object({
        id: z.string().min(1),
        source: z.string().min(1),
        target: z.string().min(1),
        sourceHandle: z.string().optional(),
        targetHandle: z.string().optional(),
      }),
    ),
  }),
});

export type WorkflowRunInput = z.input<typeof WorkflowRunRequestSchema>;
export type WorkflowRunRequest = z.infer<typeof WorkflowRunRequestSchema>;

export interface ExecuteWorkflowRunOptions extends RehearseStepOptions {
  telemetrySecret?: string;
  /** The project's webhook-signing secret (deriveProjectTelemetrySecret); Studio passes it for its own webhook. */
  telemetryWebhookSecret?: string;
  telemetryWebhookUrl?: string;
  telemetryWebhookFetcher?: TelemetryRunOptions["webhookFetcher"];
}

export interface WorkflowRunResponse {
  ok: boolean;
  runId: string;
  workflowId: string;
  revision: number;
  triggerType: string;
  workspaceId: string;
  status: "queued";
  runStatus: "succeeded" | "failed";
  durationMs: number;
  outputs: Record<string, Record<string, unknown>>;
  failed: Record<string, string>;
  skipped: string[];
  runRecord?: RunRecord;
  stepEvents: StepEvent[];
  retryOfRunId?: string | null;
}

export async function executeWorkflowRun(
  rawInput: WorkflowRunInput,
  options: ExecuteWorkflowRunOptions,
): Promise<WorkflowRunResponse> {
  const request = WorkflowRunRequestSchema.parse(rawInput);
  const registry = options.registry;
  const executors = options.executors;

  const db =
    options.db ??
    (isD1Like(options.env?.DB) ? (options.env!.DB as D1Like) : undefined);

  const runId =
    request.runId ??
    `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const trackedSecrets = new Set<string>();
  const secretFieldNames = new Set<string>();

  if (options.secretValues) {
    for (const s of options.secretValues) {
      if (typeof s === "string" && s.trim().length >= 3) {
        trackedSecrets.add(s);
      }
    }
  }
  if (options.secretFieldNames) {
    for (const f of options.secretFieldNames) {
      if (typeof f === "string" && f.length > 0) {
        secretFieldNames.add(f);
      }
    }
  }
  if (options.connections) {
    collectConnectionsMapSecrets(options.connections, trackedSecrets);
  }
  for (const node of request.graph.nodes) {
    const manifest = registry.get(node.type);
    if (!manifest) continue;
    for (const sName of manifest.secrets ?? []) {
      const val = options.env?.[sName];
      if (typeof val === "string" && val.trim().length >= 3) {
        trackedSecrets.add(val);
      }
    }
    for (const fName of manifest.secretFields ?? []) {
      secretFieldNames.add(fName);
      const val = node.data?.[fName];
      if (typeof val === "string" && val.trim().length >= 3) {
        trackedSecrets.add(val);
      }
    }
    if (node.data) {
      collectSecretKeyedValues(node.data, trackedSecrets, secretFieldNames);
    }
  }
  collectSecretKeyedValues(request.triggerPayload, trackedSecrets, secretFieldNames);
  if (request.pinnedOutputs) {
    collectSecretKeyedValues(request.pinnedOutputs, trackedSecrets, secretFieldNames);
  }
  if (request.seededOutputs) {
    collectSecretKeyedValues(request.seededOutputs, trackedSecrets, secretFieldNames);
  }

  const effectivePinnedOutputs =
    request.usePinnedOutputs !== false ? request.pinnedOutputs : undefined;

  const wf = new RuntimeGraphWorkflow(registry, executors);
  const runResult = await wf.start({
    graph: request.graph,
    workspaceId: request.workspaceId,
    payload: request.triggerPayload,
    env: options.env,
    connections: options.connections,
    ...(effectivePinnedOutputs ? { pinnedOutputs: effectivePinnedOutputs } : {}),
    ...(request.seededOutputs ? { seededOutputs: request.seededOutputs } : {}),
    ...(request.reusedNodeIds
      ? { reusedNodeIds: new Set(request.reusedNodeIds) }
      : {}),
    ...(request.fromNodeId ? { fromNodeId: request.fromNodeId } : {}),
    telemetry: {
      db,
      runId,
      project: request.project,
      ...(options.telemetryProjectId ? { projectId: options.telemetryProjectId } : {}),
      workflowId: request.workflowId,
      revision: request.revision,
      triggerType: request.triggerType,
      workspaceId: request.workspaceId,
      retryOfRunId: request.retryOfRunId ?? null,
      telemetrySecret: options.telemetrySecret,
      ...(options.telemetryWebhookSecret ? { webhookSecret: options.telemetryWebhookSecret } : {}),
      webhookUrl: options.telemetryWebhookUrl,
      webhookFetcher: options.telemetryWebhookFetcher,
      secretValues: trackedSecrets,
      secretFieldNames,
    },
  });

  const redactOpts = {
    secretValues: trackedSecrets,
    secretFieldNames,
  };

  const redactedOutputs = redactTelemetryPayload(
    runResult.outputs,
    redactOpts,
  ) as Record<string, Record<string, unknown>>;

  const redactedFailed: Record<string, string> = {};
  for (const [k, v] of Object.entries(runResult.failed)) {
    redactedFailed[k] = redactTelemetryString(v, redactOpts);
  }

  return {
    ok: runResult.ok,
    runId: runResult.runId ?? runId,
    workflowId: request.workflowId,
    revision: request.revision,
    triggerType: request.triggerType,
    workspaceId: request.workspaceId,
    status: "queued",
    runStatus: runResult.ok ? "succeeded" : "failed",
    durationMs: runResult.runRecord?.durationMs ?? 0,
    outputs: redactedOutputs,
    failed: redactedFailed,
    skipped: runResult.skipped,
    runRecord: runResult.runRecord,
    stepEvents: runResult.stepEvents ?? [],
    retryOfRunId: request.retryOfRunId ?? null,
  };
}

export async function handleWorkflowRunRequest(
  request: Request,
  options: ExecuteWorkflowRunOptions & {
    telemetrySecret: string | undefined;
  },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/__px/runs") return null;

  if (request.method !== "POST") {
    return Response.json(
      { error: { code: "METHOD_NOT_ALLOWED", message: "Expected POST /__px/runs" } },
      { status: 405 },
    );
  }

  // Story 1.17: the control-plane signature (domain, method, path, time, body) and a one-time requestId, recorded
  // before any executor runs. A replay of a captured request gets 409 and executes nothing.
  const rawBody = await request.text();
  const admitted = await admitExecutingControlRequest(request, {
    secret: options.telemetrySecret,
    rawBody,
    db: requestLedgerDb(options),
    ...(options.clock ? { nowMs: options.clock() } : {}),
  });
  if (!admitted.ok) return admitted.response;
  const parsedJson: unknown = admitted.body;

  const noWorkspace = refuseMissingWorkspace(parsedJson);
  if (noWorkspace) return noWorkspace;

  const validated = WorkflowRunRequestSchema.safeParse(parsedJson);
  if (!validated.success) {
    return Response.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: validated.error.issues.map((i) => i.message).join("; "),
          issues: validated.error.issues,
        },
      },
      { status: 422 },
    );
  }

  try {
    const result = await executeWorkflowRun(validated.data, options);
    return Response.json(result, { status: 200 });
  } catch (err) {
    const refused = refusedRunResponse(err);
    if (refused) return refused;
    throw err;
  }
}

export const WorkflowRerunRequestSchema = WorkflowRunRequestSchema.extend({
  sourceRunId: z.string().min(1).max(160),
  fromNodeId: z.string().min(1).max(160),
  seededStepEvents: z.array(StepEventSchema).optional(),
});

export type WorkflowRerunInput = z.input<typeof WorkflowRerunRequestSchema>;
export type WorkflowRerunRequest = z.infer<typeof WorkflowRerunRequestSchema>;

export class UpstreamOutputUnavailableError extends Error {
  readonly code = "UPSTREAM_OUTPUT_UNAVAILABLE" as const;
  readonly nodeId: string;
  readonly reason: "missing_succeeded_output" | "output_truncated_16kb";

  constructor(
    nodeId: string,
    reason: "missing_succeeded_output" | "output_truncated_16kb",
    message: string,
  ) {
    super(message);
    this.name = "UpstreamOutputUnavailableError";
    this.nodeId = nodeId;
    this.reason = reason;
  }
}

export async function executeWorkflowRerun(
  rawInput: WorkflowRerunInput,
  options: ExecuteWorkflowRunOptions,
): Promise<WorkflowRunResponse> {
  const request = WorkflowRerunRequestSchema.parse(rawInput);
  const db =
    options.db ??
    (isD1Like(options.env?.DB) ? (options.env!.DB as D1Like) : undefined);

  const nodeExists = request.graph.nodes.some(
    (n) => n.id === request.fromNodeId,
  );
  if (!nodeExists) {
    throw new Error(
      `NODE_NOT_FOUND: Target node "${request.fromNodeId}" does not exist in workflow "${request.workflowId}".`,
    );
  }

  const strictAncestors = computeStrictUpstreamAncestors(
    request.graph,
    request.fromNodeId,
  );

  let recordedEvents: StepEvent[] = [];
  if (db) {
    await ensureTelemetryTables(db);
    // Only the source run's events inside this rerun's own workspace (and, in Studio, its project) are reused.
    recordedEvents = await listStepEventsForRun(db, request.sourceRunId, {
      workspaceId: request.workspaceId,
      ...(options.telemetryProjectId ? { projectId: options.telemetryProjectId } : {}),
    });
  }
  if (request.seededStepEvents && request.seededStepEvents.length > 0) {
    const seenIds = new Set(recordedEvents.map((e) => e.eventId));
    for (const ev of request.seededStepEvents) {
      if (!seenIds.has(ev.eventId)) {
        recordedEvents.push(ev);
      }
    }
  }

  const seededOutputs: Record<string, unknown> = {
    ...(request.seededOutputs ?? {}),
  };

  for (const ancestorId of strictAncestors) {
    if (Object.hasOwn(seededOutputs, ancestorId)) {
      continue;
    }
    const succeededEvents = recordedEvents.filter(
      (ev) => ev.nodeId === ancestorId && ev.status === "succeeded",
    );
    const latestSucceeded = succeededEvents[succeededEvents.length - 1];
    if (!latestSucceeded) {
      throw new UpstreamOutputUnavailableError(
        ancestorId,
        "missing_succeeded_output",
        `UPSTREAM_OUTPUT_UNAVAILABLE: Strict upstream node "${ancestorId}" has no recorded succeeded output in source run "${request.sourceRunId}". Run the full workflow or pin test output before re-running from "${request.fromNodeId}".`,
      );
    }

    const truncInfo = isTelemetryPreviewTruncated(latestSucceeded.outputPreview);
    if (truncInfo.truncated) {
      throw new UpstreamOutputUnavailableError(
        ancestorId,
        "output_truncated_16kb",
        `UPSTREAM_OUTPUT_UNAVAILABLE: Strict upstream node "${ancestorId}" output in source run "${request.sourceRunId}" was truncated at the 16 KB telemetry limit (${truncInfo.originalBytes ?? "16384+"} bytes), so full state is unavailable for partial re-run.`,
      );
    }

    let parsedOutput: unknown = {};
    try {
      parsedOutput = JSON.parse(latestSucceeded.outputPreview);
    } catch {
      parsedOutput = { out: latestSucceeded.outputPreview };
    }
    seededOutputs[ancestorId] = parsedOutput;
  }

  return executeWorkflowRun(
    {
      ...request,
      retryOfRunId: request.sourceRunId,
      fromNodeId: request.fromNodeId,
      seededOutputs,
      reusedNodeIds: [...strictAncestors],
    },
    options,
  );
}

export async function handleWorkflowRerunRequest(
  request: Request,
  options: ExecuteWorkflowRunOptions & {
    telemetrySecret: string | undefined;
  },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/__px/runs/rerun") return null;

  if (request.method !== "POST") {
    return Response.json(
      {
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "Expected POST /__px/runs/rerun",
        },
      },
      { status: 405 },
    );
  }

  // Story 1.17: the control-plane signature (domain, method, path, time, body) and a one-time requestId, recorded
  // before any executor runs. A replay of a captured request gets 409 and executes nothing.
  const rawBody = await request.text();
  const admitted = await admitExecutingControlRequest(request, {
    secret: options.telemetrySecret,
    rawBody,
    db: requestLedgerDb(options),
    ...(options.clock ? { nowMs: options.clock() } : {}),
  });
  if (!admitted.ok) return admitted.response;
  const parsedJson: unknown = admitted.body;

  const noWorkspace = refuseMissingWorkspace(parsedJson);
  if (noWorkspace) return noWorkspace;

  const validated = WorkflowRerunRequestSchema.safeParse(parsedJson);
  if (!validated.success) {
    return Response.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: validated.error.issues.map((i) => i.message).join("; "),
          issues: validated.error.issues,
        },
      },
      { status: 422 },
    );
  }

  try {
    const result = await executeWorkflowRerun(validated.data, options);
    return Response.json(result, { status: 200 });
  } catch (err) {
    const refused = refusedRunResponse(err);
    if (refused) return refused;
    if (err instanceof UpstreamOutputUnavailableError) {
      return Response.json(
        {
          error: {
            code: err.code,
            nodeId: err.nodeId,
            reason: err.reason,
            message: err.message,
          },
        },
        { status: 422 },
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("NODE_NOT_FOUND:")) {
      return Response.json(
        {
          error: {
            code: "NODE_NOT_FOUND",
            message: msg,
          },
        },
        { status: 404 },
      );
    }
    throw err;
  }
}
