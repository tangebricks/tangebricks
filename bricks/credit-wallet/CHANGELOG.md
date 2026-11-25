# Changelog

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
