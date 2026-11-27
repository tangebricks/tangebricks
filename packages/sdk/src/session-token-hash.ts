// Hashed session-token storage for Better Auth (story 0.14, threat-model risk 17).
//
// Better Auth stores the session token in `session.token` as given to the client, so a copy of the database is a set
// of live sessions. `withHashedSessionTokens` wraps Better Auth's database adapter (its supported extension point; no
// fork) so that:
//   * a new session row stores sha256(token) and the caller still gets the raw token back, once;
//   * every lookup, update or delete by token hashes the presented value first, so a stored hash presented as a
//     bearer token or cookie is hashed again and matches nothing;
//   * a row read by its raw token is handed back to Better Auth with that raw token, so cookie refresh keeps working;
//   * any other row is handed out as `sha256.<digest>` (list-sessions), which revoke-session accepts but which can
//     never be presented as a credential (see STORED_ROW_PREFIX).
// `hashLegacySessionTokens` rewrites rows written before the change (any token that is not 64 hex characters) to
// their hash, so existing sessions keep working with the token the client already holds.
//
// The adapter type is written structurally so the SDK does not depend on better-auth.
import type { D1Like } from "./d1.ts";

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The form a stored row's token takes when the raw token is unknown (e.g. in list-sessions): `sha256.<digest>`.
 * It names the row for revoke-session. It can never authenticate: Better Auth reads a session token only from its
 * HMAC-signed cookie, and the bearer bridge signs only dot-free values, so a value containing "." would need a server
 * signature to arrive as a credential.
 */
export const STORED_ROW_PREFIX = "sha256.";

/** The digest named by a stored-row value (`sha256.<digest>`), or null for any other value. */
function storedDigestOf(value: string): string | null {
  if (!value.startsWith(STORED_ROW_PREFIX)) return null;
  const digest = value.slice(STORED_ROW_PREFIX.length);
  return HASH_PATTERN.test(digest) ? digest : null;
}

