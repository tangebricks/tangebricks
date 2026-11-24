# @poc/deploy

Deployment orchestration, Cloudflare API client, provisioning ledger, and safe deployment protocols for ProjectX workers and workflows.

## Safe Deploy Fault Matrix (UC8.7)

The deploy sequence in `packages/deploy/src/provisioner/deploy.ts` enforces crash-resilient convergence across all failure points. Every crash point guarantees consistent account state and idempotent re-run recovery with zero redundant write operations beyond what is missing.

| Fault # | Failure Point / Crash Condition | Immediate System State | Re-Run Recovery & Convergence |
|---|---|---|---|
| **Fault 1** | `uploadVersion` network failure or 5xx after migrations applied | Traffic remains 100% on previous version. `_projectx_deploy_history` records `status: 'upload_failed'` with `last_good_version_id` preserved. Migrations remain recorded in `_projectx_migrations`. | Re-run recognizes applied migrations via `_projectx_migrations` (0 migration re-runs). Uploads Worker version, executes smoke tests, shifts traffic, and advances history to `status: 'success'`. |
| **Fault 2** | `uploadVersion` succeeds in Cloudflare but response packet is lost (`afterHandling: true`) | An un-deployed orphan version exists on Cloudflare with metadata `annotations["workers/message"] = "projectx-poc <bundle_sha.slice(0, 12)>"`. Traffic remains on previous version. | Re-run inspects `client.listVersions()`, matches the orphan version by bundle annotation hash, and adopts it. Makes **zero redundant `uploadVersion` calls**, runs smoke check, shifts traffic to 100%, and updates history. |
| **Fault 3** | Crash between `createDeployment` (traffic shifted to 100%) and D1 history/deploy table write | Cloudflare active deployment is already taking 100% traffic on the new version. D1 `_projectx_deploy` or history still holds previous version or `started` status. | Re-run reads `client.listDeployments()`, discovers the new version is already live at 100%, makes **zero redundant `createDeployment` calls**, and reconciles `_projectx_deploy` and `_projectx_deploy_history` to `status: 'success'`. |
| **Fault 4** | `getD1Bookmark` call fails before migration batch | Deploy fails immediately before executing any migrations. | No migration SQL statements are executed. `_projectx_migrations` is untouched. Zero schema changes occur without a valid restore bookmark. |
| **Fault 5** | D1 migration batch query fails mid-way | D1 query batch transaction rolls back atomically. Partial tables/columns are discarded. `_projectx_migrations` is untouched. | Re-run retries the migration batch from the beginning once the issue is resolved. |
| **Fault 6** | `createDeployment` returns 5xx | Deployment shift fails. Cloudflare continues routing 100% traffic to the old version. Live code remains on the previous good version. | Re-run adopts the already-uploaded version and retries traffic shift. |

## Deploy plan (UC8.8)

`planDeploy({ ...deployInput, lock })` (`src/provisioner/plan.ts`) previews a deploy without writing anything: it makes only GET and read-only D1 queries (`isWriteCall` is false for every call it makes). It returns:

- `migrations`: each pending migration with its lint class (`additive`, `rewrite`, `destructive`);
- `bricks`: version moves between the lock stored with the live deploy and the new lock (`major`, `minor`, `patch`, `added`, `removed`), and `settings`: changed setting values; with a `catalog`, `settingsUpgrade` carries the `checkSettingsUpgrade` errors and warnings;
- `worker`: whether the Worker would be uploaded, and why (`new`, `bundle`, `bindings`, `config`, `drift`);
- `workflow.action` (`none`, `register`, `update`) and `rollbackTo` (the version live now, or `null`);
- `blocking`: what `deploy()` refuses, namely destructive migrations without an expand/contract header or `allowDestructive`, major brick bumps without `allowMajor`, settings errors, and an edited already-applied migration. `empty` is true when nothing differs.

`deploy()` plans first when it is given `lock` and throws `DEPLOY_PLAN_BLOCKED: ...` before any write if the plan lists blocking items. It also stores the lock (`project.json`) in `_projectx_deploy_history.lock_json` (the column is added to an older table), which is what the next plan diffs against. A project deployed without `lock` has no stored lock, so its first plan reports no brick or setting changes.

`node scripts/poc-deploy.ts --state-dir <dir> --plan [--variant changed]` prints the plan as JSON and exits 0; it reads the account and the ledger and writes neither.

## Verification

The fault matrix is continuously verified by:
- Automated fault-injection suite: `packages/deploy/test/deploy-faults.node.test.ts`
- Mutation testing: `node scripts/mutate-deploy.ts` (verifies tests kill mutants disabling version adoption, deployment reconciliation, bookmark enforcement, and failure recording)
- Safe deploy ordering & rollback suite: `packages/deploy/test/safe-deploy-order.node.test.ts`
