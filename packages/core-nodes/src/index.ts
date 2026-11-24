import { z } from "zod";
import { NotConfiguredError, PLATFORM_LIMITS, createPublicUrlFetch, createRegistry, scoped } from "@poc/sdk";
import type { BrickManifest, ExecutionContext, Executor, Registry } from "@poc/sdk";
import rawManifest from "../core-nodes.manifest.json" with { type: "json" };

export const coreNodesManifest = rawManifest;

function digPath(value: unknown, path: string): unknown {
  if (!path || !path.trim()) return value;
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>(
      (at, key) =>
        typeof at === "object" && at !== null && Object.hasOwn(at, key)
          ? (at as Record<string, unknown>)[key]
          : undefined,
      value,
    );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export async function executeWebhookTrigger(ctx: ExecutionContext): Promise<Record<string, unknown>> {
  const method = String(ctx.data.method ?? "post").toLowerCase();
  const payloadObj = asRecord(ctx.payload);
  return {
    out: {
      trigger: "webhook",
      method,
      ...payloadObj,
      body: ctx.payload ?? {},
    },
  };
}

export async function executeScheduleTrigger(ctx: ExecutionContext): Promise<Record<string, unknown>> {
  const intervalMinutes = Number(ctx.data.intervalMinutes ?? 60);
  const payloadObj = asRecord(ctx.payload);
  return {
    out: {
      trigger: "schedule",
      intervalMinutes,
      scheduledTime: String(payloadObj.scheduledTime ?? "2026-10-01T00:00:00.000Z"),
      ...payloadObj,
    },
  };
}

export async function executeBrickEventTrigger(ctx: ExecutionContext): Promise<Record<string, unknown>> {
  const payloadObj = asRecord(ctx.payload);
  return {
    out: {
      trigger: "brick_event",
      event: String(ctx.data.event ?? payloadObj.event ?? "brick.updated"),
      ...payloadObj,
    },
  };
}

export async function executeIfNode(ctx: ExecutionContext): Promise<Record<string, unknown>> {
  const input = ctx.inputs.in;
  const operator = String(ctx.data.operator ?? "eq");
  const field = typeof ctx.data.field === "string" ? ctx.data.field : "";
  const lookedUp = field ? digPath(input, field) : undefined;
  const left = lookedUp !== undefined ? lookedUp : (ctx.data.left ?? (field || input));
  const right = ctx.data.value ?? ctx.data.right;

  let matched = false;
  switch (operator) {
    case "eq":
      matched = left === right;
      break;
    case "neq":
      matched = left !== right;
      break;
    case "gt":
      matched = Number(left) > Number(right);
      break;
    case "lt":
      matched = Number(left) < Number(right);
      break;
    case "exists":
      matched = left !== undefined && left !== null;
      break;
    default:
      matched = Boolean(left);
      break;
  }

  return {
    out: { matched, branch: matched ? "true" : "false", value: input ?? null },
    true: matched ? (input ?? true) : null,
    false: matched ? null : (input ?? false),
  };
}

export async function executeSwitchNode(ctx: ExecutionContext): Promise<Record<string, unknown>> {
  const input = ctx.inputs.in;
  const field = typeof ctx.data.field === "string" ? ctx.data.field : "type";
  const cases = asRecord(ctx.data.cases);
  const actual = String(digPath(input, field) ?? "");
  const matchedCase = Object.hasOwn(cases, actual)
    ? cases[actual]
    : (ctx.data.defaultBranch ?? "default");
  return {
    out: {
      key: actual,
      branch: matchedCase,
      value: input ?? null,
    },
  };
}

export async function executeLoopNode(ctx: ExecutionContext): Promise<Record<string, unknown>> {
  const rawItems = Array.isArray(ctx.inputs.in) ? ctx.inputs.in : [];
  const maxIterations = Math.max(1, Math.min(1000, Number(ctx.data.maxIterations ?? 100)));
  const bounded = rawItems.slice(0, maxIterations).map((item, index) =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? { ...(item as Record<string, unknown>), _index: index }
      : { value: item, _index: index },
  );
  return { out: bounded };
}

export async function executeMapNode(ctx: ExecutionContext): Promise<Record<string, unknown>> {
  const rawItems = Array.isArray(ctx.inputs.in) ? ctx.inputs.in : [];
  const field = typeof ctx.data.field === "string" ? ctx.data.field : "";
  const mapped = rawItems.map((item) => (field ? digPath(item, field) : item));
  return { out: mapped };
}

export async function executeMergeNode(ctx: ExecutionContext): Promise<Record<string, unknown>> {
  const mode = String(ctx.data.mode ?? "combine");
  const a = asRecord(ctx.inputs.a);
  const b = asRecord(ctx.inputs.b);
  const direct = asRecord(ctx.inputs.in);
  let merged: Record<string, unknown>;
  if (mode === "prefer-a") {
    merged = { ...direct, ...b, ...a };
  } else if (mode === "prefer-b") {
    merged = { ...direct, ...a, ...b };
  } else {
    merged = { ...direct, ...a, ...b };
  }
  return { out: merged };
}

export async function executeDelayNode(ctx: ExecutionContext): Promise<Record<string, unknown>> {
  const delayMs = Math.max(0, Math.min(60000, Number(ctx.data.delayMs ?? 0)));
  if (delayMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delayMs, 25)));
  }
  return { out: ctx.inputs.in ?? { delayedMs: delayMs } };
}

