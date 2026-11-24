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
