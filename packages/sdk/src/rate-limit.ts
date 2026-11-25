// One D1 fixed-window rate limiter for every brick and app (story 0.21, threat-model audit 18 / B16 / PROPOSED-1).
//
// `rateLimit(rule)` is a Hono middleware. Each request names one bucket and one key; the counter row is
// `${bucket}:${sha256(keyValue)}` per window in `px_rate_limits`, so no raw IP or email is ever stored and two buckets
// never share a count. The increment is one atomic upsert; older windows of the same key are deleted on the way.
//
// Limits are set by the code that mounts the rule (for an assembled app, the brick manifest's `rateLimits`), and an
// operator can change the numbers per bucket with the `PX_RATE_LIMITS` env var, read on every request:
//
//   PX_RATE_LIMITS='{"auth-login-account":{"limit":5,"windowSeconds":600}}'
//
// An override can raise or lower a number but never disable a rule (`limit` must be at least 1). Invalid JSON, or an
// invalid entry, is ignored and logged.
//
// When the limiter itself fails (no database, missing table, D1 error), a rule with `failClosed: true` answers 503
// RATE_LIMIT_UNAVAILABLE; any other rule logs the error and lets the request through. Auth rules always fail closed.
import type { MiddlewareHandler } from "hono";
import type { D1Like } from "./d1.ts";
import { authUserId } from "./authorise.ts";
import { systemScope } from "./scoped.ts";
import { sha256HexString } from "./session-token-hash.ts";

/** The env var that overrides bucket numbers: a JSON object `{ "<bucket>": { "limit": n, "windowSeconds": n } }`. */
export const RATE_LIMITS_ENV = "PX_RATE_LIMITS";

/** The table every limiter counts in. A system table: it has no workspace_id and holds only hashed keys. */
export const RATE_LIMIT_TABLE = "px_rate_limits";

/** The longest window a rule (or an override) may use: one day. The sweep deletes windows older than this. */
export const MAX_RATE_LIMIT_WINDOW_SECONDS = 86_400;

/** The share of counted requests that also sweep every key's expired windows (keys seen once are otherwise never deleted). */
export const RATE_LIMIT_SWEEP_PROBABILITY = 0.01;

/** The DDL for `px_rate_limits`. The assembler emits it as a migration; apps without migrations run it guarded. */
export const PX_RATE_LIMITS_DDL = [
  "CREATE TABLE IF NOT EXISTS px_rate_limits (",
  "  key TEXT NOT NULL,",
  "  window_start INTEGER NOT NULL,",
  "  count INTEGER NOT NULL,",
  "  PRIMARY KEY (key, window_start)",
  ");",
  "",
].join("\n");

/**
 * What a request is counted by:
 * - `ip`: `cf-connecting-ip`, else the first `x-forwarded-for` entry, else `"unknown"`;
 * - `workspace`: the verified workspace (the `ctx` / `workspace` the workspace middleware set), else the IP;
 * - `user`: the signed-in user the identity middleware set (story 2.6), else the IP;
 * - `field:<name>`: that JSON body field, lower-cased and trimmed, else the IP;
 * - `param:<name>`: that route param, else the IP.
 */
export type RateLimitKey = "ip" | "workspace" | "user" | `field:${string}` | `param:${string}`;

export interface RateLimitRule {
  /** The counter's name. Each bucket counts separately, and `PX_RATE_LIMITS` overrides by bucket. */
  bucket: string;
  /** Requests allowed per key per window (at least 1). */
  limit: number;
  /** Window length in seconds (fixed windows aligned to the epoch). */
  windowSeconds: number;
  key: RateLimitKey;
  /**
   * When the limiter cannot count (database missing or failing): true answers 503 RATE_LIMIT_UNAVAILABLE, false (the
   * default) logs the error and lets the request through. Auth rules always set this to true, so a broken limiter can
   * never reopen credential stuffing.
   */
  failClosed?: boolean;
}

export interface RateLimitOptions {
  /** Where the counters live. Default: `env.DB`. */
  db?: (env: Record<string, unknown>) => D1Like | undefined;
  /** Called before the 429 is returned (for example to record an incident). Its errors are logged, not thrown. */
  onLimited?: (c: Parameters<MiddlewareHandler>[0], info: RateLimitResult & { bucket: string; ip: string }) => unknown;
  /** The clock, in milliseconds. Tests only. */
  now?: () => number;
  /** Chance (0..1) that a counted request also sweeps expired windows. Default RATE_LIMIT_SWEEP_PROBABILITY; tests pass 0 or 1. */
  sweepProbability?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  /** Requests counted in this window, this one included. */
  current: number;
  remaining: number;
  /** Seconds until the window ends. */
  reset: number;
  /** Seconds a refused caller should wait (at least 1). */
  retryAfter: number;
}

