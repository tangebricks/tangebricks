# Manifest Restoration & Conformance Review (37 Generated Bricks)

This document records the restoration of the 37 brick manifests overwritten in commit `e40d60f` from their pre-`e40d60f` state (`e40d60f^` / `c7ae2ce`) into the ManifestSchema v2 dialect, and reviews each manifest against its TypeScript source (`src/`) and SQL migrations (`migrations/`).

The 3 foundational hand-written bricks (`credit-wallet`, `multi-workspace`, and `dynamic-entities`) were also enriched with `ui` (`displayName`, `category`, `summary`) and `globalTables` (`mw_workspaces`) so all 40 bricks in the catalog pass `pnpm catalog:conformance` (40/40).

| `brick` | Original Commit | Fields Restored | Fields Changed or Dropped & Why | Conformance | Reviewer Note |
| --- | --- | --- | --- | --- | --- |
| admin-console | `e40d60f^ (c7ae2ce)` | ui.displayName ("Admin Console & User Impersonation"); ui.category ("governance"); ui.summary; globalTables (adm_super_admins) | Condensed original 188-char description into <=140-char ui.summary | PASS (0 violations) | Manifest accurately describes @poc/admin-console routes (/api/admin), D1 migrations (migrations/0001_admin_console.sql), and runtime options. |
| agent-sandbox | `e40d60f^ (c7ae2ce)` | ui.displayName ("Agent Sandbox & Tool Registry"); ui.category ("ai"); ui.summary | Dropped unread settings [maxToolTimeoutMs] because src/routes.ts does not read them; Aligned routePrefixes to mounted Hono routes [mcp] | PASS (0 violations) | Manifest accurately describes @poc/agent-sandbox routes (/api/mcp), D1 migrations (migrations/0001_agent_sandbox.sql), and runtime options. |
| audit-trail | `e40d60f^ (c7ae2ce)` | ui.displayName ("Audit Trail & Compliance Ledger"); ui.category ("governance"); ui.summary | Dropped unread settings [defaultPageSize] because src/routes.ts does not read them | PASS (0 violations) | Manifest accurately describes @poc/audit-trail routes (/api/audit), D1 migrations (migrations/0001_audit_trail.sql), and runtime options. |
| binary-assets | `e40d60f^ (c7ae2ce)` | ui.displayName ("Binary Asset Pipeline"); ui.category ("data"); ui.summary; settings (maxFileSizeBytes); bindings (BUCKET: r2) | Added ui.summary from brick implementation and PROGRESS.json metadata | PASS (0 violations) | Manifest accurately describes @poc/binary-assets routes (/api/assets), D1 migrations (migrations/0001_binary_assets.sql), and runtime options. |
| checkout-gateway | `e40d60f^ (c7ae2ce)` | ui.displayName ("Multi-Gateway Checkout & Taxes"); ui.category ("billing"); ui.summary | Dropped unread settings [defaultGateway, defaultCurrency] because src/routes.ts does not read them; Aligned routePrefixes to mounted Hono routes [checkout] | PASS (0 violations) | Manifest accurately describes @poc/checkout-gateway routes (/api/checkout), D1 migrations (migrations/0001_checkout_gateway.sql), and runtime options. |
| core-auth | `e40d60f^ (c7ae2ce)` | ui.displayName ("Core Authentication"); ui.category ("identity"); ui.summary; settings (sessionDurationSeconds); globalTables (auth_users, auth_credentials, auth_sessions) | Dropped unread settings [allowMagicLink] because src/routes.ts does not read them; Added ui.summary from brick implementation and PROGRESS.json metadata | PASS (0 violations) | Manifest accurately describes @poc/core-auth routes (/api/auth), D1 migrations (migrations/0001_core_auth.sql), and runtime options. |
| cron-alarms | `e40d60f^ (c7ae2ce)` | ui.displayName ("Cron & Distributed Alarms"); ui.category ("automation"); ui.summary; settings (maxSchedulesPerWorkspace) | Added ui.summary from brick implementation and PROGRESS.json metadata | PASS (0 violations) | Manifest accurately describes @poc/cron-alarms routes (/api/schedules), D1 migrations (migrations/0001_cron_alarms.sql), and runtime options. |
| custom-domains | `e40d60f^ (c7ae2ce)` | ui.displayName ("Custom Domain & SSL Provisioning"); ui.category ("developer"); ui.summary | None (direct v1-to-v2 mapping) | PASS (0 violations) | Manifest accurately describes @poc/custom-domains routes (/api/domains), D1 migrations (migrations/0001_custom_domains.sql), and runtime options. |
| data-privacy-gdpr | `e40d60f^ (c7ae2ce)` | ui.displayName ("Data Privacy & GDPR Toolkit"); ui.category ("governance"); ui.summary | None (direct v1-to-v2 mapping) | PASS (0 violations) | Manifest accurately describes @poc/data-privacy-gdpr routes (/api/privacy), D1 migrations (migrations/0001_data_privacy.sql), and runtime options. |
| document-parsing | `e40d60f^ (c7ae2ce)` | ui.displayName ("Document Parsing & Structured Extraction"); ui.category ("ai"); ui.summary | Declared conflict with document-pdf | PASS (0 violations) | Manifest accurately describes @poc/document-parsing routes (/api/docs), D1 migrations (migrations/0001_document_parsing.sql), and runtime options. |
| document-pdf | `e40d60f^ (c7ae2ce)` | ui.displayName ("Document & PDF Generation"); ui.category ("data"); ui.summary | Dropped unread settings [defaultPageSize] because src/routes.ts does not read them; Aligned routePrefixes to mounted Hono routes [documents]; Declared conflict with document-parsing | PASS (0 violations) | Manifest accurately describes @poc/document-pdf routes (/api/documents), D1 migrations (migrations/0001_document_pdf.sql), and runtime options. |
| edge-traffic-armor | `e40d60f^ (c7ae2ce)` | ui.displayName ("Edge Traffic Armor"); ui.category ("governance"); ui.summary; globalTables (arm_rate_limits) | Dropped unread settings [defaultRateLimit, defaultWindowSeconds] because src/routes.ts does not read them | PASS (0 violations) | Manifest accurately describes @poc/edge-traffic-armor routes (/api/armor), D1 migrations (migrations/0001_edge_traffic_armor.sql), and runtime options. |
| feature-flags | `e40d60f^ (c7ae2ce)` | ui.displayName ("Feature Flags & Progressive Rollouts"); ui.category ("governance"); ui.summary; settings (allowWorkspaceOverrides); globalTables (flag_definitions) | Added ui.summary from brick implementation and PROGRESS.json metadata | PASS (0 violations) | Manifest accurately describes @poc/feature-flags routes (/api/flags), D1 migrations (migrations/0001_feature_flags.sql), and runtime options. |
| identity-federation | `e40d60f^ (c7ae2ce)` | ui.displayName ("Identity Federation & Enterprise SSO"); ui.category ("identity"); ui.summary | Dropped unread settings [allowSelfRegistration] because src/routes.ts does not read them; Aligned routePrefixes to mounted Hono routes [sso] | PASS (0 violations) | Manifest accurately describes @poc/identity-federation routes (/api/sso), D1 migrations (migrations/0001_identity_federation.sql), and runtime options. |
| in-app-notifications | `e40d60f^ (c7ae2ce)` | ui.displayName ("In-App Notification Center"); ui.category ("communication"); ui.summary | Dropped unread settings [defaultLimit] because src/routes.ts does not read them | PASS (0 violations) | Manifest accurately describes @poc/in-app-notifications routes (/api/notifications), D1 migrations (migrations/0001_in_app_notifications.sql), and runtime options. |
| live-chat | `e40d60f^ (c7ae2ce)` | ui.displayName ("Live Chat & Support Messenger"); ui.category ("communication"); ui.summary | Dropped unread settings [defaultChannel] because src/routes.ts does not read them; Aligned routePrefixes to mounted Hono routes [chat] | PASS (0 violations) | Manifest accurately describes @poc/live-chat routes (/api/chat), D1 migrations (migrations/0001_live_chat.sql), and runtime options. |
| llm-gateway | `e40d60f^ (c7ae2ce)` | ui.displayName ("LLM Gateway & Prompt Router"); ui.category ("ai"); ui.summary; settings (defaultProvider) | Dropped unread settings [maxTokensPerRequest] because src/routes.ts does not read them; Added ui.summary from brick implementation and PROGRESS.json metadata | PASS (0 violations) | Manifest accurately describes @poc/llm-gateway routes (/api/ai), D1 migrations (migrations/0001_llm_gateway.sql), and runtime options. |
| marketplace-splits | `e40d60f^ (c7ae2ce)` | ui.displayName ("Marketplace Splits & Payouts"); ui.category ("billing"); ui.summary | Dropped unread settings [defaultPlatformFeePercent, defaultEscrowDays] because src/routes.ts does not read them; Aligned routePrefixes to mounted Hono routes [marketplace] | PASS (0 violations) | Manifest accurately describes @poc/marketplace-splits routes (/api/marketplace), D1 migrations (migrations/0001_marketplace_splits.sql), and runtime options. |
| metered-usage | `e40d60f^ (c7ae2ce)` | ui.displayName ("Metered Usage & Event Ingestion"); ui.category ("billing"); ui.summary; globalTables (meter_definitions) | Dropped unread settings [defaultAggregationWindow] because src/routes.ts does not read them; Aligned routePrefixes to mounted Hono routes [meters, events, usage] | PASS (0 violations) | Manifest accurately describes @poc/metered-usage routes (/api/meters, /api/events, /api/usage), D1 migrations (migrations/0001_metered_usage.sql), and runtime options. |
| oauth-server | `e40d60f^ (c7ae2ce)` | ui.displayName ("OAuth 2.0 Authorization Server"); ui.category ("developer"); ui.summary | Condensed original 148-char description into <=140-char ui.summary | PASS (0 violations) | Manifest accurately describes @poc/oauth-server routes (/api/oauth), D1 migrations (migrations/0001_oauth_server.sql), and runtime options. |
| omnichannel-outbound | `e40d60f^ (c7ae2ce)` | ui.displayName ("Omnichannel Outbound Dispatcher"); ui.category ("communication"); ui.summary; settings (defaultChannel) | Added ui.summary from brick implementation and PROGRESS.json metadata; Aligned routePrefixes to mounted Hono routes [messages] | PASS (0 violations) | Manifest accurately describes @poc/omnichannel-outbound routes (/api/messages), D1 migrations (migrations/0001_omnichannel_outbound.sql), and runtime options. |
| outbound-webhooks | `e40d60f^ (c7ae2ce)` | ui.displayName ("Outbound Developer Webhooks"); ui.category ("developer"); ui.summary | Dropped unread settings [defaultTimeoutMs] because src/routes.ts does not read them; Aligned routePrefixes to mounted Hono routes [subscriptions]; Declared conflict with subscription-plans | PASS (0 violations) | Manifest accurately describes @poc/outbound-webhooks routes (/api/subscriptions), D1 migrations (migrations/0001_outbound_webhooks.sql), and runtime options. |
| product-analytics | `e40d60f^ (c7ae2ce)` | ui.displayName ("Product Analytics & Funnel Tracking"); ui.category ("governance"); ui.summary | Dropped unread settings [defaultFunnelWindowHours] because src/routes.ts does not read them; Aligned routePrefixes to mounted Hono routes [analytics] | PASS (0 violations) | Manifest accurately describes @poc/product-analytics routes (/api/analytics), D1 migrations (migrations/0001_product_analytics.sql), and runtime options. |
| public-api-keys | `e40d60f^ (c7ae2ce)` | ui.displayName ("Public API Key Infrastructure"); ui.category ("developer"); ui.summary | Dropped unread settings [rateLimitPerMinute] because src/routes.ts does not read them; Added ui.summary from brick implementation and PROGRESS.json metadata | PASS (0 violations) | Manifest accurately describes @poc/public-api-keys routes (/api/api-keys), D1 migrations (migrations/0001_public_api_keys.sql), and runtime options. |
| queue-jobs | `e40d60f^ (c7ae2ce)` | ui.displayName ("Background Job Queue & Dead-Letter Handling"); ui.category ("automation"); ui.summary | Dropped unread settings [defaultQueue, defaultMaxRetries, visibilityTimeoutSeconds] because src/routes.ts does not read them; Aligned routePrefixes to mounted Hono routes [jobs] | PASS (0 violations) | Manifest accurately describes @poc/queue-jobs routes (/api/jobs), D1 migrations (migrations/0001_queue_jobs.sql), and runtime options. |
| rbac-policy | `e40d60f^ (c7ae2ce)` | ui.displayName ("RBAC & ABAC Policy Engine"); ui.category ("identity"); ui.summary; settings (allowCustomRoles); globalTables (rbac_permissions) | Added ui.summary from brick implementation and PROGRESS.json metadata | PASS (0 violations) | Manifest accurately describes @poc/rbac-policy routes (/api/roles, /api/policies), D1 migrations (migrations/0001_rbac_policy.sql), and runtime options. |
| realtime-presence | `e40d60f^ (c7ae2ce)` | ui.displayName ("Real-Time Presence & State Sync"); ui.category ("communication"); ui.summary | Dropped unread settings [heartbeatTtlSeconds] because src/routes.ts does not read them; Aligned routePrefixes to mounted Hono routes [presence] | PASS (0 violations) | Manifest accurately describes @poc/realtime-presence routes (/api/presence), D1 migrations (migrations/0001_realtime_presence.sql), and runtime options. |
| scripting-sandbox | `e40d60f^ (c7ae2ce)` | ui.displayName ("Plugin / Scripting Sandbox"); ui.category ("developer"); ui.summary | None (direct v1-to-v2 mapping) | PASS (0 violations) | Manifest accurately describes @poc/scripting-sandbox routes (/api/scripts), D1 migrations (migrations/0001_scripting_sandbox.sql), and runtime options. |
| search-faceted | `e40d60f^ (c7ae2ce)` | ui.displayName ("Full-Text & Faceted Search"); ui.category ("data"); ui.summary | Dropped unread settings [defaultLimit] because src/routes.ts does not read them | PASS (0 violations) | Manifest accurately describes @poc/search-faceted routes (/api/search), D1 migrations (migrations/0001_search_faceted.sql), and runtime options. |
| subscription-plans | `e40d60f^ (c7ae2ce)` | ui.displayName ("Subscription & Plan Entitlements"); ui.category ("billing"); ui.summary; settings (defaultTier); globalTables (sub_plans) | Added ui.summary from brick implementation and PROGRESS.json metadata; Aligned routePrefixes to mounted Hono routes [plans, subscriptions]; Declared conflict with outbound-webhooks | PASS (0 violations) | Manifest accurately describes @poc/subscription-plans routes (/api/plans, /api/subscriptions), D1 migrations (migrations/0001_subscription_plans.sql), and runtime options. |
| tabular-engine | `e40d60f^ (c7ae2ce)` | ui.displayName ("Spreadsheet & Tabular Engine"); ui.category ("data"); ui.summary | Dropped unread settings [maxImportRows, maxPayloadBytes] because src/routes.ts does not read them; Aligned routePrefixes to mounted Hono routes [tabular] | PASS (0 violations) | Manifest accurately describes @poc/tabular-engine routes (/api/tabular), D1 migrations (migrations/0001_tabular_engine.sql), and runtime options. |
| threaded-discussions | `e40d60f^ (c7ae2ce)` | ui.displayName ("Contextual Threaded Discussions"); ui.category ("communication"); ui.summary | Dropped unread settings [maxDepth] because src/routes.ts does not read them; Aligned routePrefixes to mounted Hono routes [threads] | PASS (0 violations) | Manifest accurately describes @poc/threaded-discussions routes (/api/threads), D1 migrations (migrations/0001_threaded_discussions.sql), and runtime options. |
| user-onboarding | `e40d60f^ (c7ae2ce)` | ui.displayName ("User Onboarding & Activation Tours"); ui.category ("governance"); ui.summary | None (direct v1-to-v2 mapping) | PASS (0 violations) | Manifest accurately describes @poc/user-onboarding routes (/api/onboarding), D1 migrations (migrations/0001_user_onboarding.sql), and runtime options. |
| user-profile | `e40d60f^ (c7ae2ce)` | ui.displayName ("User Profile & Preferences"); ui.category ("identity"); ui.summary; globalTables (profile_users) | Dropped unread settings [defaultTheme, defaultLocale, defaultTimezone] because src/routes.ts does not read them; Aligned routePrefixes to mounted Hono routes [me, users] | PASS (0 violations) | Manifest accurately describes @poc/user-profile routes (/api/me, /api/users), D1 migrations (migrations/0001_user_profile.sql), and runtime options. |
| vector-memory | `e40d60f^ (c7ae2ce)` | ui.displayName ("Vector Memory & Semantic Index"); ui.category ("data"); ui.summary | Dropped unread settings [defaultDimensions, defaultMetric] because src/routes.ts does not read them; Aligned routePrefixes to mounted Hono routes [vectors] | PASS (0 violations) | Manifest accurately describes @poc/vector-memory routes (/api/vectors), D1 migrations (migrations/0001_vector_memory.sql), and runtime options. |
| webhook-gateway | `e40d60f^ (c7ae2ce)` | ui.displayName ("Webhook Ingress & Egress Gateway"); ui.category ("automation"); ui.summary; settings (secretRotationGraceHours) | Added ui.summary from brick implementation and PROGRESS.json metadata | PASS (0 violations) | Manifest accurately describes @poc/webhook-gateway routes (/api/webhooks), D1 migrations (migrations/0001_webhook_gateway.sql), and runtime options. |
| workflow-dag | `e40d60f^ (c7ae2ce)` | ui.displayName ("Workflow & DAG Engine"); ui.category ("automation"); ui.summary; globalTables (wf_step_logs) | Dropped unread settings [maxExecutionSeconds, concurrencyLimit] because src/routes.ts does not read them; Added ui.summary from brick implementation and PROGRESS.json metadata | PASS (0 violations) | Manifest accurately describes @poc/workflow-dag routes (/api/workflows, /api/runs), D1 migrations (migrations/0001_workflow_dag.sql), and runtime options. |

