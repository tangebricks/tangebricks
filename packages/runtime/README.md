# @poc/runtime

## Step retry and timeout policy (UC7.2)

In a durable run (a Workflow), each node executes inside its own engine step, and the engine does the retrying.
`stepPolicyFor(manifest, { idempotent })` in `src/step-policy.ts` derives the step's `retries` and `timeout` from what
the node declares:

| `sideEffects` | retries | delay / backoff | timeout |
|---|---|---|---|
| `none` | 5 | 1 second, exponential | 30 seconds |
| `read` | 4 | 2 seconds, exponential | 60 seconds |
| `write`, node is `idempotent` | 3 | 5 seconds, exponential | 60 seconds |
| `write`, not idempotent (or `sideEffects` not declared) | 0 | none | 60 seconds |

- `idempotent` is declared on the node (`nodeDefinition.idempotent`). Integration operations set it when the operation
  declares idempotency support. Every attempt of a step carries the same `runId:nodeId` key (`ctx.idempotencyKey`).
- A node may lower the limit with `retry: { limit }`. Nothing raises a limit above the table, and nothing raises a
  non-idempotent write above 0.
- Errors that cannot succeed on a repeat (`INTEGRATION_UNSUPPORTED_FEATURE`, `retryable: false`, a 4xx status other than
  408 and 429) are rethrown as the engine's non-retryable error.
- When `runGraph` is given `runStep` (a durable run), its own in-process retry loop is off: a second `step.do` with the
  same name is a cached or duplicate step in the engine, not a retry.
- In local, non-durable runs (UC7.7), `telemetry.stepRetries` is unified with `stepPolicyFor`: `stepPolicyFor` is the single
  source of retry truth. A non-idempotent write is never retried even if requested by telemetry options, any configured limit
  is capped at the node's `stepPolicyFor` ceiling, and setting `stepRetries: true` inherits the canonical retry limits and backoff.
- The random `runId` fallback via `Math.random` has been eliminated (UC7.7 AC1). Callers in durable workflows supply deterministic
  identifiers (`event.instanceId`), while local non-durable runs generate collision-free UUIDs via `crypto.randomUUID()`.
