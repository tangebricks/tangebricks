import { projectIntegrationToNodes } from "@poc/assembler";
import type { Catalog, IntegrationManifestFile, IntegrationOperation } from "@poc/assembler";
import type { BlobStore, ExecutionContext, Executor } from "@poc/sdk";
import { redactTelemetryPayload, redactTelemetryString } from "@poc/telemetry";
import { callOperation, IntegrationCallError } from "./call-operation.ts";
import type { CallOperationOptions, CallOperationResult, IntegrationFetcher } from "./call-operation.ts";
import {
  DEFAULT_SECRET_HEADER_AND_FIELD_NAMES,
  NON_SECRET_CONNECTION_METADATA_KEYS,
  collectConnectionSecretValues,
  collectConnectionsMapSecrets,
  isPlainObject,
  trackSecretValue,
} from "./integration/redaction.ts";
import {
  applyConnectionAuth,
  assertNoReservedDataKeys,
  findErrorMappingForStatus,
  getByDotPath,
  parseLinkNextUrl,
  resolveConnectionForOperation,
  resolveParamValue,
  setByDotPath,
  substitutePathParams,
  validateAndBuildTargetUrl,
  validatePathSegmentValue,
  validateRawPathTemplate,
} from "./integration/request-build.ts";
import { isRetryable, parseRetryDelayMs } from "./integration/retry.ts";
import type { ParseRetryDelayResult } from "./integration/retry.ts";

export type { IntegrationFetcher };

export interface IntegrationExecutorOptions {
  readonly fetcher?: IntegrationFetcher;
  readonly blobStore?: BlobStore;
  readonly maxSleepMs?: number;
  readonly resolveHost?: (host: string) => Promise<string[]>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly idempotencyKey?: (ctx: ExecutionContext) => string;
}

interface RegisteredIntegrationOperation {
  readonly manifest: IntegrationManifestFile;
  readonly operation: IntegrationOperation;
}

const registeredOperationsByNodeType = new Map<string, RegisteredIntegrationOperation>();

export {
  DEFAULT_SECRET_HEADER_AND_FIELD_NAMES,
  NON_SECRET_CONNECTION_METADATA_KEYS,
  applyConnectionAuth,
  assertNoReservedDataKeys,
  callOperation,
  collectConnectionSecretValues,
  collectConnectionsMapSecrets,
  findErrorMappingForStatus,
  getByDotPath,
  IntegrationCallError,
  isPlainObject,
  isRetryable,
  parseLinkNextUrl,
  parseRetryDelayMs,
  resolveConnectionForOperation,
  resolveParamValue,
  setByDotPath,
  substitutePathParams,
  trackSecretValue,
  validateAndBuildTargetUrl,
  validatePathSegmentValue,
  validateRawPathTemplate,
};
export type { CallOperationOptions, CallOperationResult, ParseRetryDelayResult };

export function registerIntegrationManifest(manifest: IntegrationManifestFile): void {
  for (const operation of manifest.operations) {
    const nodeType = `int:${manifest.app}.${operation.operationId}`;
    registeredOperationsByNodeType.set(nodeType, { manifest, operation });
  }
}

export function registerCatalogIntegrations(catalog: Catalog): void {
  for (const entry of Object.values(catalog.integrations ?? {})) {
    registerIntegrationManifest(entry.manifest);
  }
}

export function getRegisteredIntegrationOperation(nodeType: string): RegisteredIntegrationOperation | undefined {
  return registeredOperationsByNodeType.get(nodeType);
}

export function getRegisteredTokenUrlsByApp(): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const { manifest } of registeredOperationsByNodeType.values()) {
    if (manifest.auth.tokenUrl) {
      urls[manifest.app] = manifest.auth.tokenUrl;
    }
  }
  return urls;
}

function mapOutputPorts(operation: IntegrationOperation, res: CallOperationResult): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  if (isPlainObject(res.data)) {
    Object.assign(raw, res.data);
  }
  for (const port of operation.response?.outputs ?? []) {
    if (port.id === "status") raw.status = res.status;
    else if (port.id === "body") raw.body = res.body;
    else if (port.id === "data" || port.id === "out") raw[port.id] = res.data;
    else if (port.id === "text" && typeof res.body === "string") raw.text = res.body;
    else if (isPlainObject(res.data) && Object.hasOwn(res.data, port.id)) raw[port.id] = (res.data as any)[port.id];
    else if (isPlainObject(res.body) && Object.hasOwn(res.body, port.id)) raw[port.id] = (res.body as any)[port.id];
  }
  raw.out = res.data;
  if (!Object.hasOwn(raw, "data")) raw.data = res.data;
  if (!Object.hasOwn(raw, "body")) raw.body = res.body;
  if (!Object.hasOwn(raw, "status")) raw.status = res.status;
  if (operation.pagination) {
    raw.truncated = res.truncated;
    raw.nextCursor = res.nextCursor;
    raw.pagesFetched = res.pagesFetched;
  }
  return raw;
}

