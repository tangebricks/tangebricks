import type { WebhookSignatureScheme } from "./signature-scheme.ts";

export const PRESETS: Record<string, WebhookSignatureScheme> = {
  "stripe-signature": {
    algorithm: "hmac-sha256",
    signedPayload: "{timestamp}.{body}",
    signatureHeader: "stripe-signature",
    signatureFormat: {
      kind: "kv-list",
      pairSeparator: ",",
      kvSeparator: "=",
      timestampKey: "t",
      signatureKey: "v1",
    },
    encoding: "hex",
    toleranceSec: 300,
  },
  "stripe-v1": {
    algorithm: "hmac-sha256",
    signedPayload: "{timestamp}.{body}",
    signatureHeader: "stripe-signature",
    signatureFormat: {
      kind: "kv-list",
      pairSeparator: ",",
      kvSeparator: "=",
      timestampKey: "t",
      signatureKey: "v1",
    },
    encoding: "hex",
    toleranceSec: 300,
  },
  "github-hmac-sha256": {
    algorithm: "hmac-sha256",
    signedPayload: "{body}",
    signatureHeader: "x-hub-signature-256",
    encoding: "hex",
    prefix: "sha256=",
  },
  "hmac-sha256": {
    algorithm: "hmac-sha256",
    signedPayload: "{body}",
    signatureHeader: "x-hub-signature-256",
    encoding: "hex",
    prefix: "sha256=",
  },
  "meta-hub-signature-256": {
    algorithm: "hmac-sha256",
    signedPayload: "{body}",
    signatureHeader: "x-hub-signature-256",
    encoding: "hex",
    prefix: "sha256=",
  },
  "meta-sha256": {
    algorithm: "hmac-sha256",
    signedPayload: "{body}",
    signatureHeader: "x-hub-signature-256",
    encoding: "hex",
    prefix: "sha256=",
  },
  "slack-v0": {
    algorithm: "hmac-sha256",
    signedPayload: "v0:{timestamp}:{body}",
    signatureHeader: "x-slack-signature",
    timestampHeader: "x-slack-request-timestamp",
    encoding: "hex",
    prefix: "v0=",
    toleranceSec: 300,
  },
  "discord-ed25519": {
    algorithm: "ed25519",
    signedPayload: "{timestamp}{body}",
    signatureHeader: "x-signature-ed25519",
    timestampHeader: "x-signature-timestamp",
    encoding: "hex",
    toleranceSec: 300,
  },
  "ed25519": {
    algorithm: "ed25519",
    signedPayload: "{timestamp}{body}",
    signatureHeader: "x-signature-ed25519",
    timestampHeader: "x-signature-timestamp",
    encoding: "hex",
    toleranceSec: 300,
  },
  "hmac-sha256-timestamp-body-base64": {
    algorithm: "hmac-sha256",
    signedPayload: "{timestamp}{body}",
    signatureHeader: "x-signature",
    timestampHeader: "x-timestamp",
    encoding: "base64",
    toleranceSec: 300,
  },
  "timestamp-body-base64": {
    algorithm: "hmac-sha256",
    signedPayload: "{timestamp}{body}",
    signatureHeader: "x-signature",
    timestampHeader: "x-timestamp",
    encoding: "base64",
    toleranceSec: 300,
  },
};

export const WEBHOOK_PRESETS = PRESETS;

export type PresetName = keyof typeof PRESETS;
export type WebhookPresetName = PresetName;

export function getPreset(name: string): WebhookSignatureScheme | undefined {
  return PRESETS[name];
}

export function mapToDbVerifier(
  verifierInput?: string,
  schemeObj?: WebhookSignatureScheme,
): "none" | "shared-secret" | "stripe-signature" | "ed25519" | "hmac-sha256" {
  if (verifierInput === "none") return "none";
  if (verifierInput === "shared-secret") return "shared-secret";
  if (verifierInput === "stripe-signature" || verifierInput === "stripe-v1") return "stripe-signature";
  if (verifierInput === "discord-ed25519" || verifierInput === "ed25519" || schemeObj?.algorithm === "ed25519") return "ed25519";
  return "hmac-sha256";
}

export function getDefaultSignatureHeader(
  verifierInput?: string,
  schemeObj?: WebhookSignatureScheme,
): string {
  if (schemeObj?.signatureHeader) return schemeObj.signatureHeader;
  const preset = verifierInput ? PRESETS[verifierInput] : undefined;
  if (preset?.signatureHeader) return preset.signatureHeader;
  if (verifierInput === "shared-secret") return "X-Webhook-Secret";
  return "X-Hub-Signature-256";
}
