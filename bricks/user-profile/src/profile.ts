import type { D1Like } from "@poc/sdk";

export type Theme = "light" | "dark" | "system";

export interface UserProfile {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  locale: string;
  timezone: string;
  theme: Theme;
  preferences: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface PublicProfile {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
}

export interface UpdateProfileInput {
  displayName?: string | null;
  avatarUrl?: string | null;
  bio?: string | null;
  locale?: string;
  timezone?: string;
  theme?: Theme;
}

interface RawProfileRow {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  locale: string;
  timezone: string;
  theme: string;
  preferences_json: string;
  created_at: string;
  updated_at: string;
}

export interface UserProfileDefaults {
  theme?: Theme;
  defaultTheme?: Theme;
  locale?: string;
  defaultLocale?: string;
  timezone?: string;
  defaultTimezone?: string;
}

export class UserProfileService {
  private readonly db: D1Like;
  private readonly defaults: UserProfileDefaults;

  constructor(db: D1Like, defaults: UserProfileDefaults = {}) {
    this.db = db;
    this.defaults = defaults;
  }

  private parseRow(row: RawProfileRow): UserProfile {
    let prefs: Record<string, unknown> = {};
    try {
      prefs = JSON.parse(row.preferences_json || "{}");
    } catch {
      prefs = {};
    }

    return {
      user_id: row.user_id,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      bio: row.bio,
      locale: row.locale,
      timezone: row.timezone,
      theme: (["light", "dark", "system"].includes(row.theme) ? row.theme : "system") as Theme,
      preferences: prefs,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * Retrieves user profile. If user has not customized their profile yet,
   * returns default values.
   */
  async getProfile(userIdRaw: string): Promise<UserProfile> {
    const userId = userIdRaw.trim();
    const row = await this.db.prepare(
      "SELECT user_id, display_name, avatar_url, bio, locale, timezone, theme, preferences_json, created_at, updated_at FROM profile_users WHERE user_id = ?"
    ).bind(userId).first<RawProfileRow>();

    if (row) {
      return this.parseRow(row);
    }

    // Return virtual default profile
    const now = new Date().toISOString();
    return {
      user_id: userId,
      display_name: null,
      avatar_url: null,
      bio: null,
      locale: this.defaults.locale || this.defaults.defaultLocale || "en",
      timezone: this.defaults.timezone || this.defaults.defaultTimezone || "UTC",
      theme: this.defaults.theme || this.defaults.defaultTheme || "system",
      preferences: {},
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * Public profile lookup exposing only non-sensitive user identity.
   */
  async getPublicProfile(userIdRaw: string): Promise<PublicProfile | null> {
    const userId = userIdRaw.trim();
    interface PublicRow {
      user_id: string;
      display_name: string | null;
      avatar_url: string | null;
      bio: string | null;
    }

    const row = await this.db.prepare(
      "SELECT user_id, display_name, avatar_url, bio FROM profile_users WHERE user_id = ?"
    ).bind(userId).first<PublicRow>();

    if (!row) return null;
    return row;
  }

  /**
   * Creates or updates the user's personal profile.
   */
  async updateProfile(userIdRaw: string, input: UpdateProfileInput): Promise<UserProfile> {
    const userId = userIdRaw.trim();
    const existing = await this.getProfile(userId);

    const displayName = input.displayName !== undefined ? (input.displayName ? input.displayName.trim() : null) : existing.display_name;
    const avatarUrl = input.avatarUrl !== undefined ? (input.avatarUrl ? input.avatarUrl.trim() : null) : existing.avatar_url;
    const bio = input.bio !== undefined ? (input.bio ? input.bio.trim() : null) : existing.bio;
    const locale = input.locale !== undefined ? input.locale.trim().slice(0, 10) : existing.locale;
    const timezone = input.timezone !== undefined ? input.timezone.trim().slice(0, 64) : existing.timezone;
    const theme = input.theme && ["light", "dark", "system"].includes(input.theme) ? input.theme : existing.theme;
    const now = new Date().toISOString();

    await this.db.prepare(`
      INSERT INTO profile_users (
        user_id, display_name, avatar_url, bio, locale, timezone, theme, preferences_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        display_name = excluded.display_name,
        avatar_url = excluded.avatar_url,
        bio = excluded.bio,
        locale = excluded.locale,
        timezone = excluded.timezone,
        theme = excluded.theme,
        updated_at = excluded.updated_at
    `).bind(
      userId,
      displayName,
      avatarUrl,
      bio,
      locale,
      timezone,
      theme,
      JSON.stringify(existing.preferences),
      existing.created_at,
      now
    ).run();

    return {
      user_id: userId,
      display_name: displayName,
      avatar_url: avatarUrl,
      bio,
      locale,
      timezone,
      theme,
      preferences: existing.preferences,
      created_at: existing.created_at,
      updated_at: now,
    };
  }

  /**
   * Merges user custom preferences (e.g. notification settings, UI toggles).
   * Validates serialized JSON length does not exceed 4096 bytes.
   */
  async updatePreferences(
    userIdRaw: string,
    updates: Record<string, unknown>
  ): Promise<{ ok: boolean; profile?: UserProfile; error?: string }> {
    const userId = userIdRaw.trim();
    const existing = await this.getProfile(userId);

    const merged = { ...existing.preferences, ...updates };
    const serialized = JSON.stringify(merged);
    if (serialized.length > 4096) {
      return { ok: false, error: "Preferences payload exceeds maximum allowed size (4096 bytes)" };
    }

    const now = new Date().toISOString();

    await this.db.prepare(`
      INSERT INTO profile_users (
        user_id, display_name, avatar_url, bio, locale, timezone, theme, preferences_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        preferences_json = excluded.preferences_json,
        updated_at = excluded.updated_at
    `).bind(
      userId,
      existing.display_name,
      existing.avatar_url,
      existing.bio,
      existing.locale,
      existing.timezone,
      existing.theme,
      serialized,
      existing.created_at,
      now
    ).run();

    return {
      ok: true,
      profile: {
        ...existing,
        preferences: merged,
        updated_at: now,
      },
    };
  }
}
