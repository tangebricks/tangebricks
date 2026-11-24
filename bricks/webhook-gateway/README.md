# Webhook Gateway (`@poc/webhook-gateway`)

The Webhook Gateway provides multi-tenant inbound and outbound webhook handling, cryptographic signature verification (HMAC-SHA256, Stripe Signature, and Shared Secret), secret rotation grace periods, payload truncation defenses against D1 row exhaustion DoS, and idempotency deduplication.

## Security & Verification Schemes

By default, the gateway enforces cryptographic verification on all inbound webhooks:
- `stripe-signature`: Verifies timestamp tolerance (5-minute replay window) and v1 HMAC signature against sealed `px_connections` credentials.
- `hmac-sha256`: Constant-time HMAC-SHA256 verification using secret keys (`X-Hub-Signature-256`, `X-Signature-SHA256`).
- `shared-secret`: Constant-time string comparison for token-authenticated endpoints (`X-Webhook-Secret`, custom headers).

### Development Flag (`PX_WEBHOOK_ALLOW_UNSIGNED`)

Unsigned webhooks (`verifier: "none"`) are **forbidden by default** across all environments:
- Attempting to register an endpoint or subscription with `verifier: "none"` returns HTTP `400 WEBHOOK_VERIFIER_NONE_FORBIDDEN`.
- Inbound requests for any stored subscription with `verifier = 'none'` return HTTP `401 WEBHOOK_VERIFIER_NONE_FORBIDDEN` and never invoke workflows.

To enable unsigned webhooks for local development or preview testing:
1. Set the environment variable / binding: `PX_WEBHOOK_ALLOW_UNSIGNED="dev"`, or pass option `allowUnsignedForDev: true` to `createWebhookRoutes` / `WebhookService`.
2. When enabled, unsigned webhooks are accepted and emit a `webhook.unsigned_accepted` telemetry warning event.
3. For endpoint ingress, accepted unsigned delivery rows record `signature_verified = 0`.

### Production Gate

Production deploy plans (`envName: "production"`) strictly refuse `PX_WEBHOOK_ALLOW_UNSIGNED="dev"` with blocker code `DEPLOY_UNSIGNED_WEBHOOKS_IN_PRODUCTION`. Unsigned webhooks can never be deployed to production environments.
