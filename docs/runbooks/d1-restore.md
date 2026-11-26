# Runbook: D1 Time Travel Database Restore

## Overview
ProjectX uses Cloudflare D1 Time Travel bookmarks to guarantee point-in-time recovery before any migration batch is applied. Before the first pending migration of any deploy is executed, `deploy()` captures a bookmark via the D1 Time Travel API (`GET /d1/database/{id}/time_travel/bookmark`) and commits it atomically alongside the first migration in `_projectx_deploy_history`.

Studio's deploy path (Studio and MCP deploys) does the same for an existing database: before it applies the first pending migration it takes a bookmark and records it at once as a restore point (Studio's `deploy_restore_points` table, by project, environment, deploy id and time), before any migration runs. A deploy that migrates and then fails still leaves its restore point. If the bookmark cannot be taken or recorded, the deploy stops before any migration runs. A deploy that creates the database, or applies no migration, records no bookmark.

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

## Studio Rollback With Data Restore (`restoreData`)
A Studio rollback (`POST /api/projects/:project/environments/:envName/rollback`) reverts the code: the target deployment's revision and its cached build. With `"restoreData": true` it also restores the environment's D1 to the bookmark taken before the first migration after the target deployment:
```json
{ "targetDeploymentId": "dep_...", "restoreData": true, "confirmDestructive": true }
```
- **Opt-in.** Without `restoreData` the rollback is code only, exactly as before. A restore is never automatic.
- **Everything since the bookmark is lost.** The restore discards every write made after that bookmark, not just the migration. Check the dry run (`"dryRun": true`) first: it names the deployment whose bookmark would be used (`restoreData.fromDeploymentId`).
- **No restore point.** When no later deployment of the environment applied a migration to an existing database, the answer is 409 `NO_RESTORE_POINT` and nothing is changed.
- **Gating.** The same as a code rollback: an MCP token needs an AD-V8 approval, and `restoreData` is part of the approved plan, so an approval for a code-only rollback does not cover a restore.
- **Order and failure.** The code is rolled back first; D1 is restored only after that succeeded. If the code rollback fails, D1 is not touched. If the restore then fails, the answer is 502 `DATA_RESTORE_FAILED` with `codeRolledBack: true` and `dataRestored: false`: the code is rolled back (the deployment is recorded), the data is not. The audit log records `environment.rollback.restore_data` with status `failed`. Retry the rollback with `restoreData` to restore the data. Restoring also brings back the graph and state rows the rollback just wrote to that database as they were at the bookmark.
- **Undo.** The answer carries `previous_bookmark`: the database as it was just before the restore. The audit log entry (`environment.rollback`) records `restoreData`, the bookmark used and `previous_bookmark`. To undo, restore to `previous_bookmark` (for example `wrangler d1 time-travel restore <database-name> --bookmark=<previous_bookmark>`).

## Automated Restore Drill (`ops:restore-drill`)
ProjectX includes an automated restore drill script (`scripts/restore-drill.ts`) to ensure that database recovery is a rehearsed, timed operation backed by cryptographic evidence.

### Modes
- **CI / Simulation (`--fake`):**
  Runs in memory against the fake Cloudflare API harness. Exercises database creation, migration execution, canary row insertion (Batch A), bookmark generation, mutation (Batch B), restoration to bookmark A, canary absence assertion, secondary restoration to `previous_bookmark`, canary presence re-assertion, and database teardown.
  ```bash
  pnpm ops:restore-drill --fake
  ```
- **Live Account Rehearsal (`--live`):**
  Runs against live Cloudflare infrastructure using provisioner credentials. Generates a temporary scratch database, executes the full restore drill, records step-by-step elapsed durations (`durationsMs`), and records stamped evidence in `evidence/restore-drill-scratch.json` (never `evidence/restore-drill.json`, which is the staging drill's).
  ```bash
  pnpm ops:restore-drill --live
  ```

- **Existing staging database (target mode):**
  Runs the drill on one named, existing database and leaves it as it found it. All three flags are required:
  ```bash
  pnpm ops:restore-drill --target-db <database-uuid> --expect-name <name>-staging --env-file <path-outside-the-repo>
  ```
  - `--expect-name` must end in `-staging` and must equal the database's live name (read first, with a read-only call); otherwise the drill refuses before any write.
  - `--env-file` holds `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Only that file is read; a file inside the repository is refused.
  - `--label` (optional, default `cephlow-staging`) is how the evidence names the target.
  - Flags take their value as the next argument. An unknown argument or a `--flag=value` form is refused with a non-zero exit before any call.

  Steps: fingerprint (every table except `_cf_*` and `sqlite_*`, with its row count), create and seed `px_restore_drill_canary`, take a bookmark, delete the canary rows and drop the canary table, restore to the bookmark, verify the canary rows are back and the fingerprint matches, drop the canary table. A failure after the bookmark restores to it (when the restore has not run yet), drops the canary and exits non-zero without writing evidence. A leftover canary table from an earlier stopped run is refused: check it and drop it by hand.

  The restore discards anything written to the staging database while the drill runs (a few seconds), so run it when staging is quiet. A concurrent write also makes the fingerprint check fail.

  The evidence, `evidence/restore-drill.json`, carries the run's start time, per-step timings and the total, the verification flags, the git SHA and the label; never an account id, a database uuid, a bookmark or a workers.dev address (the script refuses to write it otherwise). Record the run in `evidence/deployed/integrity.json` like any live run:
  ```bash
  pnpm evidence:record-live
  ```

### Guardrails (AC2)
In scratch mode (`--fake`, `--live`) the drill script enforces in code that it will **never** touch or mutate any database whose name does not start with the strict prefix `px-drill-`. Target mode touches only the one database named by `--target-db`, and only when its live name equals `--expect-name` and ends in `-staging`. Any attempt to target a project or production database is refused immediately before any API call is made. All scratch databases are automatically deleted upon completion or failure.

## Cold Backups & External Export (`wrangler d1 export`)
While D1 Time Travel provides point-in-time recovery within the 7-to-30-day window, external storage exports are recommended for disaster recovery beyond the retention window or cross-provider migration:
```bash
wrangler d1 export <database-name> --output=./backups/d1-backup-$(date +%Y%m%d).sql
```
Exported `.sql` files can be archived in R2 object storage or imported into local SQLite instances for offline investigation.
