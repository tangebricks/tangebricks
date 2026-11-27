# Changelog

## 2.1.0 — email, explicit issuer, algorithm lists, packable (story 2.8)

- `user.email` is set from the `emailClaim` setting (default `email`) when the claim is a string; `verifyJwt` returns it
  as `email`.
- No default issuer: with none configured (setting or `createOidcMiddleware` config) the middleware answers 500
  `{ error: "oidc_not_configured" }` to every request, instead of checking tokens against a placeholder issuer.
- The `algorithms` setting is a comma-separated list and may include `HS256` (for example `ES256,HS256`); HS256 still
  needs the secret named by `hs256SecretName`.
- `hs256SecretName` passed to `createOidcMiddleware(config)` is honoured; before, only the env setting was read.
- The package can be packed and installed outside the monorepo: a `files` list, `license` Apache-2.0 with `LICENSE` and
  `NOTICE`, and a README with a "Using outside the monorepo" section.

## 2.0.0

Breaking changes (story 0.14, session hardening):

- `exp` is required. A validly signed token without a numeric `exp` is refused (`missing_exp`); an expired one beyond
  `clockSkewSec` (default 60) is refused as before (`token_expired`).
- `iat` in the future beyond the skew is refused (`token_issued_in_future`); `nbf` in the future beyond the skew stays
  refused (`token_not_yet_valid`). A non-numeric `nbf` or `iat` is `malformed_token`.
- An empty configured `issuer` or `audience` refuses every token.
- A token that maps to a workspace (`workspaceClaim`) is honoured only when the subject is a member of that workspace in
  the multi-workspace membership table; otherwise 403 `not_workspace_member`. If the table cannot be read, the request
  fails with 500 `workspace_membership_unavailable` (logged), never with a quiet 403.
- The workspace role now comes from the membership row, not from the token's first role. `user.roles` still carries the
  token's roles.
- The brick now requires `workspace-context` (the multi-workspace brick), so a blueprint with oidc-verify but without
  multi-workspace no longer assembles.
- Errors thrown by handlers after the middleware are no longer turned into 401s; they reach the app's error handler.

## 1.0.0

- Initial release of generic OIDC verification brick.
