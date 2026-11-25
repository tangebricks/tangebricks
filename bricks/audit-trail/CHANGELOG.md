# Changelog

## Unreleased (story 2.6: declared audit capability)

- `auditRecorder`, declared in `worker.capabilityExports` for `audit-logging`, so other bricks write audit rows through
  the assembler's `$capability` option instead of this brick's table: `statement()` (an sdk audit statement to run in
  the caller's own D1 batch, optionally only after a change), `record()` (optionally deduplicated by key), `outcome()`
  (an appended `audit.outcome` row; the log stays append-only), `latestOutcome()`, `pendingWithoutOutcome()` and
  `pendingAcrossWorkspaces()`. Actor types `user` and `system` only.
- Migration 0002: `via_capability` (the capability marker; the recorder reads only marked rows) and `dedupe_key`
  (unique per workspace when set). Additive: existing rows get 0 and NULL.
- `POST /audit/events` refuses the reserved `platform.*` and `audit.*` actions with 400 `RESERVED_ACTION`.

## 1.0.0 — initial versioned release
