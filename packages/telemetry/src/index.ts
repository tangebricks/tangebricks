import type { D1Like, StructuredLogContext, StructuredLogLevel, StructuredLogger } from "@poc/sdk";
import { z } from "zod";
import {
  VALUE_PATTERNS,
  scrubValuePatterns,
  type ValuePattern,
} from "./value-patterns.ts";

export { VALUE_PATTERNS, scrubValuePatterns, type ValuePattern };

export const REDACTED_PLACEHOLDER = "[REDACTED]";
export const MAX_FIELD_PREVIEW_BYTES = 8 * 1024; // 8,192 bytes per top-level field
export const MAX_TOTAL_PREVIEW_BYTES = 16 * 1024; // 16,384 bytes total per preview column
export const TELEMETRY_SIGNATURE_HEADER = "x-px-signature";

export const SECRET_KEY_REGEX =
  /^(authorization|cookie|set-cookie|x-api-key|api[-_]?key|.*token.*|.*secret.*|.*password.*)$/i;

export const INLINE_HEADER_SECRET_REGEX =
  /\b(cookie|set-cookie|x-api-key|api[-_]?key)\s*([:=])\s*[^\s,;]+/gi;

export const SECRET_VALUE_PATTERNS: readonly RegExp[] = VALUE_PATTERNS.map(
  (p) => p.regex,
);

