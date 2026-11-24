# @poc/assembler

Pure-function assembly engine that transforms a blueprint and a catalog of brick manifests into a deployable Cloudflare Worker application with D1 migrations, OpenAPI specs, route mounting, identity guards, scheduled cron dispatchers, and health endpoints.

## Core Properties

1. **Pure Function**: Given the same blueprint and catalog, `assemble()` always returns identical files byte-for-byte. It accesses no network, clock, filesystem, or randomness.
2. **Deterministic File Ordering & Structure**: Output files and migrations are deterministically sorted and hashed.
3. **Reserved Platform Routes**: Route prefixes `/healthz` and `/readyz` are reserved for platform health and readiness probes. No brick route or declared entity may claim these names.

## Generated Health & Readiness Endpoints

Every assembled Worker exposes `/healthz` and `/readyz` before any authentication or identity guard:

### `GET /healthz` (Liveness Probe)
- **Status**: `200 OK`
- **Headers**: `Cache-Control: no-store`
- **Response**: `{ "ok": true, "build": "<buildSha>" }`
- **Behavior**: Verifies the worker process is running and returns the composite build SHA (or `env.PX_BUILD_SHA` override if provided). Unauthenticated, never leaks secrets or database rows.

### `GET /readyz` (Readiness Probe)
- **Status**: `200 OK` if ready, `503 Service Unavailable` if unready
- **Headers**: `Cache-Control: no-store`
- **Response**:
  ```json
  {
    "ok": true,
    "checks": {
      "d1": "ok",
      "bindings": "ok",
      "migrations": "ok"
    }
  }
  ```
- **Checks**:
  - `d1`: Probes D1 connectivity with `SELECT 1` (2-second timeout).
  - `bindings`: Checks presence of all required bindings (D1 `DB` plus any brick bindings/queues). Reports `missing: <name>` if absent.
  - `migrations`: Queries `_projectx_migrations` and verifies all expected migrations for the build are applied. Reports `pending: <name>` or `mismatched: <name>` if incomplete.
- **Safety**: Never exposes table rows, environment secrets, or stack traces.
