import type { IntegrationErrorMapping, IntegrationManifestFile, IntegrationOperation, Predicate } from "@poc/assembler";
import type { BlobStore } from "@poc/sdk";
import { redactTelemetryPayload, redactTelemetryString } from "@poc/telemetry";
import { IntegrationCallError } from "./errors.ts";
import { getByDotPath } from "./request-build.ts";

export const MAX_ERROR_BODY_CHARS = 16 * 1024;

export function capErrorBody(redacted: unknown): unknown {
  if (redacted === undefined || redacted === null) return redacted;
  try {
    const serialized = JSON.stringify(redacted);
    if (serialized.length <= MAX_ERROR_BODY_CHARS) return redacted;
    return {
      truncated: true,
      preview: serialized.slice(0, MAX_ERROR_BODY_CHARS),
    };
  } catch {
    return redacted;
  }
}

export function providerErrorField(
  body: unknown,
  fieldPath: string | undefined,
  redactOpts: { secretValues: Set<string>; secretFieldNames: Set<string> },
): string | undefined {
  if (!fieldPath) return undefined;
  const raw = getByDotPath(body, fieldPath);
  if (raw === undefined || raw === null) return undefined;
  const str = typeof raw === "string" ? raw : JSON.stringify(raw);
  return redactTelemetryString(str, redactOpts);
}

export function evaluatePredicate(predicate: Predicate, body: unknown): boolean {
  if ("equals" in predicate) {
    const val = getByDotPath(body, predicate.path);
    return val === predicate.equals;
  }
  if ("in" in predicate) {
    const val = getByDotPath(body, predicate.path);
    return (predicate.in as unknown[]).includes(val);
  }
  if ("exists" in predicate) {
    const val = getByDotPath(body, predicate.path);
    const exists = val !== undefined;
    return exists === predicate.exists;
  }
  if ("all" in predicate) {
    return predicate.all.every((p) => evaluatePredicate(p, body));
  }
  if ("any" in predicate) {
    return predicate.any.some((p) => evaluatePredicate(p, body));
  }
  return false;
}

export function findErrorMappingForStatus(status: number, opMappings?: any, manifestMappings?: any): IntegrationErrorMapping | undefined {
  const lookup = (mappings?: any): IntegrationErrorMapping | undefined => {
    if (!mappings) return undefined;
    if (Array.isArray(mappings)) {
      for (const m of mappings) {
        if (m.status === status) return m;
        if (typeof m.status === "string") {
          if (m.status === `${Math.floor(status / 100)}xx`) return m;
          if (m.status === "4xx" && status >= 400 && status < 500) return m;
          if (m.status === "5xx" && status >= 500 && status < 600) return m;
        }
      }
      return undefined;
    }
    if (typeof mappings === "object") {
      return mappings[String(status)] ?? mappings[`${Math.floor(status / 100)}xx`];
    }
    return undefined;
  };
  return lookup(opMappings) ?? lookup(manifestMappings);
}

