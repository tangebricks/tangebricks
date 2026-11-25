# Threat model

## Scope and date

- **Date:** 2026-11-21.
- **Commit:** `09ee12f` (`09ee12f4ad09f09f3be32b027f13c3931daa02d4`, merge of PR #1 into `main`).
- **What this covers:** the whole repo as a multi-tenant platform: the studio (web and API), generated apps and their bricks, the deploy Worker, the MCP endpoint, and CI.
- **Sources:** the truth audit's ranked risks 1–24 and its added risks R-A..R-G, plus a fresh security read of nine areas the audit never read (see [Sweep scope and method](#sweep-scope-and-method)).
- **Citations:** `path:line` exactly as the audit and the sweep give them. Audit citations were taken at commit `1838e18`, before a history rewrite, so line numbers may have moved a little. Sweep citations were taken at this commit. In the new-findings table, a bare file name in an A or B row (for example `routes.ts:83`) is relative to that row's brick (`bricks/<area>/src/`). Paths outside the brick are written in full. Every studio-web (C) row is written in full from the repo root (`apps/studio-web/src/...`).
- **Related:** [`security-model.md`](security-model.md) describes the integration runtime's egress and fetcher rules. This document does not repeat it.
- **What this is not:** a list of exploits. Each item names the class of flaw and its impact, not the steps.

### Stories referenced

| Ref | Title |
|---|---|
| 0.1 | Merge to main, CI green |
| 0.2 | Licence, SECURITY.md, scanners |
| 0.4 | Verified workspace context (AD-V1) |
| 0.5 | Cross-tenant attack suite on real sub-routes |
| 0.6 | Authorise every admin and mutating route |
| 0.7 | Workspace-scoped unique keys; WHERE-parsing tenant lint |
| 0.8 | No fallback secrets; SSRF guards |
| 0.9 | No fake success; remove checkout bypass |
| 0.10 | Control-plane isolation and scoped MCP tokens |
| 0.11 | Quarantine unsafe and stub bricks |
| 0.12 | Honest README and evidence integrity |
| 0.14 | Auth session hardening (cookies, JWT exp, CSRF, CORS) |
| 0.19 | rbac-policy: no grant escalation (filed from PROPOSED-5) |
| 0.20 | cron-alarms: allowlist of target Workflow bindings (filed from PROPOSED-10) |
| 0.21 | Rate limiting on auth, money and fan-out paths (filed from PROPOSED-1) |
| 1.1 | Real executors and verified workspace in deployed workflows |
| 1.2 | One real deploy path for Studio and MCP |
| 1.4 | Workspace-keyed telemetry and logs |
| 1.5 | Proposals by default; approval for destructive tools |
| 1.9 | Metering correctness: no negative values, atomic aggregation (filed from PROPOSED-2) |
| 1.10 | Workspace delete cascade and suspension enforcement (filed from PROPOSED-3) |
| 1.11 | API-key authentication: keys are a workspace-bound identity with a role ceiling (filed from PROPOSED-4) |
| 1.12 | feature-flags: honour allowOverrides on clear (filed from PROPOSED-6) |

`PROPOSED-n` ids are new tickets defined in [Proposed tickets](#proposed-tickets). They are not filed yet.

## Actors

| Actor | What they can do today | Trust |
|---|---|---|
| Anonymous internet user | Reach any public route, sign up, call routes that have no auth | None |
| Signed-in user of any workspace | Create their own workspace and own it; call every brick route behind the workspace middleware | Authenticated, not authorised for anyone else's data |
| Workspace member / admin / owner | Act inside one workspace; role decides which actions should be allowed | Trusted only inside their workspace and role |
| MCP agent with the shared bearer | Call all MCP tools on any project; author comes from unverified headers | One shared secret for everyone |
| Operator | Holds Cloudflare accounts, env secrets, deploy tokens, CI | Fully trusted |
| Compromised dependency | Runs code at build or run time inside any Worker or CI job | Untrusted, but runs with full rights |

## Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Tenant data | Brick tables in D1, R2 objects, studio project tables | Core promise: tenant A never sees or changes tenant B |
| Credentials and vault | Connection vault, studio secrets vault, integration connections, SSO secrets, channel config | Third-party access in the tenant's name |
| Money | Credit wallet, marketplace payouts, subscription plans, checkout sessions, metering, LLM spend | Direct financial loss to tenants or the operator |
| Signing secrets | Auth signing secret, webhook secrets, vault keys | Forge sessions, decrypt credentials, spoof webhooks |
| Deploy tokens | Cloudflare tokens held by the studio, MCP bearer | Deploy or change code in someone's account |
| Availability | Workers, D1, cron, outbound sends, LLM calls | Outage or runaway cost from abuse |

## Trust boundaries

| Boundary | What crosses it | Main risk classes |
|---|---|---|
| Browser ↔ studio-api | Session cookie, project ops, deploy and secret writes, WebSocket live sync | Role enforced only in the UI; org taken from the body; cookie flags, CSRF, CORS, WebSocket Origin |
| Generated app Worker ↔ bricks | Request with session, workspace header, query and body | Workspace taken from query/body instead of the verified context; missing role checks |
| Brick ↔ D1 / R2 | SQL with workspace filter; R2 keys and public URLs | Global tables and keys without a workspace column; unscoped reads; stored content served publicly |
| Worker ↔ third-party fetch | Outbound webhooks, cron URL fetch, `core.http_request`, OAuth, LLM and payment providers | SSRF; fabricated success when no provider is wired |
| MCP client ↔ MCP endpoint | Tool calls with one shared bearer | No per-project authorisation; fabricated deploy success |
| CI ↔ GitHub | Source, lockfile, Actions | No dependency update or audit step; supply chain |

## Top 10 abuse cases

| # | Actor | Path | Impact | Audit risk ids | Fixing stories |
|---|---|---|---|---|---|
| 1 | Signed-in user of any workspace | Own workspace in the header, victim's workspace in the query or body, on any of 23 bricks | Read and write other tenants' rows; the existing fuzz stays green | 1, 15 | 0.4, 0.5 |
| 2 | Workspace owner or member | Privacy export/erase routes with another workspace or user | Erase or export another tenant's data | 2, 3 | 0.6, 0.4 |
| 3 | Any signed-in user | Admin-console self-registration | Becomes platform super-admin | 4 | 0.6, quarantined (0.11): admin-console |
| 4 | Any signed-in user | `POST /api/flags` writes the global `flag_definitions` table with no role check | Flips kill switches, paid gates and rollouts for every tenant | none (sweep B1) | 0.6 |
| 5 | Signed-in user of any workspace | Reuse another tenant's wallet idempotency key; parallel payout requests | Free charges, balance disclosure, double-spent payouts | 5, 6 | 0.7, quarantined (0.11): marketplace-splits |
| 6 | Anyone with a session id, or any member | Mark a checkout session paid; overwrite plan prices or switch plans | Paid features and invoices without payment | 7, 14 | 0.9, 0.6 |
| 7 | Holder of the shared MCP bearer | MCP endpoint, any project | Read and change every project; deploy in others' names | R-E, 11 | 0.10 |
| 8 | Anyone who reads the source | Env secret missing, so code falls back to a constant in source | Forge auth sessions; decrypt vault and connection credentials | 10, R-A | 0.8 |
| 9 | Workspace member | Tenant-supplied URL in outbound webhooks, cron or `core.http_request` | Server fetches internal addresses and stores the reply | 12, R-D | 0.8 |
| 10 | Any signed-in member (the webhook and SSO routes need no sign-in at all) | Unauthenticated webhook-subscription and SSO-connection routes; OAuth-server code issuance for any user named in the request body | Attacker-chosen webhook secrets, hijacked SSO, OAuth codes issued for other users | 8, 9, 13 | 0.6 (+ quarantined (0.11): oauth-server) |

## Audit risks table

Every audit risk appears once.

| Id | Sev | One line | Fixing story |
|---|---|---|---|
| 1 | Critical | Workspace from query/body overrides the header in 23 bricks: cross-tenant read and write | 0.4 (+0.5 proves) |
| 2 | Critical | Workspace owner can erase another workspace's data across every brick table | 0.6 (+0.4) |
| 3 | Critical | Any member can export or erase any user's data in any workspace | 0.6 (+0.4) |
| 4 | Critical | Anyone can make themselves platform super-admin | 0.6, quarantined (0.11): admin-console |
| 5 | Critical | Wallet idempotency keys shared across tenants | 0.7 |
| 6 | Critical | Marketplace payouts double-spend and cross-workspace vendor | quarantined (0.11): marketplace-splits |
| 7 | High | Anyone with a checkout session id can mark it paid | 0.9 |
| 8 | High | Unauthenticated webhook subscription create with caller-chosen secret | 0.6 |
| 9 | High | Unauthenticated SSO connection create/overwrite; secrets in clear | 0.6 |
| 10 | High | Auth signing secret and vault keys fall back to source constants | 0.8 |
| 11 | High | Studio entity tables in one shared database, read with no org filter | 0.10 |
| 12 | High | Outbound webhooks and cron fetch any tenant URL (SSRF) | 0.8 |
| 13 | High | OAuth server issues codes for any user named in the body | 0.6 (+ quarantined (0.11): oauth-server) |
| 14 | High | Plan prices writable unauthenticated; plan switch without payment | 0.6, 0.9 |
| 15 | High | Cross-tenant fuzz never tries header A + query B | 0.5 |
| 16 | Medium | Metering accepts negative values, races on aggregation, global idempotency | 0.7 (keys only); 1.9 (negative values, aggregation race) |
| 17 | Medium | Non-secure cookies, unhashed session tokens, no CSRF/CORS policy | 0.14 |
| 18 | Medium | No rate limiting on login, signup, wallet or webhooks | 0.21 |
| 19 | Medium | JWTs without `exp` accepted | 0.14 |
| 20 | Medium | `poc_graphs` and telemetry have no tenant dimension | 0.10 (`poc_graphs`), 1.4 (telemetry) |
| 21 | Medium | Unauthenticated notification create; spoofable audit actor | 0.6 |
| 22 | Medium | Workspace delete leaves other bricks' rows; suspension never enforced | 1.10 |
| 23 | Low | No Dependabot/Renovate, no audit step in CI | 0.2 |
| 24 | Low | API keys issued but nothing authenticates with them | 1.11 |
| R-A | Critical | Connection-vault key falls back to a source constant (`runtime/src/connections.ts:4`) | 0.8 |
| R-B | High | Placeholder executors and fabricated HTTP 200 make workflows "succeed" | 0.9 |
| R-C | High | Runtime workspace defaults to `ws_default`; `core.batch` takes workspace from payload | 1.1 (+0.4) |
| R-D | High | Unrestricted `fetch` in `core.http_request` (SSRF) | 0.8 |
| R-E | Critical | MCP endpoint guarded by one shared bearer, no per-project authorisation (`mcp.ts:84-141`) | 0.10 |
| R-F | High | `deploy_apply` reports fabricated deploy success | 0.9 |
| R-G | High | Studio deploy and token verification are mocks shown as working | 1.2 |

## Sweep scope and method

The audit left nine areas unread: studio-web, gateway-adapters, integration-connections, llm-gateway, binary-assets, omnichannel-outbound, feature-flags, rbac-policy and cron-alarms. Three readers covered them at this commit:

- **Sweep A:** integration-connections, llm-gateway, binary-assets, `packages/gateway-adapters`.
- **Sweep B:** omnichannel-outbound, feature-flags, rbac-policy, cron-alarms.
- **Sweep C:** `apps/studio-web/src` (client only; it lists what the server must check).

Each reader checked six classes and recorded anything else as NEW:

- (a) workspace taken from query or body
- (b) fallback secrets
- (c) SSRF
- (d) missing role check
- (e) fabricated success
- (f) no rate limit

Context that limits impact: the seven brick areas (integration-connections, llm-gateway, binary-assets, omnichannel-outbound, feature-flags, rbac-policy, cron-alarms) are mounted behind the workspace middleware in the generated app (`out/max-compatible/src/index.ts:299-301,340-343,349-351` and `:312-393`); Sweep B describes that middleware as checking membership plus the member's DB role. Their queries go through `scoped()`. `packages/gateway-adapters` is a package that nothing imports, so it serves no routes. Studio-web is the frontend; Sweep C lists what its server must check. No new cross-tenant read path was found beyond the inherited class (a), except the feature-flags global table. Any signed-in user can create and own a workspace (`bricks/multi-workspace/src/routes.ts:48`), so "any member" below effectively means "anyone with an account".

Found clean: connection lists never return sealed credentials; AES-GCM with workspace AAD; single-use expiring OAuth state; PKCE S256; LLM templates and usage scoped; asset metadata/download/delete scoped with random R2 keys; flag overrides scoped; RBAC routes all have `requirePermission` and `can()` fails closed; outbound and cron lookups scoped; cron runner uses stored workspace and CAS claims. Studio-web has no `innerHTML`/`eval`, no tokens in storage or URLs, no open redirects.

## New findings table

Every sweep finding appears once. Locations are as the sweep gives them (see [Citations](#scope-and-date)).

| # | Area | Sev | Finding | Location | Covered by |
|---|---|---|---|---|---|
| A1 | llm-gateway | High | `/ai/generate` never debits the wallet (only logs cost); `/api/ai` not behind `requireNotSuspended`, so generation is unlimited at operator cost once a real provider is connected | `bricks/llm-gateway/src/gateway.ts:226-245`; `out/max-compatible/src/index.ts:349-351` | PROPOSED-7 (wallet debit); 1.10 (`requireNotSuspended` on `/api/ai`) |
| A2 | llm-gateway | Medium | Caller picks any model name; cost ignores model | `routes.ts:25`; `gateway.ts:180,227-229` | PROPOSED-7 |
| A3 | llm-gateway | Low | `maxTokens` accepted but not passed to the adapter | `routes.ts:17`; `gateway.ts:208` | PROPOSED-7 |
| A4 | llm-gateway | Low | Raw provider error text returned | `gateway.ts:220`; `routes.ts:66` | PROPOSED-7 |
| A5 | llm-gateway | Medium | Only the mock adapter exists; the app asks for a nonexistent `workers-ai`, giving a 502 or fake text with mock fallback | `gateway.ts:46-66,81`; `out/max-compatible/src/index.ts:351` | 0.9 (scope addition) |
| A6 | llm-gateway | Low | Any member creates prompt templates | `routes.ts:83` | 0.6 (scope addition: `POST /api/ai/templates`) |
| A7 | integration-connections | High | No code exchange as mounted: OAuth callback stores a token made from the caller's code and marks the connection connected | `bricks/integration-connections/src/service.ts:427-438`; `out/max-compatible/src/index.ts:343` | 0.9 (scope addition) |
| A8 | integration-connections | High | `PX_CONN_KEY` unset means credentials are sealed with a source constant key | `crypto.ts:1,39-43` | 0.8 (new instance: `bricks/integration-connections/src/crypto.ts:1`) |
| A9 | integration-connections | Medium | Any member can connect (overwrite) or disconnect the workspace connection | `routes.ts:228-251`; `service.ts:486-501` | 0.6 (scope addition: `GET /api/integrations/:provider/connect`, `GET /api/connect/:provider`, `GET`/`POST /api/integrations/:provider/callback`, `POST /api/integrations/:provider/disconnect`) |
| A10 | integration-connections | Low | Caller-supplied `accountLabel`/`externalAccountId` on callback override the provider's | `routes.ts:131-133`; `service.ts:447-454` | PROPOSED-11 |
| A11 | integration-connections | Low | Caller `redirect_uri` unchecked; GET connect with `redirect=1` has no CSRF guard | `routes.ts:76,81,96`; `service.ts:247-248` | PROPOSED-11 |
| A12 | integration-connections | Low | OAuth state bound to the workspace, not the initiating user | `service.ts:302-337` | PROPOSED-11 |
| A13 | integration-connections | Low | Placeholder client id `px_<slug>_client` when unconfigured | `service.ts:263,376` | 0.9 (scope addition) |
| A14 | binary-assets | Medium | Whole body read before the size check; no Content-Length precheck; no per-workspace quota | `bricks/binary-assets/src/routes.ts:86`; `assets.ts:136` | PROPOSED-8 |
| A15 | binary-assets | Medium (needs `publicBaseUrl`) | Uploader-chosen Content-Type on a public R2 URL allows stored XSS (HTML/SVG) | `assets.ts:128,146,150` | PROPOSED-8 |
| A16 | binary-assets | Low | Raw filename (`/`, `..`, control chars) in R2 key and public URL | `assets.ts:145-146` | PROPOSED-8 |
| A17 | binary-assets | Low | Unescaped filename in Content-Disposition; no `nosniff` | `routes.ts:64-70` | PROPOSED-8 |
| A18 | binary-assets | Low | `limit=-1` means unlimited, `offset=Infinity` gives 500; raw DB error echoed | `routes.ts:30-31`; `assets.ts:168,236` | PROPOSED-8 |
| A19 | binary-assets | Low | Any member deletes any asset | `routes.ts:106` | 0.6 (scope addition: `DELETE /api/assets/:id`) |
| A20 | gateway-adapters | Medium (unwired) | Stripe `fetchOrder` looks up the intent by wallet order id and never checks order id, currency or customer: replay risk once wired | `packages/gateway-adapters/src/stripe-payment-gateway.ts:50-71` | PROPOSED-13 |
| A21 | gateway-adapters | Medium | `createOrder` ignores the Stripe response status; an empty session id is recorded as created | `packages/gateway-adapters/src/stripe-payment-gateway.ts:42-47` | 0.9 (scope addition) |
| B1 | feature-flags | Critical | `POST /api/flags` has no role check and writes the global `flag_definitions` table: any signed-in user can change kill switches, paid gates and rollouts for every tenant | `bricks/feature-flags/src/routes.ts:49-71`; `flags.ts:48-55` | 0.6 (scope addition: `POST /api/flags` operator-only, since it writes global definitions) |
| B2 | feature-flags | Medium | Any member (not admin) can set or clear workspace overrides, enabling gated or paid features | `routes.ts:89-120` | 0.6 (scope addition: `POST`/`DELETE /api/flags/:key/override` admin-only) |
| B3 | feature-flags | Low | `clearOverride` ignores `allowOverrides=false` | `flags.ts:141-146` | 1.12 |
| B4 | rbac-policy | High | `roles:assign` holder can assign any role (incl. `*:*`) to anyone, including self; no "cannot grant more than you hold" check | `routes.ts:77-92`; `rbac.ts:121-138` | 0.19 |
| B5 | rbac-policy | High | `roles:write` holder can create a role with `*:*` or `roles:assign`; permission strings unrestricted | `routes.ts:43-67`; `rbac.ts:46-52,199-202` | 0.19 |
| B6 | rbac-policy | Low | `assignRole` does not check the user is a workspace member | `rbac.ts:121-135` | 0.19 |
| B7 | rbac-policy | Low | Raw DB error text returned in 500 body | `rbac.ts:54-56` | 0.19 |
| B8 | omnichannel-outbound | Medium | Any member creates a channel with any sender address and sends to any recipient; no sender ownership or recipient limits (harmless today only because the adapter is a mock) | `routes.ts:38-69,95-125`; `dispatcher.ts:79-101,157-160` | 0.6 (scope addition: role check on `POST /api/messages/channels`, `POST /api/messages/send`) + PROPOSED-9 (sender ownership) |
| B9 | omnichannel-outbound | Medium | Channel config (provider keys) stored as plain JSON and returned to every member | `dispatcher.ts:91-100,140-144`; `routes.ts:85-91,124` | PROPOSED-9 |
| B10 | omnichannel-outbound | Low (latent) | No CR/LF check on subject or recipient: header injection once a real email adapter is used | `dispatcher.ts:157,206-210`; `routes.ts:22-23` | PROPOSED-9 |
| B11 | omnichannel-outbound | Medium | Default mock adapter records "sent"; `executeSendOutboundMessage` returns `dispatched:true` without sending | `dispatcher.ts:44-67`; `routes.ts:55`; `index.ts:4-16` | 0.9 (scope addition) |
| B12 | omnichannel-outbound | Low | `?limit=-1` means unlimited, `Infinity` gives 500 | `routes.ts:77`; `packages/sdk/src/scoped.ts:356-357` | PROPOSED-9 |
| B13 | cron-alarms | Medium | Tenant `targetWorkflowId` used as an env key: can trigger any Worker binding with `.create()` (other bricks' Workflows) on a timer | `cron.ts:347-364`; `routes.ts:20` | 0.20 |
| B14 | cron-alarms | Medium | Missing workflow binding still recorded as success | `cron.ts:355-366` | 0.9 (scope addition) |
| B15 | cron-alarms | High | Fetches tenant URL via `globalThis.fetch` and stores status and error text in history (known, audit 12) | `cron.ts:106,368-385,388-389` | 0.8 |
| B16 | cron-alarms | Low | Catch-up "all" fires up to 100 times per tick | `routes.ts:24`; `cron.ts:520` | 0.21 |
| B17 | cron-alarms | Medium | Any member can create, toggle or delete any schedule in the workspace | `routes.ts:45,90,114` | 0.6 (scope addition: `POST /api/schedules`, `PATCH /api/schedules/:id`, `DELETE /api/schedules/:id`) |
| C1 | studio-web | Medium (High if server trusts it) | "viewer" role enforced only in the UI; the server must role-check project ops, revert, import, proposal accept/reject, secrets, connections, environment plan/deploy/promote/rollback, data row writes, sandbox deploy and BYOC promote, retention settings, workflow pin/test-step, run rerun, org project create and Cloudflare tokens | `apps/studio-web/src/components/StudioShell.tsx:164,1240`; `apps/studio-web/src/components/DataBrowserView.tsx:291`; `apps/studio-web/src/components/ProposalReviewBar.tsx:240`; `apps/studio-web/src/components/HistoryAndLedgerView.tsx:741,1024`; `apps/studio-web/src/components/ConnectionsView.tsx:539` | 0.10 (scope addition: server-side role from project) + 0.5 (test cases) |
| C2 | studio-web | Medium | Displayed role comes from the active org while `?project=` matches across all the user's orgs: an owner in org A gets edit UI on org B projects where they are a viewer; server must derive org and role from the project | `apps/studio-web/src/App.tsx:56-69`; `apps/studio-web/src/components/StudioShell.tsx:161-170` | 0.10 (scope addition: org and role from project) + 0.5 (test cases) |
| C3 | studio-web | Medium | Some calls send `orgId` in the body (BYOC promote, data row writes); server must not use it for authorisation or tenancy | `apps/studio-web/src/components/StudioShell.tsx:1249`; `apps/studio-web/src/api.ts:2259` | 0.10 (scope addition: ignore body orgId) + 0.5 (test cases) |
| C4 | studio-web | Low | Move-to-BYOC dialog pre-filled with a hard-coded fake Cloudflare token and account id in the production bundle | `apps/studio-web/src/components/StudioShell.tsx:141-146` | PROPOSED-12 |
| C5 | studio-web | Low | Whole store exposed on `window.__STUDIO_STORE__`; bootstrap from `window.__STUDIO_BOOTSTRAP__` in production | `apps/studio-web/src/App.tsx:29-31` | PROPOSED-12 |
| C6 | studio-web | Low | `?benchmark=200` loads a fake owner session in the production build | `apps/studio-web/src/App.tsx:35-44` | PROPOSED-12 |
| C7 | studio-web | Low | Server-supplied hrefs used without a scheme check (React blocks `javascript:`) | `apps/studio-web/src/components/ConnectCloudflareModal.tsx:100-102,153,238,402,427` | PROPOSED-12 |
| C8 | studio-web | Low (server check) | Live-sync WebSocket is cookie-auth only; server must check Origin on `/api/projects/:p/ws` | `apps/studio-web/src/useLiveProjectSync.ts:122-128` | 0.14 (scope addition: WebSocket Origin check) |
| D1 | cron-alarms, document-parsing, scripting-sandbox, webhook-gateway, in-app-notifications | Low | Sub-resource routes answer 200 (an empty list, or success with nothing changed) for another workspace's parent id instead of 404. No data leaks and nothing changes, but the answer does not deny the id. Found by the 0.5 attack suite (ID_GUESS), not by the sweep | `GET /api/schedules/:id/history`, `GET /api/docs/:id/chunks`, `GET /api/docs/:id/extractions`, `GET /api/scripts/:id/executions`, `GET /api/webhooks/endpoints/:id/deliveries`, `PATCH /api/notifications/:id/read`, `DELETE /api/notifications/:id` (`packages/assembler/test/attack-suite.known-failures.json`) | PROPOSED-14 |

## Proposed tickets

These are not filed. A human should file each one; the PR for this story lists them.

| Id | Title | Covers | Suggested phase |
|---|---|---|---|
| PROPOSED-1 | Rate limiting on auth, money and fan-out paths (wire edge-traffic-armor) | Audit 18; B16 | Phase 0 (filed as 0.21) |
| PROPOSED-2 | Metering correctness: reject negative values, atomic aggregation | Audit 16 (negative values, aggregation race) | Phase 1 (filed as 1.9) |
| PROPOSED-3 | Workspace delete cascade and suspension enforcement (mount `requireNotSuspended` on every brick route, including `/api/ai`) | Audit 22; A1 (suspension part) | Phase 1 (filed as 1.10) |
| PROPOSED-4 | API-key authentication, or remove key issuance | Audit 24 | Phase 1 (filed as 1.11) |
| PROPOSED-5 | rbac-policy: block grant escalation, restrict permission strings, member check, no raw DB errors | B4, B5, B6, B7 | Phase 0 (filed as 0.19) |
| PROPOSED-6 | feature-flags: honour `allowOverrides` on clear | B3 | Phase 1 (filed as 1.12) |
| PROPOSED-7 | llm-gateway: debit wallet, model allowlist and per-model cost, pass `maxTokens`, redact provider errors | A1 (wallet debit; suspension is 1.10), A2, A3, A4 | Phase 1 (before any real provider is connected) |
| PROPOSED-8 | binary-assets upload hardening: size precheck and quota, safe Content-Type, filename sanitising, `nosniff`, bounded paging | A14, A15, A16, A17, A18 | Phase 1 |
| PROPOSED-9 | omnichannel-outbound: sender ownership and recipient limits, encrypt and redact channel secrets, CR/LF validation, bounded paging | B8 (sender ownership), B9, B10, B12 | Phase 1 (before any real adapter) |
| PROPOSED-10 | cron-alarms: allowlist of target Workflow bindings | B13 | Phase 0 (filed as 0.20) |
| PROPOSED-11 | integration-connections OAuth hardening: provider data wins, `redirect_uri` allowlist, CSRF on connect, bind state to user | A10, A11, A12 | Phase 1 |
| PROPOSED-12 | studio-web: strip production test hooks and fake values; check href schemes | C4, C5, C6, C7 | Phase 1 |
| PROPOSED-13 | Payment adapter verification (order id, currency, customer) | A20 | Phase 2 |
| PROPOSED-14 | Sub-resource routes answer 200 for another workspace's parent id instead of 404 | D1 | Phase 1 |

## Not covered / open

- **Better Auth 1.7.14 defaults** (hash algorithm, cookie flags, built-in rate limiting) were not read. Story 0.14 should settle them.
- **studio-api `index.ts`** (about 14.5k lines) was only sampled. Sweep C lists what the server must check (C1–C3, C8); those checks still need a server-side read, which 0.10 and 0.5 should do.
- **`packages/runtime/src/egress.ts`** was not read line by line by the audit or the sweep. The audit notes it has real SSRF hardening; story 0.8 should confirm it before reusing it for webhooks, cron and `core.http_request`.
- **Brick-level `use("*")` under `/api`:** whether one brick's middleware runs for other bricks' routes is still open.
- **gateway-adapters** is imported by nothing today, so A20 and A21 are latent until it is wired.
- **The sweep was a read, not a test.** Findings were not reproduced against a running app. Stories 0.5 and 0.6 should turn the class (a) and (d) findings into failing tests first.
- **Recon line numbers** come from commit `1838e18`; check them against this commit before editing.
