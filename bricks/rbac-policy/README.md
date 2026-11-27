# @poc/rbac-policy

Custom roles and permissions inside a workspace. A role is a named set of `resource:action` permissions (`*` allowed on
either side); roles are assigned to members. `requirePermission(resource, action)` guards a route: the workspace owner
always passes, anyone else needs a role that grants the permission, or gets 403 `{ error: "Permission denied",
required }`. `rbacMiddleware` puts `c.get("rbac").can(resource, action)` on the request for checks inside a handler.

Exports: `createRbacRoutes`, `rbacMiddleware`, `requirePermission`, `RbacService` and the types. The routes manage roles
and assignments under `/roles` and `/policies`; `createRbacRoutes({ customRoles, knownPermissions })` turns custom roles
off or restricts permissions to a known list. Tables: `rbac_roles`, `rbac_permissions`, `rbac_role_assignments`.

## Using outside the monorepo

See [Using bricks outside the monorepo](../../docs/using-bricks-outside-the-monorepo.md) for the whole flow.

- **Install from a tarball.** Nothing is published to a registry. Run `pnpm pack` here and in `packages/sdk`, then
  depend on both tarballs (`file:` paths) and override `@poc/sdk` to the sdk tarball. Runtime dependencies: `@poc/sdk`,
  `hono` and `zod`.
- **TypeScript sources.** `exports` point at `src/index.ts`; bundle with wrangler or esbuild.
- **Mount.** The routes and `requirePermission` need the verified workspace: put multi-workspace's
  `workspaceMiddleware` (and `requireNotSuspended`) in front of `/roles`, `/roles/*`, `/policies` and `/policies/*`
  under your prefix, as the manifest's `guardPaths` say, then `app.route("/v1", createRbacRoutes())`.
- **Migrate.** Apply the files listed under `migrations` in `brick.manifest.json`, in that order, to the D1 database
  bound as `DB`, after multi-workspace's.
- **Identity.** The brick authenticates no one. Your identity middleware sets `user` (`{ uid, email? }`).
