# Import boundaries

Bricks are meant to be installable on their own and to work in any app (R9, R11). That only holds if a brick
imports nothing it does not declare and never reaches into another brick's files. `pnpm lint:deps` checks this
with [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) on every pull request (CI `gates` job).
The settings are in `.dependency-cruiser.cjs`; `scripts/test/import-boundaries.node.test.ts` shows that a seeded
violation fails the gate.

Added in story 1.30 (ticket 30).

## Rules

| Rule | From | Forbids |
|---|---|---|
| `brick-no-path-into-other-brick` | `bricks/<a>/**` | any import that resolves to a file in `bricks/<b>/` |
| `brick-no-path-outside-brick` | `bricks/<a>/**` | a relative or absolute path import that leaves `bricks/<a>/` (into `packages/`, `apps/`, `test/`, `scripts/`, ...) |
| `brick-undeclared-dependency` | `bricks/<a>/**` | a package that `bricks/<a>/package.json` does not declare in `dependencies`, `devDependencies` or `peerDependencies` |
| `brick-unresolvable` | `bricks/<a>/**` | an import that does not resolve, for example a deep path (`@poc/credit-wallet/src/wallet.ts`) that the package's `exports` does not offer |
| `package-no-path-into-brick` | `packages/**` | any import that resolves to a file in `bricks/<b>/` by path; a package uses `@poc/<brick>` instead |
| `package-no-app` | `packages/**` | any import of `apps/**` |
| `no-app-package-import` | `packages/**`, `bricks/**` | an app package imported by name (`@poc/studio-api`, `@poc/studio-web`). With `preserveSymlinks` such an import resolves under `node_modules/@poc/studio-*`, not `apps/`, so `package-no-app` alone would miss it |

So a brick's `src`, `test` and `client` import only: their own files by relative path; `@poc/sdk` (which every brick
declares); packages listed in their own `package.json`, through the entry point and `exports`; node built-ins; and
`cloudflare:workers`, `cloudflare:test`, `cloudflare:workflows`, `cloudflare:sockets` and `cloudflare:email`.
Another `cloudflare:*` module has to be added to `builtInModules` in the config first.

`package-no-path-into-brick` is not one of the three rules the story asked for. It is there because the
deploy -> credit-wallet decision below would otherwise not be enforced, and because a package reading a brick's
internal files breaks the same installability as a brick doing it.

## How imports are resolved

- **Workspace packages** (`@poc/*`): `preserveSymlinks` is on, so `@poc/x` resolves through the importing package's
  own `node_modules/@poc/x` symlink. dependency-cruiser then sees it as a dependency of that package
  (`npm`, `npm-dev`, `npm-peer`) and checks it against that package's own `package.json`. An import that is not
  declared falls through to the root `node_modules` and is reported as `npm-no-pkg`.
- **`exports`** are honoured, so a deep import that a package does not export does not resolve.
- **TypeScript**: the root `tsconfig.json` is read (there are no `paths` aliases); `.ts` extensions in imports
  (`allowImportingTsExtensions`) resolve as written; `import type` counts (`tsPreCompilationDeps`).
- **`?raw` imports** are file reads, not modules. dependency-cruiser drops the `?raw` query before the rules run,
  so it cannot tell `x.sql?raw` from `x.sql`. Every `.sql` import in the repo is a `?raw` migration read, so
  `.sql` files are excluded. Brick and package tests also read their own `.ts` files with `?raw`; those stay
  inside their own package and pass. A `.ts?raw` or `.json?raw` read across a boundary would be reported like
  an import (stricter than needed, never looser).

## Scope

`bricks/`, `packages/` and `apps/`, test files included. Generated, recorded and build output (`out/`,
`fixtures/`, `dist/`, `coverage/`, `evidence/`, `.wrangler/`, `node_modules`, `.d.ts` files,
`packages/assembler/catalog.generated.ts`, `apps/studio-web/src/catalog-data.json`) are not scanned and not
followed, but an import of one of them is still checked. `apps/*` are scanned; no rule restricts what an app imports.

## Fixes made in story 1.30

Behaviour-neutral fixes, so these are no longer exceptions:

