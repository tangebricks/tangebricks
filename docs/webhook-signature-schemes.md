# Declarative Webhook Signature Schemes

This document defines the schema, template vocabulary, and verification semantics for inbound third-party webhook signatures in ProjectX (`bricks/webhook-gateway` and `@poc/assembler`).

## Overview

Inbound third-party webhooks use varied HMAC and asymmetric signature patterns (Slack's `v0:{timestamp}:{body}`, GitHub's `sha256=<hex>`, Cashfree's `{timestamp}{body}` in base64, Stripe's `t=...,v1=...`, etc.). Instead of hardcoding vendor names in gateway logic, any HMAC or signature scheme is expressed declaratively as data via `WebhookSignatureScheme`.

Integration manifests (`integrations/*/integration.json`) define triggers with either a preset string or a `WebhookSignatureScheme` object.

---

## Schema Reference

The scheme object is validated by `WebhookSignatureSchemeSchema` in `@poc/assembler`:

```typescript
export interface WebhookSignatureScheme {
  /** Digest and signing algorithm */
  algorithm: "hmac-sha256" | "hmac-sha1" | "hmac-sha512" | "ed25519";
  /** Payload template containing tokens and allowed literals [A-Za-z0-9:._-] */
  signedPayload: string;
  /** Header carrying the inbound signature */
  signatureHeader: string;
  /** Optional header carrying the timestamp */
  timestampHeader?: string;
  /** Optional header carrying the delivery / event id */
  idHeader?: string;
  /** Signature encoding format */
  encoding: "hex" | "base64";
  /** Optional prefix prepended to signature (e.g. "v0=" or "sha256=") */
  prefix?: string;
  /** Optional structured signature format */
  signatureFormat?: {
    kind: "kv-list";
    pairSeparator: string;
    kvSeparator: string;
    timestampKey?: string;
    signatureKey: string;
  };
  /** Replay tolerance window in seconds (0 to 3600) */
  toleranceSec?: number;
  /** Secret key encoding */
  secretEncoding?: "utf8" | "base64" | "hex";
  /** Optional public key hex string (32 bytes = 64 hex chars for ed25519). If omitted, secret is used as public key. */
  publicKey?: string;
}
```

---

## Template Vocabulary

The `signedPayload` template accepts only the following tokens:

| Token | Source | Description |
|---|---|---|
| `{body}` | Inbound request | The exact raw body bytes as received over the wire. |
| `{timestamp}` | `timestampHeader` or `signatureFormat.timestampKey` | The timestamp value extracted from the request. |
| `{id}` | `idHeader` | The event/delivery identifier header value. |
| `{url}` | Inbound request | The target request URL. |

### Literal Restrictions
Literals outside token placeholders are strictly limited to `[A-Za-z0-9:._-]`. Any token outside the allowed set fails manifest validation with `WEBHOOK_SCHEME_UNKNOWN_TOKEN`.

---

## Verification Reasons & HTTP Responses

All verification failures return HTTP 401 with a typed error code matching `WebhookVerifyReason`. Secret keys and expected signature digests are never echoed in error responses.

| Reason Code | HTTP Status | Description |
|---|---|---|
| `WEBHOOK_SIGNATURE_HEADER_MISSING` | 401 | The header specified by `signatureHeader` was not present in the request. |
| `WEBHOOK_TIMESTAMP_MISSING` | 401 | `{timestamp}` or `toleranceSec` was required, but no valid timestamp was found in headers or kv-list. |
| `WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE` | 401 | `abs(now - timestamp) > toleranceSec`, rejecting replayed or stale payloads. |
| `WEBHOOK_SIGNATURE_MALFORMED` | 401 | Signature candidate missing required `prefix`, missing `signatureKey` in kv-list, or invalid hex/base64 encoding. |
| `WEBHOOK_SIGNATURE_MISMATCH` | 401 | Signature candidate digest does not match computed HMAC. |

---

## Examples

### Slack Events API
```json
{
  "algorithm": "hmac-sha256",
  "signedPayload": "v0:{timestamp}:{body}",
  "signatureHeader": "X-Slack-Signature",
  "timestampHeader": "X-Slack-Request-Timestamp",
  "encoding": "hex",
  "prefix": "v0=",
  "toleranceSec": 300
}
```

### GitHub Webhooks
```json
{
  "algorithm": "hmac-sha256",
  "signedPayload": "{body}",
  "signatureHeader": "X-Hub-Signature-256",
  "encoding": "hex",
  "prefix": "sha256="
}
```

