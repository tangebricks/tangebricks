# Runbook: Workers Observability Preset, Logpush & Tail Worker Alerts

## Overview
ProjectX provides a production observability preset configured through a single blueprint field. When enabled, it provisions:
1. **Workers Logs & Traces:** Real-time log capture and invocation tracing enabled natively on Cloudflare Workers.
2. **Logpush Readiness:** Metadata flag enabling Logpush trace streaming to long-term audit/analytics storage (R2, S3, Datadog, Splunk).
3. **Tail Worker Alert Path:** A dedicated tail consumer Worker (`<project>-tail`) that receives invocations asynchronously, filters for failures and 5xx errors, scrubs secrets via `@poc/telemetry` value patterns, and dispatches HMAC-signed alert batches to an alert webhook.

---

## 1. How to Enable in Blueprints

In your project blueprint (`blueprint.json`), add the `observability` configuration:

```json
{
  "project": "my-service",
  "bricks": [
    "multi-workspace",
    "credit-wallet"
  ],
  "observability": {
    "logs": true,
    "logpush": true,
    "alerts": {
      "webhookSecret": "PX_ALERT_WEBHOOK_URL"
    }
  }
}
```

### Configuration Options
- **`logs` (boolean, optional):** Enables native Workers Logs in `wrangler.jsonc` (`observability: { enabled: true }`) and upload metadata.
- **`logpush` (boolean, optional):** Enables Logpush ingestion for the Worker (`logpush: true`) in `wrangler.jsonc` and upload metadata.
- **`alerts` (object, optional):**
  - **`webhookSecret` (string, optional):** Environment variable or secret name holding the destination webhook URL (defaults to `"PX_ALERT_WEBHOOK_URL"`).
  - **`signingSecret` (string, optional):** Environment variable holding the HMAC secret used to sign alert POSTs (defaults to checking `PX_ALERT_SIGNING_SECRET`, `PX_ALERT_SECRET`, or `PX_TELEMETRY_SECRET`).

When `alerts` is specified, the assembler emits:
- `wrangler.jsonc`: configures `tail_consumers: [{ service: "<project>-tail" }]`.
- `tail/src/index.ts`: the tail Worker alert handler with pattern scrubbing and signing.
- `tail/wrangler.jsonc`: configuration for the `<project>-tail` Worker.

The deploy provisioner automatically uploads the tail Worker script to Cloudflare before uploading the primary Worker. Teardown removes both scripts safely in reverse dependency order.

---

## 2. Where Logs and Traces Are

### Cloudflare Dashboard
1. Log in to the Cloudflare Dashboard.
2. Navigate to **Workers & Pages** > Select your Worker (`<project>`).
3. Click the **Logs** / **Observability** tab to inspect invocations, CPU time, uncaught exceptions, and status codes.

### Real-Time Streaming via Wrangler
To stream real-time logs in your terminal:
```bash
wrangler tail <project>
```
To monitor the tail alert processor Worker itself:
```bash
wrangler tail <project>-tail
```

---

## 3. Tail Worker Alert Path & Payload Shape

### Filter Criteria
The tail handler processes every trace item emitted by the parent Worker and filters for events meeting any of the following criteria:
- `outcome !== "ok"` (e.g. `exception`, `exceededCpu`, `exceededMemory`, `unknown`)
- `exceptions.length > 0`
- HTTP response status code >= 500 (`response.status >= 500` or `event.response.status >= 500`)

If no events meet these criteria, the batch is dropped and no webhook request is sent.
If the alert webhook URL is not set in the environment, the event is silently dropped without throwing.

### Secret Scrubbing
Before alert payloads leave the Cloudflare account, the JSON payload is scrubbed using `@poc/telemetry` value patterns (`scrubValuePatterns`). Sensitive tokens are replaced with kinded placeholders:
- Stripe API keys (`sk_live_...`, `rk_live_...`) -> `[REDACTED:stripe]`
- JWT and Bearer tokens -> `[REDACTED:bearer]`
- Private keys (`-----BEGIN PRIVATE KEY-----`) -> `[REDACTED:private_key]`
- URL query parameters (`?key=...`, `?token=...`) -> `[REDACTED:url_query]`

### Alert Payload Shape
The alert webhook receives a `POST` request with `Content-Type: application/json` formatted as:

```json
{
  "type": "tail_alert",
  "service": "my-service",
  "timestamp": "2026-11-06T18:30:00.000Z",
  "batchSize": 1,
  "events": [
    {
      "outcome": "exception",
      "scriptName": "my-service",
      "eventTimestamp": 1700000000000,
      "exceptions": [
        {
          "name": "StripeError",
          "message": "Payment processing failed: [REDACTED:stripe] insufficient funds",
          "timestamp": 1700000000000
        }
      ],
      "event": {
        "request": {
          "url": "https://my-service.workers.dev/api/checkout",
          "method": "POST"
        },
        "response": {
          "status": 500
        }
      }
    }
  ]
}
```

### HMAC Signature Header
Alert deliveries include the signature header:
```
x-px-signature: sha256=<hex-digest>
```
The signature is generated using HMAC-SHA256 over the raw JSON payload. Your receiving endpoint can verify this header using `verifyTelemetrySignature` from `@poc/telemetry`.

---

## 4. How to Test with Wrangler Tail

1. In one terminal, begin streaming tail alerts:
   ```bash
   wrangler tail <project>-tail
   ```
2. Trigger an application error or simulated 500 in your deployed Worker:
   ```bash
   curl -i -X POST https://<project>.<subdomain>.workers.dev/api/cause-error
   ```
3. Observe the tail worker receiving the event, filtering `outcome !== "ok"`, scrubbing any secrets, and dispatching the HTTP POST to your alert receiver.

---

## 5. Logpush Job Creation (Manual Account-Level Setup)

Logpush pushes batches of Worker invocation logs directly to object storage or third-party monitoring vendors. Because Logpush requires account-level permissions and vendor-specific destination credentials, Logpush jobs are created at the account level rather than per-deploy.

### Prerequisites
- Cloudflare Workers Paid or Enterprise plan.
- Destination storage or service credentials (e.g. Cloudflare R2 bucket, AWS S3 bucket, Datadog API key, Splunk HEC).

### Step-by-Step Dashboard Setup
1. In Cloudflare Dashboard, go to **Analytics & Logs** > **Logpush**.
2. Click **Create a Logpush job**.
3. Under **Select dataset**, select **Workers Trace Events**.
4. Choose your destination (e.g. **Cloudflare R2**, **Amazon S3**, **Datadog**).
5. Enter destination credentials and run the ownership challenge verification.
6. Under **Filter events**, specify:
   - Service: select your Worker (`<project>`).
7. Save and enable the Logpush job.

### Cloudflare API Setup
You can also automate Logpush creation in your organization's terraform/infrastructure repo via the Cloudflare API:
```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/logpush/jobs" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "projectx-workers-logpush",
    "dataset": "workers_trace_events",
    "filter": "{\"where\":{\"and\":[{\"key\":\"ScriptName\",\"operator\":\"eq\",\"value\":\"my-service\"}]}}",
    "destination_conf": "r2://<bucket-path>?account-id=<account-id>&access-key-id=<key>&secret-access-key=<secret>",
    "enabled": true
  }'
```
