# @poc/sdk

Core SDK for ProjectX bricks and integrations on Cloudflare Workers and D1.

## Tenant-scoped queries

Multi-tenant data isolation is enforced at the database query abstraction layer via `scoped()` and `global()`.

### `scoped(db, workspaceId)`

Wraps a `D1Like` database handle with tenant scoping bound to a verified `workspaceId`.

```ts
import { scoped } from "@poc/sdk";

const s = scoped(env.DB, workspaceId);

// 1. SELECT queries automatically include `AND workspace_id = ?`
const jobs = await s.select<JobRow>("job_queues", "status = ?", ["queued"], {
  orderBy: "created_at DESC",
  limit: 50,
});

// 2. Fetch single row scoped to workspace
const job = await s.first<JobRow>("job_queues", "id = ?", [jobId]);

// 3. INSERT automatically injects `workspace_id`
// Throws TENANT_ID_CONFLICT if row carries a differing workspace_id
await s.insert("job_queues", {
  id: "job_123",
  queue_name: "default",
  task_type: "send_email",
  payload_json: "{}",
});

// 4. UPDATE automatically scopes with `AND workspace_id = ?`
// Throws TENANT_ID_CONFLICT if set attempts to alter workspace_id
const updated = await s.update(
  "job_queues",
  { status: "completed" },
  "id = ?",
  [jobId]
);

// 5. DELETE automatically scopes with `AND workspace_id = ?`
await s.delete("job_queues", "id = ?", [jobId]);

// 6. RAW queries require explicit `workspace_id = ?` predicate bound to scoped tenant
// Throws TENANT_PREDICATE_MISSING (naming the table) if omitted or bound to a different tenant
const stmt = s.raw(
  "SELECT * FROM job_queues WHERE id = ? AND workspace_id = ?",
  [jobId, workspaceId]
);
```

### `global(db, table, reason)`

