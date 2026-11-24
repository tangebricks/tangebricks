import { betterAuth } from "better-auth";
import { getAdapter } from "better-auth/db/adapter";
import { bearer } from "better-auth/plugins/bearer";
import { hardenedBetterAuthOptions, hashedSessionDatabase } from "@poc/sdk";
import type { AuthUser, D1Like } from "@poc/sdk";

export type { AuthUser };

export interface AuthEnv {
  DB: D1Like;
  BETTER_AUTH_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Comma-separated origins allowed to call with credentials (CORS and CSRF); unset = same origin only. */
  PX_ALLOWED_ORIGINS?: string;
}

export interface AuthSession {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  token: string;
  expiresAt: string;
}

function requireSecret(name: string, value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required secret ${name}`);
  }
  return value;
}

/**
 * One Better Auth instance for one request. Session settings (cookie attributes, trusted origins, rate limit) are all
 * explicit, from `hardenedBetterAuthOptions`; session tokens are stored as sha256 digests (`hashedSessionDatabase`).
 * `requestHeaders` lets the rate limiter key on the Cloudflare client address when there is one.
 */
export function createBetterAuth(
  env: AuthEnv,
  requestUrl?: string,
  sessionDurationSeconds = 86400,
  requestHeaders?: Headers,
) {
  const requestOrigin = requestUrl ? new URL(requestUrl).origin : "https://example.test";
  // No fallback: a missing signing secret must fail loudly, never sign sessions with a value written in source.
  const secret = requireSecret("BETTER_AUTH_SECRET", env.BETTER_AUTH_SECRET);
  const githubClientId = env.GITHUB_CLIENT_ID?.trim();
  const githubClientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  const hardening = hardenedBetterAuthOptions({
    requestUrl: requestOrigin,
    env,
    sessionDurationSeconds,
    hasClientIp: Boolean(requestHeaders?.get("cf-connecting-ip")),
  });

  return betterAuth({
    database: hashedSessionDatabase(getAdapter, env.DB) as unknown as Record<string, unknown>,
    baseURL: requestOrigin,
    basePath: "/api/auth",
    secret,
    trustedOrigins: hardening.trustedOrigins,
    advanced: hardening.advanced,
    session: hardening.session,
    rateLimit: hardening.rateLimit,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
    // GitHub sign-in is configured only when both credentials are provided.
    socialProviders:
      githubClientId && githubClientSecret
        ? { github: { clientId: githubClientId, clientSecret: githubClientSecret } }
        : {},
    plugins: [bearer()],
  });
}

export function normalizeAuthHeaders(rawHeaders: Headers): { headers: Headers; presentedCredentials: boolean } {
  const headers = new Headers(rawHeaders);
  const authHeader = headers.get("authorization")?.trim() ?? "";
  const cookieHeader = headers.get("cookie") ?? "";
  const hasBearer = authHeader.length > 0;
  const hasSessionCookie =
    cookieHeader.includes("better-auth.session_token=") ||
    cookieHeader.includes("__Secure-better-auth.session_token=");

  if (cookieHeader.includes("__Secure-better-auth.session_token=") && !cookieHeader.includes("; better-auth.session_token=")) {
    headers.set(
      "cookie",
      cookieHeader.replaceAll("__Secure-better-auth.session_token=", "better-auth.session_token="),
    );
  }

  return {
    headers,
    presentedCredentials: hasBearer || hasSessionCookie,
  };
}

export async function resolveAuthSession(
  env: AuthEnv,
  request: Request,
  sessionDurationSeconds = 86400,
): Promise<{
  user: AuthUser | null;
  session: AuthSession | null;
  presentedCredentials: boolean;
}> {
  const { headers, presentedCredentials } = normalizeAuthHeaders(request.headers);
  if (!presentedCredentials) {
    return { user: null, session: null, presentedCredentials: false };
  }

  const auth = createBetterAuth(env, request.url, sessionDurationSeconds);
  const resolved = await auth.api.getSession({ headers }).catch(() => null);
  if (!resolved || !resolved.session || !resolved.user) {
    return { user: null, session: null, presentedCredentials: true };
  }

  const expiresAtIso =
    resolved.session.expiresAt instanceof Date
      ? resolved.session.expiresAt.toISOString()
      : String(resolved.session.expiresAt);
  const expiresAtMs = Date.parse(expiresAtIso);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return { user: null, session: null, presentedCredentials: true };
  }

  const createdAtIso =
    resolved.user.createdAt instanceof Date
      ? resolved.user.createdAt.toISOString()
      : String(resolved.user.createdAt);

  return {
    user: {
      id: resolved.user.id,
      uid: resolved.user.id,
      email: resolved.user.email,
      displayName: resolved.user.name ?? null,
      emailVerified: Boolean(resolved.user.emailVerified),
      createdAt: createdAtIso,
    },
    session: {
      id: resolved.session.id,
      userId: resolved.user.id,
      email: resolved.user.email,
      displayName: resolved.user.name ?? null,
      token: resolved.session.token,
      expiresAt: expiresAtIso,
    },
    presentedCredentials: true,
  };
}
