# Changelog

`@poc/sdk` stays at 0.0.0: it is consumed from this repository or as a packed tarball, never from a registry. Notable
changes are listed here.

## Story 2.8 — writes through views

- `setWorkspaceSuspended` reads its outcome back instead of trusting the update's change count. Its audit statements run
  just before the update, in the same batch, under the update's own rule, so they are written exactly when the update
  applies. A registry that is a view over an app's own table (docs/adopting-existing-tables.md) now reports
  `changed: true` for a change it made, and writes its audit row, under plain SQLite and in D1 alike. Same results and
  rows on a plain table.
- `auditStatementWhen(db, made, condition)`: the row of an `afterChange` audit statement, written only if `condition`
  holds when it runs, for a writer whose change count cannot be trusted (a view). The writer passes its own guard and
  runs the insert before its write, in the same batch.
- `hasWorkspaceRegistry` accepts a view named `mw_workspaces`.
