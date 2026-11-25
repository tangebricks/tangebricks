# Changelog

## Unreleased (story 2.6: declared override capability)

- `flagOverrides`, declared in `worker.capabilityExports` for `feature-flags`: `list`, `set` and `clear` one
  workspace's override for another brick (platform-admin), under the same rules as the workspace routes. A flag must be
  defined, and `allowOverrides` (the app's `allowWorkspaceOverrides` setting, which the assembler hands the taking brick
  through `$capabilitySetting`, to first-party consumers only) must be true for a set or a clear (story 1.12). Each write
  is guarded by the value read before it and by an optional sdk workspace guard (for example: not being deleted), and
  answers `NOT_APPLIED` when the guard fails; a set to the current value and a clear of no override are no-ops.
  `alongside` takes sdk `afterChange` audit statements for the same workspace only (checked at run time), or a function
  building them from the value read; they run right after the write in its batch. `get()` reads one override.

## 1.0.0 — initial versioned release
