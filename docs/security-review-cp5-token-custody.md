# CP5 Security Review Sign-Off — Risk K12 Cloudflare Token Custody (`R28`)

- **Review Gate:** Checkpoint 5 (`epic-cp5-deploy-from-studio`, Story 5.6 `story-cp5-token-security-review-and-gate`)
- **Risk Covered:** Initiative Risk **K12** (High-blast-radius user Cloudflare API tokens held for BYOC deployment)
- **Requirements Covered:** PRD **R27**, **R28**, **R29**, **R30**, **R31**; Architecture **AD-S10**, **AD-S12**, **AD-S14**; Owner Decisions **D1**, **D8**
- **Status:** **SIGNED OFF — PASS**

---

## 1. Threat Model (Risk K12)

Per Owner Decision **D1**, ProjectX Studio deploys every generated application—both `preview` and `production`—into the customer's own Cloudflare account (**BYOC**). Holding a user's Cloudflare API token introduces six primary threat vectors (**Risk K12**):

| Threat ID | Threat Description | Blast Radius if Unmitigated | K12 Mitigation Summary |
|---|---|---|---|
| **T1 — Over-Privileged Credentials** | A user pastes a legacy Cloudflare Global API Key or an unscoped account-admin token. | Full takeover of DNS zones, billing, Zero Trust policies, R2 buckets, and unrelated Workers in the user's Cloudflare account. | Guided pre-filled Cloudflare scoped token creation URL (`buildCloudflareTokenTemplateUrl`) requesting only 4 least-privilege scopes; active rejection of Global API Keys (`GLOBAL_API_KEY_REJECTED`) and immediate per-permission verification (`verifyCloudflareToken`). |
| **T2 — Database Compromise / At-Rest Exfiltration** | An attacker obtains a read dump or SQL injection against `STUDIO_DB` (`deploy_tokens`) or `BlueprintDO` SQLite storage. | Attacker extracts plaintext Cloudflare API tokens for all connected organizations. | **AES-256-GCM Envelope Encryption**: each token is encrypted with a unique random 256-bit Data Encryption Key (`DEK`) and 96-bit `iv`, and the `DEK` is wrapped with a 256-bit Key Encryption Key (`PX_TOKEN_KEK`) and its own 96-bit `dek_iv`, versioned via `kek_version`. `PX_TOKEN_KEK` lives exclusively in Cloudflare Worker secret bindings, never in D1 or `BlueprintDO`. |
| **T3 — Cross-Surface Token Leakage** | A plaintext token (or its Base64 / URL-encoded form) is accidentally written into `saas.blueprint.json`, the `BlueprintDO` ops log, `builds`, `deployments`, `deployment_steps`, `px_runs`, `px_step_events`, `onboarding_funnel_events`, `deploy_token_audit_log`, HTTP responses, WebSocket frames, or MCP tool responses. | Token is leaked to browser DevTools, AI agents (Claude/Cursor via MCP), exported JSON bundles, or observability logs. | Strict opaque handle indirection (`tokenRef = tok_<uuidv7>`). Only `tokenRef` and `tokenLast4` ever appear in `DeployTarget`, `project_environments`, API payloads, or audit logs. Automated canary scan (`cf_canary_secret_token_9f8e7d6c5b4a`) verifies `0` occurrences across all SQLite tables, HTTP responses, WebSocket frames, and MCP tools. |
| **T4 — Autonomous Agent / Unauthorized Privilege Escalation** | An MCP agent (`mcp_token`) or `viewer` organization member attempts to connect a Cloudflare account, read/unwrap a token, or revoke a token without authorization. | Unsupervised AI agent connects unauthorized infrastructure or hijacks deploy targets. | Architecture **AD-S12**: `POST /api/orgs/:orgId/cloudflare-tokens/verify-and-save` unconditionally rejects MCP bearer tokens (`403 HUMAN_CONSENT_REQUIRED`). Token management requires `role >= editor` (`owner` or `editor`) and `connect` scope. |
| **T5 — Unaudited / Silent Token Usage** | A token is decrypted and used to mutate Cloudflare resources without an immutable forensic trail. | Organization owners cannot determine which actor or deployment used a token or when. | `decryptToken()` atomically inserts a row into `deploy_token_audit_log` (`audit_id`, `token_ref`, `org_id`, `actor`, `deploy_id`, `action`, `created_at`) on every successful unwrap before returning plaintext to the caller. |
| **T6 — Post-Revocation Residual Access** | A user disconnects/revokes their Cloudflare token in Studio, but cached credentials or nullable flags still allow subsequent `plan`, `deploy`, `promote`, `check-drift`, or `rollback` calls to execute. | Revoked token continues mutating or probing the user's Cloudflare account. | `revokeDeployToken()` atomically sets `status = 'revoked'` and overwrites `ciphertext = NULL`, `iv = NULL`, `wrapped_dek = NULL`, and `dek_iv = NULL` in `deploy_tokens`. Every token consumer (`plan`, `deploy`, `promote`, `check-drift`, `rollback`, `decryptToken`) immediately fails with `TOKEN_REVOKED` and makes `0` outbound calls to `CloudflareApiClient`. |

