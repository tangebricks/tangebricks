# WhatsApp Cloud API contract fixtures

**These are documented samples, not live recordings.** No Meta app, WhatsApp Business account or access token was
available when the adapter was written (story 2.4), so every file here is written from the response and webhook payload
shapes in Meta's public WhatsApp Cloud API documentation, with the ids and numbers changed. No request was ever sent to
Meta to produce them, and nothing here is evidence that the adapter has run against the real service.

| File | Stands for |
|------|------------|
| `send.success.json` | `POST /<version>/<phone-number-id>/messages`, 200: a text message accepted, with `messages[0].id` |
| `send-template.success.json` | the same for a template message |
| `error.invalid-parameter.json` | a 400 for a bad parameter (error code 100): not retryable |
| `error.rate-limit.json` | a 400 for throughput exceeded (error code 130429): retryable |
| `phone-number.json` | `GET /<version>/<phone-number-id>`: the number the token can see |
| `webhook.status-delivered.json` | a `messages` webhook with a `delivered` status (signed by the tests with a test app secret) |
| `webhook.status-read.json` | the same message, `read` |
| `webhook.status-failed.json` | a `failed` status with error 131026 |
| `webhook.inbound-message.json` | an inbound message, no statuses: ignored |

Owner follow-up: replace these with real recordings from a Meta test number (token and app secret stored as secrets,
never in this repository), keep this table in step, and run `packages/gateway-adapters/test/meta-whatsapp.test.ts`.
