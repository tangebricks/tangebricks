import { env } from "cloudflare:workers";
import type { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import mwMigrationSql from "../../multi-workspace/migrations/0001_multi_workspace.sql?raw";
import { createOidcMiddleware, verifyJwt, type OidcVerifyConfig } from "../src/index.ts";

// WebCrypto test helpers to create JWKS and JWT tokens
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

async function generateEcdsaKeyPair() {
  return await crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["sign", "verify"],
  );
}

function base64UrlEncode(bytes: Uint8Array | string): string {
  const binary = typeof bytes === "string" ? btoa(bytes) : btoa(String.fromCharCode(...bytes));
  return binary.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Node's JsonWebKey type has no kid, though exported JWKs carry one in a JWKS; the tests set it.
type Jwk = webcrypto.JsonWebKey & { kid?: string };
/** The key type crypto.subtle.sign takes (CryptoKey is only a value in the Node globals). */
type SigningKey = webcrypto.CryptoKey;

async function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, key: SigningKey): Promise<string> {
  const encHeader = base64UrlEncode(JSON.stringify(header));
  const encPayload = base64UrlEncode(JSON.stringify(payload));
  const data = new TextEncoder().encode(`${encHeader}.${encPayload}`);

  let signature: ArrayBuffer;
  if (key.algorithm.name === "ECDSA") {
    signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data);
  } else if (key.algorithm.name === "RSASSA-PKCS1-v1_5") {
    signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data);
  } else if (key.algorithm.name === "HMAC") {
    signature = await crypto.subtle.sign("HMAC", key, data);
  } else {
    throw new Error(`Unsupported key algorithm: ${key.algorithm.name}`);
  }

  const encSignature = base64UrlEncode(new Uint8Array(signature));
  return `${encHeader}.${encPayload}.${encSignature}`;
}

const membershipDb = env.DB as unknown as D1Like;

/** A Worker env whose DB holds the multi-workspace tables with exactly these memberships. */
async function membershipEnv(members: Array<{ workspaceId: string; userId: string; role: "owner" | "admin" | "member" }>): Promise<{ DB: D1Like }> {
  await membershipDb.prepare("DROP TABLE IF EXISTS mw_members").run();
  await membershipDb.prepare("DROP TABLE IF EXISTS mw_workspaces").run();
  await applyMigration(membershipDb, mwMigrationSql);
  for (const m of members) {
    await membershipDb.prepare("INSERT OR IGNORE INTO mw_workspaces (id, name, owner_id) VALUES (?, ?, ?)").bind(m.workspaceId, m.workspaceId, m.userId).run();
    await membershipDb.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, ?, ?)").bind(m.workspaceId, m.userId, m.role).run();
  }
  return { DB: membershipDb };
}