## Trust & Isolation Fields (ManifestSchema v2 / UC6.5)

To protect host Workers and isolate untrusted code from ambient credentials and secrets (F-ISO-3 / PROOF.md H3), `ManifestSchema` defines two isolation-related fields:

- **`trust`**: `z.enum(["first-party", "untrusted"]).default("untrusted")`
  - Declares whether the brick's code is first-party or untrusted.
  - Defaults to `"untrusted"`. If a manifest omits `trust`, it fails closed because untrusted code cannot run with `isolation: "none"`.
  - All shipped platform bricks declare `"trust": "first-party"`.

- **`isolation`**: `z.enum(["none", "dispatch"]).default("none")`
  - Declares the isolation mode used by the assembler and runtime.
  - `"none"`: Brick runs in the host isolate (allowed only for `first-party` bricks).
  - `"dispatch"`: Brick runs in a separate isolated Worker via dynamic dispatch without host secrets/bindings.
  - In `ManifestSchema.superRefine`, `"trust": "untrusted"` requires `isolation: "dispatch"`.
  - In `assemble()`, untrusted bricks without `isolation: "dispatch"` are refused with `brick "<id>" is untrusted and must run isolated (set isolation: "dispatch")`. Until UC6.7 lands, `isolation: "dispatch"` bricks are refused with `brick "<id>": per-brick isolation is not yet available`.

