import type { D1Like } from "@poc/sdk";
import { findWorkspaceMembership, global, scoped } from "@poc/sdk";

function toHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toHex(digest);
}

/** The workspace role a key acts with. There are no owner keys. */
export type ApiKeyRole = "member" | "admin";

/** Workspace role order, used for the creation ceiling and the creator re-check at authentication. */
const ROLE_RANK: Record<string, number> = { member: 1, admin: 2, owner: 3 };

/** Workspace roles that may create, list and revoke keys. */
export const KEY_MANAGER_ROLES: readonly string[] = Object.freeze(["owner", "admin"]);

/**
 * The scope sets a key can be created with: `["*"]` (full access at the key's role, the default) or `["read"]` (safe
 * methods only: GET, HEAD, OPTIONS). The identity step enforces `read`; `requireScope` is there for bricks that want more.
 */
export const KEY_SCOPE_SETS: ReadonlyArray<readonly string[]> = Object.freeze([Object.freeze(["*"]), Object.freeze(["read"])]);

/** The longest a key may live, in days. */
export const MAX_KEY_EXPIRES_DAYS = 3650;

/** True when `scopes` is one of `KEY_SCOPE_SETS`. */
export function isAllowedScopeSet(scopes: readonly string[]): boolean {
  return KEY_SCOPE_SETS.some((set) => set.length === scopes.length && set.every((s, i) => scopes[i] === s));
}

/** True when a key with these scopes may make a request with this method. */
export function scopesAllowMethod(scopes: readonly string[], method: string): boolean {
  if (scopes.includes("*")) return true;
  return scopes.includes("read") && ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export interface ApiKeyRecord {
  id: string;
  workspace_id: string;
  key_prefix: string;
  name: string;
  scopes: string[];
  role: ApiKeyRole;
  created_by: string | null;
  revoked: boolean;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

/** A key that passed authentication, with the suspension state of its workspace. */
export interface AuthenticatedApiKey {
  key: ApiKeyRecord;
  workspaceSuspended: boolean;
}

export interface CreateKeyInput {
  name: string;
  scopes?: string[];
  expiresDays?: number;
  /** The key's role. Defaults to "member". */
  role?: ApiKeyRole;
  /** The person creating the key and their verified workspace role. Never an API key. */
  creator: { userId: string; role: string };
}

interface KeyRow {
  id: string;
  workspace_id: string;
  key_prefix: string;
  name: string;
  scopes_json: string;
  role: string;
  created_by: string | null;
  revoked: number;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

/** The stored scopes, or null when the stored value is not a JSON array of strings. */
function parseScopes(json: string): string[] | null {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) && value.every((s) => typeof s === "string") ? (value as string[]) : null;
  } catch {
    return null;
  }
}

function toRecord(row: KeyRow): ApiKeyRecord {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    key_prefix: row.key_prefix,
    name: row.name,
    scopes: parseScopes(row.scopes_json) ?? [],
    role: row.role === "admin" ? "admin" : "member",
    created_by: row.created_by,
    revoked: row.revoked === 1,
    last_used_at: row.last_used_at,
    expires_at: row.expires_at,
    created_at: row.created_at,
  };
}

export class ApiKeyService {
  constructor(private readonly db: D1Like) {}

