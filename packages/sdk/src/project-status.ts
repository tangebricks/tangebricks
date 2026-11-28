// Story 2.12: an opt-in, read-only status endpoint any brick-using app can mount, so Studio can show the app as a
// connected project (its bricks, its route switch states and its shadow comparisons) without reading the app's code or
// database.
//
// Off by default: it is middleware, and with no key configured, a missing key, a wrong key, a method other than GET or a
// path other than its own, it calls `next()`, so the request goes on through the app's own routing exactly as if nothing
// were mounted. The key is compared as SHA-256 hashes in constant time and never logged or echoed. The body carries only
// the fields below: no tenant, workspace or user id, email, traffic count or env value other than the parsed switch. No
// CORS headers: Studio fetches it server-side. See docs/migrating-an-existing-app.md.
import type { MiddlewareHandler } from "hono";
import { DEFAULT_ROUTE_SWITCH_VARIABLE, isRouteGroupName, parseRouteSwitch } from "./migration-switch.ts";
import type { RouteTarget, ShadowReport } from "./migration-switch.ts";

/** Where an app mounts the endpoint unless it picks another path. */
export const DEFAULT_STATUS_PATH = "/_tangebricks/status";

/** The env var holding the read-only status key unless a caller names another. */
export const DEFAULT_STATUS_KEY_VARIABLE = "TANGEBRICKS_STATUS_KEY";

/** How long one shadow reporter may take before it is reported as an error, in milliseconds. */
export const DEFAULT_SHADOW_TIMEOUT_MS = 2000;

/** The longest `shadowTimeoutMs` honoured; larger values are clamped to it. */
export const MAX_SHADOW_TIMEOUT_MS = 30_000;

/** How long a reporter's result is reused before it runs again, in milliseconds. */
export const DEFAULT_SHADOW_CACHE_MS = 60_000;

/** A bearer longer than this many bytes is treated as no bearer, so hashing work stays bounded. */
export const MAX_STATUS_KEY_BYTES = 512;

/** A brick the app uses: its catalog id and the version it runs. */
export interface BrickInfo {
  id: string;
  version: string;
}

/** A shadow report with, optionally, the ISO time since which the comparison has stayed exact. */
export type ProjectShadowReport = ShadowReport & { exactSince?: string };

export interface ProjectShadowReporter<E = unknown> {
  /** The route group the report is about (`^[a-z][a-z0-9-]*$`); a reporter with an invalid group is skipped. */
  group: string;
  /** Returns the report. `signal` aborts when the reporter runs past `shadowTimeoutMs`. */
  report: (env: E, options: { signal: AbortSignal }) => Promise<ProjectShadowReport>;
}

export interface ProjectStatusOptions<E = unknown> {
  /** The full request path the endpoint answers on. Default `/_tangebricks/status`. */
  path?: string;
  /** The env var holding the status key. Default `TANGEBRICKS_STATUS_KEY`. */
  keyVariable?: string;
  /** The env var holding the route switch. Default `ROUTE_SWITCH`. */
  switchVariable?: string;
  /** A display name for the project. */
  project?: string;
  /** The bricks the app uses, or a function of the env returning them. Invalid entries are dropped. */
  bricks?: BrickInfo[] | ((env: E) => BrickInfo[]);
  /** Shadow reporters, run in parallel, at most one run of each at a time. */
  shadow?: ProjectShadowReporter<E>[];
  /** How long each reporter may take, in milliseconds. Default 2000, at most 30000. */
  shadowTimeoutMs?: number;
  /** How long a reporter's result (or error) is reused, in milliseconds. Default 60000; 0 disables the cache. */
  shadowCacheMs?: number;
}

export type ProjectStatusShadowEntry =
  { group: string; exact: boolean; compared: number; differing: number; checkedAt: string; exactSince?: string } | { group: string; error: true };

/** The body of a 200 response. */
export interface ProjectStatusBody {
  version: 1;
  project?: string;
  generatedAt: string;
  bricks: BrickInfo[];
  switch: { variable: string; groups: Record<string, RouteTarget> };
  shadow: ProjectStatusShadowEntry[];
}

const BRICK_ID = /^[a-z0-9][a-z0-9-]*$/;
const SEMVER_LIKE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/**
 * True when `a` and `b` are equal. Both are SHA-256 hashed first, so the byte comparison always runs over two 32-byte
 * digests whatever the inputs' lengths, and it visits every byte without an early exit.
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  const length = Math.max(ha.length, hb.length);
  let diff = ha.length ^ hb.length;
  for (let i = 0; i < length; i++) diff |= (ha[i] ?? 0) ^ (hb[i] ?? 0);
  return diff === 0;
}

/** The bearer token, or "" when there is none, it is malformed, or it is longer than `MAX_STATUS_KEY_BYTES`. */
function bearerOf(header: string | undefined): string {
  // A header far past the cap is dropped before any regex or encoding work.
  if (!header || header.length > MAX_STATUS_KEY_BYTES + 64) return "";
  const token = BEARER.exec(header)?.[1] ?? "";
  return new TextEncoder().encode(token).length > MAX_STATUS_KEY_BYTES ? "" : token;
}

function envOf(env: unknown): Record<string, unknown> {
  return env && typeof env === "object" ? (env as Record<string, unknown>) : {};
}

