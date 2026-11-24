import type { D1Like } from "@poc/sdk";
import { scoped } from "@poc/sdk";

export interface FlagDefinition {
  key: string;
  description: string | null;
  enabled_default: boolean;
  percentage_rollout: number;
  created_at: string;
}

export interface FlagOverride {
  flag_key: string;
  workspace_id: string;
  enabled: boolean;
  updated_at: string;
}

/**
 * Deterministic hash bucket (0-99) for stable percentage rollouts without storing state per user.
 */
export function hashToBucket(flagKey: string, identifier: string): number {
  const str = `${flagKey}:${identifier}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash) % 100;
}

export class FeatureFlagService {
  constructor(private readonly db: D1Like, private readonly allowOverrides = true) {}

  /**
   * Defines or updates a global feature flag.
   */
  async defineFlag(
    keyRaw: string,
    description?: string,
    enabledDefault = false,
    percentageRollout = 100
  ): Promise<FlagDefinition> {
    const key = keyRaw.trim().toLowerCase();
    const percentage = Math.max(0, Math.min(100, percentageRollout));
    const now = new Date().toISOString();

    await this.db.prepare(`
      INSERT INTO flag_definitions (key, description, enabled_default, percentage_rollout, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET
        description = excluded.description,
        enabled_default = excluded.enabled_default,
        percentage_rollout = excluded.percentage_rollout
    `).bind(key, description?.trim() || null, enabledDefault ? 1 : 0, percentage, now).run();

    return {
      key,
      description: description?.trim() || null,
      enabled_default: enabledDefault,
      percentage_rollout: percentage,
      created_at: now,
    };
  }

  /**
   * Retrieves a flag definition by key.
   */
  async getFlag(key: string): Promise<FlagDefinition | null> {
    interface Row {
      key: string;
      description: string | null;
      enabled_default: number;
      percentage_rollout: number;
      created_at: string;
    }

    const row = await this.db.prepare(
      "SELECT key, description, enabled_default, percentage_rollout, created_at FROM flag_definitions WHERE key = ?"
    ).bind(key.toLowerCase().trim()).first<Row>();

    if (!row) return null;
    return {
      ...row,
      enabled_default: row.enabled_default === 1,
    };
  }

  /**
   * Lists all defined flags.
   */
  async listFlags(): Promise<FlagDefinition[]> {
    interface Row {
      key: string;
      description: string | null;
      enabled_default: number;
      percentage_rollout: number;
      created_at: string;
    }

    const rows = (await this.db.prepare(
      "SELECT key, description, enabled_default, percentage_rollout, created_at FROM flag_definitions ORDER BY key ASC"
    ).all<Row>()).results;

    return rows.map((r) => ({
      ...r,
      enabled_default: r.enabled_default === 1,
    }));
  }

  /**
   * Sets a workspace-level override for a flag.
   */
  async setOverride(workspaceId: string, flagKeyRaw: string, enabled: boolean): Promise<boolean> {
    if (!this.allowOverrides) return false;
    const flagKey = flagKeyRaw.toLowerCase().trim();
    const now = new Date().toISOString();

    const existing = await scoped(this.db, workspaceId).first("flag_overrides", "flag_key = ?", [flagKey]);
    if (existing) {
      await scoped(this.db, workspaceId).update(
        "flag_overrides",
        { enabled: enabled ? 1 : 0, updated_at: now },
        "flag_key = ?",
        [flagKey],
      );
    } else {
      await scoped(this.db, workspaceId).insert("flag_overrides", {
        flag_key: flagKey,
        enabled: enabled ? 1 : 0,
        updated_at: now,
      });
    }

    return true;
  }

  /**
   * Clears a workspace-level override.
   */
  async clearOverride(workspaceId: string, flagKeyRaw: string): Promise<boolean> {
    const flagKey = flagKeyRaw.toLowerCase().trim();
    const res = await scoped(this.db, workspaceId).delete("flag_overrides", "flag_key = ?", [flagKey]);

    return res.meta.changes > 0;
  }

  /**
   * Evaluates whether a flag is enabled for a given context (workspace & user).
   */
  async isEnabled(
    flagKeyRaw: string,
    context: { workspaceId?: string; userId?: string } = {}
  ): Promise<boolean> {
    const flagKey = flagKeyRaw.toLowerCase().trim();

    // 1. Check workspace override
    if (this.allowOverrides && context.workspaceId) {
      interface OverrideRow {
        enabled: number;
      }
      const override = await scoped(this.db, context.workspaceId).first<OverrideRow>(
        "flag_overrides",
        "flag_key = ?",
        [flagKey],
      );

      if (override !== null && override !== undefined) {
        return override.enabled === 1;
      }
    }

    // 2. Check global definition
    const def = await this.getFlag(flagKey);
    if (!def) return false;
    if (!def.enabled_default) return false;
    if (def.percentage_rollout >= 100) return true;
    if (def.percentage_rollout <= 0) return false;

    // 3. Percentage progressive rollout evaluation
    const identifier = context.userId || context.workspaceId || "anonymous";
    const bucket = hashToBucket(flagKey, identifier);
    return bucket < def.percentage_rollout;
  }
}
