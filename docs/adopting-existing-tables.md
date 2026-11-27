# Adopting existing tables

An app that already stores workspaces, members and invites in its own tables can use the multi-workspace brick (and
every brick that reads its tables through `@poc/sdk`) without copying a row. Instead of applying the brick's
migrations, it creates `mw_workspaces`, `mw_members` and `mw_invites` as SQL views over its own tables, with
`INSTEAD OF` triggers that turn the brick's writes into writes on those tables. The brick's routes, `workspaceMiddleware`
and `requireNotSuspended` then read and write the app's rows in place, and the app's own code keeps working on the
same rows.

`fixtures/adopt-existing-tables/` is a worked example: `app-tables.sql` is an app with `teams`, `team_users` and
`team_invites` (its own column names, its own role words `lead` / `manager` / `staff`, and invite expiry in epoch
milliseconds), and `mw-views.sql` adopts them. `bricks/multi-workspace/test/adoption-views.test.ts` runs every
multi-workspace route through those views in workerd's D1 (create, invite, accept, list members, set a role, rename,
remove, revoke, delete) and checks that each row lands in the app's tables.

## The contract the views must meet

Each view must expose exactly these columns, with these meanings. Names and types are the brick's; how the app stores
them is up to the view.

| View | Columns |
|---|---|
| `mw_workspaces` | `id` (text, unique), `name`, `owner_id`, `suspended` (0 or 1), `suspended_reason` (text or null), `created_at` |
| `mw_members` | `workspace_id`, `user_id`, `role` (`owner`, `admin` or `member`), `joined_at`; one row per (workspace, user) |
| `mw_invites` | `token` (unique), `workspace_id`, `role`, `created_by`, `used` (0 or 1), `used_by`, `created_at`, `email` (lower-case or null), `expires_at` (ISO-8601 UTC or null) |

Rules for the triggers:

- **INSERT.** The brick inserts without `created_at`, `joined_at`, `suspended` or `suspended_reason` (a view has no
  column defaults), so `NEW.x` is null there: use `COALESCE(NEW.created_at, datetime('now'))` and so on, or let the
  app table's own default apply by leaving the column out.
- **UPDATE.** In an `INSTEAD OF UPDATE` trigger, `NEW` holds every column, the unchanged ones with their old values,
  so the trigger can write them all back. The brick updates `mw_workspaces.name`, `suspended` and `suspended_reason`,
  `mw_members.role`, and `mw_invites.used` and `used_by`.
- **DELETE.** Delete the matching app row by `OLD` key.
- **Mapped values.** Translate in both directions with `CASE` when the app's words differ (roles here), and convert
  formats in the view and the insert trigger (expiry here: `strftime('%Y-%m-%dT%H:%M:%fZ', ms / 1000.0, 'unixepoch')`
  one way, `CAST(round((julianday(iso) - 2440587.5) * 86400000.0) AS INTEGER)` the other).
- **Missing columns.** If the app has nowhere to keep a column the brick writes (here, who used an invite), add a
  nullable column to the app's table. That is the only change to the app's own tables, and it changes no existing row.
- **Constraints stay the app's.** A brick write the app's table refuses (a `CHECK`, `NOT NULL` or `UNIQUE`) fails the
  whole request with 500 and rolls back its batch. Map such values in the trigger, or keep the app from sending them
  (for example, an app whose invites cannot carry the owner role never sends one).

Apply the views and triggers in place of the brick's migrations, never both: the brick's `CREATE TABLE IF NOT EXISTS`
would be skipped for a name a view already has, and its `ALTER TABLE` statements would fail on a view. Dropping the
views later leaves the app's tables (and every row written through the views) as they are.

## What views cannot do, and what the bricks do instead

- **Change counts.** A write through an `INSTEAD OF` trigger does not report its changes the way a table write does:
  plain SQLite (including Node's `node:sqlite`) reports 0 changes, and D1 reports the trigger's own writes. So since
  multi-workspace 1.1.0 no route decides anything from `meta.changes` or `changes()`: accept, member removal, the delete
  fence, role changes and rename each read their outcome back. The single-use invite claim is a guarded `UPDATE`
  (`WHERE used = 0`) followed by an `INSERT ... SELECT ... WHERE EXISTS` on that claim, in one batch, then a read-back.
- **UPSERT.** SQLite refuses an `ON CONFLICT ... DO` upsert on a view ("cannot UPSERT a view"). An `INSERT OR IGNORE`
  or `OR REPLACE` on a view hands its conflict policy to the statements inside the trigger. The multi-workspace routes
  use none of these.
- **`sqlite_master`.** A view is listed with `type = 'view'`. The sdk's `hasWorkspaceRegistry` accepts a view, so
  suspension checks in other bricks (credit-wallet, platform-admin) find the registry.
- **Still counting.** The sdk's `setWorkspaceSuspended` (used by platform-admin) reports `changed` from the update's
  change count. Through views on plain SQLite it reports `changed: false` for a change it made; the row itself is
  written correctly. Adopt platform-admin's suspension routes with that in mind.

## Rolling back

Because the data never moves, switching an app back to its own code is dropping nothing: its code reads the same
tables it always did, including rows written through the views. Keep the views in place if any brick is still in use.
