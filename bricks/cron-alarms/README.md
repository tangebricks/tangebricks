# Cron & Distributed Alarms (`@poc/cron-alarms`)

The Cron Alarms brick provides multi-tenant recurring schedule execution, distributed alarm management, execution history tracking, and failure reporting.

## Configuration: `CRON_WORKFLOW_TARGETS` (Story 0.20)

A schedule may start only the Workflow bindings the app lists in the `CRON_WORKFLOW_TARGETS` env var (a Worker `vars`
entry): a comma-separated list of binding names, for example `"REPORTS_WF,NIGHTLY_SYNC_WF"`. Entries are trimmed and
empty entries ignored.

- Unset or empty: no Workflow target is allowed. URL targets (`targetUrl`) are unaffected and keep the SSRF guard.
- `POST /api/schedules` with a `targetWorkflowId` not on the list answers `400 { error, code: "WORKFLOW_TARGET_NOT_ALLOWED" }` and writes nothing.
- The list is checked again when a schedule fires. A target removed from the list since the schedule was made is recorded
  as a failure (`NOT_ALLOWED: ...`) and its binding is never called. A listed name with no binding is `NOT_CONFIGURED`.
  There is no fallback runner.
- The list is app configuration only; no route lets a workspace change it. Code embedding `CronService` directly may
  pass `allowedWorkflowTargets` in its options instead, which takes precedence over the env var.

## Concurrency & Execution Semantics (Story UC7.6)

### Atomic CAS Slot Claim
To prevent race conditions, concurrent double-firing, and overlapping executions from long-running tasks or Cloudflare platform re-deliveries:
- Invocations atomically claim a schedule slot via a Compare-And-Set (CAS) query:
  ```sql
  UPDATE cron_schedules
  SET next_run_at = ?, last_run_at = ?
  WHERE id = ? AND next_run_at = ? AND active = 1
  RETURNING id
  ```
- Only the invocation that receives a returned row proceeds with triggering the schedule.
- All competing or overlapping concurrent dispatcher invocations receive zero rows and return immediately without creating duplicate history entries or triggering duplicate runs.
- The assembled shell's top-level `scheduled()` handler applies the same `WHERE id = ? AND next_run_at = ? AND active = 1` claim on `px_schedules` to deduplicate before delegating to brick handlers.

### Deterministic Target Invocation & Deduplication
- **Workflows (`target_workflow_id`)**: Invokes the Workflow binding using a deterministic instance ID:
  ```
  cron:<scheduleId>:<slotIso>
  ```
  Because Cloudflare Workflows deduplicates instance IDs within the retention window, any redelivered alarm is safely ignored by the engine.
- **HTTP URLs (`target_url`)**: Outbound webhook calls transmit the deterministic ID in the `Idempotency-Key` header:
  ```http
  Idempotency-Key: cron:<scheduleId>:<slotIso>
  ```
  The target endpoint can use this header to deduplicate duplicate webhook dispatches.

### Missed-Run Catch-Up Policies (`catch_up`)
When a Worker is offline, redeploying, or delayed such that one or more schedule intervals were missed, `cron-alarms` applies the declared `catch_up` policy:

| Policy | Behavior |
| --- | --- |
| `once` *(default)* | Fires a single execution for the current run, advancing `next_run_at` to the next upcoming interval in the future. |
| `all` | Sequentially catches up each missed interval slot up to `max_catch_up` (default 10, configurable up to 100), recording individual execution history records for each slot. |
| `skip` | Bypasses all overdue slots (0 target invocations), advances `next_run_at` to the upcoming future slot, and records a single history record with `status: "missed"`. |

### Execution History & Outcome Status
Execution status is dynamically computed from actual target outcomes and never hardcoded:
- `success`: Target workflow created or HTTP endpoint returned 2xx.
- `failure`: Target workflow `.create()` threw, network error occurred, or HTTP endpoint returned 4xx/5xx; the error message is recorded in `response_summary`.
- `missed`: Schedule was skipped due to the `skip` catch-up policy.