export async function executeFilterNode(ctx: ExecutionContext): Promise<Record<string, unknown>> {
  const rawItems = Array.isArray(ctx.inputs.in) ? ctx.inputs.in : [];
  const field = typeof ctx.data.field === "string" ? ctx.data.field : "";
  const equals = ctx.data.equals;
  const filtered = rawItems.filter((item) => {
    if (!field) return Boolean(item);
    const val = digPath(item, field);
    return equals !== undefined ? val === equals : Boolean(val);
  });
  return { out: filtered };
}

export async function executeNoopNode(ctx: ExecutionContext): Promise<Record<string, unknown>> {
  return { out: ctx.inputs.in ?? null };
}

export async function executeFieldMapNode(ctx: ExecutionContext): Promise<Record<string, unknown>> {
  const source = asRecord(ctx.inputs.in);
  const mappings = asRecord(ctx.data.mappings);
  const includeUnmapped = Boolean(ctx.data.includeUnmapped ?? false);
  const out: Record<string, unknown> = includeUnmapped ? { ...source } : {};

  if (Object.keys(mappings).length === 0) {
    return { out: { ...source } };
  }

  for (const [targetKey, sourcePath] of Object.entries(mappings)) {
    if (typeof sourcePath === "string") {
      out[targetKey] = digPath(source, sourcePath);
    } else {
      out[targetKey] = sourcePath;
    }
  }
  return { out };
}

export async function executeRenameKeysNode(ctx: ExecutionContext): Promise<Record<string, unknown>> {
  const source = asRecord(ctx.inputs.in);
  const renameMap = asRecord(ctx.data.rename);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const nextKey = typeof renameMap[key] === "string" && renameMap[key] ? String(renameMap[key]) : key;
    out[nextKey] = value;
  }
  return { out };
}

export async function executeFormatTemplateNode(ctx: ExecutionContext): Promise<Record<string, unknown>> {
  const vars = asRecord(ctx.inputs.in);
  const template = typeof ctx.data.template === "string" ? ctx.data.template : "{{value}}";
  const formatted = template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, rawPath: string) => {
    const resolved = digPath(vars, rawPath);
    if (resolved === undefined || resolved === null) return "";
    return typeof resolved === "object" ? JSON.stringify(resolved) : String(resolved);
  });
  return { out: formatted };
}

export async function executeJsonTransformNode(ctx: ExecutionContext): Promise<Record<string, unknown>> {
  const input = ctx.inputs.in;
  const path = typeof ctx.data.path === "string" ? ctx.data.path : "";
  const wrapKey = typeof ctx.data.wrapKey === "string" ? ctx.data.wrapKey : "";
  const extracted = path ? digPath(input, path) : input;
  const result = wrapKey ? { [wrapKey]: extracted } : extracted;
  return { out: result };
}

export async function executeMathNode(ctx: ExecutionContext): Promise<Record<string, unknown>> {
  const inputObj = asRecord(ctx.inputs.in);
  const a = Number(ctx.data.a ?? inputObj.a ?? (typeof ctx.inputs.in === "number" ? ctx.inputs.in : 0));
  const b = Number(ctx.data.b ?? inputObj.b ?? 0);
  const op = String(ctx.data.operation ?? "add");
  let value = 0;
  switch (op) {
    case "add":
      value = a + b;
      break;
    case "sub":
      value = a - b;
      break;
    case "mul":
      value = a * b;
      break;
    case "div":
      if (b === 0) throw new Error("core.math: division by zero");
      value = a / b;
      break;
    case "round":
      value = Math.round(a);
      break;
    default:
      value = a + b;
      break;
  }
  return { out: value };
}

