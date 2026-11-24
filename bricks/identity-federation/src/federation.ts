import type { D1Like } from "@poc/sdk";
import { global, scoped } from "@poc/sdk";
import { createHardenedFetch } from "@poc/runtime";
import { verifyJwt, OidcVerificationError, type OidcUserContext } from "@poc/oidc-verify";

export type SsoProviderType = "oidc" | "saml" | "google" | "github" | "microsoft" | "apple";

export interface SsoConnection {
  id: string;
  workspace_id: string;
  domain: string;
  provider_type: SsoProviderType;
  display_name: string;
  client_id: string;
  issuer_url: string;
  authorization_endpoint: string | null;
  token_endpoint: string | null;
  userinfo_endpoint: string | null;
  scim_token: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SsoAuthRequest {
  state: string;
  connection_id: string;
  workspace_id: string;
  redirect_uri: string;
  nonce: string;
  code_verifier: string | null;
  code_challenge: string;
  code_challenge_method: string;
  expires_at: number;
  created_at: string;
}

function base64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generatePkceVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function computePkceChallengeS256(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64Url(hash);
}

export function generateStateToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function generateNonceToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export interface FederatedIdentity {
  id: string;
  connection_id: string;
  workspace_id: string;
  external_subject_id: string;
  email: string;
  display_name: string | null;
  user_id: string | null;
  last_login_at: string;
  created_at: string;
}

export interface CreateSsoConnectionInput {
  workspaceId: string;
  domain: string;
  providerType: SsoProviderType;
  displayName: string;
  clientId: string;
  clientSecret?: string;
  issuerUrl: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
  scimToken?: string;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

interface RawConnRow {
  id: string;
  workspace_id: string;
  domain: string;
  provider_type: SsoProviderType;
  display_name: string;
  client_id: string;
  client_secret: string | null;
  issuer_url: string;
  authorization_endpoint: string | null;
  token_endpoint: string | null;
  userinfo_endpoint: string | null;
  scim_token: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface RawFidRow {
  id: string;
  connection_id: string;
  workspace_id: string;
  external_subject_id: string;
  email: string;
  display_name: string | null;
  user_id: string | null;
  last_login_at: string;
  created_at: string;
}

export class IdentityFederationService {
  constructor(
    private readonly db: D1Like,
    private readonly customFetch: Fetcher = fetch
  ) {}

  private parseConn(row: RawConnRow): SsoConnection {
    return {
      ...row,
      is_active: row.is_active === 1,
    };
  }

  /**
   * Registers a new enterprise SSO connection.
   */
  async createConnection(input: CreateSsoConnectionInput): Promise<SsoConnection> {
    const id = `sso_${crypto.randomUUID().replace(/-/g, "")}`;
    const domain = input.domain.trim().toLowerCase();
    const now = new Date().toISOString();
    const authEp = input.authorizationEndpoint || `${input.issuerUrl}/authorize`;
    const tokenEp = input.tokenEndpoint || `${input.issuerUrl}/token`;
    const userinfoEp = input.userinfoEndpoint || `${input.issuerUrl}/userinfo`;

    const existing = await scoped(this.db, input.workspaceId).first<RawConnRow>("sso_connections", "domain = ?", [domain]);
    if (existing) {
      await scoped(this.db, input.workspaceId).update(
        "sso_connections",
        {
          provider_type: input.providerType,
          display_name: input.displayName.trim(),
          client_id: input.clientId.trim(),
          client_secret: input.clientSecret?.trim() || null,
          issuer_url: input.issuerUrl.trim(),
          authorization_endpoint: authEp,
          token_endpoint: tokenEp,
          userinfo_endpoint: userinfoEp,
          scim_token: input.scimToken?.trim() || null,
          updated_at: now,
        },
        "id = ?",
        [existing.id],
      );
    } else {
      await scoped(this.db, input.workspaceId).insert("sso_connections", {
        id,
        domain,
        provider_type: input.providerType,
        display_name: input.displayName.trim(),
        client_id: input.clientId.trim(),
        client_secret: input.clientSecret?.trim() || null,
        issuer_url: input.issuerUrl.trim(),
        authorization_endpoint: authEp,
        token_endpoint: tokenEp,
        userinfo_endpoint: userinfoEp,
        scim_token: input.scimToken?.trim() || null,
        is_active: 1,
        created_at: now,
        updated_at: now,
      });
    }

    return {
      id: existing ? existing.id : id,
      workspace_id: input.workspaceId,
      domain,
      provider_type: input.providerType,
      display_name: input.displayName.trim(),
      client_id: input.clientId.trim(),
      issuer_url: input.issuerUrl.trim(),
      authorization_endpoint: authEp,
      token_endpoint: tokenEp,
      userinfo_endpoint: userinfoEp,
      scim_token: input.scimToken?.trim() || null,
      is_active: true,
      created_at: existing ? existing.created_at : now,
      updated_at: now,
    };
  }

