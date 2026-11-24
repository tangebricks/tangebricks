// Browser-facing request guards shared by every Worker that accepts cookie sessions (studio-api, core-auth and the
// assembled app entry): an Origin check for cookie-authenticated writes (CSRF) and an explicit CORS allow-list.
//
// The allow-list comes from one env value, `PX_ALLOWED_ORIGINS` (comma-separated origins). With it unset only the
// request's own origin is allowed. The one other case: a Worker served over plain http from a loopback host
// (`http://localhost`, `http://127.0.0.1`) is a dev or test server, so it also accepts any loopback origin. This is the
// same exception that lets the session cookie drop `Secure` there; a deployed Worker is never on a loopback host.
//
// The module is framework-free (Request/Response only) so packages without Hono can use it; `createHttpGuard` returns
// a function with Hono's middleware shape.

/** The env variable that lists the extra origins allowed to call with credentials. */
export const ALLOWED_ORIGINS_ENV = "PX_ALLOWED_ORIGINS";

/** The refusal code for a cookie-authenticated write from an origin that is not allowed. */
export const CSRF_ORIGIN_MISMATCH = "CSRF_ORIGIN_MISMATCH";

/** The session cookie names Better Auth uses (plain, and with the `__Secure-` prefix). */
export const DEFAULT_SESSION_COOKIE_NAMES: readonly string[] = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
];

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Only these two: the session cookie may drop Secure, and loopback origins are trusted, on exactly these hosts.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** The origin of a URL (`scheme://host[:port]`), or null when it is not an absolute http(s) URL. */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** True for `http://localhost[:port]` and `http://127.0.0.1[:port]`. */
export function isLoopbackHttpOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/** Parses `PX_ALLOWED_ORIGINS`: comma-separated, each entry normalised to its origin; `*` and junk are dropped. */
export function parseAllowedOrigins(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const origin = originOf(part.trim());
    if (origin && !out.includes(origin)) out.push(origin);
  }
  return out;
}

/** Reads `PX_ALLOWED_ORIGINS` from a Worker env object. */
export function allowedOriginsFromEnv(env: unknown): string[] {
  if (!env || typeof env !== "object") return [];
  return parseAllowedOrigins((env as Record<string, unknown>)[ALLOWED_ORIGINS_ENV]);
}

/**
 * Whether `origin` may act on a request served at `requestUrl`: the request's own origin, an origin in `allowList`,
 * or (only when the server itself is a loopback http origin) another loopback http origin.
 */
export function isOriginAllowed(origin: string | null | undefined, requestUrl: string, allowList: readonly string[]): boolean {
  const candidate = originOf(origin);
  if (!candidate) return false;
  const own = originOf(requestUrl);
  if (own && candidate === own) return true;
  if (allowList.includes(candidate)) return true;
  return isLoopbackHttpOrigin(own) && isLoopbackHttpOrigin(candidate);
}

/**
 * The origins Better Auth should trust for a request served at `requestUrl`: the request's own origin, the configured
 * list, and (on a loopback dev/test server only) loopback origins on any port.
 */
export function trustedOriginsFor(requestUrl: string, allowList: readonly string[]): string[] {
  const own = originOf(requestUrl);
  const out = own ? [own, ...allowList.filter((o) => o !== own)] : [...allowList];
  if (isLoopbackHttpOrigin(own)) {
    for (const loopback of ["http://localhost", "http://127.0.0.1", "http://localhost:*", "http://127.0.0.1:*"]) {
      if (!out.includes(loopback)) out.push(loopback);
    }
  }
  return out;
}

/** Whether the session cookie should carry `Secure`: always, except on a loopback http dev/test server. */
export function sessionCookieSecure(requestUrl: string): boolean {
  return !isLoopbackHttpOrigin(originOf(requestUrl));
}

function hasBearer(request: Request): boolean {
  return /^bearer\s+\S/i.test(request.headers.get("authorization")?.trim() ?? "");
}

function hasSessionCookie(request: Request, names: readonly string[]): boolean {
  const cookie = request.headers.get("cookie");
  if (!cookie) return false;
  return cookie.split(";").some((pair) => {
    const name = pair.split("=")[0]?.trim() ?? "";
    return names.includes(name);
  });
}

export interface HttpGuardOptions {
  /** Path prefixes (or patterns) that keep their own authentication, such as signed webhook ingress. */
  exemptPaths?: ReadonlyArray<string | RegExp>;
  /** Session cookie names that make a request cookie-authenticated. Defaults to Better Auth's. */
  sessionCookieNames?: readonly string[];
  /** Extra allowed origins on top of `PX_ALLOWED_ORIGINS` (for embedders; normally empty). */
  allowedOrigins?: readonly string[];
}

function isExempt(pathname: string, exemptPaths: ReadonlyArray<string | RegExp>): boolean {
  return exemptPaths.some((p) => (typeof p === "string" ? pathname.startsWith(p) : p.test(pathname)));
}

/** A 403 refusal with the shared `{ error: { code, message } }` shape. */
function refusal(code: string, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status: 403,
    headers: { "content-type": "application/json; charset=UTF-8", ...headers },
  });
}

