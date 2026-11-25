# Changelog

## Unreleased (story 2.4: real delivery adapters, PROPOSED-9 hardening)

- **Breaking: adapters by provider.** The route option `adapter` is replaced by `adapters: Record<provider, DeliveryAdapter>`;
  a channel's `provider` selects its adapter. `MessageDispatcherService` takes `(db, { adapters, credentialsKey, ... })`
  and `sendMessage(workspaceId, channel, { recipient, body?, subject?, template? })`.
- **Breaking: the adapter contract** (`DeliveryAdapter` in `@poc/sdk`): `send(channel, message, credentials)` returns
  `{ status: "sent", externalId } | { status: "failed", error, retryable }`; `verifySender`; optional `checkConfig`,
  `parseStatusWebhook` and `answerWebhookChallenge`. `sent` is recorded only with a provider id.
- **Sender ownership (B8).** Channels start unverified; send answers 409 `SENDER_NOT_VERIFIED` until verified by
  credential or by a one-time code (`POST /messages/channels/:id/verify`).
- **Credentials (B9).** Sealed with AES-GCM under the new `PX_CHANNEL_CREDENTIALS_KEY` secret (associated data
  `workspace_id:channel_id`), never returned (`hasCredentials` only). Secret-like keys in `config` are refused.
- **Input (B10).** CR/LF/NUL in subject or recipient, and more than one recipient, are refused; email and E.164 formats
  are checked.
- **Paging (B12).** `/messages/history` `limit` 1..100, `offset` 0..100000; anything else 400.
- **Retries.** Up to 3 attempts, only for failures the provider says were not processed (429, 503 with Retry-After,
  throttling codes), with backoff (250 ms, 1 s, Retry-After up to 2 s) and a 20 s budget per send. Network errors,
  timeouts and thrown adapter errors are recorded `failed` with `UNKNOWN_OUTCOME` and never retried.
- **Workflow sends** only through channels an owner/admin marked `workflowSendAllowed` (`PATCH /messages/channels/:id`).
- **Verification limits.** Atomic attempt counting, superseded codes refused, at most 5 codes per channel per fixed hourly window and 20 per workspace per hour; a
  provider that cannot answer leaves the verified state unchanged (502).
- **Webhooks.** Unguarded `POST`/`GET /message-webhooks/:channelId` (own route prefix, outside the `/messages` guard): signature checked with the channel's own
  credentials, forward-only status updates (`delivered`, `read`, `failed`) within that channel's workspace.
- **Workflow node.** `createSendOutboundMessageExecutor({ adapters })` sends through the same path; the assembled node
  stays NOT_CONFIGURED.
- **Manifest.** Migration 0002, secret `PX_CHANNEL_CREDENTIALS_KEY` (brick and node), `rateLimits` (including channel
  create), explicit guard paths (the webhook paths are outside them), `DB` binding on the node.

## 1.0.0 — initial versioned release
