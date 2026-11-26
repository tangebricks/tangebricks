export { createBetterAuth, normalizeAuthHeaders, resolveAuthSession } from "./auth.ts";
export type { AuthEnv, AuthSession, AuthUser } from "./auth.ts";
export { requireAuth, sessionMiddleware } from "./middleware.ts";
export type { AuthAppEnv } from "./middleware.ts";
export { createAuthRoutes } from "./routes.ts";
export type { AuthRoutesOptions } from "./routes.ts";
