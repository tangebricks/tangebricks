# @poc/platform-admin

A console for platform operators: the people who run an app made of many workspaces. It grants credits, suspends and
unsuspends workspaces, sets per-workspace feature-flag overrides and, if you turn it on, approves new users. Every change
is written to the audit trail, and nothing in it can act as another user.

It replaces the safe functions of `admin-console`, which stays quarantined (story 0.11): admin-console let anyone make
themselves a super-admin, had impersonation routes with no role check, and its "suspend" wrote a status column the
assembled app never reads.

Exports: `createPlatformAdminRoutes`, `requireApprovedUser` (the approval gate), `PLATFORM_AUDIT_SCOPE`, the approval
helpers (`findApproval`, `listApprovals`, `approvalStatusFor`) and the option types.

## Who is an operator

An operator is a user whose id is listed in the `PX_PLATFORM_OPERATORS` env var, comma-separated:

```sh
wrangler secret put PX_PLATFORM_OPERATORS   # e.g. usr_8f2c41,usr_77ab09
```

- The list is the only source. No workspace role (an owner included), request header or body field makes anyone an
  operator.
- No value or an empty value means nobody is an operator, so every route here answers 403 (fail closed).
- The check (`isPlatformOperator` from `@poc/sdk`) runs before any input is read, on every route.
- A request with no session answers 401, and anyone not on the list gets 403 `NOT_PLATFORM_OPERATOR`.
- API keys are refused: 403 `API_KEY_FORBIDDEN` inside the brick. In an assembled app a key is never even an identity on
  these routes, because they are outside the workspace-guarded paths, so a key alone gets 401.
- The routes are not behind the workspace guard, because operators act across workspaces. Each one still needs the
  signed-in session identity.

## Actions

All routes are under `/api/platform`. Every change needs a `reason` in the body (1 to 500 characters), which is recorded
in its audit row. Every change is rate-limited per operator (bucket `platform-admin-write`, 120 a minute; change it with
`PX_RATE_LIMITS`).

| Route | What it does |
|---|---|
| `GET /workspaces?limit=&after=` | Lists the workspace registry in id order, in pages of at most 100 rows. |
| `GET /workspaces/:id` | Shows one workspace's registry row, wallet balance and flag overrides. It never shows the workspace's data. |
| `POST /workspaces/:id/credits` `{ amount, reason, idempotencyKey }` | Grants credits. `amount` has up to 3 decimals, must be above zero and is capped by the `maxGrantCredits` setting (default 1,000,000). It goes through credit-wallet's `walletCharger.grant`, a top-up tagged `op: "grant"` under the wallet key `platform-grant:<idempotencyKey>`. A retry with the same key and amount is a duplicate; the same key with another amount is 409 `IDEMPOTENCY_KEY_REUSED`. The prefix reserves nothing: the workspace's own routes share the key space (story 2.5), so if a tenant already used that wallet key the grant is 409 `IDEMPOTENCY_KEY_REUSED` too; retry with another key. A workspace with no wallet gets one only while it is live (registered and not suspended); otherwise the answer is 404 `WALLET_NOT_FOUND`. Without credit-wallet the route answers 503 `NOT_CONFIGURED`. |
| `POST /workspaces/:id/suspend` `{ reason }` | A workspace that is not suspended gets `mw_workspaces.suspended = 1` with `suspended_reason = "operator"`, through the sdk's `setWorkspaceSuspended`; the assembled app enforces the flag (story 1.10). Its members then get 403 `WORKSPACE_SUSPENDED` on every brick route behind the workspace guard. Already suspended by an operator: 200 `{ changed: false }`, no audit row. Suspended for any other reason, or with none: 409 `SUSPENDED_OTHERWISE` (an operator never takes over someone else's suspension). The delete route (story 1.10) only retries its own `"deleting"` fence, and its fence never overwrites a suspension, so the owner cannot delete a workspace an operator suspended. |
| `POST /workspaces/:id/unsuspend` `{ reason }` | Clears only an operator suspension, which restores access. Not suspended: 200 `{ changed: false }`, no audit row. Any other reason, or none: 409 `SUSPENDED_OTHERWISE`. |
| `GET /audit/pending?limit=&after=` | Lists operator audit rows still waiting for an outcome (a grant whose outcome row could not be written), across every workspace, in pages of at most 100. |
| `PUT /workspaces/:id/flags/:flagKey` `{ enabled, reason }` | Sets the workspace's override through feature-flags' `flagOverrides`. Setting the current value is a no-op (200 `{ changed: false }`, no audit row); if the override or the workspace's delete fence changes while the request runs, nothing is written and the answer is 409 (`CHANGED_CONCURRENTLY` or `WORKSPACE_DELETING`). It obeys feature-flags' `allowWorkspaceOverrides` setting (story 1.12): when that is off the answer is 409 `OVERRIDES_DISABLED`. An unknown flag is 404. |
| `DELETE /workspaces/:id/flags/:flagKey` `{ reason }` | Clears the override, under the same rules. Without feature-flags both flag routes answer 503. |
| `GET /users?status=pending&limit=&after=` | Lists approval records by status (`pending`, `approved` or `rejected`), in pages of at most 100. |
| `POST /users/:uid/approve` `{ reason }` | Approves a user. This works before they have ever signed in. |
| `POST /users/:uid/reject` `{ reason }` | Rejects a user. The gate then refuses them again. |

