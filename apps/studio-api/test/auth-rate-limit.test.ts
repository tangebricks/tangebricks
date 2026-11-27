// Story 0.21 (threat model audit 18 / B16): studio-api's custom POST /api/auth/login and /api/auth/signup call
// auth.api.* directly, past Better Auth's own limiter, so they carry the shared SDK limiter with core-auth's buckets
// (auth-login-ip, auth-login-account, auth-signup-ip), failing closed. Each test uses its own client IP, so its counts
// are its own; the suite-wide PX_RATE_LIMITS raise (vitest.workers.config.ts) is replaced here by each test's env.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import type { D1Like } from "@poc/sdk";
import { app as studioApp } from "../src/index.ts";
import type { StudioApiEnv } from "../src/index.ts";

const rawEnv = env as unknown as StudioApiEnv & { PX_RATE_LIMITS?: string };
/** The env with the default numbers (no PX_RATE_LIMITS override). */
const defaultsEnv = { ...rawEnv, PX_RATE_LIMITS: undefined } as StudioApiEnv;

async function post(path: string, body: unknown, ip: string, requestEnv: StudioApiEnv): Promise<Response> {
  return studioApp.fetch(
    new Request(`https://example.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify(body),
    }),
    requestEnv,
  );
}

function uniqueIp(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  return `198.18.${bytes[0]}.${bytes[1]}`;
}

describe("studio-api custom auth routes are rate-limited (story 0.21)", () => {
  test("the N+1th login for one email gets 429 RATE_LIMITED with Retry-After; another email is not affected", async () => {
    const email = `rl-login-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const other = `rl-other-${crypto.randomUUID().slice(0, 8)}@example.test`;
    for (const address of [email, other]) {
      const signup = await post("/api/auth/signup", { email: address, password: "Password12345!", name: "RL" }, uniqueIp(), defaultsEnv);
      expect(signup.status).toBe(201);
    }

    // auth-login-account lowered to 3 per window. The attempts come from different IPs, as a spread-out credential
    // stuffing run would, so only the per-account bucket can stop them.
    const lowered = {
      ...rawEnv,
      PX_RATE_LIMITS: JSON.stringify({ "auth-login-account": { limit: 3, windowSeconds: 600 } }),
    } as StudioApiEnv;
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push((await post("/api/auth/login", { email, password: i === 2 ? "Password12345!" : "wrong-password" }, uniqueIp(), lowered)).status);
    }
    expect(statuses).toEqual([401, 401, 200]);

    const limited = await post("/api/auth/login", { email: email.toUpperCase(), password: "Password12345!" }, uniqueIp(), lowered);
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { code: string; retryAfter: number };
    expect(body.code).toBe("RATE_LIMITED");
    expect(limited.headers.get("Retry-After")).toBe(String(body.retryAfter));
    expect(limited.headers.get("RateLimit-Remaining")).toBe("0");

    expect((await post("/api/auth/login", { email: other, password: "Password12345!" }, uniqueIp(), lowered)).status).toBe(200);
  });

  test("Better Auth's own POST /api/auth/sign-in/email shares the login buckets with the custom /api/auth/login", async () => {
    const email = `rl-shared-${crypto.randomUUID().slice(0, 8)}@example.test`;
    expect((await post("/api/auth/signup", { email, password: "Password12345!", name: "RL" }, uniqueIp(), defaultsEnv)).status).toBe(201);
    const lowered = {
      ...rawEnv,
      PX_RATE_LIMITS: JSON.stringify({ "auth-login-account": { limit: 3, windowSeconds: 600 } }),
    } as StudioApiEnv;
    // Two custom logins and one Better Auth sign-in for the same email use up its 3.
    expect((await post("/api/auth/login", { email, password: "wrong-password" }, uniqueIp(), lowered)).status).toBe(401);
    expect((await post("/api/auth/login", { email, password: "wrong-password" }, uniqueIp(), lowered)).status).toBe(401);
    expect((await post("/api/auth/sign-in/email", { email, password: "Password12345!" }, uniqueIp(), lowered)).status).toBe(200);
    const viaBetterAuth = await post("/api/auth/sign-in/email", { email, password: "Password12345!" }, uniqueIp(), lowered);
    expect(viaBetterAuth.status).toBe(429);
    expect(((await viaBetterAuth.json()) as { code: string }).code).toBe("RATE_LIMITED");
    expect((await post("/api/auth/login", { email, password: "Password12345!" }, uniqueIp(), lowered)).status).toBe(429);
  });

  test("the 6th signup from one IP in an hour gets 429 (default auth-signup-ip 5/3600s); another IP is not affected", async () => {
    const ip = uniqueIp();
    for (let i = 0; i < 5; i += 1) {
      const res = await post(
        "/api/auth/signup",
        { email: `rl-signup-${i}-${crypto.randomUUID().slice(0, 8)}@example.test`, password: "Password12345!", name: "RL" },
        ip,
        defaultsEnv,
      );
      expect(res.status, `signup ${i + 1}`).toBe(201);
    }
    const sixth = await post(
      "/api/auth/signup",
      { email: `rl-signup-6-${crypto.randomUUID().slice(0, 8)}@example.test`, password: "Password12345!", name: "RL" },
      ip,
      defaultsEnv,
    );
    expect(sixth.status).toBe(429);
    expect(((await sixth.json()) as { code: string }).code).toBe("RATE_LIMITED");

    const elsewhere = await post(
      "/api/auth/signup",
      { email: `rl-signup-x-${crypto.randomUUID().slice(0, 8)}@example.test`, password: "Password12345!", name: "RL" },
      uniqueIp(),
      defaultsEnv,
    );
    expect(elsewhere.status).toBe(201);
  });

  test("the counters hold hashed keys only: no email or IP is stored in px_rate_limits", async () => {
    const email = `rl-hash-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const ip = uniqueIp();
    await post("/api/auth/login", { email, password: "whatever-password" }, ip, defaultsEnv);
    const rows = (await (rawEnv.STUDIO_DB as D1Like).prepare("SELECT key FROM px_rate_limits").all<{ key: string }>()).results;
    expect(rows.length).toBeGreaterThan(0);
    for (const { key } of rows) {
      expect(key).toMatch(/^auth-[a-z-]+:[0-9a-f]{64}$/);
      expect(key).not.toContain(email);
      expect(key).not.toContain(ip);
    }
  });
});
