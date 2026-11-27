# Changelog

## Unreleased

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
