# Workspace Integration Connections (`@poc/integration-connections`)

The `integration-connections` brick provides Case B multi-tenant OAuth2 connections, per-workspace credential sealing (AES-GCM with workspace-bound AAD), automated token refresh coordination with concurrency locks, and integration status reporting.

## OAuth Provider Endpoint Resolution Order

When initiating an OAuth connect flow (`startWorkspaceOAuthConnect` / `GET /api/integrations/:provider/connect`), resolving token exchange callbacks (`completeWorkspaceOAuthCallback`), or listing workspace connections (`listWorkspaceIntegrations`), provider endpoints are resolved in the following strict order:

1. **Explicit Operator Config (`adapter.providers[slug]`)**:
   - The host application or operator configures explicit provider settings.
   - Must contain both `authorizeUrl` and `tokenUrl`.
   - Both URLs are validated to require `https:` protocol and verified against `isForbiddenIntegrationHost` (blocking localhost, RFC1918/RFC3927 private/link-local/loopback IPs, and AWS/GCP metadata endpoints).
   - If provided, operator URLs take precedence.

2. **Integration Manifest (`catalog.integrations[slug].manifest`)**:
   - The brick looks up the integration manifest in the assembled catalog (`packages/assembler/catalog.generated.ts`).
   - If the manifest declares `auth.type === "oauth2"` and specifies both `authorizeUrl` and `tokenUrl`, these endpoints are used.
   - `defaultScopes` are sourced from `manifest.auth.scopes`.
   - Both URLs are validated to require `https:` protocol and verified against `isForbiddenIntegrationHost`.

3. **Refuse Unknown Providers (`OAUTH_PROVIDER_UNKNOWN`)**:
   - If neither explicit operator config with both URLs nor an OAuth2 integration manifest exists, the provider is refused immediately with an `IntegrationConnectionsError` (`code: "OAUTH_PROVIDER_UNKNOWN"`, HTTP status `404`).
   - No mock or fallback URLs (such as `https://{slug}.example.com/...`) are ever generated.
   - No OAuth state token or database record is written when an unknown provider is requested.

## Unmanifested Providers (Notion, Linear, HubSpot, etc.)

Integrations that do not currently have a manifest in `integrations/` (such as Notion, Linear, or HubSpot) are not available out-of-the-box. To enable end-user OAuth for these providers, operators must either:

1. Add a validated integration manifest in `integrations/<slug>/integration.json` with `auth.type: "oauth2"`, `authorizeUrl`, and `tokenUrl`, and rebuild the catalog (`pnpm catalog:build`).
2. Provide explicit endpoint configuration via `adapter.providers`:

```typescript
const routes = createIntegrationConnectionsRoutes({
  adapter: {
    providers: {
      notion: {
        displayName: "Notion",
        authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
        tokenUrl: "https://api.notion.com/v1/oauth/token",
        defaultScopes: ["read_content", "insert_content"],
      },
    },
  },
});
```

Attempts to connect to an unmanifested provider without `adapter.providers` configuration will fail closed with HTTP 404 `OAUTH_PROVIDER_UNKNOWN`.

## OAuth hardening (story 1.15)

These rules close threat-model findings A10, A11 and A12.

### Account data comes from the provider (A10)

- The stored `externalAccountId` comes only from the provider's token exchange. A caller `externalAccountId` / `external_account_id` (query or JSON body) on the callback is ignored. When the provider returns none, the generated fallback `acct_<workspaceId>_<provider>` is stored.
- The provider's `accountLabel` wins. A caller `accountLabel` / `account_label` is used only when the provider returns no label; it is trimmed and capped at 128 characters.

### `redirect_uri` allowlist (A11)

A caller `redirect_uri` (or `redirectUri`) on `GET /api/integrations/:provider/connect` and `GET /api/connect/:provider` is accepted only when it:

- exactly equals the default callback URL, `<publicBaseUrl>/api/integrations/<provider>/callback`; or
- exactly equals an entry of the `allowedRedirectUris` setting.

Anything else answers `400 REDIRECT_URI_NOT_ALLOWED`, and no OAuth state is stored.

As assembled, the routes get no `publicBaseUrl`, so the default callback URL is `https://app.projectx.local/api/integrations/<provider>/callback`. Until `publicBaseUrl` is wired, list the deployment's real callback URL in `allowedRedirectUris`.

| Setting | Type | Default | Notes |
|---|---|---|---|
| `allowedRedirectUris` | comma-separated string, max 512 characters | `""` (none) | Each entry must be an `https://` URL (checked at assembly by the setting's pattern). Matching is exact string equality after trimming each entry. Wired to the route option `allowedRedirectUris`. |

### CSRF guard on the redirecting connect (A11)

With `redirect=1` or `redirect=true` the connect route answers a `302` to the provider, so it is a top-level GET another site could trigger. It is refused with `403 CSRF_REJECTED`, before any state is stored, when:

- a `Sec-Fetch-Site` header is present and is not `same-origin` or `none`; or
- an `Origin` header is present and its origin is neither the request URL's origin nor (when set) `publicBaseUrl`'s origin. `Origin: null` is refused.

The JSON form (no `redirect`) is unchanged.

### OAuth state is bound to the user (A12)

Every state row records the user who started the flow. A callback by any other user, even an admin of the same workspace, answers `400 OAUTH_STATE_MISMATCH`. The state is still consumed (one-time), no token exchange runs, and no connection is stored.