describe("UC9.6 — OIDC Verify conformance test suite", () => {
  it("Task 1 & AC1: Supabase ES256 token conformance", async () => {
    const keyPair = await generateEcdsaKeyPair();
    const publicJwk: Jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    publicJwk.kid = "supa-key-1";
    publicJwk.use = "sig";
    publicJwk.alg = "ES256";

    const issuer = "https://xyzcompany.supabase.co/auth/v1";
    const jwksUri = `${issuer}/.well-known/jwks.json`;

    const fetcher = async (url: string | URL | Request): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr === jwksUri) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Cache-Control": "max-age=3600" },
        });
      }
      return new Response("Not Found", { status: 404 });
    };

    const token = await signJwt(
      { alg: "ES256", typ: "JWT", kid: "supa-key-1" },
      {
        iss: issuer,
        aud: "authenticated",
        sub: "usr_supa_123",
        role: "admin",
        app_metadata: { workspace_id: "ws_supa_999" },
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      keyPair.privateKey,
    );

    const config: OidcVerifyConfig = {
      issuer,
      audience: "authenticated",
      jwksUri,
      algorithms: ["ES256"],
      userIdClaim: "sub",
      workspaceClaim: "app_metadata.workspace_id",
      rolesClaim: "role",
    };

    const user = await verifyJwt(token, config, { fetcher });
    expect(user.userId).toBe("usr_supa_123");
    expect(user.workspaceId).toBe("ws_supa_999");
    expect(user.roles).toEqual(["admin"]);
  });

  it("Task 1 & AC1: Clerk RS256 token conformance", async () => {
    const keyPair = await generateRsaKeyPair();
    const publicJwk: Jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    publicJwk.kid = "clerk-key-1";
    publicJwk.use = "sig";
    publicJwk.alg = "RS256";

    const issuer = "https://clerk.example.com";
    const jwksUri = `${issuer}/.well-known/jwks.json`;

    const fetcher = async (_url: string | URL | Request): Promise<Response> => {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=3600" },
      });
    };

    const token = await signJwt(
      { alg: "RS256", typ: "JWT", kid: "clerk-key-1" },
      {
        iss: issuer,
        sub: "user_clerk_456",
        org_id: "org_clerk_888",
        org_role: "org:admin",
        azp: "clerk_client_id",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      keyPair.privateKey,
    );

    const config: OidcVerifyConfig = {
      issuer,
      audience: "clerk_client_id",
      audienceClaim: "azp",
      jwksUri,
      algorithms: ["RS256"],
      userIdClaim: "sub",
      workspaceClaim: "org_id",
      rolesClaim: "org_role",
    };

    const user = await verifyJwt(token, config, { fetcher });
    expect(user.userId).toBe("user_clerk_456");
    expect(user.workspaceId).toBe("org_clerk_888");
    expect(user.roles).toEqual(["org:admin"]);
  });

  it("Task 1 & AC1: Auth0 RS256 token conformance with aud array and namespaced roles", async () => {
    const keyPair = await generateRsaKeyPair();
    const publicJwk: Jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    publicJwk.kid = "auth0-key-1";
    publicJwk.use = "sig";
    publicJwk.alg = "RS256";

    const issuer = "https://mytenant.us.auth0.com/";
    const jwksUri = `${issuer}.well-known/jwks.json`;

    const fetcher = async (): Promise<Response> => {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=3600" },
      });
    };

    const token = await signJwt(
      { alg: "RS256", typ: "JWT", kid: "auth0-key-1" },
      {
        iss: issuer,
        aud: ["https://api.myproject.com", "https://mytenant.us.auth0.com/userinfo"],
        sub: "auth0|789",
        "https://app/roles": ["admin", "editor"],
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      keyPair.privateKey,
    );

    const config: OidcVerifyConfig = {
      issuer,
      audience: "https://api.myproject.com",
      jwksUri,
      algorithms: ["RS256"],
      userIdClaim: "sub",
      rolesClaim: "https://app/roles",
    };

    const user = await verifyJwt(token, config, { fetcher });
    expect(user.userId).toBe("auth0|789");
    expect(user.roles).toEqual(["admin", "editor"]);
  });

  it("Task 1 & AC1: Cognito access token conformance with client_id audience and cognito:groups", async () => {
    const keyPair = await generateRsaKeyPair();
    const publicJwk: Jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    publicJwk.kid = "cognito-key-1";
    publicJwk.use = "sig";
    publicJwk.alg = "RS256";

    const issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_xyz";
    const jwksUri = `${issuer}/.well-known/jwks.json`;

    const fetcher = async (): Promise<Response> => {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=3600" },
      });
    };

    const token = await signJwt(
      { alg: "RS256", typ: "JWT", kid: "cognito-key-1" },
      {
        iss: issuer,
        token_use: "access",
        client_id: "cognito_client_123",
        sub: "cognito_usr_001",
        "cognito:groups": ["SuperAdmins"],
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      keyPair.privateKey,
    );

    const config: OidcVerifyConfig = {
      issuer,
      audience: "cognito_client_123",
      audienceClaim: "client_id",
      jwksUri,
      algorithms: ["RS256"],
      userIdClaim: "sub",
      rolesClaim: "cognito:groups",
    };

    const user = await verifyJwt(token, config, { fetcher });
    expect(user.userId).toBe("cognito_usr_001");
    expect(user.roles).toEqual(["SuperAdmins"]);
  });

  it("Task 1 & AC1: Keycloak token conformance with realm_access.roles and azp", async () => {
    const keyPair = await generateRsaKeyPair();
    const publicJwk: Jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    publicJwk.kid = "keycloak-key-1";
    publicJwk.use = "sig";
    publicJwk.alg = "RS256";

    const issuer = "https://keycloak.example.com/realms/myrealm";
    const jwksUri = `${issuer}/protocol/openid-connect/certs`;

    const fetcher = async (): Promise<Response> => {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=3600" },
      });
    };

    const token = await signJwt(
      { alg: "RS256", typ: "JWT", kid: "keycloak-key-1" },
      {
        iss: issuer,
        azp: "my_keycloak_client",
        sub: "keycloak_usr_555",
        realm_access: { roles: ["manager", "user"] },
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      keyPair.privateKey,
    );

    const config: OidcVerifyConfig = {
      issuer,
      audience: "my_keycloak_client",
      audienceClaim: "azp",
      jwksUri,
      algorithms: ["RS256"],
      userIdClaim: "sub",
      rolesClaim: "realm_access.roles",
    };

    const user = await verifyJwt(token, config, { fetcher });
    expect(user.userId).toBe("keycloak_usr_555");
    expect(user.roles).toEqual(["manager", "user"]);
  });

  it("Task 1 & AC1: Negative cases return 401 with reason codes without leaking token", async () => {
    const keyPair = await generateRsaKeyPair();
    const publicJwk: Jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    publicJwk.kid = "neg-key-1";
    publicJwk.use = "sig";
    publicJwk.alg = "RS256";

    const issuer = "https://auth.example.com";
    const jwksUri = `${issuer}/jwks.json`;

    const fetcher = async (): Promise<Response> => {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=3600" },
      });
    };

    const baseConfig: OidcVerifyConfig = {
      issuer,
      audience: "api://default",
      jwksUri,
      algorithms: ["RS256"],
      clockSkewSec: 30,
    };

    const nowSec = 1700000000;

    // 1. Expired token
    const expiredToken = await signJwt(
      { alg: "RS256", kid: "neg-key-1" },
      { iss: issuer, aud: "api://default", sub: "u1", exp: nowSec - 60 },
      keyPair.privateKey,
    );
    await expect(verifyJwt(expiredToken, baseConfig, { fetcher, now: () => nowSec * 1000 })).rejects.toMatchObject({ code: "token_expired" });

    // 2. nbf in future beyond skew
    const futureToken = await signJwt(
      { alg: "RS256", kid: "neg-key-1" },
      { iss: issuer, aud: "api://default", sub: "u1", exp: nowSec + 3600, nbf: nowSec + 120 },
      keyPair.privateKey,
    );
    await expect(verifyJwt(futureToken, baseConfig, { fetcher, now: () => nowSec * 1000 })).rejects.toMatchObject({ code: "token_not_yet_valid" });

    // 3. Wrong issuer
    const wrongIssToken = await signJwt(
      { alg: "RS256", kid: "neg-key-1" },
      { iss: "https://attacker.example.com", aud: "api://default", sub: "u1", exp: nowSec + 3600 },
      keyPair.privateKey,
    );
    await expect(verifyJwt(wrongIssToken, baseConfig, { fetcher, now: () => nowSec * 1000 })).rejects.toMatchObject({ code: "issuer_mismatch" });

    // 4. Wrong audience
    const wrongAudToken = await signJwt(
      { alg: "RS256", kid: "neg-key-1" },
      { iss: issuer, aud: "api://wrong", sub: "u1", exp: nowSec + 3600 },
      keyPair.privateKey,
    );
    await expect(verifyJwt(wrongAudToken, baseConfig, { fetcher, now: () => nowSec * 1000 })).rejects.toMatchObject({ code: "audience_mismatch" });

    // 5. alg: none
    const algNoneToken = `${base64UrlEncode(JSON.stringify({ alg: "none", typ: "JWT" }))}.${base64UrlEncode(
      JSON.stringify({ iss: issuer, aud: "api://default", sub: "u1", exp: nowSec + 3600 }),
    )}.`;
    await expect(verifyJwt(algNoneToken, baseConfig, { fetcher, now: () => nowSec * 1000 })).rejects.toMatchObject({ code: "alg_not_allowed" });

    // 6. Algorithm confusion: HS256 signed with RSA public key bytes
    const rsaExportedPub = await crypto.subtle.exportKey("spki", keyPair.publicKey);
    const hmacKey = await crypto.subtle.importKey("raw", rsaExportedPub, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const confusionToken = await signJwt(
      { alg: "HS256", typ: "JWT", kid: "neg-key-1" },
      { iss: issuer, aud: "api://default", sub: "u1", exp: nowSec + 3600 },
      hmacKey,
    );
    await expect(verifyJwt(confusionToken, baseConfig, { fetcher, now: () => nowSec * 1000 })).rejects.toMatchObject({ code: "alg_not_allowed" });

    // 7. Unknown kid after refetch
    const unknownKidToken = await signJwt(
      { alg: "RS256", kid: "non-existent-kid" },
      { iss: issuer, aud: "api://default", sub: "u1", exp: nowSec + 3600 },
      keyPair.privateKey,
    );
    await expect(verifyJwt(unknownKidToken, baseConfig, { fetcher, now: () => nowSec * 1000 })).rejects.toMatchObject({ code: "kid_unknown" });

    // 8. Malformed token
    await expect(verifyJwt("not-a-valid-token", baseConfig, { fetcher, now: () => nowSec * 1000 })).rejects.toMatchObject({ code: "malformed_token" });

    // 9. Down JWKS endpoint with expired/no cache
    const failingFetcher = async (): Promise<Response> => {
      return new Response("Service Unavailable", { status: 503 });
    };
    await expect(
      verifyJwt(
        expiredToken,
        { ...baseConfig, jwksUri: "https://down.example.com/jwks.json" },
        {
          fetcher: failingFetcher,
          now: () => nowSec * 1000,
        },
      ),
    ).rejects.toMatchObject({ code: "jwks_unavailable" });
  });

  it("Task 1 & AC2: Key rotation triggers exactly one JWKS refetch on unknown kid", async () => {
    const keyPair1 = await generateRsaKeyPair();
    const publicJwk1: Jwk = await crypto.subtle.exportKey("jwk", keyPair1.publicKey);
    publicJwk1.kid = "rot-key-1";
    publicJwk1.use = "sig";
    publicJwk1.alg = "RS256";

    const keyPair2 = await generateRsaKeyPair();
    const publicJwk2: Jwk = await crypto.subtle.exportKey("jwk", keyPair2.publicKey);
    publicJwk2.kid = "rot-key-2";
    publicJwk2.use = "sig";
    publicJwk2.alg = "RS256";

    let publishedKeys = [publicJwk1];
    let fetchCount = 0;

    const issuer = "https://rotation.example.com";
    const jwksUri = `${issuer}/jwks.json`;

    const fetcher = async (_url: string | URL | Request): Promise<Response> => {
      fetchCount += 1;
      return new Response(JSON.stringify({ keys: publishedKeys }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=3600" },
      });
    };

    const config: OidcVerifyConfig = {
      issuer,
      audience: "api://rotation",
      jwksUri,
      algorithms: ["RS256"],
    };

    const token1 = await signJwt(
      { alg: "RS256", kid: "rot-key-1" },
      { iss: issuer, aud: "api://rotation", sub: "user-1", exp: Math.floor(Date.now() / 1000) + 3600 },
      keyPair1.privateKey,
    );

    // Initial verify fetches keys (fetchCount = 1)
    const res1 = await verifyJwt(token1, config, { fetcher });
    expect(res1.userId).toBe("user-1");
    expect(fetchCount).toBe(1);

    // Subsequent verify of token with known kid uses cache (fetchCount stays 1)
    await verifyJwt(token1, config, { fetcher });
    expect(fetchCount).toBe(1);

    // Rotate: publish key 2, retire key 1
    publishedKeys = [publicJwk2];

    const token2 = await signJwt(
      { alg: "RS256", kid: "rot-key-2" },
      { iss: issuer, aud: "api://rotation", sub: "user-2", exp: Math.floor(Date.now() / 1000) + 3600 },
      keyPair2.privateKey,
    );

    // Encountering new kid rot-key-2 triggers exactly one refetch (fetchCount = 2)
    const res2 = await verifyJwt(token2, config, { fetcher });
    expect(res2.userId).toBe("user-2");
    expect(fetchCount).toBe(2);

    // Second check uses cached rotated key (fetchCount stays 2)
    await verifyJwt(token2, config, { fetcher });
    expect(fetchCount).toBe(2);
  });

  it("Task 4 & AC1: oidcMiddleware sets c.set('user', ...) and returns 401 without leaking token", async () => {
    const keyPair = await generateRsaKeyPair();
    const publicJwk: Jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    publicJwk.kid = "mid-key-1";
    publicJwk.use = "sig";
    publicJwk.alg = "RS256";

    const issuer = "https://mid.example.com";
    const jwksUri = `${issuer}/jwks.json`;

    const fetcher = async (): Promise<Response> => {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=3600" },
      });
    };

    const config: OidcVerifyConfig = {
      issuer,
      audience: "api://middleware",
      jwksUri,
      algorithms: ["RS256"],
      userIdClaim: "sub",
      workspaceClaim: "ws_id",
      rolesClaim: "roles",
    };

    const app = new Hono();
    app.use("/api/*", createOidcMiddleware(config, { fetcher }));
    app.get("/api/me", (c) => {
      const user = c.get("user" as any);
      const workspace = c.get("workspace" as any);
      return c.json({ user, workspace });
    });

    const validToken = await signJwt(
      { alg: "RS256", kid: "mid-key-1" },
      {
        iss: issuer,
        aud: "api://middleware",
        sub: "usr_alice",
        ws_id: "ws_acme",
        roles: ["admin"],
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      keyPair.privateKey,
    );

    // Story 0.14: the mapped workspace is honoured only for a member of it (the multi-workspace membership table).
    const appEnv = await membershipEnv([{ workspaceId: "ws_acme", userId: "usr_alice", role: "admin" }]);

    // Valid bearer token returns 200 and mapped user context
    const validRes = await app.fetch(
      new Request("http://localhost/api/me", {
        headers: { Authorization: `Bearer ${validToken}` },
      }),
      appEnv,
    );
    expect(validRes.status).toBe(200);
    const validBody = (await validRes.json()) as any;
    expect(validBody.user.id).toBe("usr_alice");
    expect(validBody.user.uid).toBe("usr_alice");
    expect(validBody.user.workspaceId).toBe("ws_acme");
    expect(validBody.user.roles).toEqual(["admin"]);
    expect(validBody.workspace).toEqual({ id: "ws_acme", role: "admin", suspended: false });

    // Invalid bearer token returns 401 with error reason and does NOT leak token
    const invalidToken = "eyJhbGciOiJSUzI1NiJ9.invalid.signature";
    const invalidRes = await app.fetch(
      new Request("http://localhost/api/me", {
        headers: { Authorization: `Bearer ${invalidToken}` },
      }),
    );
    expect(invalidRes.status).toBe(401);
    const invalidBody = (await invalidRes.json()) as any;
    expect(invalidBody.error).toBeDefined();
    const responseText = JSON.stringify(invalidBody);
    expect(responseText).not.toContain(invalidToken);
  });
});

