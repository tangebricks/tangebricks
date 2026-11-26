import { Hono } from "hono";
import { z } from "zod";
import { UserProfileService, type Theme } from "./profile.ts";
import { profileContextMiddleware, type ProfileEnv } from "./middleware.ts";

const UpdateProfileSchema = z.object({
  displayName: z.string().max(100).optional().nullable(),
  avatarUrl: z.string().max(512).optional().nullable(),
  bio: z.string().max(500).optional().nullable(),
  locale: z.string().min(2).max(10).optional(),
  timezone: z.string().min(1).max(64).optional(),
  theme: z.enum(["light", "dark", "system"]).optional(),
});

const UpdatePreferencesSchema = z.object({
  preferences: z.record(z.string(), z.unknown()),
});

export function createProfileRoutes(): Hono<ProfileEnv> {
  const app = new Hono<ProfileEnv>();

  app.use("*", profileContextMiddleware);

  // GET /me/profile - caller profile
  app.get("/me/profile", async (c) => {
    const user = c.get("user");
    if (!user?.uid) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const service = c.get("profileService") || new UserProfileService(c.env.DB);
    const profile = await service.getProfile(user.uid);
    return c.json({ profile }, 200);
  });

  // PATCH /me/profile - update caller profile
  app.patch("/me/profile", async (c) => {
    const user = c.get("user");
    if (!user?.uid) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = UpdateProfileSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const service = c.get("profileService") || new UserProfileService(c.env.DB);
    const updated = await service.updateProfile(user.uid, {
      displayName: parsed.data.displayName,
      avatarUrl: parsed.data.avatarUrl,
      bio: parsed.data.bio,
      locale: parsed.data.locale,
      timezone: parsed.data.timezone,
      theme: parsed.data.theme as Theme | undefined,
    });

    return c.json({ profile: updated }, 200);
  });

  // PATCH /me/preferences - update caller preferences
  app.patch("/me/preferences", async (c) => {
    const user = c.get("user");
    if (!user?.uid) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = UpdatePreferencesSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const service = c.get("profileService") || new UserProfileService(c.env.DB);
    const result = await service.updatePreferences(user.uid, parsed.data.preferences);
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }

    return c.json({ profile: result.profile }, 200);
  });

  // GET /users/:id/profile - public profile lookup
  app.get("/users/:id/profile", async (c) => {
    const userId = c.req.param("id");
    const service = c.get("profileService") || new UserProfileService(c.env.DB);
    const publicProfile = await service.getPublicProfile(userId);

    if (!publicProfile) {
      return c.json({ error: "User not found" }, 404);
    }

    return c.json({ profile: publicProfile }, 200);
  });

  return app;
}
