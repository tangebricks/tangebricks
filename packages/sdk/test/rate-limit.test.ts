// Story 0.21 (threat model audit 18, B16, PROPOSED-1): the shared D1 fixed-window limiter, run in workerd against a
// real local D1. Each test starts from an empty px_rate_limits table.
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { PX_RATE_LIMITS_DDL, applyMigration, rateLimit } from "../src/index.ts";
import type { D1Like, RateLimitRule } from "../src/index.ts";

const db = env.DB as unknown as D1Like;

async function resetTable(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS px_rate_limits").run();
  await applyMigration(db, PX_RATE_LIMITS_DDL);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetTable();
});

type Env = { DB?: D1Like; PX_RATE_LIMITS?: string };

function appWith(rule: RateLimitRule, opts: { now?: () => number; sweepProbability?: number; route?: string; workspace?: (c: { req: { header(n: string): string | undefined } }) => string | undefined } = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { workspace?: { id: string } } }>();
  if (opts.workspace) {
    app.use("*", async (c, next) => {
      const ws = opts.workspace!(c);
      if (ws) c.set("workspace", { id: ws });
      await next();
    });
  }
  const route = opts.route ?? "/login";
  app.post(route, rateLimit(rule, { now: opts.now, sweepProbability: opts.sweepProbability ?? 0 }), async (c) => {
    const body = await c.req.json().catch(() => null);
    return c.json({ ok: true, body });
  });
  return app;
}

function post(app: { request(input: string, init?: RequestInit, env?: Env): Response | Promise<Response> }, path: string, body: unknown, headers: Record<string, string> = {}, e: Env = { DB: db }) {
  return app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, e);
}