function validBricks(list: unknown): BrickInfo[] {
  if (!Array.isArray(list)) return [];
  const out: BrickInfo[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const { id, version } = entry as Record<string, unknown>;
    if (typeof id === "string" && BRICK_ID.test(id) && typeof version === "string" && SEMVER_LIKE.test(version)) {
      out.push({ id, version });
    }
  }
  return out;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** An ISO-8601 UTC timestamp like `Date.prototype.toISOString` writes (milliseconds optional). */
function isIsoUtc(value: unknown): value is string {
  return typeof value === "string" && value.length <= 24 && ISO_UTC.test(value) && !Number.isNaN(Date.parse(value));
}

/** Copies only the whitelisted fields; anything malformed becomes an error entry. */
function shadowEntry(group: string, report: unknown): ProjectStatusShadowEntry {
  if (!report || typeof report !== "object") return { group, error: true };
  const r = report as Record<string, unknown>;
  if (typeof r.exact !== "boolean" || !isCount(r.compared) || !isCount(r.differing) || !isIsoUtc(r.checkedAt)) {
    return { group, error: true };
  }
  const entry: ProjectStatusShadowEntry = { group, exact: r.exact, compared: r.compared, differing: r.differing, checkedAt: r.checkedAt };
  if (r.exact && isIsoUtc(r.exactSince)) entry.exactSince = r.exactSince;
  return entry;
}

async function runReporter<E>(reporter: ProjectShadowReporter<E>, env: E, timeoutMs: number): Promise<ProjectStatusShadowEntry> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error("shadow reporter timed out"));
      resolve("timeout");
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => reporter.report(env, { signal: controller.signal })), timeout]);
    if (result === "timeout") return { group: reporter.group, error: true };
    return shadowEntry(reporter.group, result);
  } catch {
    return { group: reporter.group, error: true };
  } finally {
    clearTimeout(timer);
  }
}

function timeoutFrom(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) return DEFAULT_SHADOW_TIMEOUT_MS;
  return Math.min(requested, MAX_SHADOW_TIMEOUT_MS);
}

function cacheFrom(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 0) return DEFAULT_SHADOW_CACHE_MS;
  return requested;
}

interface ReporterState {
  inflight?: Promise<ProjectStatusShadowEntry>;
  cached?: { entry: ProjectStatusShadowEntry; at: number };
}

/**
 * Read-only Hono middleware answering the project's status as JSON on one path (`path`, default
 * `/_tangebricks/status`). Mount it with `app.use(DEFAULT_STATUS_PATH, projectStatus({ ... }))`. It answers only `GET`
 * on its own path with `Authorization: Bearer <key>`, where the key is the value of `keyVariable` in the env. Anything
 * else, including an unset or empty key, calls `next()`, so the app's own routing answers as if nothing were mounted.
 *
 * Each reporter runs at most once at a time (concurrent requests share the run) and its result is reused for
 * `shadowCacheMs`. A run that passes `shadowTimeoutMs` is aborted through its `signal` and reported as an error.
 */
export function projectStatus<E = unknown>(options: ProjectStatusOptions<E> = {}): MiddlewareHandler {
  const path = options.path ?? DEFAULT_STATUS_PATH;
  const keyVariable = options.keyVariable ?? DEFAULT_STATUS_KEY_VARIABLE;
  const switchVariable = options.switchVariable ?? DEFAULT_ROUTE_SWITCH_VARIABLE;
  const timeoutMs = timeoutFrom(options.shadowTimeoutMs);
  const cacheMs = cacheFrom(options.shadowCacheMs);
  const reporters = (options.shadow ?? []).filter((r) => typeof r?.group === "string" && isRouteGroupName(r.group) && typeof r.report === "function");
  const states = reporters.map((): ReporterState => ({}));
  const project = typeof options.project === "string" && options.project.length > 0 ? options.project : undefined;

  const shadowOf = (index: number, env: E): Promise<ProjectStatusShadowEntry> => {
    const state = states[index]!;
    if (state.cached && Date.now() - state.cached.at < cacheMs) return Promise.resolve(state.cached.entry);
    if (state.inflight) return state.inflight;
    const run = runReporter(reporters[index]!, env, timeoutMs).then((entry) => {
      state.inflight = undefined;
      state.cached = cacheMs > 0 ? { entry, at: Date.now() } : undefined;
      return entry;
    });
    state.inflight = run;
    return run;
  };

  return async (c, next) => {
    if (c.req.path !== path) return next();
    const env = envOf(c.env);
    const configured = env[keyVariable];
    const key = typeof configured === "string" ? configured : "";
    const bearer = bearerOf(c.req.header("Authorization"));
    // Always hash and compare, so an unset key takes the same path as a wrong one.
    const equal = await constantTimeEqual(bearer, key);
    if (c.req.method !== "GET" || key.length === 0 || bearer.length === 0 || !equal) return next();

    const typedEnv = c.env as E;
    let bricks: BrickInfo[] = [];
    try {
      bricks = validBricks(typeof options.bricks === "function" ? options.bricks(typedEnv) : options.bricks);
    } catch {
      bricks = [];
    }
    const rawSwitch = env[switchVariable];
    const groups = Object.fromEntries(parseRouteSwitch(typeof rawSwitch === "string" ? rawSwitch : undefined)) as Record<string, RouteTarget>;
    const shadow = await Promise.all(reporters.map((_, i) => shadowOf(i, typedEnv)));

    const body: ProjectStatusBody = {
      version: 1,
      ...(project !== undefined ? { project } : {}),
      generatedAt: new Date().toISOString(),
      bricks,
      switch: { variable: switchVariable, groups },
      shadow,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  };
}