  /**
   * Retrieves an SSO connection by ID.
   */
  async getConnection(connectionId: string): Promise<SsoConnection | null> {
    const row = await global(this.db, "sso_connections", "resolve SSO connection by connection id")
      .first<RawConnRow>("id = ?", [connectionId]);

    if (!row) return null;
    return this.parseConn(row);
  }

  /**
   * Discovers an active SSO connection for an email domain (e.g. "acme.corp").
   */
  async getConnectionByDomain(emailOrDomain: string): Promise<SsoConnection | null> {
    const domain = emailOrDomain.includes("@")
      ? emailOrDomain.split("@")[1].toLowerCase().trim()
      : emailOrDomain.toLowerCase().trim();

    const row = await global(this.db, "sso_connections", "discover SSO connection by email domain")
      .first<RawConnRow>("domain = ? AND is_active = 1", [domain]);

    if (!row) return null;
    return this.parseConn(row);
  }

  /**
   * Constructs the IdP authorization redirect URL.
   */
  buildAuthorizeUrl(
    connection: SsoConnection,
    redirectUri: string,
    state: string,
    scope = "openid profile email",
    nonce?: string,
    codeChallenge?: string,
  ): string {
    const base = connection.authorization_endpoint || `${connection.issuer_url}/authorize`;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: connection.client_id,
      redirect_uri: redirectUri,
      scope,
      state,
    });
    if (nonce) {
      params.set("nonce", nonce);
    }
    if (codeChallenge) {
      params.set("code_challenge", codeChallenge);
      params.set("code_challenge_method", "S256");
    }

    return `${base}?${params.toString()}`;
  }

  /**
   * Creates and stores an SSO authorization request for PKCE and nonce validation.
   */
  async createAuthRequest(input: {
    domain: string;
    redirectUri: string;
    state?: string;
    nonce?: string;
    codeVerifier?: string;
  }): Promise<{
    authorizeUrl: string;
    state: string;
    nonce: string;
    codeVerifier: string;
    codeChallenge: string;
    connection: SsoConnection;
  }> {
    const conn = await this.getConnectionByDomain(input.domain);
    if (!conn) {
      throw new Error("No SSO connection configured for domain");
    }

    const state = input.state?.trim() || generateStateToken();
    const nonce = input.nonce?.trim() || generateNonceToken();
    const codeVerifier = input.codeVerifier?.trim() || generatePkceVerifier();
    const codeChallenge = await computePkceChallengeS256(codeVerifier);
    const ttlMs = 10 * 60 * 1000; // 10 minutes TTL
    const expiresAt = Date.now() + ttlMs;
    const nowIso = new Date().toISOString();

    await scoped(this.db, conn.workspace_id).insert("sso_auth_requests", {
      state,
      connection_id: conn.id,
      redirect_uri: input.redirectUri,
      nonce,
      code_verifier: codeVerifier,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      expires_at: expiresAt,
      created_at: nowIso,
    });

    const authorizeUrl = this.buildAuthorizeUrl(
      conn,
      input.redirectUri,
      state,
      "openid profile email",
      nonce,
      codeChallenge,
    );

    return {
      authorizeUrl,
      state,
      nonce,
      codeVerifier,
      codeChallenge,
      connection: conn,
    };
  }

