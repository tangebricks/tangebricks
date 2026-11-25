// Shared plumbing for the outbound delivery adapters (story 2.4): the guarded fetch, Retry-After, and the retry class
// of an HTTP status. No provider names, no secrets.
import { createPublicUrlFetch, isEgressForbiddenError } from "@poc/sdk";
import type { BaseFetcher, HostResolver } from "@poc/sdk";

export interface DeliveryAdapterHttpOptions {
  /** The fetch the egress guard wraps. Tests inject one; a Worker passes nothing and gets the platform's fetch. */
  fetch?: BaseFetcher;
  /** Host resolution for the egress guard. Tests pass `null` (no DNS) to stay offline. */
  resolveHost?: HostResolver | null;
  /**
   * Timeout for one request, reading the response body included. Default 10 s (the brick also caps a whole send,
   * retries included, at 20 s).
   */
  timeoutMs?: number;
}

export const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;

/** One request ran past its timeout (headers or body): the provider may have processed it. */
export class DeliveryTimeoutError extends Error {
  constructor() {
    super("DELIVERY_TIMEOUT");
    this.name = "DeliveryTimeoutError";
  }
}

/** A request and its JSON object body (null when the body is not one), read under one deadline. */
export type DeliveryFetcher = (url: string, init: RequestInit) => Promise<{ response: Response; body: Record<string, unknown> | null }>;

/** The body as a JSON object, or null when it is not one. A failed read throws (the caller cannot know the outcome). */
async function readJsonObject(response: Response): Promise<Record<string, unknown> | null> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function guardedFetch(options: DeliveryAdapterHttpOptions = {}): DeliveryFetcher {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
  const guarded = createPublicUrlFetch(options.fetch ?? ((url, init) => fetch(url, init)), {
    ...(options.resolveHost !== undefined ? { resolveHost: options.resolveHost } : {}),
    timeoutMs,
    // Credentials travel in headers a cross-origin redirect would not strip, so no redirect is ever followed.
    maxRedirects: 0,
  });
  return async (url, init) => {
    // One deadline over the whole exchange: connecting, the headers and reading the body.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new DeliveryTimeoutError());
        reject(new DeliveryTimeoutError());
      }, timeoutMs);
    });
    deadline.catch(() => {});
    try {
      const response = await Promise.race([guarded(url, { ...init, signal: controller.signal }), deadline]);
      const body = await Promise.race([readJsonObject(response), deadline]);
      return { response, body };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

/**
 * Retry only when the provider said the request was not processed: an explicit 429, or a 503 that carries Retry-After.
 * Any other 5xx may have been processed, so it is not retried (a retry could send the message twice).
 */
export function isRetryableResponse(response: Response): boolean {
  return response.status === 429 || (response.status === 503 && response.headers.has("retry-after"));
}

/** 429, 5xx: the provider could not answer now (used for sender checks, where nothing is sent). */
export function isUnavailableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * The error code for a request that threw. The egress guard's refusals (a URL, host or DNS check, or a redirect it will
 * not follow) are made without the provider processing anything: `EGRESS_REFUSED`. A timeout (the guard's
 * EGRESS_TIMEOUT or this module's deadline), a reset or a failed body read may come after the provider got the request,
 * so its outcome is unknown.
 */
export function thrownErrorCode(prefix: string, error: unknown): string {
  if (error instanceof DeliveryTimeoutError) return `${prefix}_UNKNOWN_OUTCOME`;
  if (isEgressForbiddenError(error)) return error.code === "EGRESS_TIMEOUT" ? `${prefix}_UNKNOWN_OUTCOME` : `${prefix}_EGRESS_REFUSED`;
  return `${prefix}_UNKNOWN_OUTCOME`;
}

/** Retry-After in milliseconds (delta-seconds only), or undefined. */
export function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (!value || !/^\d{1,6}$/.test(value)) return undefined;
  return Number(value) * 1000;
}

export const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