/** The client IP the limiter keys on: `cf-connecting-ip`, then the first `x-forwarded-for`, then `"unknown"`. */
export function rateLimitClientIp(headers: Headers): string {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return "unknown";
}

/** The stored key: `${bucket}:${sha256(keyValue)}`. */
export async function rateLimitStorageKey(bucket: string, keyValue: string): Promise<string> {
  return `${bucket}:${await sha256HexString(keyValue)}`;
}

/**
 * Counts one request against `key` in the current window and says whether it is within `limit`. One atomic
 * upsert-increment; the key's earlier windows are deleted afterwards. Throws when the database fails.
 */
export async function hitRateLimit(
  db: D1Like,
  key: string,
  limit: number,
  windowSeconds: number,
  nowMs: number = Date.now(),
  opts: { sweep?: boolean } = {},
): Promise<RateLimitResult> {
  const nowSec = Math.floor(nowMs / 1000);
  const windowStart = nowSec - (nowSec % windowSeconds);
  const sys = systemScope(db, "rate limiter");
  const row = await sys
    .raw(
      "INSERT INTO px_rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1 RETURNING count",
      [key, windowStart],
    )
    .first<{ count: number }>();
  if (!row || typeof row.count !== "number") throw new Error("RATE_LIMIT_STORAGE: the counter upsert returned no row");
  await sys.raw("DELETE FROM px_rate_limits WHERE key = ? AND window_start < ?", [key, windowStart]).run();
  if (opts.sweep) {
    // Bounded global sweep: every window older than the longest allowed one has expired, whatever its key.
    await sys.raw("DELETE FROM px_rate_limits WHERE window_start < ?", [nowSec - MAX_RATE_LIMIT_WINDOW_SECONDS]).run();
  }
  const current = row.count;
  const reset = Math.max(1, windowStart + windowSeconds - nowSec);
  return {
    allowed: current <= limit,
    limit,
    current,
    remaining: Math.max(0, limit - current),
    reset,
    retryAfter: reset,
  };
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function windowSecondsOk(value: unknown): number | undefined {
  const n = positiveInt(value);
  return n !== undefined && n <= MAX_RATE_LIMIT_WINDOW_SECONDS ? n : undefined;
}

/** The rule's numbers after any `PX_RATE_LIMITS` override for its bucket. */
export function effectiveRateLimit(
  rule: Pick<RateLimitRule, "bucket" | "limit" | "windowSeconds">,
  envValue: unknown,
): { limit: number; windowSeconds: number } {
  const base = { limit: rule.limit, windowSeconds: rule.windowSeconds };
  if (typeof envValue !== "string" || envValue.trim() === "") return base;
  let parsed: unknown;
  try {
    parsed = JSON.parse(envValue);
  } catch {
    console.error(`${RATE_LIMITS_ENV} is not valid JSON; ignoring it`);
    return base;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`${RATE_LIMITS_ENV} must be a JSON object; ignoring it`);
    return base;
  }
  const entry = (parsed as Record<string, unknown>)[rule.bucket];
  if (entry === undefined) return base;
  if (!entry || typeof entry !== "object") {
    console.error(`${RATE_LIMITS_ENV}.${rule.bucket} must be an object; ignoring it`);
    return base;
  }
  const { limit, windowSeconds } = entry as { limit?: unknown; windowSeconds?: unknown };
  const nextLimit = limit === undefined ? base.limit : positiveInt(limit);
  const nextWindow = windowSeconds === undefined ? base.windowSeconds : windowSecondsOk(windowSeconds);
  if (nextLimit === undefined || nextWindow === undefined) {
    console.error(`${RATE_LIMITS_ENV}.${rule.bucket} needs whole numbers of at least 1 (windowSeconds at most ${MAX_RATE_LIMIT_WINDOW_SECONDS}); ignoring it`);
    return base;
  }
  return { limit: nextLimit, windowSeconds: nextWindow };
}

