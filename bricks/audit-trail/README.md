# @poc/audit-trail

An append-only, per-workspace audit log with filtered listing and a CSV export. Events are always recorded in the
caller's verified workspace and in the caller's name; a body cannot set either.

Exports: `createAuditRoutes`, `AuditTrailService`, `auditContextMiddleware` and the `AuditEnv` types.

## Using outside the monorepo

See [Using bricks outside the monorepo](../../docs/using-bricks-outside-the-monorepo.md) for the whole flow, and
`fixtures/external-app/` for a working project.

- **Install from a tarball.** Nothing is published to a registry. Run `pnpm pack` here and in `packages/sdk`, then
  depend on both tarballs (`file:` paths) and override `@poc/sdk` to the sdk tarball. Runtime dependencies:
  `@poc/sdk`, `hono` and `zod`.
- **TypeScript sources.** `exports` point at `src/index.ts`; bundle with wrangler or esbuild.
- **Mount.** The routes are `POST /audit/events`, `GET /audit/events` and `GET /audit/export`, relative to your
  prefix. Put multi-workspace's `workspaceMiddleware` in front of them:

  ```ts
  import { createAuditRoutes } from "@poc/audit-trail";
  import { requireNotSuspended, workspaceMiddleware } from "@poc/multi-workspace";

  for (const path of ["/v1/audit", "/v1/audit/*"]) {
    app.use(path, workspaceMiddleware);
    app.use(path, requireNotSuspended); // as the assembler does on every guarded path
  }
  app.route("/v1", createAuditRoutes());
  ```

  To record events from your own code, use `new AuditTrailService(env.DB).record({ workspaceId, actorId, action,
  targetType, targetId })` with a workspace id you verified.
- **Migrate.** Apply the files listed under `migrations` in `brick.manifest.json`, in that order, after
  multi-workspace's, to the D1 database bound as `DB`. With wrangler, rename the copies so they sort in that order
  across bricks (every brick's files start at `0001_`).
- **Identity.** The brick authenticates no one. Your identity middleware sets `user` (`{ uid, email? }`), and the
  workspace guard sets `ctx`; without `ctx` the routes answer 400.
