# Changelog

## 1.1.0 — a host's own operator list, and writes through views (story 2.8)

- `isOperator` option: a host's own operator check, in place of `PX_PLATFORM_OPERATORS`. Only `true` admits; a resolver
  that throws or rejects admits nobody (500 `OPERATOR_CHECK_FAILED`). Without it, nothing changes.
- `createApprovalGate({ isOperator })`: the approval gate with the same check. `requireApprovedUser` is
  `createApprovalGate()`, unchanged.
- Suspension and user decisions work when `mw_workspaces` or `pa_user_approvals` is a view over the host's own table:
  the audit row is written under the change's own rule (sdk `auditStatementWhen`) instead of after it under
  `changes() > 0`, and the outcome is read back instead of taken from a change count. A decision and the gate's pending
  row are inserted with `INSERT ... SELECT ... WHERE NOT EXISTS` (no upsert clause, which SQLite refuses on a view).
  Same answers and the same rows on plain tables.
- README: the change-count caveat under "Through views" is gone; the `pa_user_approvals` view contract is documented.

## 1.0.1 — usable outside the monorepo (story 2.8)

- README: a "Using outside the monorepo" section; the external-app test packs and installs the package. No behaviour
  change.

## 1.0.0 — initial versioned release (story 2.6)

- Platform operator routes under `/api/platform/*`, for the user ids in `PX_PLATFORM_OPERATORS` only (fail closed);
  API keys are refused.
- Credit grants (through credit-wallet's `walletCharger.grant`), workspace suspension (through the sdk's
  `setWorkspaceSuspended`), per-workspace flag overrides (through feature-flags' `flagOverrides`), and an opt-in user
  approval gate (`requireUserApproval`).
- Every change writes an audit row through audit-trail's `auditRecorder`; a change whose audit row cannot be written is
  not applied.
- No impersonation of any kind.