function verifiedWorkspaceId(c: Parameters<MiddlewareHandler>[0]): string | undefined {
  const ctx = c.get("ctx") as { workspaceId?: unknown } | undefined;
  if (typeof ctx?.workspaceId === "string" && ctx.workspaceId.length > 0) return ctx.workspaceId;
  const workspace = c.get("workspace") as { id?: unknown } | undefined;
  if (typeof workspace?.id === "string" && workspace.id.length > 0) return workspace.id;
  return undefined;
}

async function bodyField(c: Parameters<MiddlewareHandler>[0], field: string): Promise<string | undefined> {
  try {
    // A clone, so the handler (or a raw-body forwarder) still reads the whole body.
    const body = (await c.req.raw.clone().json()) as unknown;
    if (!body || typeof body !== "object") return undefined;
    const value = (body as Record<string, unknown>)[field];
    if (typeof value !== "string") return undefined;
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

/** The value a request is counted by, tagged with its kind so an IP fallback never shares a count with a field value. */
async function keyValueFor(c: Parameters<MiddlewareHandler>[0], key: RateLimitKey, ip: string): Promise<string> {
  if (key === "workspace") {
    const ws = verifiedWorkspaceId(c);
    return ws ? `workspace:${ws}` : `ip:${ip}`;
  }
  if (key === "user") {
    const uid = authUserId(c.get("user"));
    return uid ? `user:${uid}` : `ip:${ip}`;
  }
  if (key.startsWith("field:")) {
    const value = await bodyField(c, key.slice("field:".length));
    return value ? `${key}:${value}` : `ip:${ip}`;
  }
  if (key.startsWith("param:")) {
    const value = c.req.param(key.slice("param:".length));
    return typeof value === "string" && value.length > 0 ? `${key}:${value}` : `ip:${ip}`;
  }
  return `ip:${ip}`;
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8", ...headers },
  });
}

/** A Hono middleware that counts each request against `rule` and answers 429 RATE_LIMITED once the limit is passed. */
export function rateLimit(rule: RateLimitRule, options: RateLimitOptions = {}): MiddlewareHandler {
  if (!rule.bucket || positiveInt(rule.limit) === undefined || windowSecondsOk(rule.windowSeconds) === undefined) {
    throw new Error(
      `RATE_LIMIT_RULE_INVALID: bucket "${rule.bucket}" needs a name, a whole limit of at least 1 and windowSeconds from 1 to ${MAX_RATE_LIMIT_WINDOW_SECONDS}`,
    );
  }
  const sweepProbability = options.sweepProbability ?? RATE_LIMIT_SWEEP_PROBABILITY;
  return async (c, next) => {
    const env = (c.env ?? {}) as Record<string, unknown>;
    const ip = rateLimitClientIp(c.req.raw.headers);
    let result: RateLimitResult;
    try {
      const db = options.db ? options.db(env) : (env.DB as D1Like | undefined);
      if (!db || typeof db.prepare !== "function") throw new Error("RATE_LIMIT_STORAGE: no database binding");
      const { limit, windowSeconds } = effectiveRateLimit(rule, env[RATE_LIMITS_ENV]);
      const storageKey = await rateLimitStorageKey(rule.bucket, await keyValueFor(c, rule.key, ip));
      const sweep = sweepProbability > 0 && Math.random() < sweepProbability;
      result = await hitRateLimit(db, storageKey, limit, windowSeconds, options.now ? options.now() : Date.now(), { sweep });
    } catch (error) {
      console.error(`rate limiter "${rule.bucket}" unavailable:`, error instanceof Error ? error.message : error);
      if (rule.failClosed) {
        return jsonResponse({ error: "Rate limiter unavailable", code: "RATE_LIMIT_UNAVAILABLE" }, 503);
      }
      await next();
      return;
    }
    if (!result.allowed) {
      if (options.onLimited) {
        try {
          await options.onLimited(c, { ...result, bucket: rule.bucket, ip });
        } catch (error) {
          console.error(`rate limiter "${rule.bucket}" onLimited failed:`, error instanceof Error ? error.message : error);
        }
      }
      return jsonResponse({ error: "Too many requests", code: "RATE_LIMITED", retryAfter: result.retryAfter }, 429, {
        "Retry-After": String(result.retryAfter),
        "RateLimit-Limit": String(result.limit),
        "RateLimit-Remaining": "0",
        "RateLimit-Reset": String(result.reset),
      });
    }
    await next();
  };
}
