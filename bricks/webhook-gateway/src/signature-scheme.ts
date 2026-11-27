import type { WebhookSignatureScheme } from "@poc/assembler";
import { fromBase64, fromHex, timingSafeEqual } from "./crypto.ts";

export type { WebhookSignatureScheme } from "@poc/assembler";

export type WebhookVerifyReason =
  | "WEBHOOK_SIGNATURE_HEADER_MISSING"
  | "WEBHOOK_TIMESTAMP_MISSING"
  | "WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE"
  | "WEBHOOK_SIGNATURE_MALFORMED"
  | "WEBHOOK_SIGNATURE_MISMATCH";

export interface WebhookVerifyRequest {
  rawBody: string;
  headers: Record<string, string | string[] | undefined> | Headers;
  url?: string;
}

export type WebhookVerifyResult = { ok: true } | { ok: false; reason: WebhookVerifyReason };

function getHeader(headers: Record<string, string | string[] | undefined> | Headers, headerName: string): string | undefined {
  if (typeof (headers as Headers).get === "function") {
    const val = (headers as Headers).get(headerName);
    return val ?? undefined;
  }
  const lower = headerName.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      if (Array.isArray(v)) return v[0];
      return typeof v === "string" ? v : undefined;
    }
  }
  return undefined;
}

