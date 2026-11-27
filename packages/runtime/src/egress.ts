import { defaultResolveHost, isForbiddenIntegrationHost, isPrivateAddress } from "@poc/sdk";
import type { IntegrationFetcher } from "./integration-executor.ts";

// Address classification and DNS resolution live in @poc/sdk (egress-guard.ts); re-exported for existing callers.
export { defaultResolveHost, isPrivateAddress };

export interface EgressPolicy {
  readonly allowedHosts: readonly string[];
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxRedirects?: number;
  readonly authHeaderName?: string;
  readonly resolveHost?: (host: string) => Promise<string[]>;
}

export class IntegrationEgressError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "IntegrationEgressError";
    this.code = code;
  }
}

export function createHardenedFetch(base: IntegrationFetcher, policy: EgressPolicy): IntegrationFetcher {
  const timeoutMs = policy.timeoutMs ?? 15_000;
  const maxResponseBytes = policy.maxResponseBytes ?? 10 * 1024 * 1024;
  const maxRedirects = policy.maxRedirects ?? 5;
  const resolveHost = Object.prototype.hasOwnProperty.call(policy, "resolveHost") ? policy.resolveHost : defaultResolveHost;

  const validateTargetUrl = (targetUrl: URL, isRedirect: boolean): void => {
    const hostname = targetUrl.hostname.toLowerCase();
    const isHttps = targetUrl.protocol === "https:";
    const hasUserInfo = targetUrl.username !== "" || targetUrl.password !== "";
    const isDefaultPort = targetUrl.port === "" || targetUrl.port === "443";
    const isAllowed = policy.allowedHosts.map((h) => h.toLowerCase()).includes(hostname);
    const isForbidden = isForbiddenIntegrationHost(hostname);

    if (!isHttps || hasUserInfo || !isDefaultPort || !isAllowed || isForbidden) {
      if (isRedirect) {
        throw new IntegrationEgressError(
          "INTEGRATION_REDIRECT_FORBIDDEN",
          `Redirect target "${hostname}" is forbidden (must be https, default port, without credentials, and in allowedHosts [${policy.allowedHosts.join(", ")}])`,
        );
      }
      throw new IntegrationEgressError("INTEGRATION_HOST_FORBIDDEN", `Target host "${hostname}" is not in allowedHosts [${policy.allowedHosts.join(", ")}]`);
    }
  };

  const checkPrivateIp = async (hostname: string): Promise<void> => {
    if (!resolveHost) return;
    const ips = await resolveHost(hostname);
    for (const ip of ips) {
      if (isPrivateAddress(ip)) {
        throw new IntegrationEgressError("INTEGRATION_PRIVATE_ADDRESS", `Host "${hostname}" resolved to private IP "${ip}"`);
      }
    }
  };

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let currentUrl: URL;
    if (typeof input === "string") {
      currentUrl = new URL(input);
    } else if (input instanceof URL) {
      currentUrl = new URL(input.toString());
    } else {
      currentUrl = new URL(input.url);
    }

    let currentMethod = init?.method ?? (input instanceof Request ? input.method : "GET");
    const currentHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    let currentBody = init?.body ?? (input instanceof Request ? input.body : undefined);

    let redirectCount = 0;

    // Validate initial destination
    validateTargetUrl(currentUrl, false);
    await checkPrivateIp(currentUrl.hostname);

    // Setup combined abort signal with timeout
    const timeoutController = new AbortController();
    let timeoutFired = false;
    const timerId = setTimeout(() => {
      timeoutFired = true;
      timeoutController.abort(new Error("INTEGRATION_TIMEOUT"));
    }, timeoutMs);

    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (callerSignal) {
      if (callerSignal.aborted) {
        clearTimeout(timerId);
        timeoutController.abort(callerSignal.reason);
      } else {
        callerSignal.addEventListener("abort", () => {
          clearTimeout(timerId);
          timeoutController.abort(callerSignal.reason);
        });
      }
    }

    try {
      while (true) {
        let response: Response;
        try {
          response = await base(currentUrl.toString(), {
            ...init,
            method: currentMethod,
            headers: currentHeaders,
            body: currentBody,
            redirect: "manual",
            signal: timeoutController.signal,
          });
        } catch (fetchErr: unknown) {
          if (timeoutFired) {
            throw new IntegrationEgressError("INTEGRATION_TIMEOUT", `Request to "${currentUrl.hostname}" timed out after ${timeoutMs}ms`);
          }
          throw fetchErr;
        }

        // Check redirect status
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          redirectCount += 1;
          if (redirectCount > maxRedirects) {
            throw new IntegrationEgressError("INTEGRATION_TOO_MANY_REDIRECTS", `Exceeded max redirects of ${maxRedirects} for host "${currentUrl.hostname}"`);
          }

          const locationHeader = response.headers.get("location");
          if (!locationHeader) {
            return response;
          }

          let nextUrl: URL;
          try {
            nextUrl = new URL(locationHeader, currentUrl.toString());
          } catch {
            throw new IntegrationEgressError(
              "INTEGRATION_REDIRECT_FORBIDDEN",
              `Invalid redirect Location URL "${locationHeader}" from "${currentUrl.hostname}"`,
            );
          }

          validateTargetUrl(nextUrl, true);
          await checkPrivateIp(nextUrl.hostname);

          // If cross-host redirect, strip sensitive headers
          const isSameHost = nextUrl.hostname.toLowerCase() === currentUrl.hostname.toLowerCase();
          if (!isSameHost) {
            currentHeaders.delete("authorization");
            currentHeaders.delete("cookie");
            currentHeaders.delete("x-api-key");
            currentHeaders.delete("api-key");
            currentHeaders.delete("apikey");
            if (policy.authHeaderName) {
              currentHeaders.delete(policy.authHeaderName.toLowerCase());
            }
          }

          // RFC 9110 / 7231 method rewriting for 301, 302, 303
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === "POST")) {
            currentMethod = "GET";
            currentBody = undefined;
            currentHeaders.delete("content-type");
            currentHeaders.delete("content-length");
          }

          currentUrl = nextUrl;
          continue;
        }

        // Check Content-Length cap if provided
        const contentLength = response.headers.get("content-length");
        if (contentLength) {
          const len = parseInt(contentLength, 10);
          if (!isNaN(len) && len > maxResponseBytes) {
            throw new IntegrationEgressError(
              "INTEGRATION_RESPONSE_TOO_LARGE",
              `Response from "${currentUrl.hostname}" exceeded max response size of ${maxResponseBytes} bytes (Content-Length: ${len})`,
            );
          }
        }

        // Wrap response body in byte-counting TransformStream if body exists
        if (response.body) {
          let bytesCount = 0;
          const hostForErr = currentUrl.hostname;
          const limiter = new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              bytesCount += chunk.byteLength;
              if (bytesCount > maxResponseBytes) {
                const err = new IntegrationEgressError(
                  "INTEGRATION_RESPONSE_TOO_LARGE",
                  `Response from "${hostForErr}" exceeded max response size of ${maxResponseBytes} bytes`,
                );
                controller.error(err);
                return;
              }
              controller.enqueue(chunk);
            },
          });

          const limitedBody = response.body.pipeThrough(limiter);
          return new Response(limitedBody, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }

        return response;
      }
    } finally {
      clearTimeout(timerId);
    }
  };
}