### Timestamp + Body (Base64)
```json
{
  "algorithm": "hmac-sha256",
  "signedPayload": "{timestamp}{body}",
  "signatureHeader": "X-Webhook-Signature",
  "timestampHeader": "X-Webhook-Timestamp",
  "encoding": "base64",
  "toleranceSec": 300
}
```

### Discord Interactions / Webhooks (Ed25519)
Discord interactions and webhooks authenticate using asymmetric Ed25519 signatures over `${timestamp}${body}` via WebCrypto:
```json
{
  "algorithm": "ed25519",
  "signedPayload": "{timestamp}{body}",
  "signatureHeader": "X-Signature-Ed25519",
  "timestampHeader": "X-Signature-Timestamp",
  "encoding": "hex",
  "toleranceSec": 300
}
```
Verification semantics for Ed25519:
- `publicKey` (or the registered `signingSecret`) must be a 32-byte raw public key encoded as a 64-character hex string.
- The signature header must contain a 64-byte Ed25519 signature encoded as a 128-character hex string.
- If the signature or public key cannot be decoded to exactly 64 or 32 bytes respectively, verification fails with `WEBHOOK_SIGNATURE_MALFORMED`.
- Verification calls WebCrypto `crypto.subtle.importKey("raw", publicKeyBytes, { name: "Ed25519" }, false, ["verify"])` followed by `crypto.subtle.verify("Ed25519", key, sigBytes, payloadBytes)`. It never executes HMAC or symmetric digest routines.
- If the signature does not cryptographically match the public key and payload, verification fails with `WEBHOOK_SIGNATURE_MISMATCH`.

---

## Replay Protection Policy (UC4.4)

Replay protection prevents an adversary from capturing a validly signed webhook and resending it to re-trigger workflows or duplicate actions. ProjectX enforces a two-tier defense:

### 1. Timestamp Tolerance Window
- For every scheme that defines a `timestampHeader` or a `signatureFormat` containing a timestamp key, the gateway enforces `|now - timestamp| <= toleranceSec`.
- The default tolerance window is **300 seconds (±5 minutes)** whenever a timestamp is configured, unless an explicit `toleranceSec` is specified.
- The clock is resolved via `options.adapter.nowSeconds` (allowing deterministic test mocking) with fallback to runtime system epoch seconds.
- Requests with timestamps outside the tolerance window (stale timestamps or timestamps too far in the future) are rejected with HTTP 401 and reason `WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE`.

### 2. Idempotent Delivery Deduplication
- Every accepted webhook delivery is recorded in SQLite table `px_webhook_deliveries` with a `UNIQUE(subscription_id, provider_event_id)` constraint.
- The `provider_event_id` is extracted in order:
  1. Configured subscription dot-path (`subscription.event_id_path`, e.g. `id` or `delivery_id`).
  2. Standard provider delivery headers (`X-Webhook-Delivery`, `X-GitHub-Delivery`, `X-Stripe-Event-Id`).
  3. **Signature Hash Fallback**: When no event ID is present in payload or headers, the gateway derives the key as `sig:` + `sha256Hex(signatureHeaderValue)`.
- Replaying any previously accepted delivery returns HTTP 200 with `{ received: true, deduplicated: true }` and never starts a subsequent workflow run.

### 3. Presets Reference Table (UC4.3)

| Preset Name | Aliases | Algorithm | Signature Header | Timestamp Header / Format | Encoding | Prefix | Replay Tolerance |
|---|---|---|---|---|---|---|---|
| `stripe-signature` | `stripe-v1` | `hmac-sha256` | `stripe-signature` | `kv-list` (`t=<ts>,v1=<sig>`) | `hex` | None | ±300s |
| `github-hmac-sha256` | `hmac-sha256` | `hmac-sha256` | `x-hub-signature-256` | N/A (Event-ID dedupe) | `hex` | `sha256=` | N/A (`sig:` dedupe) |
| `meta-hub-signature-256` | `meta-sha256` | `hmac-sha256` | `x-hub-signature-256` | N/A (Event-ID dedupe) | `hex` | `sha256=` | N/A (`sig:` dedupe) |
| `slack-v0` | | `hmac-sha256` | `x-slack-signature` | `x-slack-request-timestamp` | `hex` | `v0=` | ±300s |
| `discord-ed25519` | `ed25519` | `ed25519` | `x-signature-ed25519` | `x-signature-timestamp` | `hex` | None | ±300s |
| `hmac-sha256-timestamp-body-base64` | `timestamp-body-base64` | `hmac-sha256` | `x-signature` | `x-timestamp` | `base64` | None | ±300s |
| `shared-secret` | | `constant-time string` | `x-webhook-secret` (configurable) | N/A | utf8 | None | N/A |


