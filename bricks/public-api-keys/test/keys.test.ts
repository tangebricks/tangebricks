import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_public_api_keys.sql?raw";
import { createApiKeyRoutes, ApiKeyService, apiKeyMiddleware, requireScope } from "../src/index.ts";
import type { ApiKeyEnv } from "../src/middleware.ts";

const db = env.DB as D1Like;
const WS_A = "ws_keys_alpha";
const WS_B = "ws_keys_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS key_api_keys").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Public API Key Infrastructure Core Logic", () => {
  it("generates API key, returns raw key once, and stores SHA-256 hash in D1", async () => {
    const service = new ApiKeyService(db);
    const created = await service.createKey(WS_A, "Server Agent", ["read", "write"]);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.rawKey).toMatch(/^sk_live_[a-f0-9]{48}$/);
    expect(created.key.name).toBe("Server Agent");
    expect(created.key.scopes).toEqual(["read", "write"]);

    // Verify raw key validates
    const validated = await service.validateKey(created.rawKey);
    expect(validated).not.toBeNull();
    expect(validated?.workspace_id).toBe(WS_A);
    expect(validated?.last_used_at).not.toBeNull();

    // Verify key listings are masked (never return hash or secret)
    const list = await service.listKeys(WS_A);
    expect(list).toHaveLength(1);
    expect(list[0].key_prefix).toBe(created.key.key_prefix);
    expect((list[0] as unknown as { key_hash?: string }).key_hash).toBeUndefined();
  });

  it("rejects tampered or non-existent API keys", async () => {
    const service = new ApiKeyService(db);
    const created = await service.createKey(WS_A, "Test Key");
    if (!created.ok) return;

    // Tampered
    expect(await service.validateKey(created.rawKey + "tamper")).toBeNull();
    // Invalid prefix
    expect(await service.validateKey("sk_" + "test_fake12345678901234567890")).toBeNull();
  });

  it("revokes API key immediately, refusing subsequent validations", async () => {
    const service = new ApiKeyService(db);
    const created = await service.createKey(WS_A, "To Revoke");
    if (!created.ok) return;

    expect(await service.validateKey(created.rawKey)).not.toBeNull();

    const revoked = await service.revokeKey(WS_A, created.key.id);
    expect(revoked).toBe(true);

    expect(await service.validateKey(created.rawKey)).toBeNull();
  });

  it("rejects expired API keys", async () => {
    const service = new ApiKeyService(db);
    const created = await service.createKey(WS_A, "Expiring Key", ["*"], -1); // expired yesterday
    if (!created.ok) return;

    expect(await service.validateKey(created.rawKey)).toBeNull();
  });

  it("enforces multi-tenant isolation: Workspace B cannot see or revoke Workspace A keys", async () => {
    const service = new ApiKeyService(db);
    const created = await service.createKey(WS_A, "Alpha Key");
    if (!created.ok) return;

    expect(await service.listKeys(WS_B)).toHaveLength(0);
    expect(await service.revokeKey(WS_B, created.key.id)).toBe(false);
  });
});

describe("API Key Middleware & Route Protection", () => {
  const createApp = () => {
    const app = new Hono<ApiKeyEnv>();

    // Route management endpoints
    app.use("/api/api-keys/*", async (c, next) => {
      c.set("workspace", { id: WS_A, role: "owner" });
      await next();
    });
    app.route("/api", createApiKeyRoutes());

    // Protected external API endpoint
    app.get("/api/v1/data", apiKeyMiddleware, requireScope("data:read"), (c) =>
      c.json({ secret_data: 42, workspace: c.get("workspace")?.id }, 200)
    );

    return app;
  };

  it("GET /api/v1/data -> authenticates via Authorization: Bearer sk_live_... and enforces scopes", async () => {
    const service = new ApiKeyService(db);
    const validKey = await service.createKey(WS_A, "Read Key", ["data:read"]);
    const unprivilegedKey = await service.createKey(WS_A, "Write Only Key", ["data:write"]);
    if (!validKey.ok || !unprivilegedKey.ok) return;

    const app = createApp();

    // 1. Unauthenticated -> 401
    const unauthed = await app.fetch(new Request("http://localhost/api/v1/data"), { DB: db });
    expect(unauthed.status).toBe(401);

    // 2. Insufficient scope -> 403
    const forbidden = await app.fetch(
      new Request("http://localhost/api/v1/data", {
        headers: { Authorization: `Bearer ${unprivilegedKey.rawKey}` },
      }),
      { DB: db }
    );
    expect(forbidden.status).toBe(403);

    // 3. Authorized -> 200 OK
    const authed = await app.fetch(
      new Request("http://localhost/api/v1/data", {
        headers: { Authorization: `Bearer ${validKey.rawKey}` },
      }),
      { DB: db }
    );
    expect(authed.status).toBe(200);
    const json = (await authed.json()) as { secret_data: number; workspace: string };
    expect(json.secret_data).toBe(42);
    expect(json.workspace).toBe(WS_A);
  });
});
