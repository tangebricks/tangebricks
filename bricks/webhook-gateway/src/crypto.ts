export function toHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

export async function sha256HexString(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toHex(digest);
}

/**
 * Computes an HMAC-SHA256 hex signature for a payload using a secret string.
 */
export async function signHmacSha256(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return toHex(signature);
}

/**
 * Computes a Stripe-Signature header (`t=<timestamp>,v1=<hex>`) over `${timestamp}.${payload}`.
 */
export async function signStripeWebhookPayload(payload: string, secret: string, timestampSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const signedPayload = `${timestampSeconds}.${payload}`;
  const sigHex = await signHmacSha256(signedPayload, secret);
  return `t=${timestampSeconds},v1=${sigHex}`;
}

/**
 * Verifies a shared-secret header (accepting raw secret or `Bearer <secret>`) in constant time.
 */
export function verifySharedSecret(headerValue: string, secret: string): boolean {
  if (!headerValue || !secret) return false;
  const cleaned = headerValue
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim();
  const enc = new TextEncoder();
  return timingSafeEqual(enc.encode(cleaned), enc.encode(secret.trim()));
}

/**
 * Unseals a credential row from `px_connections` using AES-GCM 256-bit `PX_CONN_KEY`.
 */
export async function unsealPxConnectionSecret(ciphertextB64: string, ivB64: string, connKey?: string): Promise<string> {
  if (!connKey || connKey.trim().length === 0) {
    // No fallback key: never unseal with a value written in source.
    throw new Error("Missing required secret PX_CONN_KEY");
  }
  const material = connKey.trim();
  const encodedKey = new TextEncoder().encode(`projectx-studio-vault-v1:${material}`);
  const digest = await crypto.subtle.digest("SHA-256", encodedKey);
  const key = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const iv = fromBase64(ivB64);
  const ciphertext = fromBase64(ciphertextB64);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  const text = new TextDecoder().decode(decrypted);
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed === "object" && parsed !== null) {
      return String(parsed.webhookSecret ?? parsed.signingSecret ?? parsed.secret ?? parsed.apiKey ?? parsed.accessToken ?? parsed.token ?? "");
    }
    return String(parsed);
  } catch {
    return text;
  }
}

/**
 * Generates a 32-byte cryptographically secure random hex secret.
 */
export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `whsec_${toHex(bytes)}`;
}
