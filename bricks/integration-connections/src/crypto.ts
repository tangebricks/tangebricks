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

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveWorkspaceConnKey(rawKeyMaterial?: string) {
  if (!rawKeyMaterial || rawKeyMaterial.trim().length === 0) {
    // No fallback key: connection credentials must never be sealed with a value written in source.
    throw new Error("Missing required secret PX_CONN_KEY");
  }
  const material = rawKeyMaterial.trim();
  const encoded = new TextEncoder().encode(`projectx-studio-vault-v1:${material}`);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

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
  const key = await deriveWorkspaceConnKey(rawKeyMaterial);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(workspaceId);
  const plaintextBytes = new TextEncoder().encode(JSON.stringify(credentials));
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    plaintextBytes,
  );
  return JSON.stringify({
    v: 1,
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(cipherBuffer)),
  });
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
  let parsedEnvelope: { iv?: string; ct?: string };
  try {
    parsedEnvelope = JSON.parse(sealedEnvelope) as { iv?: string; ct?: string };
  } catch {
    throw new Error(
      `WORKSPACE_CREDENTIAL_INTEGRITY_ERROR: Malformed sealed_credentials envelope for workspace "${workspaceId}"`,
    );
  }
  if (typeof parsedEnvelope.iv !== "string" || typeof parsedEnvelope.ct !== "string") {
    throw new Error(
      `WORKSPACE_CREDENTIAL_INTEGRITY_ERROR: Missing IV or ciphertext in sealed_credentials for workspace "${workspaceId}"`,
    );
  }
  const key = await deriveWorkspaceConnKey(rawKeyMaterial);
  const iv = fromBase64(parsedEnvelope.iv);
  const ciphertext = fromBase64(parsedEnvelope.ct);
  const aad = new TextEncoder().encode(workspaceId);

  let plainBuffer: ArrayBuffer;
  try {
    plainBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      key,
      ciphertext,
    );
  } catch {
    throw new Error(
      `WORKSPACE_CREDENTIAL_INTEGRITY_ERROR: AES-GCM authentication failed for workspace "${workspaceId}" (AAD mismatch or tampered ciphertext)`,
    );
  }

  const decoded = new TextDecoder().decode(plainBuffer);
  return JSON.parse(decoded) as WorkspaceSealedCredentials;
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
