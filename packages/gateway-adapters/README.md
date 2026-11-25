# @poc/gateway-adapters

Payment provider adapters behind the provider-neutral `PaymentGateway` from `@poc/sdk` (`createOrder`, `fetchOrder`,
`verifyWebhook`). credit-wallet and checkout-gateway take any `PaymentGateway`; no provider's name appears in their
code. The bricks check every payment themselves: a provider's "paid" is credited only if the order id, amount,
currency and customer it reports equal the order the brick stored.

**The unit rule.** Every amount on the `PaymentGateway` interface (`createOrder`'s `amountMinor`,
`GatewayOrder.amountMinor`) is a whole number in the currency's minor unit, the smallest one: paise, cents; yen for
zero-decimal currencies (JPY, KRW, VND, ...); fils for three-decimal ones (BHD, KWD, OMR, JOD, TND); four places for
CLF and UYW. Only codes in the SDK's ISO 4217 table (`PAYMENT_CURRENCIES`) are accepted. `minorUnitExponent`,
`toMinorUnits` and `fromMinorUnits` in `@poc/sdk` do the exact conversion. credit-wallet keeps whole major units and
converts at the interface; checkout-gateway is already in minor units. An adapter whose provider speaks major units
converts exactly at its own edge and never rounds.

**The rest of the contract.** `createOrder` returns `providerRef`, the provider's own reference for the order, which
the brick stores and passes back to `fetchOrder(orderId, providerRef)`. `verifyWebhook` returns `{ kind: "invalid" }`
for a missing, forged or stale signature (the route answers 401), `{ kind: "ignored" }` for a correctly signed event
that is not about an order (200, so the provider stops retrying), or `{ kind: "order", orderId, providerRef? }`. The
bricks refuse webhook bodies over 64 KiB with 413 before any signature check.

| Import | Provider |
|--------|----------|
| `@poc/gateway-adapters/cashfree` | Cashfree Payment Gateway (PG API): `createCashfreePaymentGateway` |
| `@poc/gateway-adapters/stripe` | Stripe Payment Intents through the Stripe integration manifest: `createStripePaymentGateway` |

## Cashfree

```ts
import { createCashfreePaymentGateway } from "@poc/gateway-adapters/cashfree";
import { createWalletRoutes } from "@poc/credit-wallet";

const gateway = createCashfreePaymentGateway({
  environment: env.CASHFREE_ENV,            // "sandbox" or "production"
  clientId: env.CASHFREE_CLIENT_ID,         // secret
  clientSecret: env.CASHFREE_CLIENT_SECRET, // secret
  apiVersion: "2023-08-01",
  customerDetails: async (userId) => ({ customer_phone: await phoneOf(userId), customer_email: await emailOf(userId) }),
  notifyUrl: "https://app.example.com/api/payments/webhook", // this brick's own webhook
});
app.route("/api", createWalletRoutes({ gateway, currency: "INR" }));
```

- **No defaults.** `environment`, `clientId`, `clientSecret`, `apiVersion`, `customerDetails` and `notifyUrl` are all required; a
  missing or empty one throws `NOT_CONFIGURED` when the adapter is created, naming the option (never its value).
- **Sandbox vs production.** `"sandbox"` talks to `https://sandbox.cashfree.com/pg`, `"production"` to
  `https://api.cashfree.com/pg`. Sandbox keys and production keys are different pairs from the Cashfree dashboard;
  keep each pair as Worker secrets (`wrangler secret put`), never in source or `wrangler.jsonc`.
- **Customer details.** Cashfree refuses an order without `customer_phone`, so the host says how to find it.
  `customer_id` is always the wallet's user id; Cashfree accepts letters, digits, `_` and `-` (up to 50) there, so use
  user ids of that shape.
- **Create order.** `POST /orders` with `x-client-id`, `x-client-secret`, `x-api-version` and
  `x-idempotency-key: order:<orderId>`; body `order_id`, `order_amount`, `order_currency`, `customer_details` and
  `order_meta.notify_url`. Only a 2xx answer with a `payment_session_id` counts; anything else throws
  `PROVIDER_ERROR` and the brick records no order. The client opens Cashfree's checkout with that
  `payment_session_id`. The provider reference is Cashfree's `cf_order_id` (the order id when there is none); Cashfree
  orders are fetched by the brick's order id.
