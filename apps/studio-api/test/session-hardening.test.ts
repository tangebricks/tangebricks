// Story 0.14 (S6): studio-api session hardening. One test per row of the story's I/O matrix that studio-api owns:
// cookie flags, hashed session storage (and replay of a stored value), the guarded rewrite of rows from before the
// change, the CSRF Origin check, the CORS allow-list, and the Origin check on the live-sync WebSocket.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { hashLegacySessionTokens, sha256HexString } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { app as studioApp, ensureStudioD1Schema } from "../src/index.ts";
import type { StudioApiEnv } from "../src/index.ts";
import { signInTestHuman } from "./human-session.ts";

const rawEnv = env as unknown as StudioApiEnv;
const studioDb = rawEnv.STUDIO_DB as D1Like;
const BASE = "https://example.test";

async function call(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    baseUrl?: string;
    env?: StudioApiEnv;
  } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return studioApp.fetch(
    new Request(`${init.baseUrl ?? BASE}${path}`, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    init.env ?? rawEnv,
  );
}

async function signUp(label: string, baseUrl?: string) {
  const res = await call("/api/auth/signup", {
    body: {
      email: `hardening-${label}-${crypto.randomUUID().slice(0, 8)}@example.test`,
      password: "Password12345!",
      name: `Hardening ${label}`,
    },
    ...(baseUrl ? { baseUrl } : {}),
  });
  expect(res.status).toBe(201);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const body = (await res.json()) as { token: string; user: { id: string } };
  return { token: body.token, userId: body.user.id, setCookie, cookie: setCookie.split(";")[0] ?? "" };
}

function cookieAttributes(setCookie: string): string[] {
  return setCookie
    .split(";")
    .slice(1)
    .map((a) => a.trim().toLowerCase());
}