// Story 0.14 (S6): exp is required, nbf/iat in the future are refused (all with the configurable skew), and a token
// mapped to a workspace is honoured only for a member of it.
describe("oidc-verify claim and membership hardening (story 0.14)", () => {
  async function setup() {
    const keyPair = await generateRsaKeyPair();
    const publicJwk: Jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    publicJwk.kid = "hard-key-1";
    publicJwk.use = "sig";
    publicJwk.alg = "RS256";
    // A fresh issuer per test, so the JWKS cache (keyed by URI) never serves another test's key.
    const issuer = `https://hardening-${crypto.randomUUID().slice(0, 8)}.example.com`;
    const fetcher = async (): Promise<Response> =>
      new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=3600" },
      });
    const config: OidcVerifyConfig = {
      issuer,
      audience: "api://hardening",
      jwksUri: `${issuer}/jwks.json`,
      algorithms: ["RS256"],
      workspaceClaim: "ws_id",
    };
    const sign = (payload: Record<string, unknown>) =>
      signJwt({ alg: "RS256", kid: "hard-key-1" }, { iss: issuer, aud: "api://hardening", sub: "usr_bob", ...payload }, keyPair.privateKey);
    return { config, fetcher, sign };
  }

  const nowSec = () => Math.floor(Date.now() / 1000);

  async function codeOf(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
      return "accepted";
    } catch (err) {
      return (err as { code?: string }).code ?? "unknown";
    }
  }

  it("JWT_NO_EXP: a validly signed token without exp is refused", async () => {
    const { config, fetcher, sign } = await setup();
    expect(await codeOf(verifyJwt(await sign({}), config, { fetcher }))).toBe("missing_exp");
    expect(await codeOf(verifyJwt(await sign({ exp: "never" }), config, { fetcher }))).toBe("missing_exp");
    // The same token with an exp is accepted, so the refusal is about exp alone.
    expect(await codeOf(verifyJwt(await sign({ exp: nowSec() + 600 }), config, { fetcher }))).toBe("accepted");
  });

  it("JWT_EXPIRED: exp in the past beyond the skew is refused; within the skew it is accepted", async () => {
    const { config, fetcher, sign } = await setup();
    expect(await codeOf(verifyJwt(await sign({ exp: nowSec() - 120 }), config, { fetcher }))).toBe("token_expired");
    expect(await codeOf(verifyJwt(await sign({ exp: nowSec() - 30 }), config, { fetcher }))).toBe("accepted");
    // The skew is configurable.
    expect(await codeOf(verifyJwt(await sign({ exp: nowSec() - 30 }), { ...config, clockSkewSec: 0 }, { fetcher }))).toBe("token_expired");
  });

  it("JWT_FUTURE_NBF: nbf or iat in the future beyond the skew is refused", async () => {
    const { config, fetcher, sign } = await setup();
    const exp = nowSec() + 3600;
    expect(await codeOf(verifyJwt(await sign({ exp, nbf: nowSec() + 300 }), config, { fetcher }))).toBe("token_not_yet_valid");
    expect(await codeOf(verifyJwt(await sign({ exp, iat: nowSec() + 300 }), config, { fetcher }))).toBe("token_issued_in_future");
    expect(await codeOf(verifyJwt(await sign({ exp, nbf: nowSec() + 30, iat: nowSec() + 30 }), config, { fetcher }))).toBe("accepted");
  });

  it("aud and iss stay required", async () => {
    const { config, fetcher, sign } = await setup();
    const exp = nowSec() + 3600;
    expect(await codeOf(verifyJwt(await sign({ exp, aud: undefined }), config, { fetcher }))).toBe("audience_mismatch");
    expect(await codeOf(verifyJwt(await sign({ exp, iss: undefined }), config, { fetcher }))).toBe("issuer_mismatch");
    expect(await codeOf(verifyJwt(await sign({ exp, aud: "" }), { ...config, audience: "" }, { fetcher }))).toBe("audience_mismatch");
  });

  it("JWT_NOT_MEMBER: a valid token whose subject is not in the mapped workspace gets 403", async () => {
    const { config, fetcher, sign } = await setup();
    const app = new Hono();
    app.use("/api/*", createOidcMiddleware(config, { fetcher }));
    app.get("/api/me", (c) => c.json({ user: c.get("user" as any), workspace: c.get("workspace" as any) }));
    const exp = nowSec() + 3600;
    const appEnv = await membershipEnv([
      { workspaceId: "ws_bob", userId: "usr_bob", role: "member" },
      { workspaceId: "ws_other", userId: "usr_carol", role: "owner" },
    ]);
    const get = async (token: string, envOverride: unknown = appEnv) =>
      app.fetch(new Request("http://localhost/api/me", { headers: { Authorization: `Bearer ${token}` } }), envOverride);

    // Member: allowed, and the role comes from the membership row, not from the token.
    const member = await get(await sign({ exp, ws_id: "ws_bob", roles: ["owner"] }));
    expect(member.status).toBe(200);
    expect(((await member.json()) as any).workspace).toEqual({ id: "ws_bob", role: "member", suspended: false });

    // Not a member of the workspace the token names: 403.
    const notMember = await get(await sign({ exp, ws_id: "ws_other" }));
    expect(notMember.status).toBe(403);
    expect(((await notMember.json()) as any).error).toBe("not_workspace_member");

    // A workspace that does not exist: 403.
    expect((await get(await sign({ exp, ws_id: "ws_missing" }))).status).toBe(403);

    // No database to check membership against: a loud 500, never trusted and never a quiet "not a member".
    const noDb = await get(await sign({ exp, ws_id: "ws_bob" }), {});
    expect(noDb.status).toBe(500);
    expect(((await noDb.json()) as any).error).toBe("workspace_membership_unavailable");

    // Membership tables missing (multi-workspace not migrated): the same loud 500.
    await membershipDb.prepare("DROP TABLE IF EXISTS mw_members").run();
    const noTables = await get(await sign({ exp, ws_id: "ws_bob" }));
    expect(noTables.status).toBe(500);
    expect(((await noTables.json()) as any).error).toBe("workspace_membership_unavailable");
    await membershipEnv([{ workspaceId: "ws_bob", userId: "usr_bob", role: "member" }]);

    // A token that names no workspace is not affected.
    expect((await get(await sign({ exp }))).status).toBe(200);

    // A token without exp never reaches the membership check: 401.
    expect((await get(await sign({ ws_id: "ws_bob" }))).status).toBe(401);
  });
});

