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
- **Mount.** The routes are `/wallet`, `/wallet/history`, `/wallet/deduct`, `/payments/create-order`,
  `/payments/verify` and `/payments/webhook`, relative to your prefix. Put multi-workspace's `workspaceMiddleware` in
  front of `/wallet`, `/wallet/*` and `/payments/create-order` (not `/payments/verify`, which finds the workspace from
  the order, and not `/payments/webhook`, which the payment provider calls):

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
  app.on("POST", "/v1/payments/webhook", rateLimit({ bucket: "wallet-webhook", limit: 300, windowSeconds: 60, key: "ip" }));
  app.route("/v1", createWalletRoutes({ gateway: yourPaymentGateway, currency: "INR", creditsPerUnit: 1, minOrderAmount: 1 }));
  ```

  The manifest's `guardPaths` and `rateLimits` paths carry the assembler's `/api` prefix; swap in your own.
  `requireNotSuspended` after the guard is what stops a suspended workspace from spending, and the `wallet-verify`
  IP limit is the only thing in front of `/payments/verify`. `rateLimit` counts in a `px_rate_limits` table: add a
  migration with `PX_RATE_LIMITS_DDL` from `@poc/sdk`.

  Without a `gateway`, or without a `currency`, the payment routes answer 503 `NOT_CONFIGURED`. A gateway is any
  `PaymentGateway` (`createOrder`, `fetchOrder`, `verifyWebhook`, from `@poc/sdk`); `@poc/gateway-adapters` has
  adapters for real providers (see its README).
- **Migrate.** Apply the files listed under `migrations` in `brick.manifest.json`, in that order, after
  multi-workspace's, to the D1 database bound as `DB`. With wrangler, rename the copies so they sort in that order
  across bricks (every brick's files start at `0001_`); `applyMigration` from
  `@poc/sdk` works only from bundled worker code.
- **Identity.** The brick authenticates no one. Your identity middleware sets `user` (`{ uid }`), and the workspace
  guard sets `workspace` and `ctx`; a route reached without them answers 401 or 400.

## Payments (story 2.3)

- **Currency.** `currency` (route option; the assembler fills it from the `paymentCurrency` setting) is the ISO 4217
  code every order is created and verified in, three upper-case letters such as `INR`. It has no default: the setting
  is empty until you choose one, and with a gateway but no currency every payment route answers 503 `NOT_CONFIGURED`.
  Migration `0003` stores each order's currency; an order created before it is held to the configured currency.
- **Units.** Orders are whole major units (rupees), as before, and credits are computed from that stored amount. The
  gateway interface carries minor units (paise), so the wallet converts exactly when it creates an order (500 rupees
  is `amount: 50000`) and converts its stored amount before comparing it with the provider's.
- **Verification.** Before anything is credited, on the client path (`POST /payments/verify`) and the webhook path
  alike, the order is fetched from the provider again and must be `PAID` with the same order id, exactly the stored
  amount, the stored currency and the user who created it. A difference credits nothing and answers 409
  `verification_mismatch`; the log line names the field, never a value. The amount credited is always the stored one,
  and the `order:<id>` ledger key still makes a second confirmation impossible to commit.
- **Provider reference.** Migration 0003 also stores `provider_ref`, the provider's own id for the order, which the
  order is fetched by. If an order cannot be recorded after the provider created it, both ids are logged at error level.
- **Webhook.** `POST /payments/webhook` is for the provider. It has no user and no workspace, so it must not be behind
  the workspace guard (the manifest's `guardPaths` leave it out). It reads the raw body (at most 64 KiB, else 413), asks the
  gateway to verify the signature (401 when it does not hold, nothing credited; 200 `ignored` for a correctly signed
  event that names no order), then confirms the order as above. It answers 200 for
  credited, already processed, not paid yet or an order this wallet does not know (so the provider stops retrying; an
  unknown order is logged at error level with its id and provider reference),
  409 for a mismatch and 502 when the provider could not be asked (so it retries). A repeated delivery credits once.
  The manifest rate-limits it per IP (`wallet-webhook`). Point the provider's webhook at
  `<your prefix>/payments/webhook`.
