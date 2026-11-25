# @poc/credit-wallet

A per-workspace credit wallet: an atomic double-entry ledger in D1, a balance that cannot go below zero, workspace-scoped
idempotency keys, and payment routes that credit the wallet once a payment provider says an order is paid.

Exports: `createWalletRoutes`, `createWallet` (the service the routes use), `walletCharger`, `createFakeGateway`
(tests only), the `PaymentGateway` interface, and the workflow node executors.

## Using outside the monorepo

See [Using bricks outside the monorepo](../../docs/using-bricks-outside-the-monorepo.md) for the whole flow, and
`fixtures/external-app/` for a working project.

- **Install from a tarball.** Nothing is published to a registry. Run `pnpm pack` here and in `packages/sdk`, then
  depend on both tarballs (`file:` paths) and override `@poc/sdk` to the sdk tarball. Runtime dependencies:
  `@poc/sdk`, `hono` and `zod`. The tarball ships `src/`, `migrations/` and `brick.manifest.json`; the React widget in
  `client/` is not included.
- **TypeScript sources.** `exports` point at `src/index.ts`; bundle with wrangler or esbuild.
- **Mount.** The routes are `/wallet`, `/wallet/history`, `/wallet/deduct`, `/payments/create-order` and
  `/payments/verify`, relative to your prefix. Put multi-workspace's `workspaceMiddleware` in front of `/wallet`,
  `/wallet/*` and `/payments/create-order` (not `/payments/verify`, which finds the workspace from the order):

  ```ts
  import { createWalletRoutes } from "@poc/credit-wallet";
  import { requireNotSuspended, workspaceMiddleware } from "@poc/multi-workspace";
  import { rateLimit } from "@poc/sdk";

  for (const path of ["/v1/wallet", "/v1/wallet/*", "/v1/payments/create-order"]) {
    app.use(path, workspaceMiddleware);
    app.use(path, requireNotSuspended);
  }
  // the manifest's rateLimits
  app.on("POST", "/v1/wallet/deduct", rateLimit({ bucket: "wallet-deduct", limit: 60, windowSeconds: 60, key: "workspace" }));
  app.on("POST", "/v1/payments/create-order", rateLimit({ bucket: "wallet-create-order", limit: 60, windowSeconds: 60, key: "workspace" }));
  app.on("POST", "/v1/payments/verify", rateLimit({ bucket: "wallet-verify", limit: 60, windowSeconds: 60, key: "ip" }));
  app.route("/v1", createWalletRoutes({ gateway: yourPaymentGateway, creditsPerUnit: 1, minOrderAmount: 1 }));
  ```

  The manifest's `guardPaths` and `rateLimits` paths carry the assembler's `/api` prefix; swap in your own.
  `requireNotSuspended` after the guard is what stops a suspended workspace from spending, and the `wallet-verify`
  IP limit is the only thing in front of `/payments/verify`. `rateLimit` counts in a `px_rate_limits` table: add a
  migration with `PX_RATE_LIMITS_DDL` from `@poc/sdk`.

  Without a `gateway` the payment routes answer 503 `NOT_CONFIGURED`. Implement `PaymentGateway`
  (`createOrder`, `fetchOrder`) for your provider.
- **Migrate.** Apply the files listed under `migrations` in `brick.manifest.json`, in that order, after
  multi-workspace's, to the D1 database bound as `DB`. With wrangler, rename the copies so they sort in that order
  across bricks (every brick's files start at `0001_`); `applyMigration` from
  `@poc/sdk` works only from bundled worker code.
- **Identity.** The brick authenticates no one. Your identity middleware sets `user` (`{ uid }`), and the workspace
  guard sets `workspace` and `ctx`; a route reached without them answers 401 or 400.