// Story 2.8: the user's email, no default issuer, and the algorithms setting as a list that may include HS256.
describe("oidc-verify 2.1.0: email claim, configuration and algorithm lists", () => {
  const nowSec = () => Math.floor(Date.now() / 1000);

  async function es256Setup() {
    const keyPair = await generateEcdsaKeyPair();
    const publicJwk: Jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    publicJwk.kid = "email-key-1";
    const issuer = `https://idp-${crypto.randomUUID().slice(0, 8)}.example.com/auth/v1`;
    const fetcher = async (): Promise<Response> =>
      new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { "Content-Type": "application/json" } });
    const sign = (payload: Record<string, unknown>) =>
      signJwt({ alg: "ES256", kid: "email-key-1" }, { iss: issuer, aud: "authenticated", sub: "usr_e", exp: nowSec() + 600, ...payload }, keyPair.privateKey);
    return { issuer, fetcher, sign };
  }

  function meApp(config: Partial<OidcVerifyConfig>, fetcher?: typeof fetch) {
    const app = new Hono();
    app.use("*", createOidcMiddleware(config, fetcher ? { fetcher } : {}));
    app.get("/me", (c) => c.json({ user: c.get("user" as any) ?? null }));
    return app;
  }

  it("sets user.email from the email claim by default, and from a configured emailClaim; never from a non-string", async () => {
    const { issuer, fetcher, sign } = await es256Setup();
    const config = { issuer, audience: "authenticated", jwksUri: `${issuer}/jwks`, algorithms: ["ES256"] };
    const get = async (app: Hono, token: string) =>
      ((await (await app.fetch(new Request("http://x/me", { headers: { Authorization: `Bearer ${token}` } }), {})).json()) as any).user;

    const user = await get(meApp(config, fetcher), await sign({ email: "Person@Example.com" }));
    expect(user).toMatchObject({ id: "usr_e", uid: "usr_e", email: "Person@Example.com" });

    const custom = await get(meApp({ ...config, emailClaim: "profile.mail" }, fetcher), await sign({ email: "x@y.z", profile: { mail: "m@y.z" } }));
    expect(custom.email).toBe("m@y.z");

    const notString = await get(meApp(config, fetcher), await sign({ email: ["a@b.c"] }));
    expect(notString.uid).toBe("usr_e");
    expect("email" in notString).toBe(false);

    const verified = await verifyJwt(await sign({ email: "v@x.io" }), config, { fetcher });
    expect(verified.email).toBe("v@x.io");
  });

  it("with no issuer configured the middleware answers 500 oidc_not_configured, with or without a token", async () => {
    const app = meApp({ audience: "authenticated" });
    for (const headers of [{}, { Authorization: "Bearer a.b.c" }]) {
      const res = await app.fetch(new Request("http://x/me", { headers }), {});
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "oidc_not_configured" });
    }
    // An issuer from the environment (the brick's settings) is enough.
    const fromEnv = await app.fetch(new Request("http://x/me"), { issuer: "https://idp.example.com" });
    expect(fromEnv.status).toBe(200);
  });

  it("the algorithms setting is a comma-separated list, and HS256 works with the secret named by hs256SecretName", async () => {
    const { issuer, fetcher, sign } = await es256Setup();
    const secret = "test-only-hs256-secret-0123456789abcdef";
    const hmacKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const hsToken = await signJwt(
      { alg: "HS256", typ: "JWT" },
      { iss: issuer, aud: "authenticated", sub: "usr_h", email: "h@x.io", exp: nowSec() + 600 },
      hmacKey,
    );
    const esToken = await sign({ email: "e@x.io" });
    const app = new Hono();
    app.use("*", createOidcMiddleware({}, { fetcher }));
    app.get("/me", (c) => c.json({ user: c.get("user" as any) ?? null }));
    const settings = {
      issuer,
      audience: "authenticated",
      jwksUri: `${issuer}/jwks`,
      algorithms: "ES256, HS256",
      hs256SecretName: "MY_JWT_SECRET",
      MY_JWT_SECRET: secret,
    };
    const call = (token: string, env: Record<string, unknown>) => app.fetch(new Request("http://x/me", { headers: { Authorization: `Bearer ${token}` } }), env);

    const hs = await call(hsToken, settings);
    expect(hs.status).toBe(200);
    expect(((await hs.json()) as any).user).toMatchObject({ uid: "usr_h", email: "h@x.io" });
    const es = await call(esToken, settings);
    expect(es.status).toBe(200);
    expect(((await es.json()) as any).user).toMatchObject({ uid: "usr_e", email: "e@x.io" });

    // HS256 not listed: refused even with the secret present.
    const esOnly = await call(hsToken, { ...settings, algorithms: "ES256" });
    expect(esOnly.status).toBe(401);
    expect(((await esOnly.json()) as any).error).toBe("alg_not_allowed");
    // A wrong secret: refused.
    expect((await call(hsToken, { ...settings, MY_JWT_SECRET: "another-secret-value-0123456789" })).status).toBe(401);
  });
});
