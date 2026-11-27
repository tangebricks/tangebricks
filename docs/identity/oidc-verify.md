# Generic OIDC Verification (`oidc-verify`)

The `oidc-verify` brick enables bringing any external OpenID Connect (OIDC) identity provider to a ProjectX application without provider-specific code. Bearer JWTs are cryptographically verified against the issuer's JWKS and their claims (`exp` required, `iss`, `aud`, `nbf`, `iat`) checked, then mapped to `{userId, email, workspaceId, roles}` for downstream authorization guards (`multi-workspace`, RBAC). A workspace named by the token is honoured only when the subject is a member of it in the `multi-workspace` membership table; the workspace role comes from that membership row, never from the token. The brick therefore requires `workspace-context` (the `multi-workspace` brick) since version 2.0.0.

---

## Provider Configuration Table

The `workspaceClaim` column names where a provider puts the workspace id; the id it yields must also have a membership row for the subject (`mw_members`), and `rolesClaim` fills `user.roles` only (the workspace role is the membership row's).

| Provider | `issuer` | `audience` | `algorithms` | `audienceClaim` | `userIdClaim` | `workspaceClaim` | `rolesClaim` | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Supabase** | `https://<project-ref>.supabase.co/auth/v1` | `authenticated` | `ES256` | `aud` | `sub` | `app_metadata.workspace_id` | `role` | Uses ECDSA P-256 (ES256). Multi-tenancy metadata mapped from `app_metadata`. Legacy shared-secret HS256 supported via `hs256SecretName`. |
| **Clerk** | `https://<domain>.clerk.accounts.dev` | `<client-id>` | `RS256` | `azp` | `sub` | `org_id` | `org_role` | Clerk organization tokens map `org_id` to workspace ID, `org_role` to caller role, and client identifier via `azp`. |
| **Auth0** | `https://<tenant>.auth0.com/` | `https://api.myproject.com` | `RS256` | `aud` | `sub` | `https://app/workspace_id` | `https://app/roles` | Supports array `aud`. Custom namespaced claims supported for tenant context and roles. |
| **Cognito** | `https://cognito-idp.<region>.amazonaws.com/<pool-id>` | `<app-client-id>` | `RS256` | `client_id` | `sub` | `custom:workspace_id` | `cognito:groups` | Access tokens contain `token_use=access` and place audience in `client_id`. User groups map from `cognito:groups`. |
| **Keycloak** | `https://<host>/realms/<realm>` | `<client-id>` | `RS256` | `azp` | `sub` | `workspace` | `realm_access.roles` | Nested roles extracted from `realm_access.roles` dot-path. Client ID verified via `azp` or `aud`. |

---

## Security Architecture & Guarantees

1. **Algorithm Pinning**: Token `alg` is pinned to the matching JWK `kty` and `crv` (e.g. `RS256` requires `kty: "RSA"`, `ES256` requires `kty: "EC"` + `crv: "P-256"`). Tokens declaring `alg: "none"` or attempting algorithm confusion (e.g. HMAC with RSA public key) are refused immediately with `alg_not_allowed`.
2. **Key Rotation & Caching**: JWKS keys are cached with `Cache-Control: max-age` (clamped between 60s and 24h). When a token presents an unknown `kid`, JWKS is refetched at most once per 30 seconds to prevent denial of service. If the remote JWKS endpoint is temporarily down, stale cached keys are served up to `max-age * 2`.
3. **Required Time Claims**: `exp` is required; a token without a numeric `exp`, or past `exp` by more than `clockSkewSec` (default 60), is refused. `nbf` or `iat` in the future by more than the skew is refused. An empty configured `issuer` or `audience` refuses every token; since 2.1.0 there is no default issuer, and the middleware answers 500 `oidc_not_configured` to every request until one is set.
4. **Workspace Membership**: when `workspaceClaim` maps the token to a workspace, the subject must be a member of it (`mw_members`), otherwise HTTP 403 `not_workspace_member`. The `workspace` context carries the membership row's role and suspended flag. If the membership table cannot be read (no `DB` binding, or `multi-workspace` not migrated), the request fails with HTTP 500 `workspace_membership_unavailable` and the cause is logged; it is never treated as a member.
5. **Fail-Closed Diagnostics**: Any token validation failure returns HTTP 401 with an explicit machine-readable error code (`missing_exp`, `token_expired`, `token_not_yet_valid`, `token_issued_in_future`, `issuer_mismatch`, `audience_mismatch`, `alg_not_allowed`, `kid_unknown`, `jwks_unavailable`, `malformed_token`); a valid token for a workspace the subject does not belong to returns HTTP 403 `not_workspace_member`. No error payload or log leaks raw tokens or cryptographic keys.

---

## Enterprise SSO & Identity Federation (`identity-federation`)

The `identity-federation` brick integrates enterprise single sign-on (SSO) using the `oidc-verifier` capability from `oidc-verify`:

1. **Authorization-Code Flow & PKCE**:
   - `POST /sso/authorize` generates cryptographically random `state`, `nonce`, and PKCE `code_verifier`.
   - The hashed `code_challenge` is calculated via SHA-256 (`code_challenge_method=S256`) and embedded in the IdP authorization redirect URL.
   - Transient authorization parameters (`state`, `nonce`, `code_challenge`, `code_verifier`) are recorded in D1 table `sso_auth_requests` with a strict 10-minute TTL.

2. **IdP Callback & ID Token Verification**:
   - `GET /sso/callback?code&state` handles the authorization redirect from the IdP.
   - **Replay Protection**: The `state` parameter is single-use and consumed (deleted) immediately upon callback receipt. Replay attempts are refused with HTTP 400 (`Invalid or replayed state`).
   - **Expiration Guard**: Requests exceeding the 10-minute TTL are rejected with HTTP 400 (`SSO request expired`).
   - **Hardened Egress Token Exchange**: Authorization code is exchanged for tokens at the connection's `token_endpoint` via UC1.3 hardened egress fetch with host pinning and private-address protections.
   - **Cryptographic Verification**: The returned `id_token` is verified using `verifyJwt(token, config, { fetcher, nonce })` from `oidc-verify`, requiring a valid signature against the IdP's JWKS and exact `nonce` claim validation. Nonce mismatches or tampering return HTTP 401.

3. **Federated Identity Linking & Session Creation**:
   - Following verification, the external subject is linked in `sso_federated_identities`.
   - A valid authenticated user session is created through the `user-identity` provider.

4. **SAML Unsupported**:
   - Legacy SAML 2.0 assertions are explicitly unsupported. Any request to `POST /sso/saml/acs` is refused with HTTP 501 `SSO_SAML_UNSUPPORTED`.

## Choosing identity

| Identity | Use for | Production |
|---|---|---|
| `stub` | Tests and the proof. It trusts the `x-test-user` header, so anyone can claim to be anyone. | **Refused** |
| `core-auth` | Projects that sign users in themselves. | Allowed |
| `oidc-verify` | Projects that verify tokens from an OIDC provider. | Allowed |

A project whose identity is `stub` cannot reach production by any path:

- **Assembly:** `assemble(blueprint, catalog, { environment: "production" })` returns `ok: false` with `identity "stub" is for tests only; choose core-auth or oidc-verify`. The environment (`dev` by default, `preview` or `production`) is recorded in `project.json`.
- **Provisioner:** `deploy({ ..., environment: "production", lock })` throws `DeployError` before any write call when `lock.identity` is `stub`. `scripts/poc-deploy.ts` and `scripts/poc-deploy-mcp.ts` take `--env dev|preview|production`.
- **Runtime:** the provisioner binds `PX_ENVIRONMENT` as a plain-text binding, and the emitted `src/identity.stub.ts` answers 503 when it is `production`.

## Email and algorithm lists (2.1.0)

`user.email` is copied from the `emailClaim` claim (default `email`) when it is a string and the `emailVerifiedClaim` claim (default `email_verified`) is `true`; that boolean is copied to `user.emailVerified`. `trustUnverifiedEmail: true` sets the email without the verified claim; it is risky, because multi-workspace's emailed invites trust `user.email`, so use it only for a provider that signs tokens for verified addresses alone. The `algorithms` setting is a
comma-separated list from `RS256`, `ES256`, `EdDSA` and `HS256`; a provider that signs with both a JWKS key and a shared
secret (for example ES256 and HS256) lists both, and names the secret's env binding with `hs256SecretName`.
