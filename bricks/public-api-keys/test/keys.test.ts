import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { PX_RATE_LIMITS_DDL, applyMigration } from "@poc/sdk";
import type { D1Like, RequestContext } from "@poc/sdk";
import migration from "../migrations/0001_public_api_keys.sql?raw";
import roleAndCreator from "../migrations/0002_key_role_and_creator.sql?raw";
import { createApiKeyRoutes, ApiKeyService, apiKeyIdentity, apiKeyMiddleware, requireScope } from "../src/index.ts";
import type { ApiKeyEnv } from "../src/middleware.ts";

const db = env.DB as D1Like;
const WS_A = "ws_keys_alpha";
const WS_B = "ws_keys_beta";
const OWNER = { userId: "alice", role: "owner" };
const ADMIN = { userId: "adam", role: "admin" };

// The membership tables the creator re-check reads (the shape multi-workspace's migration creates).
const MEMBERSHIP_DDL = `
CREATE TABLE IF NOT EXISTS mw_workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, suspended INTEGER NOT NULL DEFAULT 0, suspended_reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS mw_members (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, joined_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (workspace_id, user_id));
`;

async function resetDb(): Promise<void> {
  for (const table of ["key_api_keys", "mw_members", "mw_workspaces", "px_rate_limits"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await applyMigration(db, migration);
  await applyMigration(db, roleAndCreator);
  await applyMigration(db, MEMBERSHIP_DDL);
  await applyMigration(db, PX_RATE_LIMITS_DDL);
  for (const ws of [WS_A, WS_B]) {
    await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES (?, ?, ?)").bind(ws, ws, "alice").run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, 'alice', 'owner')").bind(ws).run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, 'adam', 'admin')").bind(ws).run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, 'mia', 'member')").bind(ws).run();
  }
}

