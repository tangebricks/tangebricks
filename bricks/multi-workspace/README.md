# @poc/multi-workspace

Workspaces, memberships with roles, single-use invites, and the workspace guard every workspace-scoped brick sits
behind. `workspaceMiddleware` resolves the caller's workspace from the `x-workspace-id` header, refuses anyone who is
not a member, and sets the verified `ctx` (`{ userId, workspaceId, role }`) and `workspace` variables for the routes
after it.

Exports: `createWorkspaceRoutes`, `workspaceMiddleware`, `requireNotSuspended`, `requireWorkspaceId`,
`getRequestContext`, `rejectForeignWorkspace` and the `WorkspaceEnv` types.

## Routes

Every route needs a signed-in `user` (401 otherwise) and refuses API keys. A caller who is not a member of the workspace
named in the path gets 404, so a workspace's existence never leaks. Writes on a suspended workspace answer 403
`WORKSPACE_SUSPENDED`. Roles rank `owner` > `admin` > `member`.

| Route | Who | What |
|---|---|---|
| `GET /workspaces` | anyone | The caller's workspaces, with their role in each. |
| `POST /workspaces` `{ name }` | anyone | Creates a workspace with the caller as owner. |
| `GET /workspaces/:id` | member | One workspace. |
| `PATCH /workspaces/:id` `{ name }` | admin, owner | Renames it. |
| `DELETE /workspaces/:id` | owner | Deletes it, with the other bricks' data (see `workspaceDataPurge`). |
| `GET /workspaces/:id/members` | member | `{ members: [{ userId, role, joinedAt }] }`. |
| `PATCH /workspaces/:id/members/:userId` `{ role }` | see below | Sets a member's role. |
| `DELETE /workspaces/:id/members/:userId` | strictly higher rank, or self | Removes a member; never the last owner (409 `LAST_OWNER`). |
| `POST /workspaces/:id/invites` `{ role?, email?, expiresInSeconds? }` | admin, owner | A single-use invite at or below the caller's role. |
| `GET /workspaces/:id/invites` | admin, owner | Unused invites, each with `expiresAt` and `expired`. |
| `DELETE /workspaces/:id/invites/:token` | admin, owner | Revokes an unused invite (404 if there is none). |
| `GET /workspaces/invites/mine` | anyone | Unused, unexpired invites addressed to the caller's email, with the workspace name. |
| `POST /workspaces/invites/:token/accept` | anyone | Joins the workspace with the invite's role. |

- **Invites.** `email` (optional) is stored lower-cased; only a caller whose verified `user.email` matches it, ignoring
  case, can accept (403 `INVITE_EMAIL_MISMATCH`), and it shows in that caller's `/workspaces/invites/mine`.
  `expiresInSeconds` (optional, 60 seconds to 90 days) sets `expiresAt` (ISO-8601, UTC); past it, accept answers 410
  `INVITE_EXPIRED`. Without them an invite is open to anyone with the token and never expires. An invite whose inviter
  is no longer a member at or above its role is revoked (403 `INVITE_REVOKED`). Accept never changes an existing
  member's role (409 `ALREADY_MEMBER`).
- **Roles.** `PATCH /workspaces/:id/members/:userId` needs a caller ranking strictly above both the member's current
  role and the new one. So an owner moves members and admins between `member` and `admin`, and an admin cannot promote
  anyone. Nobody makes or unmakes an owner here, so the last owner is always kept, and nobody changes their own role.

## Adopting existing tables

An app that already keeps workspaces, members and invites in its own tables can expose them to this brick as `mw_*`
views with `INSTEAD OF` triggers instead of applying the migrations, so nothing is copied. See
[Adopting existing tables](../../docs/adopting-existing-tables.md) and `fixtures/adopt-existing-tables/`.

## Using outside the monorepo

See [Using bricks outside the monorepo](../../docs/using-bricks-outside-the-monorepo.md) for the whole flow, and
`fixtures/external-app/` for a working project.

- **Install from a tarball.** Nothing is published to a registry. Run `pnpm pack` here and in `packages/sdk`, then
  depend on both tarballs (`file:` paths) and override `@poc/sdk` to the sdk tarball, so this brick's `@poc/sdk`
  dependency resolves to it. Runtime dependencies: `@poc/sdk`, `hono` and `zod`.
- **TypeScript sources.** `exports` point at `src/index.ts`; bundle with wrangler or esbuild.
- **Mount.** Mount the routes and put the guard in front of every workspace-scoped path of the other bricks:

  ```ts
  import { Hono } from "hono";
  import { createWorkspaceRoutes, requireNotSuspended, workspaceMiddleware } from "@poc/multi-workspace";

  const app = new Hono();
  app.use("*", yourIdentityMiddleware); // sets c.set("user", { uid, email? })
  for (const path of ["/wallet", "/wallet/*", "/payments/create-order", "/audit", "/audit/*"]) {
    app.use(`/v1${path}`, workspaceMiddleware);
    app.use(`/v1${path}`, requireNotSuspended);
  }
  app.route("/v1", createWorkspaceRoutes());
  ```

  The guarded paths are the other bricks' manifest `guardPaths`, which carry the assembler's `/api` prefix: swap in
  your own. This manifest names `requireNotSuspended` as the guard's `suspension`; the assembler mounts it right after
  `workspaceMiddleware` on every guarded path, and so should you, or a suspended workspace keeps working (for example,
  it can still spend credits).

  The routes (listed above) are relative to wherever you mount them. `createWorkspaceRoutes({ workspaceDataPurge })` takes an
  optional hook that deletes other bricks' rows when a workspace is deleted; without it a delete removes only this
  brick's rows.
- **Migrate.** Apply the files listed under `migrations` in `brick.manifest.json`, in that order, to the D1 database
  bound as `DB` (with wrangler, after renaming the copies so they sort in manifest order across bricks; or with
  `applyMigration` from `@poc/sdk`, called from bundled worker code). Apply this brick's migrations before the bricks that require
  `workspace-context`.
- **Identity.** The brick authenticates no one. An earlier middleware of yours must verify the caller and set
  `user` to `{ uid, email? }`; without it every route answers 401. Set `email` only from a verified source: emailed
  invites trust it. oidc-verify sets both from the token.
