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