async function mint(input: Parameters<ApiKeyService["createKey"]>[1], ws = WS_A) {
  const created = await new ApiKeyService(db).createKey(ws, input);
  if (!created.ok) throw new Error(`create failed: ${created.error}`);
  return created;
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Public API Key Infrastructure Core Logic", () => {
  it("generates API key, returns raw key once, and stores SHA-256 hash in D1", async () => {
    const service = new ApiKeyService(db);
    const created = await mint({ name: "Server Agent", scopes: ["read"], creator: OWNER });

    expect(created.rawKey).toMatch(/^sk_live_[a-f0-9]{48}$/);
    expect(created.key.name).toBe("Server Agent");
    expect(created.key.scopes).toEqual(["read"]);
    expect(created.key.role).toBe("member");
    expect(created.key.created_by).toBe("alice");

    // The raw key is never stored: only its hash.
    const stored = await db.prepare("SELECT * FROM key_api_keys WHERE id = ?").bind(created.key.id).first<Record<string, unknown>>();
    expect(JSON.stringify(stored)).not.toContain(created.rawKey);

    const validated = await service.validateKey(created.rawKey);
    expect(validated?.workspace_id).toBe(WS_A);

    // Verify key listings are masked (never return hash or secret)
    const list = await service.listKeys(WS_A);
    expect(list).toHaveLength(1);
    expect(list[0]!.key_prefix).toBe(created.key.key_prefix);
    expect((list[0] as unknown as { key_hash?: string }).key_hash).toBeUndefined();
  });

  it("caps the key's role at the creator's: no owner keys, members cannot mint, admins mint member or admin", async () => {
    const service = new ApiKeyService(db);
    expect((await service.createKey(WS_A, { name: "k", role: "admin", creator: OWNER })).ok).toBe(true);
    expect((await service.createKey(WS_A, { name: "k", role: "admin", creator: ADMIN })).ok).toBe(true);
    expect((await service.createKey(WS_A, { name: "k", role: "member", creator: ADMIN })).ok).toBe(true);
    const byMember = await service.createKey(WS_A, { name: "k", role: "member", creator: { userId: "mia", role: "member" } });
    expect(byMember).toMatchObject({ ok: false, code: 403 });
    const ownerKey = await service.createKey(WS_A, { name: "k", role: "owner" as never, creator: OWNER });
    expect(ownerKey.ok).toBe(false);
    // The schema refuses an owner key even when written directly.
    await expect(db.prepare("UPDATE key_api_keys SET role = 'owner' WHERE workspace_id = ?").bind(WS_A).run()).rejects.toThrow();
  });

  it('accepts only the scope sets ["*"] and ["read"], and expiresDays from 1 to 3650', async () => {
    const service = new ApiKeyService(db);
    for (const bad of [["read", "write"], ["records:read"], ["Read"], ["*", "read"], []]) {
      const res = await service.createKey(WS_A, { name: "k", scopes: bad, creator: OWNER });
      expect(res, JSON.stringify(bad)).toMatchObject({ ok: false, code: 400 });
    }
    expect((await service.createKey(WS_A, { name: "k", scopes: ["*"], creator: OWNER })).ok).toBe(true);
    expect((await service.createKey(WS_A, { name: "k", scopes: ["read"], creator: OWNER })).ok).toBe(true);
    expect((await service.createKey(WS_A, { name: "k", creator: OWNER })).ok).toBe(true);

    for (const bad of [3651, 1e12, 0, 1.5]) {
      const res = await service.createKey(WS_A, { name: "k", expiresDays: bad, creator: OWNER });
      expect(res, String(bad)).toMatchObject({ ok: false, code: 400 });
    }
    expect((await service.createKey(WS_A, { name: "k", expiresDays: 3650, creator: OWNER })).ok).toBe(true);
  });

  it("rejects tampered, non-existent and corrupt API keys", async () => {
    const service = new ApiKeyService(db);
    const created = await mint({ name: "Test Key", creator: OWNER });

    expect(await service.validateKey(created.rawKey + "tamper")).toBeNull();
    expect(await service.validateKey("sk_" + "test_fake12345678901234567890")).toBeNull();
    expect(await service.validateKey("sk_live_" + "0".repeat(48))).toBeNull();

    // A stored scope list that is not a JSON array of strings makes the key invalid, not a thrown error.
    await db.prepare("UPDATE key_api_keys SET scopes_json = 'not json' WHERE id = ?").bind(created.key.id).run();
    expect(await service.validateKey(created.rawKey)).toBeNull();
  });

  it("revokes API key immediately, refusing subsequent validations", async () => {
    const service = new ApiKeyService(db);
    const created = await mint({ name: "To Revoke", creator: OWNER });

    expect(await service.validateKey(created.rawKey)).not.toBeNull();
    expect(await service.revokeKey(WS_A, created.key.id)).toBe(true);
    expect(await service.validateKey(created.rawKey)).toBeNull();
  });

  it("rejects expired API keys", async () => {
    const service = new ApiKeyService(db);
    const created = await mint({ name: "Expiring Key", expiresDays: 1, creator: OWNER });
    await db
      .prepare("UPDATE key_api_keys SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), created.key.id)
      .run();

    expect(await service.validateKey(created.rawKey)).toBeNull();
  });

  it("refuses a key whose creator left the workspace or fell below the key's role", async () => {
    const service = new ApiKeyService(db);
    const adminKey = await mint({ name: "admin key", role: "admin", creator: ADMIN });
    const memberKey = await mint({ name: "member key", role: "member", creator: ADMIN });
    expect(await service.validateKey(adminKey.rawKey)).not.toBeNull();

    // Demoted to member: the admin key dies, the member key lives.
    await db.prepare("UPDATE mw_members SET role = 'member' WHERE workspace_id = ? AND user_id = 'adam'").bind(WS_A).run();
    expect(await service.validateKey(adminKey.rawKey)).toBeNull();
    expect(await service.validateKey(memberKey.rawKey)).not.toBeNull();

    // Removed: every key they made dies.
    await db.prepare("DELETE FROM mw_members WHERE workspace_id = ? AND user_id = 'adam'").bind(WS_A).run();
    expect(await service.validateKey(memberKey.rawKey)).toBeNull();

    // A key without a recorded creator (made before 0002) is refused.
    const ownerKey = await mint({ name: "owner made", creator: OWNER });
    await db.prepare("UPDATE key_api_keys SET created_by = NULL WHERE id = ?").bind(ownerKey.key.id).run();
    expect(await service.validateKey(ownerKey.rawKey)).toBeNull();
  });

  it("touch writes last_used_at at most once a minute", async () => {
    const service = new ApiKeyService(db);
    const created = await mint({ name: "used", creator: OWNER });
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    expect(await service.touch(WS_A, created.key.id, t0)).toBe(true);
    expect(await service.touch(WS_A, created.key.id, t0 + 30_000)).toBe(false);
    expect(await service.touch(WS_A, created.key.id, t0 + 61_000)).toBe(true);
    expect(await service.touch(WS_B, created.key.id, t0 + 200_000)).toBe(false);
  });

  it("enforces multi-tenant isolation: Workspace B cannot see or revoke Workspace A keys", async () => {
    const service = new ApiKeyService(db);
    const created = await mint({ name: "Alpha Key", creator: OWNER });

    expect(await service.listKeys(WS_B)).toHaveLength(0);
    expect(await service.revokeKey(WS_B, created.key.id)).toBe(false);
  });
});