export const StepStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunRecordSchema = z.object({
  runId: z.string().min(1),
  workflowId: z.string().min(1),
  revision: z.number().int().min(0),
  triggerType: z.string().min(1).default("manual"),
  workspaceId: z.string().min(1).default("ws_default"),
  status: RunStatusSchema,
  durationMs: z.number().min(0),
  retries: z.number().int().min(0).default(0),
  retryOfRunId: z.string().nullable().optional(),
  errorStack: z.string().nullable().optional(),
  startedAt: z.string().min(1),
  endedAt: z.string().nullable().optional(),
  durable: z.boolean().optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const StepEventSchema = z.object({
  eventId: z.string().min(1),
  runId: z.string().min(1),
  workflowId: z.string().min(1),
  revision: z.number().int().min(0),
  nodeId: z.string().min(1),
  status: StepStatusSchema,
  durationMs: z.number().min(0),
  retries: z.number().int().min(0).default(0),
  inputPreview: z.string().default("{}"),
  outputPreview: z.string().default("{}"),
  errorStack: z.string().nullable().optional(),
  createdAt: z.string().min(1),
  cursor: z.number().int().min(0).optional(),
  fromPinned: z.boolean().optional(),
  reused: z.boolean().optional(),
});
export type StepEvent = z.infer<typeof StepEventSchema>;

export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const StructuredLogEntrySchema = z.object({
  seq: z.number().int().min(0).optional(),
  logId: z.string().min(1),
  ts: z.string().min(1),
  level: LogLevelSchema,
  message: z.string(),
  runId: z.string().nullable().optional(),
  workflowId: z.string().nullable().optional(),
  revision: z.number().int().min(0).nullable().optional(),
  nodeId: z.string().nullable().optional(),
  brickId: z.string().nullable().optional(),
  workspaceId: z.string().nullable().optional(),
  requestId: z.string().nullable().optional(),
  fields: z.record(z.string(), z.unknown()).default({}),
  fieldsJson: z.string().default("{}"),
  errorStack: z.string().nullable().optional(),
  envName: z.string().optional(),
});
export type StructuredLogEntry = z.infer<typeof StructuredLogEntrySchema>;

export const LogWsFrameSchema = z.object({
  type: z.literal("log"),
  project: z.string().min(1),
  envName: z.string().min(1).default("preview"),
  entry: StructuredLogEntrySchema,
});
export type LogWsFrame = z.infer<typeof LogWsFrameSchema>;

export const TelemetryWebhookPayloadSchema = z.object({
  project: z.string().min(1).optional(),
  run: RunRecordSchema.optional(),
  events: z.array(StepEventSchema).default([]),
  logs: z.array(StructuredLogEntrySchema).optional(),
});
export type TelemetryWebhookPayload = z.infer<
  typeof TelemetryWebhookPayloadSchema
>;

export const TelemetryWsFrameSchema = z.object({
  type: z.literal("telemetry"),
  project: z.string().min(1),
  rev: z.number().int().min(0),
  runId: z.string().min(1),
  workflowId: z.string().min(1),
  nodeId: z.string().min(1),
  status: StepStatusSchema,
  durationMs: z.number().min(0),
  retries: z.number().int().min(0),
  inputPreview: z.string(),
  outputPreview: z.string(),
  errorStack: z.string().nullable().optional(),
  runStatus: RunStatusSchema.optional(),
  timestamp: z.string().min(1),
  fromPinned: z.boolean().optional(),
  reused: z.boolean().optional(),
});
export type TelemetryWsFrame = z.infer<typeof TelemetryWsFrameSchema>;

export const PX_TELEMETRY_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS px_runs (
  run_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  workspace_id TEXT NOT NULL DEFAULT 'ws_default',
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  duration_ms REAL NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  retry_of_run_id TEXT,
  error_stack TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_px_runs_workflow_started ON px_runs(workflow_id, started_at DESC);

CREATE TABLE IF NOT EXISTS px_step_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped')),
  duration_ms REAL NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  input_preview TEXT NOT NULL DEFAULT '{}',
  output_preview TEXT NOT NULL DEFAULT '{}',
  error_stack TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_px_step_events_run_node ON px_step_events(run_id, node_id);
CREATE INDEX IF NOT EXISTS idx_px_step_events_workflow_created ON px_step_events(workflow_id, created_at DESC);
CREATE VIEW IF NOT EXISTS px_steps AS SELECT * FROM px_step_events;

CREATE TABLE IF NOT EXISTS px_logs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  log_id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  message TEXT NOT NULL,
  run_id TEXT,
  workflow_id TEXT,
  revision INTEGER,
  node_id TEXT,
  brick_id TEXT,
  workspace_id TEXT,
  request_id TEXT,
  fields_json TEXT NOT NULL DEFAULT '{}',
  error_stack TEXT,
  env_name TEXT NOT NULL DEFAULT 'preview'
);

CREATE INDEX IF NOT EXISTS idx_px_logs_ts ON px_logs(ts DESC, seq DESC);
CREATE INDEX IF NOT EXISTS idx_px_logs_run_node ON px_logs(run_id, node_id);
CREATE INDEX IF NOT EXISTS idx_px_logs_workspace_brick ON px_logs(workspace_id, brick_id);
CREATE INDEX IF NOT EXISTS idx_px_logs_level_ts ON px_logs(level, ts DESC);

CREATE TABLE IF NOT EXISTS px_http_rollups (
  bucket_minute TEXT NOT NULL,
  route_prefix TEXT NOT NULL DEFAULT '/',
  brick_id TEXT NOT NULL DEFAULT 'runtime',
  request_count INTEGER NOT NULL DEFAULT 0,
  error_4xx_count INTEGER NOT NULL DEFAULT 0,
  error_5xx_count INTEGER NOT NULL DEFAULT 0,
  latency_buckets_json TEXT NOT NULL DEFAULT '{}',
  p50_ms REAL NOT NULL DEFAULT 0,
  p95_ms REAL NOT NULL DEFAULT 0,
  p99_ms REAL NOT NULL DEFAULT 0,
  d1_query_count INTEGER NOT NULL DEFAULT 0,
  d1_latency_ms REAL NOT NULL DEFAULT 0,
  d1_error_count INTEGER NOT NULL DEFAULT 0,
  env_name TEXT NOT NULL DEFAULT 'preview',
  PRIMARY KEY (bucket_minute, route_prefix, brick_id, env_name)
);

CREATE INDEX IF NOT EXISTS idx_px_http_rollups_env_bucket ON px_http_rollups(env_name, bucket_minute DESC);

CREATE TABLE IF NOT EXISTS px_queue_metrics (
  queue_name TEXT NOT NULL,
  pending_count INTEGER NOT NULL DEFAULT 0,
  dlq_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  env_name TEXT NOT NULL DEFAULT 'preview',
  PRIMARY KEY (queue_name, env_name)
);
`;

export const PX_TELEMETRY_MIGRATION = {
  name: "9010_px_telemetry.sql",
  sql: PX_TELEMETRY_MIGRATION_SQL,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function utf8ToBase64(text: string): string {
  const bytes = encoder.encode(text);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function utf8ToBase64Url(text: string): string {
  return utf8ToBase64(text)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sliceUtf8ByBytes(text: string, maxBytes: number): string {
  const encoded = encoder.encode(text);
  if (encoded.byteLength <= maxBytes) return text;
  let end = maxBytes;
  // Walk back over UTF-8 continuation bytes (10xxxxxx) so we never split a multi-byte code point
  while (end > 0 && (encoded[end]! & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return decoder.decode(encoded.subarray(0, end));
}

export interface RedactTelemetryOptions {
  /** Secret values accessed via ctx.secret(), ctx.connection(), or known canary values. */
  secretValues?: Iterable<string>;
  /** Field names whose manifest or node config schema marks widget: "secret". */
  secretFieldNames?: Iterable<string>;
  /** Project-configured additional field keys to redact (merged case-insensitively with secretFieldNames). */
  additionalRedactKeys?: Iterable<string>;
  /** Additive custom value patterns (e.g. from integration manifests or caller options). */
  valuePatterns?: Iterable<ValuePattern | { kind: string; regex?: RegExp; pattern?: RegExp }>;
}

function mergeSecretFieldNames(
  secretFieldNames?: Iterable<string>,
  additionalRedactKeys?: Iterable<string>,
): Set<string> {
  const secretFields = new Set<string>();
  const addFrom = (iter?: Iterable<string>) => {
    if (!iter) return;
    for (const field of iter) {
      if (typeof field === "string") {
        const trimmed = field.trim();
        if (trimmed.length > 0) {
          secretFields.add(trimmed);
          secretFields.add(trimmed.toLowerCase());
        }
      }
    }
  };
  addFrom(secretFieldNames);
  addFrom(additionalRedactKeys);
  return secretFields;
}

function buildExpandedSecretTokens(secretValues?: Iterable<string>): string[] {
  if (!secretValues) return [];
  const tokenSet = new Set<string>();
  for (const raw of secretValues) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length < 3) continue;
    tokenSet.add(raw);
    tokenSet.add(trimmed);
    try {
      const b64 = utf8ToBase64(trimmed);
      if (b64.length >= 4) tokenSet.add(b64);
      const b64Url = utf8ToBase64Url(trimmed);
      if (b64Url.length >= 4) tokenSet.add(b64Url);
    } catch {
      // Ignore encoding errors
    }
    try {
      const urlEnc = encodeURIComponent(trimmed);
      if (urlEnc.length >= 3) tokenSet.add(urlEnc);
    } catch {
      // Ignore encoding errors
    }
  }
  return [...tokenSet].sort((a, b) => b.length - a.length);
}

function addSecretCandidateString(raw: string, sink: Set<string>): void {
  const trimmed = raw.trim();
  if (trimmed.length < 3) return;
  sink.add(raw);
  sink.add(trimmed);
  const authMatch = /^(?:Bearer|Basic)\s+(.+)$/i.exec(trimmed);
  if (authMatch?.[1] && authMatch[1].trim().length >= 3) {
    sink.add(authMatch[1].trim());
  }
  if (trimmed.includes("=")) {
    for (const part of trimmed.split(";")) {
      const eqIdx = part.indexOf("=");
      if (eqIdx > 0) {
        const cookieVal = part.slice(eqIdx + 1).trim();
        if (cookieVal.length >= 3) {
          sink.add(cookieVal);
        }
      }
    }
  }
}

export function collectSecretStringsFromValue(
  value: unknown,
  sink: Set<string> = new Set<string>(),
  seen: WeakSet<object> = new WeakSet<object>(),
): Set<string> {
  if (typeof value === "string") {
    addSecretCandidateString(value, sink);
    return sink;
  }
  if (typeof value !== "object" || value === null) {
    return sink;
  }
  if (seen.has(value)) return sink;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectSecretStringsFromValue(item, sink, seen);
    }
    return sink;
  }

  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") {
      if (SECRET_KEY_REGEX.test(k) || v.trim().length >= 6) {
        addSecretCandidateString(v, sink);
      }
    } else if (typeof v === "object" && v !== null) {
      collectSecretStringsFromValue(v, sink, seen);
    }
  }
  return sink;
}

export function collectSecretKeyedValues(
  value: unknown,
  sink: Set<string> = new Set<string>(),
  secretFieldNames?: Iterable<string>,
  seen: WeakSet<object> = new WeakSet<object>(),
): Set<string> {
  if (typeof value !== "object" || value === null) {
    return sink;
  }
  if (seen.has(value)) return sink;
  seen.add(value);

  const secretFields = new Set<string>();
  if (secretFieldNames) {
    for (const f of secretFieldNames) {
      if (typeof f === "string" && f.length > 0) {
        secretFields.add(f);
        secretFields.add(f.toLowerCase());
      }
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectSecretKeyedValues(item, sink, secretFields, seen);
    }
    return sink;
  }

  if (typeof Headers !== "undefined" && value instanceof Headers) {
    value.forEach((v, k) => {
      if (
        SECRET_KEY_REGEX.test(k) ||
        secretFields.has(k) ||
        secretFields.has(k.toLowerCase())
      ) {
        addSecretCandidateString(v, sink);
      }
    });
    return sink;
  }

  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const isSecretKey =
      SECRET_KEY_REGEX.test(k) ||
      secretFields.has(k) ||
      secretFields.has(k.toLowerCase());
    if (isSecretKey) {
      if (typeof v === "string") {
        addSecretCandidateString(v, sink);
      } else if (typeof v === "object" && v !== null) {
        collectSecretStringsFromValue(v, sink, seen);
      }
    } else if (typeof v === "object" && v !== null) {
      collectSecretKeyedValues(v, sink, secretFields, seen);
    }
  }
  return sink;
}

export function redactTelemetryString(
  input: string,
  options: RedactTelemetryOptions = {},
): string {
  let out = input;
  const tokens = buildExpandedSecretTokens(options.secretValues);
  for (const token of tokens) {
    if (token && out.includes(token)) {
      out = out.split(token).join(REDACTED_PLACEHOLDER);
    }
  }
  // Scrub inline Basic credentials in strings (Bearer is handled via VALUE_PATTERNS)
  out = out.replace(
    /\bBasic\s+[A-Za-z0-9._~+/=-]{6,}/gi,
    `$1 ${REDACTED_PLACEHOLDER}`,
  );
  out = out.replace(
    INLINE_HEADER_SECRET_REGEX,
    `$1$2${REDACTED_PLACEHOLDER}`,
  );
  // Value-pattern scrubbing with kinded placeholders (UC9.3)
  out = scrubValuePatterns(out, options.valuePatterns);
  return out;
}

export function redactTelemetryPayload(
  value: unknown,
  options: RedactTelemetryOptions = {},
): unknown {
  const combinedSecrets = new Set<string>();
  if (options.secretValues) {
    for (const s of options.secretValues) {
      if (typeof s === "string") {
        addSecretCandidateString(s, combinedSecrets);
      }
    }
  }
  const secretFields = mergeSecretFieldNames(
    options.secretFieldNames,
    options.additionalRedactKeys,
  );
  collectSecretKeyedValues(value, combinedSecrets, secretFields);

  const seen = new WeakSet<object>();

  const scrubString = (str: string): string => {
    return redactTelemetryString(str, {
      secretValues: combinedSecrets,
      valuePatterns: options.valuePatterns,
    });
  };

  const walk = (current: unknown): unknown => {
    if (current === null || current === undefined) return current;
    if (typeof current === "string") {
      return scrubString(current);
    }
    if (typeof current === "number" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "bigint") {
      return current.toString();
    }
    if (current instanceof Error) {
      return {
        name: current.name,
        message: scrubString(current.message),
        ...(current.stack ? { stack: scrubString(current.stack) } : {}),
      };
    }
    if (typeof current !== "object") {
      return scrubString(String(current));
    }
    if (seen.has(current)) {
      return "[Circular]";
    }
    seen.add(current);

    try {
      if (Array.isArray(current)) {
        return current.map((item) => walk(item));
      }

      if (typeof Headers !== "undefined" && current instanceof Headers) {
        const headersObj: Record<string, string> = {};
        current.forEach((v, k) => {
          if (
            SECRET_KEY_REGEX.test(k) ||
            secretFields.has(k) ||
            secretFields.has(k.toLowerCase())
          ) {
            headersObj[k] = REDACTED_PLACEHOLDER;
          } else {
            headersObj[k] = scrubString(v);
          }
        });
        return headersObj;
      }

      const record = current as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(record)) {
        if (
          SECRET_KEY_REGEX.test(key) ||
          secretFields.has(key) ||
          secretFields.has(key.toLowerCase())
        ) {
          result[key] = REDACTED_PLACEHOLDER;
        } else {
          result[key] = walk(val);
        }
      }
      return result;
    } finally {
      seen.delete(current);
    }
  };

  return walk(value);
}

export function truncateTelemetryPreview(
  rawInput: unknown,
  options: RedactTelemetryOptions & {
    maxFieldBytes?: number;
    maxTotalBytes?: number;
  } = {},
): string {
  const maxFieldBytes = options.maxFieldBytes ?? MAX_FIELD_PREVIEW_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_PREVIEW_BYTES;

  const redacted = redactTelemetryPayload(rawInput ?? {}, options);
  const fullSerialized = JSON.stringify(redacted) ?? "{}";
  const originalBytes = utf8ByteLength(fullSerialized);

  let candidate: unknown = redacted;

  if (
    typeof redacted === "object" &&
    redacted !== null &&
    !Array.isArray(redacted)
  ) {
    const processedObj: Record<string, unknown> = {};
    for (const [key, fieldVal] of Object.entries(
      redacted as Record<string, unknown>,
    )) {
      const fieldText =
        typeof fieldVal === "string"
          ? fieldVal
          : (JSON.stringify(fieldVal) ?? "null");
      const fieldBytes = utf8ByteLength(fieldText);
      if (fieldBytes > maxFieldBytes) {
        const previewBudget = Math.max(256, maxFieldBytes - 160);
        processedObj[key] = {
          __truncated: true,
          originalBytes: fieldBytes,
          preview: sliceUtf8ByBytes(fieldText, previewBudget),
        };
      } else {
        processedObj[key] = fieldVal;
      }
    }
    candidate = processedObj;
  }

  const candidateJson = JSON.stringify(candidate) ?? "{}";
  const candidateBytes = utf8ByteLength(candidateJson);

  if (candidateBytes <= maxTotalBytes) {
    return candidateJson;
  }

  // Total serialized payload still exceeds 16,384 bytes: wrap in deterministic top-level truncation envelope
  let previewBudget = Math.max(128, maxTotalBytes - 200);
  for (;;) {
    const previewSlice = sliceUtf8ByBytes(fullSerialized, previewBudget);
    const envelope = {
      __truncated: true as const,
      originalBytes,
      preview: previewSlice,
    };
    const envelopeJson = JSON.stringify(envelope);
    const envelopeBytes = utf8ByteLength(envelopeJson);
    if (envelopeBytes <= maxTotalBytes || previewBudget <= 64) {
      return envelopeJson;
    }
    previewBudget = Math.max(
      64,
      previewBudget - (envelopeBytes - maxTotalBytes) - 32,
    );
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

export async function signTelemetryPayload(
  payloadText: string,
  secret: string,
): Promise<string> {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("PX_TELEMETRY_SECRET must be a non-empty string");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payloadText),
  );
  return `sha256=${bytesToHex(new Uint8Array(sigBuffer))}`;
}

export async function verifyTelemetrySignature(
  payloadText: string,
  signatureHeader: string | null | undefined,
  secret: string | null | undefined,
): Promise<boolean> {
  if (
    typeof secret !== "string" ||
    secret.length === 0 ||
    typeof signatureHeader !== "string" ||
    signatureHeader.trim().length === 0
  ) {
    return false;
  }
  const normalizedGiven = signatureHeader.trim().startsWith("sha256=")
    ? signatureHeader.trim().toLowerCase()
    : `sha256=${signatureHeader.trim().toLowerCase()}`;
  const expected = (await signTelemetryPayload(payloadText, secret)).toLowerCase();

  const a = encoder.encode(normalizedGiven);
  const b = encoder.encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

export function canonicalEventsCursorPayload(after: number, limit: number): string {
  return `GET:/__px/events?after=${after}&limit=${limit}`;
}

export function canonicalLogsQueryPayload(queryOrUrl: string | URL): string {
  if (typeof queryOrUrl === "string") {
    const trimmed = queryOrUrl.trim();
    if (trimmed.startsWith("GET:/__px/logs")) return trimmed;
    if (trimmed.startsWith("/__px/logs")) return `GET:${trimmed}`;
    if (trimmed.startsWith("?")) return `GET:/__px/logs${trimmed}`;
    return `GET:/__px/logs${trimmed ? `?${trimmed}` : ""}`;
  }
  return `GET:/__px/logs${queryOrUrl.search}`;
}

export function canonicalMetricsQueryPayload(queryOrUrl: string | URL): string {
  if (typeof queryOrUrl === "string") {
    const trimmed = queryOrUrl.trim();
    if (trimmed.startsWith("GET:/__px/metrics")) return trimmed;
    if (trimmed.startsWith("/__px/metrics")) return `GET:${trimmed}`;
    if (trimmed.startsWith("?")) return `GET:/__px/metrics${trimmed}`;
    return `GET:/__px/metrics${trimmed ? `?${trimmed}` : ""}`;
  }
  return `GET:/__px/metrics${queryOrUrl.search}`;
}

export async function ensureTelemetryTables(db: D1Like): Promise<void> {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS px_runs (
        run_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        trigger_type TEXT NOT NULL DEFAULT 'manual',
        workspace_id TEXT NOT NULL DEFAULT 'ws_default',
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
        duration_ms REAL NOT NULL DEFAULT 0,
        retries INTEGER NOT NULL DEFAULT 0,
        retry_of_run_id TEXT,
        error_stack TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
      )`,
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_px_runs_workflow_started ON px_runs(workflow_id, started_at DESC)",
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS px_step_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        node_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped')),
        duration_ms REAL NOT NULL DEFAULT 0,
        retries INTEGER NOT NULL DEFAULT 0,
        input_preview TEXT NOT NULL DEFAULT '{}',
        output_preview TEXT NOT NULL DEFAULT '{}',
        error_stack TEXT,
        created_at TEXT NOT NULL
      )`,
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_px_step_events_run_node ON px_step_events(run_id, node_id)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_px_step_events_workflow_created ON px_step_events(workflow_id, created_at DESC)",
    ),
    db.prepare(
      "CREATE VIEW IF NOT EXISTS px_steps AS SELECT * FROM px_step_events",
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS px_logs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        log_id TEXT NOT NULL UNIQUE,
        ts TEXT NOT NULL,
        level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
        message TEXT NOT NULL,
        run_id TEXT,
        workflow_id TEXT,
        revision INTEGER,
        node_id TEXT,
        brick_id TEXT,
        workspace_id TEXT,
        request_id TEXT,
        fields_json TEXT NOT NULL DEFAULT '{}',
        error_stack TEXT,
        env_name TEXT NOT NULL DEFAULT 'preview'
      )`,
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_px_logs_ts ON px_logs(ts DESC, seq DESC)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_px_logs_run_node ON px_logs(run_id, node_id)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_px_logs_workspace_brick ON px_logs(workspace_id, brick_id)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_px_logs_level_ts ON px_logs(level, ts DESC)",
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS px_http_rollups (
        bucket_minute TEXT NOT NULL,
        route_prefix TEXT NOT NULL DEFAULT '/',
        brick_id TEXT NOT NULL DEFAULT 'runtime',
        request_count INTEGER NOT NULL DEFAULT 0,
        error_4xx_count INTEGER NOT NULL DEFAULT 0,
        error_5xx_count INTEGER NOT NULL DEFAULT 0,
        latency_buckets_json TEXT NOT NULL DEFAULT '{}',
        p50_ms REAL NOT NULL DEFAULT 0,
        p95_ms REAL NOT NULL DEFAULT 0,
        p99_ms REAL NOT NULL DEFAULT 0,
        d1_query_count INTEGER NOT NULL DEFAULT 0,
        d1_latency_ms REAL NOT NULL DEFAULT 0,
        d1_error_count INTEGER NOT NULL DEFAULT 0,
        env_name TEXT NOT NULL DEFAULT 'preview',
        PRIMARY KEY (bucket_minute, route_prefix, brick_id, env_name)
      )`,
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_px_http_rollups_env_bucket ON px_http_rollups(env_name, bucket_minute DESC)",
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS px_queue_metrics (
        queue_name TEXT NOT NULL,
        pending_count INTEGER NOT NULL DEFAULT 0,
        dlq_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        env_name TEXT NOT NULL DEFAULT 'preview',
        PRIMARY KEY (queue_name, env_name)
      )`,
    ),
  ]);
}

