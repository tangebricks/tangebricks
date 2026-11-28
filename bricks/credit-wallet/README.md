# @poc/credit-wallet

A per-workspace credit wallet: an atomic double-entry ledger in D1, a balance that cannot go below zero, workspace-scoped
idempotency keys, and payment routes that credit the wallet once a payment provider says an order is paid.

Exports: `createWalletRoutes`, `createWallet` (the service the routes use), `walletCharger`, the action-cost helpers
(`chargeAction`, `setActionCost`, `listActionCosts`, `parseDefaultActionCosts`), the balance import library
(`importWalletBalances`, `parseBalanceFile`), `createFakeGateway` (tests only), the `PaymentGateway` interface, and the
workflow node executors.

## Using outside the monorepo

See [Using bricks outside the monorepo](../../docs/using-bricks-outside-the-monorepo.md) for the whole flow, and
`fixtures/external-app/` for a working project.

- **Install from a tarball.** Nothing is published to a registry. Run `pnpm pack` here and in `packages/sdk`, then
  depend on both tarballs (`file:` paths) and override `@poc/sdk` to the sdk tarball. Runtime dependencies:
  `@poc/sdk`, `hono` and `zod`. The tarball ships `src/`, `migrations/` and `brick.manifest.json`; the React widget in
  `client/` is not included.
- **TypeScript sources.** `exports` point at `src/index.ts`; bundle with wrangler or esbuild.
- **Mount.** The routes are `/wallet`, `/wallet/history`, `/wallet/deduct`, `/wallet/costs`, `/wallet/costs/:action`,
  `/wallet/charge`, `/wallet/transfer`, `/payments/create-order`, `/payments/verify` and `/payments/webhook`, relative to your prefix. Put multi-workspace's `workspaceMiddleware` in
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
  app.on("POST", "/v1/wallet/charge", rateLimit({ bucket: "wallet-charge", limit: 600, windowSeconds: 60, key: "workspace" }));
  app.on("POST", "/v1/wallet/transfer", rateLimit({ bucket: "wallet-transfer", limit: 30, windowSeconds: 60, key: "workspace" }));
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
- **Workspace registry (optional).** Transfers and the balance import check that a named workspace exists and is not
  suspended by reading multi-workspace's `mw_workspaces` table (`findWorkspaceState` / `hasWorkspaceRegistry` in
  `@poc/sdk`, which look the table up in `sqlite_master` once per database). A host with its own workspace guard and no
  `mw_workspaces` table still works: the check falls back to whether the workspace has a wallet, a transfer's batch
  leaves out the in-batch registry condition, and the import tool cannot create wallets (it has nothing to check an id
  against).
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

## Credits, action costs and transfers (story 2.5)

- **Units.** Every credit amount is stored as a whole number of thousandths of a credit ("milli-credits"): 1 credit is
  1000, 0.2 credits is 200. Migration `0004` renames the columns (`credit_wallets.balance_milli`,
  `credit_ledger.amount_milli` and `balance_after_milli`) and multiplies every existing value by 1000 in the same
  migration, so a query still written for whole credits fails ("no such column") instead of misreading the units. The
  CHECKs (`balance_milli >= 0`, `balance_after_milli >= 0`) and the per-workspace idempotency key are unchanged. Order
  amounts (`credit_orders.amount`) are money, not credits, and stay whole major units.
- **Converting.** `toMilli`, `fromMilli` and `formatMilli` in `@poc/sdk` are the one conversion. `toMilli` reads a
  number through its shortest decimal text, or a decimal string, exactly, and refuses more than three decimals, a
  negative, NaN, Infinity, exponent notation (`"1e-3"`) and anything past a safe integer. Nothing adds or subtracts
  credits as floats.
- **Routes.** A credit amount in a body may be a number or a decimal string with up to three decimals (`0.2`,
  `"12.345"`); `0.0001` or the string `"1e-3"` is 400. A JSON *number* written `1e-3` is a different matter: JSON
  parsing turns it into 0.001 before the route sees it, so it is accepted as 0.001 (exactly 1 thousandth). Only the
  string form of exponent notation is refused. Every amount comes back twice: in credits (`currentBalance`, `amount`,
  `balanceAfter`, `charged`, `credits`) and in thousandths (`currentBalanceMilli`, `amountMilli`, `balanceAfterMilli`,
  `chargedMilli`, `creditsMilli`).