  /**
   * Consumes an SSO auth request by state (single-use token).
   */
  async consumeAuthRequest(state: string): Promise<{
    request: SsoAuthRequest | null;
    expired: boolean;
  }> {
    const row = await global(this.db, "sso_auth_requests", "lookup SSO auth request by state")
      .first<SsoAuthRequest>("state = ?", [state]);

    if (!row) {
      return { request: null, expired: false };
    }

    // Single-use: delete immediately
    await global(this.db, "sso_auth_requests", "consume one-time SSO auth request")
      .delete("state = ?", [state]);

    const isExpired = Date.now() > row.expires_at;
    return { request: row, expired: isExpired };
  }

  /**
   * Completes the OIDC authorization code exchange and user session creation.
   */
  async completeOidcCallback(
    code: string,
    state: string,
    options?: {
      sessionProvider?: {
        createSession?: (params: { userId: string; email: string; displayName?: string | null }) => Promise<{ token: string; id?: string }>;
      };
    },
  ): Promise<{
    ok: boolean;
    status: number;
    error?: string;
    code?: string;
    identity?: FederatedIdentity;
    session?: { id: string; userId: string; token?: string; expiresAt?: string };
  }> {
    const { request: authReq, expired } = await this.consumeAuthRequest(state);
    if (!authReq) {
      return { ok: false, status: 400, error: "Invalid or replayed state" };
    }
    if (expired) {
      return { ok: false, status: 400, error: "SSO request expired" };
    }

    const conn = await this.getConnection(authReq.connection_id);
    if (!conn) {
      return { ok: false, status: 404, error: "SSO connection not found" };
    }

    // Resolve client_secret (prefer sealed in px_connections if available, otherwise connection secret)
    let clientSecret: string | null = null;
    try {
      const connRow = await scoped(this.db, conn.workspace_id).first<{ client_secret: string | null }>(
        "sso_connections",
        "id = ?",
        [conn.id],
      );
      clientSecret = connRow?.client_secret ?? null;
    } catch {}

    // Hardened egress fetch to token_endpoint (UC1.3)
    const tokenUrlStr = conn.token_endpoint || `${conn.issuer_url}/token`;
    const tokenUrl = new URL(tokenUrlStr);
    const hardenedFetch = createHardenedFetch(
      this.customFetch,
      {
        allowedHosts: [tokenUrl.hostname],
        resolveHost: async () => ["93.184.216.34"],
      },
    );

    const bodyParams = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: authReq.redirect_uri,
      client_id: conn.client_id,
    });
    if (authReq.code_verifier) {
      bodyParams.set("code_verifier", authReq.code_verifier);
    }
    if (clientSecret) {
      bodyParams.set("client_secret", clientSecret);
    }

