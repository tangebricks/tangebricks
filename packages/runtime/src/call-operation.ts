import type {
  IntegrationManifestFile,
  IntegrationOperation,
} from "@poc/assembler";
import type { BlobStore } from "@poc/sdk";
import {
  DEFAULT_SECRET_HEADER_AND_FIELD_NAMES,
  collectConnectionSecretValues,
  trackSecretValue,
} from "./integration/redaction.ts";
import {
  validateAndBuildTargetUrl,
  validatePathSegmentValue,
  validateRawPathTemplate,
} from "./integration/request-build.ts";
import {
  isRetryable,
  parseRetryDelayMs,
  sleep as defaultSleep,
} from "./integration/retry.ts";
import { IntegrationCallError } from "./integration/errors.ts";
import { createHardenedFetch } from "./egress.ts";
import { redactTelemetryString } from "@poc/telemetry";
import { serializeParam } from "./integration/param-serialization.ts";
import { resolveOperationAuth } from "./integration/auth.ts";
import { encodeRequestBody } from "./integration/body-encoding.ts";
import {
  initPaginationState,
  updatePaginationOnPage,
  finalizePaginationResult,
} from "./integration/pagination.ts";
import {
  decodeResponseBody,
  findErrorMappingForStatus,
} from "./integration/response-decoding.ts";

export { IntegrationCallError };

export type IntegrationFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CallOperationOptions {
  readonly connection?: Record<string, unknown> | null;
  readonly fetcher: IntegrationFetcher;
  readonly blobStore?: BlobStore;
  readonly idempotencyKey?: string;
  readonly maxSleepMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly resolveHost?: (host: string) => Promise<string[]>;
}