  /**
   * Generates a new API key. The rawKey is returned ONLY on creation and never stored; only its SHA-256 hash is.
   * The creator must be an owner or admin of the workspace, and the key's role can never exceed the creator's.
   */
  async createKey(
    workspaceId: string,
    input: CreateKeyInput,
  ): Promise<{ ok: true; rawKey: string; key: ApiKeyRecord } | { ok: false; error: string; code: number }> {
    const name = input.name.trim();
    if (!name || name.length > 100) {
      return { ok: false, error: "Key name must be between 1 and 100 characters", code: 400 };
    }
    const scopes = input.scopes ?? ["*"];
    if (!isAllowedScopeSet(scopes)) {
      return { ok: false, error: 'Scopes must be ["*"] or ["read"]', code: 400 };
    }
    if (
      input.expiresDays !== undefined &&
      (!Number.isInteger(input.expiresDays) || input.expiresDays < 1 || input.expiresDays > MAX_KEY_EXPIRES_DAYS)
    ) {
      return { ok: false, error: `expiresDays must be a whole number from 1 to ${MAX_KEY_EXPIRES_DAYS}`, code: 400 };
    }
    const role: ApiKeyRole = input.role ?? "member";
    if (role !== "member" && role !== "admin") return { ok: false, error: "Key role must be member or admin", code: 400 };
    const creatorRank = ROLE_RANK[input.creator.role] ?? 0;
    if (!input.creator.userId || !KEY_MANAGER_ROLES.includes(input.creator.role)) {
      return { ok: false, error: "Only a workspace owner or admin can create API keys", code: 403 };
    }
    if (ROLE_RANK[role]! > creatorRank) {
      return { ok: false, error: "A key's role cannot exceed its creator's role", code: 403 };
    }

    const randomBytes = new Uint8Array(24);
    crypto.getRandomValues(randomBytes);
    const entropy = toHex(randomBytes);
    const rawKey = `sk_live_${entropy}`;
    const keyPrefix = rawKey.substring(0, 16); // e.g. "sk_live_a1b2c3d4"
    const keyHash = await sha256Hex(rawKey);

    const id = `key_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const expiresAt = input.expiresDays ? new Date(Date.now() + input.expiresDays * 86400 * 1000).toISOString() : null;

    await scoped(this.db, workspaceId).insert("key_api_keys", {
      id,
      key_prefix: keyPrefix,
      key_hash: keyHash,
      name,
      scopes_json: JSON.stringify(scopes),
      role,
      created_by: input.creator.userId,
      revoked: 0,
      expires_at: expiresAt,
      created_at: now,
    });

    return {
      ok: true,
      rawKey,
      key: {
        id,
        workspace_id: workspaceId,
        key_prefix: keyPrefix,
        name,
        scopes,
        role,
        created_by: input.creator.userId,
        revoked: false,
        last_used_at: null,
        expires_at: expiresAt,
        created_at: now,
      },
    };
  }

  /**
   * Authenticates an API key by its hash. Returns null when the key is unknown, revoked or expired, or when its creator
   * is no longer a member of the key's workspace at or above the key's role, or when its stored scopes are corrupt.
   * Does not record the use; see `touch`. Throws when the database fails (the caller answers 503, never the session).
   */
  async authenticate(rawKey: string): Promise<AuthenticatedApiKey | null> {
    if (!rawKey || !rawKey.startsWith("sk_live_") || rawKey.length < 32) return null;

    const keyHash = await sha256Hex(rawKey);
    const row = await global(this.db, "key_api_keys", "authenticate incoming API key by key hash")
      .first<KeyRow>("key_hash = ? AND revoked = 0", [keyHash]);
    if (!row) return null;
    if (row.expires_at && !(new Date(row.expires_at).getTime() > Date.now())) return null;
    if (parseScopes(row.scopes_json) === null) return null;

    // The creator re-check (the same rule as invites): one lookup on the membership primary key.
    if (!row.created_by) return null;
    const creator = await findWorkspaceMembership(this.db, row.workspace_id, row.created_by);
    if (!creator) return null;
    if ((ROLE_RANK[creator.role] ?? 0) < (ROLE_RANK[row.role] ?? Number.POSITIVE_INFINITY)) return null;

    return { key: toRecord(row), workspaceSuspended: creator.suspended };
  }

  /** `authenticate`, returning only the key. */
  async validateKey(rawKey: string): Promise<ApiKeyRecord | null> {
    return (await this.authenticate(rawKey))?.key ?? null;
  }

  /**
   * Records that a key was used, at most once a minute: the write happens only when the stored value is older than 60
   * seconds. Returns whether it wrote. Best effort: callers do not wait on it.
   */
  async touch(workspaceId: string, keyId: string, nowMs: number = Date.now()): Promise<boolean> {
    const cutoff = new Date(nowMs - 60_000).toISOString();
    const res = await scoped(this.db, workspaceId).update(
      "key_api_keys",
      { last_used_at: new Date(nowMs).toISOString() },
      "id = ? AND COALESCE(last_used_at, '') < ?",
      [keyId, cutoff],
    );
    return res.meta.changes > 0;
  }

  /**
   * Revokes an API key immediately.
   */
  async revokeKey(workspaceId: string, keyId: string): Promise<boolean> {
    const res = await scoped(this.db, workspaceId).update("key_api_keys", { revoked: 1 }, "id = ?", [keyId]);

    return res.meta.changes > 0;
  }

  /**
   * Lists masked API keys in a workspace.
   */
  async listKeys(workspaceId: string): Promise<ApiKeyRecord[]> {
    const rows = await scoped(this.db, workspaceId).select<KeyRow>(
      "key_api_keys",
      undefined,
      [],
      { orderBy: "created_at DESC" },
    );
    return rows.map(toRecord);
  }
}