export function createIntegrationOperationExecutor(
  manifest: IntegrationManifestFile,
  operation: IntegrationOperation,
  options: IntegrationExecutorOptions = {},
): Executor {
  registerIntegrationManifest(manifest);

  return async (ctx: ExecutionContext): Promise<Record<string, unknown>> => {
    const blockingEntries = (manifest.fidelity?.unsupported ?? []).filter(
      (e) => (e.op === operation.operationId || e.op === null || e.op === "*") && e.blocking,
    );
    if (blockingEntries.length > 0) {
      const details = blockingEntries.map((e) => (e.pointer ? `${e.code} at ${e.pointer}` : e.code)).join(", ");
      throw new Error(`INTEGRATION_UNSUPPORTED_FEATURE: Integration "${manifest.app}" operation "${operation.operationId}" cannot run faithfully: ${details}`);
    }

    assertNoReservedDataKeys(ctx);

    const trackedSecrets = new Set<string>();
    const secretFieldNames = new Set<string>(DEFAULT_SECRET_HEADER_AND_FIELD_NAMES);
    if (manifest.auth?.headerName) secretFieldNames.add(manifest.auth.headerName.toLowerCase());
    if (manifest.auth?.queryParam) secretFieldNames.add(manifest.auth.queryParam.toLowerCase());
    for (const p of operation.params ?? []) if (p.sensitive) secretFieldNames.add(p.name.toLowerCase());
    for (const f of operation.body?.fields ?? []) if (f.sensitive) secretFieldNames.add(f.name.toLowerCase());

    const args: Record<string, unknown> = {};
    const bindArg = (name: string, sensitive?: boolean) => {
      const v = resolveParamValue(ctx, name);
      if (v !== undefined) args[name] = v;
      if (sensitive || secretFieldNames.has(name.toLowerCase())) trackSecretValue(v, trackedSecrets);
    };
    for (const p of operation.params ?? []) bindArg(p.name, p.sensitive);
    for (const f of operation.body?.fields ?? []) bindArg(f.name, f.sensitive);

    const conn = await resolveConnectionForOperation(ctx, manifest, trackedSecrets);

    let idempotencyKey: string | undefined = ctx.idempotencyKey;
    if (!idempotencyKey) {
      const ctxWithRun = ctx as ExecutionContext & { runId?: string };
      if (typeof ctxWithRun.runId === "string" && typeof ctx.nodeId === "string") {
        idempotencyKey = `${ctxWithRun.runId}:${ctx.nodeId}`;
      } else if (options.idempotencyKey) {
        idempotencyKey = options.idempotencyKey(ctx);
      } else if (operation.idempotency?.header) {
        idempotencyKey = crypto.randomUUID();
      }
    }

    try {
      const fetcher = options.fetcher ?? globalThis.fetch;
      const callResult = await callOperation(manifest, operation.operationId, args, {
        connection: conn,
        fetcher,
        blobStore: options.blobStore,
        idempotencyKey,
        maxSleepMs: options.maxSleepMs,
        sleep: options.sleep,
        now: options.now,
        resolveHost: options.resolveHost,
      });

      const rawOutput = mapOutputPorts(operation, callResult);
      const redactOpts = { secretValues: trackedSecrets, secretFieldNames };
      const scrubbed = redactTelemetryPayload(rawOutput, redactOpts) as Record<string, unknown>;

      await ctx.log?.info(`Executed integration operation int:${manifest.app}.${operation.operationId}`, {
        app: manifest.app,
        operationId: operation.operationId,
        method: operation.method,
        status: callResult.status,
        pagesFetched: callResult.pagesFetched,
      });

      return scrubbed;
    } catch (err) {
      const redactOpts = { secretValues: trackedSecrets, secretFieldNames };
      const rawMessage = err instanceof Error ? err.message : String(err);
      const safeMessage = redactTelemetryString(rawMessage, redactOpts);
      await ctx.log?.error(`Integration operation int:${manifest.app}.${operation.operationId} failed: ${safeMessage}`, {
        app: manifest.app,
        operationId: operation.operationId,
        method: operation.method,
      });
      if (safeMessage !== rawMessage) {
        const redactedErr = new Error(safeMessage);
        if (err && typeof err === "object") {
          Object.assign(redactedErr, err);
          redactedErr.message = safeMessage;
        }
        throw redactedErr;
      }
      throw err;
    }
  };
}

export const executeIntegrationOperation: Executor = async (ctx: ExecutionContext): Promise<Record<string, unknown>> => {
  assertNoReservedDataKeys(ctx);

  const ctxWithMeta = ctx as ExecutionContext & { nodeType?: string };
  const nodeType =
    ctxWithMeta.nodeType ??
    (typeof ctx.data.nodeType === "string" ? ctx.data.nodeType : undefined) ??
    (typeof ctx.data.app === "string" && typeof ctx.data.operationId === "string" ? `int:${ctx.data.app}.${ctx.data.operationId}` : undefined);

  if (nodeType) {
    const reg = registeredOperationsByNodeType.get(nodeType);
    if (reg) {
      const bound = createIntegrationOperationExecutor(reg.manifest, reg.operation);
      return bound(ctx);
    }
  }

  throw new Error(`INTEGRATION_OPERATION_NOT_FOUND: No registered integration operation found for node "${ctx.nodeId}"${nodeType ? ` (${nodeType})` : ""}`);
};

export function projectCatalogIntegrations(catalog: Catalog): Array<{
  app: string;
  manifest: IntegrationManifestFile;
  nodes: ReturnType<typeof projectIntegrationToNodes>;
}> {
  const results: Array<{
    app: string;
    manifest: IntegrationManifestFile;
    nodes: ReturnType<typeof projectIntegrationToNodes>;
  }> = [];
  for (const [app, entry] of Object.entries(catalog.integrations ?? {})) {
    const nodes = entry.nodes ?? projectIntegrationToNodes(entry.manifest);
    results.push({ app, manifest: entry.manifest, nodes });
  }
  return results;
}
