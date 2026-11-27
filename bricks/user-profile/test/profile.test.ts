import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_user_profile.sql?raw";
import { UserProfileService, createProfileRoutes } from "../src/index.ts";
import type { ProfileEnv } from "../src/middleware.ts";

const db = env.DB as D1Like;
const USER_ALICE = "usr_alice_123";
const USER_BOB = "usr_bob_456";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS profile_users").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("User Profile Service Core Logic", () => {
  it("returns default virtual profile for fresh user", async () => {
    const service = new UserProfileService(db, { defaultTheme: "dark", defaultLocale: "fr" });
    const profile = await service.getProfile(USER_ALICE);

    expect(profile.user_id).toBe(USER_ALICE);
    expect(profile.display_name).toBeNull();
    expect(profile.avatar_url).toBeNull();
    expect(profile.bio).toBeNull();
    expect(profile.locale).toBe("fr");
    expect(profile.theme).toBe("dark");
    expect(profile.preferences).toEqual({});
  });

  it("updates personal profile and saves in D1", async () => {
    const service = new UserProfileService(db);
    const updated = await service.updateProfile(USER_ALICE, {
      displayName: "Alice In Borderland",
      avatarUrl: "https://example.com/alice.png",
      bio: "Software architect and builder",
      locale: "en-US",
      timezone: "America/New_York",
      theme: "dark",
    });

    expect(updated.display_name).toBe("Alice In Borderland");
    expect(updated.avatar_url).toBe("https://example.com/alice.png");
    expect(updated.bio).toBe("Software architect and builder");
    expect(updated.locale).toBe("en-US");
    expect(updated.timezone).toBe("America/New_York");
    expect(updated.theme).toBe("dark");

    // Fetch again from DB to verify persistence
    const reloaded = await service.getProfile(USER_ALICE);
    expect(reloaded.display_name).toBe("Alice In Borderland");
    expect(reloaded.theme).toBe("dark");
  });

  it("merges custom user preferences and enforces 4096 byte payload limit", async () => {
    const service = new UserProfileService(db);
    await service.updateProfile(USER_ALICE, { displayName: "Alice" });

    // Initial preference update
    const res1 = await service.updatePreferences(USER_ALICE, {
      notifications: { email: true, push: false },
      soundEnabled: true,
    });
    expect(res1.ok).toBe(true);
    expect(res1.profile?.preferences).toEqual({
      notifications: { email: true, push: false },
      soundEnabled: true,
    });

    // Merge additional preference
    const res2 = await service.updatePreferences(USER_ALICE, {
      soundEnabled: false,
      compactView: true,
    });
    expect(res2.ok).toBe(true);
    expect(res2.profile?.preferences).toEqual({
      notifications: { email: true, push: false },
      soundEnabled: false,
      compactView: true,
    });

    // Enforce 4096 byte payload limit
    const hugeString = "x".repeat(5000);
    const resOverflow = await service.updatePreferences(USER_ALICE, { huge: hugeString });
    expect(resOverflow.ok).toBe(false);
    expect(resOverflow.error).toContain("exceeds maximum allowed size");
  });

  it("provides public profile lookup without leaking private preferences", async () => {
    const service = new UserProfileService(db);
    await service.updateProfile(USER_ALICE, {
      displayName: "Alice Public",
      avatarUrl: "https://example.com/alice.jpg",
      bio: "Hello world",
    });
    await service.updatePreferences(USER_ALICE, { secretApiKey: "12345", privateNotes: "shh" });

    const pub = await service.getPublicProfile(USER_ALICE);
    expect(pub).not.toBeNull();
    expect(pub?.user_id).toBe(USER_ALICE);
    expect(pub?.display_name).toBe("Alice Public");
    expect(pub?.avatar_url).toBe("https://example.com/alice.jpg");
    expect(pub?.bio).toBe("Hello world");
    // Preferences should not exist on public profile
    expect((pub as unknown as { preferences?: unknown }).preferences).toBeUndefined();

    // Missing user returns null
    expect(await service.getPublicProfile("usr_ghost_999")).toBeNull();
  });

  it("strictly isolates profiles between different users", async () => {
    const service = new UserProfileService(db);
    await service.updateProfile(USER_ALICE, { displayName: "Alice Wonder" });
    await service.updateProfile(USER_BOB, { displayName: "Bob Builder" });

    const alice = await service.getProfile(USER_ALICE);
    const bob = await service.getProfile(USER_BOB);

    expect(alice.display_name).toBe("Alice Wonder");
    expect(bob.display_name).toBe("Bob Builder");
  });
});

describe("User Profile HTTP API", () => {
  it("protects /me endpoints from unauthenticated callers", async () => {
    const app = new Hono<ProfileEnv>();
    app.route("/api", createProfileRoutes());

    const res = await app.request("/api/me/profile", {}, { DB: db });
    expect(res.status).toBe(401);
  });

  it("handles profile retrieval and updates via HTTP", async () => {
    const app = new Hono<ProfileEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { uid: USER_ALICE, email: "alice@example.com" });
      await next();
    });
    app.route("/api", createProfileRoutes());

    // 1. GET initial profile
    const getRes = await app.request("/api/me/profile", {}, { DB: db });
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as { profile: { user_id: string } };
    expect(getJson.profile.user_id).toBe(USER_ALICE);

    // 2. PATCH profile
    const patchRes = await app.request(
      "/api/me/profile",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: "Alice In Wonderland",
          theme: "dark",
          bio: "Curiouser and curiouser",
        }),
      },
      { DB: db },
    );
    expect(patchRes.status).toBe(200);
    const patchJson = (await patchRes.json()) as { profile: { display_name: string; theme: string } };
    expect(patchJson.profile.display_name).toBe("Alice In Wonderland");
    expect(patchJson.profile.theme).toBe("dark");

    // 3. PATCH preferences
    const prefRes = await app.request(
      "/api/me/preferences",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preferences: { emailDigest: "weekly" },
        }),
      },
      { DB: db },
    );
    expect(prefRes.status).toBe(200);

    // 4. Public lookup
    const pubRes = await app.request(`/api/users/${USER_ALICE}/profile`, {}, { DB: db });
    expect(pubRes.status).toBe(200);
    const pubJson = (await pubRes.json()) as { profile: { display_name: string } };
    expect(pubJson.profile.display_name).toBe("Alice In Wonderland");
  });
});
