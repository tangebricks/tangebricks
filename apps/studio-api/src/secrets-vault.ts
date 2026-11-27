function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function deriveAesGcmVaultKey(rawSecret?: string) {
  if (!rawSecret || rawSecret.trim().length === 0) {
    // No fallback key: secrets must never be sealed with a value written in source.
    throw new Error("Missing required secret PX_VAULT_KEY");
  }
  const effectiveSecret = rawSecret.trim();
  const keyBytes = new TextEncoder().encode(effectiveSecret);
  const hashBuffer = await crypto.subtle.digest("SHA-256", keyBytes);
  return crypto.subtle.importKey("raw", hashBuffer, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export function computeSecretKeyHint(plaintext: string): string {
  const trimmed = plaintext.trim();
  const suffix = trimmed.length >= 4 ? trimmed.slice(-4) : trimmed.padStart(4, "•");
  return `••••${suffix}`;
}

export interface SealedSecretRecord {
  ciphertextB64: string;
  ivB64: string;
  keyHint: string;
}

export async function encryptSecretValue(plaintext: string, rawKeySecret?: string): Promise<SealedSecretRecord> {
  const key = await deriveAesGcmVaultKey(rawKeySecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encodedPlaintext = new TextEncoder().encode(plaintext);
  const cipherBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encodedPlaintext);
  return {
    ciphertextB64: bytesToBase64(new Uint8Array(cipherBuffer)),
    ivB64: bytesToBase64(iv),
    keyHint: computeSecretKeyHint(plaintext),
  };
}

export async function decryptSecretValue(ciphertextB64: string, ivB64: string, rawKeySecret?: string): Promise<string> {
  const key = await deriveAesGcmVaultKey(rawKeySecret);
  const iv = base64ToBytes(ivB64);
  const cipherBytes = base64ToBytes(ciphertextB64);
  const plainBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBytes);
  return new TextDecoder().decode(plainBuffer);
}
