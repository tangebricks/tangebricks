import type { AuditStatement, D1Like, WorkspaceGuard } from "@poc/sdk";
import { auditStatementsOnly, scoped, workspaceGuardParts } from "@poc/sdk";

/**
 * Story 2.6: the workspace-override surface other bricks are handed through the assembler's `$capability` route option
 * (`feature-flags.flagOverrides`), so an operator tool can set or clear one workspace's override without writing this
 * brick's tables itself.
 *
 * It keeps this brick's rules:
 * - `allowOverrides` must be `true` for a set or a clear (story 1.12), else `OVERRIDES_DISABLED`;
 * - an override can only point at a defined flag (`FLAG_NOT_FOUND`).
 *
 * The override rule is the owner's: `allowOverrides` is this brick's own `allowWorkspaceOverrides` setting, which the
 * assembler passes to the taking brick (`$capabilitySetting: "feature-flags.allowWorkspaceOverrides"`). The assembler
 * hands this export and that setting only to first-party, non-isolated, non-quarantined bricks, so the rule is never in
 * an untrusted caller's hands; and anything but `true` refuses (fail closed).
 *
 * Each change is one D1 batch: the write, guarded in its own WHERE by the value read just before (so a concurrent change
 * makes it write nothing, `NOT_APPLIED`) and by `guard` (an @poc/sdk workspace guard such as `workspaceNotDeletingGuard`),
 * then the `alongside` audit statements (made by `auditStatement` with `afterChange`, for this workspace; anything else
 * throws), which are written only if the write changed a row. A set to the current value and a clear of no override are
 * no-ops (`changed: false`) that run nothing. Pass `alongside` as a function to build the audit rows from the value
 * read, so the audit "before" is exactly the `before` returned.
 */
export type FlagOverrideRefusal = { ok: false; code: "OVERRIDES_DISABLED" | "FLAG_NOT_FOUND" | "NOT_APPLIED" };
export type FlagOverrideChange = { ok: true; key: string; changed: boolean; before: boolean | null; after: boolean | null };

export interface FlagOverrideOptions {
  /** The app's `allowWorkspaceOverrides` setting. Anything but `true` refuses the change. */
  allowOverrides: boolean | undefined;
  /** An @poc/sdk workspace guard the write must also satisfy (for example: the workspace is not being deleted). */
  guard?: WorkspaceGuard;
  alongside?: readonly AuditStatement[] | ((before: boolean | null) => readonly AuditStatement[]);
}

export interface FlagOverrides {
  /** The workspace's overrides, by flag key, in key order (at most 500). */
  list(db: D1Like, workspaceId: string): Promise<Array<{ key: string; enabled: boolean; updatedAt: string }>>;
  /** The workspace's override of one flag: true/false, or null when it has none. */
  get(db: D1Like, workspaceId: string, flagKey: string): Promise<boolean | null>;
  set(db: D1Like, workspaceId: string, flagKey: string, enabled: boolean, options: FlagOverrideOptions): Promise<FlagOverrideChange | FlagOverrideRefusal>;
  clear(db: D1Like, workspaceId: string, flagKey: string, options: FlagOverrideOptions): Promise<FlagOverrideChange | FlagOverrideRefusal>;
}

const normalise = (key: string) => key.trim().toLowerCase();

async function current(db: D1Like, workspaceId: string, key: string): Promise<boolean | null> {
  const row = await scoped(db, workspaceId).first<{ enabled: number }>("flag_overrides", "flag_key = ?", [key]);
  return row ? row.enabled === 1 : null;
}

async function defined(db: D1Like, key: string): Promise<boolean> {
  // flag_definitions is a global table (every workspace reads the same definitions).
  const row = await db.prepare("SELECT 1 AS present FROM flag_definitions WHERE key = ?").bind(key).first<{ present: number }>();
  return Boolean(row);
}

/** The extra WHERE terms: the caller's workspace guard, if any. */
function guardTerms(options: FlagOverrideOptions): { sql: string; params: unknown[] } {
  if (options.guard === undefined) return { sql: "", params: [] };
  const parts = workspaceGuardParts(options.guard);
  return { sql: ` AND ${parts.sql}`, params: parts.params };
}