---

## 2. AES-256-GCM Envelope Encryption Architecture

Cloudflare API tokens are sealed in `apps/studio-api/src/security/token-vault.ts` using two-tier **WebCrypto AES-256-GCM envelope encryption**:

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Worker Secret Binding (Never stored in D1 / SQLite)                        │
│   PX_TOKEN_KEK (master secret)  +  PX_TOKEN_KEK_VERSION (e.g. 1)           │
│         │                                                                  │
│         ▼ SHA-256 -> WebCrypto AES-256-GCM Key (non-extractable)           │
└─────────┼──────────────────────────────────────────────────────────────────┘
          │
          │ wraps / unwraps (AES-256-GCM, 96-bit dek_iv, 128-bit auth tag)
          ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ Per-Token Data Encryption Key (DEK)                                        │
│   rawDek = crypto.getRandomValues(new Uint8Array(32))  (256-bit random)    │
│   Zeroed in memory (rawDek.fill(0)) immediately after seal / unwrap        │
└─────────┼──────────────────────────────────────────────────────────────────┘
          │
          │ encrypts / decrypts (AES-256-GCM, 96-bit iv, 128-bit auth tag)
          ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ D1 Table: deploy_tokens (`apps/studio-api/migrations/0003_cp5_deploy_tokens.sql`)