export interface CallOperationResult {
  readonly ok: true;
  readonly status: number;
  readonly data: unknown;
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly pagesFetched: number;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

export async function callOperation(
  manifest: IntegrationManifestFile,
  operationId: string,
  args: Record<string, unknown>,
  options: CallOperationOptions,
): Promise<CallOperationResult> {
  if (!options || typeof options.fetcher !== "function") {
    throw new IntegrationCallError(
      "INTEGRATION_FETCHER_MISSING: options.fetcher is required and must be a function",
      { code: "INTEGRATION_FETCHER_MISSING" },
    );
  }

  const operation = manifest.operations.find(
    (op: IntegrationOperation) => op.operationId === operationId,
  );
  if (!operation) {
    throw new IntegrationCallError(
      `INTEGRATION_OPERATION_NOT_FOUND: Operation "${operationId}" not found in manifest "${manifest.app}"`,
      { code: "INTEGRATION_OPERATION_NOT_FOUND" },
    );
  }

  const blockingEntries = (manifest.fidelity?.unsupported ?? []).filter(
    (e) =>
      (e.op === operation.operationId || e.op === null || e.op === "*") &&
      e.blocking,
  );
  if (blockingEntries.length > 0) {
    const details = blockingEntries
      .map((e) => (e.pointer ? `${e.code} at ${e.pointer}` : e.code))
      .join(", ");
    throw new IntegrationCallError(
      `INTEGRATION_UNSUPPORTED_FEATURE: Integration "${manifest.app}" operation "${operation.operationId}" cannot run faithfully: ${details}`,
      { code: "INTEGRATION_UNSUPPORTED_FEATURE" },
    );
  }

  const trackedSecrets = new Set<string>();
  const secretFieldNames = new Set<string>(DEFAULT_SECRET_HEADER_AND_FIELD_NAMES);
  if (manifest.auth?.headerName) {
    secretFieldNames.add(manifest.auth.headerName.toLowerCase());
  }
  if (manifest.auth?.queryParam) {
    secretFieldNames.add(manifest.auth.queryParam.toLowerCase());
  }
  for (const param of operation.params ?? []) {
    if (param.sensitive) {
      secretFieldNames.add(param.name.toLowerCase());
    }
  }
  for (const field of operation.body?.fields ?? []) {
    if (field.sensitive) {
      secretFieldNames.add(field.name.toLowerCase());
    }
  }

  try {
    const rawPath = operation.path;
    validateRawPathTemplate(rawPath, manifest.app);

    // 1. Substitute path parameters
    const substitutedPath = rawPath.replace(/\{([^{}]+)\}/g, (_match, paramName: string) => {
      let lookupName = paramName;
      let allowReserved = false;
      if (paramName.startsWith("+")) {
        lookupName = paramName.slice(1);
        allowReserved = true;
      }
      const paramDef = (operation.params ?? []).find(
        (p) => p.name === lookupName && p.in === "path",
      );
      if (paramDef?.allowReserved) {
        allowReserved = true;
      }

      const val = args[lookupName];
      if (val === undefined || val === null || String(val).trim().length === 0) {
        throw new IntegrationCallError(
          `INTEGRATION_MISSING_PARAM: Missing required path parameter "${lookupName}" for path "${rawPath}"`,
          { code: "INTEGRATION_MISSING_PARAM" },
        );
      }
      if (paramDef?.sensitive || secretFieldNames.has(lookupName.toLowerCase())) {
        trackSecretValue(val, trackedSecrets);
      }
      if (paramDef) {
        const serialized = serializeParam(paramDef, val);
        if (serialized.kind === "path") {
          return validatePathSegmentValue(lookupName, serialized.segment, allowReserved);
        }
      }
      return validatePathSegmentValue(lookupName, String(val), allowReserved);
    });

    // 2. Validate and build target HTTPS URL
    const targetUrl = validateAndBuildTargetUrl(manifest, substitutedPath);

    // 3. Initialize request headers
    const requestHeaders: Record<string, string> = {
      accept: "application/json",
      ...(manifest.defaultHeaders ?? {}),
    };

    // 4. Apply connection auth
    const authHeaderNames = resolveOperationAuth(
      manifest,
      operation,
      options.connection,
      requestHeaders,
      targetUrl,
      trackedSecrets,
      secretFieldNames,
    );

    // 5. Resolve query, header, and cookie parameters
    const queryPairs: [string, string][] = [];
    const cookiePairs: [string, string][] = [];

    for (const param of operation.params ?? []) {
      if (param.in === "path") continue;
      const val = args[param.name];
      if (val === undefined || val === null) {
        if (param.required) {
          throw new IntegrationCallError(
            `INTEGRATION_MISSING_PARAM: Missing required parameter "${param.name}"`,
            { code: "INTEGRATION_MISSING_PARAM" },
          );
        }
        continue;
      }
      if (param.sensitive || secretFieldNames.has(param.name.toLowerCase())) {
        trackSecretValue(val, trackedSecrets);
      }

      const serialized = serializeParam(param, val);
      if (serialized.kind === "query") {
        queryPairs.push(...serialized.pairs);
      } else if (serialized.kind === "header") {
        const hName = param.wireName ?? param.name;
        if (authHeaderNames.has(hName.toLowerCase())) {
          throw new IntegrationCallError(
            `INTEGRATION_HEADER_CONFLICT: Header parameter "${param.name}" conflicts with auth header "${hName}"`,
            { code: "INTEGRATION_HEADER_CONFLICT" },
          );
        }
        requestHeaders[hName] = serialized.value;
      } else if (serialized.kind === "cookie") {
        cookiePairs.push(serialized.pair);
      }
    }

    if (cookiePairs.length > 0) {
      const cookieHeaderVal = cookiePairs.map(([k, v]) => `${k}=${v}`).join("; ");
      requestHeaders["cookie"] = cookieHeaderVal;
    }

    // 6. Encode request body
    const requestBody = await encodeRequestBody(
      operation,
      args,
      requestHeaders,
      options,
      trackedSecrets,
      secretFieldNames,
    );

    // 7. Append query parameters
    if (queryPairs.length > 0) {
      for (const [k, v] of queryPairs) {
        targetUrl.searchParams.append(k, v);
      }
      if (targetUrl.search.includes("%5B%5D")) {
        targetUrl.search = targetUrl.search.replace(/%5B%5D/g, "[]");
      }
    }

    // 8. Idempotency Key header
    if (operation.idempotency?.header) {
      const headerName = operation.idempotency.header;
      if (options.idempotencyKey) {
        requestHeaders[headerName] = options.idempotencyKey;
      }
    } else if (
      operation.method === "POST" ||
      operation.method === "PUT" ||
      operation.method === "PATCH" ||
      operation.method === "DELETE"
    ) {
      if (options.idempotencyKey) {
        requestHeaders["Idempotency-Key"] = options.idempotencyKey;
      }
    }

    // 9. Hardened fetcher
    const customFetcher = createHardenedFetch(options.fetcher, {
      allowedHosts: manifest.allowedHosts,
      resolveHost: options.resolveHost,
    });

    const maxRetries = Math.min(Math.max(0, operation.rateLimit?.maxRetries ?? 3), 5);
    const sleepFn = options.sleep ?? defaultSleep;
    const nowFn = options.now ?? Date.now;
    const maxSleepMs = options.maxSleepMs ?? 30_000;

    const executeSinglePageFetch = async (
      pageUrl: URL,
    ): Promise<{
      status: number;
      body: unknown;
      headers: Headers;
    }> => {
      for (let attempt = 0; ; attempt += 1) {
        const attemptHeaders = { ...requestHeaders };
        const response = await customFetcher(pageUrl.toString(), {
          method: operation.method,
          headers: attemptHeaders,
          ...(requestBody !== undefined ? { body: requestBody } : {}),
        });

        if (response.status === 401) {
          const mapped401 = findErrorMappingForStatus(
            401,
            operation.errorMappings,
            manifest.errorMappings,
          );
          const code401 = mapped401?.code ?? "CONNECTION_EXPIRED";
          const hintSuffix = mapped401?.hint ? ` (${mapped401.hint})` : "";
          throw new IntegrationCallError(
            `${code401}: Integration "${manifest.app}" operation "${operation.operationId}" returned HTTP 401 Unauthorized${hintSuffix}`,
            { code: code401, status: 401 },
          );
        }

        const opRetryable = isRetryable(operation);
        if (
          (response.status === 429 || response.status === 503) &&
          opRetryable &&
          attempt < maxRetries
        ) {
          const mapped429 = findErrorMappingForStatus(
            response.status,
            operation.errorMappings,
            manifest.errorMappings,
          );
          const retryDelay = parseRetryDelayMs(
            response,
            attempt,
            operation.rateLimit,
            maxSleepMs,
            mapped429?.retryAfterHeader,
            nowFn,
          );
          if (retryDelay.exceedsCeiling) {
            const rawText = await response.text();
            const safeBodyText = redactTelemetryString(rawText.slice(0, 300), {
              secretValues: trackedSecrets,
              secretFieldNames,
            });
            const mappedErr = findErrorMappingForStatus(
              response.status,
              operation.errorMappings,
              manifest.errorMappings,
            );
            const errPrefix = mappedErr?.code ?? "RATE_LIMITED";
            const hintSuffix = mappedErr?.hint ? ` (${mappedErr.hint})` : "";
            throw new IntegrationCallError(
              `${errPrefix}: Integration "${manifest.app}" operation "${operation.operationId}" failed with HTTP ${response.status}${hintSuffix}: ${safeBodyText}`,
              {
                code: errPrefix,
                status: response.status,
                retryable: false,
                retryAfterMs: retryDelay.delayMs,
              },
            );
          }
          await sleepFn(retryDelay.delayMs);
          continue;
        }

        return decodeResponseBody(
          response,
          manifest,
          operation,
          options,
          trackedSecrets,
          secretFieldNames,
        );
      }
    };

    // 10. Execute pagination fetch loop
    const paginationState = initPaginationState(operation, targetUrl);

    while (paginationState.pagesFetched < paginationState.maxPages) {
      const decoded = await executeSinglePageFetch(paginationState.currentPageUrl);
      const shouldContinue = updatePaginationOnPage(
        paginationState,
        manifest,
        operation,
        decoded.status,
        decoded.body,
        decoded.headers,
      );
      if (!shouldContinue) {
        break;
      }
    }

    const { finalBody, extractedData, headersRecord } = finalizePaginationResult(
      paginationState,
      operation,
    );

    return {
      ok: true,
      status: paginationState.lastStatus,
      data: extractedData,
      body: finalBody,
      headers: headersRecord,
      pagesFetched: paginationState.pagesFetched,
      truncated: paginationState.truncated,
      nextCursor: paginationState.truncated ? paginationState.nextCursor : null,
    };
  } catch (err) {
    const redactOpts = {
      secretValues: trackedSecrets,
      secretFieldNames,
    };
    const rawMessage = err instanceof Error ? err.message : String(err);
    const safeMessage = redactTelemetryString(rawMessage, redactOpts);
    if (safeMessage !== rawMessage) {
      if (err instanceof IntegrationCallError) {
        throw new IntegrationCallError(safeMessage, {
          code: err.code,
          status: err.status,
          retryable: err.retryable,
          providerCode: err.providerCode,
          providerMessage: err.providerMessage,
          retryAfterMs: err.retryAfterMs,
          body: err.body,
        });
      }
      const redactedErr = new Error(safeMessage);
      if (err && typeof err === "object") {
        Object.assign(redactedErr, err);
      }
      redactedErr.message = safeMessage;
      throw redactedErr;
    }
    throw err;
  }
}