function alongsideFor(options: FlagOverrideOptions, workspaceId: string, before: boolean | null) {
  const list = typeof options.alongside === "function" ? options.alongside(before) : options.alongside;
  return auditStatementsOnly(list, workspaceId);
}

export const flagOverrides: FlagOverrides = Object.freeze({
  async list(db: D1Like, workspaceId: string) {
    const rows = await scoped(db, workspaceId).select<{ flag_key: string; enabled: number; updated_at: string }>("flag_overrides", undefined, [], {
      orderBy: "flag_key ASC",
      limit: 500,
    });
    return rows.map((r) => ({ key: r.flag_key, enabled: r.enabled === 1, updatedAt: r.updated_at }));
  },

  async get(db: D1Like, workspaceId: string, flagKey: string) {
    return current(db, workspaceId, normalise(flagKey));
  },

  async set(db: D1Like, workspaceId: string, flagKey: string, enabled: boolean, options: FlagOverrideOptions) {
    if (typeof enabled !== "boolean") throw new TypeError("enabled must be a boolean");
    if (options.allowOverrides !== true) return { ok: false, code: "OVERRIDES_DISABLED" } as const;
    const key = normalise(flagKey);
    const guard = guardTerms(options);
    if (!(await defined(db, key))) return { ok: false, code: "FLAG_NOT_FOUND" } as const;
    const before = await current(db, workspaceId, key);
    if (before === enabled) return { ok: true, key, changed: false, before, after: enabled } as const;
    const extra = alongsideFor(options, workspaceId, before);
    // Guarded by the value just read: a concurrent change makes this write (and the audit rows after it) do nothing.
    const upsert =
      before === null
        ? db
            .prepare(
              "INSERT INTO flag_overrides (flag_key, workspace_id, enabled, updated_at) SELECT ?, ?, ?, ? " +
                "WHERE NOT EXISTS (SELECT 1 FROM flag_overrides WHERE flag_key = ? AND workspace_id = ?)" +
                guard.sql +
                " ON CONFLICT (flag_key, workspace_id) DO NOTHING",
            )
            .bind(key, workspaceId, enabled ? 1 : 0, new Date().toISOString(), key, workspaceId, ...guard.params)
        : db
            .prepare("UPDATE flag_overrides SET enabled = ?, updated_at = ? WHERE flag_key = ? AND workspace_id = ? AND enabled = ?" + guard.sql)
            .bind(enabled ? 1 : 0, new Date().toISOString(), key, workspaceId, before ? 1 : 0, ...guard.params);
    const [result] = await db.batch([upsert, ...extra]);
    if (!result || result.meta.changes === 0) return { ok: false, code: "NOT_APPLIED" } as const;
    return { ok: true, key, changed: true, before, after: enabled } as const;
  },

  async clear(db: D1Like, workspaceId: string, flagKey: string, options: FlagOverrideOptions) {
    // Story 1.12: clearing is a change to the override, so it obeys allowOverrides like a set.
    if (options.allowOverrides !== true) return { ok: false, code: "OVERRIDES_DISABLED" } as const;
    const key = normalise(flagKey);
    const guard = guardTerms(options);
    if (!(await defined(db, key))) return { ok: false, code: "FLAG_NOT_FOUND" } as const;
    const before = await current(db, workspaceId, key);
    if (before === null) return { ok: true, key, changed: false, before, after: null } as const;
    const extra = alongsideFor(options, workspaceId, before);
    const [result] = await db.batch([
      db
        .prepare("DELETE FROM flag_overrides WHERE flag_key = ? AND workspace_id = ? AND enabled = ?" + guard.sql)
        .bind(key, workspaceId, before ? 1 : 0, ...guard.params),
      ...extra,
    ]);
    if (!result || result.meta.changes === 0) return { ok: false, code: "NOT_APPLIED" } as const;
    return { ok: true, key, changed: true, before, after: null } as const;
  },
});
