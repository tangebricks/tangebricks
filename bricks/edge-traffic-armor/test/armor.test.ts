import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { PX_RATE_LIMITS_DDL, applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_edge_traffic_armor.sql?raw";
import rateLimitMigration from "../migrations/0002_px_rate_limits.sql?raw";
import { TrafficArmorService, createTrafficArmorRoutes, trafficArmorMiddleware } from "../src/index.ts";
import type { ArmorEnv } from "../src/middleware.ts";
import { stubWorkspaceContext } from "../../multi-workspace/test/support/stub-workspace-context.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_arm_alpha";
const WS_BETA = "ws_arm_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS arm_blocked_requests").run();
  await db.prepare("DROP TABLE IF EXISTS arm_rate_limits").run();
  await db.prepare("DROP TABLE IF EXISTS arm_ip_rules").run();
  // Story 0.21: the middleware's rate limit counts in the shared SDK limiter's table, which the brick's own 0002
  // migration creates.
  await db.prepare("DROP TABLE IF EXISTS px_rate_limits").run();
  await applyMigration(db, migration);
  await applyMigration(db, rateLimitMigration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Traffic Armor Core Security Logic", () => {
  it("story 0.21: the brick's px_rate_limits migration is exactly the SDK limiter's DDL", () => {
    expect(rateLimitMigration).toBe(PX_RATE_LIMITS_DDL);
  });

  it("manages IP access rules and checks client IP status", async () => {
    const service = new TrafficArmorService(db);
    const rule = await service.addIpRule(WS_ALPHA, "198.51.100.4", "block", "Credential stuffing attacker");

    expect(rule.action).toBe("block");
    expect(rule.ip_or_cidr).toBe("198.51.100.4");

    expect(await service.checkIp(WS_ALPHA, "198.51.100.4")).toBe("block");
    expect(await service.checkIp(WS_ALPHA, "198.51.100.5")).toBeNull();

    // Remove rule
    const removed = await service.removeIpRule(WS_ALPHA, "198.51.100.4");
    expect(removed).toBe(true);
    expect(await service.checkIp(WS_ALPHA, "198.51.100.4")).toBeNull();
  });

  it("enforces sliding/fixed window rate limits with standard metrics", async () => {
    const service = new TrafficArmorService(db);
    const key = "rl:ws_test:192.0.2.1";

    // 1st request (limit 3)
    const r1 = await service.checkRateLimit(key, 3, 60);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    // 2nd request
    const r2 = await service.checkRateLimit(key, 3, 60);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    // 3rd request
    const r3 = await service.checkRateLimit(key, 3, 60);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    // 4th request -> blocked!
    const r4 = await service.checkRateLimit(key, 3, 60);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("validates Turnstile tokens with external siteverify endpoint", async () => {
    const mockFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      const body = String(init?.body || "");
      if (body.includes("valid_token")) {
        return new Response(JSON.stringify({ success: true }));
      }
      return new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }));
    };

    const service = new TrafficArmorService(db, mockFetch);

    const validRes = await service.verifyTurnstile("valid_token", "secret_key");
    expect(validRes.success).toBe(true);

    const invalidRes = await service.verifyTurnstile("bad_token", "secret_key");
    expect(invalidRes.success).toBe(false);
    expect(invalidRes.errorCodes).toEqual(["invalid-input-response"]);
  });

  it("strictly isolates IP rules between workspaces", async () => {
    const service = new TrafficArmorService(db);
    await service.addIpRule(WS_ALPHA, "192.0.2.50", "block");

    expect(await service.checkIp(WS_ALPHA, "192.0.2.50")).toBe("block");
    expect(await service.checkIp(WS_BETA, "192.0.2.50")).toBeNull();
  });
});

