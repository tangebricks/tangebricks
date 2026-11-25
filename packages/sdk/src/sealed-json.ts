// AES-GCM sealing of a JSON value under a secret key with associated data (story 2.4, moved here from
// integration-connections so more than one brick can seal credentials without copying crypto).
//
// The key is SHA-256(`${domain}:${keyMaterial}`), so one secret can serve several purposes without the derived keys
// being equal. The associated data (for example `workspaceId` or `workspaceId:channelId`) is authenticated but not
// stored: a sealed value copied to another row (another workspace, another channel) fails to open.

const encoder = new TextEncoder();

/** Why a seal or unseal failed. The message names the key (never its value) or the failure, never the plaintext. */
export type SealedJsonErrorCode = "MISSING_KEY" | "MISSING_ASSOCIATED_DATA" | "MALFORMED" | "INTEGRITY";

export class SealedJsonError extends Error {
  readonly code: SealedJsonErrorCode;
  constructor(code: SealedJsonErrorCode, message: string) {
    super(message);
    this.name = "SealedJsonError";
    this.code = code;
  }
}

export interface SealOptions {
  /** The secret's value (a Worker secret). Missing or blank fails `MISSING_KEY`: there is never a fallback key. */
  keyMaterial: string | undefined;
  /** The secret's name, used only in error messages. */
  keyName: string;
  /** Separates purposes that share one secret, e.g. "projectx-studio-vault-v1". */
  domain: string;
  /** Bound into the AES-GCM tag; the same value must be given to open it. Must not be blank. */
  associatedData: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(options: SealOptions) {
  const material = typeof options.keyMaterial === "string" ? options.keyMaterial.trim() : "";
  if (material.length === 0) throw new SealedJsonError("MISSING_KEY", `Missing required secret ${options.keyName}`);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${options.domain}:${material}`));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function associatedData(options: SealOptions): Uint8Array<ArrayBuffer> {
  if (typeof options.associatedData !== "string" || options.associatedData.trim().length === 0) {
    throw new SealedJsonError("MISSING_ASSOCIATED_DATA", "associated data is required for sealing");
  }
  return encoder.encode(options.associatedData);
}

/** Whether a secret value is present (non-blank), without deriving anything. */
export function hasSealingKey(keyMaterial: unknown): keyMaterial is string {
  return typeof keyMaterial === "string" && keyMaterial.trim().length > 0;
}

/** Seals `value` (JSON-serialisable) into `{"v":1,"iv":...,"ct":...}`. */
export async function sealJson(value: unknown, options: SealOptions): Promise<string> {
  const aad = associatedData(options);
  const key = await deriveKey(options);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, encoder.encode(JSON.stringify(value)));
  return JSON.stringify({ v: 1, iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) });
}

/** Opens what `sealJson` sealed with the same key, domain and associated data. Anything else throws `SealedJsonError`. */
export async function unsealJson<T = unknown>(envelope: string, options: SealOptions): Promise<T> {
  const aad = associatedData(options);
  let parsed: { iv?: unknown; ct?: unknown };
  try {
    parsed = JSON.parse(envelope) as { iv?: unknown; ct?: unknown };
  } catch {
    throw new SealedJsonError("MALFORMED", "malformed sealed envelope");
  }
  if (!parsed || typeof parsed.iv !== "string" || typeof parsed.ct !== "string") {
    throw new SealedJsonError("MALFORMED", "missing IV or ciphertext in sealed envelope");
  }
  const key = await deriveKey(options);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(parsed.iv), additionalData: aad }, key, fromBase64(parsed.ct));
  } catch {
    throw new SealedJsonError("INTEGRITY", "AES-GCM authentication failed (associated data mismatch or tampered ciphertext)");
  }
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