/**
 * The CSRF check for one request. Returns a 403 `CSRF_ORIGIN_MISMATCH` response, or null when the request may go on.
 * Only POST/PUT/PATCH/DELETE requests that carry a session cookie and no `Authorization: Bearer` are checked: a
 * bearer credential is never sent by a browser on its own, so a bearer request cannot be forged cross-site.
 */
export function checkCsrf(request: Request, allowList: readonly string[], options: HttpGuardOptions = {}): Response | null {
  if (!MUTATING_METHODS.has(request.method.toUpperCase())) return null;
  const pathname = new URL(request.url).pathname;
  if (isExempt(pathname, options.exemptPaths ?? [])) return null;
  if (hasBearer(request)) return null;
  if (!hasSessionCookie(request, options.sessionCookieNames ?? DEFAULT_SESSION_COOKIE_NAMES)) return null;

  if (request.headers.get("sec-fetch-site")?.toLowerCase() === "same-origin") return null;
  // Referer is consulted only when Origin is absent. An opaque `Origin: null` (sandboxed frame, data: URL, some
  // redirects) is never allowed, whatever the Referer says.
  const origin = request.headers.get("origin");
  const claimed = origin !== null ? origin : originOf(request.headers.get("referer"));
  if (claimed && claimed !== "null" && isOriginAllowed(claimed, request.url, allowList)) return null;
  return refusal(CSRF_ORIGIN_MISMATCH, "Cross-site request refused: the Origin of this cookie-authenticated request is not allowed");
}

/** True when the request comes from a browser on another origin that the allow-list admits. */
function corsOrigin(request: Request, allowList: readonly string[]): string | null {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return null;
  if (origin === originOf(request.url)) return null; // same-origin: no CORS headers needed
  return isOriginAllowed(origin, request.url, allowList) ? origin : null;
}

/**
 * Answers a CORS preflight. Returns null when the request is not a preflight. An allowed origin gets the allow
 * headers with credentials; any other origin gets a bare 204 with no allow headers, so the browser blocks the call.
 */
export function handlePreflight(request: Request, allowList: readonly string[]): Response | null {
  if (request.method.toUpperCase() !== "OPTIONS") return null;
  if (!request.headers.get("origin") || !request.headers.get("access-control-request-method")) return null;
  const origin = corsOrigin(request, allowList);
  const headers = new Headers({ vary: "Origin" });
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
    headers.set("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
    const requested = request.headers.get("access-control-request-headers");
    headers.set("access-control-allow-headers", requested && requested.trim() ? requested : "content-type, authorization");
    headers.set("access-control-max-age", "600");
  }
  return new Response(null, { status: 204, headers });
}

/** Adds the CORS response headers for an allowed cross-origin caller. Returns the response to send. */
export function applyCorsHeaders(request: Request, response: Response, allowList: readonly string[]): Response {
  const origin = corsOrigin(request, allowList);
  if (!origin || response.status === 101) return response;
  const set = (headers: Headers) => {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
    const exposed = new Set(
      (headers.get("access-control-expose-headers") ?? "")
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean),
    );
    exposed.add("set-auth-token");
    headers.set("access-control-expose-headers", [...exposed].join(", "));
    const vary = headers.get("vary") ?? "";
    if (!/(^|,)\s*origin\s*(,|$)/i.test(vary)) headers.set("vary", vary ? `${vary}, Origin` : "Origin");
  };
  try {
    set(response.headers);
    return response;
  } catch {
    // Immutable headers (a response passed through from fetch): copy it.
    const copy = new Response(response.body, response);
    set(copy.headers);
    return copy;
  }
}

/**
 * Refuses a WebSocket upgrade from a browser page on an origin that is not allowed (cross-site WebSocket hijacking).
 * A client without an Origin header is not a browser page and is left to the route's own authentication.
 */
export function checkWebSocketOrigin(request: Request, allowList: readonly string[]): Response | null {
  const origin = request.headers.get("origin");
  if (origin === null) return null;
  if (isOriginAllowed(origin, request.url, allowList)) return null;
  return refusal("WS_ORIGIN_NOT_ALLOWED", "WebSocket upgrade refused: the Origin of this request is not allowed");
}

/** The parts of a Hono context the guard uses. */
export interface HttpGuardContext {
  req: { raw: Request };
  env: unknown;
  res: Response;
}

/**
 * The CSRF + CORS guard as a Hono-shaped middleware: answers preflights, refuses cross-site cookie writes, and adds
 * CORS headers for allowed cross-origin callers. Mount it before any route.
 */
export function createHttpGuard(options: HttpGuardOptions = {}) {
  return async (c: HttpGuardContext, next: () => Promise<void>): Promise<Response | void> => {
    const request = c.req.raw;
    const allowList = [...allowedOriginsFromEnv(c.env), ...(options.allowedOrigins ?? [])];
    const preflight = handlePreflight(request, allowList);
    if (preflight) return preflight;
    const csrf = checkCsrf(request, allowList, options);
    if (csrf) return applyCorsHeaders(request, csrf, allowList);
    await next();
    const decorated = applyCorsHeaders(request, c.res, allowList);
    if (decorated !== c.res) c.res = decorated;
  };
}
