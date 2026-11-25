# Public API Keys (`@poc/public-api-keys`)

Workspace API keys (`sk_live_…`) for server-to-server calls. Only the SHA-256 hash of a key is stored. The raw key is
returned once, in the response that creates it.

## Authenticating with a key (Story 1.11)

In an assembled app that includes this brick, the workspace-guarded API routes (the paths a workspace guard is
mounted on) accept a key in either header:

- `Authorization: Bearer sk_live_…`
- `X-API-Key: sk_live_…`

The brick's `apiKeyIdentity` step (manifest `worker.identityAlternative`) runs on those paths only, before the
session identity. On every other path (sign-in, profile, workspace management, webhook ingress) a key header is
ignored: no authentication and no 401, so those routes behave exactly as they do without it.

- **No key header:** the request goes on to the session identity unchanged.
- **Valid key:** the step sets the `authenticatedBy: "api-key"` marker, which only it sets. The caller is
  `apikey:<keyId>`. The verified request context is
  `{ userId: "apikey:<keyId>", workspaceId: <the key's workspace>, role: <the key's role> }`. The session identity
  does not run.
- **Unknown, revoked or expired key, or a creator who lost the rights to it:** `401 { code: "INVALID_API_KEY" }`. The
  request never falls through to the session, even when a session is sent alongside. A malformed `X-API-Key` header,
  or two different keys in one request, gets the same answer.
- **Workspace header:** `x-workspace-id` is optional for a key. Naming any other workspace gets
  `403 { code: "WORKSPACE_MISMATCH" }`.
- **Suspended workspace:** its keys get `403 WORKSPACE_SUSPENDED` wherever its people do (story 1.10).
- **Unavailable store:** if the key lookup fails, the answer is `503 API_KEY_AUTH_UNAVAILABLE`, never the session.
- **Rate limit:** every request carrying a key header is counted per client IP in bucket `api-key-auth-ip`
  (600 per 60 s, adjustable with `PX_RATE_LIMITS`; fails open with a log line). Over the limit: `429`.
- **Recording use:** `last_used_at` is updated without delaying the request (`waitUntil` when available), and at most
  once a minute per key.

## Scopes

A key is created with one of two scope sets:

- `["*"]` (the default): full access at the key's role.
- `["read"]`: GET, HEAD and OPTIONS only. Any other method gets `403 API_KEY_SCOPE`.

Any other scope list is refused with `400`. A brick that wants finer checks can still use `requireScope("<scope>")`.

## Roles and the creator rule

- A key has a role, `member` (the default) or `admin`. There are no owner keys, and the database refuses one.
- Only a workspace `owner` or `admin`, signed in with a session, can create, list or revoke keys. A key's role can
  never exceed its creator's role. The creator is recorded in `created_by`.
- An API key can never call `/api/api-keys` (`403 API_KEY_FORBIDDEN`). Routes that mint credentials outliving the key
  refuse it the same way through the SDK's `refuseApiKeyCaller`: OAuth client registration, authorize and token,
  inbound-webhook subscriptions, endpoints and secret rotation, SSO connections, and the workspace routes.
- Each time a key is used, its creator must still be a member of the key's workspace, at or above the key's role.
  If the creator was removed, or demoted below the key's role, the key is refused with `401 INVALID_API_KEY`. This is
  the same rule that 1.10 applies to invites. Keys created before migration `0002` have no recorded creator, so they
  are refused. Mint new ones.

## Creating a key

`POST /api/api-keys` with `{ name, scopes?, role?, expiresDays? }`:

- `scopes` is `["*"]` (the default) or `["read"]`.
- `role` is `member` or `admin`.
- `expiresDays` is optional, a whole number from 1 to 3650. An expired key is refused like a revoked one.
