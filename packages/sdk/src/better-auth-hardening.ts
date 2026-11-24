// The explicit Better Auth session settings every Worker in this repository uses (story 0.14). Each value is set on
// purpose; none is left to a library default. What the 1.7.25 defaults are, and where they live in
// node_modules/better-auth, is recorded in the story's Implementation Notes.
//
// Kept free of better-auth types so the SDK does not depend on it; the shapes match BetterAuthOptions.
import type { D1Like } from "./d1.ts";
import { allowedOriginsFromEnv, sessionCookieSecure, trustedOriginsFor } from "./http-guards.ts";
import { withHashedSessionTokens, type SessionAdapterLike } from "./session-token-hash.ts";

export interface BetterAuthHardeningInput {
  /** The URL of the request the auth instance serves. */
  requestUrl: string;
  /** The Worker env; `PX_ALLOWED_ORIGINS` is read from it. */
  env: unknown;
  /** Session lifetime in seconds. */
  sessionDurationSeconds: number;
  /**
   * Whether the request carries the client address Cloudflare's edge sets (`cf-connecting-ip`). Rate limiting is keyed
   * on that address; without one every caller would share one bucket and one client could lock everyone out, so the
   * limiter runs only when the address is known.
   */
  hasClientIp?: boolean;
}

/** The session-related BetterAuthOptions fields, all set explicitly. */
export function hardenedBetterAuthOptions(input: BetterAuthHardeningInput) {
  const allowList = allowedOriginsFromEnv(input.env);
  return {
    // The request's own origin, PX_ALLOWED_ORIGINS, and loopback origins on a loopback dev/test server only.
    trustedOrigins: trustedOriginsFor(input.requestUrl, allowList),
    advanced: {
      // Keeps the cookie name `better-auth.session_token` (no `__Secure-` prefix) that clients and the bearer bridge
      // already use; the Secure attribute itself is set below.
      useSecureCookies: false,
      defaultCookieAttributes: {
        // Secure everywhere except a plain-http loopback dev/test server.
        secure: sessionCookieSecure(input.requestUrl),
        httpOnly: true,
        sameSite: "lax" as const,
        path: "/",
      },
      // Better Auth's own Origin/Referer check on cookie requests to its endpoints, and its callbackURL validation.
      disableCSRFCheck: false,
      disableOriginCheck: false,
      // The client address on Cloudflare; x-forwarded-for (the default) can be set by the client.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"], disableIpTracking: false },
    },
    session: {
      expiresIn: input.sessionDurationSeconds,
      updateAge: 86400,
      freshAge: 86400,
      // No session data in cookies: every request reads the (hashed) session row.
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: input.hasClientIp === true,
      // Per isolate: a best-effort limit on requests through Better Auth's own handler (`/api/auth/*`). The custom
      // `auth.api.*` login/signup routes are not covered by it (deferred).
      storage: "memory" as const,
      window: 10,
      max: 100,
      // The credential endpoints' limits, written out rather than left to Better Auth's built-in special rules (same
      // values as 1.7.25's defaults: 3 per 10s for sign-in/sign-up/password/email change, 3 per 60s for reset and
      // verification mail). Custom rules are matched after the built-in ones and take precedence.
      customRules: {
        "/sign-in/*": { window: 10, max: 3 },
        "/sign-up/*": { window: 10, max: 3 },
        "/change-password": { window: 10, max: 3 },
        "/change-email": { window: 10, max: 3 },
        "/request-password-reset": { window: 60, max: 3 },
        "/send-verification-email": { window: 60, max: 3 },
        "/forget-password/*": { window: 60, max: 3 },
      },
    },
  };
}

/**
 * Better Auth's `database` option with hashed session tokens: a function adapter that builds Better Auth's own
 * adapter for `db` (pass `getAdapter` from "better-auth/db/adapter") and wraps it with `withHashedSessionTokens`.
 */
export function hashedSessionDatabase(
  getAdapter: (options: any) => Promise<unknown>,
  db: D1Like,
): (options: Record<string, unknown>) => SessionAdapterLike {
  return (options) =>
    withHashedSessionTokens(getAdapter({ ...options, database: db }) as Promise<SessionAdapterLike>, db);
}