- **Amounts.** Cashfree's `order_amount` is a decimal in the major unit, so the adapter converts at its edge, exactly:
  12345 paise go out as the literal `123.45` (50000 as `500.00`, 500 yen as `500`, 12345 fils as `12.345`), and the
  `order_amount` Cashfree reports comes back in minor units. An amount with more decimal places than the currency has
  (`123.456` rupees), a negative, exponent or missing amount becomes NaN, which never matches: refused, never rounded.
  It works for both credit-wallet and checkout-gateway.
- **Fetch order.** `GET /orders/{order_id}`; `order_status: "PAID"` maps to `PAID` (`ACTIVE`, `EXPIRED` and the rest
  stay as they are and credit nothing), plus `order_id`, `order_amount`, `order_currency` and
  `customer_details.customer_id`.
- **Webhook routing: one adapter per brick.** `notifyUrl` is required (an absolute `https` URL, checked when the
  adapter is created) and is sent as `order_meta.notify_url` on every order, so Cashfree notifies that URL about that
  order. Build one adapter for credit-wallet with `notifyUrl` set to its `/api/payments/webhook`, and another for
  checkout-gateway with its `/api/checkout/webhook`, so each brick's orders are notified to its own webhook. Relying on
  the dashboard's single webhook URL would deliver one brick's payments to the other, which acknowledges and drops them.
  Each brick also ignores, quietly, an order id that is not in its own format (wallet `order_...`, checkout `cs_...`).
- **Webhook verification.** A request is `invalid` unless `x-webhook-signature` equals
  base64(HMAC-SHA256(`x-webhook-timestamp` + raw body, client secret)), compared in constant time, and the timestamp is
  within five minutes. A signed event names `data.order.order_id` (an `order`); one without it is `ignored`. The
  brick re-fetches the order and checks it before acting on anything.
- **Egress.** Every request goes through the SDK's `createPublicUrlFetch` guard, and no redirect is followed (the keys
  travel in headers). Tests inject `fetch` and `resolveHost: null` and stay offline.
- **Errors.** Errors carry a code (`NOT_CONFIGURED`, `PROVIDER_ERROR`) and the HTTP status, never a key or Cashfree's
  own message; the wallet routes answer the client with a generic message.

### Contract fixtures

`test/fixtures/cashfree/` holds **documented samples, not live recordings**: they are written from the response and
webhook shapes in Cashfree's public documentation, because no sandbox keys were available. The contract tests
(`test/cashfree-payment-gateway.test.ts`) prove the adapter against those shapes only. Replacing them with real
sandbox recordings is an owner follow-up (see the fixtures README).

## Stripe

`createStripePaymentGateway({ manifest, connection, fetcher, webhookSecret })` calls Stripe through the Stripe
integration manifest's `createPaymentIntent` and `getPaymentIntent` operations.

- The order's currency is the brick's (lower-cased for Stripe); the adapter has none of its own. Amounts are already
  minor units, which is what Stripe's `amount` is, so they pass through unchanged (a 500-rupee wallet order is
  `amount: 50000`).
- **Currencies Stripe treats differently are refused.** For HUF, TWD, ISK, UGX and MGA Stripe's amount convention
  differs from ISO 4217's minor unit, so `createOrder` fails `NOT_SUPPORTED` (`STRIPE_UNSUPPORTED_CURRENCIES`) before
  any request rather than charge a wrong amount.
- The brick's user id is not a Stripe customer (`cus_...`), so it is never sent as `customer`; it travels in
  `metadata.customer_id` with `metadata.order_id`.
- The provider reference is the intent id (`pi_...`). `fetchOrder` fetches by it (Stripe has no lookup by the brick's
  order id; without a stored reference it fails `PROVIDER_ERROR`) and reports the intent's `metadata.order_id`,
  `metadata.customer_id` and currency upper-cased, so the brick's id, amount, currency and customer checks apply.
- `webhookSecret` is the endpoint's signing secret (`whsec_...`, a secret). It is required for webhooks: without it
  `verifyWebhook` fails `NOT_CONFIGURED`. The `Stripe-Signature` header (`t=...,v1=...`) must hold an HMAC-SHA256 of
  `${t}.${rawBody}` with that secret, within five minutes; a `payment_intent.*` event names its intent's
  `metadata.order_id` and its intent id. Any other correctly signed event is `ignored` (the route answers 200).
