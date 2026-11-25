# Changelog

## Unreleased (story 2.5: fractional credits, action costs, transfers)

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

## Unreleased (story 2.3: real payment adapters)

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
