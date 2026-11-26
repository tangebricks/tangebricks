import type { D1Like } from "@poc/sdk";

export interface OAuthClient {
  client_id: string;
  workspace_id: string;
  client_name: string;
  redirect_uris: string[];
  allowed_scopes: string[];
  is_confidential: boolean;
  created_at: string;
}

export interface RegisterClientInput {
  workspaceId: string;
  clientName: string;
  redirectUris: string[];
  allowedScopes: string[];
  isConfidential?: boolean;
}

export interface ClientRegistrationResult {
  client: OAuthClient;
  clientSecret: string | null;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

export interface IntrospectionResult {
  active: boolean;
  client_id?: string;
  user_id?: string | null;
  workspace_id?: string;
  scope?: string;
  exp?: number;
}

interface RawClientRow {
  client_id: string;
  workspace_id: string;
  client_name: string;
  client_secret_hash: string | null;
  redirect_uris_json: string;
  allowed_scopes_json: string;
  is_confidential: number;
  created_at: string;
}

interface RawCodeRow {
  code: string;
  client_id: string;
  user_id: string;
  workspace_id: string;
  redirect_uri: string;
  scopes_json: string;
  code_challenge: string | null;
  code_challenge_method: string | null;
  expires_at: number;
  used_at: number | null;
  created_at: string;
}

interface RawTokenRow {
  access_token: string;
  refresh_token: string | null;
  client_id: string;
  user_id: string | null;
  workspace_id: string;
  scopes_json: string;
  token_type: string;
  access_token_expires_at: number;
  refresh_token_expires_at: number;
  revoked_at: number | null;
  created_at: string;
}

/**
 * Computes SHA-256 hex digest using WebCrypto
 */
async function hashSecret(secret: string): Promise<string> {
  const enc = new TextEncoder().encode(secret);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Base64URL string encoding without padding
 */
function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) {
    bin += String.fromCharCode(byte);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Computes PKCE S256 code challenge from verifier
 */
export async function computeCodeChallenge(codeVerifier: string): Promise<string> {
  const enc = new TextEncoder().encode(codeVerifier);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return toBase64Url(new Uint8Array(buf));
}

export class OAuthServerService {
  private readonly db: D1Like;

  constructor(db: D1Like) {
    this.db = db;
  }

  /**
   * Registers a new OAuth client.
   */
  async registerClient(input: RegisterClientInput): Promise<ClientRegistrationResult> {
    const clientId = `client_${crypto.randomUUID().replace(/-/g, "")}`;
    const isConfidential = input.isConfidential ?? true;
    let clientSecret: string | null = null;
    let secretHash: string | null = null;

    if (isConfidential) {
      clientSecret = `sec_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
      secretHash = await hashSecret(clientSecret);
    }

    const now = new Date().toISOString();
    const urisJson = JSON.stringify(input.redirectUris);
    const scopesJson = JSON.stringify(input.allowedScopes);

    await this.db.prepare(`
      INSERT INTO oauth_clients (
        client_id, workspace_id, client_name, client_secret_hash,
        redirect_uris_json, allowed_scopes_json, is_confidential, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      clientId,
      input.workspaceId,
      input.clientName.trim(),
      secretHash,
      urisJson,
      scopesJson,
      isConfidential ? 1 : 0,
      now
    ).run();

    return {
      client: {
        client_id: clientId,
        workspace_id: input.workspaceId,
        client_name: input.clientName.trim(),
        redirect_uris: input.redirectUris,
        allowed_scopes: input.allowedScopes,
        is_confidential: isConfidential,
        created_at: now,
      },
      clientSecret,
    };
  }

  /**
   * Retrieves a client by ID.
   */
  async getClient(clientId: string): Promise<OAuthClient | null> {
    const row = await this.db.prepare(
      "SELECT * FROM oauth_clients WHERE client_id = ?"
    ).bind(clientId).first<RawClientRow>();

    if (!row) return null;

    return {
      client_id: row.client_id,
      workspace_id: row.workspace_id,
      client_name: row.client_name,
      redirect_uris: JSON.parse(row.redirect_uris_json || "[]"),
      allowed_scopes: JSON.parse(row.allowed_scopes_json || "[]"),
      is_confidential: row.is_confidential === 1,
      created_at: row.created_at,
    };
  }

  /**
   * Verifies client authentication credentials.
   */
  private async authenticateClient(clientId: string, clientSecret?: string): Promise<RawClientRow> {
    const client = await this.db.prepare(
      "SELECT * FROM oauth_clients WHERE client_id = ?"
    ).bind(clientId).first<RawClientRow>();

    if (!client) {
      throw new Error("invalid_client: Client does not exist");
    }

    if (client.is_confidential === 1) {
      if (!clientSecret) {
        throw new Error("invalid_client: Client secret required for confidential client");
      }
      const hashed = await hashSecret(clientSecret);
      if (hashed !== client.client_secret_hash) {
        throw new Error("invalid_client: Client secret mismatch");
      }
    }

    return client;
  }

  /**
   * Issues an authorization code (RFC 6749 + RFC 7636 PKCE).
   */
  async createAuthorizationCode(input: {
    clientId: string;
    userId: string;
    workspaceId: string;
    redirectUri: string;
    scopes: string[];
    codeChallenge?: string;
    codeChallengeMethod?: "S256" | "plain";
  }): Promise<{ code: string; redirectUri: string }> {
    const client = await this.getClient(input.clientId);
    if (!client) {
      throw new Error("invalid_client: Client does not exist");
    }

    if (!client.redirect_uris.includes(input.redirectUri)) {
      throw new Error("invalid_request: Redirect URI not registered");
    }

    // Validate scopes
    for (const sc of input.scopes) {
      if (!client.allowed_scopes.includes(sc)) {
        throw new Error(`invalid_scope: Requested scope '${sc}' not permitted`);
      }
    }

    const code = `code_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    await this.db.prepare(`
      INSERT INTO oauth_auth_codes (
        code, client_id, user_id, workspace_id, redirect_uri,
        scopes_json, code_challenge, code_challenge_method,
        expires_at, used_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).bind(
      code,
      input.clientId,
      input.userId,
      input.workspaceId,
      input.redirectUri,
      JSON.stringify(input.scopes),
      input.codeChallenge || null,
      input.codeChallengeMethod || null,
      expiresAt,
      now
    ).run();

    return { code, redirectUri: input.redirectUri };
  }

  /**
   * Exchanges an authorization code for access and refresh tokens.
   */
  async exchangeAuthorizationCode(input: {
    clientId: string;
    clientSecret?: string;
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<TokenResponse> {
    const client = await this.authenticateClient(input.clientId, input.clientSecret);

    const codeRow = await this.db.prepare(
      "SELECT * FROM oauth_auth_codes WHERE code = ? AND client_id = ?"
    ).bind(input.code, input.clientId).first<RawCodeRow>();

    if (!codeRow) {
      throw new Error("invalid_grant: Invalid authorization code");
    }

    if (codeRow.used_at !== null) {
      throw new Error("invalid_grant: Authorization code already used");
    }

    if (Date.now() > codeRow.expires_at) {
      throw new Error("invalid_grant: Authorization code expired");
    }

    if (codeRow.redirect_uri !== input.redirectUri) {
      throw new Error("invalid_grant: Redirect URI mismatch");
    }

    // Verify PKCE if challenge was set
    if (codeRow.code_challenge) {
      if (!input.codeVerifier) {
        throw new Error("invalid_grant: PKCE code_verifier required");
      }

      if (codeRow.code_challenge_method === "S256") {
        const computed = await computeCodeChallenge(input.codeVerifier);
        if (computed !== codeRow.code_challenge) {
          throw new Error("invalid_grant: PKCE verification failed");
        }
      } else {
        if (input.codeVerifier !== codeRow.code_challenge) {
          throw new Error("invalid_grant: PKCE verification failed");
        }
      }
    }

    // Mark code as used
    await this.db.prepare(
      "UPDATE oauth_auth_codes SET used_at = ? WHERE code = ?"
    ).bind(Date.now(), input.code).run();

    // Generate tokens
    const accessToken = `at_${crypto.randomUUID().replace(/-/g, "")}`;
    const refreshToken = `rt_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const accessExp = Date.now() + 3600 * 1000; // 1 hour
    const refreshExp = Date.now() + 30 * 86400 * 1000; // 30 days

    await this.db.prepare(`
      INSERT INTO oauth_tokens (
        access_token, refresh_token, client_id, user_id, workspace_id,
        scopes_json, token_type, access_token_expires_at, refresh_token_expires_at,
        revoked_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'Bearer', ?, ?, NULL, ?)
    `).bind(
      accessToken,
      refreshToken,
      client.client_id,
      codeRow.user_id,
      codeRow.workspace_id,
      codeRow.scopes_json,
      accessExp,
      refreshExp,
      now
    ).run();

    const scopes: string[] = JSON.parse(codeRow.scopes_json || "[]");

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  /**
   * Refreshes an access token using a refresh token.
   */
  async refreshAccessToken(input: {
    clientId: string;
    clientSecret?: string;
    refreshToken: string;
  }): Promise<TokenResponse> {
    const client = await this.authenticateClient(input.clientId, input.clientSecret);

    const tokenRow = await this.db.prepare(
      "SELECT * FROM oauth_tokens WHERE refresh_token = ? AND client_id = ?"
    ).bind(input.refreshToken, input.clientId).first<RawTokenRow>();

    if (!tokenRow) {
      throw new Error("invalid_grant: Invalid refresh token");
    }

    if (tokenRow.revoked_at !== null) {
      throw new Error("invalid_grant: Token has been revoked");
    }

    if (Date.now() > tokenRow.refresh_token_expires_at) {
      throw new Error("invalid_grant: Refresh token expired");
    }

    // Revoke old refresh token (refresh token rotation)
    await this.db.prepare(
      "UPDATE oauth_tokens SET revoked_at = ? WHERE refresh_token = ?"
    ).bind(Date.now(), input.refreshToken).run();

    // Issue new pair
    const newAccessToken = `at_${crypto.randomUUID().replace(/-/g, "")}`;
    const newRefreshToken = `rt_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const accessExp = Date.now() + 3600 * 1000;
    const refreshExp = Date.now() + 30 * 86400 * 1000;

    await this.db.prepare(`
      INSERT INTO oauth_tokens (
        access_token, refresh_token, client_id, user_id, workspace_id,
        scopes_json, token_type, access_token_expires_at, refresh_token_expires_at,
        revoked_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'Bearer', ?, ?, NULL, ?)
    `).bind(
      newAccessToken,
      newRefreshToken,
      client.client_id,
      tokenRow.user_id,
      tokenRow.workspace_id,
      tokenRow.scopes_json,
      accessExp,
      refreshExp,
      now
    ).run();

    const scopes: string[] = JSON.parse(tokenRow.scopes_json || "[]");

    return {
      access_token: newAccessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: newRefreshToken,
      scope: scopes.join(" "),
    };
  }

  /**
   * Client credentials grant (machine-to-machine, no user context).
   */
  async exchangeClientCredentials(input: {
    clientId: string;
    clientSecret?: string;
    scopes?: string[];
  }): Promise<TokenResponse> {
    const client = await this.authenticateClient(input.clientId, input.clientSecret);

    const allowedScopes: string[] = JSON.parse(client.allowed_scopes_json || "[]");
    const requestedScopes = input.scopes || allowedScopes;

    for (const sc of requestedScopes) {
      if (!allowedScopes.includes(sc)) {
        throw new Error(`invalid_scope: Scope '${sc}' not permitted`);
      }
    }

    const accessToken = `at_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const accessExp = Date.now() + 7200 * 1000; // 2 hours
    const refreshExp = Date.now(); // No refresh token for client credentials

    await this.db.prepare(`
      INSERT INTO oauth_tokens (
        access_token, refresh_token, client_id, user_id, workspace_id,
        scopes_json, token_type, access_token_expires_at, refresh_token_expires_at,
        revoked_at, created_at
      ) VALUES (?, NULL, ?, NULL, ?, ?, 'Bearer', ?, ?, NULL, ?)
    `).bind(
      accessToken,
      client.client_id,
      client.workspace_id,
      JSON.stringify(requestedScopes),
      accessExp,
      refreshExp,
      now
    ).run();

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 7200,
      scope: requestedScopes.join(" "),
    };
  }

  /**
   * Introspects an active access token (RFC 7662).
   */
  async introspectToken(token: string): Promise<IntrospectionResult> {
    const row = await this.db.prepare(
      "SELECT * FROM oauth_tokens WHERE access_token = ?"
    ).bind(token).first<RawTokenRow>();

    if (!row || row.revoked_at !== null || Date.now() > row.access_token_expires_at) {
      return { active: false };
    }

    const scopes: string[] = JSON.parse(row.scopes_json || "[]");

    return {
      active: true,
      client_id: row.client_id,
      user_id: row.user_id,
      workspace_id: row.workspace_id,
      scope: scopes.join(" "),
      exp: Math.floor(row.access_token_expires_at / 1000),
    };
  }

  /**
   * Revokes a token (RFC 7009).
   */
  async revokeToken(token: string): Promise<boolean> {
    const now = Date.now();
    const res = await this.db.prepare(`
      UPDATE oauth_tokens
      SET revoked_at = ?
      WHERE access_token = ? OR refresh_token = ?
    `).bind(now, token, token).run();

    return res.meta.changes > 0;
  }

  /**
   * Lists clients in a workspace.
   */
  async listClients(workspaceId: string): Promise<OAuthClient[]> {
    const rows = (await this.db.prepare(
      "SELECT * FROM oauth_clients WHERE workspace_id = ? ORDER BY created_at DESC"
    ).bind(workspaceId).all<RawClientRow>()).results;

    return rows.map((r) => ({
      client_id: r.client_id,
      workspace_id: r.workspace_id,
      client_name: r.client_name,
      redirect_uris: JSON.parse(r.redirect_uris_json || "[]"),
      allowed_scopes: JSON.parse(r.allowed_scopes_json || "[]"),
      is_confidential: r.is_confidential === 1,
      created_at: r.created_at,
    }));
  }
}
