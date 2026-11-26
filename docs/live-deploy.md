# Live deploy: Studio's real path, proved against your account

Studio deploys to your Cloudflare account through one path: the real Cloudflare REST client
(`createHttpCloudflareApiClient` in `packages/deploy/src/http-control-plane.ts`). MCP's `deploy_plan` and `deploy_apply` call
Studio's own routes, so they use the same path. The in-memory fake (`MockCloudflareControlPlane`) is for tests only. Studio
uses it only when `PX_DEPLOY_CLIENT=fake` and `PX_ENVIRONMENT` is `test` or `development`; with any other `PX_ENVIRONMENT`
(production, preview, unset) that setting is refused.

`scripts/live-studio-deploy.ts` proves this path end to end against a real account. It runs Studio's API in-process with the
real client, drives Studio's own routes, records the evidence and removes everything it created.

## The token

Create a scoped API token, either an account token or a user token under My Profile; both work. Give it these permissions on
the one account you deploy to:

| Permission | Why |
|---|---|
| Account Settings: Read | Read the account's name, and probe the token |
| Workers Scripts: Edit | Upload Workers, set their secrets, Cron Triggers and workers.dev address, register Workflows |
| D1: Edit | Create the environment databases, run migrations, store graphs, fund and read the test wallet |
| Queues: Edit | Create the queues a brick declares. The proof's bricks declare none, but step 1 requires this permission, and the account must have Queues available (`GET /queues` answers 200): a token or account without it is refused at connect |

Workers Routes is not needed: the proof uses only `*.workers.dev` addresses.

The account needs a workers.dev subdomain. Neither Studio nor the script creates it. If it is missing, the deploy stops with
`NO_WORKERS_DEV_SUBDOMAIN`. To add one, open the dashboard, go to Workers & Pages > Overview, choose a subdomain and save.

Studio verifies a token by asking Cloudflare. It tries `GET /accounts/{id}/tokens/verify` first, then
`GET /user/tokens/verify` for a user token. It reads the token's permission groups when the token may read its own policies.
Otherwise (a user token, or an account token that may not read its policies) it makes one harmless read per capability
(account, Workers scripts, D1, queues). A read shows only that the permission group is there with at least Read: the report
says `verifiedBy: "read-probe"` and marks Workers Scripts, D1 and Queues Edit as unconfirmed, and they are confirmed by the
first deploy. A refused read (401/403) names the missing permission; a 400/404 says that capability is unavailable on the
account (for example Queues not enabled). A 5xx or a network failure is never read as a verdict on the token: Studio answers
502 `CLOUDFLARE_UNREACHABLE`, and a recheck never marks a token revoked on such an answer.

## The env file

Keep it outside the repository. Node loads it, and the script never prints a value from it.

```
CLOUDFLARE_ACCOUNT_ID=<32 hex>
CLOUDFLARE_API_TOKEN=<the scoped token>
PX_TELEMETRY_SECRET=<Studio's root secret, 16+ characters>
# optional, for step 6: a token you have already revoked
CF_REVOKED_TOKEN=<a revoked token>
```

## The commands

```
node --env-file=<path-outside-repo>/.env scripts/live-studio-deploy.ts --state-dir <path-outside-repo>/studio-state --revoked-token-env CF_REVOKED_TOKEN
```

`pnpm live:studio-deploy -- --state-dir <folder>` is the same command. Without `--env-file`, the variables must already be in
the environment.

The run takes these steps:

1. It signs up a throw-away Studio owner in a local Studio database. It connects the token through
   `POST /api/orgs/:org/cloudflare-tokens/verify-and-save` and requires `active` with every permission granted.
2. It creates the project `tangebricks-test-<8 hex>` from `INVOICE_FLOW_BLUEPRINT` (multi-workspace, credit-wallet,
   dynamic-entities) with oidc-verify as its identity (production refuses the stub). It also adds a stored graph
   `trigger.manual -> credit-wallet.debit`. The core-auth identity has its own proof, `--blueprint core-auth` (below).
3. It plans and deploys preview (`/environments/preview/plan`, `/deploy`), then production (`/production/plan`,
   `/promote`). Each address must answer `/healthz` with the access key.
4. It redeploys both. Each redeploy must report `action: noop` with `changes: []`, and the write guard must log no write call.
5. It funds a test workspace's wallet in the production D1 over REST, then starts a signed `POST /__px/workflow-runs`. The
   wallet must be debited exactly once by the real executor. A run with no workspace must get 400 `NO_WORKSPACE`, and a run
   with a bad workspace 400 `BAD_WORKSPACE`. Neither may debit anything.
6. With `--revoked-token-env`, verify-and-save must refuse the revoked token, and an upload made with it must be refused by
   Cloudflare.
7. It tears down everything in the ledger, then lists the account to check that nothing with its prefix is left.
8. It writes the evidence. Each file is checked for every secret before it is written. A pass becomes the canonical
   `evidence/deployed/studio-deploy-result.json` and `studio-deploy-calls.json` (the previous pair moves to `attempts/`). A
   failure is written to `attempts/` only and never replaces a passing result. The result file carries the calls file's sha256,
   so the integrity record covers both. The script then records the results in `evidence/deployed/integrity.json`, as
   `pnpm evidence:record-live` would. Run `pnpm readme:generate` after it.

Step 6 needs a token that differs from `CLOUDFLARE_API_TOKEN`. Before any upload with it, the script asks Cloudflare to verify
it at both endpoints. If Cloudflare says it is active, the step stops and nothing is uploaded with it. A Global API Key (37 hex
characters) is refused before anything is sent.

