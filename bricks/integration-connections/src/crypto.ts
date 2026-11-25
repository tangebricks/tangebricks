import { SealedJsonError, sealJson, unsealJson } from "@poc/sdk";

export interface WorkspaceSealedCredentials {
  provider: string;
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: number | null;
  scopes?: string[];
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  externalAccountId?: string;
  accountLabel?: string;
  [key: string]: unknown;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Story 2.4: the AES-GCM sealing itself lives in @poc/sdk (`sealJson` / `unsealJson`), shared with other bricks.
// The domain, the key name and the envelope format are unchanged, so credentials sealed before still open.
const sealOptions = (workspaceId: string, rawKeyMaterial?: string) => ({
  keyMaterial: rawKeyMaterial,
  keyName: "PX_CONN_KEY",
  domain: "projectx-studio-vault-v1",
  associatedData: workspaceId,
});

/**
 * Encrypts workspace OAuth credentials using AES-GCM 256-bit `PX_CONN_KEY` with
 * `workspaceId` bound in the Additional Authenticated Data (`AAD`).
 * Copying `sealed_credentials` across workspace rows will fail AES-GCM tag verification.
 */
export async function sealWorkspaceCredentials(
  credentials: WorkspaceSealedCredentials,
  workspaceId: string,
  rawKeyMaterial?: string,
): Promise<string> {
  if (!workspaceId || workspaceId.trim().length === 0) {
    throw new Error("workspaceId is required for AAD-bound credential sealing");
  }
  try {
    return await sealJson(credentials, sealOptions(workspaceId, rawKeyMaterial));
  } catch (error) {
    // No fallback key: connection credentials must never be sealed with a value written in source.
    if (error instanceof SealedJsonError && error.code === "MISSING_KEY") throw new Error("Missing required secret PX_CONN_KEY");
    throw error;
  }
}

/**
 * Decrypts and authenticates workspace OAuth credentials using AES-GCM 256-bit `PX_CONN_KEY`
 * verifying `AAD === workspaceId`. Throws `WORKSPACE_CREDENTIAL_INTEGRITY_ERROR` on AAD mismatch.
 */
export async function unsealWorkspaceCredentials(
  sealedEnvelope: string,
  workspaceId: string,
  rawKeyMaterial?: string,
): Promise<WorkspaceSealedCredentials> {
  if (!workspaceId || workspaceId.trim().length === 0) {
    throw new Error(
      "WORKSPACE_CREDENTIAL_INTEGRITY_ERROR: Missing workspaceId for AAD verification",
    );
  }
  try {
    return await unsealJson<WorkspaceSealedCredentials>(sealedEnvelope, sealOptions(workspaceId, rawKeyMaterial));
  } catch (error) {
    if (!(error instanceof SealedJsonError)) throw error;
    if (error.code === "MISSING_KEY") throw new Error("Missing required secret PX_CONN_KEY");
    if (error.code === "MALFORMED") {
      throw new Error(
        `WORKSPACE_CREDENTIAL_INTEGRITY_ERROR: Malformed sealed_credentials envelope for workspace "${workspaceId}"`,
      );
    }
    throw new Error(
      `WORKSPACE_CREDENTIAL_INTEGRITY_ERROR: AES-GCM authentication failed for workspace "${workspaceId}" (AAD mismatch or tampered ciphertext)`,
    );
  }
}

export function generateOAuthStateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `st_${toBase64Url(bytes)}`;
}

export function generatePkceVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toBase64Url(bytes);
}

export async function computePkceChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return toBase64Url(new Uint8Array(digest));
}
