// Story 0.14: the shared CSRF / CORS / WebSocket-Origin rules, checked without any app around them.
import { describe, expect, test } from "vitest";
import {
  checkCsrf,
  checkWebSocketOrigin,
  handlePreflight,
  isOriginAllowed,
  parseAllowedOrigins,
  sessionCookieSecure,
  trustedOriginsFor,
} from "../src/index.ts";

const COOKIE = "better-auth.session_token=abc.def";

function req(method: string, url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method, headers });
}

describe("http guards (story 0.14)", () => {
  test("PX_ALLOWED_ORIGINS parsing keeps origins only: no wildcard, no paths, no junk", () => {
    expect(parseAllowedOrigins("https://a.example, https://b.example/path ,*, not a url,")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });

  test("same origin is always allowed; others only when listed; loopback only on a loopback server", () => {
    expect(isOriginAllowed("https://app.example", "https://app.example/x", [])).toBe(true);
    expect(isOriginAllowed("https://evil.example", "https://app.example/x", [])).toBe(false);
    expect(isOriginAllowed("https://ui.example", "https://app.example/x", ["https://ui.example"])).toBe(true);
    expect(isOriginAllowed("http://localhost:5173", "http://127.0.0.1:8787/api", [])).toBe(true);
    expect(isOriginAllowed("http://localhost:5173", "https://app.example/api", [])).toBe(false);
    expect(isOriginAllowed("null", "https://app.example/x", [])).toBe(false);
  });

  test("Secure is dropped only on a plain-http loopback server; trusted origins follow the same rule", () => {
    expect(sessionCookieSecure("https://app.example")).toBe(true);
    expect(sessionCookieSecure("http://app.example")).toBe(true);
    expect(sessionCookieSecure("http://localhost:8787")).toBe(false);
    expect(sessionCookieSecure("http://127.0.0.1")).toBe(false);
    // Only localhost and 127.0.0.1 count as loopback, for the cookie and for trusted origins alike.
    expect(sessionCookieSecure("http://[::1]:8787")).toBe(true);
    expect(isOriginAllowed("http://localhost:5173", "http://[::1]:8787/api", [])).toBe(false);
    expect(trustedOriginsFor("http://[::1]:8787/api", [])).toEqual(["http://[::1]:8787"]);
    expect(trustedOriginsFor("https://app.example/api", [])).toEqual(["https://app.example"]);
    expect(trustedOriginsFor("http://localhost/api", [])).toContain("http://localhost:*");
  });

  test("CSRF applies to cookie-authenticated writes only", () => {
    const url = "https://app.example/api/things";
    // Refused: cross-site Origin, cross-site Referer, nothing at all.
    expect(checkCsrf(req("POST", url, { cookie: COOKIE, origin: "https://evil.example" }), [])?.status).toBe(403);
    expect(checkCsrf(req("DELETE", url, { cookie: COOKIE, referer: "https://evil.example/x" }), [])?.status).toBe(403);
    expect(checkCsrf(req("PATCH", url, { cookie: COOKIE }), [])?.status).toBe(403);
    expect(checkCsrf(req("PUT", url, { cookie: COOKIE, origin: "null" }), [])?.status).toBe(403);
    // Origin "null" is refused even with a same-origin Referer: Referer counts only when Origin is absent.
    expect(
      checkCsrf(req("POST", url, { cookie: COOKIE, origin: "null", referer: "https://app.example/page" }), [])?.status,
    ).toBe(403);
    // Origin absent: a same-origin Referer is accepted.
    expect(checkCsrf(req("POST", url, { cookie: COOKIE, referer: "https://app.example/page" }), [])).toBeNull();
    // Allowed: same origin, Sec-Fetch-Site same-origin, listed origin, bearer, no session cookie, safe method, exempt path.
    expect(checkCsrf(req("POST", url, { cookie: COOKIE, origin: "https://app.example" }), [])).toBeNull();
    expect(checkCsrf(req("POST", url, { cookie: COOKIE, "sec-fetch-site": "same-origin" }), [])).toBeNull();
    expect(checkCsrf(req("POST", url, { cookie: COOKIE, origin: "https://ui.example" }), ["https://ui.example"])).toBeNull();
    expect(checkCsrf(req("POST", url, { cookie: COOKIE, authorization: "Bearer tok" }), [])).toBeNull();
    expect(checkCsrf(req("POST", url, { cookie: "other=1", origin: "https://evil.example" }), [])).toBeNull();
    expect(checkCsrf(req("GET", url, { cookie: COOKIE, origin: "https://evil.example" }), [])).toBeNull();
    expect(
      checkCsrf(req("POST", "https://app.example/api/webhooks/in/sub_1", { cookie: COOKIE, origin: "https://evil.example" }), [], {
        exemptPaths: ["/api/webhooks/in/"],
      }),
    ).toBeNull();
  });

  test("preflight: allowed origin gets credentials and never `*`; unlisted origin gets no allow headers", () => {
    const ok = handlePreflight(
      req("OPTIONS", "https://app.example/api/x", { origin: "https://ui.example", "access-control-request-method": "POST" }),
      ["https://ui.example"],
    );
    expect(ok?.status).toBe(204);
    expect(ok?.headers.get("access-control-allow-origin")).toBe("https://ui.example");
    expect(ok?.headers.get("access-control-allow-credentials")).toBe("true");
    const denied = handlePreflight(
      req("OPTIONS", "https://app.example/api/x", { origin: "https://evil.example", "access-control-request-method": "POST" }),
      ["https://ui.example"],
    );
    expect(denied?.headers.get("access-control-allow-origin")).toBeNull();
    expect(handlePreflight(req("OPTIONS", "https://app.example/api/x"), [])).toBeNull();
  });

  test("WebSocket upgrade: an unlisted Origin is refused; same origin and no Origin are left to the route", () => {
    const url = "https://app.example/api/projects/p/ws";
    expect(checkWebSocketOrigin(req("GET", url, { origin: "https://evil.example" }), [])?.status).toBe(403);
    expect(checkWebSocketOrigin(req("GET", url, { origin: "https://app.example" }), [])).toBeNull();
    expect(checkWebSocketOrigin(req("GET", url), [])).toBeNull();
  });
});