export async function executeDateTimeNode(ctx: ExecutionContext): Promise<Record<string, unknown>> {
  const inputObj = asRecord(ctx.inputs.in);
  const rawIso =
    typeof ctx.inputs.in === "string"
      ? ctx.inputs.in
      : typeof inputObj.iso === "string"
        ? inputObj.iso
        : typeof ctx.data.iso === "string"
          ? ctx.data.iso
          : "2026-10-01T00:00:00.000Z";
  const addSeconds = Number(ctx.data.addSeconds ?? 0);
  const baseMs = Date.parse(rawIso);
  if (Number.isNaN(baseMs)) {
    throw new Error(`core.date_time: invalid ISO timestamp "${rawIso}"`);
  }
  const shiftedIso = new Date(baseMs + addSeconds * 1000).toISOString();
  return { out: shiftedIso };
}

function isFixtureUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "http:" &&
      parsed.hostname === "fixture.local" &&
      parsed.port === "" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

export async function executeHttpRequestNode(ctx: ExecutionContext): Promise<Record<string, unknown>> {
  const method = String(ctx.data.method ?? "post").toUpperCase();
  const timeoutMs = Number(ctx.data.timeoutMs ?? 5000);
  const inputObj = asRecord(ctx.inputs.in);
  const url = String(ctx.data.url ?? inputObj.url ?? "https://api.example.test/webhook");
  const requestBody = inputObj.body ?? ctx.inputs.in ?? null;

  const fixtureTarget = isFixtureUrl(url);
  if (ctx.data.liveFetch === true || fixtureTarget) {
    const reqHeaders = new Headers(asRecord(ctx.data.headers) as Record<string, string>);
    if (!reqHeaders.has("content-type") && method !== "GET" && method !== "HEAD") {
      reqHeaders.set("content-type", "application/json");
    }
    const init: RequestInit = {
      method,
      headers: reqHeaders,
      ...(method !== "GET" && method !== "HEAD" && requestBody !== null
        ? { body: typeof requestBody === "string" ? requestBody : JSON.stringify(requestBody) }
        : {}),
    };
    // The URL comes from the workflow's settings or input, so a live call goes through the public-URL guard
    // (no private, loopback, link-local or metadata destinations; every redirect hop re-checked). The only exception
    // is the exact `http://fixture.local` test-fixture host, which never resolves on public DNS and is fetched
    // without following redirects.
    const res = fixtureTarget
      ? await fetch(url, { ...init, redirect: "manual" })
      : await createPublicUrlFetch((target, reqInit) => fetch(target, reqInit))(url, init);
    if (fixtureTarget && res.status >= 300 && res.status < 400) {
      throw new Error("core.http_request: redirects from the fixture host are not followed");
    }
    const text = await res.text();
    let parsedBody: unknown = text;
    try {
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = text;
    }
    return {
      out: {
        ok: res.ok,
        status: res.status,
        method,
        url,
        timeoutMs,
        body: parsedBody,
      },
    };
  }

  // Story 0.9 (R-B): with live fetch off and no injected fixture target there is no response to report.
  // Never fabricate a 200; fail the step with an explicit code the run records.
  throw new NotConfiguredError(
    `core.http_request (${ctx.nodeId}): live fetch is off, so ${method} ${url} was not sent. Set "liveFetch": true on the node to call the URL.`,
  );
}

