// Story 2.11: the strangler route switch, for any app moving onto bricks one route group at a time.
//
// The switch value (an env var, `ROUTE_SWITCH` by default) is a comma-separated list of `group:target` pairs, for
// example `health:brick,wallet:shadow`. A group not listed, an unknown target, or a malformed pair means `app`: the
// app's own code answers. The switch only picks which code answers; it never moves data. See
// docs/migrating-an-existing-app.md.
//
// `migrationTelemetry` writes one Workers Analytics Engine data point per noted group per request: the group, the
// handler that answered and the status class (`1xx`, `2xx`, `3xx`, `4xx`, `5xx`, or `error` when the handler threw).
// Nothing else (no tenant, user, path, query, IP or body), no D1, and no
// await on the response path.
import type { Context, MiddlewareHandler } from "hono";

/** Which code answers a route group: the app's own, the brick, or the app's own with the brick mirrored alongside. */
export type RouteTarget = "app" | "brick" | "shadow";

/** A brick's router (a Hono app, or anything with Hono's `fetch` signature). */
export interface BrickRouter {
  fetch(request: Request, env: unknown, executionCtx?: unknown): Response | Promise<Response>;
}

/** The response header naming who answered: `brick:<group>` or `app:<group>`. */
export const ROUTE_HANDLER_HEADER = "X-Route-Handler";

/** The env var the switch is read from unless a caller names another. */
export const DEFAULT_ROUTE_SWITCH_VARIABLE = "ROUTE_SWITCH";

/** The Hono context variable that holds the handlers noted for this request (group to handler). */
export const ROUTE_HANDLERS_VAR = "px.routeHandlers";

const GROUP_NAME = /^[a-z][a-z0-9-]*$/;

/** The longest route group name, in characters (Analytics Engine refuses an index over 96 bytes). */
export const MAX_ROUTE_GROUP_LENGTH = 64;

/** True when `group` is a valid route group name: `^[a-z][a-z0-9-]*$`, at most 64 characters. */
export function isRouteGroupName(group: string): boolean {
  return group.length <= MAX_ROUTE_GROUP_LENGTH && GROUP_NAME.test(group);
}

/** Parses a switch value. Malformed pairs, bad group names and unknown targets are ignored, never thrown. */
export function parseRouteSwitch(raw: string | undefined): Map<string, RouteTarget> {
  const targets = new Map<string, RouteTarget>();
  if (!raw) return targets;
  for (const entry of raw.split(",")) {
    const [group, target, ...rest] = entry.split(":").map((part) => part.trim());
    if (rest.length > 0 || !group || !isRouteGroupName(group)) continue;
    if (target === "app" || target === "brick" || target === "shadow") targets.set(group, target);
  }
  return targets;
}

export interface ResolveRouteOptions {
  /** A brick router (or brick code path) is available for this group. Without one, `brick` resolves to `app`. */
  hasBrick: boolean;
  /** The caller handles `shadow` for this group. Without it, `shadow` resolves to `app`. */
  allowShadow?: boolean;
}

/**
 * Which code answers `group`: `brick` only when the switch says `brick` and a brick is available, `shadow` only when
 * the switch says `shadow` and the caller allows shadow, otherwise `app`. The three-argument form
 * `(raw, group, hasBrick)` never returns `shadow`.
 */
export function resolveRouteTarget(raw: string | undefined, group: string, hasBrick: boolean): RouteTarget;
export function resolveRouteTarget(raw: string | undefined, group: string, options: ResolveRouteOptions): RouteTarget;
export function resolveRouteTarget(raw: string | undefined, group: string, options: boolean | ResolveRouteOptions): RouteTarget {
  const { hasBrick, allowShadow = false } = typeof options === "boolean" ? { hasBrick: options } : options;
  const target = parseRouteSwitch(raw).get(group);
  if (target === "brick" && hasBrick) return "brick";
  if (target === "shadow" && allowShadow) return "shadow";
  return "app";
}

// The helpers work on any Hono context, whatever its Env type.
type AnyContext = Context<{ Variables: Record<string, unknown> }>;

function handlersOf(c: Context): Map<string, RouteTarget> {
  const ctx = c as unknown as AnyContext;
  const existing = ctx.get(ROUTE_HANDLERS_VAR);
  if (existing instanceof Map) return existing as Map<string, RouteTarget>;
  const created = new Map<string, RouteTarget>();
  ctx.set(ROUTE_HANDLERS_VAR, created);
  return created;
}

/**
 * Notes which handler answered `group` in this request, for `migrationTelemetry`. A group noted twice counts once,
 * with the last handler. It does not set `X-Route-Handler`; an inline group sets that itself if it wants it.
 */
export function noteRouteHandler(c: Context, group: string, handler: RouteTarget): void {
  if (!isRouteGroupName(group)) return;
  handlersOf(c).set(group, handler);
}

