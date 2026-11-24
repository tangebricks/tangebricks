import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { applyMigration, entityDdl, hashLegacySessionTokens, parseEntities, sha256HexString } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { createEntityRoutes } from "@poc/dynamic-entities";
import { createWorkspaceRoutes, workspaceMiddleware } from "@poc/multi-workspace";
import mwMigrationSql from "../../multi-workspace/migrations/0001_multi_workspace.sql?raw";
import authMigrationSql from "../migrations/0001_core_auth.sql?raw";
import { createAuthRoutes, sessionMiddleware } from "../src/index.ts";
import type { AuthEnv } from "../src/index.ts";

const db = env.DB as unknown as D1Like;

const parsedEntities = parseEntities(
  [
    {
      name: "documents",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "confidential", type: "boolean" },
      ],
    },
  ],
  new Set(["auth", "workspaces"]),
);
if (!parsedEntities.ok) {
  throw new Error(parsedEntities.errors.join("; "));
}
const DOCUMENTS_ENTITY = parsedEntities.entities[0]!;

const TEST_ENV: AuthEnv = {
  DB: db,
  BETTER_AUTH_SECRET: "test-better-auth-secret-key-0123456789abcdef",
  GITHUB_CLIENT_ID: "gh-test-client-id-123",
  GITHUB_CLIENT_SECRET: "gh-test-client-secret-456",
};

function buildApp() {
  const app = new Hono<{ Bindings: AuthEnv }>();
  app.use("/api/*", sessionMiddleware);
  app.route("/api", createAuthRoutes({ sessionDuration: 86400 }));
  app.route("/api", createWorkspaceRoutes());
  app.use("/api/documents", workspaceMiddleware);
  app.use("/api/documents/*", workspaceMiddleware);
  app.route("/api", createEntityRoutes({ entities: [DOCUMENTS_ENTITY] }));
  return app;
}

async function call(
  app: Hono<{ Bindings: AuthEnv }>,
  path: string,
  options: {
    method?: string;
    token?: string;
    cookie?: string;
    workspaceId?: string;
    body?: unknown;
    headers?: Record<string, string>;
    baseUrl?: string;
    env?: AuthEnv & { PX_ALLOWED_ORIGINS?: string };
  } = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.workspaceId) headers.set("x-workspace-id", options.workspaceId);
  let rawBody: string | undefined;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    rawBody = JSON.stringify(options.body);
  }
  return app.fetch(
    new Request(`${options.baseUrl ?? "https://example.test"}${path}`, {
      method: options.method ?? (rawBody !== undefined ? "POST" : "GET"),
      headers,
      body: rawBody,
    }),
    options.env ?? TEST_ENV,
  );
}

beforeEach(async () => {
  await db.prepare('DROP TABLE IF EXISTS "entity_documents"').run();
  await db.prepare('DROP TABLE IF EXISTS "mw_members"').run();
  await db.prepare('DROP TABLE IF EXISTS "mw_workspaces"').run();
  await db.prepare('DROP TABLE IF EXISTS "session"').run();
  await db.prepare('DROP TABLE IF EXISTS "account"').run();
  await db.prepare('DROP TABLE IF EXISTS "verification"').run();
  await db.prepare('DROP TABLE IF EXISTS "user"').run();
  await applyMigration(db, authMigrationSql);
  await applyMigration(db, mwMigrationSql);
  await applyMigration(db, entityDdl(DOCUMENTS_ENTITY));
});