export async function executeBatchNode(ctx: ExecutionContext): Promise<Record<string, unknown>> {
  const runId = String(ctx.runId ?? "run_batch");
  const nodeId = String(ctx.nodeId ?? "node_batch");
  const targetOperation = String(ctx.data.targetOperation ?? ctx.data.target ?? "integration.send");
  const plan = String(ctx.data.plan ?? "free").toLowerCase();
  const retries = Number(ctx.data.retries ?? 0);
  // The run's verified workspace only (AD-S19): config, inputs and payload never choose where the jobs are written.
  const workspaceId = ctx.workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("NO_WORKSPACE: core.batch has no verified run workspace, so no jobs were written");
  }

  // 1. Resolve raw items
  let rawItems: unknown[] = [];
  const inVal = ctx.inputs.in;
  if (Array.isArray(inVal)) {
    rawItems = inVal;
  } else if (typeof inVal === "number" && inVal > 0) {
    rawItems = Array.from({ length: inVal }, (_, i) => ({ id: i + 1, index: i }));
  } else if (typeof inVal === "object" && inVal !== null && Array.isArray((inVal as any).items)) {
    rawItems = (inVal as any).items;
  } else if (Array.isArray(ctx.inputs.items)) {
    rawItems = ctx.inputs.items;
  } else if (Array.isArray(ctx.data.items)) {
    rawItems = ctx.data.items;
  } else if (typeof ctx.data.items === "number" && ctx.data.items > 0) {
    rawItems = Array.from({ length: ctx.data.items }, (_, i) => ({ id: i + 1, index: i }));
  } else if (typeof (ctx.payload as any)?.items === "number" && (ctx.payload as any).items > 0) {
    rawItems = Array.from({ length: (ctx.payload as any).items }, (_, i) => ({ id: i + 1, index: i }));
  } else if (Array.isArray((ctx.payload as any)?.items)) {
    rawItems = (ctx.payload as any).items;
  }

  const maxItems = Math.max(1, Math.min(100000, Number(ctx.data.maxItems ?? 100000)));
  const items = rawItems.slice(0, maxItems);

  // 2. Resolve chunkSize
  // auto = floor(PLATFORM_LIMITS[plan].subrequests * 0.8 / (retries + 1))
  const planLimits = PLATFORM_LIMITS[plan === "paid" ? "paid" : "free"] ?? PLATFORM_LIMITS.free;
  const autoChunkSize = Math.max(1, Math.floor((planLimits.subrequests.limit * 0.8) / (retries + 1)));

  let chunkSize = autoChunkSize;
  const configChunkSize = ctx.data.chunkSize;
  if (typeof configChunkSize === "number" && !Number.isNaN(configChunkSize) && configChunkSize > 0) {
    chunkSize = Math.floor(configChunkSize);
  } else if (typeof configChunkSize === "string" && configChunkSize !== "auto") {
    const parsed = parseInt(configChunkSize, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      chunkSize = parsed;
    }
  }

  // 3. Resolve bindings: DB and Queue
  let db: any = null;
  try {
    db = ctx.binding("DB");
  } catch {
    db = (ctx.data as any)?.db ?? (ctx as any).env?.DB;
  }

  let queue: any = null;
  try {
    queue = ctx.binding("QUEUE");
  } catch {
    try {
      queue = ctx.binding("JOB_QUEUE");
    } catch {
      queue =
        (ctx.data as any)?.queue ??
        (ctx.data as any)?.jobQueue ??
        (ctx as any).env?.QUEUE ??
        (ctx as any).env?.JOB_QUEUE;
    }
  }

  // 4. Chunk items and write job_queues
  const chunks: unknown[][] = [];
  if (items.length === 0) {
    chunks.push([]);
  } else {
    for (let i = 0; i < items.length; i += chunkSize) {
      chunks.push(items.slice(i, i + chunkSize));
    }
  }

  const totalChunks = chunks.length;
  const nowIso = new Date().toISOString();
  const enqueuedJobIds: string[] = [];

  for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
    const chunkItems = chunks[chunkIdx]!;
    const jobId = `job_${crypto.randomUUID().replace(/-/g, "")}`;
    enqueuedJobIds.push(jobId);

    if (db) {
      await scoped(db, workspaceId).insert("job_queues", {
        id: jobId,
        queue_name: "batch",
        task_type: "batch-chunk",
        payload_json: JSON.stringify({
          runId,
          nodeId,
          chunk: chunkIdx,
          totalChunks,
          totalItems: items.length,
          items: chunkItems,
          targetOperation,
        }),
        status: "queued",
        priority: 0,
        max_retries: 3,
        attempt_count: 0,
        next_run_at: nowIso,
        created_at: nowIso,
      });
    }
  }

  // 5. Send messages to queue binding
  if (queue) {
    if (typeof queue.sendBatch === "function") {
      const msgs = enqueuedJobIds.map((jobId) => ({ body: { jobId } }));
      for (let i = 0; i < msgs.length; i += 100) {
        await queue.sendBatch(msgs.slice(i, i + 100));
      }
    } else if (typeof queue.send === "function") {
      for (const jobId of enqueuedJobIds) {
        await queue.send({ jobId });
      }
    }
  }

  // 6. Aggregate result tracking
  const aggKey = `${runId}:${nodeId}`;
  const aggregate = {
    total: items.length,
    succeeded: 0,
    failed: 0,
    deadLettered: 0,
    chunkSize,
    chunkCount: totalChunks,
  };

  const aggregates = (globalThis as any).__px_batch_aggregates ?? new Map();
  (globalThis as any).__px_batch_aggregates = aggregates;
  aggregates.set(aggKey, aggregate);

  // 7. If step.waitForEvent is available (Workflows primitive), wait for event
  const stepObj = (ctx as any).step ?? (ctx.data as any)?.step;
  if (typeof stepObj?.waitForEvent === "function") {
    try {
      const evt = await stepObj.waitForEvent(`batch:${runId}:${nodeId}`);
      if (evt && typeof evt === "object" && "payload" in evt) {
        const payload = (evt as any).payload;
        return {
          out: payload,
          ...payload,
        };
      }
    } catch {
      // If waitForEvent fails or probe shows unavailable, continue
    }
  }

  return {
    out: aggregate,
    ...aggregate,
  };
}