describe("@poc/sdk rateLimit (story 0.21)", () => {
  test("the N+1th call in a window gets 429 RATE_LIMITED with Retry-After and RateLimit headers", async () => {
    const app = appWith({ bucket: "t-ip", limit: 3, windowSeconds: 60, key: "ip" });
    const ip = { "cf-connecting-ip": "198.51.100.7" };
    for (let i = 0; i < 3; i += 1) expect((await post(app, "/login", {}, ip)).status).toBe(200);
    const res = await post(app, "/login", {}, ip);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; code: string; retryAfter: number };
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.error).toBe("Too many requests");
    expect(body.retryAfter).toBeGreaterThanOrEqual(1);
    expect(res.headers.get("Retry-After")).toBe(String(body.retryAfter));
    expect(res.headers.get("RateLimit-Limit")).toBe("3");
    expect(res.headers.get("RateLimit-Remaining")).toBe("0");
    expect(Number(res.headers.get("RateLimit-Reset"))).toBeGreaterThanOrEqual(1);
    // Another IP is not affected; x-forwarded-for's first entry is used when cf-connecting-ip is absent.
    expect((await post(app, "/login", {}, { "x-forwarded-for": "203.0.113.9, 10.0.0.1" })).status).toBe(200);
  });

  test("buckets are independent: the same key in another bucket has its own count", async () => {
    const a = appWith({ bucket: "t-a", limit: 1, windowSeconds: 60, key: "ip" });
    const b = appWith({ bucket: "t-b", limit: 1, windowSeconds: 60, key: "ip" });
    const ip = { "cf-connecting-ip": "198.51.100.8" };
    expect((await post(a, "/login", {}, ip)).status).toBe(200);
    expect((await post(a, "/login", {}, ip)).status).toBe(429);
    expect((await post(b, "/login", {}, ip)).status).toBe(200);
  });

  test("field: keys count per normalised value, the handler still reads the body, and a missing field falls back to the IP", async () => {
    const app = appWith({ bucket: "t-email", limit: 2, windowSeconds: 600, key: "field:email" });
    const ip = { "cf-connecting-ip": "198.51.100.9" };
    const first = await post(app, "/login", { email: "Victim@Example.com", password: "x" }, ip);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { body: { email: string } }).body.email).toBe("Victim@Example.com");
    // The same address, differently cased and padded, from another IP: still the same account bucket.
    expect((await post(app, "/login", { email: "  victim@example.COM " }, { "cf-connecting-ip": "203.0.113.1" })).status).toBe(200);
    expect((await post(app, "/login", { email: "victim@example.com" }, { "cf-connecting-ip": "203.0.113.2" })).status).toBe(429);
    // Another email is not affected.
    expect((await post(app, "/login", { email: "other@example.com" }, ip)).status).toBe(200);
    // No email: keyed by IP, which has its own count.
    expect((await post(app, "/login", { password: "x" }, ip)).status).toBe(200);
    expect((await post(app, "/login", { password: "x" }, ip)).status).toBe(200);
    expect((await post(app, "/login", { password: "x" }, ip)).status).toBe(429);
  });

  test("param: keys count per route param", async () => {
    const app = appWith({ bucket: "t-sub", limit: 2, windowSeconds: 60, key: "param:subscriptionId" }, { route: "/in/:subscriptionId" });
    for (let i = 0; i < 2; i += 1) expect((await post(app, "/in/sub_a", {})).status).toBe(200);
    expect((await post(app, "/in/sub_a", {})).status).toBe(429);
    expect((await post(app, "/in/sub_b", {})).status).toBe(200);
  });

  test("workspace keys use the verified workspace and fall back to the IP without one", async () => {
    const app = appWith(
      { bucket: "t-ws", limit: 1, windowSeconds: 60, key: "workspace" },
      { workspace: (c) => c.req.header("x-ws") },
    );
    expect((await post(app, "/login", {}, { "x-ws": "ws_a", "cf-connecting-ip": "198.51.100.1" })).status).toBe(200);
    expect((await post(app, "/login", {}, { "x-ws": "ws_a", "cf-connecting-ip": "198.51.100.2" })).status).toBe(429);
    expect((await post(app, "/login", {}, { "x-ws": "ws_b", "cf-connecting-ip": "198.51.100.1" })).status).toBe(200);
    expect((await post(app, "/login", {}, { "cf-connecting-ip": "198.51.100.3" })).status).toBe(200);
    expect((await post(app, "/login", {}, { "cf-connecting-ip": "198.51.100.3" })).status).toBe(429);
  });

  test("a new window resets the count", async () => {
    let now = Date.UTC(2026, 0, 1, 0, 0, 5);
    const app = appWith({ bucket: "t-window", limit: 1, windowSeconds: 60, key: "ip" }, { now: () => now });
    expect((await post(app, "/login", {})).status).toBe(200);
    expect((await post(app, "/login", {})).status).toBe(429);
    now += 60_000;
    expect((await post(app, "/login", {})).status).toBe(200);
    // The earlier window's row was deleted when the new one was written.
    const rows = await db.prepare("SELECT count(*) AS n FROM px_rate_limits").first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  test("limiter down: failClosed answers 503 RATE_LIMIT_UNAVAILABLE, fail-open lets the request through and logs", async () => {
    await db.prepare("DROP TABLE IF EXISTS px_rate_limits").run();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const closed = appWith({ bucket: "t-closed", limit: 5, windowSeconds: 60, key: "ip", failClosed: true });
      const res = await post(closed, "/login", {});
      expect(res.status).toBe(503);
      expect(((await res.json()) as { code: string }).code).toBe("RATE_LIMIT_UNAVAILABLE");
      // No DB binding at all is the same failure.
      expect((await post(closed, "/login", {}, {}, {})).status).toBe(503);

      const open = appWith({ bucket: "t-open", limit: 5, windowSeconds: 60, key: "ip" });
      expect((await post(open, "/login", {})).status).toBe(200);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  test("PX_RATE_LIMITS overrides a bucket's numbers; invalid JSON is ignored and logged; limit 0 cannot disable a rule", async () => {
    const app = appWith({ bucket: "auth-login-account", limit: 10, windowSeconds: 600, key: "field:email" });
    const override = { DB: db, PX_RATE_LIMITS: JSON.stringify({ "auth-login-account": { limit: 2, windowSeconds: 600 } }) };
    expect((await post(app, "/login", { email: "a@example.com" }, {}, override)).status).toBe(200);
    expect((await post(app, "/login", { email: "a@example.com" }, {}, override)).status).toBe(200);
    expect((await post(app, "/login", { email: "a@example.com" }, {}, override)).status).toBe(429);

    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const bad = appWith({ bucket: "t-bad", limit: 1, windowSeconds: 60, key: "ip" });
      const badEnv = { DB: db, PX_RATE_LIMITS: "{not json" };
      expect((await post(bad, "/login", {}, {}, badEnv)).status).toBe(200);
      expect((await post(bad, "/login", {}, {}, badEnv)).status).toBe(429);
      expect(log.mock.calls.some((args) => String(args[0]).includes("PX_RATE_LIMITS"))).toBe(true);

      const longWindow = appWith({ bucket: "t-long", limit: 1, windowSeconds: 60, key: "ip" });
      const longEnv = { DB: db, PX_RATE_LIMITS: JSON.stringify({ "t-long": { limit: 5, windowSeconds: 86_401 } }) };
      expect((await post(longWindow, "/login", {}, {}, longEnv)).status).toBe(200);
      expect((await post(longWindow, "/login", {}, {}, longEnv)).status).toBe(429);

      const zero = appWith({ bucket: "t-zero", limit: 1, windowSeconds: 60, key: "ip" });
      const zeroEnv = { DB: db, PX_RATE_LIMITS: JSON.stringify({ "t-zero": { limit: 0 } }) };
      expect((await post(zero, "/login", {}, {}, zeroEnv)).status).toBe(200);
      expect((await post(zero, "/login", {}, {}, zeroEnv)).status).toBe(429);
    } finally {
      log.mockRestore();
    }
  });

  test("the stored key holds no raw email or IP", async () => {
    const email = "stored-victim@example.com";
    const ip = "198.51.100.77";
    const byEmail = appWith({ bucket: "t-store-email", limit: 5, windowSeconds: 60, key: "field:email" });
    const byIp = appWith({ bucket: "t-store-ip", limit: 5, windowSeconds: 60, key: "ip" });
    await post(byEmail, "/login", { email }, { "cf-connecting-ip": ip });
    await post(byIp, "/login", { email }, { "cf-connecting-ip": ip });
    const rows = (await db.prepare("SELECT key FROM px_rate_limits").all<{ key: string }>()).results;
    expect(rows).toHaveLength(2);
    for (const { key } of rows) {
      expect(key).toMatch(/^t-store-(email|ip):[0-9a-f]{64}$/);
      expect(key).not.toContain(email);
      expect(key).not.toContain("stored-victim");
      expect(key).not.toContain(ip);
    }
  });

  test("a sweep deletes every key's windows older than a day, and nothing newer; without a sweep they stay", async () => {
    const now = Date.UTC(2026, 0, 10, 12, 0, 0);
    const nowSec = Math.floor(now / 1000);
    const seed = async () => {
      await db.prepare("DELETE FROM px_rate_limits").run();
      for (const [key, start] of [["once-a:x", nowSec - 86_400 * 3], ["once-b:y", nowSec - 86_401], ["recent:z", nowSec - 3600]] as const) {
        await db.prepare("INSERT INTO px_rate_limits (key, window_start, count) VALUES (?, ?, 1)").bind(key, start).run();
      }
    };
    const keys = async () => (await db.prepare("SELECT key FROM px_rate_limits ORDER BY key").all<{ key: string }>()).results.map((r) => r.key);

    await seed();
    await post(appWith({ bucket: "t-nosweep", limit: 5, windowSeconds: 60, key: "ip" }, { now: () => now, sweepProbability: 0 }), "/login", {});
    expect((await keys()).filter((k) => !k.startsWith("t-"))).toEqual(["once-a:x", "once-b:y", "recent:z"]);

    await seed();
    await post(appWith({ bucket: "t-sweep", limit: 5, windowSeconds: 60, key: "ip" }, { now: () => now, sweepProbability: 1 }), "/login", {});
    const left = await keys();
    expect(left).toContain("recent:z");
    expect(left).not.toContain("once-a:x");
    expect(left).not.toContain("once-b:y");
    expect(left.some((k) => k.startsWith("t-sweep:"))).toBe(true);
  });

  test("a rule with a non-positive limit, or a window outside 1..86400 seconds, is refused when it is built", () => {
    expect(() => rateLimit({ bucket: "t", limit: 0, windowSeconds: 60, key: "ip" })).toThrow(/RATE_LIMIT_RULE_INVALID/);
    expect(() => rateLimit({ bucket: "t", limit: 1, windowSeconds: 0, key: "ip" })).toThrow(/RATE_LIMIT_RULE_INVALID/);
    expect(() => rateLimit({ bucket: "t", limit: 1, windowSeconds: 86_401, key: "ip" })).toThrow(/RATE_LIMIT_RULE_INVALID/);
  });
});
