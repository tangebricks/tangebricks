# Changelog

## 1.2.0 — shadow report

### Story 2.11: migration switch

- `walletShadowReport(group, result, checkedAt?)`: turns a `reconcileWallets` result into the sdk's generic
  `ShadowReport` `{ group, exact, compared, differing, checkedAt }`. `compared` is every row given, `differing` counts
  mismatched and refused rows, `exact` is the result's own, and `checkedAt` (a `Date` or ISO string) defaults to now.
  Nothing else changes.

## 1.1.0 — milli credits, transfers, real payment adapters, operator grants, shadow reconciliation

Everything below ships together in the 1.1.0 tarball. Stories 2.3, 2.5 and 2.6 were released under this version; they
are no longer "Unreleased".

### Story 2.9: shadow reconciliation and ledger metadata

- `walletCharger.debit`, `grant` and `refund` take an optional trailing `metadata` (a plain JSON object, at most 2000
  characters as JSON), merged into the ledger row's metadata. The operation tag (`op`, and `refunds` on a refund) wins
  over a key of the same name, and metadata plays no part in deciding whether a retry is the same operation. Without
  it, behaviour is unchanged. A host mirroring its own ledger records its row id here.
- `reconcileWallets(db, [{ workspaceId, balanceMilli }])`: compares a host's balances (in thousandths) with this
  brick's, read-only. Per row `{ workspaceId, hostMilli, brickMilli, diffMilli, refused }` (a workspace with no wallet
  has `brickMilli: null` and is compared as 0), the totals, `mismatchedRows`, `missingWallets`, `refusedRows`, and
  `exact`, true only when every row was read and every difference is 0. It reads the brick's balances in one query per
  chunk of at most 90 workspaces (never one query per workspace), so a host can page through thousands of workspaces
  within D1's limits.

### Story 2.6: operator grants

- `walletCharger.grant(db, ws, milli, key, reason, userId?)`: an idempotent top-up tagged `op: "grant"`, for
  platform-admin's credit grants. A retry is a duplicate only when the row under the key is a grant of the same amount;
  any other use of the key is `IDEMPOTENCY_KEY_REUSED`. A missing wallet is opened only for a live workspace (registered
  and not suspended), otherwise `WALLET_NOT_FOUND`.
- `createWallet().refund` takes an optional `match` (tags recorded on the top-up and required of a duplicate), as
  `deduct` already did. Without it, behaviour is unchanged.

### Story 2.5: fractional credits, action costs, transfers

- **Breaking: credits are thousandths.** Migration 0004 stores every credit amount as a whole number of thousandths
  (`credit_wallets.balance_milli`, `credit_ledger.amount_milli`, `credit_ledger.balance_after_milli`), renaming the
  columns and multiplying every existing value by 1000 in the same migration. CHECKs and indexes are kept;
  `credit_ledger` is rebuilt (through `credit_ledger_v3`) to add the transfer types and `transfer_code`. Order amounts
  are money and are unchanged.
- **Breaking for library callers.** `createWallet` and `walletCharger` take and return thousandths, under new names:
  `getBalanceMilli`, `deduct/refund({ amountMilli })`, `balanceAfterMilli`, `creditsMilli`,
  `walletCharger.balanceMilli`, `debit/refund(db, ws, milli, ...)`, `settled() -> { milli, type }`. Whole-credit code
  fails to compile.
- **Routes accept decimals.** Credit amounts may have up to three decimals (a number or a decimal string); responses
  carry both credits and thousandths (`currentBalanceMilli`, `amountMilli`, `balanceAfterMilli`, `chargedMilli`,
  `creditsMilli`). The `creditsPerUnit` route option may be a decimal with up to three places.
- **Action costs.** New `credit_action_costs` table; `GET /wallet/costs`, owner/admin `PUT` and `DELETE
  /wallet/costs/:action`, `POST /wallet/charge` (rate limit `wallet-charge`), the optional `defaultActionCosts` setting
  and `walletCharger.chargeAction`.
- **Transfers.** `POST /wallet/transfer` (owner/admin, never an API key; rate limit `wallet-transfer`): one atomic
  batch, two ledger rows (`transfer_out`, `transfer_in`) sharing a `transfer_code`, idempotent per source workspace and
  key.
- **Import tool.** `scripts/import-wallet-balances.ts` and `importWalletBalances` load decimal balances exactly, dry run
  by default, with a reconciliation report.
- **Idempotency keys are checked for the same operation.** A key already on the workspace's ledger answers
  `duplicate: true` only for the same operation (same type and amount; for a charge, the same action and quantity);
  anything else is 409 `IDEMPOTENCY_KEY_REUSED` and takes nothing.
- **Transfer destinations** must be live, unsuspended workspaces (`findWorkspaceState` in `@poc/sdk`) with a wallet;
  sufficiency is checked first.
- **`defaultActionCosts`** costs are capped at 999999.999 in both the pattern and the parser; a duplicate action keeps
  its first cost.
- **Erasure:** `credit_ledger` is now retained on user erasure (financial records), not deleted.
- The import tool refuses unknown workspaces, wallet-less workspaces (unless `--create-wallets`), wallets that already
  hold credits or an import (unless `--allow-existing`) and JSON number balances, and reconciles resulting balances.
- The client reads the new fields; the widget shows credits to the thousandth (unchanged code: `toLocaleString`).

### Story 2.3: real payment adapters

- **Breaking for host-written gateways: the unit rule.** Every amount on `PaymentGateway` is now a whole number in the
  currency's minor unit (paise, cents), and the field is renamed so an adapter written for the old contract fails to
  compile instead of charging the wrong amount: `createOrder({ orderId, amountMinor, currency, customerId })` and
  `GatewayOrder.amountMinor`. The wallet's own orders stay in whole major units (rupees); it converts with
  `toMinorUnits` from `@poc/sdk` when it creates an order and before it compares the provider's amount.
- **`providerRef`.** `createOrder` returns the provider's own reference for the order, the wallet stores it
  (`credit_orders.provider_ref`, migration 0003), and `fetchOrder(orderId, providerRef)` receives it back.
- **`verifyWebhook`** returns `{ kind: "invalid" }` (401), `{ kind: "ignored" }` (200) or
  `{ kind: "order", orderId, providerRef? }` instead of `{ orderId } | null`.
- **Verification.** A "PAID" answer is credited only if the order id, the exact amount, the currency and the customer
  match the stored order; a mismatch answers 409 `verification_mismatch` and credits nothing.
- **Currency.** New `currency` route option (`paymentCurrency` setting, an ISO 4217 code, empty by default); with a
  gateway and no currency the payment routes answer 503 `NOT_CONFIGURED`. Migration 0003 stores each order's currency.
- **Webhook.** New unguarded `POST /payments/webhook` (64 KiB body limit, IP rate limit `wallet-webhook`).

## 1.0.0 — initial versioned release
