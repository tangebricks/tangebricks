import type { IntegrationOperation } from "@poc/assembler";

export function isRetryable(operation: Pick<IntegrationOperation, "method" | "sideEffects" | "idempotency">): boolean {
  const method = operation.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return true;
  }
  if (operation.sideEffects === "none" || operation.sideEffects === "read") {
    return true;
  }
  if (operation.idempotency !== undefined && operation.idempotency !== null) {
    return true;
  }
  return false;
}

export interface ParseRetryDelayResult {
  readonly delayMs: number;
  readonly exceedsCeiling: boolean;
}

export function parseRetryDelayMs(
  response: Response,
  attempt: number,
  rateLimit: IntegrationOperation["rateLimit"],
  maxSleepMs: number,
  fallbackRetryAfterHeader?: string,
  now: () => number = Date.now,
): ParseRetryDelayResult {
  const respectRetryAfter = rateLimit?.respectRetryAfter ?? true;
  const headerName = rateLimit?.retryAfterHeader ?? fallbackRetryAfterHeader ?? "retry-after";

  let headerDelayMs: number | undefined;

  if (respectRetryAfter) {
    let rawVal: string | null = null;
    let headerUsed: string | null = null;

    const configuredVal = response.headers.get(headerName);
    if (configuredVal !== null && configuredVal.trim() !== "") {
      rawVal = configuredVal.trim();
      headerUsed = headerName.toLowerCase();
    } else {
      const retryAfterVal = response.headers.get("retry-after");
      if (retryAfterVal !== null && retryAfterVal.trim() !== "") {
        rawVal = retryAfterVal.trim();
        headerUsed = "retry-after";
      } else {
        const resetVal = response.headers.get("x-ratelimit-reset");
        if (resetVal !== null && resetVal.trim() !== "") {
          rawVal = resetVal.trim();
          headerUsed = "x-ratelimit-reset";
        }
      }
    }

    if (rawVal !== null && headerUsed !== null) {
      if (headerUsed.includes("reset")) {
        const num = Number(rawVal);
        if (Number.isFinite(num) && num >= 0) {
          if (num >= 1e9) {
            headerDelayMs = Math.max(0, Math.round(num * 1000) - now());
          } else {
            headerDelayMs = Math.round(num * 1000);
          }
        }
      } else {
        if (/^\d+(\.\d+)?$/.test(rawVal)) {
          const seconds = Number(rawVal);
          if (Number.isFinite(seconds) && seconds >= 0) {
            headerDelayMs = Math.round(seconds * 1000);
          }
        } else {
          const parsedTime = Date.parse(rawVal);
          if (!Number.isNaN(parsedTime)) {
            headerDelayMs = Math.max(0, parsedTime - now());
          }
        }
      }
    }
  }

  let delayMs: number;
  let exceedsCeiling = false;
  if (headerDelayMs !== undefined) {
    delayMs = headerDelayMs;
    exceedsCeiling = delayMs > maxSleepMs;
  } else {
    const initialBackoff = rateLimit?.initialBackoffMs ?? rateLimit?.baseBackoffMs ?? 250;
    const expDelay = initialBackoff * Math.pow(2, attempt);
    delayMs = Math.round(expDelay);
    exceedsCeiling = delayMs > maxSleepMs;
  }

  return {
    delayMs,
    exceedsCeiling,
  };
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