The command exits 0 only when every step passed and the teardown left nothing.

### The core-auth preview proof (`--blueprint core-auth`, story 1.19)

```
node --env-file=<path-outside-repo>/.env scripts/live-studio-deploy.ts --state-dir <path-outside-repo>/studio-state --blueprint core-auth
```

It proves the safe secrets path for an agent-built preview, on the same guard, ledger, prefix and evidence rules:

1. It connects the token as above, then applies a core-auth blueprint (multi-workspace, core-auth as the identity,
   dynamic-entities). Nobody stores a secret: `BETTER_AUTH_SECRET` is generated by Studio, and the GitHub credentials are
   optional. It issues an MCP token with the default agent scopes (`read`, `edit`, `deploy`; never `connect`).
2. As that MCP token, `deploy_apply` to preview must be refused with `APPROVAL_REQUIRED`, and the message must name
   `generate BETTER_AUTH_SECRET`.
3. The owner approves in Studio. The agent's retry with the `approvalId` deploys. The bundle imports `node:crypto`
   (better-auth), so the upload carries `compatibility_flags: ["nodejs_compat"]`; the address must answer `/healthz`.
4. A user signs up and signs in by email on the deployed preview (`/api/auth/sign-up/email`, `/api/auth/sign-in/email`).
5. The value Studio generated is read from the run's own local vault. No Studio answer the run received (HTTP or MCP) may
   hold it, and it is added to the secrets every evidence file is checked against.
6. It tears down and writes `evidence/deployed/studio-core-auth-result.json` and `studio-core-auth-calls.json` as above. The
   invoice-flow evidence is left alone.

## What it creates

Every resource is named `px-tangebricks-test-<8 hex>-...`, a prefix separate from `projectx-poc-*`. For each environment
(preview and production) it creates:

- a D1 database, `...-<env>-db`;
- a Worker, `...-<env>`, with its workers.dev address switched on;
- a Workflow, `...-<env>-graphs`, for class `GraphRunner`.

The run is safe in these ways:

- **It refuses to start** if the account already holds a `px-tangebricks-test-*` Worker, database, Workflow or queue that its
  ledger does not list.
- **Writes are guarded.** Every write, from Studio or from the script, passes a guard. The guard refuses a name without this
  run's own prefix, and a database or queue id that the run did not create or list under that prefix.
- **Creates are recorded first.** Each create is written to the ledger (`<state-dir>/studio-ledger.json`) before it is sent.

## Teardown

The run tears down at the end, and also when it fails. If it was interrupted, run:

```
node --env-file=<path-outside-repo>/.env scripts/live-studio-deploy.ts --state-dir <path-outside-repo>/studio-state --teardown
```

This deletes exactly what the ledger lists, through the same guard. It reports any prefixed resource that the ledger does not
know, and leaves that resource alone.

## Offline

`scripts/test/live-studio-deploy.node.test.ts` runs the whole flow against the fake Cloudflare
(`packages/deploy/test/support/fake-cloudflare.ts`) and a small stand-in for the deployed Worker. It proves the script's logic
without the network. It does not prove that Cloudflare behaves as documented: only the live run settles that. Endpoints not yet
exercised against the live API are marked in `packages/deploy/src/provisioner/cloudflare.ts`.

## What Studio does on a real deploy

- It bundles the Worker and uploads it under the bundle's own sha256 (gate and runtime included), so a change in any layer
  redeploys and the drift check compares the account against what was really uploaded.
- "No changes" is judged against the account: the Worker's annotated code hash, the database's own state table and
  migrations. A Worker missing in the account is redeployed whatever Studio remembers.
- Secrets: Studio keeps an HMAC of each secret value (never the value). A changed value (a rotated root secret, a new vault
  value) is put again; a secret no longer bound is deleted. A brick secret bound to a vault entry that is gone fails the deploy
  with 422 `SECRET_NOT_IN_VAULT`.
- Generated secrets (story 1.19): a brick secret its manifest marks `"generate": "random-32-bytes"` is made by Studio on a
  preview deploy, after the deploy's approval (an MCP token's deploy needs one, AD-V8; the approval's fingerprint and summary
  name the secrets it generates). Studio takes 32 random bytes from Web Crypto, seals them in the vault as a `brick_secret`
  row (key hint `generated`, never the value's last characters), binds the ref, and deploys. A redeploy reuses the stored
  value. Production never generates: it stays `MISSING_REQUIRED_SECRETS` until the owner binds a value or promotes from
  preview. An `"optional": true` secret never blocks.
- A bundle that imports `node:*` is uploaded with `compatibility_flags: ["nodejs_compat"]`; one that does not is uploaded with
  the same metadata as before.
- After an upload or a secret change it runs the same keyed smoke check as the CLI provisioner (`/healthz` with the access
  key). A Worker that does not answer fails the deploy with 502 `SMOKE_CHECK_FAILED`.
- A Cloudflare failure is answered as a structured error with Cloudflare's code: 422 `NO_WORKERS_DEV_SUBDOMAIN`, 502
  `CLOUDFLARE_ERROR` or `CLOUDFLARE_UNREACHABLE`. The audit log records the steps done and every write call made before it.
- Each request or deploy gets its own client, so its call log and the token it holds end with the request. The request budget
  is per process and per account (not per user), kept in a bounded LRU.

## Known limit

Studio uploads a bundled Worker, which needs esbuild. A Studio running in Node (the live script) bundles with `bundleWorker`.
A Studio that runs as a Worker has no bundler, so its real deploy route refuses with 501 `DEPLOY_BUNDLER_NOT_CONFIGURED`
rather than upload unbundled TypeScript.