export async function upsertRunRecord(db: D1Like, run: RunRecord): Promise<void> {
  const parsed = RunRecordSchema.parse(run);
  await db
    .prepare(
      `INSERT INTO px_runs (
        run_id, workflow_id, revision, trigger_type, workspace_id, status, duration_ms, retries, retry_of_run_id, error_stack, started_at, ended_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
      ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status,
        duration_ms = excluded.duration_ms,
        retries = excluded.retries,
        error_stack = excluded.error_stack,
        ended_at = excluded.ended_at`,
    )
    .bind(
      parsed.runId,
      parsed.workflowId,
      parsed.revision,
      parsed.triggerType,
      parsed.workspaceId,
      parsed.status,
      parsed.durationMs,
      parsed.retries,
      parsed.retryOfRunId ?? null,
      parsed.errorStack ?? null,
      parsed.startedAt,
      parsed.endedAt ?? null,
    )
    .run();
}

export interface InsertStepEventOptions {
  envName?: string;
  captureStepIoInProd?: boolean;
}

export async function insertStepEvent(
  db: D1Like,
  event: StepEvent,
  options: InsertStepEventOptions = {},
): Promise<StepEvent> {
  const suppressProdIo =
    options.captureStepIoInProd === false &&
    (options.envName ?? "production") === "production";
  const parsed = StepEventSchema.parse({
    ...event,
    ...(suppressProdIo ? { inputPreview: "{}", outputPreview: "{}" } : {}),
  });
  await db
    .prepare(
      `INSERT INTO px_step_events (
        event_id, run_id, workflow_id, revision, node_id, status, duration_ms, retries, input_preview, output_preview, error_stack, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
      ON CONFLICT(event_id) DO UPDATE SET
        status = excluded.status,
        duration_ms = excluded.duration_ms,
        retries = excluded.retries,
        input_preview = excluded.input_preview,
        output_preview = excluded.output_preview,
        error_stack = excluded.error_stack`,
    )
    .bind(
      parsed.eventId,
      parsed.runId,
      parsed.workflowId,
      parsed.revision,
      parsed.nodeId,
      parsed.status,
      parsed.durationMs,
      parsed.retries,
      parsed.inputPreview,
      parsed.outputPreview,
      parsed.errorStack ?? null,
      parsed.createdAt,
    )
    .run();

  const row = await db
    .prepare("SELECT seq FROM px_step_events WHERE event_id = ?1")
    .bind(parsed.eventId)
    .first<{ seq: number }>();

  return {
    ...parsed,
    ...(row && typeof row.seq === "number" ? { cursor: Number(row.seq) } : {}),
  };
}

interface D1RunRow {
  run_id: string;
  workflow_id: string;
  revision: number;
  trigger_type: string;
  workspace_id: string;
  status: RunStatus;
  duration_ms: number;
  retries: number;
  retry_of_run_id: string | null;
  error_stack: string | null;
  started_at: string;
  ended_at: string | null;
}

interface D1StepEventRow {
  seq: number;
  event_id: string;
  run_id: string;
  workflow_id: string;
  revision: number;
  node_id: string;
  status: StepStatus;
  duration_ms: number;
  retries: number;
  input_preview: string;
  output_preview: string;
  error_stack: string | null;
  created_at: string;
}

function mapRunRow(row: D1RunRow): RunRecord {
  return {
    runId: row.run_id,
    workflowId: row.workflow_id,
    revision: Number(row.revision),
    triggerType: row.trigger_type,
    workspaceId: row.workspace_id,
    status: row.status,
    durationMs: Number(row.duration_ms),
    retries: Number(row.retries ?? 0),
    retryOfRunId: row.retry_of_run_id,
    errorStack: row.error_stack,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function mapStepEventRow(row: D1StepEventRow): StepEvent {
  let fromPinned: boolean | undefined;
  let reused: boolean | undefined;
  if (row.input_preview.includes('"fromPinned":true')) {
    fromPinned = true;
  }
  if (row.input_preview.includes('"reused":true')) {
    reused = true;
  }
  return {
    eventId: row.event_id,
    runId: row.run_id,
    workflowId: row.workflow_id,
    revision: Number(row.revision),
    nodeId: row.node_id,
    status: row.status,
    durationMs: Number(row.duration_ms),
    retries: Number(row.retries),
    inputPreview: row.input_preview,
    outputPreview: row.output_preview,
    errorStack: row.error_stack,
    createdAt: row.created_at,
    cursor: Number(row.seq),
    ...(fromPinned ? { fromPinned: true } : {}),
    ...(reused ? { reused: true } : {}),
  };
}

export async function getRunRecord(
  db: D1Like,
  runId: string,
): Promise<RunRecord | null> {
  const row = await db
    .prepare("SELECT * FROM px_runs WHERE run_id = ?1")
    .bind(runId)
    .first<D1RunRow>();
  return row ? mapRunRow(row) : null;
}

export async function listRunRecords(
  db: D1Like,
  options: { workflowId?: string; limit?: number } = {},
): Promise<RunRecord[]> {
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  const res = options.workflowId
    ? await db
        .prepare(
          "SELECT * FROM px_runs WHERE workflow_id = ?1 ORDER BY started_at DESC LIMIT ?2",
        )
        .bind(options.workflowId, limit)
        .all<D1RunRow>()
    : await db
        .prepare("SELECT * FROM px_runs ORDER BY started_at DESC LIMIT ?1")
        .bind(limit)
        .all<D1RunRow>();
  return (res.results ?? []).map(mapRunRow);
}

export async function listStepEventsForRun(
  db: D1Like,
  runId: string,
): Promise<StepEvent[]> {
  const res = await db
    .prepare("SELECT * FROM px_step_events WHERE run_id = ?1 ORDER BY seq ASC")
    .bind(runId)
    .all<D1StepEventRow>();
  return (res.results ?? []).map(mapStepEventRow);
}

export async function listStepEventsAfterCursor(
  db: D1Like,
  afterCursor = 0,
  limit = 100,
): Promise<{ events: StepEvent[]; nextCursor: number; hasMore: boolean }> {
  const clampedLimit = Math.max(1, Math.min(500, limit));
  const res = await db
    .prepare(
      "SELECT * FROM px_step_events WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2",
    )
    .bind(afterCursor, clampedLimit + 1)
    .all<D1StepEventRow>();
  const rows = res.results ?? [];
  const hasMore = rows.length > clampedLimit;
  const page = rows.slice(0, clampedLimit).map(mapStepEventRow);
  const nextCursor =
    page.length > 0 ? (page[page.length - 1]!.cursor ?? afterCursor) : afterCursor;
  return {
    events: page,
    nextCursor,
    hasMore,
  };
}

export async function handleTelemetryEventsPullRequest(
  request: Request,
  options: {
    db: D1Like;
    telemetrySecret: string | undefined;
  },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/__px/events") return null;
  if (request.method !== "GET") {
    return Response.json(
      { error: { code: "METHOD_NOT_ALLOWED", message: "Expected GET /__px/events" } },
      { status: 405 },
    );
  }

  const afterRaw = url.searchParams.get("after") ?? "0";
  const limitRaw = url.searchParams.get("limit") ?? "100";
  const after = Number(afterRaw);
  const limit = Number(limitRaw);
  if (
    !Number.isInteger(after) ||
    after < 0 ||
    !Number.isInteger(limit) ||
    limit < 1
  ) {
    return Response.json(
      {
        error: {
          code: "INVALID_CURSOR_PARAMS",
          message: "after must be >= 0 and limit must be >= 1",
        },
      },
      { status: 400 },
    );
  }

  const signature = request.headers.get(TELEMETRY_SIGNATURE_HEADER);
  const canonical = canonicalEventsCursorPayload(after, limit);
  const pathAndQuery = `${url.pathname}${url.search}`;
  const validCanonical = await verifyTelemetrySignature(
    canonical,
    signature,
    options.telemetrySecret,
  );
  const validPathQuery =
    validCanonical ||
    (await verifyTelemetrySignature(
      pathAndQuery,
      signature,
      options.telemetrySecret,
    ));

  if (!validPathQuery) {
    return Response.json(
      {
        error: {
          code: "UNAUTHORIZED_TELEMETRY_SIGNATURE",
          message: "Missing or invalid X-Px-Signature",
        },
      },
      { status: 401 },
    );
  }

  await ensureTelemetryTables(options.db);
  const page = await listStepEventsAfterCursor(options.db, after, limit);
  const runs = await listRunRecords(options.db, { limit: 50 });

  return Response.json(
    {
      ok: true,
      after,
      limit,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      events: page.events,
      runs,
    },
    { status: 200 },
  );
}

export const DEFAULT_RUN_RETENTION_DAYS = 14;
export const MIN_RUN_RETENTION_DAYS = 7;
export const MAX_RUN_RETENTION_DAYS = 90;
export const DEFAULT_TELEMETRY_RETENTION_DAYS = 7;
export const MIN_TELEMETRY_RETENTION_DAYS = 1;
export const MAX_TELEMETRY_RETENTION_DAYS = 30;

export function resolveRunRetentionDays(
  raw?: number | string | null,
): number {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_RUN_RETENTION_DAYS;
  }
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_RUN_RETENTION_DAYS;
  }
  return Math.min(
    MAX_RUN_RETENTION_DAYS,
    Math.max(MIN_RUN_RETENTION_DAYS, Math.floor(parsed)),
  );
}

export function resolveConfigurableRunRetentionDays(
  raw?: number | string | null,
): number {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_RUN_RETENTION_DAYS;
  }
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_RUN_RETENTION_DAYS;
  }
  return Math.min(MAX_RUN_RETENTION_DAYS, Math.max(1, Math.floor(parsed)));
}

export function resolveTelemetryRetentionDays(
  raw?: number | string | null,
): number {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_TELEMETRY_RETENTION_DAYS;
  }
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TELEMETRY_RETENTION_DAYS;
  }
  return Math.min(
    MAX_TELEMETRY_RETENTION_DAYS,
    Math.max(MIN_TELEMETRY_RETENTION_DAYS, Math.floor(parsed)),
  );
}

export interface PruneTelemetryOptions {
  retentionDays?: number | string | null;
  runRetentionDays?: number | string | null;
  telemetryRetentionDays?: number | string | null;
  now?: Date | string | number;
}

export interface PruneTelemetryResult {
  deletedRuns: number;
  deletedStepEvents: number;
  deletedLogs?: number;
  deletedHttpRollups?: number;
  cutoffIso: string;
  telemetryCutoffIso?: string;
  retentionDays: number;
  runRetentionDays?: number;
  telemetryRetentionDays?: number;
}

