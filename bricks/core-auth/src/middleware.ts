import type { MiddlewareHandler } from "hono";
import { resolveAuthSession } from "./auth.ts";
import type { AuthEnv } from "./auth.ts";

declare module "hono" {
  interface ContextVariableMap {
    authSession?: {
      id: string;
      userId: string;
      email: string;
      displayName: string | null;
      expiresAt: string;
    };
  }
}

/**
 * Identity middleware mounted on `/api/*` when a blueprint selects `"identity": "core-auth"`.
 * Resolves Better Auth sessions from Bearer tokens or session cookies and populates `c.set("user", ...)`.
 * Forged, modified, or expired credentials presented on any request are rejected with 401.
 */
export const sessionMiddleware: MiddlewareHandler<{ Bindings: AuthEnv }> = async (c, next) => {
  const { user, session, presentedCredentials } = await resolveAuthSession(c.env, c.req.raw);
  if (user && session) {
    c.set("user", {
      uid: user.id,
      email: user.email,
      displayName: user.displayName ?? undefined,
    });
    c.set("authSession", {
      id: session.id,
      userId: session.userId,
      email: session.email,
      displayName: session.displayName,
      expiresAt: session.expiresAt,
    });
    await next();
    return;
  }

  if (presentedCredentials) {
    return c.json({ error: "invalid or expired session" }, 401);
  }

  await next();
};

/**
 * Route-level auth guard for endpoints that always require an authenticated user.
 */
export const requireAuth: MiddlewareHandler<{ Bindings: AuthEnv }> = async (c, next) => {
  const { user, session, presentedCredentials } = await resolveAuthSession(c.env, c.req.raw);
  if (user && session) {
    c.set("user", {
      uid: user.id,
      email: user.email,
      displayName: user.displayName ?? undefined,
    });
    c.set("authSession", {
      id: session.id,
      userId: session.userId,
      email: session.email,
      displayName: session.displayName,
      expiresAt: session.expiresAt,
    });
    await next();
    return;
  }

  if (presentedCredentials) {
    return c.json({ error: "invalid or expired session" }, 401);
  }

  const existing = c.get("user") as { uid?: string; email?: string; displayName?: string } | undefined;
  if (existing && typeof existing.uid === "string" && existing.uid.length > 0) {
    await next();
    return;
  }

  return c.json({ error: "unauthenticated" }, 401);
};
