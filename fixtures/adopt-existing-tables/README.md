# Adopt existing tables fixture

An app that kept its own workspace tables before it used any brick, and the SQL that lets the multi-workspace brick
work on them in place.

- `app-tables.sql`: the app's tables, `teams`, `team_users` and `team_invites`, with its own column names, role words
  (`lead`, `manager`, `staff`) and invite expiry in epoch milliseconds.
- `mw-views.sql`: `mw_workspaces`, `mw_members` and `mw_invites` as views over them, with `INSTEAD OF` triggers for
  every write the brick makes, and one nullable column added to `team_invites` (`accepted_by`).

`bricks/multi-workspace/test/adoption-views.test.ts` applies both to workerd's D1 and runs the brick's routes, guard
and the sdk's registry helpers through the views. See [docs/adopting-existing-tables.md](../../docs/adopting-existing-tables.md).
