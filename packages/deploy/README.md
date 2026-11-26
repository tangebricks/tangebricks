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

## Deployed runs: real executors and a verified workspace (story 1.1)

The bundled Worker's `GraphRunner` Workflow and its `/__px/*` routes run the real catalog: `buildRegistryFromCatalog(catalog)` and `buildExecutorsFromCatalog(catalog, DEPLOY_PACKAGE_EXPORTS, { environment })` (`src/worker/catalog-bricks.ts`). `DEPLOY_PACKAGE_EXPORTS` wires `@poc/credit-wallet` (debit is the D1-backed deduction; it needs the `DB` binding, which its catalog node declares). A brick action whose package executor would only report success without doing anything is left NOT_CONFIGURED. The proof bricks (`proof.add`, `proof.multiply`, `src/worker/proof-bricks.ts`) are test fixtures: a test injects them with `bundleWorker({ fixtureBricksModule })`; the shipped bundle never does.

Trigger rule: **a run without a verified workspace is refused.**

- `POST /poc/runs` (shared access key only) never starts a run: it answers `403 NO_VERIFIED_WORKSPACE` and creates no Workflow instance.
- `POST /__px/workflow-runs` is the authenticated trigger. Body `{ requestId, graphId, workspaceId, payload? }`, signed with `PX_TELEMETRY_SECRET`, which must be set and must differ from the access key (with no such secret the route answers 503). Since story 1.17 that binding holds the project's derived control-plane secret (`deriveProjectSecret(root, projectId, "control-plane")`, bound by the provisioner with `telemetryWebhookConfig`), never Studio's root secret, so a signature made for another project is refused. The signature is two headers: `x-px-signed-at` (epoch seconds, refused when more than 300 s from the Worker's clock) and `x-px-signature`, the HMAC-SHA256 of `px-control-plane/v1\n${method}\n${path}\n${signedAt}\n${body}`, so a signature made with the access key, for another route, for another body, or for the telemetry webhook (whose signature is HMAC over `px-telemetry-webhook/v1\n${body}`) is refused (401). `requestId` (a UUID) becomes the Workflow instance id: a replayed request finds it taken and gets `409 DUPLICATE_REQUEST`, and nothing runs twice. The signed body's `workspaceId` is the run's workspace: it is whatever the signer put there. Studio does not sign this route: its own preview-workspace check (story 1.17) applies to Studio's in-process `/runs`, `/run` and test-step, which accept only the project's preview workspace, a workspace in the project's own preview data store, or one its runs already name, and refuse any other with `403 WORKSPACE_NOT_IN_PROJECT` before anything is signed. A body without one gets `400 NO_WORKSPACE`; the reserved `__app__` workspace or a malformed id gets 400. On success it starts the Workflow with `params { graphId, workspaceId, payload }` and answers `202 { id, workspaceId }`.
- `GET /poc/runs/:id` returns a run's status and output, which can hold a tenant's balances, so it takes the same signature (empty body) as well as the access key; the key alone is 401.
- The routes that execute bricks inline (`/__px/rehearse`, `/__px/runs`, `/__px/runs/rerun`) take the same control-plane signature (method, path, time, body; story 1.17) and a one-time `requestId` (a UUID) in the signed body. The id is recorded in `px_control_requests(request_id PRIMARY KEY, path, workspace_id, created_at)` before any executor runs; a second use gets `409 DUPLICATE_REQUEST` and executes nothing, so a captured request replayed inside the window debits once. A missing or malformed `requestId` is 400; a stale, wrong-path, legacy body-only or webhook signature is 401. Rows older than an hour are pruned opportunistically. Their signed body must also name a tenant `workspaceId` (400 `NO_WORKSPACE` or `BAD_WORKSPACE` otherwise). The read-only pulls (GET `/__px/events`, `/__px/logs`, `/__px/metrics` and `/__px/data/*` reads) take the same signature without a request id; every signed `/__px/data/*` write (POST, PATCH, PUT, DELETE) must carry a one-time `requestId` (a UUID) in its signed query string, claimed in the same `px_control_requests` ledger before the write (400 without one, 409 `DUPLICATE_REQUEST` on reuse).
- The Workflow hands that workspace to `runGraph`, which gives it to every executor as the read-only `ctx.workspaceId`. The runtime has no default workspace: `runGraph` refuses a run without one (`RunRefusedError`, `NO_WORKSPACE`) before any node runs, and a run whose params carry none (or `__app__`) ends non-retryably before its graph is read. Executors never take a workspace from inputs, payload or config: `credit-wallet.debit` fails `WORKSPACE_MISMATCH` and debits nothing when its input names another workspace.

## Studio's one real deploy path (story 1.2)

Studio deploys with `createHttpCloudflareApiClient` (`src/http-control-plane.ts`), the `CloudflareApiClient` over Cloudflare's
REST API. MCP's deploy tools call Studio's routes, so they use the same client. The client is built on the provisioner's REST
client (`src/provisioner/cloudflare.ts`), so auth, retries, error classes, secret redaction and the request budget are shared
with the proof scripts. There is no second HTTP stack.

- **Endpoints.** Workers: upload with `keep_bindings` for secrets; `PUT .../secrets`; `GET`/`PUT .../schedules`;
  `.../subdomain`. Also D1, Queues (`GET`/`POST /queues`, `DELETE /queues/{id}`), Workflows and the account record. A method
  whose endpoint has not been checked against the live API says so in a comment.
- **Bookkeeping.** The project's own D1 holds two tables: `_projectx_migrations` and `_projectx_studio_state` (the build,
  code and graph hashes, and the schedule rows). The Worker's code hash is the version annotation `workers/message`. An
  unchanged redeploy is a no-op with zero write calls.