## Secret Declarations (story 1.19)

A brick's `secrets` lists what its Worker reads from its environment. Each entry is either a name (`"PX_CONN_KEY"`) or an
object:

```json
"secrets": [
  { "name": "BETTER_AUTH_SECRET", "generate": "random-32-bytes" },
  { "name": "GITHUB_CLIENT_ID", "optional": true },
  { "name": "GITHUB_CLIENT_SECRET", "optional": true }
]
```

- **A name, or `{ "name" }` alone**: required. Readiness reports `UNBOUND_BRICK_SECRET` until it is bound, and a deploy without
  a value is refused with `MISSING_REQUIRED_SECRETS`. The owner provides the value in Studio (Connections/secrets); an MCP
  token can never set or read one.
- **`"optional": true`**: the brick runs without it (core-auth configures GitHub sign-in only when both GitHub credentials are
  present). It never blocks readiness, the deploy plan's secret requirements, or a deploy.
- **`"generate": "random-32-bytes"`**: internal to the brick, so the platform can make the value. Studio generates it on an
  approved preview deploy (32 random bytes, sealed in the vault, bound, reused by every later deploy). Production never
  generates one. Only a secret the brick itself owns may be `generate`; a third-party credential never is.
- A secret is `optional` or `generate`, never both (`ManifestSchema` refuses it). `secretDeclarations()` and `secretNames()` in
  `@poc/assembler` read either form.