describe("core-auth on Better Auth in workerd + D1", () => {
  test("1. sign-up, then sign-in, then an authenticated request succeeds (bearer token and session cookie), and sign-out revokes session", async () => {
    const app = buildApp();

    // Sign-up via Better Auth native endpoint
    const signUpRes = await call(app, "/api/auth/sign-up/email", {
      body: {
        email: "alice@example.com",
        password: "correct-horse-battery-staple",
        name: "Alice Liddell",
      },
    });
    expect(signUpRes.status).toBe(200);
    const signUpData = (await signUpRes.json()) as {
      token: string;
      user: { id: string; email: string; name: string };
    };
    expect(signUpData.user.email).toBe("alice@example.com");
    expect(signUpData.user.name).toBe("Alice Liddell");
    expect(signUpData.token).toBeTruthy();

    // Sign-in with email + password
    const signInRes = await call(app, "/api/auth/sign-in/email", {
      body: {
        email: "alice@example.com",
        password: "correct-horse-battery-staple",
      },
    });
    expect(signInRes.status).toBe(200);
    const signInCookie = signInRes.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(signInCookie).toContain("better-auth.session_token=");
    const signInData = (await signInRes.json()) as {
      token: string;
      user: { id: string; email: string; name: string };
    };
    expect(signInData.token).toBeTruthy();

    // Authenticated request via Bearer token succeeds
    const meBearerRes = await call(app, "/api/auth/me", {
      token: signInData.token,
    });
    expect(meBearerRes.status).toBe(200);
    const meBearerBody = (await meBearerRes.json()) as {
      user: { id: string; email: string; displayName: string };
      session: { id: string; expiresAt: string };
    };
    expect(meBearerBody.user).toEqual({
      id: signUpData.user.id,
      email: "alice@example.com",
      displayName: "Alice Liddell",
    });

    // Authenticated request via session cookie succeeds
    const meCookieRes = await call(app, "/api/auth/me", {
      cookie: signInCookie,
    });
    expect(meCookieRes.status).toBe(200);
    const meCookieBody = (await meCookieRes.json()) as { user: { id: string } };
    expect(meCookieBody.user.id).toBe(signUpData.user.id);

    // Sign-out revokes the session in D1
    const logoutRes = await call(app, "/api/auth/logout", {
      method: "POST",
      token: signInData.token,
    });
    expect(logoutRes.status).toBe(200);

    const afterLogoutRes = await call(app, "/api/auth/me", {
      token: signInData.token,
    });
    expect(afterLogoutRes.status).toBe(401);
  });

  test("2. a forged or modified session token or cookie returns 401", async () => {
    const app = buildApp();

    const signUpRes = await call(app, "/api/auth/signup", {
      body: {
        email: "bob@example.com",
        password: "super-secret-password",
        displayName: "Bob",
      },
    });
    expect(signUpRes.status).toBe(201);
    const signUpCookie = signUpRes.headers.get("set-cookie")?.split(";")[0] ?? "";
    const { token } = (await signUpRes.json()) as { token: string };

    // Forged random Bearer token -> 401
    const forgedBearerRes = await call(app, "/api/auth/me", {
      token: "forged-session-token-does-not-exist",
    });
    expect(forgedBearerRes.status).toBe(401);

    // Modified Bearer token (tampered characters) -> 401
    const modifiedToken = `${token.slice(0, -4)}XXXX`;
    const modifiedBearerRes = await call(app, "/api/workspaces", {
      token: modifiedToken,
    });
    expect(modifiedBearerRes.status).toBe(401);

    // Modified signed session cookie -> 401
    const tamperedCookie = `${signUpCookie.slice(0, -6)}TAMPER`;
    const tamperedCookieRes = await call(app, "/api/auth/me", {
      cookie: tamperedCookie,
    });
    expect(tamperedCookieRes.status).toBe(401);

    // Unauthenticated request without credentials -> 401
    const unauthRes = await call(app, "/api/auth/me");
    expect(unauthRes.status).toBe(401);
  });

  test("3. an expired session (expiry set in the past in D1) returns 401", async () => {
    const app = buildApp();

    const signUpRes = await call(app, "/api/auth/signup", {
      body: {
        email: "carol@example.com",
        password: "carol-password-123",
        displayName: "Carol",
      },
    });
    expect(signUpRes.status).toBe(201);
    const signUpCookie = signUpRes.headers.get("set-cookie")?.split(";")[0] ?? "";
    const { token } = (await signUpRes.json()) as { token: string };

    // Verify valid before expiry
    const validRes = await call(app, "/api/auth/me", { token });
    expect(validRes.status).toBe(200);

    // Backdate session expiry in D1 to the past (story 0.14: the row holds sha256(token), not the token)
    const backdated = await db
      .prepare('UPDATE "session" SET "expiresAt" = ? WHERE "token" = ?')
      .bind("2000-01-01T00:00:00.000Z", await sha256HexString(token))
      .run();
    expect(backdated.meta.changes).toBe(1);

    // Expired Bearer token -> 401
    const expiredBearerRes = await call(app, "/api/auth/me", { token });
    expect(expiredBearerRes.status).toBe(401);

    // Expired session cookie -> 401
    const expiredCookieRes = await call(app, "/api/workspaces", { cookie: signUpCookie });
    expect(expiredCookieRes.status).toBe(401);
  });

  test("4. cross-workspace isolation with real Better Auth sessions denies workspace A member from reading or writing workspace B records (403/404)", async () => {
    const app = buildApp();

    // Sign up Alice (workspace A owner) and Bob (workspace B owner)
    const aliceSignUp = await call(app, "/api/auth/signup", {
      body: { email: "alice-ws@example.com", password: "alice-password-123", displayName: "Alice" },
    });
    expect(aliceSignUp.status).toBe(201);
    const aliceToken = ((await aliceSignUp.json()) as { token: string }).token;

    const bobSignUp = await call(app, "/api/auth/signup", {
      body: { email: "bob-ws@example.com", password: "bob-password-123", displayName: "Bob" },
    });
    expect(bobSignUp.status).toBe(201);
    const bobToken = ((await bobSignUp.json()) as { token: string }).token;

    // Create Workspace A as Alice and Workspace B as Bob
    const createWsA = await call(app, "/api/workspaces", {
      method: "POST",
      token: aliceToken,
      body: { name: "Alice Workspace A" },
    });
    expect(createWsA.status).toBe(201);
    const wsA = ((await createWsA.json()) as { workspace: { id: string } }).workspace.id;

    const createWsB = await call(app, "/api/workspaces", {
      method: "POST",
      token: bobToken,
      body: { name: "Bob Workspace B" },
    });
    expect(createWsB.status).toBe(201);
    const wsB = ((await createWsB.json()) as { workspace: { id: string } }).workspace.id;

    // Bob creates a confidential record in Workspace B
    const bobCreateDoc = await call(app, "/api/documents", {
      method: "POST",
      token: bobToken,
      workspaceId: wsB,
      body: { title: "Workspace B Secret Spec", confidential: true },
    });
    expect(bobCreateDoc.status).toBe(201);
    const bobDocId = ((await bobCreateDoc.json()) as { item: { id: string } }).item.id;

    // Alice (member of Workspace A only) cannot read Bob's record by targeting Workspace B -> 403
    const aliceReadTargetB = await call(app, `/api/documents/${bobDocId}`, {
      method: "GET",
      token: aliceToken,
      workspaceId: wsB,
    });
    expect(aliceReadTargetB.status).toBe(403);

    // Alice cannot read Bob's record through her own Workspace A -> 404
    const aliceReadOwnA = await call(app, `/api/documents/${bobDocId}`, {
      method: "GET",
      token: aliceToken,
      workspaceId: wsA,
    });
    expect(aliceReadOwnA.status).toBe(404);

    // Alice cannot write into Workspace B -> 403
    const aliceWriteTargetB = await call(app, "/api/documents", {
      method: "POST",
      token: aliceToken,
      workspaceId: wsB,
      body: { title: "Unauthorized Write", confidential: false },
    });
    expect(aliceWriteTargetB.status).toBe(403);

    // Alice cannot update or delete Bob's record through Workspace A -> 404
    const aliceDeleteViaA = await call(app, `/api/documents/${bobDocId}`, {
      method: "DELETE",
      token: aliceToken,
      workspaceId: wsA,
    });
    expect(aliceDeleteViaA.status).toBe(404);
  });

  test("5. GitHub OAuth start route returns redirect URL with expected params and callback against mocked GitHub endpoints creates user and session", async () => {
    const app = buildApp();

    // Start GitHub OAuth sign-in flow
    const startRes = await call(app, "/api/auth/sign-in/social", {
      method: "POST",
      body: {
        provider: "github",
        callbackURL: "https://example.test/dashboard",
      },
    });
    expect(startRes.status).toBe(200);
    const stateCookie = startRes.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(stateCookie).toContain("better-auth.state=");

    const startBody = (await startRes.json()) as { url: string; redirect: boolean };
    expect(startBody.redirect).toBe(true);
    const authorizeUrl = new URL(startBody.url);
    expect(authorizeUrl.origin).toBe("https://github.com");
    expect(authorizeUrl.pathname).toBe("/login/oauth/authorize");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("gh-test-client-id-123");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe("https://example.test/api/auth/callback/github");
    expect(authorizeUrl.searchParams.get("scope")).toContain("user:email");
    const state = authorizeUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    // Mock GitHub token exchange and user profile endpoints
    const origFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("github.com/login/oauth/access_token")) {
        return new Response(
          JSON.stringify({
            access_token: "gho_test_access_token_999",
            token_type: "bearer",
            scope: "read:user,user:email",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("api.github.com/user")) {
        return new Response(
          JSON.stringify({
            id: 424242,
            login: "octocat",
            name: "Mona Octocat",
            email: "mona@github.com",
            avatar_url: "https://avatars.githubusercontent.com/u/424242",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("api.github.com/user/emails")) {
        return new Response(
          JSON.stringify([
            {
              email: "mona@github.com",
              primary: true,
              verified: true,
              visibility: "public",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return origFetch(input, init);
    });

    try {
      const callbackRes = await call(
        app,
        `/api/auth/callback/github?code=gh_auth_code_xyz&state=${encodeURIComponent(state!)}`,
        {
          method: "GET",
          cookie: stateCookie,
        },
      );
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.get("location")).toBe("https://example.test/dashboard");

      const signedToken = callbackRes.headers.get("set-auth-token");
      expect(signedToken).toBeTruthy();

      // Verify user and session were persisted in D1 and authenticate protected requests
      const meRes = await call(app, "/api/auth/me", {
        token: signedToken!,
      });
      expect(meRes.status).toBe(200);
      const meBody = (await meRes.json()) as {
        user: { id: string; email: string; displayName: string };
        session: { id: string };
      };
      expect(meBody.user.email).toBe("mona@github.com");
      expect(meBody.user.displayName).toBe("Mona Octocat");
      expect(meBody.session.id).toBeTruthy();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// Story 0.14 (S6): session hardening. One test per row of the story's I/O matrix that core-auth owns.
describe("core-auth session hardening (story 0.14)", () => {
  async function signUp(app: Hono<{ Bindings: AuthEnv }>, email: string, baseUrl?: string) {
    const res = await call(app, "/api/auth/signup", {
      body: { email, password: "hardening-password-123", displayName: "Hardening" },
      ...(baseUrl ? { baseUrl } : {}),
    });
    expect(res.status).toBe(201);
    const setCookie = res.headers.get("set-cookie") ?? "";
    const { token, user } = (await res.json()) as { token: string; user: { id: string } };
    return { token, userId: user.id, setCookie, cookie: setCookie.split(";")[0] ?? "" };
  }

  function cookieAttributes(setCookie: string): string[] {
    return setCookie
      .split(";")
      .slice(1)
      .map((a) => a.trim().toLowerCase());
  }

  test("COOKIE_FLAGS: sign-in over https sets Secure, HttpOnly and SameSite=Lax", async () => {
    const app = buildApp();
    await signUp(app, "flags@example.com");
    const res = await call(app, "/api/auth/sign-in/email", {
      body: { email: "flags@example.com", password: "hardening-password-123" },
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("better-auth.session_token=");
    const attrs = cookieAttributes(setCookie);
    expect(attrs).toContain("secure");
    expect(attrs).toContain("httponly");
    expect(attrs).toContain("samesite=lax");
  });

  test("COOKIE_DEV: sign-in on http://localhost keeps HttpOnly and SameSite; Secure is off", async () => {
    const app = buildApp();
    await signUp(app, "dev@example.com", "http://localhost");
    const res = await call(app, "/api/auth/sign-in/email", {
      baseUrl: "http://localhost",
      body: { email: "dev@example.com", password: "hardening-password-123" },
    });
    expect(res.status).toBe(200);
    const attrs = cookieAttributes(res.headers.get("set-cookie") ?? "");
    expect(attrs).toContain("httponly");
    expect(attrs).toContain("samesite=lax");
    expect(attrs).not.toContain("secure");
  });

  test("HASHED_STORE and DB_ROW_REPLAY: the session row holds sha256(token), and that value is refused as a bearer or cookie", async () => {
    const app = buildApp();
    const { token, userId } = await signUp(app, "hashed@example.com");
    const row = await db
      .prepare('SELECT "token" FROM "session" WHERE "userId" = ?')
      .bind(userId)
      .first<{ token: string }>();
    expect(row).not.toBeNull();
    expect(row!.token).not.toBe(token);
    expect(row!.token).toBe(await sha256HexString(token));
    expect(row!.token).toMatch(/^[0-9a-f]{64}$/);

    // The raw token still works.
    expect((await call(app, "/api/auth/me", { token })).status).toBe(200);
    // The stored column value is not a credential: as a bearer token, or as an (unsigned) cookie.
    expect((await call(app, "/api/auth/me", { token: row!.token })).status).toBe(401);
    expect((await call(app, "/api/auth/me", { cookie: `better-auth.session_token=${row!.token}` })).status).toBe(401);
  });

  test("MIGRATED_SESSION: a row stored before the change (raw token) still works with the original token, and is rewritten to its hash", async () => {
    const app = buildApp();
    const { token, userId } = await signUp(app, "legacy@example.com");
    // Turn the row back into what a pre-0.14 Worker wrote: the raw token.
    const legacyToken = "LegacyRawSessionToken0123456789ab";
    await db.prepare('UPDATE "session" SET "token" = ? WHERE "userId" = ?').bind(legacyToken, userId).run();
    expect((await call(app, "/api/auth/me", { token })).status).toBe(401);

    // The forward step rewrites every legacy row to its digest; running it again changes nothing.
    expect(await hashLegacySessionTokens(db)).toBe(1);
    expect(await hashLegacySessionTokens(db)).toBe(0);
    const row = await db.prepare('SELECT "token" FROM "session" WHERE "userId" = ?').bind(userId).first<{ token: string }>();
    expect(row!.token).toBe(await sha256HexString(legacyToken));
    expect((await call(app, "/api/auth/me", { token: legacyToken })).status).toBe(200);

    // A legacy row the forward step has not reached yet is upgraded on first use, too.
    const second = await signUp(app, "legacy2@example.com");
    const legacyToken2 = "LegacyRawSessionTokenSecond012345";
    await db.prepare('UPDATE "session" SET "token" = ? WHERE "userId" = ?').bind(legacyToken2, second.userId).run();
    expect((await call(app, "/api/auth/me", { token: legacyToken2 })).status).toBe(200);
    const row2 = await db
      .prepare('SELECT "token" FROM "session" WHERE "userId" = ?')
      .bind(second.userId)
      .first<{ token: string }>();
    expect(row2!.token).toBe(await sha256HexString(legacyToken2));
  });

  test("CSRF_CROSS_SITE: a cookie-authenticated POST from another origin is refused 403 CSRF_ORIGIN_MISMATCH and changes nothing", async () => {
    const app = buildApp();
    const { token, cookie } = await signUp(app, "csrf@example.com");
    const res = await call(app, "/api/auth/logout", {
      method: "POST",
      cookie,
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CSRF_ORIGIN_MISMATCH");
    // The session was not signed out.
    expect((await call(app, "/api/auth/me", { token })).status).toBe(200);

    // A cross-site Referer is refused the same way, and so is a request with no Origin, Referer or Sec-Fetch-Site.
    const viaReferer = await call(app, "/api/auth/logout", {
      method: "POST",
      cookie,
      headers: { referer: "https://evil.example/page" },
    });
    expect(viaReferer.status).toBe(403);
    const bare = await call(app, "/api/auth/logout", { method: "POST", cookie });
    expect(bare.status).toBe(403);
    expect((await call(app, "/api/auth/me", { token })).status).toBe(200);
  });

  test("CSRF_SAME_ORIGIN and BEARER_EXEMPT: an allowed-origin cookie POST and a bearer POST without Origin both work", async () => {
    const app = buildApp();
    const first = await signUp(app, "same-origin@example.com");
    const sameOrigin = await call(app, "/api/auth/logout", {
      method: "POST",
      cookie: first.cookie,
      headers: { origin: "https://example.test" },
    });
    expect(sameOrigin.status).toBe(200);
    expect((await call(app, "/api/auth/me", { token: first.token })).status).toBe(401);

    const listed = await signUp(app, "listed-origin@example.com");
    const fromListed = await call(app, "/api/auth/logout", {
      method: "POST",
      cookie: listed.cookie,
      headers: { origin: "https://app.example" },
      env: { ...TEST_ENV, PX_ALLOWED_ORIGINS: "https://app.example" },
    });
    expect(fromListed.status).toBe(200);

    const fetchMetadata = await signUp(app, "fetch-metadata@example.com");
    const sameOriginByFetchMetadata = await call(app, "/api/auth/logout", {
      method: "POST",
      cookie: fetchMetadata.cookie,
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(sameOriginByFetchMetadata.status).toBe(200);

    const second = await signUp(app, "bearer-exempt@example.com");
    const bearer = await call(app, "/api/auth/logout", { method: "POST", token: second.token });
    expect(bearer.status).toBe(200);
    expect((await call(app, "/api/auth/me", { token: second.token })).status).toBe(401);
  });

  test("CORS_ALLOWED and CORS_DENIED: a preflight from a listed origin is allowed with credentials; an unlisted one gets no allow headers", async () => {
    const app = buildApp();
    const env = { ...TEST_ENV, PX_ALLOWED_ORIGINS: "https://app.example, https://other.example" };
    const allowed = await call(app, "/api/auth/sign-in/email", {
      method: "OPTIONS",
      env,
      headers: {
        origin: "https://app.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");
    expect(allowed.headers.get("access-control-allow-origin")).not.toBe("*");

    const denied = await call(app, "/api/auth/sign-in/email", {
      method: "OPTIONS",
      env,
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    expect(denied.headers.get("access-control-allow-credentials")).toBeNull();

    // With PX_ALLOWED_ORIGINS unset only the request's own origin is allowed.
    const defaultDenied = await call(app, "/api/auth/sign-in/email", {
      method: "OPTIONS",
      headers: { origin: "https://app.example", "access-control-request-method": "POST" },
    });
    expect(defaultDenied.headers.get("access-control-allow-origin")).toBeNull();
  });
});

// Story 0.14 review: Better Auth's own session-management endpoints keep working with hashed storage.
describe("core-auth hashed sessions and Better Auth session management (story 0.14)", () => {
  const PASSWORD = "revoke-password-123";

  async function signUpAndIn(app: Hono<{ Bindings: AuthEnv }>, email: string): Promise<{ first: string; second: string }> {
    const up = await call(app, "/api/auth/signup", { body: { email, password: PASSWORD, displayName: "Revoke" } });
    expect(up.status).toBe(201);
    const first = ((await up.json()) as { token: string }).token;
    const signIn = await call(app, "/api/auth/login", { body: { email, password: PASSWORD } });
    expect(signIn.status).toBe(200);
    const second = ((await signIn.json()) as { token: string }).token;
    expect(second).not.toBe(first);
    return { first, second };
  }

  test("revoke-other-sessions keeps the caller signed in and signs the other session out", async () => {
    const app = buildApp();
    const { first, second } = await signUpAndIn(app, "revoke-others@example.com");
    const res = await call(app, "/api/auth/revoke-other-sessions", { method: "POST", token: first, body: {} });
    expect(res.status).toBe(200);
    expect((await call(app, "/api/auth/me", { token: first })).status).toBe(200);
    expect((await call(app, "/api/auth/me", { token: second })).status).toBe(401);
  });

  test("revoke-session with a value from list-sessions revokes exactly that session of the caller; that value is never a credential", async () => {
    const app = buildApp();
    const { first, second } = await signUpAndIn(app, "revoke-one@example.com");

    const list = await call(app, "/api/auth/list-sessions", { token: first });
    expect(list.status).toBe(200);
    const sessions = (await list.json()) as Array<{ token: string }>;
    expect(sessions).toHaveLength(2);
    // The caller's own session is listed with its own token; the other one only in stored-row form.
    expect(sessions.map((s) => s.token)).toContain(first);
    const other = sessions.find((s) => s.token !== first)!;
    expect(other.token).toBe(`sha256.${await sha256HexString(second)}`);
    expect(JSON.stringify(sessions)).not.toContain(second);

    // The listed value cannot authenticate: as a bearer, as a cookie, or with the prefix stripped.
    expect((await call(app, "/api/auth/me", { token: other.token })).status).toBe(401);
    expect((await call(app, "/api/auth/me", { cookie: `better-auth.session_token=${other.token}` })).status).toBe(401);
    expect((await call(app, "/api/auth/me", { token: other.token.slice("sha256.".length) })).status).toBe(401);

    // Another user cannot revoke it.
    const stranger = await signUpAndIn(app, "revoke-stranger@example.com");
    const foreign = await call(app, "/api/auth/revoke-session", { method: "POST", token: stranger.first, body: { token: other.token } });
    expect(foreign.status).toBe(200);
    expect((await call(app, "/api/auth/me", { token: second })).status).toBe(200);

    // Its owner can, and only that session goes.
    const revoked = await call(app, "/api/auth/revoke-session", { method: "POST", token: first, body: { token: other.token } });
    expect(revoked.status).toBe(200);
    expect((await call(app, "/api/auth/me", { token: second })).status).toBe(401);
    expect((await call(app, "/api/auth/me", { token: first })).status).toBe(200);
    expect((await call(app, "/api/auth/me", { token: stranger.first })).status).toBe(200);
  });
});