async function orgCount(token: string): Promise<number> {
  const res = await call("/api/orgs", { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { orgs?: unknown[] } | unknown[];
  return Array.isArray(body) ? body.length : (body.orgs ?? []).length;
}

describe("studio-api session hardening (story 0.14)", () => {
  test("COOKIE_FLAGS: sign-in over https sets Secure, HttpOnly and SameSite=Lax on the session cookie", async () => {
    const { setCookie } = await signUp("flags");
    expect(setCookie).toContain("better-auth.session_token=");
    const attrs = cookieAttributes(setCookie);
    expect(attrs).toContain("secure");
    expect(attrs).toContain("httponly");
    expect(attrs).toContain("samesite=lax");
  });

  test("COOKIE_DEV: on http://localhost the cookie keeps HttpOnly and SameSite; Secure is off", async () => {
    const { setCookie } = await signUp("dev", "http://localhost");
    const attrs = cookieAttributes(setCookie);
    expect(attrs).toContain("httponly");
    expect(attrs).toContain("samesite=lax");
    expect(attrs).not.toContain("secure");
  });

  test("HASHED_STORE and DB_ROW_REPLAY: the row holds sha256(token); the stored value is refused as bearer and cookie", async () => {
    const { token, userId } = await signUp("hashed");
    const row = await studioDb
      .prepare('SELECT "token" FROM "session" WHERE "userId" = ?')
      .bind(userId)
      .first<{ token: string }>();
    expect(row!.token).toBe(await sha256HexString(token));
    expect(row!.token).not.toBe(token);

    expect((await call("/api/auth/me", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await call("/api/auth/me", { headers: { authorization: `Bearer ${row!.token}` } })).status).toBe(401);
    expect(
      (await call("/api/auth/me", { headers: { cookie: `better-auth.session_token=${row!.token}` } })).status,
    ).toBe(401);
  });

  test("MIGRATED_SESSION: a row written before the change keeps working with its original token after the schema step", async () => {
    const { userId } = await signUp("legacy");
    const legacyToken = "StudioLegacyRawSessionToken01234";
    await studioDb.prepare('UPDATE "session" SET "token" = ? WHERE "userId" = ?').bind(legacyToken, userId).run();

    // The schema step's sweep runs once per isolate (already done here), so this row is rewritten on first use.
    await ensureStudioD1Schema(studioDb);
    expect((await call("/api/auth/me", { headers: { authorization: `Bearer ${legacyToken}` } })).status).toBe(200);
    const row = await studioDb
      .prepare('SELECT "token" FROM "session" WHERE "userId" = ?')
      .bind(userId)
      .first<{ token: string }>();
    expect(row!.token).toBe(await sha256HexString(legacyToken));
    expect((await call("/api/auth/me", { headers: { authorization: `Bearer ${legacyToken}` } })).status).toBe(200);

    // The full sweep itself (what the schema step runs once per isolate) rewrites every legacy row.
    const other = await signUp("legacy-sweep");
    const legacyToken2 = "StudioLegacyRawSessionTokenSweep1";
    await studioDb.prepare('UPDATE "session" SET "token" = ? WHERE "userId" = ?').bind(legacyToken2, other.userId).run();
    expect(await hashLegacySessionTokens(studioDb)).toBe(1);
    expect((await call("/api/auth/me", { headers: { authorization: `Bearer ${legacyToken2}` } })).status).toBe(200);
  });

  test("CSRF_CROSS_SITE: a cookie-authenticated POST from another origin is refused 403 CSRF_ORIGIN_MISMATCH with no state change", async () => {
    const { token, cookie } = await signUp("csrf");
    const before = await orgCount(token);
    const res = await call("/api/orgs", {
      body: { name: "Forged Org" },
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CSRF_ORIGIN_MISMATCH");
    expect(await orgCount(token)).toBe(before);

    // Cross-site Sec-Fetch-Site with no Origin, and no browser headers at all: refused too.
    const variants: Array<Record<string, string>> = [{ cookie, "sec-fetch-site": "cross-site" }, { cookie }];
    for (const headers of variants) {
      const refused = await call("/api/orgs", { body: { name: "Forged Org" }, headers });
      expect(refused.status).toBe(403);
    }
    expect(await orgCount(token)).toBe(before);
  });

  test("CSRF_SAME_ORIGIN and BEARER_EXEMPT: a same-origin or listed-origin cookie POST works, and so does a bearer POST with no Origin", async () => {
    const { token, cookie } = await signUp("same-origin");
    const sameOrigin = await call("/api/orgs", {
      body: { name: "Same Origin Org" },
      headers: { cookie, origin: BASE },
    });
    expect(sameOrigin.status).toBe(201);

    const listed = await call("/api/orgs", {
      body: { name: "Listed Origin Org" },
      headers: { cookie, origin: "https://studio.example" },
      env: { ...rawEnv, PX_ALLOWED_ORIGINS: "https://studio.example" },
    });
    expect(listed.status).toBe(201);

    const bearer = await call("/api/orgs", {
      body: { name: "Bearer Org" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(bearer.status).toBe(201);
  });

  test("signed webhook ingress keeps its own check and is not Origin-checked", async () => {
    const { cookie } = await signUp("webhook");
    const res = await call("/api/projects/hardening-proj/telemetry/webhook", {
      body: { events: [] },
      headers: { cookie, origin: "https://evil.example" },
    });
    const text = await res.text();
    expect(text).not.toContain("CSRF_ORIGIN_MISMATCH");
    // Without a valid signature the route still refuses on its own terms.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("CORS_ALLOWED and CORS_DENIED: preflight from a listed origin is allowed with credentials; an unlisted one gets no allow headers", async () => {
    const corsEnv = { ...rawEnv, PX_ALLOWED_ORIGINS: "https://studio.example" };
    const allowed = await call("/api/orgs", {
      method: "OPTIONS",
      env: corsEnv,
      headers: {
        origin: "https://studio.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, authorization",
      },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://studio.example");
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");
    expect(allowed.headers.get("access-control-allow-headers")).toContain("authorization");

    const denied = await call("/api/orgs", {
      method: "OPTIONS",
      env: corsEnv,
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    expect(denied.headers.get("access-control-allow-credentials")).toBeNull();

    // An actual (non-preflight) response carries the allow headers only for a listed origin.
    const { token } = await signUp("cors");
    const listedGet = await call("/api/orgs", {
      env: corsEnv,
      headers: { authorization: `Bearer ${token}`, origin: "https://studio.example" },
    });
    expect(listedGet.headers.get("access-control-allow-origin")).toBe("https://studio.example");
    const unlistedGet = await call("/api/orgs", {
      env: corsEnv,
      headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" },
    });
    expect(unlistedGet.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("WS_ORIGIN: a WebSocket upgrade from an unlisted origin is refused; a same-origin one is accepted", async () => {
    const project = `ws-origin-${crypto.randomUUID().slice(0, 8)}`;
    const human = await signInTestHuman(rawEnv, "ws-origin", "owner", project);

    const refused = await call(`/api/projects/${project}/ws`, {
      headers: { ...human.headers, upgrade: "websocket", origin: "https://evil.example" },
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("WS_ORIGIN_NOT_ALLOWED");

    const accepted = await call(`/api/projects/${project}/ws`, {
      headers: { ...human.headers, upgrade: "websocket", origin: BASE },
    });
    expect(accepted.status).toBe(101);
    const socket = (accepted as Response & { webSocket?: WebSocket }).webSocket;
    socket?.accept();
    socket?.close(1000, "done");
  });
});