## Semantic Versioning and Capability Ranges (UC8.2)

To prevent breaking changes from slipping unnoticed into redeploys and enforce compatibility between interacting bricks (F-DEP-1), manifests and the assembler enforce semantic versioning across bricks and capabilities.

### 1. Brick Versioning & Baseline
- **Version format**: `ManifestSchema.version` and `BrickManifestSchema.version` enforce exact 3-component semver `^\d+\.\d+\.\d+$` (e.g. `1.0.0`, `0.1.0`). Incomplete or invalid versions like `1.2` or `1.0.0-beta` are rejected at schema validation.
- **Baseline tiers**:
  - `production` and `beta` bricks: baseline `1.0.0`.
  - `experimental` bricks (`scripting-sandbox`, `workflow-dag`): baseline `0.1.0`.
- **Zero version prohibited**: `check-manifests.ts` and `catalog:conformance` refuse `0.0.0` for all bricks.
- **Package synchronization**: `package.json` `version` must match `brick.manifest.json` `version`.
- **Changelog enforcement**: Each brick repository contains a `CHANGELOG.md` documenting releases (starting with `1.0.0 — initial versioned release` or `0.1.0 — initial versioned release`). `catalog:conformance` fails if `CHANGELOG.md` is missing or fails to mention the current manifest version.