/** sha256 of a string, as 64 lowercase hex characters. */
export async function sha256HexString(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** True when a stored token is already a sha256 hex digest. */
export function isHashedSessionToken(value: unknown): boolean {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

interface WhereLike {
  field: string;
  value: unknown;
  operator?: string;
  [key: string]: unknown;
}

type AnyFn = (...args: any[]) => Promise<any>;

/** The subset of Better Auth's DBAdapter this wrapper touches. Other members pass through unchanged. */
export interface SessionAdapterLike {
  id: string;
  create: AnyFn;
  findOne: AnyFn;
  findMany: AnyFn;
  count: AnyFn;
  update: AnyFn;
  updateMany: AnyFn;
  delete: AnyFn;
  deleteMany: AnyFn;
  consumeOne?: AnyFn;
  incrementOne?: AnyFn;
  transaction: (callback: (trx: any) => Promise<any>) => Promise<any>;
  [key: string]: unknown;
}

export interface HashedSessionOptions {
  /** The Better Auth model holding sessions. Default `session`. */
  model?: string;
  /** The column holding the token. Default `token`. */
  field?: string;
  /** The physical table name, for the legacy-row rewrite. Default `session`. */
  table?: string;
}

const sweptDatabases = new WeakMap<object, Promise<void>>();

/**
 * Rewrites every session row whose token is not yet a sha256 digest to its digest. Safe to run any number of times.
 * Returns how many rows it rewrote.
 */
export async function hashLegacySessionTokens(db: D1Like, table = "session"): Promise<number> {
  const quoted = `"${table.replaceAll('"', '""')}"`;
  const rows = await db
    .prepare(`SELECT "id", "token" FROM ${quoted} WHERE length("token") <> 64 OR "token" GLOB '*[^0-9a-f]*'`)
    .all<{ id: string; token: string }>();
  let rewritten = 0;
  for (const row of rows.results ?? []) {
    if (typeof row.token !== "string" || isHashedSessionToken(row.token)) continue;
    const hashed = await sha256HexString(row.token);
    const res = await db.prepare(`UPDATE ${quoted} SET "token" = ? WHERE "id" = ? AND "token" = ?`).bind(hashed, row.id, row.token).run();
    rewritten += Number(res.meta?.changes ?? 0);
  }
  return rewritten;
}

/**
 * Runs `hashLegacySessionTokens` once per database object per isolate (a failure is retried on the next call). Rows
 * written raw later (by an older Worker still draining) are rewritten on first use by the wrapper's lazy upgrade.
 */
export function hashLegacySessionTokensOnce(db: D1Like, table = "session"): Promise<void> {
  return sweepOnce(db, table);
}

function sweepOnce(db: D1Like, table: string): Promise<void> {
  const existing = sweptDatabases.get(db as object);
  if (existing) return existing;
  const run = hashLegacySessionTokens(db, table).then(
    () => undefined,
    () => {
      sweptDatabases.delete(db as object);
    },
  );
  sweptDatabases.set(db as object, run);
  return run;
}

/**
 * Wraps a Better Auth adapter (or a promise of one) so session tokens are stored hashed. `db` is the same database,
 * used only to rewrite rows from before the change.
 */
export function withHashedSessionTokens(
  inner: SessionAdapterLike | Promise<SessionAdapterLike>,
  db: D1Like,
  options: HashedSessionOptions = {},
): SessionAdapterLike {
  const model = options.model ?? "session";
  const field = options.field ?? "token";
  const table = options.table ?? "session";
  // Raw tokens this instance was given (presented in a lookup, or just created), by digest. A row read back whose
  // digest is here is returned with its raw token, so Better Auth's comparisons against the current session token
  // (cookie refresh, revoke-other-sessions) see the same value on both sides.
  const knownRaw = new Map<string, string>();
  const ready = Promise.resolve(inner).then(async (adapter) => {
    await sweepOnce(db, table);
    return adapter;
  });

  /**
   * Hashes the token predicates of `where`; returns the new clause and digest -> raw token for the raw values. A value in
   * the stored-row form (`sha256.<digest>`, what list-sessions hands out) names that row's digest directly.
   */
  async function mapWhere(where: WhereLike[] | undefined): Promise<{ where: WhereLike[] | undefined; rawByDigest: Map<string, string> }> {
    const rawByDigest = new Map<string, string>();
    if (!Array.isArray(where)) return { where, rawByDigest };
    const hashOne = async (value: unknown): Promise<unknown> => {
      if (typeof value !== "string") return value;
      const stored = storedDigestOf(value);
      if (stored) return stored;
      const digest = await sha256HexString(value);
      rawByDigest.set(digest, value);
      knownRaw.set(digest, value);
      return digest;
    };
    const mapped = await Promise.all(
      where.map(async (clause) => {
        if (clause.field !== field) return clause;
        const value = Array.isArray(clause.value) ? await Promise.all(clause.value.map(hashOne)) : await hashOne(clause.value);
        return { ...clause, value };
      }),
    );
    return { where: mapped, rawByDigest };
  }

  /**
   * Puts the raw token back on a row whose raw token this instance knows; any other hashed row is returned in the
   * stored-row form `sha256.<digest>`, which names the row for revoke-session but can never be a credential.
   */
  function restore<T>(row: T, rawByDigest: Map<string, string>): T {
    if (!row || typeof row !== "object") return row;
    const record = row as Record<string, unknown>;
    const stored = record[field];
    if (typeof stored !== "string") return row;
    const raw = rawByDigest.get(stored) ?? knownRaw.get(stored);
    if (raw !== undefined) return { ...record, [field]: raw } as T;
    if (isHashedSessionToken(stored)) return { ...record, [field]: `${STORED_ROW_PREFIX}${stored}` } as T;
    return row;
  }

  /** Rewrites legacy rows lazily: a raw token presented for a row that still stores it raw is hashed in place. */
  async function upgradeLegacyRow(rawByDigest: Map<string, string>): Promise<boolean> {
    let changed = false;
    const quoted = `"${table.replaceAll('"', '""')}"`;
    for (const [digest, raw] of rawByDigest) {
      if (isHashedSessionToken(raw)) continue; // a 64-hex value is never a legacy raw token; never match a digest row
      const res = await db
        .prepare(`UPDATE ${quoted} SET "token" = ? WHERE "token" = ? AND length("token") <> 64`)
        .bind(digest, raw)
        .run()
        .catch(() => null);
      if (res && Number(res.meta?.changes ?? 0) > 0) changed = true;
    }
    return changed;
  }

  function wrap(getAdapter: () => Promise<SessionAdapterLike>, base: { id: string; options?: unknown }): SessionAdapterLike {
    const isSession = (args: { model?: string } | undefined) => args?.model === model;
    const wrapped: SessionAdapterLike = {
      id: base.id,
      ...(base.options !== undefined ? { options: base.options } : {}),
      async create(args: { model: string; data: Record<string, unknown> }) {
        const adapter = await getAdapter();
        if (!isSession(args) || typeof args.data?.[field] !== "string") return adapter.create(args);
        const raw = args.data[field] as string;
        const digest = await sha256HexString(raw);
        knownRaw.set(digest, raw);
        const created = await adapter.create({ ...args, data: { ...args.data, [field]: digest } });
        return restore(created, new Map([[digest, raw]]));
      },
      async findOne(args: { model: string; where: WhereLike[] }) {
        const adapter = await getAdapter();
        if (!isSession(args)) return adapter.findOne(args);
        const { where, rawByDigest } = await mapWhere(args.where);
        let row = await adapter.findOne({ ...args, where });
        if (!row && rawByDigest.size > 0 && (await upgradeLegacyRow(rawByDigest))) {
          row = await adapter.findOne({ ...args, where });
        }
        return restore(row, rawByDigest);
      },
      async findMany(args: { model: string; where?: WhereLike[] }) {
        const adapter = await getAdapter();
        if (!isSession(args)) return adapter.findMany(args);
        const { where, rawByDigest } = await mapWhere(args.where);
        const rows = (await adapter.findMany({ ...args, ...(where ? { where } : {}) })) as unknown[];
        return (rows ?? []).map((row) => restore(row, rawByDigest));
      },
      async count(args: { model: string; where?: WhereLike[] }) {
        const adapter = await getAdapter();
        if (!isSession(args)) return adapter.count(args);
        const { where } = await mapWhere(args.where);
        return adapter.count({ ...args, ...(where ? { where } : {}) });
      },
      async update(args: { model: string; where: WhereLike[]; update: Record<string, unknown> }) {
        const adapter = await getAdapter();
        if (!isSession(args)) return adapter.update(args);
        const { where, rawByDigest } = await mapWhere(args.where);
        const update = { ...args.update };
        if (typeof update[field] === "string") {
          const raw = update[field] as string;
          const digest = await sha256HexString(raw);
          update[field] = digest;
          rawByDigest.set(digest, raw);
        }
        return restore(await adapter.update({ ...args, where, update }), rawByDigest);
      },
      async updateMany(args: { model: string; where: WhereLike[]; update: Record<string, unknown> }) {
        const adapter = await getAdapter();
        if (!isSession(args)) return adapter.updateMany(args);
        const { where } = await mapWhere(args.where);
        const update = { ...args.update };
        if (typeof update[field] === "string") update[field] = await sha256HexString(update[field] as string);
        return adapter.updateMany({ ...args, where, update });
      },
      async delete(args: { model: string; where: WhereLike[] }) {
        const adapter = await getAdapter();
        if (!isSession(args)) return adapter.delete(args);
        const { where } = await mapWhere(args.where);
        return adapter.delete({ ...args, where });
      },
      async deleteMany(args: { model: string; where: WhereLike[] }) {
        const adapter = await getAdapter();
        if (!isSession(args)) return adapter.deleteMany(args);
        const { where } = await mapWhere(args.where);
        return adapter.deleteMany({ ...args, where });
      },
      async consumeOne(args: { model: string; where: WhereLike[] }) {
        const adapter = await getAdapter();
        if (!adapter.consumeOne) throw new Error("adapter has no consumeOne");
        if (!isSession(args)) return adapter.consumeOne(args);
        const { where, rawByDigest } = await mapWhere(args.where);
        return restore(await adapter.consumeOne({ ...args, where }), rawByDigest);
      },
      async incrementOne(args: { model: string; where: WhereLike[] }) {
        const adapter = await getAdapter();
        if (!adapter.incrementOne) throw new Error("adapter has no incrementOne");
        if (!isSession(args)) return adapter.incrementOne(args);
        const { where, rawByDigest } = await mapWhere(args.where);
        return restore(await adapter.incrementOne({ ...args, where }), rawByDigest);
      },
      async transaction(callback: (trx: any) => Promise<any>) {
        const adapter = await getAdapter();
        return adapter.transaction((trx: SessionAdapterLike) => callback(wrap(async () => trx, { id: trx?.id ?? base.id, options: trx?.options })));
      },
    };
    return wrapped;
  }

  return wrap(() => ready, { id: "kysely" });
}
