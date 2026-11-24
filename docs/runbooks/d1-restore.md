# Runbook: D1 Time Travel Database Restore

## Overview
ProjectX uses Cloudflare D1 Time Travel bookmarks to guarantee point-in-time recovery before any migration batch is applied. Before the first pending migration of any deploy is executed, `deploy()` captures a bookmark via the D1 Time Travel API (`GET /d1/database/{id}/time_travel/bookmark`) and commits it atomically alongside the first migration in `_projectx_deploy_history`.

## Retention Window & Constraints
- **Workers Paid / Enterprise plans:** 30 days of continuous Time Travel retention window.
- **Workers Free plans:** 7 days retention window.
- *(Source: Cloudflare D1 Time Travel documentation, updated October 2026)*.
- Restores within the retention window are point-in-time exact at statement transaction boundaries.
- Restores outside the retention window fail with `bookmark not found` or `timestamp out of retention bounds`.

## When to Restore vs. Roll Forward
| Scenario | Recommended Action | Reason |
|---|---|---|
| Destructive migration executed accidentally | **Restore to bookmark** | Reverts dropped tables, dropped columns, or truncated rows immediately. |
| Incompatible schema broke live traffic | **Restore + Rollback** | Restores database to `from_version_id` bookmark, then pairs with Worker rollback. |
| Additive migration with bug in column constraint | **Roll forward** | Write a corrective migration (`00xx_fix_*.sql`) rather than losing valid user writes. |
| Corrupted or missing application data | **Restore to bookmark** | Reverts application state to pre-deploy checkpoint. |

## Finding the Target Bookmark or Deploy ID
You can find the target bookmark using either:
1. `_projectx_deploy_history` in the database:
   ```sql
   SELECT id, started_at, bookmark, from_version_id, to_version_id, status
   FROM _projectx_deploy_history
   ORDER BY started_at DESC;
   ```
2. The `poc:restore` command (lists all recorded deploy checkpoints):
   ```bash
   pnpm poc:restore --state-dir "<state-dir>"
   ```
3. Cloudflare Wrangler CLI:
   ```bash
   wrangler d1 time-travel info <database-name>
   ```

## Restore Execution Procedure

### 1. Dry Run Inspection
Inspect the restore plan (shows target bookmark, database ID, and migrations that will be reverted) without modifying the database:
```bash
pnpm poc:restore --state-dir "<state-dir>" --to "<deploy-id-or-bookmark>"
```

### 2. Live Restore Execution
Execute the restore by passing `--yes`:
```bash
pnpm poc:restore --state-dir "<state-dir>" --to "<deploy-id-or-bookmark>" --yes
```
The restore command:
- Calls `POST /d1/database/{id}/time_travel/restore?bookmark=<target_bookmark>`.
- Captures and logs the `previous_bookmark` (undo snapshot), allowing the restore itself to be undone if needed.
- Pairs with the matching `from_version_id` for Worker rollback (UC8.6).

### 3. Verification Post-Restore
1. Check that `_projectx_migrations` reflects the target state:
   ```sql
   SELECT name, applied_at FROM _projectx_migrations ORDER BY applied_at DESC;
   ```
2. Verify table schemas in `sqlite_master`:
   ```sql
   SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger');
   ```
3. Test application canary queries against restored tables to confirm data integrity.

### 4. Undoing a Restore
If a restore was executed erroneously, you can undo it immediately by restoring to the reported `previous_bookmark`:
```bash
pnpm poc:restore --state-dir "<state-dir>" --to "<previous-bookmark>" --yes
```

## Worker Rollback Pairing (UC8.6)
When an incompatible schema migration breaks application traffic, restoring the database alone leaves the live Worker script running newer code that expects the newer schema.
To restore service safely:
1. Retrieve `from_version_id` from `_projectx_deploy_history` for the target deployment.
2. Restore the database using `pnpm poc:restore --to <deploy-id> --yes`.
3. Roll back the active Worker version to `from_version_id` via UC8.6 deployment rollback:
   ```bash
   wrangler versions deploy <script-name>@<from_version_id> --percentage 100
   ```
4. Verify `/healthz` and `/readyz` probes return HTTP 200.

## Automated Restore Drill (`ops:restore-drill`)
ProjectX includes an automated restore drill script (`scripts/restore-drill.ts`) to ensure that database recovery is a rehearsed, timed operation backed by cryptographic evidence.

### Modes
- **CI / Simulation (`--fake`):**
  Runs in memory against the fake Cloudflare API harness. Exercises database creation, migration execution, canary row insertion (Batch A), bookmark generation, mutation (Batch B), restoration to bookmark A, canary absence assertion, secondary restoration to `previous_bookmark`, canary presence re-assertion, and database teardown.
  ```bash
  pnpm ops:restore-drill --fake
  ```
- **Live Account Rehearsal (`--live`):**
  Runs against live Cloudflare infrastructure using provisioner credentials. Generates a temporary scratch database, executes the full restore drill, records step-by-step elapsed durations (`durationsMs`), and records stamped evidence in `evidence/restore-drill.json`.
  ```bash
  pnpm ops:restore-drill --live
  ```

### Guardrails (AC2)
The drill script enforces in code that it will **never** touch or mutate any database whose name does not start with the strict prefix `px-drill-`. Any attempt to target a project or production database is refused immediately before any API call is made. All scratch databases are automatically deleted upon completion or failure.

## Cold Backups & External Export (`wrangler d1 export`)
While D1 Time Travel provides point-in-time recovery within the 7-to-30-day window, external storage exports are recommended for disaster recovery beyond the retention window or cross-provider migration:
```bash
wrangler d1 export <database-name> --output=./backups/d1-backup-$(date +%Y%m%d).sql
```
Exported `.sql` files can be archived in R2 object storage or imported into local SQLite instances for offline investigation.