- **Tokens.** `verifyCloudflareToken(token, accountId, { client })` asks Cloudflare. It tries
  `GET /accounts/{id}/tokens/verify`, and on a 401 or code 1000 tries `GET /user/tokens/verify`, because a user token
  verifies only there. It reads permissions from the token's own policies when an account token may read them. Otherwise it
  makes one harmless read per capability and names each refusal. A read proves Read only: the report says `verifiedBy: "read-probe"`, marks the Edit permissions unconfirmed, and its summary says the first deploy will confirm them. A 400/404 read reports the capability unavailable; a 5xx or network failure propagates as unreachable, never as a verdict on the token. It needs a client. The spelling-based classifier
  (`cf_revoked_...`) is reachable only through the fake, `MockCloudflareControlPlane`, which is for tests only. Studio uses the
  fake only with `PX_DEPLOY_CLIENT=fake` and `PX_ENVIRONMENT` test or development; anywhere else that setting is refused.
- **Rate limit.** Every request attempt, retries included, takes a token from a bucket of 1,100 per five minutes per account (per process, and per account rather than per user; the shared budgets are a bounded LRU),
  below Cloudflare's 1,200 (`createRequestBudget`, `sharedRequestBudget`). A request waits for budget instead of failing. A 429
  is still retried after `Retry-After`.
- **Smoke check.** The check before a traffic shift sends the gate's `x-poc-key`, so a redeploy that uploads code passes the
  access-key gate.
- **Lists** (scripts, D1, queues, Workflows) are read page by page (`page`/`per_page`, stopping at `result_info.total_pages`, a short page or a repeated page); the paging parameters of `/workers/scripts`, `/queues` and `/workflows` are not yet checked against the live API.
- **workers.dev.** An account without a workers.dev subdomain gets `NO_WORKERS_DEV_SUBDOMAIN`, with steps to enable it.
  Nothing creates the subdomain.

The live proof is `pnpm live:studio-deploy`. See [docs/live-deploy.md](../../docs/live-deploy.md) for the token permissions,
the env file, the commands, the teardown and what the proof creates.

## Verification

The fault matrix is continuously verified by:
- Automated fault-injection suite: `packages/deploy/test/deploy-faults.node.test.ts`
- Mutation testing: `node scripts/mutate-deploy.ts` (verifies tests kill mutants disabling version adoption, deployment reconciliation, bookmark enforcement, and failure recording)
- Safe deploy ordering & rollback suite: `packages/deploy/test/safe-deploy-order.node.test.ts`
