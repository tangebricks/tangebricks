import { REQUIRED_CLOUDFLARE_PERMISSIONS } from "./target.ts";
import type { CloudflareAccountSummary, CloudflarePermissionScope, RegisteredMockToken } from "./target.ts";

// The fake Cloudflare control plane's spelling-based token classifier, kept out of target.ts: it belongs to the fake only.
// verifyCloudflareToken reaches it solely for a MockCloudflareControlPlane with no registered token (story R53).

/**
 * TEST-ONLY. Classifies a token by its spelling (cf_revoked_..., ..._missing_d1, ...), so offline tests and the e2e suite can
 * drive every verification outcome without Cloudflare. Reachable only through the fake client (MockCloudflareControlPlane
 * with no registered tokens): a real client always asks Cloudflare, so a "cf_revoked_token" string sent to it is simply a
 * token Cloudflare does not know.
 */
export function synthesizeDeterministicTokenEntry(
  rawToken: string,
  requestedAccountId?: string,
): RegisteredMockToken | null {
  const trimmed = rawToken.trim();
  if (!trimmed || trimmed.length < 8) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  const normalizedAccountId =
    requestedAccountId && /^[0-9a-fA-F]{32}$/.test(requestedAccountId.trim())
      ? requestedAccountId.trim().toLowerCase()
      : "abcdef0123456789abcdef0123456789";

  if (
    lower.startsWith("cf_invalid") ||
    lower.startsWith("cf_bad") ||
    lower.includes("invalid_token")
  ) {
    return null;
  }

  if (
    lower.startsWith("cf_global_key") ||
    lower.includes("global_api_key") ||
    /^[0-9a-f]{37}$/i.test(trimmed)
  ) {
    return {
      token: trimmed,
      tokenId: "cf_tok_global_key",
      accountId: normalizedAccountId,
      accountName: "Acme Cloudflare Account",
      subdomain: "acme-workers",
      status: "active",
      isGlobalApiKey: true,
      permissions: [...REQUIRED_CLOUDFLARE_PERMISSIONS],
    };
  }

  if (lower.startsWith("cf_expired") || lower.includes("expired_token")) {
    return {
      token: trimmed,
      tokenId: "cf_tok_expired",
      accountId: normalizedAccountId,
      accountName: "Acme Cloudflare Account",
      subdomain: "acme-workers",
      status: "expired",
      permissions: [...REQUIRED_CLOUDFLARE_PERMISSIONS],
    };
  }

  if (
    lower.startsWith("cf_revoked") ||
    lower.startsWith("cf_disabled") ||
    lower.includes("revoked_token")
  ) {
    return {
      token: trimmed,
      tokenId: "cf_tok_disabled",
      accountId: normalizedAccountId,
      accountName: "Acme Cloudflare Account",
      subdomain: "acme-workers",
      status: "disabled",
      permissions: [...REQUIRED_CLOUDFLARE_PERMISSIONS],
    };
  }

  const grantedScopes = new Set<CloudflarePermissionScope>(
    REQUIRED_CLOUDFLARE_PERMISSIONS,
  );
  if (lower.includes("missing_workers") || lower.includes("no_workers")) {
    grantedScopes.delete("Workers Scripts: Edit");
  }
  if (lower.includes("missing_d1") || lower.includes("no_d1")) {
    grantedScopes.delete("D1: Edit");
  }
  if (lower.includes("missing_queues") || lower.includes("no_queues")) {
    grantedScopes.delete("Queues: Edit");
  }
  if (lower.includes("missing_account") || lower.includes("no_account")) {
    grantedScopes.delete("Account Settings: Read");
  }

  if (lower.includes("multi_account")) {
    const accounts: CloudflareAccountSummary[] = [
      {
        id: "abcdef0123456789abcdef0123456789",
        name: "Acme Production Cloudflare",
        subdomain: "acme-prod",
      },
      {
        id: "fedcba9876543210fedcba9876543210",
        name: "Acme Sandbox Cloudflare",
        subdomain: "acme-sandbox",
      },
    ];
    const chosen =
      accounts.find((a) => a.id === normalizedAccountId) ?? accounts[0]!;
    return {
      token: trimmed,
      tokenId: "cf_tok_multi",
      accountId: chosen.id,
      accountName: chosen.name,
      accounts,
      subdomain: chosen.subdomain ?? "acme-workers",
      status: "active",
      permissions: [...grantedScopes],
    };
  }

  return {
    token: trimmed,
    tokenId: "cf_tok_verified",
    accountId: normalizedAccountId,
    accountName: "Acme Cloudflare Account",
    accounts: [
      {
        id: normalizedAccountId,
        name: "Acme Cloudflare Account",
        subdomain: "acme-workers",
      },
    ],
    subdomain: "acme-workers",
    status: "active",
    permissions: [...grantedScopes],
  };
}
