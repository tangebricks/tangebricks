# Security Model — Integration Runtime

## Overview

The ProjectX integration runtime executes actions and queries against third-party SaaS APIs (GitHub, Slack, Discord, Stripe, Google, etc.). Because workflow nodes process untrusted user data and outputs from upstream steps, the integration executor enforces strict separation between platform execution parameters and untrusted workflow data.

## Key Principles

1. **Platform-Controlled Manifests & Operations**:
   Only the platform can choose an integration's manifest, operation, path, and egress network function. Workflow data, node configuration, and trigger payloads can never alter or replace them.

2. **No Data-Driven Fetcher Injection**:
   Network fetchers and OAuth token refresh fetchers are **injected strictly via executor options** and platform runtime harnesses:
   - `buildExecutorsFromCatalog(catalog, { integration: { fetcher } })`
   - `createIntegrationOperationExecutor(manifest, operation, { fetcher })`
   - `runGraph(graph, registry, executors, { fetcher, oauthFetcher })`
   - `rehearseStep(req, { registry, executors, fetcher, oauthFetcher })`
   
   Workflow data (`ctx.data.__fetcher`, `ctx.inputs.__fetcher`, etc.) is completely ignored for network dispatch and strictly forbidden.

3. **Reserved Key Enforcement (`INTEGRATION_RESERVED_DATA_KEY`)**:
   Any own property starting with `__` in `ctx.data`, `ctx.inputs`, or `ctx.payload` (including nested `params`, `body`, or `in` structures) causes execution to immediately fail closed before any network I/O:
   ```
   INTEGRATION_RESERVED_DATA_KEY: <key>
   ```

4. **Path Template Immutability**:
   Paths are defined exclusively by the registered operation in the integration manifest. Caller-supplied path overrides (e.g. `__pathOverride`) are rejected. Path parameters declared in the operation are strictly sanitized to prevent directory traversal and host injection.

## Route authorisation (story 0.6)

Workspace admin routes take the caller's role only from the verified context (`ctx.role`): owner or admin for admin actions, owner for data-privacy export/erasure and workspace delete; 401 with no user, 403 for a lower role, checked before the body is read. Writes to all-tenant tables (`POST /api/flags`, `POST /api/meters`, `POST /api/plans`) and `POST /api/admin/super-admins` need a **platform operator**: a user id listed in the comma-separated `PX_PLATFORM_OPERATORS` env var (or, for super-admins, an existing super_admin). With the variable unset nobody is an operator, so these writes are refused (`isPlatformOperator` in `@poc/sdk`).