describe("API Key Middleware & Route Protection", () => {
  /** A stand-in session identity: `x-user` + `x-role` become the verified ctx for workspace A. */
  const sessionFor = (c: { req: { header(n: string): string | undefined }; set(k: string, v: unknown): void; get(k: string): unknown }) => {
    if (c.get("authenticatedBy")) return;
    const user = c.req.header("x-user");
    const role = c.req.header("x-role");
    if (!user || !role) return;
    c.set("user", { uid: user });
    c.set("ctx", Object.freeze<RequestContext>({ userId: user, workspaceId: WS_A, role }));
  };

  const createApp = () => {
    const app = new Hono<ApiKeyEnv>();
    app.use("/api/*", apiKeyIdentity);
    app.use("/api/*", async (c, next) => {
      sessionFor(c as never);
      await next();
    });
    app.route("/api", createApiKeyRoutes());
    app.get("/api/whoami", (c) => c.json({ user: c.get("user")?.uid ?? null, ctx: c.get("ctx") ?? null }, 200));
    app.post("/api/whoami", (c) => c.json({ user: c.get("user")?.uid ?? null }, 200));
    app.get("/api/v1/data", apiKeyMiddleware, requireScope("data:read"), (c) => c.json({ secret_data: 42, workspace: c.get("ctx")?.workspaceId }, 200));
    return app;
  };

  /** Requests with an execution context whose waitUntil work is collected, so tests can await it. */
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} };
  const fetchApp = async (path: string, init: RequestInit = {}, extraEnv: Record<string, unknown> = {}) => {
    const res = await createApp().fetch(new Request(`http://localhost${path}`, init), { DB: db, ...extraEnv }, executionCtx as never);
    await Promise.all(pending.splice(0));
    return res;
  };

  it("requireScope and the read scope: a read key may GET but not POST; finer scopes need requireScope", async () => {
    const readKey = await mint({ name: "Read Key", scopes: ["read"], creator: OWNER });
    const fullKey = await mint({ name: "Full Key", scopes: ["*"], creator: OWNER });

    expect((await fetchApp("/api/v1/data")).status).toBe(401);
    // requireScope("data:read"): the read set does not hold it, "*" does.
    expect((await fetchApp("/api/v1/data", { headers: { Authorization: `Bearer ${readKey.rawKey}` } })).status).toBe(403);
    const authed = await fetchApp("/api/v1/data", { headers: { Authorization: `Bearer ${fullKey.rawKey}` } });
    expect(authed.status).toBe(200);
    expect(await authed.json()).toEqual({ secret_data: 42, workspace: WS_A });

    // The identity step enforces "read": safe methods only.
    expect((await fetchApp("/api/whoami", { headers: { "X-API-Key": readKey.rawKey } })).status).toBe(200);
    const write = await fetchApp("/api/whoami", { method: "POST", headers: { "X-API-Key": readKey.rawKey } });
    expect(write.status).toBe(403);
    expect(((await write.json()) as { code: string }).code).toBe("API_KEY_SCOPE");
    expect((await fetchApp("/api/whoami", { method: "POST", headers: { "X-API-Key": fullKey.rawKey } })).status).toBe(200);
  });

  it("sets the verified ctx from the key, never falls through after a bad key, and leaves keyless requests alone", async () => {
    const service = new ApiKeyService(db);
    const key = await mint({ name: "k", role: "admin", creator: OWNER });

    const ok = await fetchApp("/api/whoami", { headers: { "X-API-Key": key.rawKey, "x-user": "alice", "x-role": "owner" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      user: `apikey:${key.key.id}`,
      ctx: { userId: `apikey:${key.key.id}`, workspaceId: WS_A, role: "admin" },
    });

    // Unknown, revoked and malformed keys: 401 INVALID_API_KEY, even with a valid session alongside.
    const session = { "x-user": "alice", "x-role": "owner" };
    for (const headers of [
      { Authorization: `Bearer sk_live_${"0".repeat(48)}` },
      { "X-API-Key": "not-a-key" },
      { "X-API-Key": key.rawKey, Authorization: `Bearer sk_live_${"1".repeat(48)}` },
    ]) {
      const res = await fetchApp("/api/whoami", { headers: { ...session, ...headers } });
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe("INVALID_API_KEY");
    }
    await service.revokeKey(WS_A, key.key.id);
    const revoked = await fetchApp("/api/whoami", { headers: { ...session, "X-API-Key": key.rawKey } });
    expect(revoked.status).toBe(401);

    // No key: the session identity runs as before.
    const plain = await fetchApp("/api/whoami", { headers: session });
    expect(await plain.json()).toEqual({ user: "alice", ctx: { userId: "alice", workspaceId: WS_A, role: "owner" } });
  });

  it("records last_used_at once for two quick calls", async () => {
    const fresh = await mint({ name: "used", creator: OWNER });
    await fetchApp("/api/whoami", { headers: { "X-API-Key": fresh.rawKey } });
    const first = await db.prepare("SELECT last_used_at FROM key_api_keys WHERE id = ?").bind(fresh.key.id).first<{ last_used_at: string | null }>();
    expect(first?.last_used_at).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fetchApp("/api/whoami", { headers: { "X-API-Key": fresh.rawKey } });
    const second = await db.prepare("SELECT last_used_at FROM key_api_keys WHERE id = ?").bind(fresh.key.id).first<{ last_used_at: string | null }>();
    expect(second?.last_used_at).toBe(first?.last_used_at);
  });

  it("rate-limits key attempts per IP, and fails closed with 503 when the key store is unavailable", async () => {
    const limits = { PX_RATE_LIMITS: JSON.stringify({ "api-key-auth-ip": { limit: 3, windowSeconds: 60 } }) };
    const bad = { headers: { "X-API-Key": `sk_live_${"2".repeat(48)}`, "cf-connecting-ip": "203.0.113.9", "x-user": "alice", "x-role": "owner" } };
    for (let i = 0; i < 3; i += 1) expect((await fetchApp("/api/whoami", bad, limits)).status).toBe(401);
    const limited = await fetchApp("/api/whoami", bad, limits);
    expect(limited.status).toBe(429);
    // Another IP is unaffected, and a keyless request is never counted.
    expect((await fetchApp("/api/whoami", { headers: { ...bad.headers, "cf-connecting-ip": "203.0.113.10" } }, limits)).status).toBe(401);
    expect((await fetchApp("/api/whoami", { headers: { "x-user": "alice", "x-role": "owner", "cf-connecting-ip": "203.0.113.9" } }, limits)).status).toBe(200);

    const key = await mint({ name: "k", creator: OWNER });
    await db.prepare("DROP TABLE key_api_keys").run();
    const down = await fetchApp("/api/whoami", { headers: { "X-API-Key": key.rawKey, "x-user": "alice", "x-role": "owner" } });
    expect(down.status).toBe(503);
    expect(((await down.json()) as { code: string }).code).toBe("API_KEY_AUTH_UNAVAILABLE");
  });

  it("key management: owner/admin sessions only; a key can never call /api-keys; the role ceiling applies", async () => {
    const asSession = (role: string, init: RequestInit = {}) => ({
      ...init,
      headers: { "content-type": "application/json", "x-user": role === "member" ? "mia" : role === "admin" ? "adam" : "alice", "x-role": role },
    });

    // A member cannot list or create.
    expect((await fetchApp("/api/api-keys", asSession("member"))).status).toBe(403);
    expect((await fetchApp("/api/api-keys", asSession("member", { method: "POST", body: JSON.stringify({ name: "x" }) }))).status).toBe(403);

    // An admin can mint member and admin keys, never owner keys; scopes and expiry are validated.
    const adminKey = await fetchApp("/api/api-keys", asSession("admin", { method: "POST", body: JSON.stringify({ name: "x", role: "admin" }) }));
    expect(adminKey.status).toBe(201);
    const created = (await adminKey.json()) as { rawKey: string; key: { id: string; role: string; created_by: string } };
    expect(created.key).toMatchObject({ role: "admin", created_by: "adam" });
    for (const body of [
      { name: "x", role: "owner" },
      { name: "x", scopes: ["records:read"] },
      { name: "x", expiresDays: 3651 },
      { name: "x", expiresDays: 1e12 },
    ]) {
      const res = await fetchApp("/api/api-keys", asSession("owner", { method: "POST", body: JSON.stringify(body) }));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }

    // The key itself cannot list, mint or revoke keys.
    const keyHeaders = { "content-type": "application/json", "X-API-Key": created.rawKey };
    for (const [method, path] of [
      ["GET", "/api/api-keys"],
      ["POST", "/api/api-keys"],
      ["DELETE", `/api/api-keys/${created.key.id}`],
    ] as const) {
      const res = await fetchApp(path, { method, headers: keyHeaders, ...(method === "POST" ? { body: JSON.stringify({ name: "y", role: "member" }) } : {}) });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("API_KEY_FORBIDDEN");
    }

    // Owners list and revoke.
    const list = await fetchApp("/api/api-keys", asSession("owner"));
    expect(((await list.json()) as { keys: unknown[] }).keys).toHaveLength(1);
    expect((await fetchApp(`/api/api-keys/${created.key.id}`, asSession("owner", { method: "DELETE" }))).status).toBe(200);
  });
});
