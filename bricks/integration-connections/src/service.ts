import { scoped, type D1Like } from "@poc/sdk";
import { isForbiddenIntegrationHost } from "@poc/assembler";
import type { IntegrationManifestFile } from "@poc/assembler";
import { catalog } from "@poc/assembler/catalog";
import {
  computePkceChallengeS256,
  generateOAuthStateToken,
  generatePkceVerifier,
  sealWorkspaceCredentials,
  unsealWorkspaceCredentials,
} from "./crypto.ts";
import type { WorkspaceSealedCredentials } from "./crypto.ts";

export interface OAuthProviderConfig {
  provider: string;
  displayName: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId?: string;
  clientSecret?: string;
  defaultScopes: string[];
}

export interface OAuthTokenExchangeResult {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
  expiresAt?: number | null;
  scopes?: string[];
  externalAccountId?: string;
  accountLabel?: string;
}

export interface IntegrationConnectionsAdapter {
  providers?: Record<string, Partial<OAuthProviderConfig>>;
  integrations?: Record<string, { manifest: IntegrationManifestFile }>;
  fetcher?: typeof fetch;
  exchangeCode?: (params: {
    provider: string;
    code: string;
    codeVerifier: string | null;
    redirectUri: string;
    workspaceId: string;
    tokenUrl: string;
  }) => Promise<OAuthTokenExchangeResult>;
  refreshToken?: (params: {
    provider: string;
    refreshToken: string;
    workspaceId: string;
    tokenUrl: string;
  }) => Promise<OAuthTokenExchangeResult>;
}

export interface WorkspaceIntegrationSummary {
  id: string;
  workspaceId: string;
  provider: string;
  displayName: string;
  status: "connected" | "expired" | "revoked" | "error";
  accountLabel: string | null;
  externalAccountId: string | null;
  scopes: string[];
  expiresAt: number | null;
  createdAt: string;
  updatedAt: string;
}

function validateOAuthUrl(urlStr: string, fieldName: string, provider: string): void {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new IntegrationConnectionsError(
      "INVALID_OAUTH_URL",
      `Invalid ${fieldName} for provider "${provider}": must be a valid URL`,
      400,
    );
  }
  if (parsed.protocol !== "https:") {
    throw new IntegrationConnectionsError(
      "INVALID_OAUTH_URL",
      `Invalid ${fieldName} for provider "${provider}": protocol must be https:`,
      400,
    );
  }
  if (isForbiddenIntegrationHost(parsed.hostname)) {
    throw new IntegrationConnectionsError(
      "FORBIDDEN_OAUTH_HOST",
      `Forbidden host in ${fieldName} for provider "${provider}": "${parsed.hostname}"`,
      400,
    );
  }
}

export function resolveProviderConfig(
  provider: string,
  adapter?: IntegrationConnectionsAdapter,
): OAuthProviderConfig {
  const clean = provider.trim().toLowerCase();
  const override = adapter?.providers?.[clean];
  const integrations =
    adapter?.integrations !== undefined
      ? adapter.integrations
      : (catalog.integrations as Record<string, { manifest: IntegrationManifestFile }> | undefined);
  const manifest = integrations?.[clean]?.manifest;

  // 1. adapter.providers[slug] (explicit operator config, must contain both URLs)
  if (override?.authorizeUrl && override?.tokenUrl) {
    validateOAuthUrl(override.authorizeUrl, "authorizeUrl", clean);
    validateOAuthUrl(override.tokenUrl, "tokenUrl", clean);

    const defaultScopes =
      override.defaultScopes ??
      (manifest?.auth?.type === "oauth2" ? manifest.auth.scopes : undefined) ??
      [];

    return {
      provider: clean,
      displayName:
        override.displayName ??
        manifest?.ui?.displayName ??
        clean.charAt(0).toUpperCase() + clean.slice(1),
      authorizeUrl: override.authorizeUrl,
      tokenUrl: override.tokenUrl,
      clientId: override.clientId,
      clientSecret: override.clientSecret,
      defaultScopes,
    };
  }

  // 2. catalog integration manifest with auth.type === "oauth2" and both URLs
  if (
    manifest &&
    manifest.auth?.type === "oauth2" &&
    manifest.auth.authorizeUrl &&
    manifest.auth.tokenUrl
  ) {
    const authorizeUrl = override?.authorizeUrl ?? manifest.auth.authorizeUrl;
    const tokenUrl = override?.tokenUrl ?? manifest.auth.tokenUrl;

    validateOAuthUrl(authorizeUrl, "authorizeUrl", clean);
    validateOAuthUrl(tokenUrl, "tokenUrl", clean);

    const defaultScopes =
      override?.defaultScopes ??
      manifest.auth.scopes ??
      [];

    return {
      provider: clean,
      displayName:
        override?.displayName ??
        manifest.ui?.displayName ??
        clean.charAt(0).toUpperCase() + clean.slice(1),
      authorizeUrl,
      tokenUrl,
      clientId: override?.clientId,
      clientSecret: override?.clientSecret,
      defaultScopes,
    };
  }

  // 3. otherwise throw OAUTH_PROVIDER_UNKNOWN
  throw new IntegrationConnectionsError(
    "OAUTH_PROVIDER_UNKNOWN",
    `Unknown OAuth provider "${clean}"`,
    404,
  );
}

