# @poc/omnichannel-outbound

Outbound messages (email, SMS, WhatsApp, Slack, Discord) per workspace: channels with a verified sender and sealed
credentials, one recipient per send, retries for transient provider failures, a dispatch log in D1, and delivery-status
updates from signed provider webhooks.

Exports: `createMessageRoutes`, `MessageDispatcherService` (the service the routes use), the `DeliveryAdapter`
contract (re-exported from `@poc/sdk`), `MockDeliveryAdapter` (tests only, refused in production),
`executeSendOutboundMessage` (the assembled workflow node, NOT_CONFIGURED) and `createSendOutboundMessageExecutor`.

## Delivery adapters

There is no default adapter. The brick never names a provider: each channel has a `provider` string, and the host
passes one adapter per provider string.

```ts
import { createMessageRoutes } from "@poc/omnichannel-outbound";
import { createZeptoMailAdapter } from "@poc/gateway-adapters/zeptomail";
import { createMetaWhatsAppAdapter } from "@poc/gateway-adapters/meta-whatsapp";

app.route("/api", createMessageRoutes({
  adapters: { zeptomail: createZeptoMailAdapter(), "meta-whatsapp": createMetaWhatsAppAdapter() },
}));
```

- A channel whose provider has no adapter answers 503 `NOT_CONFIGURED` on send. With adapters configured, creating a
  channel for a provider none of them serves is refused (400). With no adapters at all (the assembled default) a
  channel can be recorded, but it stays unverified and nothing is sent.
- `send` returns `{ status: "sent", externalId }` or `{ status: "failed", error, retryable }`. The brick records
  `sent` only when the adapter returned a provider id; anything else is `failed`.
- **Retries.** Only a failure the provider says was not processed is tried again: an explicit 429, a 503 with
  `Retry-After`, or a provider throttling code. At most 3 attempts in all, after 250 ms and then 1 s, or after the
  provider's `Retry-After` up to 2 s. Any other 4xx or 5xx is not retried. The outcome is recorded once, with `attempts`.
- **Unknown outcome.** A network error, a timeout (the adapters give each request, reading the response body
  included, about 10 s) or an adapter that throws may come after the provider accepted the message, so it is never
  retried (a retry could deliver it twice): the dispatch is recorded `failed` with an error code ending in
  `UNKNOWN_OUTCOME`, and the message may in fact have been delivered. A request the egress guard refused before
  sending is `..._EGRESS_REFUSED` (definitely not sent).
