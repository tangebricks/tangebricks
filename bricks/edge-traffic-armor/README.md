# @poc/edge-traffic-armor

Per-workspace IP allow and block rules, a rate limiter in front of any route, and a log of refused requests
(incidents).

Exports: `trafficArmorMiddleware`, `createTrafficArmorRoutes`, `TrafficArmorService` and the `ArmorEnv` types.

## The middleware

`trafficArmorMiddleware(options)` runs two checks, in order:

1. **IP rules** (on unless `enforceIpRules: false`). With a verified workspace on the context, a request from an IP the
   workspace blocks gets 403 and an `ip_block` incident.
2. **Rate limit** (only when `rateLimit` is given). It uses the SDK's `rateLimit` and counts in the `px_rate_limits`
   table. Past the limit it answers 429 `RATE_LIMITED` with `Retry-After` and `RateLimit-*` headers, and logs a
   `rate_limit` incident in `arm_blocked_requests`. If the database fails, the limiter lets the request through:
   armor is a traffic shield, not an auth control.

`rateLimit` options:

| Option | Default | Meaning |
|---|---|---|
| `limit` | (required) | Requests allowed per window. |
| `windowSeconds` | (required) | Window length, 1 to 86400 seconds. |
| `bucket` | `armor` | The counter's name. Each bucket counts separately, so you can mount the middleware several times with different numbers. `PX_RATE_LIMITS` overrides the numbers by bucket name. |
| `key` | `ip` | What a request is counted by: `ip`, `workspace` (the verified workspace) or `user` (the signed-in user's `uid` or `id`). `workspace` and `user` fall back to the IP when there is none. |

```ts
// Two limits with separate counts, each per signed-in user.
app.use("/v1/search", trafficArmorMiddleware({ enforceIpRules: false, rateLimit: { bucket: "search", limit: 30, windowSeconds: 60, key: "user" } }));
app.use("/v1/export", trafficArmorMiddleware({ enforceIpRules: false, rateLimit: { bucket: "export", limit: 5, windowSeconds: 3600, key: "user" } }));
```

## The routes

`createTrafficArmorRoutes()` mounts `GET /armor/rules`, `POST /armor/rules`, `DELETE /armor/rules` and
`GET /armor/incidents`, relative to your prefix. They read the workspace from the verified `ctx` only; without it they
answer 400.

## Using outside the monorepo

See [Using bricks outside the monorepo](../../docs/using-bricks-outside-the-monorepo.md) for the whole flow, and
`fixtures/external-app/` for a working project.

- **Install from a tarball.** Nothing is published to a registry. Run `pnpm pack` here and in `packages/sdk`, then
  depend on both tarballs (`file:` paths) and override `@poc/sdk` to the sdk tarball. Runtime dependencies:
  `@poc/sdk`, `hono` and `zod`.
- **TypeScript sources.** `exports` point at `src/index.ts`; bundle with wrangler or esbuild.
- **Mount.** The middleware alone needs no workspace guard; with `key: "user"` put it after your identity middleware.
  The `/armor/*` routes need multi-workspace's `workspaceMiddleware` (and `requireNotSuspended`) in front of them, as
  in audit-trail's README.
- **Migrate.** Apply the files listed under `migrations` in `brick.manifest.json`, in that order, to the D1 database
  bound as `DB`. `0002_px_rate_limits.sql` is the SDK's `PX_RATE_LIMITS_DDL`, so you need no separate migration for
  the limiter's table. With wrangler, rename the copies so they sort in order across bricks (every brick's files start
  at `0001_`).
- **Identity.** The brick authenticates no one. Your identity middleware sets `user` (`{ uid, email? }`), which
  `key: "user"` counts by.
