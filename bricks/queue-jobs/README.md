# Background Job Queue (`queue-jobs`)

## Lease Semantics & Concurrency Safety

Jobs are claimed and leased atomically via single-statement SQLite `UPDATE ... RETURNING` queries:

- **Atomic Claiming (`claimJobById`):** Claims a specific job only if its status is `'queued'` or if an earlier lease has expired (`status = 'running'` and `next_run_at <= datetime('now')`). Bumps `attempt_count` by 1 and advances `next_run_at` by the visibility timeout. If multiple consumers race to claim the same job, SQLite serializes the writes so exactly one consumer wins the lease; all other contenders receive `null`.
- **Atomic Batch Dequeue (`dequeueBatch`):** Evaluates prioritized candidate jobs in a subquery and atomically transitions matching `'queued'` rows to `'running'` in a single `UPDATE ... WHERE id IN (...) AND status = 'queued' RETURNING *` statement. Concurrent workers receive disjoint sets of leased jobs with zero duplicate leases.
- **Conditional Completion & Failure (`complete` / `fail`):** Transitions to `'completed'`, `'queued'` (retry), or `'dead_letter'` are conditional on `status = 'running'` and guard against stale consumers via an optional lease attempt check (`AND attempt_count = ?`). If a lease expired and was reclaimed by another consumer (incrementing `attempt_count`), any late completion or failure attempt from the previous consumer fails safely without overwriting the newer lease.
