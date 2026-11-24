// Story 0.21 (threat model audit 18, B16, PROPOSED-1): nothing was rate-limited. Run against the assembled
// max-compatible app (the outermost surface) in workerd, with PX_RATE_LIMITS lowering the declared limits so the test
// stays fast: one email's logins, one IP's signups, one workspace's top-ups and one subscription's inbound webhooks
// each get 429 RATE_LIMITED with Retry-After on the N+1th call in a window (Better Auth's own sign-in/email shares the
// login buckets), and another email, IP, workspace or
// subscription is not affected. The auth rules fail closed (503) when the limiter cannot count; the money rules fail open.
import { env } from "cloudflare:workers";
import { describe, expect, test, vi } from "vitest";
import type { D1Like } from "@poc/sdk";
import { call, resetAndMigrate } from "./support/assembled-app.ts";
import type { App } from "./support/assembled-app.ts";

const entryLoaders = import.meta.glob("../../../out/max-compatible/src/index.ts") as Record<string, () => Promise<{ default: App }>>;
const app = (await Object.values(entryLoaders)[0]?.())?.default;
const sql = import.meta.glob("../../../out/max-compatible/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const db = env.DB as unknown as D1Like;

/** The test env with the declared limits lowered (and nothing else of the suite-wide override kept). */
const lowered = {
  ...(env as unknown as Record<string, unknown>),
  PX_RATE_LIMITS: JSON.stringify({
    "auth-login-account": { limit: 3, windowSeconds: 600 },
    "auth-login-ip": { limit: 1000, windowSeconds: 600 },
    "auth-signup-ip": { limit: 2, windowSeconds: 3600 },
    "wallet-verify": { limit: 3, windowSeconds: 60 },
    "wallet-create-order": { limit: 3, windowSeconds: 60 },
    "wallet-deduct": { limit: 3, windowSeconds: 60 },
    "webhook-in": { limit: 3, windowSeconds: 60 },
  }),
};

function expectRateLimited(res: { status: number; text: string; headers: Headers }, label: string): void {
  expect(res.status, label).toBe(429);
  const body = JSON.parse(res.text) as { code: string; retryAfter: number };
  expect(body.code, label).toBe("RATE_LIMITED");
  expect(res.headers.get("Retry-After"), label).toBe(String(body.retryAfter));
  expect(Number(res.headers.get("Retry-After")), label).toBeGreaterThanOrEqual(1);
  expect(res.headers.get("RateLimit-Remaining"), label).toBe("0");
}

async function newWorkspace(owner: string, name: string): Promise<string> {
  const created = await call(app!, "POST", "/api/workspaces", { user: owner, body: { name } });
  expect(created.status).toBe(201);
  return (JSON.parse(created.text) as { workspace: { id: string } }).workspace.id;
}

describe("rate limits on auth, money and fan-out paths of the assembled max-compatible app (story 0.21)", () => {
  test(
    "the N+1th login, signup, top-up and inbound webhook get 429; other keys are not affected",
    async () => {
      // test/support/global-setup.ts assembles out/max-compatible before the workers project runs.
      expect(app, "out/max-compatible/src/index.ts was not assembled").toBeDefined();
      expect(Object.keys(sql).some((name) => name.endsWith("_shell__px_rate_limits.sql")), "the px_rate_limits migration").toBe(true);
      await resetAndMigrate(db, sql);

      // 1. Login, one email (auth-login-account 3): spread over different IPs, so only the per-account bucket stops it.
      for (let i = 0; i < 3; i += 1) {
        const res = await call(app!, "POST", "/api/auth/login", {
          body: { email: "victim@example.test", password: `guess-${i}` },
          headers: { "cf-connecting-ip": `198.51.100.${10 + i}` },
          env: lowered,
        });
        expect(res.status, `login ${i + 1}`).toBe(401);
      }
      expectRateLimited(
        await call(app!, "POST", "/api/auth/login", {
          body: { email: "Victim@Example.test", password: "guess-4" },
          headers: { "cf-connecting-ip": "198.51.100.20" },
          env: lowered,
        }),
        "4th login for one email",
      );
      const otherLogin = await call(app!, "POST", "/api/auth/login", {
        body: { email: "someone-else@example.test", password: "guess" },
        headers: { "cf-connecting-ip": "198.51.100.20" },
        env: lowered,
      });
      expect(otherLogin.status, "another email").toBe(401);

      //    Better Auth's own POST /auth/sign-in/email shares the same buckets: two custom logins and one sign-in/email
      //    for one email use up its 3, so the next attempt through either entry point is refused.
      for (const [i, path] of (["/api/auth/login", "/api/auth/login", "/api/auth/sign-in/email"] as const).entries()) {
        const res = await call(app!, "POST", path, {
          body: { email: "shared@example.test", password: `guess-${i}` },
          headers: { "cf-connecting-ip": `198.51.100.${40 + i}` },
          env: lowered,
        });
        expect(res.status, `shared ${path} ${i + 1}`).not.toBe(429);
      }
      expectRateLimited(
        await call(app!, "POST", "/api/auth/sign-in/email", {
          body: { email: "shared@example.test", password: "guess-4" },
          headers: { "cf-connecting-ip": "198.51.100.50" },
          env: lowered,
        }),
        "4th attempt for one email via sign-in/email",
      );
      expectRateLimited(
        await call(app!, "POST", "/api/auth/login", {
          body: { email: "shared@example.test", password: "guess-5" },
          headers: { "cf-connecting-ip": "198.51.100.51" },
          env: lowered,
        }),
        "5th attempt for one email via /auth/login",
      );

      // 2. Signup, one IP (auth-signup-ip 2).
      for (let i = 0; i < 2; i += 1) {
        const res = await call(app!, "POST", "/api/auth/signup", {
          body: { email: `new-${i}@example.test`, password: "Password12345!", name: `New ${i}` },
          headers: { "cf-connecting-ip": "203.0.113.50" },
          env: lowered,
        });
        expect(res.status, `signup ${i + 1}`).toBe(201);
      }
      expectRateLimited(
        await call(app!, "POST", "/api/auth/signup", {
          body: { email: "new-3@example.test", password: "Password12345!", name: "New 3" },
          headers: { "cf-connecting-ip": "203.0.113.50" },
          env: lowered,
        }),
        "3rd signup from one IP",
      );
      const otherSignup = await call(app!, "POST", "/api/auth/signup", {
        body: { email: "new-4@example.test", password: "Password12345!", name: "New 4" },
        headers: { "cf-connecting-ip": "203.0.113.51" },
        env: lowered,
      });
      expect(otherSignup.status, "signup from another IP").toBe(201);

      // 3. Money. Starting a top-up (payments/create-order, wallet-create-order 3) is workspace-guarded and counts per
      //    verified workspace: from one IP, workspace A is stopped and workspace B is not. (No gateway is configured, so
      //    the route itself answers 503 NOT_CONFIGURED; the limiter counts in front of it.)
      const wsA = await newWorkspace("alice", "Workspace A");
      const wsB = await newWorkspace("bob", "Workspace B");
      const sameIp = { "cf-connecting-ip": "192.0.2.10" };
      for (let i = 0; i < 3; i += 1) {
        const res = await call(app!, "POST", "/api/payments/create-order", { user: "alice", ws: wsA, body: { amount: 100 }, headers: sameIp, env: lowered });
        expect(res.status, `create-order ${i + 1}`).not.toBe(429);
      }
      expectRateLimited(
        await call(app!, "POST", "/api/payments/create-order", { user: "alice", ws: wsA, body: { amount: 100 }, headers: sameIp, env: lowered }),
        "4th top-up order in workspace A",
      );
      const otherOrder = await call(app!, "POST", "/api/payments/create-order", { user: "bob", ws: wsB, body: { amount: 100 }, headers: sameIp, env: lowered });
      expect(otherOrder.status, "top-up order in workspace B from the same IP").not.toBe(429);

      //    Confirming a top-up (payments/verify, wallet-verify 3) has no workspace guard by design (a suspended workspace
      //    must still complete a charged payment), so it is declared per IP: one IP is stopped whichever workspace or
      //    user it claims, and another IP is not.
      for (let i = 0; i < 3; i += 1) {
        const res = await call(app!, "POST", "/api/payments/verify", {
          user: i % 2 === 0 ? "alice" : "bob",
          ws: i % 2 === 0 ? wsA : wsB,
          body: { order_id: `order_${i}` },
          headers: sameIp,
          env: lowered,
        });
        expect(res.status, `verify ${i + 1}`).not.toBe(429);
      }
      expectRateLimited(
        await call(app!, "POST", "/api/payments/verify", { user: "bob", ws: wsB, body: { order_id: "order_4" }, headers: sameIp, env: lowered }),
        "4th top-up verify from one IP",
      );
      const otherVerify = await call(app!, "POST", "/api/payments/verify", {
        user: "alice",
        ws: wsA,
        body: { order_id: "order_b" },
        headers: { "cf-connecting-ip": "192.0.2.11" },
        env: lowered,
      });
      expect(otherVerify.status, "verify from another IP").not.toBe(429);

      //    Spending (wallet/deduct, wallet-deduct 3) sits behind the workspace guard, so it counts per verified
      //    workspace: workspace A is stopped from any IP, workspace B is not.
      for (let i = 0; i < 3; i += 1) {
        const res = await call(app!, "POST", "/api/wallet/deduct", {
          user: "alice",
          ws: wsA,
          body: { amount: 1 },
          headers: { "cf-connecting-ip": `192.0.2.${100 + i}` },
          env: lowered,
        });
        expect(res.status, `deduct ${i + 1}`).not.toBe(429);
      }
      expectRateLimited(
        await call(app!, "POST", "/api/wallet/deduct", { user: "alice", ws: wsA, body: { amount: 1 }, headers: { "cf-connecting-ip": "192.0.2.200" }, env: lowered }),
        "4th deduct in workspace A",
      );
      const otherWorkspace = await call(app!, "POST", "/api/wallet/deduct", {
        user: "bob",
        ws: wsB,
        body: { amount: 1 },
        headers: { "cf-connecting-ip": "192.0.2.200" },
        env: lowered,
      });
      expect(otherWorkspace.status, "deduct in workspace B").not.toBe(429);

      // 4. Inbound webhook, one subscription (webhook-in 3). Unknown subscriptions are refused by the route; the limiter
      //    counts in front of it either way.
      for (let i = 0; i < 3; i += 1) {
        const res = await call(app!, "POST", "/api/webhooks/in/sub_flooded", { body: { n: i }, env: lowered });
        expect(res.status, `webhook ${i + 1}`).not.toBe(429);
      }
      expectRateLimited(await call(app!, "POST", "/api/webhooks/in/sub_flooded", { body: { n: 4 }, env: lowered }), "4th webhook for one subscription");
      const otherSub = await call(app!, "POST", "/api/webhooks/in/sub_quiet", { body: { n: 1 }, env: lowered });
      expect(otherSub.status, "another subscription").not.toBe(429);

      // Nothing raw is stored.
      const keys = (await db.prepare("SELECT key FROM px_rate_limits").all<{ key: string }>()).results.map((r) => r.key);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key).toMatch(/^[a-z-]+:[0-9a-f]{64}$/);
        expect(key).not.toMatch(/victim|example\.test|198\.51|203\.0|192\.0|sub_flooded/);
      }
    },
    120_000,
  );

  test(
    "when the limiter cannot count, auth rules answer 503 RATE_LIMIT_UNAVAILABLE and money rules let the request through",
    async () => {
      expect(app, "out/max-compatible/src/index.ts was not assembled").toBeDefined();
      await resetAndMigrate(db, sql);
      const ws = await newWorkspace("carol", "Workspace C");
      await db.prepare("DROP TABLE IF EXISTS px_rate_limits").run();
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const login = await call(app!, "POST", "/api/auth/login", { body: { email: "a@example.test", password: "x" } });
        expect(login.status).toBe(503);
        expect((JSON.parse(login.text) as { code: string }).code).toBe("RATE_LIMIT_UNAVAILABLE");
        const reset = await call(app!, "POST", "/api/auth/request-password-reset", { body: { email: "a@example.test" } });
        expect(reset.status).toBe(503);

        const deduct = await call(app!, "POST", "/api/wallet/deduct", { user: "carol", ws, body: { amount: 1 } });
        expect([429, 503]).not.toContain(deduct.status);
        expect(log).toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    },
    120_000,
  );
});
