import type { D1Like } from "@poc/sdk";
import { global, scoped } from "@poc/sdk";

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

export interface ApiKeyRecord {
  id: string;
  workspace_id: string;
  key_prefix: string;
  name: string;
  scopes: string[];
  revoked: boolean;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export class ApiKeyService {
  constructor(private readonly db: D1Like) {}

  /**
   * Generates a new API key. The rawKey is returned ONLY on creation and never stored.
   */
  async createKey(
    workspaceId: string,
    nameRaw: string,
    scopes: string[] = ["*"],
    expiresDays?: number
  ): Promise<{ ok: true; rawKey: string; key: ApiKeyRecord } | { ok: false; error: string; code: number }> {
    const name = nameRaw.trim();
    if (!name || name.length > 100) {
      return { ok: false, error: "Key name must be between 1 and 100 characters", code: 400 };
    }

    const randomBytes = new Uint8Array(24);
    crypto.getRandomValues(randomBytes);
    const entropy = toHex(randomBytes);
    const rawKey = `sk_live_${entropy}`;
    const keyPrefix = rawKey.substring(0, 16); // e.g. "sk_live_a1b2c3d4"
    const keyHash = await sha256Hex(rawKey);

    const id = `key_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const expiresAt = expiresDays ? new Date(Date.now() + expiresDays * 86400 * 1000).toISOString() : null;
    const scopesJson = JSON.stringify(scopes);

    await scoped(this.db, workspaceId).insert("key_api_keys", {
      id,
      key_prefix: keyPrefix,
      key_hash: keyHash,
      name,
      scopes_json: scopesJson,
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
        revoked: false,
        last_used_at: null,
        expires_at: expiresAt,
        created_at: now,
      },
    };
  }

  /**
   * Authenticates an API key in constant time and returns associated workspace & scopes.
   */
  async validateKey(rawKey: string): Promise<ApiKeyRecord | null> {
    if (!rawKey || !rawKey.startsWith("sk_live_") || rawKey.length < 32) return null;

    const keyHash = await sha256Hex(rawKey);

    interface Row {
      id: string;
      workspace_id: string;
      key_prefix: string;
      name: string;
      scopes_json: string;
      revoked: number;
      last_used_at: string | null;
      expires_at: string | null;
      created_at: string;
    }

    const row = await global(this.db, "key_api_keys", "authenticate incoming API key by key hash")
      .first<Row>("key_hash = ? AND revoked = 0", [keyHash]);

    if (!row) return null;

    // Check expiration
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      return null;
    }

    // Update last_used_at
    const now = new Date().toISOString();
    await scoped(this.db, row.workspace_id).update("key_api_keys", { last_used_at: now }, "id = ?", [row.id]);

    return {
      id: row.id,
      workspace_id: row.workspace_id,
      key_prefix: row.key_prefix,
      name: row.name,
      scopes: JSON.parse(row.scopes_json || '["*"]'),
      revoked: row.revoked === 1,
      last_used_at: now,
      expires_at: row.expires_at,
      created_at: row.created_at,
    };
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
    interface Row {
      id: string;
      workspace_id: string;
      key_prefix: string;
      name: string;
      scopes_json: string;
      revoked: number;
      last_used_at: string | null;
      expires_at: string | null;
      created_at: string;
    }

    const rows = await scoped(this.db, workspaceId).select<Row>(
      "key_api_keys",
      undefined,
      [],
      { orderBy: "created_at DESC" },
    );

    return rows.map((r) => ({
      id: r.id,
      workspace_id: r.workspace_id,
      key_prefix: r.key_prefix,
      name: r.name,
      scopes: JSON.parse(r.scopes_json || '["*"]'),
      revoked: r.revoked === 1,
      last_used_at: r.last_used_at,
      expires_at: r.expires_at,
      created_at: r.created_at,
    }));
  }
}