│   - token_ref:   "tok_<uuidv7>" (opaque handle)                            │
│   - token_last4: last 4 chars only (e.g. "5b4a")                           │
│   - status:      'active' | 'revoked' | 'expired'                          │
│   - ciphertext:  Base64(AES-256-GCM(DEK, iv, plaintextToken))              │
│   - iv:          Base64(12-byte random IV)                                 │
│   - wrapped_dek: Base64(AES-256-GCM(KEK[kek_version], dek_iv, rawDek))     │
│   - dek_iv:      Base64(12-byte random DEK IV)                             │
│   - kek_version: INTEGER (supports zero-downtime KEK rotation)             │
└────────────────────────────────────────────────────────────────────────────┘
```

### Key Cryptographic Properties
1. **Unique Per-Token DEK & IVs**: Every call to `sealDeployToken()` generates 32 bytes (`256 bits`) of CSPRNG key material for `rawDek`, a 12-byte (`96-bit`) `tokenIv` for the token ciphertext, and a separate 12-byte (`96-bit`) `dekIv` for wrapping the DEK (`apps/studio-api/src/security/token-vault.ts:422-443`).
2. **In-Memory Zeroization**: Both `sealDeployToken()` (`line 443`), `decryptToken()` (`lines 583, 594`), and `rotateDeployTokenKek()` (`line 732`) explicitly zero out `rawDek.fill(0)` immediately after WebCrypto operations complete.
3. **Authenticated Encryption & Tamper Detection**: AES-GCM provides a 128-bit authentication tag on both `wrapped_dek` and `ciphertext`. Flipping any bit in `ciphertext`, `iv`, `wrapped_dek`, or `dek_iv` causes WebCrypto `crypto.subtle.decrypt` to reject with `DeployTokenVaultError("TOKEN_TAMPERED")` (`apps/studio-api/src/security/token-vault.ts:550-592`) and writes zero audit entries (`apps/studio-api/test/token-vault.test.ts:205-276`).
4. **Online KEK Rotation (`rotateDeployTokenKek`)**: Rotating `PX_TOKEN_KEK` from `kek_version = N` to `N + 1` unwraps each active token's `wrapped_dek` under `KEK[N]` and re-wraps it under `KEK[N+1]` with a fresh `dek_iv` without touching `ciphertext` or re-requesting tokens from users (`apps/studio-api/src/security/token-vault.ts:667-757`, tested in `apps/studio-api/test/token-vault.test.ts:278-359`).

---

## 3. Least-Privilege Permission Template Scopes (`R27`, `R28`)

Studio never asks for a Cloudflare Global API Key or full account administrator privileges. `buildCloudflareTokenTemplateUrl()` (`packages/deploy/src/target.ts:63-153`) generates a pre-filled Cloudflare dashboard link requesting **only** four scoped permissions:

| Permission ID | Cloudflare Permission Label | Template Key & Access | Why It Is Required |
|---|---|---|---|
| `account_settings_read` | `Account Settings: Read` | `account_settings: read` | Verify target Cloudflare `accountId` and `accountName` during Connect Cloudflare. |
| `workers_scripts_edit` | `Workers Scripts: Edit` | `workers_scripts: edit` | Upload assembled Worker script bundles, configure bindings, secret bindings, and Cron Triggers. |
| `d1_edit` | `D1: Edit` | `d1: edit` | Provision `preview` and `production` D1 SQLite databases, apply forward migrations, and hot-apply workflow graphs (`_px_workflows`). |
| `queues_edit` | `Queues: Edit` | `queues: edit` | Create and bind Cloudflare Queues required by asynchronous bricks and workflows. |

- **Pre-filled Dashboard Template URL**:
  `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=[{"key":"workers_scripts","type":"edit"},{"key":"d1","type":"edit"},{"key":"queues","type":"edit"},{"key":"account_settings","type":"read"}]&name=ProjectX+Studio+Deploy`
- **Immediate Per-Permission Verification**:
  Upon paste into `POST /api/orgs/:orgId/cloudflare-tokens/verify-and-save`, `verifyCloudflareToken()` (`packages/deploy/src/target.ts:996-1174`) checks token status, rejects Global API Keys (`isGlobalApiKey === true`), and verifies each of the 4 permissions individually. Missing permissions return HTTP `422 MISSING_REQUIRED_PERMISSIONS` with plain-language diagnostics (e.g., `"Workers Scripts: Edit missing ✕"`, `"D1: Edit missing ✕"`), a direct `"Fix in Cloudflare"` remediation link, and **zero rows written to `deploy_tokens`**.

---

## 4. End-to-End Token Lifecycle

1. **Connect (`wizard_opened` → `template_link_clicked`)**:
   A human user with `role >= editor` opens the **Connect Cloudflare** wizard in Studio (`apps/studio-web/src/components/ConnectCloudflareModal.tsx`). Funnel events are recorded in `onboarding_funnel_events` (`apps/studio-api/src/index.ts:4394-4438`).
2. **Verify (`token_submitted` → `verification_succeeded` / `verification_failed`)**:
   `POST /api/orgs/:orgId/cloudflare-tokens/verify-and-save` (`apps/studio-api/src/index.ts:4481-4700`) blocks MCP agent callers (`403 HUMAN_CONSENT_REQUIRED`), enforces `role >= editor` and `connect` scope, and runs `verifyCloudflareToken()`.
3. **Seal (`sealDeployToken`)**:
   Only after all 4 permissions verify green, `sealDeployToken()` (`apps/studio-api/src/security/token-vault.ts:398-498`) encrypts the token with AES-256-GCM envelope encryption, stores the sealed row in `deploy_tokens`, provisions `preview` and `production` `DeployTarget` records (`{ type: "byoc", accountId, tokenRef, envName }`) in `project_environments`, and returns only `tokenRef` (`tok_<uuidv7>`) and `tokenLast4`.
4. **Decrypt-in-Step (`createStudioTokenResolver` → `decryptToken`)**:
   All deploy operations (`plan`, `apply`, `putGraph`, `putSecret`, `promote`, `destroy`) accept only `DeployTarget = { type: "byoc", accountId, tokenRef, envName }`. Static lint (`scripts/lint-deploy-target.ts`) forbids reading `process.env.CLOUDFLARE_*` or hard-coding account IDs. The plaintext token is decrypted via `TokenResolver` exclusively inside the isolated provisioner step right before invoking `CloudflareApiClient` (`packages/deploy/src/target.ts:2734-2750`).
5. **Audit (`deploy_token_audit_log`)**:
   Every call to `decryptToken()` (`apps/studio-api/src/security/token-vault.ts:596-602`) and `revokeDeployToken()` (`lines 649-656`) writes an immutable audit record (`audit_id`, `token_ref`, `org_id`, `actor`, `deploy_id`, `action`, `created_at`) queryable via `GET /api/orgs/:orgId/cloudflare-tokens/:tokenRef/audit`.
6. **Revoke (`DELETE /api/orgs/:orgId/cloudflare-tokens/:tokenRef`)**:
   `revokeDeployToken()` (`apps/studio-api/src/security/token-vault.ts:607-665`) sets `status = 'revoked'`, overwrites `ciphertext = NULL`, `iv = NULL`, `wrapped_dek = NULL`, and `dek_iv = NULL`, marks environments `token_revoked`, and logs a `revoke` audit entry plus `token_disconnected` funnel event. All subsequent `plan`, `deploy`, `promote`, `check-drift`, and `rollback` requests fail immediately with HTTP `422 TOKEN_REVOKED` and make `0` outbound calls to `CloudflareApiClient`.

---

## 5. K12 Control-to-Test Traceability Matrix

Every K12 security control is verified by automated tests executed in `pnpm ci:cp5`:

| K12 Control | Implementation File & Lines | Passing Test File & Lines |
|---|---|---|
| **C-K12-01:** Abstract `DeployTarget` contract (`{ type: "byoc", accountId, tokenRef, envName }`) & static lint forbidding `CLOUDFLARE_*` env reads or hard-coded account IDs | `packages/deploy/src/target.ts:7-41`<br>`scripts/lint-deploy-target.ts:26-155` | `packages/deploy/test/deploy-target.test.ts:22-79`<br>`packages/deploy/test/deploy-target.test.ts:310-367` |
| **C-K12-02:** Least-privilege Cloudflare scoped token template URL (`Workers Scripts: Edit`, `D1: Edit`, `Queues: Edit`, `Account Settings: Read`) | `packages/deploy/src/target.ts:43-153`<br>`apps/studio-api/src/index.ts:4357-4379` | `packages/deploy/test/verify-token.test.ts:12-28`<br>`apps/studio-api/test/connect-cloudflare.test.ts:133-160` |
| **C-K12-03:** Per-permission verifier rejecting missing scopes (`Workers Scripts: Edit`, `D1: Edit`), expired/revoked tokens, and Global API Keys with 0 rows stored | `packages/deploy/src/target.ts:996-1174`<br>`apps/studio-api/src/index.ts:4565-4606` | `packages/deploy/test/verify-token.test.ts:54-132`<br>`apps/studio-api/test/connect-cloudflare.test.ts:188-297` |
| **C-K12-04:** AD-S12 human-consent gate (`403 HUMAN_CONSENT_REQUIRED` for MCP agent tokens) & RBAC (`role >= editor` + `connect` scope) | `apps/studio-api/src/index.ts:4135-4195`<br>`apps/studio-api/src/index.ts:4491-4530` | `apps/studio-api/test/connect-cloudflare.test.ts:162-186`<br>`apps/studio-api/test/token-vault.test.ts:467-490` |
| **C-K12-05:** AES-256-GCM envelope encryption (`PX_TOKEN_KEK` + per-token 256-bit DEK + 96-bit `iv`/`dek_iv` + `kek_version`) & in-memory DEK zeroization | `apps/studio-api/src/security/token-vault.ts:398-498`<br>`apps/studio-api/migrations/0003_cp5_deploy_tokens.sql:3-20` | `apps/studio-api/test/token-vault.test.ts:104-159`<br>`apps/studio-api/test/k12-token-security-review.test.ts:352-390` |
| **C-K12-06:** AES-GCM authentication tag tamper detection on `ciphertext` and `wrapped_dek` (`TOKEN_TAMPERED`) | `apps/studio-api/src/security/token-vault.ts:550-592` | `apps/studio-api/test/token-vault.test.ts:205-276` |
| **C-K12-07:** Zero-downtime master KEK rotation (`rotateDeployTokenKek` from `kek_version = 1` to `2` without re-encrypting token ciphertext) | `apps/studio-api/src/security/token-vault.ts:667-757` | `apps/studio-api/test/token-vault.test.ts:278-359` |
| **C-K12-08:** Mandatory audit logging in `deploy_token_audit_log` on every `decryptToken()` and `revokeDeployToken()` | `apps/studio-api/src/security/token-vault.ts:357-396`<br>`apps/studio-api/src/security/token-vault.ts:596-602` | `apps/studio-api/test/token-vault.test.ts:160-203`<br>`apps/studio-api/test/k12-token-security-review.test.ts:660-666` |
| **C-K12-09:** End-to-end canary leak scan (`cf_canary_secret_token_9f8e7d6c5b4a` raw, Base64, Base64URL, URL-encoded) proving `0` occurrences across `BlueprintDO` SQLite, `builds`, `deployments`, `deployment_steps`, `px_runs`, `px_step_events`, `onboarding_funnel_events`, `deploy_token_audit_log`, `deploy_tokens`, HTTP responses, WebSocket frames, and MCP responses | `apps/studio-api/src/security/token-vault.ts:398-665`<br>`apps/studio-api/src/blueprint-do.ts:2158-2188` | `apps/studio-api/test/k12-token-security-review.test.ts:174-682`<br>`apps/studio-web/e2e/connect-cloudflare.spec.ts:140-144` |
| **C-K12-10:** Immediate revocation (`DELETE /api/orgs/:orgId/cloudflare-tokens/:tokenRef`) nulling `ciphertext` & `wrapped_dek` and blocking `plan`, `deploy`, `promote`, `check-drift`, and `rollback` with `TOKEN_REVOKED` and `0` outbound `CloudflareApiClient` calls | `apps/studio-api/src/security/token-vault.ts:607-665`<br>`apps/studio-api/src/index.ts:4272-4355`<br>`apps/studio-api/src/index.ts:5328-5342`<br>`apps/studio-api/src/index.ts:6692-6706`<br>`apps/studio-api/src/index.ts:6856-6871` | `apps/studio-api/test/token-vault.test.ts:526-652`<br>`apps/studio-api/test/k12-token-security-review.test.ts:601-754` |
| **C-K12-11:** Production `identity: "stub"` blocker (D8) & Destructive D1 Migration Guard (`DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, type narrowing) | `packages/deploy/src/target.ts:2945-3195`<br>`apps/studio-api/src/index.ts:6330-6398` | `packages/deploy/test/plan-diff.test.ts:246-293`<br>`packages/deploy/test/migration-guard.test.ts:30-146`<br>`apps/studio-api/test/deploy-plan.test.ts:224-396`<br>`apps/studio-api/test/drift-and-rollback.test.ts:461-529` |
