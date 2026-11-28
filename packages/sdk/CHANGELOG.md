# Changelog

`@poc/sdk` stays at 0.0.0: it is consumed from this repository or as a packed tarball, never from a registry. Notable
changes are listed here.

## Story 2.11 — migration switch

New module `migration-switch`, exported from the package root, for any app moving onto bricks one route group at a time
(docs/migrating-an-existing-app.md). New exports:

- `parseRouteSwitch(raw)`: reads the switch value, `group:target` pairs separated by commas, targets `app`, `brick` and
  `shadow`; malformed pairs, bad group names and unknown targets are ignored.
- `resolveRouteTarget(raw, group, { hasBrick, allowShadow? })`, or `(raw, group, hasBrick)`, which never returns
  `shadow`: which code answers a group.
- `routeSwitch(group, brick?, { variable? })`: middleware for a whole-router group; sets `X-Route-Handler` to
  `brick:<group>` or `app:<group>` and notes the handler.
- `noteRouteHandler(c, group, handler)`: notes the handler of a group decided inline, for telemetry.
- `notedRouteHandlers(c)`: the handlers noted so far in the request; reads without writing.
- `migrationTelemetry({ dataset })`: root middleware writing one Workers Analytics Engine data point per noted group per
  request (index `group`, blobs `[group, handler, statusClass]`, doubles `[1]`); each point is written on its own, and a
  missing or throwing binding never affects the response.
- `isRouteGroupName(group)`: true for `^[a-z][a-z0-9-]*$` of at most 64 characters.
- `MAX_ROUTE_GROUP_LENGTH`: 64, the longest group name.
- `ROUTE_HANDLER_HEADER`: `"X-Route-Handler"`.
- `DEFAULT_ROUTE_SWITCH_VARIABLE`: `"ROUTE_SWITCH"`, the env var read unless `variable` names another.
- `ROUTE_HANDLERS_VAR`: `"px.routeHandlers"`, the Hono context variable holding the noted handlers.
- Types `RouteTarget`, `BrickRouter`, `ResolveRouteOptions`, `RouteSwitchOptions`, `AnalyticsEngineLike`,
  `MigrationTelemetryOptions`, `RouteStatusClass` (`1xx` to `5xx`, or `error`) and `ShadowReport`.

No existing export changes.

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