const EXECUTOR_FUNCTIONS: Record<string, Executor> = {
  executeWebhookTrigger,
  executeScheduleTrigger,
  executeBrickEventTrigger,
  executeIfNode,
  executeSwitchNode,
  executeLoopNode,
  executeMapNode,
  executeMergeNode,
  executeDelayNode,
  executeFilterNode,
  executeNoopNode,
  executeFieldMapNode,
  executeRenameKeysNode,
  executeFormatTemplateNode,
  executeJsonTransformNode,
  executeMathNode,
  executeDateTimeNode,
  executeHttpRequestNode,
  executeBatchNode,
};

function buildConfigSchemaFromManifestConfig(
  configDef: Record<
    string,
    | { type: "integer"; min: number; max: number; default: number }
    | { type: "enum"; values: string[]; default: string }
    | { type: "boolean"; default: boolean }
  >,
): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, def] of Object.entries(configDef)) {
    if (key === "chunkSize") {
      shape[key] = z.union([z.number().int(), z.string()]).optional();
    } else if (def.type === "integer") {
      shape[key] = z.number().int().min(def.min).max(def.max).optional();
    } else if (def.type === "enum") {
      shape[key] = z.enum(def.values as [string, ...string[]]).optional();
    } else if (def.type === "boolean") {
      shape[key] = z.boolean().optional();
    }
  }
  return z.object(shape).passthrough();
}

export const coreNodeRegistryEntries: BrickManifest[] = coreNodesManifest.nodes.map((node) => ({
  type: node.type,
  label: node.label,
  summary: node.summary,
  category: node.role === "trigger" ? "trigger" : node.role === "logic" ? "logic" : "action",
  inputs: node.inputs.map((p) => ({ id: p.id, label: p.label, dataType: p.dataType })),
  outputs: node.outputs.map((p) => ({ id: p.id, label: p.label, dataType: p.dataType })),
  configSchema: buildConfigSchemaFromManifestConfig(
    node.config as Record<
      string,
      | { type: "integer"; min: number; max: number; default: number }
      | { type: "enum"; values: string[]; default: string }
      | { type: "boolean"; default: boolean }
    >,
  ),
  secrets: [],
  bindings: (node as any).bindings ? [...(node as any).bindings] : undefined,
  executor: node.executor,
  durable: node.durable,
  sideEffects: node.sideEffects as "none" | "read" | "write",
}));

export const coreNodeRegistry: Registry = createRegistry(coreNodeRegistryEntries);

export const coreNodeExecutors: ReadonlyMap<string, Executor> = new Map<string, Executor>(
  coreNodesManifest.nodes.map((node) => {
    const fn = EXECUTOR_FUNCTIONS[node.executor];
    if (!fn) {
      throw new Error(`Missing executor function "${node.executor}" for core node "${node.type}"`);
    }
    return [node.type, fn];
  }),
);

export const coreNodeExecutorsByExportName: Readonly<Record<string, Executor>> = EXECUTOR_FUNCTIONS;
export const coreNodeDefinitions = coreNodesManifest.nodes;
export const CORE_NODE_TYPES = coreNodesManifest.nodes.map((node) => node.type);