export async function decodeResponseBody(
  response: Response,
  manifest: IntegrationManifestFile,
  operation: IntegrationOperation,
  options: { blobStore?: BlobStore },
  trackedSecrets: Set<string>,
  secretFieldNames: Set<string>,
): Promise<{
  status: number;
  body: unknown;
  headers: Headers;
}> {
  const respContentType = response.headers.get("content-type") ?? "";
  const isBinaryOp =
    Boolean(operation.response?.binary) ||
    respContentType.includes("application/pdf") ||
    respContentType.includes("application/octet-stream") ||
    respContentType.startsWith("image/") ||
    respContentType.startsWith("audio/") ||
    respContentType.startsWith("video/");

  let rawText = "";
  let parsedBody: unknown;

  if (!response.ok) {
    rawText = await response.text();
    if (rawText.trim().length === 0) {
      parsedBody = {};
    } else {
      try {
        parsedBody = JSON.parse(rawText);
      } catch {
        parsedBody = { text: rawText };
      }
    }
    const safeBodyText = redactTelemetryString(rawText.slice(0, 300), {
      secretValues: trackedSecrets,
      secretFieldNames,
    });
    const mappedErr = findErrorMappingForStatus(response.status, operation.errorMappings, manifest.errorMappings);
    const errPrefix = mappedErr?.code ?? (response.status === 429 ? "RATE_LIMITED" : "INTEGRATION_HTTP_ERROR");
    const hintSuffix = mappedErr?.hint ? ` (${mappedErr.hint})` : "";
    const redactOptsForBody = { secretValues: trackedSecrets, secretFieldNames };
    const shape = operation.response?.errorShape;
    const providerCode = shape?.codePath ? providerErrorField(parsedBody, shape.codePath, redactOptsForBody) : undefined;
    const providerMessage = shape?.messagePath ? providerErrorField(parsedBody, shape.messagePath, redactOptsForBody) : undefined;
    const hasProviderFields = providerCode !== undefined || providerMessage !== undefined;
    const detail = hasProviderFields ? [providerCode, providerMessage].filter((v) => v !== undefined).join(": ") : safeBodyText;
    throw new IntegrationCallError(
      `${errPrefix}: Integration "${manifest.app}" operation "${operation.operationId}" failed with HTTP ${response.status}${hintSuffix}: ${detail}`,
      {
        code: errPrefix,
        status: response.status,
        retryable: false,
        ...(providerCode !== undefined ? { providerCode } : {}),
        ...(providerMessage !== undefined ? { providerMessage } : {}),
        body: capErrorBody(redactTelemetryPayload(parsedBody, redactOptsForBody)),
      },
    );
  }

  if (isBinaryOp) {
    if (!options.blobStore) {
      throw new IntegrationCallError("INTEGRATION_BLOBSTORE_MISSING: blobStore is required for binary responses", { code: "INTEGRATION_BLOBSTORE_MISSING" });
    }
    const maxBytes = operation.response?.maxBytes ?? 10 * 1024 * 1024;
    if (!response.body) {
      parsedBody = { blobRef: "", contentType: respContentType, size: 0 };
    } else {
      try {
        const stored = await options.blobStore.put(response.body, {
          contentType: respContentType || "application/octet-stream",
          maxBytes,
        });
        parsedBody = {
          blobRef: stored.ref,
          contentType: stored.contentType,
          size: stored.size,
        };
      } catch (err: any) {
        if (err?.code === "INTEGRATION_PAYLOAD_TOO_LARGE") {
          throw new IntegrationCallError(err.message, {
            code: "INTEGRATION_PAYLOAD_TOO_LARGE",
          });
        }
        throw err;
      }
    }
  } else if (operation.response?.contentType?.startsWith("text/") || respContentType.startsWith("text/")) {
    rawText = await response.text();
    parsedBody = rawText;
  } else {
    rawText = await response.text();
    if (rawText.trim().length === 0) {
      parsedBody = {};
    } else {
      try {
        parsedBody = JSON.parse(rawText);
      } catch {
        parsedBody = { text: rawText };
      }
    }
  }

  const errorWhen = operation.errorWhen ?? manifest.errorWhen;
  if (errorWhen && evaluatePredicate(errorWhen, parsedBody)) {
    const safeBodyText = redactTelemetryString(rawText.slice(0, 300), {
      secretValues: trackedSecrets,
      secretFieldNames,
    });
    const redactOptsForBody = { secretValues: trackedSecrets, secretFieldNames };
    const shape = operation.response?.errorShape;
    const providerCode = shape?.codePath ? providerErrorField(parsedBody, shape.codePath, redactOptsForBody) : undefined;
    const providerMessage = shape?.messagePath ? providerErrorField(parsedBody, shape.messagePath, redactOptsForBody) : undefined;
    const hasProviderFields = providerCode !== undefined || providerMessage !== undefined;
    const detail = hasProviderFields ? [providerCode, providerMessage].filter((v) => v !== undefined).join(": ") : safeBodyText;
    throw new IntegrationCallError(
      `INTEGRATION_PROVIDER_ERROR: Integration "${manifest.app}" operation "${operation.operationId}" failed with provider error: ${detail}`,
      {
        code: "INTEGRATION_PROVIDER_ERROR",
        status: response.status,
        retryable: false,
        ...(providerCode !== undefined ? { providerCode } : {}),
        ...(providerMessage !== undefined ? { providerMessage } : {}),
        body: capErrorBody(redactTelemetryPayload(parsedBody, redactOptsForBody)),
      },
    );
  }

  const successWhen = operation.successWhen ?? manifest.successWhen;
  if (successWhen && !evaluatePredicate(successWhen, parsedBody)) {
    const safeBodyText = redactTelemetryString(rawText.slice(0, 300), {
      secretValues: trackedSecrets,
      secretFieldNames,
    });
    const redactOptsForBody = { secretValues: trackedSecrets, secretFieldNames };
    const shape = operation.response?.errorShape;
    const providerCode = shape?.codePath ? providerErrorField(parsedBody, shape.codePath, redactOptsForBody) : undefined;
    const providerMessage = shape?.messagePath ? providerErrorField(parsedBody, shape.messagePath, redactOptsForBody) : undefined;
    const hasProviderFields = providerCode !== undefined || providerMessage !== undefined;
    const detail = hasProviderFields ? [providerCode, providerMessage].filter((v) => v !== undefined).join(": ") : safeBodyText;
    throw new IntegrationCallError(
      `INTEGRATION_PROVIDER_ERROR: Integration "${manifest.app}" operation "${operation.operationId}" failed success predicate: ${detail}`,
      {
        code: "INTEGRATION_PROVIDER_ERROR",
        status: response.status,
        retryable: false,
        ...(providerCode !== undefined ? { providerCode } : {}),
        ...(providerMessage !== undefined ? { providerMessage } : {}),
        body: capErrorBody(redactTelemetryPayload(parsedBody, redactOptsForBody)),
      },
    );
  }

  return {
    status: response.status,
    body: parsedBody,
    headers: response.headers,
  };
}
