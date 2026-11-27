# External app fixture

A small project that uses bricks the way a project outside this monorepo would: it installs `@poc/sdk`,
`@poc/multi-workspace`, `@poc/credit-wallet`, `@poc/audit-trail` and `@poc/edge-traffic-armor` from packed tarballs and mounts them on its own
Hono app in `src/index.ts`. It is not a workspace package (`fixtures/` is outside the `pnpm-workspace.yaml` globs).

`package.json` holds `TARBALL:<name>` placeholders. `test/external-app.node.test.ts` packs the packages, copies this
directory to a temp directory outside the repo, replaces the placeholders with `file:` paths to the tarballs, installs,
bundles `src/index.ts` with esbuild, runs it in workerd with a D1 binding, applies the shipped migrations and runs a
smoke test.

The entry mounts the workspace guard with `requireNotSuspended` after it, and credit-wallet's manifest rate limits
with the SDK's `rateLimit`, as the assembler does. It also mounts edge-traffic-armor's middleware on `GET /v1/ping`
with a named bucket counted per user. `packageManager` pins pnpm to the repo's version, `.npmrc` pins
`node-linker=isolated` (so the install layout does not depend on user config), and `tsconfig.json` lets the test
typecheck `src/` against the installed packages.

Two parts exist only for the test, and a real project replaces both:

- `stubIdentity` trusts an `x-test-user` header. A real project verifies its own session or token and sets the same
  `user` variable.
- `POST /__test__/gateway/orders/:orderId/paid` marks an order paid on the brick's fake payment gateway. A real project
  passes its own `PaymentGateway` to `createWalletRoutes` and has no such route.

See [docs/using-bricks-outside-the-monorepo.md](../../docs/using-bricks-outside-the-monorepo.md).