describe("Traffic Armor HTTP Middleware & API", () => {
  it("blocks requests from blacklisted IPs with 403 Forbidden", async () => {
    const service = new TrafficArmorService(db);
    await service.addIpRule(WS_ALPHA, "198.51.100.99", "block");

    const app = new Hono<ArmorEnv>();
    app.use("*", async (c, next) => {
      c.set("workspace", { id: WS_ALPHA });
      await next();
    });
    app.use("*", trafficArmorMiddleware({ enforceIpRules: true }));
    app.get("/data", (c) => c.json({ ok: true }));

    // Request from blocked IP
    const blockedRes = await app.request(
      "/data",
      {
        headers: { "cf-connecting-ip": "198.51.100.99" },
      },
      { DB: db },
    );
    expect(blockedRes.status).toBe(403);

    // Request from good IP
    const allowedRes = await app.request(
      "/data",
      {
        headers: { "cf-connecting-ip": "198.51.100.1" },
      },
      { DB: db },
    );
    expect(allowedRes.status).toBe(200);
  });

  it("throttles excessive requests with 429 Too Many Requests and rate limit headers", async () => {
    const app = new Hono<ArmorEnv>();
    app.use("*", async (c, next) => {
      c.set("workspace", { id: WS_ALPHA });
      await next();
    });
    app.use("*", trafficArmorMiddleware({ rateLimit: { limit: 2, windowSeconds: 60 } }));
    app.get("/ping", (c) => c.text("pong"));

    const headers = { "cf-connecting-ip": "203.0.113.1" };

    // Request 1: 200
    const res1 = await app.request("/ping", { headers }, { DB: db });
    expect(res1.status).toBe(200);

    // Request 2: 200
    const res2 = await app.request("/ping", { headers }, { DB: db });
    expect(res2.status).toBe(200);

    // Request 3: 429 Rate limited!
    const res3 = await app.request("/ping", { headers }, { DB: db });
    expect(res3.status).toBe(429);
    expect(res3.headers.get("RateLimit-Remaining")).toBe("0");
    expect(res3.headers.get("Retry-After")).not.toBeNull();
    // The refused request is still logged as an incident.
    const incidents = await db
      .prepare("SELECT count(*) AS n FROM arm_blocked_requests WHERE block_reason = 'rate_limit' AND workspace_id = ?")
      .bind(WS_ALPHA)
      .first<{ n: number }>();
    expect(incidents?.n).toBe(1);
  });

  it("defaults to bucket armor keyed by IP: two users on one IP share a count", async () => {
    const app = new Hono<ArmorEnv & { Variables: { user?: { uid: string } } }>();
    app.use("*", async (c, next) => {
      const uid = c.req.header("x-test-user");
      if (uid) c.set("user", { uid });
      await next();
    });
    app.use("*", trafficArmorMiddleware({ rateLimit: { limit: 2, windowSeconds: 3600 } }));
    app.get("/ping", (c) => c.text("pong"));

    const ip = { "cf-connecting-ip": "203.0.113.10" };
    expect((await app.request("/ping", { headers: { ...ip, "x-test-user": "u_a" } }, { DB: db })).status).toBe(200);
    expect((await app.request("/ping", { headers: { ...ip, "x-test-user": "u_b" } }, { DB: db })).status).toBe(200);
    expect((await app.request("/ping", { headers: { ...ip, "x-test-user": "u_c" } }, { DB: db })).status).toBe(429);
    const rows = await db.prepare("SELECT count(*) AS n FROM px_rate_limits WHERE key LIKE 'armor:%'").first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("counts a named bucket separately from another bucket", async () => {
    const app = new Hono<ArmorEnv>();
    app.use("/a", trafficArmorMiddleware({ rateLimit: { bucket: "bucket-a", limit: 1, windowSeconds: 3600 } }));
    app.use("/b", trafficArmorMiddleware({ rateLimit: { bucket: "bucket-b", limit: 1, windowSeconds: 3600 } }));
    app.get("/a", (c) => c.text("a"));
    app.get("/b", (c) => c.text("b"));

    const headers = { "cf-connecting-ip": "203.0.113.20" };
    expect((await app.request("/a", { headers }, { DB: db })).status).toBe(200);
    // Bucket b has its own count, so the same IP still passes there once.
    expect((await app.request("/b", { headers }, { DB: db })).status).toBe(200);
    expect((await app.request("/a", { headers }, { DB: db })).status).toBe(429);
    expect((await app.request("/b", { headers }, { DB: db })).status).toBe(429);
    const a = await db.prepare("SELECT count(*) AS n FROM px_rate_limits WHERE key LIKE 'bucket-a:%'").first<{ n: number }>();
    const b = await db.prepare("SELECT count(*) AS n FROM px_rate_limits WHERE key LIKE 'bucket-b:%'").first<{ n: number }>();
    const armor = await db.prepare("SELECT count(*) AS n FROM px_rate_limits WHERE key LIKE 'armor:%'").first<{ n: number }>();
    expect([a?.n, b?.n, armor?.n]).toEqual([1, 1, 0]);
  });

  it("key user counts per signed-in user on one IP and falls back to the IP without a user", async () => {
    const app = new Hono<ArmorEnv & { Variables: { user?: { uid: string } } }>();
    app.use("*", async (c, next) => {
      const uid = c.req.header("x-test-user");
      if (uid) c.set("user", { uid });
      await next();
    });
    app.use("*", trafficArmorMiddleware({ rateLimit: { bucket: "per-user", limit: 2, windowSeconds: 3600, key: "user" } }));
    app.get("/ping", (c) => c.text("pong"));

    const ip = { "cf-connecting-ip": "203.0.113.30" };
    const asUser = (uid: string) => app.request("/ping", { headers: { ...ip, "x-test-user": uid } }, { DB: db });
    expect((await asUser("u_a")).status).toBe(200);
    expect((await asUser("u_a")).status).toBe(200);
    expect((await asUser("u_a")).status).toBe(429);
    // User B on the same IP has their own count.
    expect((await asUser("u_b")).status).toBe(200);
    expect((await asUser("u_b")).status).toBe(200);
    // No user: counted by the IP, separately from both users.
    expect((await app.request("/ping", { headers: ip }, { DB: db })).status).toBe(200);
    const incidents = await db
      .prepare("SELECT count(*) AS n FROM arm_blocked_requests WHERE block_reason = 'rate_limit' AND workspace_id IS NULL")
      .first<{ n: number }>();
    expect(incidents?.n).toBe(1);
  });

  it("manages IP rules via API", async () => {
    const app = new Hono<ArmorEnv>();
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createTrafficArmorRoutes());

    // 1. Add rule
    const addRes = await app.request(
      "/api/armor/rules",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
        body: JSON.stringify({
          ipOrCidr: "203.0.113.88",
          action: "block",
          reason: "Malicious scanner",
        }),
      },
      { DB: db },
    );
    expect(addRes.status).toBe(201);

    // 2. List rules
    const listRes = await app.request("/api/armor/rules", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { rules: unknown[] };
    expect(listJson.rules).toHaveLength(1);

    // 3. Delete rule
    const delRes = await app.request(
      "/api/armor/rules",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
        body: JSON.stringify({
          ipOrCidr: "203.0.113.88",
        }),
      },
      { DB: db },
    );
    expect(delRes.status).toBe(200);
  });
});
