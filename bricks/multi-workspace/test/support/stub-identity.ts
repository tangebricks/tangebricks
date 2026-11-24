import type { MiddlewareHandler } from "hono";

/**
 * STUB IDENTITY, for tests only (C8: the proof uses stub identity, not Supabase). It trusts a plain header, which is
 * exactly what a real project must never do; a real project puts its JWT verification here instead. Nothing in
 * packages/*\/src imports this file.
 *
 * `x-test-user: user-1` authenticates as user-1; no header leaves the request unauthenticated.
 */
export const stubIdentity: MiddlewareHandler = async (c, next) => {
  const uid = c.req.header("x-test-user");
  if (uid) c.set("user", { id: uid, uid, email: `${uid}@example.com` });
  return await next();
};