### 2. Versioned Capabilities (`provides` & `requires`)
- **`provides`**:
  - Bare name `"cap"` implicitly provides `"cap@<brick.version>"`.
  - Explicit capability `"cap@x.y.z"` provides capability `cap` at version `x.y.z`.
- **`requires`**:
  - Bare name `"cap"` implies wildcard range `"cap@*"` (any version acceptable).
  - Versioned range `"cap@<range>"` specifies semver constraints:
    - Caret (`^1.0.0`): compatible within same major (or minor for 0.x.y).
    - Tilde (`~1.2.0`): compatible within same minor.
    - Comparison operators (`>=1.0.0`, `<2.0.0`).
    - Exact match (`1.0.0` or `=1.0.0`).
    - Wildcard (`*`).

### 3. Assembler Range Enforcement & Lock Comparison
- **Dependency & Range Validation**:
  - Step 2 checks that provider capability versions satisfy all consumer `requires` constraints.
  - If a mismatch occurs, assembly is refused: `brick "<consumer>" requires capability "<cap>@<range>" but provider "<provider>" offers "<cap>@<version>"`.
- **Upgrade and Downgrade Safety (`previousLock`)**:
  - When assembling with `opts.previousLock` from the previous deployment:
    - **Same version**: allowed.
    - **Patch / Minor upgrade**: allowed automatically.
    - **Major upgrade** (e.g. `1.0.0` -> `2.0.0`): refused with `UPGRADE_MAJOR_REQUIRES_ACK: brick "<id>" major upgrade from <old> to <new> requires explicit acknowledgement` unless acknowledged via `opts.acknowledgeUpgrades: ["<id>@<major>"]`.
    - **Downgrade** (e.g. `1.1.0` -> `1.0.0`): refused with `brick "<id>" downgrade from <old> to <new> is refused`.
