# Migrating an existing app

An app that already runs in production does not have to move onto bricks in one release. It can move one route group
at a time behind a switch it flips with an env var, check each group in production, and flip it back if something is
wrong. `@poc/sdk` ships that switch (`migration-switch`), a way to count which code answered each group, and a common
shape for shadow comparisons.

## The strangler pattern

The app keeps its own handlers and mounts the brick next to them. For each request in a switched group, the switch
decides which of the two answers. Nothing moves the data: bricks that read the app's tables do so in place (see
[Adopting existing tables](adopting-existing-tables.md)), so flipping a group back is only a change to the switch value.
When every group answers from bricks and has stayed that way long enough, the app's own handlers can be deleted.

## Choosing groups

A group is a set of routes that move together, named with lower-case letters, digits and dashes
(`^[a-z][a-z0-9-]*$`), at most 64 characters (`MAX_ROUTE_GROUP_LENGTH`): `health`, `auth`, `workspaces`, `wallet`.
`isRouteGroupName(name)` checks a name. Good groups:

- match one brick's routes, so one flip moves one brick;
- start with something cheap to get wrong (a health check), then read-mostly routes, and money last;
- are small enough that a flip back is an easy call.

## The switch value

The switch is an env var, `ROUTE_SWITCH` (`DEFAULT_ROUTE_SWITCH_VARIABLE`) unless you name another. Its value is a comma-separated list of `group:target`
pairs:

```text
ROUTE_SWITCH="health:brick,workspaces:brick,wallet:shadow"
```

