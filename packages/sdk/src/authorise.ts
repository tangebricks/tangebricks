import type { RequestContext } from "./request-context.ts";
import { isPlatformOperator } from "./platform-operator.ts";

/** Workspace roles that may run workspace-scoped admin actions. */
export const WORKSPACE_ADMIN_ROLES: readonly string[] = Object.freeze(["owner", "admin"]);
/** Workspace roles that may run destructive whole-workspace data actions (export, erasure, workspace delete). */
export const WORKSPACE_OWNER_ROLES: readonly string[] = Object.freeze(["owner"]);

/** Why a caller was refused: 401 when nobody is signed in, 403 when the signed-in caller lacks the role. */
export interface AuthRefusal {
  status: 401 | 403;
  body: { error: string };
}

const UNAUTHORIZED: AuthRefusal = Object.freeze({ status: 401, body: Object.freeze({ error: "Unauthorized" }) }) as AuthRefusal;
const FORBIDDEN: AuthRefusal = Object.freeze({ status: 403, body: Object.freeze({ error: "Forbidden" }) }) as AuthRefusal;

/** The signed-in user's id from an identity middleware's `user` variable (`uid` or `id`), or undefined. */
export function authUserId(user: unknown): string | undefined {
  if (!user || typeof user !== "object") return undefined;
  const u = user as { uid?: unknown; id?: unknown };
  if (typeof u.uid === "string" && u.uid.length > 0) return u.uid;
  if (typeof u.id === "string" && u.id.length > 0) return u.id;
  return undefined;
}

/**
 * Checks the caller's workspace role against `allowed`, using only the verified context set by the workspace
 * middleware (`ctx`), never anything the caller sent. Returns the refusal to send, or undefined when the caller may
 * proceed. Run it before reading or validating the body, so a low-role caller gets 403 and not 400.
 */
export function workspaceRoleRefusal(
  user: unknown,
  ctx: RequestContext | undefined,
  allowed: readonly string[],
): AuthRefusal | undefined {
  if (!authUserId(user) && !ctx) return UNAUTHORIZED;
  if (!ctx || !allowed.includes(ctx.role)) return FORBIDDEN;
  return undefined;
}

/**
 * Checks that the caller is a platform operator (see `isPlatformOperator`). For writes to all-tenant tables, which no
 * workspace role may make. `extraOperator` lets a brick add its own source of operators (admin-console's super-admin
 * table); it is only consulted for a signed-in caller.
 */
export async function platformOperatorRefusal(
  env: unknown,
  user: unknown,
  ctx: RequestContext | undefined,
  extraOperator?: (userId: string) => Promise<boolean> | boolean,
): Promise<AuthRefusal | undefined> {
  const userId = ctx?.userId || authUserId(user);
  if (!userId) return UNAUTHORIZED;
  if (isPlatformOperator(env, userId)) return undefined;
  if (extraOperator && (await extraOperator(userId))) return undefined;
  return FORBIDDEN;
}
