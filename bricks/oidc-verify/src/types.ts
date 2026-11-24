import type { AuthUser } from "@poc/sdk";

export type { AuthUser };

export interface JsonWebKey {
  kty?: string;
  use?: string;
  key_ops?: string[];
  alg?: string;
  ext?: boolean;
  crv?: string;
  x?: string;
  y?: string;
  d?: string;
  n?: string;
  e?: string;
  k?: string;
  kid?: string;
  [key: string]: unknown;
}

export interface OidcVerifyConfig {
  /** Expected issuer URI (iss). */
  issuer: string;
  /** Expected audience (aud or configured audienceClaim). */
  audience: string;
  /** Expected nonce claim value. */
  nonce?: string;
  /** Explicit JWKS endpoint URL. If omitted, resolved via openid-configuration or default path. */
  jwksUri?: string;
  /** Allowed signing algorithms (e.g. ["RS256", "ES256", "EdDSA"]). Defaults to ["RS256"]. */
  algorithms?: string[];
  /** Allowed clock skew in seconds for exp/nbf validation. Defaults to 60. */
  clockSkewSec?: number;
  /** Dot-path for user ID in token payload. Defaults to "sub". */
  userIdClaim?: string;
  /** Dot-path for workspace/tenant ID in token payload. */
  workspaceClaim?: string;
  /** Dot-path for roles in token payload. */
  rolesClaim?: string;
  /** Dot-path or claim name for audience validation. Defaults to "aud". */
  audienceClaim?: string;
  /** Binding/environment variable name containing symmetric secret for HS256 legacy verification. */
  hs256SecretName?: string;
  /** Raw symmetric secret string for HS256 verification (if enabled). */
  hs256Secret?: string;
}

export interface OidcUserContext {
  userId: string;
  workspaceId?: string;
  roles: string[];
  claims: Record<string, unknown>;
}

export class OidcVerificationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "OidcVerificationError";
    this.code = code;
  }
}