/** Story 0.9 (A13): the configured OAuth client id, or a NOT_CONFIGURED error. Never a placeholder. */
function requireClientId(cfg: OAuthProviderConfig, providerSlug: string): string {
  const clientId = typeof cfg.clientId === "string" ? cfg.clientId.trim() : "";
  if (!clientId) {
    throw new IntegrationConnectionsError(
      "NOT_CONFIGURED",
      `NOT_CONFIGURED: no OAuth client id is configured for provider "${providerSlug}"; set providers.${providerSlug}.clientId.`,
      503,
    );
  }
  return clientId;
}

export class IntegrationConnectionsError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(`${code}: ${message}`);
    this.name = "IntegrationConnectionsError";
    this.code = code;
    this.status = status;
  }
}

/** Story 1.15 (A10): the longest caller-supplied account label kept, and only when the provider returned none. */
export const MAX_CALLER_ACCOUNT_LABEL_LENGTH = 128;

/**
 * Story 1.15 (A11): the `allowedRedirectUris` setting (a comma string) or an already-split list, as the exact
 * `https://` URIs a caller may ask for as `redirect_uri`. Blank entries and anything that is not an https URL are
 * dropped, so a malformed entry never widens the allowlist.
 */
export function parseAllowedRedirectUris(raw: string | readonly string[] | undefined): string[] {
  if (raw === undefined) return [];
  const entries = typeof raw === "string" ? raw.split(",") : [...raw];
  const out: string[] = [];
  for (const entry of entries) {
    const uri = String(entry).trim();
    if (!uri) continue;
    try {
      if (new URL(uri).protocol !== "https:") continue;
    } catch {
      continue;
    }
    out.push(uri);
  }
  return out;
}

/** The callback URL the brick itself serves for a provider: `<publicBaseUrl>/api/integrations/<provider>/callback`. */
export function defaultCallbackUrl(providerSlug: string, publicBaseUrl?: string): string {
  const base = (publicBaseUrl ?? "https://app.projectx.local").replace(/\/+$/, "");
  return `${base}/api/integrations/${providerSlug}/callback`;
}

interface IntOAuthStateRow {
  state: string;
  workspace_id: string;
  user_id: string;
  provider: string;
  code_verifier: string | null;
  redirect_uri: string | null;
  scopes: string;
  expires_at: number;
  created_at: string;
}

interface IntConnectionRow {
  id: string;
  workspace_id: string;
  provider: string;
  external_account_id: string | null;
  account_label: string | null;
  sealed_credentials?: string;
  scopes: string;
  status: "connected" | "expired" | "revoked" | "error";
  expires_at: number | null;
  refresh_lock_until: number | null;
  created_at: string;
  updated_at: string;
}