The only sanctioned way to access global non-tenant tables (such as system tables listed in a manifest's `globalTables`). Requires a non-empty `reason` string for auditability.

```ts
import { global } from "@poc/sdk";

const systemSettings = global(env.DB, "sys_settings", "system-configuration-reader");

const setting = await systemSettings.first("key = ?", ["maintenance_mode"]);
```

### Safety Guarantees & Constraints

- **Workspace ID Validation**: Throws `TENANT_ID_INVALID` if `workspaceId` is empty, purely whitespace, or exceeds 200 characters.
- **Identifier Validation**: Table and column names must strictly match `/^[a-z_][a-z0-9_]*$/`. Malformed identifiers throw `INVALID_IDENTIFIER`.
- **Bind Count Limit**: D1 enforces a limit of 100 parameters per statement. Generating a query binding > 100 parameters throws `D1_BIND_LIMIT`.
- **Conflict Prevention**: Inserting or updating rows with a conflicting `workspace_id` throws `TENANT_ID_CONFLICT`.
- **Predicate Enforcement**: `raw()` accepts only a single-table statement with no comments (`--`, `/*`), semicolons, `UNION`, `OR`, `JOIN`, comma-separated `FROM` tables, or nested `SELECT` subqueries, where `workspace_id = ?` is a top-level `AND` term and the scoped tenant ID is bound at that exact placeholder position; otherwise it throws `TENANT_PREDICATE_MISSING` (naming the table).
- **Where Clause Safety**: `select()`, `first()`, `update()`, and `delete()` reject semicolons, comments (`--`, `/*`), `UNION`, subquery `SELECT`s, and unbalanced parentheses in the `where` clause (throwing `WHERE_UNSAFE`).
- **Order By Safety**: `orderBy` is strictly validated against `/^[a-z_][a-z0-9_]*(\s+(ASC|DESC))?(\s*,\s*[a-z_][a-z0-9_]*(\s+(ASC|DESC))?)*$/i` (throwing `ORDER_BY_UNSAFE`).
- **Runtime Immutability**: `scoped().workspaceId` is backed by a private `#field` and the `ScopedDb` instance is frozen (`Object.freeze`), preventing runtime tampering.

## Rate limiting (`rateLimit`)

`rateLimit(rule)` is a Hono middleware backed by a D1 fixed window in the `px_rate_limits` table (story 0.21). A rule
is `{ bucket, limit, windowSeconds, key, failClosed? }`; `key` is `ip` (`cf-connecting-ip`, then the first
`x-forwarded-for`), `workspace` (the verified workspace, else the IP), `field:<name>` (a JSON body field, lower-cased
and trimmed, read from a clone of the request; else the IP) or `param:<name>` (a route param). The stored key is
`<bucket>:<sha256(value)>`, so no raw IP or email is kept. Over the limit the answer is 429
`{ code: "RATE_LIMITED", retryAfter }` with `Retry-After` and `RateLimit-*` headers.

Bricks do not mount it themselves: a brick lists its sensitive routes in its manifest's `rateLimits`, and the assembler
mounts the limiter on them (after the brick's guards, before its routes) and emits the `px_rate_limits` migration.

- **Fail closed:** when the limiter cannot count (no database, missing table, D1 error), a rule with
  `failClosed: true` answers 503 `RATE_LIMIT_UNAVAILABLE`; any other rule logs the error and lets the request through.
  Auth rules (core-auth and studio-api login, signup and password reset) always fail closed.
- **`PX_RATE_LIMITS`:** an operator changes a bucket's numbers with this env var, read on every request, for example
  `PX_RATE_LIMITS='{"auth-login-account":{"limit":5,"windowSeconds":600}}'`. Numbers can go up or down but a rule
  cannot be switched off (`limit` must be at least 1). Invalid JSON is ignored and logged.

## Platform Limits and Static Budget Checks (`checkGraphBudget`)

Workflows and blueprints are validated statically against Cloudflare platform limits before deploy, preventing opaque runtime failures.

### Platform Limits Table

| Resource Dimension | Free Plan Limit | Paid Plan Limit | Source / Rationale |
|--------------------|-----------------|-----------------|-------------------|
| Workflow Steps (`steps`) | 1,024 steps | 4,096 steps | [Cloudflare Workflows Limits](https://developers.cloudflare.com/workflows/platform/limits/) |
| Subrequests per Invocation (`subrequests`) | 50 subrequests | 1,000 subrequests | [Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests) |
| Output Port Fan-out (`fanout`) | 256 connections | 256 connections | Default fan-out threshold per output port (`DEFAULT_FANOUT_LIMIT`) |
| D1 Bind Parameters (`d1BindParams`) | 100 parameters | 100 parameters | [Cloudflare D1 Limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 Max Statement Size (`d1MaxStatementBytes`) | 1,000,000 bytes | 1,000,000 bytes | Cloudflare D1 documented statement limit |
| D1 Max Row Size (`d1MaxRowBytes`) | 2,097,152 bytes | 2,097,152 bytes | Cloudflare D1 documented row size limit |
| Step Return Bytes (`stepReturnBytes`) | 1,048,576 bytes (1MB) | 1,048,576 bytes (1MB) | Workflows step return serialization ceiling |
| Event Payload Bytes (`eventPayloadBytes`) | 1,048,576 bytes (1MB) | 1,048,576 bytes (1MB) | Workflows event payload ceiling |
| Step Retries (`retries`) | 5 retries | 5 retries | Workflows retry policy ceiling |

### Assembly-Time Checks

1. **Step Budget (`BUDGET_STEPS_EXCEEDED`)**:
   - Computes total steps = nodes reachable from the trigger + 1 load step.
   - Refuses graphs exceeding 1,024 steps on `free` (or 4,096 steps on `paid`).
   - Remediation: reduce step count, split workflows, or upgrade to paid.

2. **Subrequest Budget (`BUDGET_SUBREQUESTS_EXCEEDED`)**:
   - Calculates estimated subrequests across integration nodes as `(pagination ? maxPages : 1) * (retryLimit + 1)`.
   - Recognizes `core.batch` and counts its subrequests as 1 per chunk enqueue.
   - Refuses graphs exceeding 50 subrequests on `free` (or 1,000 on `paid`), naming the offending node.
   - Remediation: move bulk operations to a Batch node (`core.batch`, UC7.5), reduce pagination pages, or upgrade plan.

3. **Output Port Fan-out (`BUDGET_FANOUT_EXCEEDED`)**:
   - Checks outgoing edge count per node output port.
   - Refuses ports feeding > 256 target nodes.
   - Remediation: reduce fan-out or distribute parallel sends across batch stages.

4. **D1 Entity Bind Parameters (`D1_BIND_PARAMS_EXCEEDED`)**:
   - `parseEntities` validates that declared entity fields + 4 system columns (`id`, `workspace_id`, `created_at`, `updated_at`) <= 100 parameters.
   - Refuses entity declarations defining > 96 fields.
   - Remediation: split entity into smaller normalized tables or reduce field count.

5. **Payload Unbounded Warning (`BUDGET_PAYLOAD_UNBOUNDED_WARNING`)**:
   - Warns when an action or integration node outputs `rows` or `json` without declaring `maxOutputBytes`.
   - Remediation: declare `maxOutputBytes` in node data configuration.

## ExecutionContext & Idempotency Key

Every node executor receives an `ExecutionContext` built by the runtime for the active step.

### Context Fields

| Field | Type | Description |
|---|---|---|
| `nodeId` | `string` | Identifier of the node being executed in the graph. |
| `runId` | `readonly string` | Stable workflow run identifier. In durable Cloudflare Workflows, this matches `event.instanceId`. |
| `idempotencyKey` | `readonly string` | Deterministic key identifying this step execution across replays and retries. |
| `data` | `Record<string, unknown>` | Validated node configuration. |
| `inputs` | `Record<string, unknown>` | Values received from upstream output ports. |
| `payload` | `unknown` | Initial workflow trigger payload. |
| `secret(name)` | `(name: string) => string` | Access declared secrets. |
| `binding(name)` | `<T>(name: string) => T` | Access declared bindings (e.g. D1 database). |
| `connection(selector)` | `(selector: ...) => T` | Access declared connection credentials. |
| `log` | `StructuredLogger` | Redacted structured logger correlated with the run. |

### Idempotency Key Format

- **Standard node execution**: `"<runId>:<nodeId>"`
- **Fan-out / loop iterations**: `"<runId>:<nodeId>:<iteration>"`

Integration operations with `sideEffects: "write"` forward this key as `Idempotency-Key` (or the provider manifest's declared header, such as `X-Slack-Req-Id`) in outbound HTTP requests and to `callOperation({ idempotencyKey })`. Because Cloudflare Workflows steps have at-least-once execution semantics, this deterministic key ensures that step retries or pause/resume replays do not result in double-charges, duplicate message sends, or duplicated external mutations.



## Using outside the monorepo

The bricks import `@poc/sdk` at runtime, so a project outside this repo installs it next to them. See
[Using bricks outside the monorepo](../../docs/using-bricks-outside-the-monorepo.md) for the whole flow.

- **Install from a tarball.** Nothing is published to a registry (the package stays `"private": true`). Run
  `pnpm pack` in `packages/sdk` and depend on the tarball: `"@poc/sdk": "file:./vendor/poc-sdk-0.0.0.tgz"`. Packed
  bricks depend on `@poc/sdk` by version, so also add an override that points every `@poc/sdk` at the same tarball
  (`"pnpm": { "overrides": { "@poc/sdk": "file:./vendor/poc-sdk-0.0.0.tgz" } }`, or npm's `"overrides"`).
- **What the tarball holds.** `src/`, this README, `LICENSE` and `NOTICE` (Apache-2.0). No migrations and no
  manifest: the SDK is not a brick.
- **TypeScript sources.** There is one export, `"."`, pointing at `./src/index.ts`. Bundle the worker with wrangler or
  esbuild, which compile it; Node cannot load `.ts` from `node_modules`.
- **Runtime dependencies.** Only `zod`. The `hono` import in `src/rate-limit.ts` is type-only.
- **Migrations.** The SDK ships no migration files. `applyMigration(db, sql)` applies one brick migration file to a
  D1 database, statement by statement; call it from bundled worker code, not from a Node script. If you mount
  `rateLimit`, create its `px_rate_limits` table with a migration holding `PX_RATE_LIMITS_DDL`.
- **Mounting helpers.** `rateLimit(rule)` mounts a brick manifest's `rateLimits` entry (method and path from the
  manifest, with your prefix in place of `/api`).
- **Identity.** The SDK does not authenticate anyone. Your app sets `user` (`{ uid, email? }`) on the Hono context
  before any brick route runs.
