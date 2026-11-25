# ZeptoMail contract fixtures

**These are documented samples, not live recordings.** No ZeptoMail account or Send Mail token was available when the
adapter was written (story 2.4), so every file here is written from the response shapes in ZeptoMail's public Email
Sending API documentation (`POST /v1.1/email`, `POST /v1.1/email/template`), with the request ids changed. No request
was ever sent to ZeptoMail to produce them, and nothing here is evidence that the adapter has run against the real
service.

| File | Stands for |
|------|------------|
| `send.success.json` | `POST /v1.1/email`, 201: the request accepted, with its `request_id` |
| `send-template.success.json` | `POST /v1.1/email/template`, 201 |
| `error.mandatory-field.json` | a 400 for a request with a missing field (`TM_3201`) |
| `error.invalid-token.json` | a 401 for a bad Send Mail token (`TM_3301`) |

Owner follow-up: replace these with real responses from a ZeptoMail account (token stored as a secret, never in this
repository), keep this table in step, and run `packages/gateway-adapters/test/zeptomail.test.ts`.