export async function verifyWithScheme(
  scheme: WebhookSignatureScheme,
  request: WebhookVerifyRequest,
  secret: string,
  nowSeconds?: number,
): Promise<WebhookVerifyResult> {
  // 1. Locate signature header
  const rawSigHeader = getHeader(request.headers, scheme.signatureHeader);
  if (!rawSigHeader || !rawSigHeader.trim()) {
    return { ok: false, reason: "WEBHOOK_SIGNATURE_HEADER_MISSING" };
  }

  // 2. Extract timestamp
  let timestamp: number | null = null;
  let timestampStr: string | null = null;
  let hasTimestampConfig = false;

  if (scheme.timestampHeader) {
    hasTimestampConfig = true;
    const tsVal = getHeader(request.headers, scheme.timestampHeader);
    if (tsVal && tsVal.trim()) {
      timestampStr = tsVal.trim();
      const parsed = Number(timestampStr);
      if (Number.isFinite(parsed)) {
        timestamp = parsed;
      }
    }
  }

  if (scheme.signatureFormat?.kind === "kv-list" && scheme.signatureFormat.timestampKey) {
    hasTimestampConfig = true;
    const parts = rawSigHeader.split(scheme.signatureFormat.pairSeparator);
    for (const part of parts) {
      const [k, ...rest] = part.trim().split(scheme.signatureFormat.kvSeparator);
      if (k?.trim() === scheme.signatureFormat.timestampKey) {
        const val = rest.join(scheme.signatureFormat.kvSeparator).trim();
        timestampStr = val;
        const parsed = Number(val);
        if (Number.isFinite(parsed)) {
          timestamp = parsed;
        }
        break;
      }
    }
  }

  const requiresTimestamp =
    hasTimestampConfig || scheme.signedPayload.includes("{timestamp}") || (scheme.toleranceSec !== undefined && scheme.toleranceSec > 0);

  if (requiresTimestamp && (timestamp === null || !timestampStr)) {
    return { ok: false, reason: "WEBHOOK_TIMESTAMP_MISSING" };
  }

  // 3. Tolerance replay check: default tolerance is 300 when a timestamp is present
  const toleranceSec = scheme.toleranceSec !== undefined ? scheme.toleranceSec : hasTimestampConfig && nowSeconds !== undefined ? 300 : undefined;

  if (toleranceSec !== undefined && toleranceSec > 0 && timestamp !== null) {
    const currentSec = nowSeconds ?? Math.floor(Date.now() / 1000);
    if (Math.abs(currentSec - timestamp) > toleranceSec) {
      return { ok: false, reason: "WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE" };
    }
  }

  // 4. Extract candidate signatures
  const candidateStrings: string[] = [];
  if (scheme.signatureFormat?.kind === "kv-list") {
    const parts = rawSigHeader.split(scheme.signatureFormat.pairSeparator);
    for (const part of parts) {
      const [k, ...rest] = part.trim().split(scheme.signatureFormat.kvSeparator);
      if (k?.trim() === scheme.signatureFormat.signatureKey) {
        const val = rest.join(scheme.signatureFormat.kvSeparator).trim();
        if (val) candidateStrings.push(val);
      }
    }
    if (candidateStrings.length === 0) {
      return { ok: false, reason: "WEBHOOK_SIGNATURE_MALFORMED" };
    }
  } else {
    candidateStrings.push(rawSigHeader.trim());
  }

  // 5. Validate & decode candidate signatures
  const candidateBytesList: Uint8Array[] = [];
  for (const candidate of candidateStrings) {
    let sig = candidate;
    if (scheme.prefix) {
      if (sig.startsWith(scheme.prefix)) {
        sig = sig.slice(scheme.prefix.length);
      } else {
        return { ok: false, reason: "WEBHOOK_SIGNATURE_MALFORMED" };
      }
    }

    if (scheme.encoding === "hex") {
      if (!/^[0-9a-fA-F]+$/.test(sig) || sig.length % 2 !== 0) {
        return { ok: false, reason: "WEBHOOK_SIGNATURE_MALFORMED" };
      }
      if (scheme.algorithm === "ed25519" && sig.length !== 128) {
        return { ok: false, reason: "WEBHOOK_SIGNATURE_MALFORMED" };
      }
      try {
        candidateBytesList.push(fromHex(sig.toLowerCase()));
      } catch {
        return { ok: false, reason: "WEBHOOK_SIGNATURE_MALFORMED" };
      }
    } else if (scheme.encoding === "base64") {
      if (!/^[A-Za-z0-9+/=]+$/.test(sig)) {
        return { ok: false, reason: "WEBHOOK_SIGNATURE_MALFORMED" };
      }
      try {
        const decoded = fromBase64(sig);
        if (scheme.algorithm === "ed25519" && decoded.length !== 64) {
          return { ok: false, reason: "WEBHOOK_SIGNATURE_MALFORMED" };
        }
        candidateBytesList.push(decoded);
      } catch {
        return { ok: false, reason: "WEBHOOK_SIGNATURE_MALFORMED" };
      }
    }
  }

  if (candidateBytesList.length === 0) {
    return { ok: false, reason: "WEBHOOK_SIGNATURE_MALFORMED" };
  }

  // 6. Build signed payload from template
  let signedPayload = scheme.signedPayload;
  signedPayload = signedPayload.replace(/\{body\}/g, request.rawBody);
  if (signedPayload.includes("{timestamp}")) {
    signedPayload = signedPayload.replace(/\{timestamp\}/g, timestampStr ?? "");
  }
  if (signedPayload.includes("{url}")) {
    signedPayload = signedPayload.replace(/\{url\}/g, request.url ?? "");
  }
  if (signedPayload.includes("{id}")) {
    const idVal = scheme.idHeader ? getHeader(request.headers, scheme.idHeader) : undefined;
    signedPayload = signedPayload.replace(/\{id\}/g, idVal ?? "");
  }

  // 7. Compute signature using WebCrypto SubtleCrypto
  if (scheme.algorithm === "ed25519") {
    const rawKey = scheme.publicKey?.trim() || secret?.trim();
    if (!rawKey) {
      return { ok: false, reason: "WEBHOOK_SIGNATURE_MALFORMED" };
    }
    let publicKeyBytes: Uint8Array;
    if (scheme.secretEncoding === "base64" || (!/^[0-9a-fA-F]{64}$/.test(rawKey) && /^[A-Za-z0-9+/=]{43,44}$/.test(rawKey))) {
      try {
        publicKeyBytes = fromBase64(rawKey);
      } catch {
        return { ok: false, reason: "WEBHOOK_SIGNATURE_MALFORMED" };
      }
    } else if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
      try {
        publicKeyBytes = fromHex(rawKey);
      } catch {
        return { ok: false, reason: "WEBHOOK_SIGNATURE_MALFORMED" };
      }
    } else {
      return { ok: false, reason: "WEBHOOK_SIGNATURE_MALFORMED" };
    }

    if (publicKeyBytes.length !== 32) {
      return { ok: false, reason: "WEBHOOK_SIGNATURE_MALFORMED" };
    }

    let cryptoKey: Awaited<ReturnType<typeof crypto.subtle.importKey>>;
    try {
      cryptoKey = await crypto.subtle.importKey("raw", publicKeyBytes, { name: "Ed25519" }, false, ["verify"]);
    } catch {
      return { ok: false, reason: "WEBHOOK_SIGNATURE_MALFORMED" };
    }

    const payloadBytes = new TextEncoder().encode(signedPayload);
    for (const candidateBytes of candidateBytesList) {
      if (candidateBytes.length !== 64) {
        return { ok: false, reason: "WEBHOOK_SIGNATURE_MALFORMED" };
      }
      try {
        const valid = await crypto.subtle.verify("Ed25519", cryptoKey, candidateBytes, payloadBytes);
        if (valid) {
          return { ok: true };
        }
      } catch {
        // Verification failed
      }
    }
    return { ok: false, reason: "WEBHOOK_SIGNATURE_MISMATCH" };
  }

  let hashAlg: "SHA-256" | "SHA-1" | "SHA-512";
  if (scheme.algorithm === "hmac-sha256") {
    hashAlg = "SHA-256";
  } else if (scheme.algorithm === "hmac-sha1") {
    hashAlg = "SHA-1";
  } else if (scheme.algorithm === "hmac-sha512") {
    hashAlg = "SHA-512";
  } else {
    return { ok: false, reason: "WEBHOOK_SIGNATURE_MISMATCH" };
  }

  let secretBytes: Uint8Array;
  if (scheme.secretEncoding === "base64") {
    try {
      secretBytes = fromBase64(secret);
    } catch {
      secretBytes = new TextEncoder().encode(secret);
    }
  } else if (scheme.secretEncoding === "hex") {
    try {
      secretBytes = fromHex(secret);
    } catch {
      secretBytes = new TextEncoder().encode(secret);
    }
  } else {
    secretBytes = new TextEncoder().encode(secret);
  }

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: hashAlg }, false, ["sign"]);
  const signatureBuf = await crypto.subtle.sign("HMAC", key, enc.encode(signedPayload));
  const expectedBytes = new Uint8Array(signatureBuf);

  // 8. Constant-time comparison
  for (const candidateBytes of candidateBytesList) {
    if (timingSafeEqual(candidateBytes, expectedBytes)) {
      return { ok: true };
    }
  }

  return { ok: false, reason: "WEBHOOK_SIGNATURE_MISMATCH" };
}