export async function pruneExpiredTelemetryRuns(
  db: D1Like,
  options: PruneTelemetryOptions = {},
): Promise<PruneTelemetryResult> {
  await ensureTelemetryTables(db);
  const hasExplicitRunRetention =
    options.runRetentionDays !== undefined &&
    options.runRetentionDays !== null &&
    options.runRetentionDays !== "";
  const hasExplicitTelemetryRetention =
    options.telemetryRetentionDays !== undefined &&
    options.telemetryRetentionDays !== null &&
    options.telemetryRetentionDays !== "";
  const hasLegacyRetention =
    options.retentionDays !== undefined &&
    options.retentionDays !== null &&
    options.retentionDays !== "";

  const runRetentionDays = hasExplicitRunRetention
    ? resolveConfigurableRunRetentionDays(options.runRetentionDays)
    : resolveRunRetentionDays(options.retentionDays);

  const telemetryRetentionDays = hasExplicitTelemetryRetention
    ? resolveTelemetryRetentionDays(options.telemetryRetentionDays)
    : hasLegacyRetention
      ? resolveRunRetentionDays(options.retentionDays)
      : DEFAULT_TELEMETRY_RETENTION_DAYS;

  const nowMs =
    options.now instanceof Date
      ? options.now.getTime()
      : typeof options.now === "number"
        ? options.now
        : typeof options.now === "string"
          ? Date.parse(options.now)
          : Date.now();
  const effectiveNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const cutoffIso = new Date(
    effectiveNowMs - runRetentionDays * 86_400_000,
  ).toISOString();
  const telemetryCutoffIso = new Date(
    effectiveNowMs - telemetryRetentionDays * 86_400_000,
  ).toISOString();

  const expiredEventsCountRow = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM px_step_events
       WHERE created_at < ?1
          OR run_id IN (SELECT run_id FROM px_runs WHERE started_at < ?1)`,
    )
    .bind(cutoffIso)
    .first<{ cnt: number }>();

  const expiredLogsCountRow = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM px_logs
       WHERE ts < ?1
          OR (run_id IS NOT NULL AND run_id IN (SELECT run_id FROM px_runs WHERE started_at < ?2))`,
    )
    .bind(telemetryCutoffIso, cutoffIso)
    .first<{ cnt: number }>();

  const expiredRollupsCountRow = await db
    .prepare("SELECT COUNT(*) AS cnt FROM px_http_rollups WHERE bucket_minute < ?1")
    .bind(telemetryCutoffIso)
    .first<{ cnt: number }>();

  const expiredRunsCountRow = await db
    .prepare("SELECT COUNT(*) AS cnt FROM px_runs WHERE started_at < ?1")
    .bind(cutoffIso)
    .first<{ cnt: number }>();

  const deletedStepEvents = Number(expiredEventsCountRow?.cnt ?? 0);
  const deletedLogs = Number(expiredLogsCountRow?.cnt ?? 0);
  const deletedHttpRollups = Number(expiredRollupsCountRow?.cnt ?? 0);
  const deletedRuns = Number(expiredRunsCountRow?.cnt ?? 0);

  if (deletedStepEvents > 0) {
    await db
      .prepare(
        `DELETE FROM px_step_events
         WHERE created_at < ?1
            OR run_id IN (SELECT run_id FROM px_runs WHERE started_at < ?1)`,
      )
      .bind(cutoffIso)
      .run();
  }

  if (deletedLogs > 0) {
    await db
      .prepare(
        `DELETE FROM px_logs
         WHERE ts < ?1
            OR (run_id IS NOT NULL AND run_id IN (SELECT run_id FROM px_runs WHERE started_at < ?2))`,
      )
      .bind(telemetryCutoffIso, cutoffIso)
      .run();
  }

  if (deletedHttpRollups > 0) {
    await db
      .prepare("DELETE FROM px_http_rollups WHERE bucket_minute < ?1")
      .bind(telemetryCutoffIso)
      .run();
  }

  if (deletedRuns > 0) {
    await db
      .prepare("DELETE FROM px_runs WHERE started_at < ?1")
      .bind(cutoffIso)
      .run();
  }

  return {
    deletedRuns,
    deletedStepEvents,
    deletedLogs,
    deletedHttpRollups,
    cutoffIso,
    telemetryCutoffIso,
    retentionDays: runRetentionDays,
    runRetentionDays,
    telemetryRetentionDays,
  };
}

export async function runScheduledTelemetryRetentionPrune(
  controller: { scheduledTime?: number; cron?: string } | undefined,
  env: {
    DB: D1Like;
    PX_RUN_RETENTION_DAYS?: number | string;
    PX_TELEMETRY_RETENTION_DAYS?: number | string;
    [key: string]: unknown;
  },
  options: PruneTelemetryOptions = {},
): Promise<PruneTelemetryResult> {
  return pruneExpiredTelemetryRuns(env.DB, {
    retentionDays: options.retentionDays ?? env.PX_RUN_RETENTION_DAYS,
    runRetentionDays: options.runRetentionDays,
    telemetryRetentionDays:
      options.telemetryRetentionDays ?? env.PX_TELEMETRY_RETENTION_DAYS,
    now: options.now ?? controller?.scheduledTime ?? Date.now(),
  });
}

export interface RunHistoryQueryFilters {
  workflowId?: string;
  status?: string;
  trigger?: string;
  from?: string;
  to?: string;
  cursor?: string | number;
  limit?: number;
}

export interface RunHistorySummary extends RunRecord {
  failedNodeId: string | null;
  stepCount: number;
  resolvedByRunId?: string | null;
}

export interface RunHistoryQueryPage {
  runs: RunHistorySummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

export async function findResolvingRetryRunId(
  db: D1Like,
  runId: string,
): Promise<string | null> {
  await ensureTelemetryTables(db);
  const resolvedRow = await db
    .prepare(
      "SELECT run_id FROM px_runs WHERE retry_of_run_id = ?1 AND status = 'succeeded' ORDER BY started_at DESC LIMIT 1",
    )
    .bind(runId)
    .first<{ run_id: string }>();
  return resolvedRow?.run_id ?? null;
}

export async function queryRunHistory(
  db: D1Like,
  filters: RunHistoryQueryFilters = {},
): Promise<RunHistoryQueryPage> {
  await ensureTelemetryTables(db);
  const limit = Math.max(1, Math.min(200, filters.limit ?? 50));
  const offsetRaw =
    filters.cursor !== undefined && filters.cursor !== null && filters.cursor !== ""
      ? Number(filters.cursor)
      : 0;
  const offset =
    Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

  const whereClauses: string[] = [];
  const bindArgs: unknown[] = [];

  if (filters.workflowId && filters.workflowId.trim() && filters.workflowId !== "all") {
    whereClauses.push("workflow_id = ?");
    bindArgs.push(filters.workflowId.trim());
  }
  if (filters.status && filters.status.trim() && filters.status !== "all") {
    whereClauses.push("status = ?");
    bindArgs.push(filters.status.trim());
  }
  if (filters.trigger && filters.trigger.trim() && filters.trigger !== "all") {
    whereClauses.push("trigger_type = ?");
    bindArgs.push(filters.trigger.trim());
  }
  if (filters.from && filters.from.trim()) {
    whereClauses.push("started_at >= ?");
    bindArgs.push(filters.from.trim());
  }
  if (filters.to && filters.to.trim()) {
    whereClauses.push("started_at <= ?");
    bindArgs.push(filters.to.trim());
  }

  const whereSql =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const sql = `SELECT * FROM px_runs ${whereSql} ORDER BY started_at DESC, run_id DESC LIMIT ? OFFSET ?`;
  const res = await db
    .prepare(sql)
    .bind(...bindArgs, limit + 1, offset)
    .all<D1RunRow>();

  const rows = res.results ?? [];
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit).map(mapRunRow);

  const enriched: RunHistorySummary[] = [];
  for (const run of pageRows) {
    const failedEvent = await db
      .prepare(
        "SELECT node_id FROM px_step_events WHERE run_id = ?1 AND status = 'failed' ORDER BY seq ASC LIMIT 1",
      )
      .bind(run.runId)
      .first<{ node_id: string }>();

    const stepCountRow = await db
      .prepare(
        "SELECT COUNT(DISTINCT node_id) AS cnt FROM px_step_events WHERE run_id = ?1",
      )
      .bind(run.runId)
      .first<{ cnt: number }>();

    const resolvedByRunId =
      run.status === "failed"
        ? await findResolvingRetryRunId(db, run.runId)
        : null;

    enriched.push({
      ...run,
      failedNodeId: failedEvent?.node_id ?? null,
      stepCount: Number(stepCountRow?.cnt ?? 0),
      resolvedByRunId,
    });
  }

  return {
    runs: enriched,
    nextCursor: hasMore ? String(offset + limit) : null,
    hasMore,
  };
}

export function isTelemetryPreviewTruncated(previewText: string): {
  truncated: boolean;
  originalBytes?: number;
} {
  if (!previewText || typeof previewText !== "string") {
    return { truncated: false };
  }
  if (previewText.includes('"__truncated":true')) {
    try {
      const parsed = JSON.parse(previewText) as Record<string, unknown>;
      if (parsed && parsed.__truncated === true) {
        return {
          truncated: true,
          ...(typeof parsed.originalBytes === "number"
            ? { originalBytes: parsed.originalBytes }
            : {}),
        };
      }
      for (const val of Object.values(parsed)) {
        if (
          typeof val === "object" &&
          val !== null &&
          (val as Record<string, unknown>).__truncated === true
        ) {
          const orig = (val as Record<string, unknown>).originalBytes;
          return {
            truncated: true,
            ...(typeof orig === "number" ? { originalBytes: orig } : {}),
          };
        }
      }
    } catch {
      return { truncated: true };
    }
    return { truncated: true };
  }
  return { truncated: false };
}

export interface RawStructuredLogInput {
  logId?: string;
  ts?: string;
  level: LogLevel;
  message: string;
  runId?: string | null;
  workflowId?: string | null;
  revision?: number | null;
  nodeId?: string | null;
  brickId?: string | null;
  workspaceId?: string | null;
  requestId?: string | null;
  fields?: Record<string, unknown>;
  fieldsJson?: string;
  errorStack?: string | null;
  envName?: string;
}

let logIdCounter = 0;

