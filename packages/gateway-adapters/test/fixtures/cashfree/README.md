# Cashfree contract fixtures

**These are documented samples, not live recordings.** No Cashfree sandbox keys were available when the adapter was
written (story 2.3), so every file here is written from the response and webhook payload shapes in Cashfree's public
PG API documentation (API version `2023-08-01`), with the ids, amounts and customers changed to match the tests. No
request was ever sent to Cashfree to produce them, and nothing here is evidence that the adapter has run against the
real service.

| File | Stands for |
|------|------------|
| `create-order.response.json` | `POST /pg/orders`, 200: the order with its `payment_session_id` |
| `fetch-order.paid.json` | `GET /pg/orders/{order_id}` once paid (`order_status: "PAID"`) |
| `fetch-order.active.json` | the same order before payment (`ACTIVE`) |
| `fetch-order.expired.json` | the same order after it expired unpaid (`EXPIRED`) |
| `webhook.payment-success.json` | the body of a `PAYMENT_SUCCESS_WEBHOOK` (signed by the tests with a test secret) |
| `error.authentication.json` | the body of a 401 for bad keys |

Owner follow-up: replace these with real recordings from a Cashfree sandbox account (keys stored as secrets, never in
this repository), keep this README's table in step, and run the contract tests in
`packages/gateway-adapters/test/cashfree-payment-gateway.test.ts` against them.
