# @poc/multi-workspace

Workspaces, memberships with roles, single-use invites, and the workspace guard every workspace-scoped brick sits
behind. `workspaceMiddleware` resolves the caller's workspace from the `x-workspace-id` header, refuses anyone who is
not a member, and sets the verified `ctx` (`{ userId, workspaceId, role }`) and `workspace` variables for the routes
after it.

Exports: `createWorkspaceRoutes`, `workspaceMiddleware`, `requireNotSuspended`, `requireWorkspaceId`,
`getRequestContext`, `rejectForeignWorkspace` and the `WorkspaceEnv` types.

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

  The routes are `/workspaces`, `/workspaces/:id`, `/workspaces/:id/invites`, `/workspaces/invites/:token/accept` and
  the member routes, relative to wherever you mount them. `createWorkspaceRoutes({ workspaceDataPurge })` takes an
  optional hook that deletes other bricks' rows when a workspace is deleted; without it a delete removes only this
  brick's rows.
- **Migrate.** Apply the files listed under `migrations` in `brick.manifest.json`, in that order, to the D1 database
  bound as `DB` (with wrangler, after renaming the copies so they sort in manifest order across bricks; or with
  `applyMigration` from `@poc/sdk`, called from bundled worker code). Apply this brick's migrations before the bricks that require
  `workspace-context`.
- **Identity.** The brick authenticates no one. An earlier middleware of yours must verify the caller and set
  `user` to `{ uid, email? }`; without it every route answers 401.
