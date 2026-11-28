# Using bricks outside the monorepo

A project that is not part of this repository can install bricks, mount their routers on its own Hono app, and run
their migrations on its own D1 database. No assembler, Studio or generated code is involved. Eight packages support
this today:

| Package | What it gives you | README |
|---|---|---|
| `@poc/sdk` | Tenant-scoped queries, `applyMigration`, shared types. Every brick depends on it. | [packages/sdk](../packages/sdk/README.md#using-outside-the-monorepo) |
| `@poc/multi-workspace` | Workspaces, memberships, invites, and `workspaceMiddleware`, the guard the other bricks sit behind. | [bricks/multi-workspace](../bricks/multi-workspace/README.md#using-outside-the-monorepo) |
| `@poc/credit-wallet` | Per-workspace credit ledger and payment routes. | [bricks/credit-wallet](../bricks/credit-wallet/README.md#using-outside-the-monorepo) |
| `@poc/audit-trail` | Per-workspace audit log and CSV export. | [bricks/audit-trail](../bricks/audit-trail/README.md#using-outside-the-monorepo) |
| `@poc/edge-traffic-armor` | A rate-limit and IP-rule middleware for any route, with a log of refused requests. | [bricks/edge-traffic-armor](../bricks/edge-traffic-armor/README.md#using-outside-the-monorepo) |
| `@poc/oidc-verify` | Bearer-token verification for any OIDC provider (JWKS or HS256), setting `user` with id and email. | [bricks/oidc-verify](../bricks/oidc-verify/README.md#using-outside-the-monorepo) |
| `@poc/rbac-policy` | Custom roles and permissions inside a workspace, and `requirePermission`. | [bricks/rbac-policy](../bricks/rbac-policy/README.md#using-outside-the-monorepo) |
| `@poc/platform-admin` | Operator routes across workspaces: credit grants, suspension, flag overrides, user approvals. | [bricks/platform-admin](../bricks/platform-admin/README.md#using-outside-the-monorepo) |

An app that already has its own workspace tables can keep them: see [Adopting existing tables](adopting-existing-tables.md).
An app already in production can move onto bricks one route group at a time: see
[Migrating an existing app](migrating-an-existing-app.md).

## 1. Pack and install

Nothing is published to a registry; the packages stay `"private": true` and keep their `@poc/*` names. In this repo:

```sh
pnpm --dir packages/sdk pack --pack-destination /path/to/my-app/vendor
pnpm --dir bricks/multi-workspace pack --pack-destination /path/to/my-app/vendor
pnpm --dir bricks/credit-wallet pack --pack-destination /path/to/my-app/vendor
pnpm --dir bricks/audit-trail pack --pack-destination /path/to/my-app/vendor
pnpm --dir bricks/edge-traffic-armor pack --pack-destination /path/to/my-app/vendor
pnpm --dir bricks/oidc-verify pack --pack-destination /path/to/my-app/vendor
pnpm --dir bricks/rbac-policy pack --pack-destination /path/to/my-app/vendor
pnpm --dir bricks/platform-admin pack --pack-destination /path/to/my-app/vendor
```

Each brick's tarball holds `src/`, `migrations/` (none for oidc-verify, which owns no tables), `brick.manifest.json`,
the README, CHANGELOG, `LICENSE` and `NOTICE`.
The `@poc/sdk` tarball holds only `src/`, the README, `LICENSE` and `NOTICE`: no migrations and no manifest. Every
tarball's `package.json` has its `workspace:*` dependencies rewritten to versions by pack. All eight are Apache-2.0.
In your project:

```json
{
  "dependencies": {
    "@poc/sdk": "file:./vendor/poc-sdk-0.0.0.tgz",
    "@poc/multi-workspace": "file:./vendor/poc-multi-workspace-1.1.0.tgz",
    "@poc/credit-wallet": "file:./vendor/poc-credit-wallet-1.0.0.tgz",
    "@poc/audit-trail": "file:./vendor/poc-audit-trail-1.0.0.tgz",
    "@poc/edge-traffic-armor": "file:./vendor/poc-edge-traffic-armor-1.1.0.tgz",
    "@poc/oidc-verify": "file:./vendor/poc-oidc-verify-2.1.0.tgz",
    "hono": "4.13.20"
  },
  "pnpm": { "overrides": { "@poc/sdk": "file:./vendor/poc-sdk-0.0.0.tgz" } }
}
```

The override matters: each brick depends on `@poc/sdk` by version, and that version exists only as your tarball. With
npm, use the top-level `"overrides"` field instead. Use the same `hono` version as the bricks so there is one copy.

## 2. Bundle

The packages' `exports` point at TypeScript sources (`src/index.ts`). Wrangler and esbuild compile them while
bundling the worker, so nothing has to be built first. Node cannot import them from `node_modules` directly.

## 3. Mount

```ts
import { Hono } from "hono";
import { createWorkspaceRoutes, requireNotSuspended, workspaceMiddleware } from "@poc/multi-workspace";
import { createWalletRoutes } from "@poc/credit-wallet";
import { createAuditRoutes } from "@poc/audit-trail";
import { trafficArmorMiddleware } from "@poc/edge-traffic-armor";
import { rateLimit } from "@poc/sdk";

const app = new Hono();
app.use("*", identity); // yours: verifies the caller and sets c.set("user", { uid, email? })
for (const path of ["/wallet", "/wallet/*", "/payments/create-order", "/audit", "/audit/*"]) {
  app.use(`/v1${path}`, workspaceMiddleware);
  app.use(`/v1${path}`, requireNotSuspended); // refuses a suspended workspace (403 WORKSPACE_SUSPENDED)
}
// credit-wallet's manifest `rateLimits`, with the SDK's D1 limiter
app.on("POST", "/v1/wallet/deduct", rateLimit({ bucket: "wallet-deduct", limit: 60, windowSeconds: 60, key: "workspace" }));
app.on("POST", "/v1/payments/create-order", rateLimit({ bucket: "wallet-create-order", limit: 60, windowSeconds: 60, key: "workspace" }));
app.on("POST", "/v1/payments/verify", rateLimit({ bucket: "wallet-verify", limit: 60, windowSeconds: 60, key: "ip" }));
// edge-traffic-armor on one of your own paths: its own bucket, counted per signed-in user, refusals logged as incidents
app.use("/v1/search", trafficArmorMiddleware({ enforceIpRules: false, rateLimit: { bucket: "search", limit: 30, windowSeconds: 60, key: "user" } }));
app.route("/v1", createWorkspaceRoutes());
app.route("/v1", createWalletRoutes({ gateway: yourPaymentGateway }));
app.route("/v1", createAuditRoutes());
export default app;
```

No casts are needed: `fixtures/external-app/src/index.ts` mounts the bricks the same way, and the test typechecks it
against the installed packages.

- **Guarded paths.** They are the ones each brick's manifest lists under `worker.routes[].guardPaths`. The manifests
  write them with the assembler's `/api` prefix (`/api/wallet`, `/api/audit/*`); swap in your own prefix (`/v1`
  here, your choice).
- **Suspension.** multi-workspace's manifest names `requireNotSuspended` as its guard's `suspension`. The assembler
  mounts it right after `workspaceMiddleware` on every guarded path; do the same, or a suspended workspace can still
  spend credits.
- **Rate limits.** credit-wallet's manifest lists `rateLimits` (method, path, bucket, limit, window, key). Mount each
  with `rateLimit` from `@poc/sdk`, prefix swapped in as above, before the routes. `/payments/verify` sits outside the
  workspace guard, so its IP limit is the only thing in front of it. The limiter counts in a `px_rate_limits` table:
  add a migration with the SDK's `PX_RATE_LIMITS_DDL`. Without the table the limiter logs an error and lets requests
  through.
- **edge-traffic-armor.** `trafficArmorMiddleware(options)` takes `enforceIpRules` (default on; it checks the
  verified workspace's IP rules, so turn it off on a path with no workspace guard) and `rateLimit`:
  `{ limit, windowSeconds, bucket?, key? }`. `bucket` (default `armor`) names the counter, so mounting the middleware
  on several paths with different buckets keeps separate counts, and `PX_RATE_LIMITS` overrides by bucket. `key` is
  `ip` (default), `workspace` or `user` (the `user` variable's `uid` or `id`); `workspace` and `user` fall back to the
  IP. Past the limit it answers 429 `RATE_LIMITED` and adds a `rate_limit` row to `arm_blocked_requests`; if D1 fails
  it lets the request through. Its `/armor/*` routes need the workspace guard like the other bricks' routes.

## 4. Migrate

Each brick lists its migration files, in order, under `migrations` in `brick.manifest.json`. Apply multi-workspace's
first, then the bricks that require `workspace-context`, then the `px_rate_limits` table, to the D1 database bound as
`DB`. edge-traffic-armor ships that table as its own `0002_px_rate_limits.sql` (the same `CREATE TABLE IF NOT
EXISTS`), so with armor installed the separate step is a no-op.

- **With wrangler.** Copy the files into your migrations folder, but rename them in that order. Wrangler applies a
  folder in filename order, and the bricks' own names (`0001_credit_wallet.sql`, `0001_audit_trail.sql`, ...) neither
  sort in manifest order nor are unique across bricks, so a flat copy can reorder them or overwrite one with another.
  For example: `0001_multi_workspace__0001_multi_workspace.sql`, `0002_credit_wallet__0001_credit_wallet.sql`,
  `0003_credit_wallet__0002_workspace_scoped_idempotency.sql`, `0004_audit_trail__0001_audit_trail.sql`,
  `0005_px_rate_limits.sql`.
- **With `applyMigration(db, sql)` from `@poc/sdk`.** Call it from your bundled worker code (an admin route or a
  setup step). The installed package is TypeScript source, so a plain Node script cannot import it from
  `node_modules`.

## 5. Identity

No brick authenticates anyone on its own. Your app verifies the caller (session, JWT, API key) and sets `user` on the
Hono context before any brick route runs, or mounts oidc-verify's `createOidcMiddleware({ issuer, audience, jwksUri,
algorithms })` to do it from a bearer token. `workspaceMiddleware` then resolves the workspace from the
`x-workspace-id` header and refuses callers who are not members. Emailed invites trust `user.email`, so set it only from
a verified source.

## The proof

`fixtures/external-app/` is a project that does all of the above with a stub identity (and oidc-verify on one path).
`test/external-app.node.test.ts` packs the eight packages, copies the fixture to a temp directory outside the repo,
installs the tarballs with `pnpm install --ignore-workspace`, bundles the entry with esbuild, runs it in workerd
through Miniflare with a D1 binding, applies the shipped migrations, and checks that one user's wallet and audit log
work, that a user in another workspace cannot see them, that the rate limits count, that armor's user-keyed bucket
answers 429 per user and logs an incident, that a suspended workspace cannot spend, that oidc-verify sets the user
from an HS256 token, that emailed invites, the member list, role changes and rename work, that rbac-policy answers
behind the guard, and that platform-admin refuses a non-operator. It also typechecks the fixture against what it installed. It runs in CI with the node test project.
