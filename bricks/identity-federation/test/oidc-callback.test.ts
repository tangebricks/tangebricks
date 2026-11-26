import { env } from "cloudflare:workers";
import type { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration1 from "../migrations/0001_identity_federation.sql?raw";
import migration2 from "../migrations/0002_auth_requests.sql?raw";
import {
  IdentityFederationService,
  createSsoRoutes,
} from "../src/index.ts";

const db = env.DB as D1Like;
const WS_TEST = "ws_sso_oidc_test";

// Helpers for RSA keypair, JWKS and JWT signing
async function generateRsaKeyPair() {
  return await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
}

function base64UrlEncode(bytes: Uint8Array | string): string {
  const binary =
    typeof bytes === "string"
      ? btoa(bytes)
      : btoa(String.fromCharCode(...bytes));
  return binary.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Node's JsonWebKey type has no kid, though exported JWKs carry one in a JWKS; the tests set it.
type Jwk = webcrypto.JsonWebKey & { kid?: string };
/** The key type crypto.subtle.sign takes (CryptoKey is only a value in the Node globals). */
type SigningKey = webcrypto.CryptoKey;

async function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: SigningKey,
): Promise<string> {
  const encHeader = base64UrlEncode(JSON.stringify(header));
  const encPayload = base64UrlEncode(JSON.stringify(payload));
  const data = new TextEncoder().encode(`${encHeader}.${encPayload}`);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, data);
  const encSignature = base64UrlEncode(new Uint8Array(signature));
  return `${encHeader}.${encPayload}.${encSignature}`;
}

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS sso_auth_requests").run();
  await db.prepare("DROP TABLE IF EXISTS sso_federated_identities").run();
  await db.prepare("DROP TABLE IF EXISTS sso_connections").run();
  await applyMigration(db, migration1);
  await applyMigration(db, migration2);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("UC9.7 — Enterprise SSO OIDC callback & authorization-code flow", () => {
  it("Task 1 & AC1: full code flow ends with linked identity row and session for mapped user", async () => {
    const keyPair = await generateRsaKeyPair();
    const publicJwk: Jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    publicJwk.kid = "test-key-1";
    publicJwk.use = "sig";
    publicJwk.alg = "RS256";

    const issuer = "https://acme.okta.com";
    const clientId = "client_okta_enterprise_123";

    // Setup SSO connection
    const service = new IdentityFederationService(db);
    const conn = await service.createConnection({
      workspaceId: WS_TEST,
      domain: "acme.corp",
      providerType: "oidc",
      displayName: "Acme Okta Enterprise",
      clientId,
      clientSecret: "secret_okta_xyz",
      issuerUrl: issuer,
      authorizationEndpoint: `${issuer}/oauth2/v1/authorize`,
      tokenEndpoint: `${issuer}/oauth2/v1/token`,
    });

    let capturedTokenRequestBody: string | null = null;
    let expectedNonce: string | null = null;

    const mockFetcher: typeof fetch = async (input, init) => {
      const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const url = new URL(urlStr);

      if (url.pathname === "/.well-known/openid-configuration") {
        return new Response(JSON.stringify({
          issuer,
          jwks_uri: `${issuer}/oauth2/v1/keys`,
          token_endpoint: `${issuer}/oauth2/v1/token`,
          authorization_endpoint: `${issuer}/oauth2/v1/authorize`,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url.pathname === "/oauth2/v1/keys") {
        return new Response(JSON.stringify({
          keys: [publicJwk],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url.pathname === "/oauth2/v1/token") {
        capturedTokenRequestBody = String(init?.body || "");
        const idToken = await signJwt(
          { alg: "RS256", kid: "test-key-1", typ: "JWT" },
          {
            iss: issuer,
            aud: clientId,
            sub: "okta_sub_alice_456",
            email: "alice@acme.corp",
            name: "Alice Smith",
            nonce: expectedNonce || "test_nonce",
            exp: Math.floor(Date.now() / 1000) + 3600,
            iat: Math.floor(Date.now() / 1000),
          },
          keyPair.privateKey,
        );

        return new Response(JSON.stringify({
          access_token: "mock_access_token_abc",
          id_token: idToken,
          token_type: "Bearer",
          expires_in: 3600,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response("Not found", { status: 404 });
    };

    const fedService = new IdentityFederationService(db, mockFetcher);
    const app = createSsoRoutes({ adapter: { service: fedService } });

    // 1. POST /sso/authorize stores state, nonce, and hashed code_verifier
    const authRes = await app.request("/sso/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        domain: "acme.corp",
        redirectUri: "https://app.projectx.dev/sso/callback",
      }),
    }, { DB: db });

    expect(authRes.status).toBe(200);
    const authBody = await authRes.json() as { authorize_url: string };
    expect(authBody.authorize_url).toBeDefined();

    const authUrl = new URL(authBody.authorize_url);
    const state = authUrl.searchParams.get("state");
    const nonce = authUrl.searchParams.get("nonce");
    expectedNonce = nonce;
    const codeChallenge = authUrl.searchParams.get("code_challenge");
    const codeChallengeMethod = authUrl.searchParams.get("code_challenge_method");

    expect(state).toBeTruthy();
    expect(nonce).toBeTruthy();
    expect(codeChallenge).toBeTruthy();
    expect(codeChallengeMethod).toBe("S256");

    // Verify row stored in sso_auth_requests with 10-minute TTL
    const storedReq = await db.prepare("SELECT * FROM sso_auth_requests WHERE state = ?").bind(state).first<{
      state: string;
      connection_id: string;
      nonce: string;
      code_challenge: string;
      expires_at: number;
    }>();

    expect(storedReq).not.toBeNull();
    expect(storedReq?.connection_id).toBe(conn.id);
    expect(storedReq?.nonce).toBe(nonce);
    expect(storedReq?.code_challenge).toBe(codeChallenge);
    expect(storedReq?.expires_at).toBeGreaterThan(Date.now() + 500 * 1000); // ~10 minutes

    // 2. GET /sso/callback?code&state exchanges code, verifies id_token via verifyJwt, links identity, and creates session
    const callbackRes = await app.request(`/sso/callback?code=mock_auth_code_789&state=${encodeURIComponent(state!)}`, {
      method: "GET",
    }, { DB: db });

    expect(callbackRes.status).toBe(200);
    const callbackBody = await callbackRes.json() as {
      ok: boolean;
      identity: { id: string; email: string; external_subject_id: string; user_id: string };
      session: { id: string; userId: string };
    };

    expect(callbackBody.ok).toBe(true);
    expect(callbackBody.identity.email).toBe("alice@acme.corp");
    expect(callbackBody.identity.external_subject_id).toBe("okta_sub_alice_456");
    expect(callbackBody.identity.user_id).toBeTruthy();
    expect(callbackBody.session.userId).toBe(callbackBody.identity.user_id);

    // Verify linked identity in DB
    const fidRow = await db.prepare("SELECT * FROM sso_federated_identities WHERE connection_id = ? AND external_subject_id = ?")
      .bind(conn.id, "okta_sub_alice_456")
      .first<{ email: string; user_id: string }>();

    expect(fidRow).not.toBeNull();
    expect(fidRow?.email).toBe("alice@acme.corp");
    expect(fidRow?.user_id).toBe(callbackBody.identity.user_id);

    // Verify token endpoint received code_verifier
    expect(capturedTokenRequestBody).toContain("code_verifier=");
    expect(capturedTokenRequestBody).toContain("grant_type=authorization_code");
    expect(capturedTokenRequestBody).toContain("code=mock_auth_code_789");
  });

  it("Task 1 & AC2: replayed state gives 400 (state is single-use)", async () => {
    const service = new IdentityFederationService(db);
    await service.createConnection({
      workspaceId: WS_TEST,
      domain: "acme.corp",
      providerType: "oidc",
      displayName: "Acme Okta",
      clientId: "client_123",
      issuerUrl: "https://acme.okta.com",
    });

    const app = createSsoRoutes({ adapter: { service } });

    const authRes = await app.request("/sso/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        domain: "acme.corp",
        redirectUri: "https://app.projectx.dev/sso/callback",
        state: "state_replay_test_123",
      }),
    }, { DB: db });
    const { authorize_url } = await authRes.json() as { authorize_url: string };
    const state = new URL(authorize_url).searchParams.get("state")!;

    // First attempt consumes state
    await app.request(`/sso/callback?code=mock_code&state=${encodeURIComponent(state)}`, {}, { DB: db });

    // Replay with identical state must be rejected with 400
    const replayRes = await app.request(`/sso/callback?code=mock_code_2&state=${encodeURIComponent(state)}`, {}, { DB: db });
    expect(replayRes.status).toBe(400);
  });

  it("Task 1 & AC1: wrong nonce gives 401", async () => {
    const keyPair = await generateRsaKeyPair();
    const publicJwk: Jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    publicJwk.kid = "test-key-wrong-nonce";
    publicJwk.use = "sig";
    publicJwk.alg = "RS256";

    const issuer = "https://acme.okta.com";
    const clientId = "client_okta_wrong_nonce";

    const service = new IdentityFederationService(db);
    await service.createConnection({
      workspaceId: WS_TEST,
      domain: "acme.corp",
      providerType: "oidc",
      displayName: "Acme Okta",
      clientId,
      issuerUrl: issuer,
    });

    const mockFetcher: typeof fetch = async (input) => {
      const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const url = new URL(urlStr);

      if (url.pathname === "/.well-known/openid-configuration") {
        return new Response(JSON.stringify({
          issuer,
          jwks_uri: `${issuer}/oauth2/v1/keys`,
          token_endpoint: `${issuer}/oauth2/v1/token`,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url.pathname === "/oauth2/v1/keys") {
        return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url.pathname === "/oauth2/v1/token") {
        // Deliberately wrong nonce in id_token
        const idToken = await signJwt(
          { alg: "RS256", kid: "test-key-wrong-nonce", typ: "JWT" },
          {
            iss: issuer,
            aud: clientId,
            sub: "okta_sub_tampered",
            email: "bob@acme.corp",
            nonce: "completely_wrong_nonce_value",
            exp: Math.floor(Date.now() / 1000) + 3600,
            iat: Math.floor(Date.now() / 1000),
          },
          keyPair.privateKey,
        );

        return new Response(JSON.stringify({
          access_token: "mock_access_token",
          id_token: idToken,
          token_type: "Bearer",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response("Not found", { status: 404 });
    };

    const fedService = new IdentityFederationService(db, mockFetcher);
    const app = createSsoRoutes({ adapter: { service: fedService } });

    const authRes = await app.request("/sso/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        domain: "acme.corp",
        redirectUri: "https://app.projectx.dev/sso/callback",
        state: "state_wrong_nonce_test_456",
      }),
    }, { DB: db });
    const { authorize_url } = await authRes.json() as { authorize_url: string };
    const state = new URL(authorize_url).searchParams.get("state")!;

    const callbackRes = await app.request(`/sso/callback?code=mock_code&state=${encodeURIComponent(state)}`, {}, { DB: db });
    expect(callbackRes.status).toBe(401);
  });

  it("Task 1 & AC1: expired auth request gives 400", async () => {
    const service = new IdentityFederationService(db);
    const conn = await service.createConnection({
      workspaceId: WS_TEST,
      domain: "acme.corp",
      providerType: "oidc",
      displayName: "Acme Okta",
      clientId: "client_123",
      issuerUrl: "https://acme.okta.com",
    });

    // Directly insert an expired request into sso_auth_requests
    const expiredState = "expired_state_12345";
    await db.prepare(`
      INSERT INTO sso_auth_requests (state, connection_id, workspace_id, redirect_uri, nonce, code_verifier, code_challenge, code_challenge_method, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      expiredState,
      conn.id,
      WS_TEST,
      "https://app.projectx.dev/sso/callback",
      "nonce_exp",
      "verifier_exp",
      "challenge_exp",
      "S256",
      Date.now() - 60000, // expired 1 minute ago
    ).run();

    const app = createSsoRoutes({ adapter: { service } });

    const callbackRes = await app.request(`/sso/callback?code=mock_code&state=${encodeURIComponent(expiredState)}`, {}, { DB: db });
    expect(callbackRes.status).toBe(400);
  });

  it("Task 1 & AC3: SAML POST /sso/saml/acs returns 501 SSO_SAML_UNSUPPORTED", async () => {
    const app = createSsoRoutes();
    const res = await app.request("/sso/saml/acs", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "SAMLResponse=PHNhbWxwOlJlc3BvbnNlPjwvc2FtbHA6UmVzcG9uc2U+",
    }, { DB: db });

    expect(res.status).toBe(501);
    const body = await res.json() as { error: string; code?: string };
    expect(body.error === "SSO_SAML_UNSUPPORTED" || body.code === "SSO_SAML_UNSUPPORTED").toBe(true);
  });
});
