import { getJwksKey, resolveJwksUri } from "./jwks.ts";
import { OidcVerificationError, type OidcUserContext, type OidcVerifyConfig } from "./types.ts";

function base64UrlDecode(str: string): Uint8Array {
  try {
    const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const padLen = (4 - (base64.length % 4)) % 4;
    const padded = base64 + "=".repeat(padLen);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    throw new OidcVerificationError("malformed_token", "Base64URL decoding failed");
  }
}

function decodeJsonSegment<T>(segment: string): T {
  const bytes = base64UrlDecode(segment);
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new OidcVerificationError("malformed_token", "Invalid JSON payload in token segment");
  }
}

export function getByDotPath(target: unknown, path?: string): unknown {
  if (!path || !path.trim()) return undefined;
  if (typeof target !== "object" || target === null) return undefined;

  // Direct property check for namespaced claim keys
  if (Object.hasOwn(target, path)) {
    return (target as Record<string, unknown>)[path];
  }

  const segments = path.split(".").filter(Boolean);
  let current: unknown = target;
  for (const seg of segments) {
    if (seg === "__proto__" || seg === "constructor" || seg === "prototype") {
      return undefined;
    }
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

interface JwtHeader {
  alg?: string;
  typ?: string;
  kid?: string;
}

interface JwtPayload {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  [key: string]: unknown;
}

export type VerifyJwtOptions =
  | {
      fetcher?: typeof fetch;
      now?: () => number;
      nonce?: string;
    }
  | typeof fetch;

export async function verifyJwt(token: string, config: OidcVerifyConfig, options: VerifyJwtOptions = {}): Promise<OidcUserContext> {
  const resolvedFetcher = typeof options === "function" ? options : options.fetcher;
  const resolvedNow = typeof options === "object" && options.now ? options.now() : Date.now();
  const expectedNonce = (typeof options === "object" && options.nonce) || config.nonce;

  if (!token || typeof token !== "string") {
    throw new OidcVerificationError("malformed_token", "Token must be a non-empty string");
  }

  const parts = token.trim().split(".");
  if (parts.length !== 3) {
    throw new OidcVerificationError("malformed_token", "JWT must consist of exactly 3 dot-separated segments");
  }

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = decodeJsonSegment<JwtHeader>(headerB64);
  const payload = decodeJsonSegment<JwtPayload>(payloadB64);

  const alg = header.alg || "";
  if (!alg || alg.toLowerCase() === "none") {
    throw new OidcVerificationError("alg_not_allowed", "Algorithm 'none' is forbidden");
  }

  const allowedAlgs = config.algorithms && config.algorithms.length > 0 ? config.algorithms.map((a) => a.toUpperCase()) : ["RS256"];

  if (alg.toUpperCase().startsWith("HS")) {
    const secret = config.hs256Secret;
    if (!secret || alg.toUpperCase() !== "HS256" || !allowedAlgs.includes("HS256")) {
      throw new OidcVerificationError("alg_not_allowed", `Symmetric algorithm ${alg} is not allowed`);
    }
  } else {
    if (!allowedAlgs.includes(alg.toUpperCase())) {
      throw new OidcVerificationError("alg_not_allowed", `Algorithm "${alg}" is not in allowed list [${allowedAlgs.join(", ")}]`);
    }
  }

  const signatureBytes = base64UrlDecode(signatureB64);
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  // Signature verification
  if (alg.toUpperCase() === "HS256") {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(config.hs256Secret!), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, signatureBytes, signedData);
    if (!valid) {
      throw new OidcVerificationError("invalid_signature", "HMAC signature verification failed");
    }
  } else {
    const jwksUri = await resolveJwksUri(config.issuer, config.jwksUri, resolvedFetcher);
    const jwk = await getJwksKey(jwksUri, header.kid, {
      fetcher: resolvedFetcher,
      now: () => resolvedNow,
    });

    // Validate algorithm matches key type to prevent algorithm confusion attacks
    if (alg.toUpperCase() === "RS256") {
      if (jwk.kty !== "RSA") {
        throw new OidcVerificationError("alg_not_allowed", "RS256 requires RSA key type");
      }
    } else if (alg.toUpperCase() === "ES256") {
      if (jwk.kty !== "EC" || jwk.crv !== "P-256") {
        throw new OidcVerificationError("alg_not_allowed", "ES256 requires EC key type with P-256 curve");
      }
    } else if (alg.toUpperCase() === "EDDSA") {
      if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
        throw new OidcVerificationError("alg_not_allowed", "EdDSA requires OKP key type with Ed25519 curve");
      }
    }

    let importAlgorithm: Record<string, unknown> | string;
    let verifyAlgorithm: Record<string, unknown> | string;

    if (alg.toUpperCase() === "RS256") {
      importAlgorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
      verifyAlgorithm = "RSASSA-PKCS1-v1_5";
    } else if (alg.toUpperCase() === "ES256") {
      importAlgorithm = { name: "ECDSA", namedCurve: "P-256" };
      verifyAlgorithm = { name: "ECDSA", hash: "SHA-256" };
    } else if (alg.toUpperCase() === "EDDSA") {
      importAlgorithm = { name: "Ed25519" };
      verifyAlgorithm = "Ed25519";
    } else {
      throw new OidcVerificationError("alg_not_allowed", `Unsupported algorithm "${alg}"`);
    }

    const cryptoKey = (await (crypto.subtle.importKey as any)("jwk", jwk, importAlgorithm, false, ["verify"])) as Awaited<
      ReturnType<typeof crypto.subtle.importKey>
    >;

    const valid = await (crypto.subtle.verify as any)(verifyAlgorithm, cryptoKey, signatureBytes, signedData);
    if (!valid) {
      throw new OidcVerificationError("invalid_signature", "Asymmetric signature verification failed");
    }
  }

  // Validate standard claims with clock skew
  const now = resolvedNow;
  const rawSkewSec = config.clockSkewSec ?? 60;
  const skewMs = (Number.isFinite(rawSkewSec) && rawSkewSec >= 0 ? rawSkewSec : 60) * 1000;

  // iss and aud are always checked; a verifier configured without either cannot accept any token.
  if (typeof config.issuer !== "string" || config.issuer.trim().length === 0) {
    throw new OidcVerificationError("issuer_mismatch", "No expected issuer is configured");
  }
  if (typeof config.audience !== "string" || config.audience.trim().length === 0) {
    throw new OidcVerificationError("audience_mismatch", "No expected audience is configured");
  }

  // 1. Issuer check (normalize trailing slashes)
  const normExpectedIss = config.issuer.trim().replace(/\/+$/, "");
  const normActualIss = typeof payload.iss === "string" ? payload.iss.trim().replace(/\/+$/, "") : "";
  if (!normActualIss || normActualIss !== normExpectedIss) {
    throw new OidcVerificationError("issuer_mismatch", `Token issuer "${payload.iss}" does not match expected "${config.issuer}"`);
  }

  // 2. Audience check (using audienceClaim or "aud")
  const audClaimName = config.audienceClaim || "aud";
  const rawAud = getByDotPath(payload, audClaimName);
  const expectedAud = config.audience;

  let audMatches = false;
  if (typeof rawAud === "string") {
    audMatches = rawAud === expectedAud;
  } else if (Array.isArray(rawAud)) {
    audMatches = rawAud.some((a) => String(a) === expectedAud);
  }

  if (!audMatches) {
    throw new OidcVerificationError("audience_mismatch", `Token audience claim "${audClaimName}" does not match expected "${expectedAud}"`);
  }

  // 3. Expiration check: `exp` is required. A token that never expires is refused.
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new OidcVerificationError("missing_exp", "Token has no numeric exp claim");
  }
  if (now > payload.exp * 1000 + skewMs) {
    throw new OidcVerificationError("token_expired", "Token has expired");
  }

  // 4. Not Before (nbf) check
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf)) {
      throw new OidcVerificationError("malformed_token", "Token nbf claim is not a number");
    }
    if (now < payload.nbf * 1000 - skewMs) {
      throw new OidcVerificationError("token_not_yet_valid", "Token is not yet active (nbf in future)");
    }
  }

  // 4b. Issued At (iat) check: a token issued in the future (beyond the skew) is refused.
  if (payload.iat !== undefined) {
    if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) {
      throw new OidcVerificationError("malformed_token", "Token iat claim is not a number");
    }
    if (now < payload.iat * 1000 - skewMs) {
      throw new OidcVerificationError("token_issued_in_future", "Token iat is in the future");
    }
  }

  // 5. Nonce check
  if (expectedNonce !== undefined && expectedNonce !== null && expectedNonce !== "") {
    const actualNonce = payload.nonce;
    if (typeof actualNonce !== "string" || actualNonce !== expectedNonce) {
      throw new OidcVerificationError("nonce_mismatch", `Token nonce "${actualNonce}" does not match expected "${expectedNonce}"`);
    }
  }

  // Map user context
  const userIdClaim = config.userIdClaim || "sub";
  const rawUserId = getByDotPath(payload, userIdClaim);
  if (!rawUserId || (typeof rawUserId !== "string" && typeof rawUserId !== "number")) {
    throw new OidcVerificationError("malformed_token", `Missing or invalid user identifier claim "${userIdClaim}"`);
  }
  const userId = String(rawUserId);

  let workspaceId: string | undefined;
  if (config.workspaceClaim) {
    const rawWs = getByDotPath(payload, config.workspaceClaim);
    if (typeof rawWs === "string" && rawWs.trim().length > 0) {
      workspaceId = rawWs.trim();
    }
  }

  let roles: string[] = [];
  if (config.rolesClaim) {
    const rawRoles = getByDotPath(payload, config.rolesClaim);
    if (Array.isArray(rawRoles)) {
      roles = rawRoles.map(String).filter((r) => r.length > 0);
    } else if (typeof rawRoles === "string" && rawRoles.trim().length > 0) {
      roles = [rawRoles.trim()];
    }
  }

  return {
    userId,
    workspaceId,
    roles,
    claims: payload,
  };
}