- **Library API.** `createWallet` speaks thousandths only, and its names say so: `openWallet(ws, initialBalanceMilli)`,
  `getBalanceMilli`, `deduct({ amountMilli })`, `refund({ amountMilli })`, results with `balanceAfterMilli` and
  `creditsMilli`. `walletCharger` likewise: `balanceMilli`, `debit(db, ws, milli, ...)`, `refund(db, ws, milli, ...)`
  and `settled()` returning `{ milli, type }`. A caller written for whole credits fails to compile.
- **Workflow node.** `credit-wallet.deduct` keeps a whole-credit `amount` in its config (the catalog declares it an
  integer) and converts it to thousandths; its output carries `charged`/`balanceAfter` and their `...Milli` pairs.
- **Top-ups.** The `creditsPerUnit` route option may be a decimal with up to three places (`"2.125"`); it is held as
  thousandths and multiplies the order's whole amount in integers. The `creditsPerUnit` setting of an assembled app is
  still a whole number, because manifest settings have no decimal type.
- **Action costs.** `credit_action_costs` holds a workspace's price per action name (`^[a-z][a-z0-9_.:-]{0,63}$`), in
  thousandths, 0 or more. `GET /wallet/costs` (any member) lists the workspace's own costs and the defaults that still
  apply; `PUT /wallet/costs/:action { cost }` and `DELETE /wallet/costs/:action` are owner/admin only.
  `POST /wallet/charge { action, quantity?, idempotencyKey, reason? }` takes cost x quantity (quantity 1 to 10000) from
  the caller's workspace once per key: 404 `UNKNOWN_ACTION` when nothing prices the action, 402 `INSUFFICIENT_CREDITS`
  when the balance cannot cover it, and a retry with the same key answers `duplicate: true`. The optional
  `defaultActionCosts` setting (`email.send:0.2,message.send:0.5`, empty by default) prices an action only for a
  workspace with no row of its own. A free action (cost 0) takes nothing but still records a zero-amount deduction
  under its key, so a retry after a price change is a duplicate. An action listed twice keeps its first cost, and a cost is at most 999999.999 (the
  pattern and the parser agree, so a value the assembler accepts never fails when the routes are built). Nothing has a
  built-in price. Other bricks charge through
  `walletCharger.chargeAction(db, ws, action, quantity, key, reason, { defaultCosts?, userId? })`.
- **Idempotency keys.** Deductions, top-ups, charges and transfers share one key space per workspace. Every deduction
  records an operation tag in its metadata: `op: "deduct"` (the route), `op: "node"` with the `node_id` (the workflow
  node), `op: "charger"` (`walletCharger.debit`), `op: "action"` with the action and quantity (charges), `op: "wallet"`
  (any other library call). A retry answers `duplicate: true` only when the row already under its key is the same
  operation: a deduction of the same amount with the same tags, a top-up of the same amount, or a transfer to the same
  destination of the same amount. A row written before the tags existed matches nothing new. Any other reuse is 409 `IDEMPOTENCY_KEY_REUSED`
  (`idempotency_key_reused` / `IDEMPOTENCY_KEY_REUSED` from the library and `walletCharger`) and takes nothing.
- **Operator grants (story 2.6).** `walletCharger.grant(db, ws, milli, key, reason, userId?)` adds credits as a top-up
  tagged `op: "grant"`, once per key (a retry of the same grant is a duplicate; any other use of the key is
  `IDEMPOTENCY_KEY_REUSED`). A workspace with no wallet gets one only while it is live (registered and not suspended).
  platform-admin's `POST /api/platform/workspaces/:id/credits` uses it.