/** The handlers noted so far in this request, in the order their groups were first noted. Reads without writing. */
export function notedRouteHandlers(c: Context): ReadonlyMap<string, RouteTarget> {
  const existing = (c as unknown as AnyContext).get(ROUTE_HANDLERS_VAR);
  return existing instanceof Map ? new Map(existing as Map<string, RouteTarget>) : new Map();
}

function executionContextOf(c: Context): unknown {
  try {
    return c.executionCtx;
  } catch {
    // app.request() in tests has no ExecutionContext.
    return undefined;
  }
}

export interface RouteSwitchOptions {
  /** The env var holding the switch value. Default `ROUTE_SWITCH`. */
  variable?: string;
}

/**
 * Middleware for a whole-router group. Mount it on the group's paths where the app's own router is mounted, after the
 * group's auth, workspace and rate-limit middleware, so those run whichever handler answers. When the switch says
 * `brick` and a brick is given, the brick answers (`X-Route-Handler: brick:<group>`); otherwise the app's own route
 * does (`app:<group>`, set after `next()`). Either way the handler is noted for `migrationTelemetry`.
 */
export function routeSwitch(group: string, brick?: BrickRouter, options: RouteSwitchOptions = {}): MiddlewareHandler {
  if (!isRouteGroupName(group)) throw new Error(`invalid route group name: ${group}`);
  const variable = options.variable ?? DEFAULT_ROUTE_SWITCH_VARIABLE;
  return async (c, next) => {
    const env = c.env as Record<string, unknown> | undefined;
    const raw = env?.[variable];
    const target = resolveRouteTarget(typeof raw === "string" ? raw : undefined, group, brick !== undefined);
    if (target === "brick" && brick) {
      noteRouteHandler(c, group, "brick");
      const res = await brick.fetch(c.req.raw, c.env, executionContextOf(c));
      const answered = new Response(res.body, res);
      answered.headers.set(ROUTE_HANDLER_HEADER, `brick:${group}`);
      return answered;
    }
    noteRouteHandler(c, group, "app");
    await next();
    c.res.headers.set(ROUTE_HANDLER_HEADER, `app:${group}`);
    return undefined;
  };
}

/** The part of a Workers Analytics Engine dataset binding the telemetry uses. */
export interface AnalyticsEngineLike {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

export interface MigrationTelemetryOptions {
  /** The Analytics Engine dataset from the env, or undefined to write nothing. */
  dataset: (env: unknown) => AnalyticsEngineLike | undefined;
}

/** How many distinct telemetry error messages one middleware logs before it stops logging. */
const MAX_LOGGED_TELEMETRY_ERRORS = 10;

/** `1xx`, `2xx`, `3xx`, `4xx` or `5xx` from a status, or `error` when the handler threw. */
export type RouteStatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "error";

function statusClassOf(status: number): RouteStatusClass {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  if (status >= 200) return "2xx";
  return "1xx";
}

/**
 * Root middleware: after the request, one data point per noted group, with index `group`, blobs
 * `[group, handler, statusClass]` and doubles `[1]`. Mount it first. A thrown handler (or one Hono's error handler
 * caught) records `error`, and the error goes on as before. With no dataset, nothing is written; each point is
 * written in its own try/catch, so one that throws never drops another, and the response is unaffected. Each distinct
 * error message is logged once (the first 10). `writeDataPoint` is synchronous and never awaited.
 */
export function migrationTelemetry(options: MigrationTelemetryOptions): MiddlewareHandler {
  const logged = new Set<string>();
  const warnOnce = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (logged.has(message) || logged.size >= MAX_LOGGED_TELEMETRY_ERRORS) return;
    logged.add(message);
    console.error("migrationTelemetry: writing a data point failed; that point is skipped", error);
  };
  return async (c, next) => {
    let threw = false;
    try {
      await next();
    } catch (error) {
      threw = true;
      throw error;
    } finally {
      try {
        const handlers = (c as unknown as AnyContext).get(ROUTE_HANDLERS_VAR);
        if (handlers instanceof Map && handlers.size > 0) {
          const dataset = options.dataset(c.env);
          if (dataset) {
            const statusClass: RouteStatusClass = threw || c.error ? "error" : statusClassOf(c.res.status);
            for (const [group, handler] of handlers as Map<string, RouteTarget>) {
              try {
                dataset.writeDataPoint({ indexes: [group], blobs: [group, handler, statusClass], doubles: [1] });
              } catch (error) {
                warnOnce(error);
              }
            }
          }
        }
      } catch (error) {
        warnOnce(error);
      }
    }
  };
}

/**
 * The result of comparing a shadowed brick with the app's own data, in one shape for any brick: `compared` rows were
 * checked, `differing` of them did not match (or could not be checked), and `exact` is true only when none differ.
 */
export interface ShadowReport {
  group: string;
  exact: boolean;
  compared: number;
  differing: number;
  /** ISO-8601 UTC time of the check. */
  checkedAt: string;
}