export async function startWorkspaceOAuthConnect(
  db: D1Like,
  params: {
    workspaceId: string;
    userId: string;
    provider: string;
    redirectUri?: string;
    scopes?: string[];
    oauthStateTtlSeconds: number;
    publicBaseUrl?: string;
    /** Story 1.15 (A11): exact redirect URIs a caller may ask for besides the default callback URL. */
    allowedRedirectUris?: string | readonly string[];
    adapter?: IntegrationConnectionsAdapter;
  },
): Promise<{
  authorizeUrl: string;
  state: string;
  provider: string;
  expiresAt: number;
}> {
  const providerSlug = params.provider.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(providerSlug)) {
    throw new IntegrationConnectionsError(
      "INVALID_PROVIDER",
      `Invalid provider slug "${params.provider}"`,
      400,
    );
  }

  const cfg = resolveProviderConfig(providerSlug, params.adapter);
  // Story 0.9 (A13): no placeholder client id. Refuse before any state is stored.
  requireClientId(cfg, providerSlug);
  // Story 1.15 (A11): a caller redirect_uri must be the default callback URL or an allowlisted one. Refuse before
  // any state is stored.
  const defaultRedirectUri = defaultCallbackUrl(providerSlug, params.publicBaseUrl);
  if (
    params.redirectUri !== undefined &&
    params.redirectUri !== defaultRedirectUri &&
    !parseAllowedRedirectUris(params.allowedRedirectUris).includes(params.redirectUri)
  ) {
    throw new IntegrationConnectionsError(
      "REDIRECT_URI_NOT_ALLOWED",
      "redirect_uri is not the default callback URL or in allowedRedirectUris",
      400,
    );
  }
  const state = generateOAuthStateToken();
  const codeVerifier = generatePkceVerifier();
  const codeChallenge = await computePkceChallengeS256(codeVerifier);
  const scopes = params.scopes && params.scopes.length > 0 ? params.scopes : cfg.defaultScopes;
  const nowMs = Date.now();
  const ttlMs = Math.max(60, params.oauthStateTtlSeconds) * 1000;
  const expiresAt = nowMs + ttlMs;
  const redirectUri = params.redirectUri ?? defaultRedirectUri;

  await scoped(db, params.workspaceId).insert("int_oauth_states", {
    state,
    user_id: params.userId,
    provider: providerSlug,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    scopes: JSON.stringify(scopes),
    expires_at: expiresAt,
    created_at: new Date(nowMs).toISOString(),
  });

  const authUrl = new URL(cfg.authorizeUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", requireClientId(cfg, providerSlug));
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scopes.join(" "));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  return {
    authorizeUrl: authUrl.toString(),
    state,
    provider: providerSlug,
    expiresAt,
  };
}

