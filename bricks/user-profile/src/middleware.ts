import type { MiddlewareHandler } from "hono";
import type { D1Like } from "@poc/sdk";
import { UserProfileService, type UserProfile } from "./profile.ts";

export interface ProfileEnv {
  Bindings: { DB: D1Like };
  Variables: {
    user?: { uid: string; email?: string };
    profile?: UserProfile;
    profileService?: UserProfileService;
  };
}

/**
 * Middleware that loads the caller's profile and attaches it to the Hono request context.
 */
export const profileContextMiddleware: MiddlewareHandler<ProfileEnv> = async (c, next) => {
  const service = new UserProfileService(c.env.DB);
  c.set("profileService", service);

  const user = c.get("user");
  if (user?.uid) {
    const profile = await service.getProfile(user.uid);
    c.set("profile", profile);
  }

  await next();
};
