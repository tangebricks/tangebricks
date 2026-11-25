# @poc/gateway-adapters

Payment provider adapters behind the provider-neutral `PaymentGateway` from `@poc/sdk`, and (story 2.4) message
delivery adapters behind `DeliveryAdapter` (see [Outbound delivery adapters](#outbound-delivery-adapters-story-24)).
Payment adapters sit behind `PaymentGateway` (`createOrder`, `fetchOrder`,
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
| `@poc/gateway-adapters/zeptomail` | ZeptoMail email delivery: `createZeptoMailAdapter` |
| `@poc/gateway-adapters/meta-whatsapp` | WhatsApp Cloud API delivery: `createMetaWhatsAppAdapter` |

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

## Outbound delivery adapters (story 2.4)

Message delivery adapters behind the provider-neutral `DeliveryAdapter` from `@poc/sdk`, for the omnichannel-outbound
brick. The brick passes each call the channel (non-secret `config`, `sender_address`) and that channel's credentials,
decrypted for the call; the adapter itself holds no key. A host builds one adapter per provider string:

```ts
import { createMessageRoutes } from "@poc/omnichannel-outbound";
import { createZeptoMailAdapter } from "@poc/gateway-adapters/zeptomail";
import { createMetaWhatsAppAdapter } from "@poc/gateway-adapters/meta-whatsapp";

app.route("/api", createMessageRoutes({
  adapters: { zeptomail: createZeptoMailAdapter(), "meta-whatsapp": createMetaWhatsAppAdapter() },
}));
```

Common to both:

- **No defaults.** No endpoint region, API version or key is built in; a channel without them is refused when it is
  created (`checkConfig`) and nothing is sent.
- **Answers.** `sent` only with the provider's id. Retryable only when the provider said the message was not
  processed: an explicit 429, a 503 with `Retry-After`, or a throttling code; a `Retry-After` is passed on. Every other
  4xx and 5xx is `failed`, not retryable. A network error or timeout (10 s per request, reading the body included)
  is `failed` with `<PROVIDER>_UNKNOWN_OUTCOME`, not retryable, because the provider may have accepted the message;
  for a sender check it is `unavailable`. A request the egress guard refused before sending (URL, host or DNS check,
  a redirect) is `<PROVIDER>_EGRESS_REFUSED`. The brick does the
  retrying (3 attempts and 20 s at most).
- **Egress.** Every request goes through the SDK's `createPublicUrlFetch` guard, and no redirect is followed (the
  credentials travel in headers). Tests inject `fetch` and `resolveHost: null` and stay offline.
- **Errors.** A short code (`ZEPTOMAIL_HTTP_400_TM_3201`, `META_HTTP_400_130429`, `META_UNREACHABLE`), never a key or
  the provider's own text.

### ZeptoMail (`@poc/gateway-adapters/zeptomail`)

| | |
|---|---|
| Channel type | `email` |
| Config | `region` (required): the API domain suffix, e.g. `com`, `in`, `eu` (`https://api.zeptomail.<region>`). Optional `fromName` (no CR, LF or NUL), `bodyFormat` (`text`, the default, or `html`). |
| Credentials | `apiKey`: the Send Mail token, with or without its `Zoho-enczapikey ` prefix |
| Send | `POST /v1.1/email` with `Authorization: Zoho-enczapikey <token>`; body `from`, `to[].email_address.address`, `subject`, `textbody`/`htmlbody`. 2xx with `request_id` is `sent` with that id. |
| Templates | `POST /v1.1/email/template` with `mail_template_key` (the template name) and `merge_info` (the variables) |
| Sender verification | `code`: ZeptoMail has no API that ties an address to a token, so the brick mails a one-time code to the sender address |
| Delivery webhook | **Not handled.** Zoho's public pages describe a `producer-signature` HMAC-SHA256 header, but the exact signing input (whether its timestamp is signed) and the delivered-event payload were not documented clearly enough to implement a check that could be trusted, and an unsigned webhook is never accepted. ZeptoMail dispatches therefore stay `sent`; delivery status is deferred. |

### WhatsApp Cloud API (`@poc/gateway-adapters/meta-whatsapp`)

| | |
|---|---|
| Channel type | `whatsapp` |
| Sender address | the WhatsApp phone-number id (digits) |
| Config | `apiVersion` (required), e.g. `v21.0`. Optional `defaultLanguage` for templates (like `en` or `en_US`). |
| Credentials | `accessToken` (a system-user token), `appSecret` (signs webhooks), `verifyToken` (the GET subscription check) |
| Send | `POST https://graph.facebook.com/<apiVersion>/<phone-number-id>/messages`, `Authorization: Bearer <token>`. Text: `{ messaging_product: "whatsapp", to, type: "text", text: { body } }`. `messages[0].id` is `sent` with that id. |
| Templates | `type: "template"` with `name`, `language.code` (required) and body parameters: numeric variable keys (`"1"`, `"2"`) are positional, any other keys named (`parameter_name`) |
| Retryable errors | HTTP 429, a 503 with `Retry-After`, and the throttling / unavailable Graph codes 4, 17, 80007, 130429, 131016, 131056 |
| Sender verification | `credential`: `GET /<apiVersion>/<phone-number-id>?fields=id` with the token must answer that id. 429, 5xx or a network error is `unavailable` (not a "no"). |
| Status webhook | `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(raw body, appSecret)>`, compared in constant time; then `entry[].changes[].value.statuses[]` for this channel's phone-number id map to `delivered`, `read` or `failed`. No `appSecret` means every webhook is refused. |
| GET verify | echoes `hub.challenge` when `hub.mode=subscribe` and `hub.verify_token` equals the `verifyToken` credential |

In the Meta app's webhook settings, use `https://<your app>/api/message-webhooks/<channel id>` as the callback URL and
the channel's `verifyToken` as the verify token.

**Limit: one webhook URL per Meta app.** A Meta app has a single callback URL, so only the channel named in it
receives status updates. A second WhatsApp channel on the same Meta app gets none (its dispatches stay `sent`) unless it
uses a Meta app of its own.

### Contract fixtures

`test/fixtures/zeptomail/` and `test/fixtures/meta-whatsapp/` hold **documented samples, not live recordings**: they
are written from the response and webhook shapes in each provider's public documentation, because no accounts or
tokens were available. The contract tests (`test/zeptomail.test.ts`, `test/meta-whatsapp.test.ts`) prove the adapters
against those shapes only; neither adapter has been run against the real service. Replacing them with real recordings
is an owner follow-up (see each fixtures README).