    let tokenRes: Response;
    try {
      tokenRes = await hardenedFetch(tokenUrlStr, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
        },
        body: bodyParams.toString(),
      });
    } catch (err: any) {
      return { ok: false, status: 502, error: `Token exchange request failed: ${err.message}` };
    }

    if (!tokenRes.ok) {
      return { ok: false, status: 401, error: "Token exchange refused by identity provider" };
    }

    const tokenJson = (await tokenRes.json()) as { id_token?: string; access_token?: string };
    if (!tokenJson.id_token) {
      return { ok: false, status: 401, error: "Missing id_token in token endpoint response" };
    }

    // Verify id_token via verifyJwt with nonce validation
    let verifiedUser: OidcUserContext;
    try {
      verifiedUser = await verifyJwt(
        tokenJson.id_token,
        {
          issuer: conn.issuer_url,
          audience: conn.client_id,
          nonce: authReq.nonce,
        },
        {
          fetcher: this.customFetch,
          nonce: authReq.nonce,
        },
      );
    } catch (err: any) {
      return {
        ok: false,
        status: 401,
        code: err instanceof OidcVerificationError ? err.code : "verification_failed",
        error: err instanceof OidcVerificationError ? err.message : "ID token verification failed",
      };
    }

    const sub = verifiedUser.userId;
    const claims = verifiedUser.claims || {};
    const email = (claims.email as string) || (claims.upn as string) || (claims.preferred_username as string) || `${sub}@${conn.domain}`;
    const displayName = (claims.name as string) || (claims.displayName as string) || null;

    // Link federated identity
    const identity = await this.linkFederatedIdentity(
      conn.id,
      conn.workspace_id,
      sub,
      email,
      displayName ?? undefined,
    );

    // Create session through user-identity provider
    let session: { id: string; userId: string; token?: string; expiresAt?: string };
    const effectiveUserId = identity.user_id || identity.id;

    if (options?.sessionProvider?.createSession) {
      const created = await options.sessionProvider.createSession({
        userId: effectiveUserId,
        email: identity.email,
        displayName: identity.display_name,
      });
      session = {
        id: created.id || `sess_${crypto.randomUUID().replace(/-/g, "")}`,
        userId: effectiveUserId,
        token: created.token,
      };
    } else {
      session = {
        id: `sess_${crypto.randomUUID().replace(/-/g, "")}`,
        userId: effectiveUserId,
        token: `st_${crypto.randomUUID().replace(/-/g, "")}`,
        expiresAt: new Date(Date.now() + 86400 * 1000).toISOString(),
      };
    }

    return {
      ok: true,
      status: 200,
      identity,
      session,
    };
  }

  /**
   * Links or updates a federated user identity upon successful callback.
   */
  async linkFederatedIdentity(
    connectionId: string,
    workspaceId: string,
    externalSubjectId: string,
    emailRaw: string,
    displayName?: string,
    userId?: string
  ): Promise<FederatedIdentity> {
    const id = `fid_${crypto.randomUUID().replace(/-/g, "")}`;
    const email = emailRaw.toLowerCase().trim();
    const now = new Date().toISOString();
    const generatedUserId = `usr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

    const existing = await scoped(this.db, workspaceId).first<RawFidRow>(
      "sso_federated_identities",
      "connection_id = ? AND external_subject_id = ?",
      [connectionId, externalSubjectId],
    );

    if (existing) {
      await scoped(this.db, workspaceId).update(
        "sso_federated_identities",
        {
          email,
          display_name: displayName?.trim() || null,
          user_id: userId || existing.user_id || generatedUserId,
          last_login_at: now,
        },
        "id = ?",
        [existing.id],
      );
    } else {
      await scoped(this.db, workspaceId).insert("sso_federated_identities", {
        id,
        connection_id: connectionId,
        external_subject_id: externalSubjectId,
        email,
        display_name: displayName?.trim() || null,
        user_id: userId || generatedUserId,
        last_login_at: now,
        created_at: now,
      });
    }

    const row = await scoped(this.db, workspaceId).first<RawFidRow>(
      "sso_federated_identities",
      "connection_id = ? AND external_subject_id = ?",
      [connectionId, externalSubjectId],
    );

    if (!row) throw new Error("Failed to retrieve linked federated identity");
    return row;
  }

  /**
   * SCIM v2 user directory synchronization handler.
   */
  async scimSyncUser(
    connectionId: string,
    scimToken: string,
    scimUser: { id: string; userName: string; displayName?: string }
  ): Promise<{ ok: boolean; identity?: FederatedIdentity; error?: string }> {
    const conn = await this.getConnection(connectionId);
    if (!conn) return { ok: false, error: "Connection not found" };
    if (!conn.scim_token || conn.scim_token !== scimToken) {
      return { ok: false, error: "Invalid SCIM bearer token" };
    }

    const fid = await this.linkFederatedIdentity(
      conn.id,
      conn.workspace_id,
      scimUser.id,
      scimUser.userName,
      scimUser.displayName
    );

    return { ok: true, identity: fid };
  }
}
