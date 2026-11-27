# @poc/oidc-verify

Bearer-token verification for any OpenID Connect provider. `oidcMiddleware` (or `createOidcMiddleware(config)`) checks
the token's signature against the issuer's JWKS (RS256, ES256, EdDSA) or a shared HS256 secret, checks `iss`, `aud`,
`exp` (required), `nbf` and `iat` with a clock skew, and sets the Hono `user` variable:
`{ id, uid, email?, emailVerified?, workspaceId?, roles, claims }`. A request with no `Authorization` header passes through with no
`user`; a bad token gets 401 `{ error: <reason code> }`. If the token names a workspace (`workspaceClaim`), the subject
must be a member of it in the multi-workspace membership table, and the role comes from that row, never from the token.

Exports: `createOidcMiddleware`, `oidcMiddleware`, `resolveOidcConfigFromSettings`, `verifyJwt`, `getJwksKey`,
`resolveJwksUri`, `getByDotPath`, `OidcVerificationError` and the config types. More detail, with provider examples, is
in [docs/identity/oidc-verify.md](../../docs/identity/oidc-verify.md).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `issuer` | none | The expected `iss`. Required: with no issuer the middleware answers 500 `oidc_not_configured` to every request. |
| `audience` | `authenticated` | The expected audience. |
| `jwksUri` | discovered | The JWKS URL. Without it the issuer's `/.well-known/openid-configuration` is read. |
| `algorithms` | `RS256` | Allowed algorithms, comma-separated, from `RS256`, `ES256`, `EdDSA`, `HS256` (for example `ES256,HS256`). |
| `hs256SecretName` | none | The env binding that holds the HS256 secret. HS256 is accepted only when it is listed and the secret is set. |
| `userIdClaim` | `sub` | Dot path to the user id. |
| `emailClaim` | `email` | Dot path to the user's email. Copied to `user.email` when it is a string and verified (below). |
| `emailVerifiedClaim` | `email_verified` | Dot path to the claim that says the email is verified. A boolean is copied to `user.emailVerified`; `user.email` is set only when it is `true`. |
| `trustUnverifiedEmail` | `false` | Risky. Sets `user.email` even when the verified claim is missing or `false` (`emailVerified` still says which). Turn it on only for a provider that signs tokens for verified addresses alone: other bricks trust `user.email` (multi-workspace's emailed invites). |
| `workspaceClaim` | none | Dot path to a workspace id; see above. |
| `rolesClaim` | none | Dot path to the roles, copied to `user.roles`. |
| `audienceClaim` | `aud` | Dot path to the audience. |
| `clockSkewSec` | 60 | Allowed clock skew, 0 to 300 seconds. |

`oidcMiddleware` reads these names from the worker's env. `createOidcMiddleware(config)` takes them as config, and
values given there win over the env.

## Using outside the monorepo

See [Using bricks outside the monorepo](../../docs/using-bricks-outside-the-monorepo.md) for the whole flow.

- **Install from a tarball.** Nothing is published to a registry. Run `pnpm pack` here and in `packages/sdk`, then
  depend on both tarballs (`file:` paths) and override `@poc/sdk` to the sdk tarball. Runtime dependencies: `@poc/sdk`
  and `hono`.
- **TypeScript sources.** `exports` point at `src/index.ts`; bundle with wrangler or esbuild.
- **Mount.** Put it first, before every route that needs a caller:

  ```ts
  import { createOidcMiddleware } from "@poc/oidc-verify";

  const verify = createOidcMiddleware({
    issuer: "https://idp.example.com",
    audience: "my-api",
    jwksUri: "https://idp.example.com/.well-known/jwks.json",
    algorithms: ["ES256"],
  });
  app.use("/v1/*", verify);
  ```

  For a shared-secret provider add `"HS256"` to `algorithms` and pass `hs256Secret` (or name an env binding with
  `hs256SecretName`). The middleware sets `user` and lets an unauthenticated request through; the routes after it
  decide whether a caller is required (the multi-workspace routes answer 401 without one).
- **Migrate.** Nothing to migrate. `workspaceClaim` needs the multi-workspace tables (or views of them).