- **Emitted `project.json` Lock**:
  - Contains `bricks: { [id]: { version, capabilities: { [cap]: version } } }`.
  - Contains top-level `capabilities: { [cap]: { provider: brickId, version } }` recording resolved capability versions next to brick versions.

### 4. Setting Lifecycle & Upgrade Re-Validation (UC8.3 / F-DEP-1)
- **Setting Metadata**:
  - `settingDefinition` supports lifecycle fields across all types (`integer`, `enum`, `boolean`):
    - `since`: SemVer string (e.g. `"1.1.0"`) denoting when the setting was introduced.
    - `deprecated`: Object with `{ since, replacedBy?, removeIn? }` denoting when the setting was deprecated, recommended replacement, and planned removal version.
  - `ManifestSchema.superRefine` rejects any brick manifest whose setting `since` or `deprecated.since` is greater than the brick's current `version`.
- **Re-Validation on Upgrade (`checkSettingsUpgrade`)**:
  - Executed whenever `assemble()` is called with a `previousLock` (and surfaced during deployment planning):
    - **Narrowed settings**: If a setting's constraints are tightened (e.g. integer range 0..1000 narrowed to 0..400) and the saved value violates the new constraint, an error is raised (`setting <brick>.<setting>=<val> is outside <min>..<max> in <version>`).
    - **Deprecated settings**: Emits structured warnings with migration guidance when a project configures a deprecated setting (`setting <brick>.<setting> is deprecated since <since>; migrate to <replacedBy>`).
    - **Added settings**: New settings defined in the manifest that were not present in the saved configuration take their defaults and are returned in `added: [{ brick, setting, default, since }]`.
    - **Removed settings (AC2)**: If a setting was removed from the manifest and its saved value differs from the previous default, deployment is blocked with an error. If the saved value matched the default, it is silently dropped without error.


## Tenant Queries & Isolation (UC6.3)