- Targets are `app` (the app's own code), `brick` and `shadow`.
- Whitespace around names is ignored. A pair with a bad or over-long group name, an unknown target or an extra colon is ignored,
  never an error, so a typo leaves that group on the app.
- A group not listed is `app`. `brick` with no brick available is `app`. `shadow` is `app` for any group that did not opt
  in to shadow.

To flip back, set the group to `app` (or remove it) and redeploy the variable (`wrangler secret put ROUTE_SWITCH` or the
`vars` in your wrangler config). Nothing else changes.

## Whole-router groups

When a brick's router can answer a group's paths on its own, mount `routeSwitch` where the app's own router is mounted,
after the group's auth, workspace and rate-limit middleware, so those run whichever handler answers:

```ts
import { routeSwitch } from "@poc/sdk";
import { createWorkspaceRoutes } from "@poc/multi-workspace";

const workspacesBrick = new Hono().route("/v1", createWorkspaceRoutes());
app.use("/v1/workspaces/*", routeSwitch("workspaces", workspacesBrick));
app.route("/v1", myOwnWorkspaceRoutes);
```

With `workspaces:brick`, the brick receives the original request, env and execution context and its response is
returned with `X-Route-Handler: brick:workspaces`. Otherwise the app's route answers and the header is
`app:workspaces`. Pass `{ variable: "MY_SWITCH" }` as the third argument to read another env var.

## Inline groups

Some groups cannot be a separate router: an auth middleware, a rate limiter, an audit write inside a handler. Decide
them in place with `resolveRouteTarget` and note the answer for telemetry:

```ts
import { noteRouteHandler, resolveRouteTarget } from "@poc/sdk";

const target = resolveRouteTarget(c.env.ROUTE_SWITCH, "auth", { hasBrick: true });
noteRouteHandler(c, "auth", target);
if (target === "brick") return brickAuth(c, next);
return myOwnAuth(c, next);
```

`resolveRouteTarget(raw, group, hasBrick)` with a boolean also works and never returns `shadow`. `noteRouteHandler`
does not set `X-Route-Handler`; set it yourself if the group answers the whole response. When several groups set the
header in one request, the last one set wins.

## Shadow

`shadow` means the app's own code answers, and the app also mirrors each change into the brick, so the two can be
compared before the brick takes over. Only groups whose code handles it should read it:

```ts
const target = resolveRouteTarget(c.env.ROUTE_SWITCH, "wallet", { hasBrick: true, allowShadow: true });
if (target === "shadow") c.executionCtx.waitUntil(mirrorIntoBrick(change));
```

Compare the two sides on a schedule and report the result as a `ShadowReport`
(`{ group, exact, compared, differing, checkedAt }`), the same shape for any brick. credit-wallet ships one:
`walletShadowReport("wallet", await reconcileWallets(db, hostBalances))`. Flip to `brick` once the reports stay exact.

## Counting who answered

`migrationTelemetry` writes one Workers Analytics Engine data point per noted group per request. Add a dataset to your
wrangler config:

```jsonc
{
  "analytics_engine_datasets": [{ "binding": "MIGRATION_TELEMETRY", "dataset": "my_app_route_handlers" }]
}
```

and mount the middleware first, before anything that can answer:

```ts
import { migrationTelemetry } from "@poc/sdk";

app.use("*", migrationTelemetry({ dataset: (env) => (env as { MIGRATION_TELEMETRY?: AnalyticsEngineDataset }).MIGRATION_TELEMETRY }));
```

`routeSwitch` notes its group itself; inline groups note theirs with `noteRouteHandler`. A group noted twice in one
request counts once, with the last handler. Noted handlers live on the Hono context under `px.routeHandlers`
(`ROUTE_HANDLERS_VAR`); `notedRouteHandlers(c)` reads them without changing anything.

### What is recorded, and what is not

Each data point has exactly:

| Field | Value |
|---|---|
| `indexes` | `[group]` |
| `blobs` | `[group, handler, statusClass]`: handler is `app`, `brick` or `shadow`; statusClass is `1xx` (a WebSocket upgrade's 101, for example), `2xx`, `3xx`, `4xx`, `5xx`, or `error` when the handler threw |
| `doubles` | `[1]` |

Nothing else: no tenant or user id, path, query string, IP or body. The write is synchronous and fire-and-forget,
adds no await to the response and touches no D1. With no binding, nothing is written. Each point is written on its
own: if the binding throws for one, that point is skipped and the others are still written, and each distinct error
message is logged once (up to 10). The response is the same with or without the middleware, and a thrown error goes on to
the app's error handler as before.

A query such as `SELECT blob1 AS grp, blob2 AS handler, blob3 AS status, SUM(_sample_interval) AS requests FROM
my_app_route_handlers WHERE timestamp > NOW() - INTERVAL '1' DAY GROUP BY grp, handler, status` shows how much traffic
each group sends to each handler.

## Project status endpoint

Studio shows an app that uses bricks as a connected project: which bricks it runs, where each route group's switch
stands, and how its shadow comparisons look. It gets these from a small read-only endpoint the app mounts from
`@poc/sdk`, so Studio never reads the app's code or database. The endpoint is opt-in and off until a key is set.

### Mounting

`projectStatus` is middleware. Mount it with `app.use` at its path, `DEFAULT_STATUS_PATH` (`/_tangebricks/status`),
anywhere in the app: it answers only `GET` on that exact path with the right key, and passes every other request on
with `next()`, so the app's own routes, catch-all and not-found handler answer them as if nothing were mounted. If you
mount it in a sub-app, pass the full request path as `path`.

```ts
import { Hono } from "hono";
import { DEFAULT_STATUS_PATH, projectStatus } from "@poc/sdk";
import type { ProjectShadowReport } from "@poc/sdk";
import { reconcileWallets, walletShadowReport } from "@poc/credit-wallet";
import type { ReconcileRow } from "@poc/credit-wallet";

type Bindings = { DB: D1Database; STATUS: KVNamespace; TANGEBRICKS_STATUS_KEY?: string; ROUTE_SWITCH?: string };

// The app's own: the balances it holds, to compare with the brick's.
declare function hostBalances(env: Bindings): Promise<ReconcileRow[]>;

const app = new Hono<{ Bindings: Bindings }>();

app.use(
  DEFAULT_STATUS_PATH,
  projectStatus<Bindings>({
    project: "my-app",
    bricks: [
      { id: "credit-wallet", version: "1.2.0" },
      { id: "core-auth", version: "1.0.0" },
    ],
    shadow: [
      {
        group: "wallet",
        // Reads the last comparison; it never reconciles on the request path.
        report: async (env) => {
          const stored = await env.STATUS.get<ProjectShadowReport>("shadow:wallet", "json");
          if (!stored) throw new Error("no wallet comparison yet");
          return stored;
        },
      },
    ],
  }),
);

export default {
  fetch: app.fetch,
  // A cron trigger compares the two sides and stores the report where the app owns it.
  async scheduled(_controller: ScheduledController, env: Bindings) {
    const report = walletShadowReport("wallet", await reconcileWallets(env.DB, await hostBalances(env)));
    await env.STATUS.put("shadow:wallet", JSON.stringify(report));
  },
};
```

Options:

| Option | Default | Meaning |
|---|---|---|
| `path` | `/_tangebricks/status` (`DEFAULT_STATUS_PATH`) | the full request path it answers on |
| `keyVariable` | `TANGEBRICKS_STATUS_KEY` (`DEFAULT_STATUS_KEY_VARIABLE`) | the env var holding the key |
| `switchVariable` | `ROUTE_SWITCH` | the env var holding the route switch |
| `project` | none | a display name |
| `bricks` | `[]` | `{ id, version }` entries, or a function of the env returning them |
| `shadow` | `[]` | `{ group, report(env, { signal }) }` reporters returning a `ShadowReport`, optionally with `exactSince` |
| `shadowTimeoutMs` | `2000` | how long each reporter may take, at most `30000` (`MAX_SHADOW_TIMEOUT_MS`) |
| `shadowCacheMs` | `60000` (`DEFAULT_SHADOW_CACHE_MS`) | how long a reporter's result is reused; `0` disables the cache |

`projectStatus<Bindings>(...)` types the `env` its functions receive.

The brick list is whatever the app passes: literals as above, or build-time constants the app already has. An entry
whose `id` does not match `^[a-z0-9][a-z0-9-]*$` or whose `version` is not semver-like (`1.2.0`, `2.0.1-beta.1`) is
dropped.

### The key

Create a long random key and store it as a secret, never in `vars`:

```sh
wrangler secret put TANGEBRICKS_STATUS_KEY
```

Give the same key to Studio for this project. Callers send it as `Authorization: Bearer <key>`. The endpoint hashes the
sent key and the configured key with SHA-256 and compares the digests in constant time; the key never appears in a log
or a response. To turn the endpoint off, delete the secret (`wrangler secret delete TANGEBRICKS_STATUS_KEY`).

A bearer longer than 512 bytes (`MAX_STATUS_KEY_BYTES`) is treated as no bearer, so a key must be at most 512 bytes.

With the key unset or empty, a missing or wrong key, or any method other than `GET`, the middleware calls `next()` and
the app answers as it would for a path where nothing is mounted (its catch-all, its fallback, or its 404). A prober
cannot tell the endpoint exists.

### The response

```json
{
  "version": 1,
  "project": "my-app",
  "generatedAt": "2026-11-28T10:00:00.000Z",
  "bricks": [{ "id": "credit-wallet", "version": "1.2.0" }],
  "switch": { "variable": "ROUTE_SWITCH", "groups": { "health": "brick", "wallet": "shadow" } },
  "shadow": [
    { "group": "wallet", "exact": true, "compared": 120, "differing": 0, "checkedAt": "2026-11-28T09:55:00.000Z" }
  ]
}
```

with `Cache-Control: no-store`, `Content-Type: application/json` and `X-Content-Type-Options: nosniff`.

- `switch.groups` is the switch value parsed the same way `routeSwitch` parses it; bad pairs are left out.
- Reporters run in parallel. Only `exact`, `compared`, `differing`, `checkedAt` and `exactSince` are copied from a
  report, under the group named in the options; any other field a reporter returns is dropped. `checkedAt` and
  `exactSince` must be ISO-8601 UTC timestamps (`2026-11-28T09:55:00.000Z`), and `exactSince` is kept only when `exact`
  is true. A reporter that throws, returns something malformed (a bad `checkedAt` included) or takes longer than
  `shadowTimeoutMs` shows as `{ "group": "wallet", "error": true }`, and the endpoint still answers 200. On a timeout
  the reporter's `signal` is aborted; pass it to any fetch or query that accepts one.
- Each reporter runs at most once at a time: concurrent requests share one run. Its result, or its error, is reused for
  `shadowCacheMs` (60 s by default), so a poller or a leaked key cannot pile up runs. Still keep reporters cheap: read a
  stored result, as above, rather than reconcile on the request path.

### What is never exposed

No tenant, workspace or user id, email, traffic count, key, or env value other than the parsed switch. Traffic per
group comes from Analytics Engine (see [Counting who answered](#counting-who-answered)), not from this endpoint.

### No CORS

The endpoint sets no CORS headers. Studio fetches it server-side with the key, so a browser never calls it and the
key never reaches a browser. Do not add CORS for it.