function nextLogId(): string {
  logIdCounter += 1;
  return `log_${Date.now()}_${logIdCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

function extractRawErrorStack(
  rawFields: Record<string, unknown>,
  explicitStack?: string | null,
): string | null {
  if (typeof explicitStack === "string" && explicitStack.trim().length > 0) {
    return explicitStack;
  }
  if (typeof rawFields.errorStack === "string" && rawFields.errorStack.trim().length > 0) {
    return rawFields.errorStack;
  }
  if (rawFields.error instanceof Error) {
    return rawFields.error.stack ?? `${rawFields.error.name}: ${rawFields.error.message}`;
  }
  if (
    typeof rawFields.error === "object" &&
    rawFields.error !== null &&
    typeof (rawFields.error as { stack?: unknown }).stack === "string"
  ) {
    return (rawFields.error as { stack: string }).stack;
  }
  return null;
}

export function redactStructuredLogEntry(
  input: RawStructuredLogInput,
  options: RedactTelemetryOptions = {},
): StructuredLogEntry {
  const rawFields: Record<string, unknown> =
    input.fields && typeof input.fields === "object" && !Array.isArray(input.fields)
      ? { ...input.fields }
      : input.fieldsJson
        ? (() => {
            try {
              const parsed = JSON.parse(input.fieldsJson);
              return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : {};
            } catch {
              return {};
            }
          })()
        : {};

  const combinedSecrets = new Set<string>();
  if (options.secretValues) {
    for (const s of options.secretValues) {
      if (typeof s === "string") {
        addSecretCandidateString(s, combinedSecrets);
      }
    }
  }
  const mergedSecretFields = mergeSecretFieldNames(
    options.secretFieldNames,
    options.additionalRedactKeys,
  );
  collectSecretKeyedValues(rawFields, combinedSecrets, mergedSecretFields);

  const redactOpts: RedactTelemetryOptions = {
    secretValues: combinedSecrets,
    secretFieldNames: mergedSecretFields,
    additionalRedactKeys: options.additionalRedactKeys,
    valuePatterns: options.valuePatterns,
  };

  const rawErrorStack = extractRawErrorStack(rawFields, input.errorStack);
  const cleanedFieldsInput = { ...rawFields };
  delete cleanedFieldsInput.errorStack;

  const redactedFieldsObj = redactTelemetryPayload(cleanedFieldsInput, redactOpts);
  const redactedFields: Record<string, unknown> =
    typeof redactedFieldsObj === "object" &&
    redactedFieldsObj !== null &&
    !Array.isArray(redactedFieldsObj)
      ? (redactedFieldsObj as Record<string, unknown>)
      : {};

  const redactedMessage = redactTelemetryString(String(input.message ?? ""), redactOpts);
  const redactedErrorStack = rawErrorStack
    ? redactTelemetryString(rawErrorStack, redactOpts)
    : null;
  const fieldsJson = truncateTelemetryPreview(redactedFields, redactOpts);

  const runId =
    input.runId ??
    (typeof rawFields.runId === "string" ? rawFields.runId : null);
  const workflowId =
    input.workflowId ??
    (typeof rawFields.workflowId === "string" ? rawFields.workflowId : null);
  const revision =
    typeof input.revision === "number"
      ? input.revision
      : typeof rawFields.revision === "number"
        ? rawFields.revision
        : null;
  const nodeId =
    input.nodeId ??
    (typeof rawFields.nodeId === "string" ? rawFields.nodeId : null);
  const brickId =
    input.brickId ??
    (typeof rawFields.brickId === "string" ? rawFields.brickId : null);
  const workspaceId =
    input.workspaceId ??
    (typeof rawFields.workspaceId === "string" ? rawFields.workspaceId : null);
  const requestId =
    input.requestId ??
    (typeof rawFields.requestId === "string" ? rawFields.requestId : null);

  return StructuredLogEntrySchema.parse({
    logId: input.logId && input.logId.trim() ? input.logId.trim() : nextLogId(),
    ts: input.ts && input.ts.trim() ? input.ts.trim() : new Date().toISOString(),
    level: LogLevelSchema.parse(input.level),
    message: redactedMessage,
    runId: runId && runId.trim() ? runId.trim() : null,
    workflowId: workflowId && workflowId.trim() ? workflowId.trim() : null,
    revision,
    nodeId: nodeId && nodeId.trim() ? nodeId.trim() : null,
    brickId: brickId && brickId.trim() ? brickId.trim() : null,
    workspaceId: workspaceId && workspaceId.trim() ? workspaceId.trim() : null,
    requestId: requestId && requestId.trim() ? requestId.trim() : null,
    fields: redactedFields,
    fieldsJson,
    errorStack: redactedErrorStack,
    envName: input.envName && input.envName.trim() ? input.envName.trim() : "preview",
  });
}

interface D1LogRow {
  seq: number;
  log_id: string;
  ts: string;
  level: LogLevel;
  message: string;
  run_id: string | null;
  workflow_id: string | null;
  revision: number | null;
  node_id: string | null;
  brick_id: string | null;
  workspace_id: string | null;
  request_id: string | null;
  fields_json: string;
  error_stack: string | null;
  env_name?: string | null;
}

function mapLogRow(row: D1LogRow): StructuredLogEntry {
  let parsedFields: Record<string, unknown> = {};
  if (typeof row.fields_json === "string" && row.fields_json.trim().length > 0) {
    try {
      const candidate = JSON.parse(row.fields_json);
      if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
        parsedFields = candidate as Record<string, unknown>;
      }
    } catch {
      parsedFields = {};
    }
  }
  return {
    seq: Number(row.seq),
    logId: row.log_id,
    ts: row.ts,
    level: row.level,
    message: row.message,
    runId: row.run_id ?? null,
    workflowId: row.workflow_id ?? null,
    revision: row.revision !== null && row.revision !== undefined ? Number(row.revision) : null,
    nodeId: row.node_id ?? null,
    brickId: row.brick_id ?? null,
    workspaceId: row.workspace_id ?? null,
    requestId: row.request_id ?? null,
    fields: parsedFields,
    fieldsJson: row.fields_json ?? "{}",
    errorStack: row.error_stack ?? null,
    envName: row.env_name ?? "preview",
  };
}

export async function insertStructuredLog(
  db: D1Like,
  input: RawStructuredLogInput,
  redactOptions: RedactTelemetryOptions = {},
): Promise<StructuredLogEntry> {
  await ensureTelemetryTables(db);
  const redacted = redactStructuredLogEntry(input, redactOptions);

  await db
    .prepare(
      `INSERT INTO px_logs (
        log_id, ts, level, message, run_id, workflow_id, revision, node_id, brick_id, workspace_id, request_id, fields_json, error_stack, env_name
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
      ON CONFLICT(log_id) DO UPDATE SET
        level = excluded.level,
        message = excluded.message,
        run_id = excluded.run_id,
        workflow_id = excluded.workflow_id,
        revision = excluded.revision,
        node_id = excluded.node_id,
        brick_id = excluded.brick_id,
        workspace_id = excluded.workspace_id,
        request_id = excluded.request_id,
        fields_json = excluded.fields_json,
        error_stack = excluded.error_stack,
        env_name = excluded.env_name`,
    )
    .bind(
      redacted.logId,
      redacted.ts,
      redacted.level,
      redacted.message,
      redacted.runId ?? null,
      redacted.workflowId ?? null,
      redacted.revision ?? null,
      redacted.nodeId ?? null,
      redacted.brickId ?? null,
      redacted.workspaceId ?? null,
      redacted.requestId ?? null,
      redacted.fieldsJson,
      redacted.errorStack ?? null,
      redacted.envName ?? "preview",
    )
    .run();

  const row = await db
    .prepare("SELECT * FROM px_logs WHERE log_id = ?1")
    .bind(redacted.logId)
    .first<D1LogRow>();

  return row ? mapLogRow(row) : redacted;
}

export interface StructuredLogQueryFilters {
  env?: string;
  level?: string;
  workspaceId?: string;
  brickId?: string;
  workflowId?: string;
  runId?: string;
  nodeId?: string;
  requestId?: string;
  q?: string;
  after?: number;
  limit?: number;
}

export interface StructuredLogQueryPage {
  logs: StructuredLogEntry[];
  after: number;
  limit: number;
  nextCursor: number;
  hasMore: boolean;
}

export async function queryStructuredLogs(
  db: D1Like,
  filters: StructuredLogQueryFilters = {},
): Promise<StructuredLogQueryPage> {
  await ensureTelemetryTables(db);
  const limit = Math.max(1, Math.min(500, filters.limit ?? 100));
  const afterRaw = filters.after !== undefined && filters.after !== null ? Number(filters.after) : 0;
  const after = Number.isInteger(afterRaw) && afterRaw >= 0 ? afterRaw : 0;

  const whereClauses: string[] = [];
  const bindArgs: unknown[] = [];

  if (after > 0) {
    whereClauses.push("seq > ?");
    bindArgs.push(after);
  }
  if (filters.env && filters.env.trim() && filters.env !== "all") {
    whereClauses.push("env_name = ?");
    bindArgs.push(filters.env.trim());
  }
  if (filters.level && filters.level.trim() && filters.level !== "all") {
    const levels = filters.level
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s === "debug" || s === "info" || s === "warn" || s === "error");
    if (levels.length === 1) {
      whereClauses.push("level = ?");
      bindArgs.push(levels[0]!);
    } else if (levels.length > 1) {
      whereClauses.push(`level IN (${levels.map(() => "?").join(", ")})`);
      bindArgs.push(...levels);
    }
  }
  if (filters.workspaceId && filters.workspaceId.trim() && filters.workspaceId !== "all") {
    whereClauses.push("workspace_id = ?");
    bindArgs.push(filters.workspaceId.trim());
  }
  if (filters.brickId && filters.brickId.trim() && filters.brickId !== "all") {
    whereClauses.push("brick_id = ?");
    bindArgs.push(filters.brickId.trim());
  }
  if (filters.workflowId && filters.workflowId.trim() && filters.workflowId !== "all") {
    whereClauses.push("workflow_id = ?");
    bindArgs.push(filters.workflowId.trim());
  }
  if (filters.runId && filters.runId.trim() && filters.runId !== "all") {
    whereClauses.push("run_id = ?");
    bindArgs.push(filters.runId.trim());
  }
  if (filters.nodeId && filters.nodeId.trim() && filters.nodeId !== "all") {
    whereClauses.push("node_id = ?");
    bindArgs.push(filters.nodeId.trim());
  }
  if (filters.requestId && filters.requestId.trim() && filters.requestId !== "all") {
    whereClauses.push("request_id = ?");
    bindArgs.push(filters.requestId.trim());
  }
  if (filters.q && filters.q.trim()) {
    const qLike = `%${filters.q.trim().toLowerCase()}%`;
    whereClauses.push(
      `(LOWER(message) LIKE ? OR LOWER(fields_json) LIKE ? OR LOWER(COALESCE(error_stack, '')) LIKE ? OR LOWER(COALESCE(run_id, '')) LIKE ? OR LOWER(COALESCE(node_id, '')) LIKE ? OR LOWER(COALESCE(brick_id, '')) LIKE ? OR LOWER(COALESCE(workspace_id, '')) LIKE ?)`,
    );
    bindArgs.push(qLike, qLike, qLike, qLike, qLike, qLike, qLike);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
  const orderBySql = after > 0 ? "ORDER BY seq ASC" : "ORDER BY seq DESC";
  const sql = `SELECT * FROM px_logs ${whereSql} ${orderBySql} LIMIT ?`;

  const res = await db
    .prepare(sql)
    .bind(...bindArgs, limit + 1)
    .all<D1LogRow>();

  const rows = res.results ?? [];
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit).map(mapLogRow);

  let nextCursor = after;
  for (const row of pageRows) {
    if (typeof row.seq === "number" && row.seq > nextCursor) {
      nextCursor = row.seq;
    }
  }

  return {
    logs: pageRows,
    after,
    limit,
    nextCursor,
    hasMore,
  };
}

export interface CreateStructuredLoggerOptions {
  db?: D1Like;
  context?: StructuredLogContext & { envName?: string };
  redactOptions?: RedactTelemetryOptions;
  onLog?: (entry: StructuredLogEntry) => void | Promise<void>;
}

export interface BoundStructuredLogger extends StructuredLogger {
  readonly context: StructuredLogContext & { envName?: string };
  withContext(extra: Partial<StructuredLogContext & { envName?: string }>): BoundStructuredLogger;
  flush(): Promise<StructuredLogEntry[]>;
  getEntries(): StructuredLogEntry[];
}

export function createStructuredLogger(
  options: CreateStructuredLoggerOptions = {},
): BoundStructuredLogger {
  const entries: StructuredLogEntry[] = [];
  const pending: Promise<StructuredLogEntry>[] = [];

  const buildLogger = (
    ctx: StructuredLogContext & { envName?: string },
  ): BoundStructuredLogger => {
    const emit = (
      level: StructuredLogLevel,
      message: string,
      fields?: Record<string, unknown> & { errorStack?: string | null; error?: unknown },
    ): Promise<StructuredLogEntry> => {
      const task = (async () => {
        const rawInput: RawStructuredLogInput = {
          level,
          message,
          runId:
            ctx.runId ??
            (typeof fields?.runId === "string" ? fields.runId : null),
          workflowId:
            ctx.workflowId ??
            (typeof fields?.workflowId === "string" ? fields.workflowId : null),
          revision:
            ctx.revision ??
            (typeof fields?.revision === "number" ? fields.revision : null),
          nodeId:
            ctx.nodeId ??
            (typeof fields?.nodeId === "string" ? fields.nodeId : null),
          brickId:
            ctx.brickId ??
            (typeof fields?.brickId === "string" ? fields.brickId : null),
          workspaceId:
            (ctx.workspaceId && ctx.workspaceId !== "ws_default"
              ? ctx.workspaceId
              : typeof fields?.workspaceId === "string"
                ? fields.workspaceId
                : ctx.workspaceId) ?? null,
          requestId:
            ctx.requestId ??
            (typeof fields?.requestId === "string" ? fields.requestId : null),
          fields: fields ?? {},
          errorStack:
            typeof fields?.errorStack === "string" ? fields.errorStack : null,
          envName: ctx.envName ?? "preview",
        };

        const persisted = options.db
          ? await insertStructuredLog(options.db, rawInput, options.redactOptions)
          : redactStructuredLogEntry(rawInput, options.redactOptions);

        entries.push(persisted);
        if (options.onLog) {
          await options.onLog(persisted);
        }
        return persisted;
      })();

      pending.push(task);
      return task;
    };

    return {
      context: { ...ctx },
      debug: (message, fields) => emit("debug", message, fields),
      info: (message, fields) => emit("info", message, fields),
      warn: (message, fields) => emit("warn", message, fields),
      error: (message, fields) => emit("error", message, fields),
      withContext: (extra) => buildLogger({ ...ctx, ...extra }),
      flush: async () => {
        if (pending.length > 0) {
          await Promise.allSettled(pending.splice(0, pending.length));
        }
        return [...entries];
      },
      getEntries: () => [...entries],
    };
  };

  return buildLogger(options.context ?? {});
}

export async function handleTelemetryLogsPullRequest(
  request: Request,
  options: {
    db: D1Like;
    telemetrySecret: string | undefined;
    pxEnv?: string;
  },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/__px/logs") return null;
  if (request.method !== "GET") {
    return Response.json(
      { error: { code: "METHOD_NOT_ALLOWED", message: "Expected GET /__px/logs" } },
      { status: 405 },
    );
  }

  const afterRaw = url.searchParams.get("after") ?? "0";
  const limitRaw = url.searchParams.get("limit") ?? "100";
  const after = Number(afterRaw);
  const limit = Number(limitRaw);
  if (
    !Number.isInteger(after) ||
    after < 0 ||
    !Number.isInteger(limit) ||
    limit < 1
  ) {
    return Response.json(
      {
        error: {
          code: "INVALID_CURSOR_PARAMS",
          message: "after must be >= 0 and limit must be >= 1",
        },
      },
      { status: 400 },
    );
  }

  const signature = request.headers.get(TELEMETRY_SIGNATURE_HEADER);
  const canonical = canonicalLogsQueryPayload(url);
  const pathAndQuery = `${url.pathname}${url.search}`;
  const cursorFallback = `GET:/__px/logs?after=${after}&limit=${limit}`;

  const validSig =
    (await verifyTelemetrySignature(canonical, signature, options.telemetrySecret)) ||
    (await verifyTelemetrySignature(pathAndQuery, signature, options.telemetrySecret)) ||
    (await verifyTelemetrySignature(cursorFallback, signature, options.telemetrySecret));

  if (!validSig) {
    return Response.json(
      {
        error: {
          code: "UNAUTHORIZED_TELEMETRY_SIGNATURE",
          message: "Missing or invalid X-Px-Signature",
        },
      },
      { status: 401 },
    );
  }

  const envParam = url.searchParams.get("env") ?? undefined;
  const page = await queryStructuredLogs(options.db, {
    ...(envParam ? { env: envParam } : {}),
    level: url.searchParams.get("level") ?? undefined,
    workspaceId: url.searchParams.get("workspaceId") ?? undefined,
    brickId: url.searchParams.get("brickId") ?? undefined,
    workflowId: url.searchParams.get("workflowId") ?? undefined,
    runId: url.searchParams.get("runId") ?? undefined,
    nodeId: url.searchParams.get("nodeId") ?? undefined,
    requestId: url.searchParams.get("requestId") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    after,
    limit,
  });

  return Response.json(
    {
      ok: true,
      env: envParam ?? options.pxEnv ?? "preview",
      after: page.after,
      limit: page.limit,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      logs: page.logs,
    },
    { status: 200 },
  );
}

export const HealthWindowSchema = z.enum(["1h", "24h", "7d"]);
export type HealthWindow = z.infer<typeof HealthWindowSchema>;

export interface HttpRollupInput {
  bucketMinute: string;
  routePrefix?: string;
  brickId?: string;
  requestCount: number;
  error4xxCount?: number;
  error5xxCount?: number;
  latencyBucketsJson?: string;
  latencySamplesMs?: number[];
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
  d1QueryCount?: number;
  d1LatencyMs?: number;
  d1ErrorCount?: number;
  d1SamplesMs?: number[];
  envName?: string;
}

export interface HttpRequestSampleInput {
  ts?: string | number | Date;
  routePrefix: string;
  brickId: string;
  status: number;
  latencyMs: number;
  d1Queries?: number;
  d1LatencyMs?: number;
  d1Errors?: number;
  envName?: string;
}

export interface QueueMetricInput {
  queueName: string;
  pendingCount?: number;
  depth?: number;
  dlqCount?: number;
  updatedAt?: string;
  envName?: string;
}

export interface BrickHealthMetric {
  brickId: string;
  routePrefix: string;
  requestCount: number;
  error4xxCount: number;
  error5xxCount: number;
  errorRatePercent: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface QueueHealthMetric {
  queueName: string;
  depth: number;
  dlqCount: number;
  updatedAt: string;
}

export interface TopFailingWorkflowMetric {
  workflowId: string;
  failedCount: number;
  lastFailedRunId: string | null;
}

export interface HealthTimeSeriesBucket {
  bucketTs: string;
  requestCount: number;
  error5xxCount: number;
  p95Ms: number;
  failedRuns: number;
}

export interface CloudflareAnalyticsSnapshot {
  workersInvocationsAdaptive?: {
    requests?: number;
    errors?: number;
    p50Ms?: number;
    p95Ms?: number;
    p99Ms?: number;
  };
  queuesBacklogAdaptive?: Array<{
    queueName: string;
    depth: number;
    dlqCount?: number;
    updatedAt?: string;
  }>;
}

export interface EnvironmentHealthSummary {
  ok: true;
  env: string;
  window: HealthWindow;
  generatedAt: string;
  requestCount: number;
  requestsPerMinute: number;
  error4xxCount: number;
  error5xxCount: number;
  errorRatePercent: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  d1: {
    queryCount: number;
    p50Ms: number;
    p95Ms: number;
    errorCount: number;
  };
  workflows: {
    totalRuns: number;
    succeededRuns: number;
    failedRuns: number;
    successRatePercent: number;
    topFailingWorkflows: TopFailingWorkflowMetric[];
  };
  queues: QueueHealthMetric[];
  perBrick: BrickHealthMetric[];
  series: HealthTimeSeriesBucket[];
  analyticsReconciliation?: {
    source: "d1-sovereign" | "cloudflare-graphql+d1";
    cloudflareRequests?: number;
    cloudflareErrors?: number;
    cloudflareP95Ms?: number;
    deltaPercent?: number;
  };
}

export function toMinuteBucketIso(ts?: string | number | Date): string {
  const date =
    ts instanceof Date
      ? new Date(ts.getTime())
      : typeof ts === "number"
        ? new Date(ts)
        : typeof ts === "string" && ts.trim()
          ? new Date(ts)
          : new Date();
  const valid = Number.isFinite(date.getTime()) ? date : new Date();
  valid.setUTCSeconds(0, 0);
  return valid.toISOString();
}

function roundMetric(val: number, decimals = 2): number {
  if (!Number.isFinite(val)) return 0;
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}

function computeQuantileFromSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return roundMetric(sorted[0]!, 2);
  const pos = (sorted.length - 1) * q;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return roundMetric(sorted[lower]!, 2);
  const weight = pos - lower;
  return roundMetric(
    sorted[lower]! * (1 - weight) + sorted[upper]! * weight,
    2,
  );
}

export function computeLatencyQuantiles(values: number[]): {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
} {
  const clean = values
    .filter((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  if (clean.length === 0) {
    return { p50Ms: 0, p95Ms: 0, p99Ms: 0 };
  }
  return {
    p50Ms: computeQuantileFromSorted(clean, 0.5),
    p95Ms: computeQuantileFromSorted(clean, 0.95),
    p99Ms: computeQuantileFromSorted(clean, 0.99),
  };
}

interface ParsedLatencyBucketsPayload {
  samples?: number[];
  d1Samples?: number[];
  buckets?: Record<string, number>;
}

function parseLatencyBucketsJson(raw: string | null | undefined): ParsedLatencyBucketsPayload {
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      return {
        samples: Array.isArray(obj.samples)
          ? obj.samples.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
          : undefined,
        d1Samples: Array.isArray(obj.d1Samples)
          ? obj.d1Samples.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
          : undefined,
        buckets:
          typeof obj.buckets === "object" && obj.buckets !== null && !Array.isArray(obj.buckets)
            ? (obj.buckets as Record<string, number>)
            : undefined,
      };
    }
  } catch {
    // ignore invalid json
  }
  return {};
}

function buildHistogramBuckets(samples: number[]): Record<string, number> {
  const buckets: Record<string, number> = {
    le_10: 0,
    le_25: 0,
    le_50: 0,
    le_100: 0,
    le_250: 0,
    le_500: 0,
    le_1000: 0,
    gt_1000: 0,
  };
  for (const s of samples) {
    if (s <= 10) buckets.le_10! += 1;
    else if (s <= 25) buckets.le_25! += 1;
    else if (s <= 50) buckets.le_50! += 1;
    else if (s <= 100) buckets.le_100! += 1;
    else if (s <= 250) buckets.le_250! += 1;
    else if (s <= 500) buckets.le_500! += 1;
    else if (s <= 1000) buckets.le_1000! += 1;
    else buckets.gt_1000! += 1;
  }
  return buckets;
}

export async function upsertHttpRollup(
  db: D1Like,
  input: HttpRollupInput,
): Promise<void> {
  await ensureTelemetryTables(db);
  const bucketMinute = toMinuteBucketIso(input.bucketMinute);
  const routePrefix = input.routePrefix?.trim() || "/";
  const brickId = input.brickId?.trim() || "runtime";
  const envName = input.envName?.trim() || "preview";
  const requestCount = Math.max(0, Math.trunc(input.requestCount));
  const error4xxCount = Math.max(0, Math.trunc(input.error4xxCount ?? 0));
  const error5xxCount = Math.max(0, Math.trunc(input.error5xxCount ?? 0));
  const d1QueryCount = Math.max(0, Math.trunc(input.d1QueryCount ?? 0));
  const d1LatencyMs = roundMetric(Math.max(0, input.d1LatencyMs ?? 0), 2);
  const d1ErrorCount = Math.max(0, Math.trunc(input.d1ErrorCount ?? 0));

  const samples = Array.isArray(input.latencySamplesMs) ? input.latencySamplesMs : [];
  const d1Samples = Array.isArray(input.d1SamplesMs) ? input.d1SamplesMs : [];
  const computedQuantiles =
    samples.length > 0 ? computeLatencyQuantiles(samples) : null;

  const p50Ms = roundMetric(input.p50Ms ?? computedQuantiles?.p50Ms ?? 0, 2);
  const p95Ms = roundMetric(input.p95Ms ?? computedQuantiles?.p95Ms ?? 0, 2);
  const p99Ms = roundMetric(input.p99Ms ?? computedQuantiles?.p99Ms ?? 0, 2);

  const latencyBucketsJson =
    input.latencyBucketsJson ??
    JSON.stringify({
      samples: samples.slice(0, 500),
      d1Samples: d1Samples.slice(0, 500),
      buckets: buildHistogramBuckets(samples),
    });

  await db
    .prepare(
      `INSERT INTO px_http_rollups (
        bucket_minute, route_prefix, brick_id, request_count, error_4xx_count, error_5xx_count,
        latency_buckets_json, p50_ms, p95_ms, p99_ms, d1_query_count, d1_latency_ms, d1_error_count, env_name
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
      ON CONFLICT(bucket_minute, route_prefix, brick_id, env_name) DO UPDATE SET
        request_count = excluded.request_count,
        error_4xx_count = excluded.error_4xx_count,
        error_5xx_count = excluded.error_5xx_count,
        latency_buckets_json = excluded.latency_buckets_json,
        p50_ms = excluded.p50_ms,
        p95_ms = excluded.p95_ms,
        p99_ms = excluded.p99_ms,
        d1_query_count = excluded.d1_query_count,
        d1_latency_ms = excluded.d1_latency_ms,
        d1_error_count = excluded.d1_error_count`,
    )
    .bind(
      bucketMinute,
      routePrefix,
      brickId,
      requestCount,
      error4xxCount,
      error5xxCount,
      latencyBucketsJson,
      p50Ms,
      p95Ms,
      p99Ms,
      d1QueryCount,
      d1LatencyMs,
      d1ErrorCount,
      envName,
    )
    .run();
}

interface D1HttpRollupRow {
  bucket_minute: string;
  route_prefix: string;
  brick_id: string;
  request_count: number;
  error_4xx_count: number;
  error_5xx_count: number;
  latency_buckets_json: string;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  d1_query_count: number;
  d1_latency_ms: number;
  d1_error_count: number;
  env_name: string;
}

export async function recordHttpRequestSamples(
  db: D1Like,
  samples: HttpRequestSampleInput[],
): Promise<void> {
  if (!Array.isArray(samples) || samples.length === 0) return;
  await ensureTelemetryTables(db);

  const grouped = new Map<
    string,
    {
      bucketMinute: string;
      routePrefix: string;
      brickId: string;
      envName: string;
      requestCount: number;
      error4xxCount: number;
      error5xxCount: number;
      latencies: number[];
      d1Queries: number;
      d1Latencies: number[];
      d1Errors: number;
    }
  >();

  for (const sample of samples) {
    const bucketMinute = toMinuteBucketIso(sample.ts);
    const routePrefix = sample.routePrefix?.trim() || "/";
    const brickId = sample.brickId?.trim() || "runtime";
    const envName = sample.envName?.trim() || "preview";
    const key = `${bucketMinute}::${routePrefix}::${brickId}::${envName}`;
    let acc = grouped.get(key);
    if (!acc) {
      acc = {
        bucketMinute,
        routePrefix,
        brickId,
        envName,
        requestCount: 0,
        error4xxCount: 0,
        error5xxCount: 0,
        latencies: [],
        d1Queries: 0,
        d1Latencies: [],
        d1Errors: 0,
      };
      grouped.set(key, acc);
    }
    acc.requestCount += 1;
    if (sample.status >= 400 && sample.status < 500) {
      acc.error4xxCount += 1;
    } else if (sample.status >= 500) {
      acc.error5xxCount += 1;
    }
    if (typeof sample.latencyMs === "number" && Number.isFinite(sample.latencyMs)) {
      acc.latencies.push(Math.max(0, sample.latencyMs));
    }
    if (typeof sample.d1Queries === "number" && sample.d1Queries > 0) {
      acc.d1Queries += Math.trunc(sample.d1Queries);
    }
    if (typeof sample.d1LatencyMs === "number" && Number.isFinite(sample.d1LatencyMs)) {
      acc.d1Latencies.push(Math.max(0, sample.d1LatencyMs));
    }
    if (typeof sample.d1Errors === "number" && sample.d1Errors > 0) {
      acc.d1Errors += Math.trunc(sample.d1Errors);
    }
  }

  for (const group of grouped.values()) {
    const existing = await db
      .prepare(
        `SELECT * FROM px_http_rollups
         WHERE bucket_minute = ?1 AND route_prefix = ?2 AND brick_id = ?3 AND env_name = ?4`,
      )
      .bind(group.bucketMinute, group.routePrefix, group.brickId, group.envName)
      .first<D1HttpRollupRow>();

    const existingParsed = parseLatencyBucketsJson(existing?.latency_buckets_json);
    const mergedLatencies = [
      ...(existingParsed.samples ?? []),
      ...group.latencies,
    ];
    const mergedD1Latencies = [
      ...(existingParsed.d1Samples ?? []),
      ...group.d1Latencies,
    ];
    const quantiles = computeLatencyQuantiles(mergedLatencies);
    const d1Quantiles = computeLatencyQuantiles(mergedD1Latencies);

    await upsertHttpRollup(db, {
      bucketMinute: group.bucketMinute,
      routePrefix: group.routePrefix,
      brickId: group.brickId,
      envName: group.envName,
      requestCount: Number(existing?.request_count ?? 0) + group.requestCount,
      error4xxCount: Number(existing?.error_4xx_count ?? 0) + group.error4xxCount,
      error5xxCount: Number(existing?.error_5xx_count ?? 0) + group.error5xxCount,
      latencySamplesMs: mergedLatencies,
      d1SamplesMs: mergedD1Latencies,
      p50Ms: quantiles.p50Ms,
      p95Ms: quantiles.p95Ms,
      p99Ms: quantiles.p99Ms,
      d1QueryCount: Number(existing?.d1_query_count ?? 0) + group.d1Queries,
      d1LatencyMs:
        mergedD1Latencies.length > 0
          ? d1Quantiles.p50Ms
          : Number(existing?.d1_latency_ms ?? 0),
      d1ErrorCount: Number(existing?.d1_error_count ?? 0) + group.d1Errors,
    });
  }
}

export async function upsertQueueMetrics(
  db: D1Like,
  input: QueueMetricInput,
): Promise<void> {
  await ensureTelemetryTables(db);
  const queueName = input.queueName.trim();
  const pendingCount = Math.max(
    0,
    Math.trunc(input.pendingCount ?? input.depth ?? 0),
  );
  const dlqCount = Math.max(0, Math.trunc(input.dlqCount ?? 0));
  const updatedAt =
    input.updatedAt && input.updatedAt.trim()
      ? input.updatedAt.trim()
      : new Date().toISOString();
  const envName = input.envName?.trim() || "preview";

  await db
    .prepare(
      `INSERT INTO px_queue_metrics (
        queue_name, pending_count, dlq_count, updated_at, env_name
      ) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(queue_name, env_name) DO UPDATE SET
        pending_count = excluded.pending_count,
        dlq_count = excluded.dlq_count,
        updated_at = excluded.updated_at`,
    )
    .bind(queueName, pendingCount, dlqCount, updatedAt, envName)
    .run();
}

interface D1QueueMetricRow {
  queue_name: string;
  pending_count: number;
  dlq_count: number;
  updated_at: string;
  env_name: string;
}

export function resolveWindowDurationMinutes(window: HealthWindow): number {
  switch (window) {
    case "1h":
      return 60;
    case "24h":
      return 24 * 60;
    case "7d":
      return 7 * 24 * 60;
  }
}

export async function queryEnvironmentMetrics(
  db: D1Like,
  options: {
    env?: string;
    window?: HealthWindow | string;
    now?: Date | string | number;
  } = {},
): Promise<EnvironmentHealthSummary> {
  await ensureTelemetryTables(db);
  const env = options.env?.trim() || "preview";
  const windowParsed = HealthWindowSchema.safeParse(options.window ?? "1h");
  const window: HealthWindow = windowParsed.success ? windowParsed.data : "1h";

  const nowMs =
    options.now instanceof Date
      ? options.now.getTime()
      : typeof options.now === "number"
        ? options.now
        : typeof options.now === "string"
          ? Date.parse(options.now)
          : Date.now();
  const effectiveNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const windowMinutes = resolveWindowDurationMinutes(window);
  const cutoffIso = new Date(
    effectiveNowMs - windowMinutes * 60_000,
  ).toISOString();

  const rollupRes = await db
    .prepare(
      `SELECT * FROM px_http_rollups
       WHERE env_name = ?1 AND bucket_minute >= ?2
       ORDER BY bucket_minute ASC`,
    )
    .bind(env, cutoffIso)
    .all<D1HttpRollupRow>();
  const rollupRows = rollupRes.results ?? [];

  let totalRequests = 0;
  let total4xx = 0;
  let total5xx = 0;
  let totalD1Queries = 0;
  let totalD1Errors = 0;

  const allLatencySamples: number[] = [];
  const allRollupP50s: number[] = [];
  const allRollupP95s: number[] = [];
  const allRollupP99s: number[] = [];
  const allD1Samples: number[] = [];
  const allD1RollupLatencies: number[] = [];

  const brickMap = new Map<
    string,
    {
      brickId: string;
      routePrefix: string;
      requestCount: number;
      error4xxCount: number;
      error5xxCount: number;
      samples: number[];
      p50s: number[];
      p95s: number[];
      p99s: number[];
    }
  >();

  for (const row of rollupRows) {
    const reqCount = Number(row.request_count ?? 0);
    const err4xx = Number(row.error_4xx_count ?? 0);
    const err5xx = Number(row.error_5xx_count ?? 0);
    const d1Q = Number(row.d1_query_count ?? 0);
    const d1Err = Number(row.d1_error_count ?? 0);
    const d1Lat = Number(row.d1_latency_ms ?? 0);

    totalRequests += reqCount;
    total4xx += err4xx;
    total5xx += err5xx;
    totalD1Queries += d1Q;
    totalD1Errors += d1Err;

    const parsedJson = parseLatencyBucketsJson(row.latency_buckets_json);
    if (parsedJson.samples && parsedJson.samples.length > 0) {
      allLatencySamples.push(...parsedJson.samples);
    } else if (reqCount > 0) {
      allRollupP50s.push(Number(row.p50_ms ?? 0));
      allRollupP95s.push(Number(row.p95_ms ?? 0));
      allRollupP99s.push(Number(row.p99_ms ?? 0));
    }

    if (parsedJson.d1Samples && parsedJson.d1Samples.length > 0) {
      allD1Samples.push(...parsedJson.d1Samples);
    } else if (d1Q > 0 || d1Lat > 0) {
      allD1RollupLatencies.push(d1Lat);
    }

    const brickKey = `${row.brick_id}::${row.route_prefix}`;
    let brickAcc = brickMap.get(brickKey);
    if (!brickAcc) {
      brickAcc = {
        brickId: row.brick_id,
        routePrefix: row.route_prefix,
        requestCount: 0,
        error4xxCount: 0,
        error5xxCount: 0,
        samples: [],
        p50s: [],
        p95s: [],
        p99s: [],
      };
      brickMap.set(brickKey, brickAcc);
    }
    brickAcc.requestCount += reqCount;
    brickAcc.error4xxCount += err4xx;
    brickAcc.error5xxCount += err5xx;
    if (parsedJson.samples && parsedJson.samples.length > 0) {
      brickAcc.samples.push(...parsedJson.samples);
    } else if (reqCount > 0) {
      brickAcc.p50s.push(Number(row.p50_ms ?? 0));
      brickAcc.p95s.push(Number(row.p95_ms ?? 0));
      brickAcc.p99s.push(Number(row.p99_ms ?? 0));
    }
  }

  let latencyP50Ms = 0;
  let latencyP95Ms = 0;
  let latencyP99Ms = 0;
  if (allLatencySamples.length > 0) {
    const q = computeLatencyQuantiles(allLatencySamples);
    latencyP50Ms = q.p50Ms;
    latencyP95Ms = q.p95Ms;
    latencyP99Ms = q.p99Ms;
  } else if (allRollupP50s.length > 0) {
    latencyP50Ms = computeQuantileFromSorted(
      [...allRollupP50s].sort((a, b) => a - b),
      0.5,
    );
    latencyP95Ms = computeQuantileFromSorted(
      [...allRollupP95s].sort((a, b) => a - b),
      0.95,
    );
    latencyP99Ms = computeQuantileFromSorted(
      [...allRollupP99s].sort((a, b) => a - b),
      0.99,
    );
  }

  let d1P50Ms = 0;
  let d1P95Ms = 0;
  if (allD1Samples.length > 0) {
    const dq = computeLatencyQuantiles(allD1Samples);
    d1P50Ms = dq.p50Ms;
    d1P95Ms = dq.p95Ms;
  } else if (allD1RollupLatencies.length > 0) {
    const sortedD1 = [...allD1RollupLatencies].sort((a, b) => a - b);
    d1P50Ms = computeQuantileFromSorted(sortedD1, 0.5);
    d1P95Ms = computeQuantileFromSorted(sortedD1, 0.95);
  }

  const perBrick: BrickHealthMetric[] = [...brickMap.values()]
    .map((b) => {
      let p50Ms = 0;
      let p95Ms = 0;
      let p99Ms = 0;
      if (b.samples.length > 0) {
        const q = computeLatencyQuantiles(b.samples);
        p50Ms = q.p50Ms;
        p95Ms = q.p95Ms;
        p99Ms = q.p99Ms;
      } else if (b.p50s.length > 0) {
        p50Ms = computeQuantileFromSorted([...b.p50s].sort((x, y) => x - y), 0.5);
        p95Ms = computeQuantileFromSorted([...b.p95s].sort((x, y) => x - y), 0.95);
        p99Ms = computeQuantileFromSorted([...b.p99s].sort((x, y) => x - y), 0.99);
      }
      const errorRatePercent =
        b.requestCount > 0
          ? roundMetric((b.error5xxCount / b.requestCount) * 100, 2)
          : 0;
      return {
        brickId: b.brickId,
        routePrefix: b.routePrefix,
        requestCount: b.requestCount,
        error4xxCount: b.error4xxCount,
        error5xxCount: b.error5xxCount,
        errorRatePercent,
        p50Ms,
        p95Ms,
        p99Ms,
      };
    })
    .sort((a, b) => b.error5xxCount - a.error5xxCount || b.requestCount - a.requestCount);

  // Query workflow runs within window
  const runsRes = await db
    .prepare(
      `SELECT * FROM px_runs
       WHERE started_at >= ?1
       ORDER BY started_at DESC`,
    )
    .bind(cutoffIso)
    .all<D1RunRow>();
  const runRows = runsRes.results ?? [];

  let totalRuns = 0;
  let succeededRuns = 0;
  let failedRuns = 0;
  const failedByWorkflow = new Map<
    string,
    { workflowId: string; failedCount: number; lastFailedRunId: string | null }
  >();

  for (const run of runRows) {
    totalRuns += 1;
    if (run.status === "succeeded") {
      succeededRuns += 1;
    } else if (run.status === "failed") {
      failedRuns += 1;
      const existing = failedByWorkflow.get(run.workflow_id);
      if (!existing) {
        failedByWorkflow.set(run.workflow_id, {
          workflowId: run.workflow_id,
          failedCount: 1,
          lastFailedRunId: run.run_id,
        });
      } else {
        existing.failedCount += 1;
      }
    }
  }

  const topFailingWorkflows = [...failedByWorkflow.values()]
    .sort((a, b) => b.failedCount - a.failedCount || a.workflowId.localeCompare(b.workflowId))
    .slice(0, 5);

  const successRatePercent =
    totalRuns > 0 ? roundMetric((succeededRuns / totalRuns) * 100, 2) : 100;

  // Query queue metrics for environment
  const queuesRes = await db
    .prepare(
      `SELECT * FROM px_queue_metrics
       WHERE env_name = ?1
       ORDER BY dlq_count DESC, pending_count DESC, queue_name ASC`,
    )
    .bind(env)
    .all<D1QueueMetricRow>();
  const queues: QueueHealthMetric[] = (queuesRes.results ?? []).map((q) => ({
    queueName: q.queue_name,
    depth: Number(q.pending_count ?? 0),
    dlqCount: Number(q.dlq_count ?? 0),
    updatedAt: q.updated_at,
  }));

  // Build time-series buckets for sparklines (12 buckets across the window)
  const bucketCount = 12;
  const bucketSpanMs = (windowMinutes * 60_000) / bucketCount;
  const startWindowMs = effectiveNowMs - windowMinutes * 60_000;
  const series: HealthTimeSeriesBucket[] = [];

  for (let i = 0; i < bucketCount; i += 1) {
    const bStart = startWindowMs + i * bucketSpanMs;
    const bEnd = bStart + bucketSpanMs;
    const bStartIso = new Date(bStart).toISOString();
    const bEndIso = new Date(bEnd).toISOString();

    let bReq = 0;
    let b5xx = 0;
    const bSamples: number[] = [];
    const bP95s: number[] = [];

    for (const r of rollupRows) {
      if (r.bucket_minute >= bStartIso && r.bucket_minute < bEndIso) {
        bReq += Number(r.request_count ?? 0);
        b5xx += Number(r.error_5xx_count ?? 0);
        const parsed = parseLatencyBucketsJson(r.latency_buckets_json);
        if (parsed.samples && parsed.samples.length > 0) {
          bSamples.push(...parsed.samples);
        } else if (Number(r.request_count ?? 0) > 0) {
          bP95s.push(Number(r.p95_ms ?? 0));
        }
      }
    }

    let bFailedRuns = 0;
    for (const run of runRows) {
      if (
        run.status === "failed" &&
        run.started_at >= bStartIso &&
        run.started_at < bEndIso
      ) {
        bFailedRuns += 1;
      }
    }

    const bP95Ms =
      bSamples.length > 0
        ? computeLatencyQuantiles(bSamples).p95Ms
        : bP95s.length > 0
          ? computeQuantileFromSorted([...bP95s].sort((a, b) => a - b), 0.95)
          : 0;

    series.push({
      bucketTs: bStartIso,
      requestCount: bReq,
      error5xxCount: b5xx,
      p95Ms: bP95Ms,
      failedRuns: bFailedRuns,
    });
  }

  const requestsPerMinute = roundMetric(totalRequests / windowMinutes, 2);
  const errorRatePercent =
    totalRequests > 0
      ? roundMetric((total5xx / totalRequests) * 100, 2)
      : 0;

  return {
    ok: true,
    env,
    window,
    generatedAt: new Date(effectiveNowMs).toISOString(),
    requestCount: totalRequests,
    requestsPerMinute,
    error4xxCount: total4xx,
    error5xxCount: total5xx,
    errorRatePercent,
    latencyP50Ms,
    latencyP95Ms,
    latencyP99Ms,
    d1: {
      queryCount: totalD1Queries,
      p50Ms: d1P50Ms,
      p95Ms: d1P95Ms,
      errorCount: totalD1Errors,
    },
    workflows: {
      totalRuns,
      succeededRuns,
      failedRuns,
      successRatePercent,
      topFailingWorkflows,
    },
    queues,
    perBrick,
    series,
    analyticsReconciliation: {
      source: "d1-sovereign",
    },
  };
}

export function reconcileCloudflareAnalyticsWithD1Metrics(
  d1Metrics: EnvironmentHealthSummary,
  cfAnalytics?: CloudflareAnalyticsSnapshot | null,
): EnvironmentHealthSummary {
  if (!cfAnalytics) return d1Metrics;

  const cfWorkers = cfAnalytics.workersInvocationsAdaptive;
  const cfQueues = cfAnalytics.queuesBacklogAdaptive;

  const windowMinutes = resolveWindowDurationMinutes(d1Metrics.window);
  const requestCount =
    typeof cfWorkers?.requests === "number" && cfWorkers.requests >= d1Metrics.requestCount
      ? cfWorkers.requests
      : d1Metrics.requestCount;
  const error5xxCount =
    typeof cfWorkers?.errors === "number" && cfWorkers.errors >= d1Metrics.error5xxCount
      ? cfWorkers.errors
      : d1Metrics.error5xxCount;

  const latencyP50Ms =
    d1Metrics.latencyP50Ms > 0
      ? d1Metrics.latencyP50Ms
      : roundMetric(cfWorkers?.p50Ms ?? 0, 2);
  const latencyP95Ms =
    d1Metrics.latencyP95Ms > 0
      ? d1Metrics.latencyP95Ms
      : roundMetric(cfWorkers?.p95Ms ?? 0, 2);
  const latencyP99Ms =
    d1Metrics.latencyP99Ms > 0
      ? d1Metrics.latencyP99Ms
      : roundMetric(cfWorkers?.p99Ms ?? 0, 2);

  const mergedQueueMap = new Map<string, QueueHealthMetric>();
  for (const q of d1Metrics.queues) {
    mergedQueueMap.set(q.queueName, { ...q });
  }
  if (Array.isArray(cfQueues)) {
    for (const cq of cfQueues) {
      const existing = mergedQueueMap.get(cq.queueName);
      if (existing) {
        existing.depth = Math.max(existing.depth, Number(cq.depth ?? 0));
        if (typeof cq.dlqCount === "number") {
          existing.dlqCount = Math.max(existing.dlqCount, cq.dlqCount);
        }
      } else {
        mergedQueueMap.set(cq.queueName, {
          queueName: cq.queueName,
          depth: Number(cq.depth ?? 0),
          dlqCount: Number(cq.dlqCount ?? 0),
          updatedAt: cq.updatedAt ?? d1Metrics.generatedAt,
        });
      }
    }
  }

  const deltaPercent =
    typeof cfWorkers?.requests === "number" && cfWorkers.requests > 0
      ? roundMetric(
          (Math.abs(cfWorkers.requests - d1Metrics.requestCount) /
            cfWorkers.requests) *
            100,
          2,
        )
      : 0;

  return {
    ...d1Metrics,
    requestCount,
    requestsPerMinute: roundMetric(requestCount / windowMinutes, 2),
    error5xxCount,
    errorRatePercent:
      requestCount > 0 ? roundMetric((error5xxCount / requestCount) * 100, 2) : 0,
    latencyP50Ms,
    latencyP95Ms,
    latencyP99Ms,
    queues: [...mergedQueueMap.values()],
    analyticsReconciliation: {
      source: "cloudflare-graphql+d1",
      ...(typeof cfWorkers?.requests === "number"
        ? { cloudflareRequests: cfWorkers.requests }
        : {}),
      ...(typeof cfWorkers?.errors === "number"
        ? { cloudflareErrors: cfWorkers.errors }
        : {}),
      ...(typeof cfWorkers?.p95Ms === "number"
        ? { cloudflareP95Ms: cfWorkers.p95Ms }
        : {}),
      deltaPercent,
    },
  };
}

export async function handleTelemetryMetricsRequest(
  request: Request,
  options: {
    db: D1Like;
    telemetrySecret: string | undefined;
    pxEnv?: string;
    now?: Date | string | number;
  },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/__px/metrics") return null;
  if (request.method !== "GET") {
    return Response.json(
      { error: { code: "METHOD_NOT_ALLOWED", message: "Expected GET /__px/metrics" } },
      { status: 405 },
    );
  }

  const windowParam = url.searchParams.get("window") ?? "1h";
  const parsedWindow = HealthWindowSchema.safeParse(windowParam);
  if (!parsedWindow.success) {
    return Response.json(
      {
        error: {
          code: "INVALID_WINDOW",
          message: "window must be one of 1h, 24h, 7d",
        },
      },
      { status: 400 },
    );
  }

  const signature = request.headers.get(TELEMETRY_SIGNATURE_HEADER);
  const canonical = canonicalMetricsQueryPayload(url);
  const pathAndQuery = `${url.pathname}${url.search}`;
  const windowFallback = `GET:/__px/metrics?window=${parsedWindow.data}`;

  const validSig =
    (await verifyTelemetrySignature(canonical, signature, options.telemetrySecret)) ||
    (await verifyTelemetrySignature(pathAndQuery, signature, options.telemetrySecret)) ||
    (await verifyTelemetrySignature(windowFallback, signature, options.telemetrySecret));

  if (!validSig) {
    return Response.json(
      {
        error: {
          code: "UNAUTHORIZED_TELEMETRY_SIGNATURE",
          message: "Missing or invalid X-Px-Signature",
        },
      },
      { status: 401 },
    );
  }

  const envParam = url.searchParams.get("env") ?? options.pxEnv ?? "preview";
  const summary = await queryEnvironmentMetrics(options.db, {
    env: envParam,
    window: parsedWindow.data,
    now: options.now,
  });

  return Response.json(summary, { status: 200 });
}