To prevent cross-tenant data leaks and enforce strict multi-tenant boundary compliance (F-ISO-1), `pnpm lint:tenant` scans every brick in `bricks/*/src/**/*.ts` using the TypeScript compiler AST:

### 1. The Tenant Query Rule
- Any table defined in a brick migration that has a `workspace_id` column is treated as a **tenant table**, unless explicitly declared in the brick's `brick.manifest.json` under `globalTables` with a non-empty audit `reason`.
- Every SQL string in brick source code (`bricks/*/src/**/*.ts`: string and template literals, `+` concatenations of them, and any call argument that contains `SELECT` or `FROM`) that touches a tenant table must bind that table to a workspace (AD-V2, story 0.7). For a SELECT, UPDATE or DELETE, the WHERE or JOIN ... ON clause of the query level that names the table must compare that table's `workspace_id` (bare or alias-qualified) to a bound value (`= ?`, `= ?1`, `= :name`, `IN (?, ...)` or a `${...}` substitution), joined to the rest by AND. A top-level OR needs the predicate on every side; `IS NULL` / `IS NOT NULL` never counts; a join equality `a.workspace_id = b.workspace_id` counts only when the other table is itself bound to a value; a predicate inside a sub-select does not cover the outer query. An INSERT needs `workspace_id` in its column list. This applies to `db.prepare(...)`, `scoped(...).raw(...)`, `global(...).raw(...)` and `systemScope(...).raw(...)` alike.
- `global(db, table, reason)` and `systemScope(db, reason)` calls on a tenant table (`select`, `first`, `update`, `delete`, `insert`) are checked too, including handles kept in a variable, a class field (`this.sys = systemScope(...)`) or a parameter typed `SystemScopeDb`: a reason makes the bypass explicit, it does not make it safe. A `global()` call whose table is not a string literal cannot be checked and is a violation unless exempted.
- `scoped(db, workspaceId)` remains the preferred way to query a tenant table: it injects and validates `workspace_id = ?` on every CRUD query.

### 2. Global Tables & Cross-Tenant Access
- Tables legitimately accessed across tenants without workspace context (e.g. edge custom domain routing, OAuth token introspection) must be declared in `brick.manifest.json` under `globalTables`:
  ```json
  "globalTables": [
    {
      "table": "dom_domains",
      "reason": "Global hostname resolution at Cloudflare edge worker"
    }
  ]
  ```
- Cross-tenant system operations (e.g. background alarm runners, platform-wide audit sweeps) must use `systemScope(db, reason)` from `@poc/sdk`, which requires an explicit, audited reason string.

### 3. Exemptions
- A query that must reach across tenants (e.g. a lookup by an unguessable token or public id that happens before any workspace is known) is exempted only by name, with a non-empty reason, in one of two ways:
  1. an entry `{ "file": "bricks/<id>/src/<file>.ts", "table": "<table>", "reason": "..." }` in `scripts/tenant-lint-allowlist.json`, which covers that table in that file; or
  2. a `// tenant-lint: allow <reason>` comment directly above the query (or above the statement or array element that holds it). A comment with no reason is itself a violation.
- `globalTables` declarations were re-reviewed in story 0.7: only tables that are all-tenant by design keep the declaration, each with its reason.
- The tenant query linter is integrated directly into `pnpm catalog:conformance`, ensuring that any unscoped tenant query fails CI.

## Migration Linter & Expand/Contract Safety Gates (UC8.4)

To prevent breaking database changes and accidental data loss during deployments (F-DEP-2 / PROOF.md H8), all D1 SQL migrations across the platform (brick manifests, runtime deployment, and assembler entity migrations) are statically analyzed and classified by `packages/deploy/src/migration-lint.ts` before execution.

### 1. Migration Classifications
Migrations are classified into one of three structural categories:
- **`additive`**: Safe, backward-compatible additions that can run online without disrupting existing worker isolates.
  - `CREATE TABLE [IF NOT EXISTS] ...`
  - `CREATE [UNIQUE] INDEX [IF NOT EXISTS] ...`
  - `ALTER TABLE ... ADD COLUMN ...` (nullable or declaring a `DEFAULT` value)
  - `CREATE VIEW [IF NOT EXISTS] ...`
- **`rewrite`**: Non-destructive table transformations and data migrations that preserve existing columns and tables.
  - The SQLite table rebuild pattern: creating a staging table (`CREATE TABLE new ...`), copying data (`INSERT INTO new SELECT ...`), dropping the original table, and renaming the staging table (`ALTER TABLE new RENAME TO old`).
  - Data backfills (`UPDATE ... WHERE ...`).
  - `INSERT INTO ... VALUES ...`
