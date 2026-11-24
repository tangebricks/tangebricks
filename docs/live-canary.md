# Live Canary Harness & Provider Sandbox Verification

## Overview
The Live Canary Harness (`scripts/integrations-live-canary.ts`, `"integrations:canary"`) executes automated end-to-end API verification against real third-party provider sandbox accounts. Its primary goal is to ensure that integrations claiming `production` maturity are backed by fresh, verified executions through the production integration executor and hardened egress fetch, rather than solely relying on recorded static fixtures.

## Tier Policy & Freshness Window
As defined in `scripts/tier-policy.json`:
```json
{
  "liveVerifiedMaxAgeDays": 7
}
```
- **Freshness Window:** 7 days.
- **Verification Rule:** `isLiveVerified(app, now)` returns `true` only if:
  1. `evidence/live-canary/<app>.json` exists.
  2. The run status is `"pass"`.
  3. `verifiedAt` is within the last 7 days of `now`.
- If a canary was skipped (e.g. missing sandbox secret) or failed, or if the evidence is older than 7 days, the integration cannot be certified as `production` (enforced in UC5.6).

## Safety & Security Guardrails

### 1. Refusal of Live Production Credentials (AC3)
The harness strictly verifies that no production secrets are ever fed into test runs. Any credential containing:
- Stripe live keys (`sk_live_...`, `rk_live_...`)
- Live webhook signing secrets (`whsec_live_...`)
- Generic live markers (`live_secret_...`)
immediately aborts execution with `CANARY_LIVE_CREDENTIAL_REFUSED` before any HTTP call is made.

### 2. Sandbox-Only Write Operations
Canary plans (`integrations/<app>/canary.json`) allow read operations and sandbox-safe operations. Any operation with `sideEffects: "write"` (e.g. creating a customer or channel) must explicitly declare:
```json
"sandboxOnly": true
```
Any write operation in a canary plan lacking `"sandboxOnly": true` is rejected by `validateCanaryPlan()`.

### 3. Automatic Secret Scrubbing (AC1)
All written evidence under `evidence/live-canary/<app>.json` is processed through the UC1.5 telemetry redaction scrubber (`redactTelemetryPayload`) before being committed. Even if a provider echoes authentication tokens or account secrets in response payloads or error messages, they are replaced with `[REDACTED]`.

---

## Provider Sandbox Accounts & Scopes

### 1. Stripe
- **Secret Environment Variable:** `CANARY_STRIPE_TOKEN`
- **Setup:**
  1. In the Stripe Dashboard, toggle to **Test Mode**.
  2. Navigate to **Developers -> API keys**.
  3. Create a restricted key or copy the standard test secret key (must start with `sk_test_`).
- **Required Scopes:**
  - `Customers: Read & Write` (`/v1/customers`)
  - `Balance: Read` (`/v1/balance`)
- **Operations Tested:** `listCustomers` (read), `createCustomer` (`sandboxOnly: true`).

### 2. GitHub
- **Secret Environment Variable:** `CANARY_GITHUB_TOKEN`
- **Setup:**
  1. Create a dedicated canary organization (e.g. `projectx-canary-org`).
  2. Create a Fine-grained Personal Access Token scoped solely to the canary organization.
- **Required Scopes:**
  - `Repositories: Read-only` (`listRepos`, `getRepo`)
- **Operations Tested:** `listRepos`.

### 3. Slack
- **Secret Environment Variable:** `CANARY_SLACK_TOKEN`
- **Setup:**
  1. Create a free sandbox workspace (e.g. `projectx-canary-workspace.slack.com`).
  2. In api.slack.com/apps, create a canary app and install it to the workspace.
  3. Obtain the Bot User OAuth Token (`xoxb-...`).
- **Required Scopes:**
  - `channels:read`
  - `groups:read`
  - `im:read`
  - `mpim:read`
- **Operations Tested:** `conversations_list`.

### 4. Discord
- **Secret Environment Variable:** `CANARY_DISCORD_TOKEN`
- **Setup:**
  1. In the Discord Developer Portal, create a canary Bot application.
  2. Create a dedicated canary Discord Server (Guild) and invite the bot.
  3. Copy the bot token (`Bot <token>`).
- **Required Scopes:**
  - Bot permissions: `View Channels`, `Read Message History`.
- **Operations Tested:** `getGuild`.

### 5. Google
- **Secret Environment Variable:** `CANARY_GOOGLE_SA_JSON`
- **Setup:**
  1. In Google Cloud Console, create a canary project.
  2. Enable the Google Calendar API.
  3. Create a service account and export its private key JSON.
  4. Share a dedicated canary secondary calendar with the service account email.
- **Required Scopes:**
  - `https://www.googleapis.com/auth/calendar.readonly`
  - `https://www.googleapis.com/auth/calendar.events`
- **Operations Tested:** `calendar_events_list`.

---

## Secret Management & Rotation
1. Sandbox tokens are stored in the GitHub repository's **Environment Secrets** under environment `canary`.
2. Secrets are rotated every 90 days.
3. If a secret is rotated or expired, the canary job records `status: "fail"` (if expired) or `status: "skipped"` (if variable unset), triggering notification without crashing the repository build.

---

## Execution

### Local / CLI
Run canaries for all registered integrations:
```bash
pnpm integrations:canary
```
Run a single integration canary:
```bash
node scripts/integrations-live-canary.ts --app stripe
```

### Scheduled GitHub Actions
`.github/workflows/live-canary.yml` runs daily at `03:17 UTC` and on `workflow_dispatch`. It executes the suite, uploads artifact evidence, and commits updated `evidence/live-canary/*.json` to the dedicated `evidence/live-canary` branch for consumption by CI `catalog:tiers`.
