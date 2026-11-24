# Brick Conformance Kit

The Shared Brick Conformance Kit (`@poc/harness/conformance`) provides a standardized verification harness ensuring every brick in the catalog satisfies baseline tenancy, safety, and migration contracts before earning production readiness.

## Baseline Checks

The conformance kit registers and executes five essential checks:

1. **`CONF_MIGRATIONS_UP`**:
   - All migrations apply cleanly in order to an empty D1 database instance.
   - Every created table contains a `workspace_id` column unless declared as platform-wide in `manifest.globalTables` (or `globalTables` option).

2. **`CONF_TENANT_ISOLATION`**:
   - Seeds data for distinct workspaces (`workspaceA` and `workspaceB`).
   - Requires a **positive control**: first executes the route as the owning workspace and requires a 200/201 response containing that workspace's data.
   - Only then executes the route authenticated as workspace B while requesting workspace A identifiers (in params, query, or body).
   - Enforces a 403 Forbidden or 404 Not Found response and confirms no workspace A data appears in the response body. If a route 404s for everyone or nothing is tested, the check fails (`cannot confirm isolation` or `nothing to test`).
   - Declared `globalRoutes: string[]` (e.g. `/flags`) over declared `globalTables` are exempted from workspace isolation checks.

3. **`CONF_IDEMPOTENT_WRITE`**:
   - Executes write routes (POST/PUT) with an `Idempotency-Key` header (substituting `:id`-style path parameters).
   - Replays the exact request with the same header and validates that the database row count does not increase on replay.

4. **`CONF_ERROR_CONTRACT`**:
   - Validates that all 4xx client error responses conform to the standard structured error contract:
     ```json
     {
       "error": {
         "code": "STRING_ERROR_CODE",
         "message": "Human-readable description"
       }
     }
     ```

5. **`CONF_SECRET_SCOPE`**:
   - Wraps the Worker execution environment in an access-monitoring Proxy passed into Hono's context (`c.env`).
   - Ensures routes only touch secrets and bindings declared in `brick.manifest.json` (`secrets`, `bindings`, or D1 `DB`).
   - **Known Limit (H3)**: `CONF_SECRET_SCOPE` only observes binding and secret access accessed through Hono's `c.env`. It **cannot** detect or intercept direct module imports such as `import { env } from "cloudflare:workers"` (documented as known limit H3 in `PROOF.md`). Strict isolate-level isolation for untrusted brick code requires separate Workers per brick (addressed in Epic UC6).

## What Conformance Checks Do NOT Prove

While the conformance kit verifies baseline contracts, each check has explicit boundaries and does NOT prove total system security:

1. **`CONF_MIGRATIONS_UP` does NOT prove:**
   - Migration rollbacks / down-migrations work cleanly or preserve data.
   - Schema performance, indexing strategy, or SQLite query planner efficiency.
   - Forward or backward schema compatibility across future breaking migrations.

2. **`CONF_TENANT_ISOLATION` does NOT prove:**
   - Protection against malicious raw SQL queries or direct database binding calls that bypass route parameters or ORM helpers.
   - Resilience against side-channel timing attacks or cache-probing between workspaces.
   - Complete business-logic isolation for arbitrary edge cases not covered by test requests or default schemas.

3. **`CONF_IDEMPOTENT_WRITE` does NOT prove:**
   - Concurrency safety or distributed locking when replayed write requests arrive simultaneously in parallel.
   - Deduplication of out-of-band side effects (e.g., external API calls, webhook dispatches, email sending) triggered inside the route handler.

4. **`CONF_ERROR_CONTRACT` does NOT prove:**
   - Formatting of fatal runtime crashes or unhandled workerd panics (e.g. out-of-memory or native workerd aborts) that crash the runtime before Hono's error handler executes.
   - Semantic validity or domain correctness of the specific error code strings returned.

5. **`CONF_SECRET_SCOPE` does NOT prove:**
   - Secret access isolation beyond Hono's `c.env` context; code running inside the same isolate can import `env` from `"cloudflare:workers"` directly (known limit H3 in `PROOF.md`).
   - Secure memory handling of declared secrets (e.g. ensuring secrets are not accidentally logged or included in debug stack traces).

## Adopting the Kit

Adopting the conformance kit requires a single test file of fewer than 15 lines in `bricks/<name>/test/conformance.workerd.test.ts`:

```typescript
import { runBrickConformance } from "@poc/harness/conformance";
import { createAuditRoutes } from "../src/index.ts";

runBrickConformance({
  brickDir: "bricks/audit-trail",
  routes: createAuditRoutes(),
  skip: {
    CONF_IDEMPOTENT_WRITE: "Audit trail is an append-only log without idempotency-key deduplication",
  },
});
```

## Skipping Checks

Checks may be skipped only by providing an explicit, non-empty `reason` string:
```typescript
skip: {
  CONF_IDEMPOTENT_WRITE: "Explicit reason explaining why this check is not applicable or postponed",
}
```
Attempting to skip a check without a reason or with an empty string throws an error. Skipped checks are automatically attached to test metadata and written by the test reporter into the ignored run directory as `.evidence-run/tier-evidence.json` (it is test output, not tracked evidence, so a test run never dirties the tree) as:
```json
{
  "id": "audit-trail",
  "kind": "brick",
  "skipped": [
    {
      "check": "CONF_IDEMPOTENT_WRITE",
      "reason": "Audit trail is an append-only log without idempotency-key deduplication"
    }
  ]
}
```
