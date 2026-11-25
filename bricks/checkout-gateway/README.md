# @poc/checkout-gateway

Checkout sessions with a statutory tax lookup, and invoices. A session changes state, and an invoice is issued, only
from a verified payment-provider webhook: a session id is never proof of payment, and there is no "complete" route.

Exports: `createCheckoutRoutes`, `CheckoutService`, `calculateTax`, `checkoutMiddleware` and the `CheckoutEnv` types.

## Routes

Relative to your prefix (the assembler mounts them at `/api`):

| Route | Guard | What it does |
|-------|-------|--------------|
| `POST /checkout/sessions` | workspace | Creates a session in the caller's workspace |
| `GET /checkout/sessions/:id` | workspace | Reads one of the workspace's sessions |
| `GET /checkout/invoices`, `GET /checkout/invoices/:id` | workspace | Lists or reads the workspace's invoices |
| `POST /checkout/webhook` | none (signed by the provider) | Completes a paid session and issues its invoice, once |

The manifest's `guardPaths` name the workspace-guarded paths one by one so `/checkout/webhook` is left out: the
provider calls it with no user and no workspace. Its signature is its authentication, and the manifest rate-limits it
per IP (`checkout-webhook`).

## Payment gateway (story 2.3)

`createCheckoutRoutes({ gateway })` takes any `PaymentGateway` from `@poc/sdk` (`createOrder`, `fetchOrder`,
`verifyWebhook`), the same shape credit-wallet takes; `@poc/gateway-adapters` has adapters for real providers.

- **Without a gateway** the behaviour is as before: a session gets a placeholder `checkout_url`, line items are not
  capped, and `/checkout/webhook` answers 503 `NOT_CONFIGURED`, so no session can be completed. What does change is
  the table: after migration 0002 the session rows have the new gateway columns, left empty. (Every session now has
  bounded line items, quantity at most 1,000,000 and unit amount at most 10^12, metadata JSON at most 2048 characters
  and an email at most 255, the limits the table already enforced.)
- **Currency.** With a gateway, sessions are priced in the `currency` route option (the assembler fills it from the
  `paymentCurrency` setting, an ISO 4217 code, empty by default). Without it, session creation and the webhook answer
  503 `NOT_CONFIGURED`. A request body's `currency` is optional and must equal it (400 otherwise).
- **Price.** With a gateway, the provider is charged the server-computed total: the line items' sum plus tax. A body
  `amountCents` that differs from the line items' sum is refused with 400. A gateway session has at most 50 line items,
  and its total must be a positive, safe whole number (400 otherwise), checked before any provider order is created.
  Tax is computed in integer basis points, rounded half-up exactly.
- **The caller sets the line-item prices and the tax country.** The line items, and so the price, come from the
  request, and so does `countryCode`, from which the tax is computed. A host must create sessions from its own trusted
  code (not straight from a browser), or must not grant entitlements on the invoice alone. Server-side pricing from a
  catalog, and tax from a verified country, are deferred.
- **With a gateway**, `POST /checkout/sessions` creates the provider order first, for the session's total (amount plus tax) in the session's smallest currency unit, for
  the calling user as the customer, with the session id as the order id. Only when the provider has created it is the
  session recorded, with its total, currency, customer, the provider's reference and the line items, and the response
  carries the provider's `payment_session_id` instead of a placeholder URL. A provider failure answers 502 and records
  nothing; if the session cannot be recorded after the provider created its order, the provider order id is logged at
  error level so it can be reconciled. Without a gateway, nothing new is stored (no line items).
- **Currency units.** Sessions are priced in the currency's minor unit (cents, paise), which is the unit every
  `PaymentGateway` amount is in, so the session total passes to the gateway unchanged and is compared unchanged.
- **Webhook.** `POST /checkout/webhook` reads the raw body (at most 64 KiB, else 413) and asks the gateway to verify
  the signature (401 when it does not hold; 200 `ignored` for a correctly signed event that names no order). It then finds the session by its id, re-fetches the provider order, and requires it to be `PAID`
  with the session's id, exactly its total, its currency and its customer. A difference answers 409 and changes
  nothing. A match marks the session completed and issues one invoice (numbered `INV-<session id>`, with the session's
  line items) in one batch; a repeated delivery answers 200 `already_processed` and issues nothing. 200 also answers a
  session that is not paid yet, and a session the brick never recorded (logged at error level with the order id and
  provider reference, for reconciliation); 502 means the provider could not be asked, so it retries.

## Migrations

Apply `migrations/0001_checkout_gateway.sql` and `migrations/0002_verified_payments.sql` in order. 0002 adds the
session's customer, provider session id, provider reference and line items, and a unique index that allows one invoice
per session.
