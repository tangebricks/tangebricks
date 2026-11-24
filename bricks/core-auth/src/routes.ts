import { Hono } from "hono";
import { z } from "zod";
import { createHttpGuard } from "@poc/sdk";
import { createBetterAuth, normalizeAuthHeaders } from "./auth.ts";
import type { AuthEnv } from "./auth.ts";
import { requireAuth } from "./middleware.ts";

export interface AuthRoutesOptions {
  sessionDuration?: number;
}

const SignupBody = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(256),
  displayName: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120).optional(),
});

const LoginBody = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(256),
});

function copyAuthHeaders(from: Headers, to: (name: string, value: string) => void): void {
  const setCookie = from.get("set-cookie");
  if (setCookie) to("set-cookie", setCookie);
  const setAuthToken = from.get("set-auth-token");
  if (setAuthToken) to("set-auth-token", setAuthToken);
}

export function createAuthRoutes(options: AuthRoutesOptions = {}): Hono<{ Bindings: AuthEnv }> {
  const sessionDuration = options.sessionDuration ?? 86400;
  const router = new Hono<{ Bindings: AuthEnv }>();

  // CSRF (Origin check on cookie-authenticated writes) and the CORS allow-list (PX_ALLOWED_ORIGINS) for the auth
  // routes. The assembled entry mounts the same guard on all of /api.
  router.use("/auth/*", createHttpGuard());

  router.post("/auth/signup", async (c) => {
    const parsed = SignupBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid signup body", issues: parsed.error.issues }, 400);
    }

    const auth = createBetterAuth(c.env, c.req.url, sessionDuration);
    const displayName = parsed.data.displayName ?? parsed.data.name ?? parsed.data.email.split("@")[0] ?? "User";
    const res = await auth.api.signUpEmail({
      body: {
        email: parsed.data.email,
        password: parsed.data.password,
        name: displayName,
      },
      headers: c.req.raw.headers,
      asResponse: true,
    });

    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
      const isDuplicate =
        res.status === 422 ||
        res.status === 409 ||
        errBody.code === "USER_ALREADY_EXISTS" ||
        errBody.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" ||
        (errBody.message ?? "").toLowerCase().includes("already exists");
      return c.json(
        { error: errBody.message ?? "sign-up failed" },
        isDuplicate ? 409 : 400,
      );
    }

    copyAuthHeaders(res.headers, (k, v) => c.header(k, v));
    const data = (await res.json()) as {
      token: string;
      user: { id: string; email: string; name: string; emailVerified?: boolean; createdAt?: string };
    };
    const expiresAt = new Date(Date.now() + sessionDuration * 1000).toISOString();
    return c.json(
      {
        token: data.token,
        user: {
          id: data.user.id,
          email: data.user.email,
          displayName: data.user.name,
        },
        session: {
          token: data.token,
          expiresAt,
        },
      },
      201,
    );
  });

  router.post("/auth/login", async (c) => {
    const parsed = LoginBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid login body", issues: parsed.error.issues }, 400);
    }

    const auth = createBetterAuth(c.env, c.req.url, sessionDuration);
    const res = await auth.api.signInEmail({
      body: {
        email: parsed.data.email,
        password: parsed.data.password,
      },
      headers: c.req.raw.headers,
      asResponse: true,
    });

    if (!res.ok) {
      return c.json({ error: "invalid email or password" }, 401);
    }

    copyAuthHeaders(res.headers, (k, v) => c.header(k, v));
    const data = (await res.json()) as {
      token: string;
      user: { id: string; email: string; name: string };
    };
    const expiresAt = new Date(Date.now() + sessionDuration * 1000).toISOString();
    return c.json({
      token: data.token,
      user: {
        id: data.user.id,
        email: data.user.email,
        displayName: data.user.name,
      },
      session: {
        token: data.token,
        expiresAt,
      },
    });
  });

  router.post("/auth/logout", requireAuth, async (c) => {
    const { headers, presentedCredentials } = normalizeAuthHeaders(c.req.raw.headers);
    if (presentedCredentials) {
      const auth = createBetterAuth(c.env, c.req.url, sessionDuration);
      const res = await auth.api.signOut({ headers, asResponse: true }).catch(() => null);
      if (res) {
        copyAuthHeaders(res.headers, (k, v) => c.header(k, v));
      }
    }
    return c.json({ ok: true });
  });

  router.get("/auth/me", requireAuth, async (c) => {
    const user = c.get("user") as { uid: string; email?: string; displayName?: string };
    const authSession = c.get("authSession");
    return c.json({
      user: {
        id: user.uid,
        email: authSession?.email ?? user.email ?? null,
        displayName: authSession?.displayName ?? user.displayName ?? null,
      },
      session: authSession
        ? {
            id: authSession.id,
            expiresAt: authSession.expiresAt,
          }
        : null,
    });
  });

  router.all("/auth/*", async (c) => {
    const auth = createBetterAuth(c.env, c.req.url, sessionDuration, c.req.raw.headers);
    const { headers } = normalizeAuthHeaders(c.req.raw.headers);
    const req = new Request(c.req.url, {
      method: c.req.method,
      headers,
      body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body,
    });
    return auth.handler(req);
  });

  return router;
}