- **`destructive`**: Hazardous operations that remove tables or columns, narrow column data types, or enforce non-null constraints on existing rows.
  - `DROP TABLE ...` (outside of a matched table rebuild pattern)
  - `DROP COLUMN ...` / `ALTER TABLE ... DROP COLUMN ...`
  - `ALTER TABLE ... RENAME TO ...` (outside of a matched table rebuild pattern)
  - `ALTER TABLE ... ADD COLUMN ... NOT NULL` without a default value
  - Column type narrowing (e.g. changing `TEXT` to `INTEGER`)
  - Unbounded deletions (`DELETE FROM ...` without a `WHERE` clause)
  - `TRUNCATE TABLE ...`

### 2. Expand/Contract Migration Header
Destructive migrations are strictly blocked by default during deployment and CI checks. A destructive migration is permitted if and only if:
1. It includes a structured contract header on the first non-empty line of the migration file:
   ```sql
   -- projectx: phase=contract expands=<prior_migration_name>
   ```
2. The corresponding `<prior_migration_name>` expand migration has already been applied and recorded in `_projectx_migrations` on the target database in a previous deployment.

Alternatively, CLI operators may pass `--allow-destructive` for explicit out-of-band administrative operations, which records an `allow_destructive` entry into the deployment audit ledger.

### 3. Integrated Enforcement Points
The unified linter (`lintMigration`) is enforced across three primary boundaries:
- **Deployment Provisioner (`packages/deploy/src/provisioner/deploy.ts`)**: Lints all pending migrations prior to running any database write calls (`isWriteCall`), rejecting unapproved destructive migrations with `MIGRATION_DESTRUCTIVE_BLOCKED`.
- **Brick Manifest Conformance (`scripts/check-manifests.ts`)**: Lints all migrations under `bricks/*/migrations/*.sql` during `pnpm catalog:conformance`. Any unapproved destructive migration in a brick package fails conformance checks.
- **Assembler (`packages/assembler/src/assemble.ts`)**: Lints generated entity migrations to guarantee that dynamic entity migrations remain safe and additive.

## Mandatory Privacy & GDPR Coverage (UC9.2)

To guarantee that no tenant data escapes GDPR Article 17 erasure or Article 20 export (F-OPS-2), the platform enforces declarative privacy rules across all brick manifests and generated projects.

### 1. Manifest Contract (`privacy`)
Every brick manifest defining tenant migrations must declare `privacy: { tables: Record<string, PrivacyTableDefinition> }`:
- `subject`: `"workspace" | "user"`
- `userColumn`: string (identifies user column for user queries)
- `erase`: `"delete" | "anonymize" | "retain"`
- `retainReason`: string (required when `erase: "retain"`)
- `export`: boolean (included in Article 20 export archives)

Optional code hooks may be declared under `worker.privacy`:
- `exportTenant`: `(db: ScopedDb, subject: { workspaceId: string; userId?: string }) => Promise<Record<string, unknown>>`
- `eraseTenant`: `(db: ScopedDb, subject: { workspaceId: string; userId?: string }) => Promise<{ deletedCount: number; retain: Array<{ table: string; reason?: string }> }>`

### 2. Static Conformance & Assembly Rules
- **Catalog Conformance (`pnpm catalog:conformance`)**: Inspects every migration of every brick. Any created table with a `workspace_id` column that is not listed in `manifest.privacy.tables` (or `manifest.privacy.hookTables`) fails conformance with `table "<table>" has workspace_id but no privacy rule in manifest.privacy.tables`.
- **Assembler Rule (`assemble()`)**: Validates that all tenant tables from chosen bricks and declared entity tables are covered by privacy rules. If any table is omitted, assembly fails naming the table.
- **Generated Code (`src/privacy.generated.ts`)**: Emits `exportTenant` and `eraseTenant` functions iterating covered tables in reverse topological dependency order using `scoped()`, executing bulk deletions in atomic `db.batch()` batches per workspace, and invoking code hooks.
- **REST Endpoints (`data-privacy-gdpr`)**: Wires `/api/privacy/erasure` and `/api/privacy/export` to the generated functions, and introduces `DELETE /api/privacy/workspace` for owner-only tenant workspace offboarding.