export async function completeWorkspaceOAuthCallback(
  db: D1Like,
  params: {
    workspaceId: string;
    /** Story 1.15 (A12): the user completing the callback; must be the user who started the flow. */
    userId: string;
    provider: string;
    code: string;
    state: string;
    /**
     * Story 1.15 (A10): used only when the provider returns no label, trimmed and capped at 128 characters. There is
     * no caller external account id: it comes only from the provider (or the generated fallback).
     */
    accountLabel?: string;
    connKey?: string;
    adapter?: IntegrationConnectionsAdapter;
  },
): Promise<WorkspaceIntegrationSummary> {
  const providerSlug = params.provider.trim().toLowerCase();
  if (!params.state || !params.code) {
    throw new IntegrationConnectionsError(
      "OAUTH_MISSING_PARAMS",
      "Both code and state parameters are required",
      400,
    );
  }

  const stateRow = await scoped(db, params.workspaceId).first<IntOAuthStateRow>(
    "int_oauth_states",
    "state = ?",
    [params.state]
  );

  if (!stateRow) {
    throw new IntegrationConnectionsError(
      "OAUTH_STATE_MISMATCH",
      "OAuth state token is invalid or has already been consumed",
      400,
    );
  }

  // Always consume the one-time state token immediately
  await scoped(db, params.workspaceId).delete(
    "int_oauth_states",
    "state = ?",
    [params.state]
  );

  if (stateRow.workspace_id !== params.workspaceId) {
    throw new IntegrationConnectionsError(
      "OAUTH_STATE_MISMATCH",
      `OAuth state token belongs to a different workspace`,
      400,
    );
  }

  // Story 1.15 (A12): the state is bound to the user who started the flow. It is already consumed above, and no
  // token exchange runs.
  if (stateRow.user_id !== params.userId) {
    throw new IntegrationConnectionsError(
      "OAUTH_STATE_MISMATCH",
      "OAuth state token was issued to a different user",
      400,
    );
  }

  if (stateRow.provider !== providerSlug) {
    throw new IntegrationConnectionsError(
      "OAUTH_STATE_MISMATCH",
      `OAuth state token provider mismatch (expected "${stateRow.provider}", received "${providerSlug}")`,
      400,
    );
  }

  const nowMs = Date.now();
  if (stateRow.expires_at <= nowMs) {
    throw new IntegrationConnectionsError(
      "OAUTH_STATE_EXPIRED",
      "OAuth state token has expired",
      400,
    );
  }

  const cfg = resolveProviderConfig(providerSlug, params.adapter);
  const redirectUri =
    stateRow.redirect_uri ?? `https://app.projectx.local/api/integrations/${providerSlug}/callback`;
  let requestedScopes: string[] = cfg.defaultScopes;
  try {
    const parsedScopes = JSON.parse(stateRow.scopes);
    if (Array.isArray(parsedScopes)) {
      requestedScopes = parsedScopes.map(String);
    }
  } catch {
    // keep default scopes
  }

  let exchanged: OAuthTokenExchangeResult;
  if (params.adapter?.exchangeCode) {
    exchanged = await params.adapter.exchangeCode({
      provider: providerSlug,
      code: params.code,
      codeVerifier: stateRow.code_verifier,
      redirectUri,
      workspaceId: params.workspaceId,
      tokenUrl: cfg.tokenUrl,
    });
  } else if (params.adapter?.fetcher) {
    const form = new URLSearchParams();
    form.set("grant_type", "authorization_code");
    form.set("code", params.code);
    form.set("redirect_uri", redirectUri);
    form.set("client_id", requireClientId(cfg, providerSlug));
    if (cfg.clientSecret) {
      form.set("client_secret", cfg.clientSecret);
    }
    if (stateRow.code_verifier) {
      form.set("code_verifier", stateRow.code_verifier);
    }
    const tokenRes = await params.adapter.fetcher(cfg.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form.toString(),
    });
    if (!tokenRes.ok) {
      throw new IntegrationConnectionsError(
        "OAUTH_TOKEN_EXCHANGE_FAILED",
        `Provider "${providerSlug}" token endpoint returned HTTP ${tokenRes.status}`,
        400,
      );
    }
    const body = (await tokenRes.json()) as Record<string, unknown>;
    const accessToken = String(body.access_token ?? body.accessToken ?? "");
    if (!accessToken) {
      throw new IntegrationConnectionsError(
        "OAUTH_TOKEN_EXCHANGE_FAILED",
        `Provider "${providerSlug}" token response did not include access_token`,
        400,
      );
    }
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : undefined;
    exchanged = {
      accessToken,
      ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
      tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
      ...(expiresIn !== undefined ? { expiresIn, expiresAt: nowMs + expiresIn * 1000 } : {}),
      ...(typeof body.scope === "string"
        ? { scopes: body.scope.split(/[,\s]+/).filter(Boolean) }
        : {}),
      ...(typeof body.account_label === "string"
        ? { accountLabel: body.account_label }
        : typeof body.email === "string"
          ? { accountLabel: body.email }
          : {}),
      ...(typeof body.external_account_id === "string"
        ? { externalAccountId: body.external_account_id }
        : typeof body.sub === "string"
          ? { externalAccountId: body.sub }
          : {}),
    };
  } else {
    // Story 0.9 (A7): with no exchange adapter and no fetcher there is no way to turn the code into a
    // token. Never mint one from the caller's code; the connection is not stored or marked connected.
    throw new IntegrationConnectionsError(
      "NOT_CONFIGURED",
      `NOT_CONFIGURED: no OAuth token exchange is configured for provider "${providerSlug}"; the connection was not made.`,
      503,
    );
  }

  const finalScopes = exchanged.scopes && exchanged.scopes.length > 0 ? exchanged.scopes : requestedScopes;
  const expiresAt =
    exchanged.expiresAt !== undefined
      ? exchanged.expiresAt
      : exchanged.expiresIn !== undefined
        ? nowMs + exchanged.expiresIn * 1000
        : nowMs + 3600 * 1000;
  // Story 1.15 (A10): the provider's account data wins. A caller label is only a fallback for a provider that
  // returned none; a caller external account id is never used.
  const callerLabel = params.accountLabel?.trim().slice(0, MAX_CALLER_ACCOUNT_LABEL_LENGTH) || undefined;
  const accountLabel =
    exchanged.accountLabel ||
    callerLabel ||
    `${params.workspaceId}@${providerSlug}.connected`;
  const externalAccountId =
    exchanged.externalAccountId ||
    `acct_${params.workspaceId}_${providerSlug}`;

  const credentialsToSeal: WorkspaceSealedCredentials = {
    provider: providerSlug,
    accessToken: exchanged.accessToken,
    ...(exchanged.refreshToken ? { refreshToken: exchanged.refreshToken } : {}),
    tokenType: exchanged.tokenType ?? "Bearer",
    expiresAt,
    scopes: finalScopes,
    tokenUrl: cfg.tokenUrl,
    ...(cfg.clientId ? { clientId: cfg.clientId } : {}),
    ...(cfg.clientSecret ? { clientSecret: cfg.clientSecret } : {}),
    accountLabel,
    externalAccountId,
  };

  // Seal with AES-GCM 256-bit PX_CONN_KEY and AAD = workspaceId
  const sealedEnvelope = await sealWorkspaceCredentials(
    credentialsToSeal,
    params.workspaceId,
    params.connKey,
  );

  const nowIso = new Date(nowMs).toISOString();
  const connId = `intc_${params.workspaceId}_${providerSlug}`;

  const existingConn = await scoped(db, params.workspaceId).first<IntConnectionRow>(
    "int_connections",
    "provider = ?",
    [providerSlug]
  );

  if (existingConn) {
    await scoped(db, params.workspaceId).update(
      "int_connections",
      {
        external_account_id: externalAccountId,
        account_label: accountLabel,
        sealed_credentials: sealedEnvelope,
        scopes: JSON.stringify(finalScopes),
        status: "connected",
        expires_at: expiresAt,
        refresh_lock_until: null,
        updated_at: nowIso,
      },
      "provider = ?",
      [providerSlug]
    );
  } else {
    await scoped(db, params.workspaceId).insert("int_connections", {
      id: connId,
      provider: providerSlug,
      external_account_id: externalAccountId,
      account_label: accountLabel,
      sealed_credentials: sealedEnvelope,
      scopes: JSON.stringify(finalScopes),
      status: "connected",
      expires_at: expiresAt,
      refresh_lock_until: null,
      created_at: nowIso,
      updated_at: nowIso,
    });
  }

  return {
    id: connId,
    workspaceId: params.workspaceId,
    provider: providerSlug,
    displayName: cfg.displayName,
    status: "connected",
    accountLabel,
    externalAccountId,
    scopes: finalScopes,
    expiresAt,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export async function disconnectWorkspaceIntegration(
  db: D1Like,
  params: {
    workspaceId: string;
    provider: string;
  },
): Promise<{ ok: true; workspaceId: string; provider: string; disconnected: boolean }> {
  const providerSlug = params.provider.trim().toLowerCase();
  const existing = await scoped(db, params.workspaceId).first<{ id: string }>(
    "int_connections",
    "provider = ?",
    [providerSlug]
  );

  await scoped(db, params.workspaceId).delete(
    "int_connections",
    "provider = ?",
    [providerSlug]
  );

  return {
    ok: true,
    workspaceId: params.workspaceId,
    provider: providerSlug,
    disconnected: Boolean(existing),
  };
}

export async function listWorkspaceIntegrations(
  db: D1Like,
  params: {
    workspaceId: string;
    refreshWindowSeconds: number;
    adapter?: IntegrationConnectionsAdapter;
  },
): Promise<WorkspaceIntegrationSummary[]> {
  // Never select sealed_credentials in status listings
  const rows = await scoped(db, params.workspaceId).select<IntConnectionRow>(
    "int_connections",
    undefined,
    [],
    { orderBy: "provider ASC" }
  );

  const nowMs = Date.now();
  const windowMs = Math.max(0, params.refreshWindowSeconds) * 1000;

  return (rows ?? []).map((row) => {
    const cfg = resolveProviderConfig(row.provider, params.adapter);
    let scopes: string[] = [];
    try {
      const parsed = JSON.parse(row.scopes);
      if (Array.isArray(parsed)) scopes = parsed.map(String);
    } catch {
      scopes = [];
    }
    const isExpired =
      row.status === "expired" ||
      (row.expires_at !== null && row.expires_at <= nowMs - windowMs);
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      provider: row.provider,
      displayName: cfg.displayName,
      status: isExpired ? "expired" : row.status,
      accountLabel: row.account_label,
      externalAccountId: row.external_account_id,
      scopes,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

export { unsealWorkspaceCredentials };