- **Budget.** A whole send, retries included, has 20 s, and an attempt starts only while at least 10 s (the adapter
  timeout) remain. A retryable failure that cannot be retried within the budget is recorded as that failure (for
  example the provider's 429), not as an unknown outcome; when no attempt could start the dispatch is `failed`
  `SEND_BUDGET_EXHAUSTED` with 0 attempts. Verification code mails follow the same rules.
- **Templates.** `POST /messages/send` takes `template: { name, language?, variables? }` instead of, or with, `body`.

## Channels

`POST /messages/channels` (owner/admin):

```json
{
  "channelType": "email",
  "provider": "zeptomail",
  "senderAddress": "noreply@example.com",
  "config": { "region": "in" },
  "credentials": { "apiKey": "<Send Mail token>" }
}
```

- **Credentials (B9).** Secrets go in `credentials`, never in `config`. They are sealed with AES-GCM under the
  `PX_CHANNEL_CREDENTIALS_KEY` secret, with `workspace_id:channel_id` as associated data, so a ciphertext copied to
  another channel or workspace does not open. Without the secret, creating a channel with credentials answers 503
  `NOT_CONFIGURED`. List and create answers never include credentials, only `hasCredentials: true`.
- `config` holds non-secret settings only (at most 4096 characters of JSON). A key at any depth that contains `key`,
  `token`, `secret`, `password` or `authorization` is refused with 400, and so is config nested more than 8 levels deep
  or with more than 200 keys.
- `credentials` holds at most 16 string entries and 8192 characters of JSON (400 otherwise), so the sealed envelope
  always fits its column.
- `workflowSendAllowed` (default false): whether workflow runs may send through this channel. Only owners and admins
  set it, on create or with `PATCH /messages/channels/:id {"workflowSendAllowed": true}`.
- An email sender must be a valid address. Every sender is one address, without CR, LF or NUL.

## Sender verification (B8)

A channel is created with `verified: false`, and sending through an unverified channel answers 409
`SENDER_NOT_VERIFIED`. The adapter says how ownership is proven:

- **`credential`**: the provider confirms the sender belongs to the credentials (for the WhatsApp Cloud API, the
  phone-number id is readable with the channel's token). Checked when the channel is created, and again on
  `POST /messages/channels/:id/verify` with no body. A provider "no" leaves the channel unverified. A provider that
  cannot answer (429, 5xx, network error) is not a "no": the verified state is left as it was and verify answers 502
  `PROVIDER_UNAVAILABLE`.
- **`code`**: the brick sends a 6-digit one-time code to the sender address through the adapter, when the channel is
  created and on `POST /messages/channels/:id/verify` with no body (a new code replaces the old one). An admin confirms
  it with `POST /messages/channels/:id/verify {"code":"123456"}`. The code is stored only as a SHA-256 hash, expires
  after 15 minutes (410 `CODE_EXPIRED`) and allows 5 attempts (then 429 `TOO_MANY_ATTEMPTS`; ask for a new code). A
  wrong code is 400 `INVALID_CODE`. Each attempt is counted by one conditional database update before the code is
  compared, so parallel guesses all count; a code replaced by a newer one is refused (409 `CODE_SUPERSEDED`). At most 5
  codes are sent per channel per fixed hourly window, across create and re-verify, and at most 20 per workspace per
  hour across all its channels (counted with the SDK rate limiter; 429 `TOO_MANY_CODES`).
- A code mail the provider definitely refused clears that code (only that one: a newer code stored meanwhile stays)
  and answers 502 `VERIFICATION_NOT_SENT`. A code mail with an unknown outcome keeps the code, since it may have
  arrived, and answers 502 `VERIFICATION_OUTCOME_UNKNOWN`: check the sender's inbox, or ask for a new code later.

Only owners and admins may create channels, verify them, or send.

## Sending (B10) and history (B12)

- `recipient` is exactly one address or number: a comma or semicolon is refused, and so is CR, LF or NUL in the
  recipient or the subject. Email recipients must be valid addresses; WhatsApp and SMS recipients must be E.164
  (`+` and 7 to 15 digits).
- `GET /messages/history?limit=&offset=&channelId=`: `limit` is a whole number from 1 to 100 (default 50) and `offset`
  from 0 to 100000 (default 0); anything else is 400.

## Status webhooks

`POST /message-webhooks/:channelId` receives a provider's delivery-status webhook, and
`GET /message-webhooks/:channelId` answers a provider's subscription check (the WhatsApp Cloud API echoes
`hub.challenge` when `hub.verify_token` equals the channel's `verifyToken` credential). Give the provider this URL with
the channel's id, e.g. `https://<your app>/api/message-webhooks/<channel id>`. The webhook routes have their own route
prefix, so every `/messages` path stays behind the workspace guard (`/api/messages`, `/api/messages/*`).

- Neither route is behind the workspace guard: the provider calls them. The channel id (unguessable) names the
  channel; its own decrypted credentials check the signature (only adapters with a documented signature scheme handle
  webhooks). Bodies over 64 KiB are refused (413) before any check; both routes are rate-limited per IP.
- A forged or missing signature is 401. An unknown channel or an unknown dispatch is 200 `ignored`. Only dispatches of
  that channel, in that channel's workspace, are updated, and only forwards: sent -> delivered -> read, sent -> failed.
- Any other failure answers a generic 503 or 500 with no secret name or detail; the detail is logged with the channel id.
- **One webhook URL per Meta app.** A Meta app has a single webhook callback URL, so only the channel whose id is in
  that URL receives status updates. A second WhatsApp channel on the same app gets none (its dispatches stay `sent`)
  unless it uses its own Meta app.

## Workflow node

`omnichannel-outbound.send_message` as assembled has no adapters and fails `NOT_CONFIGURED`. A host with adapters
registers `createSendOutboundMessageExecutor({ adapters })` for that node type: it reads the message from the `in` port
(`{ recipient, body?, subject?, template?, channel? }`), sends through the same dispatcher path in the run's verified
workspace (the node declares the `DB` binding and the `PX_CHANNEL_CREDENTIALS_KEY` secret), and throws on any refusal
or failed delivery. Anyone who can run a workflow could trigger it, so it sends only through a channel an owner or
admin marked `workflowSendAllowed`; any other channel refuses with `WORKFLOW_SEND_NOT_ALLOWED`.

## Migrations

- `0001`: `msg_channels`, `msg_dispatches`.
- `0002` (story 2.4): `msg_channels.verified`, `credentials_ciphertext`, `verify_code_hash`, `verify_code_expires_at`,
  `verify_code_attempts`, `verify_code_sends`, `verify_code_window_start`, `workflow_send_allowed`; `msg_dispatches`
  rebuilt with `attempts` and the `read` status.

## Rate limits (manifest)

| Bucket | Route | Limit |
|--------|-------|-------|
| `messages-send` | `POST /messages/send` | 60/min per workspace |
| `messages-channel-create` | `POST /messages/channels` | 5/min per workspace |
| `messages-verify` | `POST /messages/channels/:id/verify` | 10/min per workspace |
| `messages-webhook` | `POST /message-webhooks/:channelId` | 300/min per IP |
| `messages-webhook-challenge` | `GET /message-webhooks/:channelId` | 30/min per IP |