- **Transfers.** `POST /wallet/transfer { toWorkspaceId, amount, idempotencyKey, note? }` moves credits from the
  caller's workspace to another workspace's existing wallet. Owner/admin of the source only, and never an API key (403
  `API_KEY_FORBIDDEN`). One D1 batch debits the source (the CHECK refuses an overdraw and rolls everything back),
  credits the destination and writes two ledger rows, `transfer_out` and `transfer_in`, sharing a generated
  `transfer_code`; the destination's row carries the amount and the code and nothing else of the source. Idempotent per
  (source workspace, key); the same key for another destination or amount is 409. 400 for a transfer to itself or an
  amount below 0.001; 402 for more than the balance, checked before anything about the destination, so a caller who
  cannot cover the amount learns nothing about it; 404 `DESTINATION_NOT_FOUND` for a destination that is not a live
  workspace, is suspended (read from `mw_workspaces` with `findWorkspaceState` from `@poc/sdk`, the row the workspace
  guard reads) or has no wallet, the same answer in every case. The destination's state is checked again inside the
  transfer's batch, so a suspension or deletion that lands between the check and the batch rolls the transfer back.
- **Importing balances.** `node scripts/import-wallet-balances.ts <file.json|file.csv> [--sqlite <db>] [--apply]
  [--round half-up|down] [--allow-existing] [--create-wallets] [--out report.json]` loads `{ workspaceId, balance }` rows, the balance as decimal text in
  credits (`"12.345"`, `"0.2"`, `"7"`). Conversion is exact string parsing; more than three decimals is refused unless
  `--round` is given, and then every rounded row is reported. In JSON the balance must be a string; a JSON number is
  refused (it has already been through a float). Every id must be an existing workspace (suspended ones included); one without a wallet is refused
  unless `--create-wallets` (which still needs the workspace to exist), and one whose wallet already holds credits or an
  import from any file is refused unless `--allow-existing` (recorded in the report). Every row and the totals are
  checked before anything is written. A dry run is the default; `--apply` writes one top-up per
  workspace under the key `import:<file-sha256>:<workspaceId>` through the wallet's own code, so a re-run credits
  nothing twice. The report gives the source total and the imported total, exact to the thousandth, compares each
  workspace's resulting balance (read back) with its source balance, and counts every row that differs. Mapping another system's export to `{ workspaceId, balance }` happens before the tool. The library
  (`importWalletBalances`) runs against any `D1Like`; the script opens a local SQLite file. For a hosted D1 database,
  call `importWalletBalances` with a `D1Like` over the D1 REST endpoint against the live database (as
  `packages/deploy/src/h5-hosted.ts` does with `restD1`), or quiesce the wallet before reloading a copy. A row that fails
  while writing is reported and the rest go on; `reconciled` is true only with no refused row.
- **Running as a shadow of a host's wallet (story 2.9).** A host that keeps its own balances can mirror each change
  into this brick before switching to it: `walletCharger.debit` / `grant` under a key derived from its own ledger row
  (so a replay is a no-op), with that row's id in the optional trailing `metadata` argument, and, for a transfer, a
  `debit` on the source and a `grant` on the destination, each keyed by its own ledger row. Seed the brick's wallets
  once with `importWalletBalances` (dry run first, `createWallets` for workspaces with no wallet). Then
  `reconcileWallets(db, rows)` takes the host's `{ workspaceId, balanceMilli }` rows (converted to thousandths with
  `toMilli` or `toMilliRounded` from `@poc/sdk`), reads this brick's balances and reports each difference, the
  totals and `exact`. It writes nothing, and reads the brick's balances in one query per chunk of at most 90
  workspaces, so a host pages its own workspace list (a few hundred per call) rather than querying one by one. The brick refuses an overdraw that a host without such a check accepts; that
  shows up as a difference, which is what reconciliation is for. `walletShadowReport(group, result, checkedAt?)` turns
  that result into the sdk's `ShadowReport` (`{ group, exact, compared, differing, checkedAt }`) for a host reporting
  its migration per route group (story 2.11, docs/migrating-an-existing-app.md).
- **Erasure.** `credit_ledger` is retained when a user or a workspace is erased (`erase: "retain"`): it is the financial record every
  balance is the sum of, and a transfer is two rows in two workspaces, so deleting one user's rows would leave half a
  transfer. `user_id` cannot be anonymized because the ledger requires it. This follows the owner's
  decision that money records are kept.