An unknown workspace is 404. With no workspace registry (no multi-workspace brick), every workspace route (reads,
grants, suspension, flags) answers 503 `NOT_CONFIGURED`. A workspace whose delete is in progress (story 1.10's fence,
`suspended_reason = "deleting"`) is refused with 409 `WORKSPACE_DELETING`, and nothing is written. Suspension and flag
writes also repeat that check inside their guarded write; a grant checks it once, before the wallet call (see the
residual under the audit guarantee). A user decision is guarded by the status read before it: if it changed meanwhile,
the answer is 409 `CHANGED_CONCURRENTLY` and nothing is written. `idempotencyKey` is 1 to 177 characters, so the audit
dedupe key built from it fits.

## The audit guarantee

Every change writes an audit-trail row in the target workspace's `audit_events`, through audit-trail's declared
`auditRecorder` export. A user decision goes to the platform scope instead, `_platform`, because a person belongs to no
single workspace. The row holds:

- the actor: the operator's id;
- the action name (`platform.credits.grant`, `platform.workspace.suspend`, `platform.workspace.unsuspend`,
  `platform.flag.set`, `platform.flag.clear`, `platform.user.approve` or `platform.user.reject`);
- the target;
- a before/after summary;
- the reason.

A change whose audit row cannot be written is not applied, and the log stays append-only (no row is ever changed):

- **Suspension, flag overrides and user decisions** run the change and the audit insert in one D1 batch. Both commit,
  or neither does. The change repeats its rule in its own WHERE (for flags: the value read before, and that the
  workspace is not being deleted), and the audit insert right after it is written only if the change changed a row
  (`changes() > 0`), so a no-op, a vanished workspace or a lost race leaves no row. The audit `before` records the
  previous state, including the suspension reason.
- **Credit grants** use the wallet's own batch, so a row is written first with `status: "pending"` and the request's
  idempotency key, at most once per workspace and key (a unique dedupe key, so concurrent first attempts and retries
  share one row). The wallet changes only after that row exists; if it cannot be written, the answer is 503
  `AUDIT_UNAVAILABLE` and nothing is granted. Afterwards an outcome row (action `audit.outcome`, target the pending row's
  id) records `applied`, `refused` or `failed`, unless the latest outcome already says the same; a grant that took
  effect on an earlier attempt ends `applied`. `GET /api/platform/audit/pending` lists pending rows with no outcome.
  Known residuals: a grant checks the workspace's delete fence once, before the wallet call, so a grant that lands
  after a delete has fenced the workspace is applied to a wallet the delete then purges; and any grant to a workspace
  deleted later goes with its wallet. In both cases the grant's audit rows (pending and outcome) stay.
- Every capability row carries a marker (`audit_events.via_capability`, audit-trail migration 0002) that the public
  `POST /api/audit/events` route never writes, and that route refuses the reserved `platform.*` and `audit.*` actions;
  the recorder's reads (pending rows, outcomes) look only at marked rows, so a workspace member cannot plant a pending
  grant or an outcome.
- The only statements another brick's write accepts alongside its change are made by the sdk's structured
  `auditStatement` builder (fixed SQL, no caller SQL, actor types `user` and `system` only, with `afterChange`), for the
  workspace being changed; anything else throws.

The routes never write another brick's tables themselves. Every change goes through the owner's declared capability
(`walletCharger`, `flagOverrides`, `auditRecorder`) or the sdk's `setWorkspaceSuspended`. That helper is the only write
any brick but multi-workspace makes to the workspace registry, and it touches only the `suspended` column.

## No impersonation

No route, token, header or session switch here acts as another user. The brick never sets the request's user or
workspace context, mints no session or token, and has no "view as" mode. A test fails if a route path or export ever
offers one.

## The user approval gate (opt in)

Set `requireUserApproval: true` (default `false`) in the blueprint:

```json
{ "id": "platform-admin", "config": { "requireUserApproval": true } }
```

With the setting on, the assembler mounts `requireApprovedUser` on every workspace-guarded path. It runs after the
identity step and before the workspace guard.

- A signed-in user who is not approved gets 403 `USER_NOT_APPROVED`.
- Their first such request creates a `pending` row in `pa_user_approvals`, so operators see them in the pending list.
- Operators exempt themselves.
- A request authenticated by an API key is judged by the key's creator (the person it acts for, which the key's
  identity step exposes as `apiKeyCreator`): a key whose creator is pending or rejected gets 403 `USER_NOT_APPROVED`,
  and so does a key whose creator is unknown.
- A request with no session passes to the guard, which answers 401.
- If the table cannot be read, the request is refused.

With the setting off (the default), no gate is mounted and the assembled app is exactly as it would be without the
setting.

Routes outside the workspace guard are not gated: creating a workspace, the user's own profile, and sign-in.

`pa_user_approvals` is a platform table (no `workspace_id`). Its privacy rule is `subject: "user"`, `userColumn:
user_id`, `export: true`, `erase: "retain"` and `platformWide: true`: a user's own data export (they are the requester)
includes their approval record, an export of someone else by a workspace owner never does, and an erasure keeps it as
an access-governance record (reported in the erasure's `retain` list). Only a first-party, non-isolated,
non-quarantined brick may declare a `platformWide` table, and only one of its own global tables.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `maxGrantCredits` | 1000000 | The largest single grant, in whole credits. |
| `requireUserApproval` | false | Turns the approval gate on. |

## Requires

- `workspace-context` (multi-workspace).
- `audit-logging` (audit-trail), required: no audit row, no change.
- Optional: credit-wallet for grants, and feature-flags for overrides. Each is wired when it is enabled. The routes that
  need one that is missing answer 503 `NOT_CONFIGURED`.