- **Undeclared packages declared.** Every brick test imports `vitest`, which only the root `package.json`
  declared; it is now a `devDependency` (`5.1.1`, the root's pin) of every brick. Also declared:
  `@poc/harness` (audit-trail, dynamic-entities, multi-workspace), `@poc/dynamic-entities` and
  `@poc/multi-workspace` (core-auth), `@poc/assembler` (cron-alarms, data-privacy-gdpr, queue-jobs, workflow-dag),
  `@poc/runtime` and `@poc/core-nodes` (queue-jobs), `react` and `@testing-library/react` (credit-wallet and
  integration-connections, for the client UI and its tests). integration-connections exports its client UI
  (`"./client"`) and ships it, so `react` is also its `peerDependency`: the app supplies React. credit-wallet's
  client is not exported and not in its tarball (`files`), so `react` stays dev-only there.
  `integration-connections` and `webhook-gateway` import `@poc/assembler` from `src`, so it is in their
  `dependencies` (workspace packages are not part of a manifest's `npmDependencies`). pnpm links each to the same
  copy the root uses, so no test loads a second `vitest` or `react`. The lockfile change is additions only.
- **Path imports switched to the package entry** (and the package declared):
  - `bricks/checkout-gateway/test/checkout-webhook.test.ts`: `../../credit-wallet/src/gateway.ts` -> `@poc/credit-wallet`
  - `bricks/platform-admin/test/platform-admin.test.ts`: audit-trail, feature-flags and credit-wallet `src/index.ts` -> `@poc/audit-trail`, `@poc/feature-flags`, `@poc/credit-wallet`
  - `bricks/subscription-plans/test/plan-credits.test.ts`: `../../credit-wallet/src/index.ts` -> `@poc/credit-wallet`
  - `bricks/queue-jobs/test/batch-primitive.test.ts`: `../../../packages/core-nodes/src/index.ts` -> `@poc/core-nodes`
  - `packages/deploy/client/support/rehearsal-world.ts`: `bricks/credit-wallet/src/index.ts` -> `@poc/credit-wallet`

Files that feed the proof `inputsHash` (`packages/*/src`, `packages/*/test`, and credit-wallet, multi-workspace and
dynamic-entities) and the five H12 glue files pinned by sha256 were not edited, so `proof:check` and the H12 record
are unchanged.

## Exceptions

Each exception is one source file and the exact files it may import. They are listed, with their reasons, in
`EXCEPTIONS` in `.dependency-cruiser.cjs`. Any other import from those files is checked by the plain rule. The test
fails if an exception names an import that no longer exists, so the list only shrinks. All are test or demo code; no
brick `src` and no package `src` other than `packages/deploy/src/h5-hosted.ts` is excepted.

### `brick-no-path-into-other-brick` (30 files)

- **multi-workspace test stubs.** `bricks/multi-workspace/test/support/stub-workspace-context.ts` is imported by the tests of
  admin-console, agent-sandbox, audit-trail (3 files), checkout-gateway (2), document-pdf, edge-traffic-armor,
  identity-federation, live-chat, marketplace-splits, metered-usage, outbound-webhooks, product-analytics,
  queue-jobs (2), realtime-presence, search-faceted, tabular-engine, threaded-discussions and vector-memory.
  `bricks/multi-workspace/test/support/stub-identity.ts` is imported by credit-wallet (4 files, one in `client/test`),
  dynamic-entities' `H8.router.test.ts` and integration-connections' `client/test/connect-account-widget.test.tsx`.
  Why: they are test code, so they are not in `@poc/multi-workspace`'s exports or tarball, and the credit-wallet and
  dynamic-entities copies feed the proof inputsHash.
- **credit-wallet's SQLite D1 test adapter.** `bricks/credit-wallet/client/test/support/sqlite-d1.ts` is imported by
  scripting-sandbox's `escape.node.test.ts` and `noninterference.node.test.ts` and by integration-connections'
  `connect-account-widget.test.tsx`. Why: test code, not part of `@poc/credit-wallet`'s exports.

Follow-up for both: a shared test-support workspace package that bricks declare as a `devDependency`.

### `brick-no-path-outside-brick` (4 files)

`bricks/cron-alarms/test/cron.test.ts`, `bricks/queue-jobs/test/jobs.test.ts`, `bricks/workflow-dag/test/workflow.test.ts`
and `bricks/data-privacy-gdpr/test/erasure-coverage.test.ts` import the repo's test harness
(`test/support/emitted-worker.ts`, `test/support/blueprints.ts`, and for data-privacy-gdpr `scripts/max-compatible.ts`)
to assemble and run a project. Why: the harness is repo tooling, not a package to declare.

### `package-no-app` (6 files)

`packages/assembler/test/openapi-emission.test.ts`, `packages/harness/test/cohort-1-simulation.test.ts`,
`packages/mcp-server/test/deploy-real-client.node.test.ts`, `self-correction.test.ts` and `tools-surface.test.ts`
(which also use `apps/studio-api/test/human-session.ts` and `project-token.ts`) import `apps/studio-api/src/index.ts`;
`packages/deploy/test/data-browser-isolation.test.ts` imports `apps/studio-api/src/telemetry-reads.ts`. Why: they are
integration tests that drive the Studio API end to end. They live in `packages/*/test`, which feeds the proof
inputsHash, so moving them under `apps/` is a separate change. No package `src` imports an app.

### `package-no-path-into-brick` (15 files)

- Package tests that import brick source by path: `packages/assembler/test/llm-gateway-billing.test.ts` and
  `oidc-denial.test.ts`, `packages/core-nodes/test/core-nodes.conformance.test.ts`,
  `packages/integrations/test/pack-v1-contract.workerd.test.ts`, `packages/mcp-server/test/mcp.test.ts`,
  `packages/runtime/test/case-a-connections.test.ts`. Why: `packages/*/test` feeds the proof inputsHash; switching
  them to `@poc/<brick>` is a separate change with an evidence refresh.
- `packages/mcp-server/test/discovery.node.test.ts`, `interop.node.test.ts` and `support/session.ts` import
  credit-wallet's SQLite D1 test adapter (see above).
- `packages/deploy`: see the next section.

## `packages/deploy` and credit-wallet

`packages/deploy/package.json` lists `@poc/credit-wallet` in `dependencies`. The imports are:

| File | Imports | What it is | Decision |
|---|---|---|---|
| `src/worker/catalog-bricks.ts` | `@poc/credit-wallet` (package entry) | The deployed Worker's executors: `DEPLOY_PACKAGE_EXPORTS` wires the wallet's package exports so the catalog's `debit` action does the real D1 deduction (story 1.1). | **Allowed.** A declared package dependency through the entry point, which the rules allow. This is why the dependency exists. |
| `client/demo-entry.tsx`, `client/support/widget-driver.tsx` | `bricks/credit-wallet/client/CreditWidget.tsx`, `wallet-client.ts` | The H12 demo page and the widget driver. | **Narrow exception.** The client UI is not in the brick's `exports` (the tarball does not ship it), and both files are H12 glue files whose sha256 the recorded live run pinned (`GLUE_SCAN_FILES`). |
| `client/live/H12.live.test.tsx`, `client/test/H12.rehearsal.test.tsx` | `bricks/credit-wallet/client/wallet-client.ts` | H12 live test and offline rehearsal. | **Narrow exception**, same reason. |
| `client/support/rehearsal-world.ts` | `@poc/credit-wallet` (was `bricks/credit-wallet/src/index.ts`); `bricks/credit-wallet/client/test/support/sqlite-d1.ts`; `bricks/multi-workspace/test/support/stub-identity.ts`; wallet and workspace migrations as `?raw` | The H12 offline rehearsal world. | The `src` import now goes through the package entry. The two test helpers are a **narrow exception** (test code, not exported). Migration reads are file reads. |
| `src/h5-hosted.ts` | `bricks/credit-wallet/src/index.ts`, `bricks/credit-wallet/test/support/workload.ts` | H5's hosted-D1 proof harness: runs the wallet's own code and the local sweep's workloads against hosted D1 (`pnpm poc:h5-hosted`). Not part of the deployed Worker. | **Narrow exception.** It needs the wallet's test workload, which is not exported, and `packages/deploy/src` feeds the proof inputsHash (and `scripts/mutate-h5-hosted.ts` mutates this file), so it stays as recorded. Follow-up: import `createWallet` and `createFakeGateway` from `@poc/credit-wallet` at the next evidence refresh. |

The dependency stays: the deployed Worker needs the wallet's executors, and every other import is test, proof or demo
code.

## Version and cost

`dependency-cruiser` is pinned at `18.7.2` (published 2026-11-02), the newest release at least two weeks older than
the day it was added (2026-11-27); 18.8.0 (2026-11-16) and 18.9.0 (2026-11-22) were too recent.

On Windows 11 (Intel i5-12450H, 12 threads, Node 24.14.0), `pnpm lint:deps` cruises about 1,200 modules and
4,070 dependencies in about 3.2 s with a peak working set of about 500 MB (three runs: 3.21 s / 479 MB,
3.14 s / 499 MB, 3.13 s / 502 MB).
