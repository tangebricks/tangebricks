import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type MaturityTier = "production" | "beta" | "experimental";

export interface TierPolicy {
  minAssertions?: {
    production: number;
    beta: number;
  };
  requireConformanceKit?: {
    production: boolean;
  };
  liveVerifiedMaxAgeDays?: number;
  integrationFidelity?: {
    production: "zero-unacknowledged";
    beta: "report-present";
  };
}

export interface DeriveTierResult {
  tier: MaturityTier;
  blockers: string[];
}

export const TIER_RANK: Record<MaturityTier, number> = {
  experimental: 0,
  beta: 1,
  production: 2,
};

export function loadTierPolicy(policyPath?: string): TierPolicy {
  const defaultPolicy: TierPolicy = {
    minAssertions: { production: 20, beta: 5 },
    requireConformanceKit: { production: true },
    liveVerifiedMaxAgeDays: 7,
    integrationFidelity: { production: "zero-unacknowledged", beta: "report-present" },
  };

  const resolvedPath =
    policyPath ?? resolve(__dirname, "..", "tier-policy.json");

  if (existsSync(resolvedPath)) {
    try {
      const parsed = JSON.parse(readFileSync(resolvedPath, "utf8"));
      return {
        minAssertions: {
          ...defaultPolicy.minAssertions,
          ...(parsed.minAssertions ?? {}),
        },
        requireConformanceKit: {
          ...defaultPolicy.requireConformanceKit,
          ...(parsed.requireConformanceKit ?? {}),
        },
        liveVerifiedMaxAgeDays:
          typeof parsed.liveVerifiedMaxAgeDays === "number"
            ? parsed.liveVerifiedMaxAgeDays
            : defaultPolicy.liveVerifiedMaxAgeDays,
        integrationFidelity: {
          ...defaultPolicy.integrationFidelity,
          ...(parsed.integrationFidelity ?? {}),
        },
      };
    } catch {
      return defaultPolicy;
    }
  }

  return defaultPolicy;
}

export function deriveTier(
  manifest: Record<string, any>,
  tierEvidence?: {
    executed?: boolean;
    passed?: boolean;
    assertionCount?: number;
    skipped?: Array<{ check: string; reason: string }>;
    conformanceKit?: boolean;
  } | null,
  fidelity?: any | null,
  liveCanary?: any | null,
  policy?: TierPolicy | null,
): DeriveTierResult {
  const resolvedPolicy = policy ?? loadTierPolicy();
  const minProd = resolvedPolicy.minAssertions?.production ?? 20;
  const minBeta = resolvedPolicy.minAssertions?.beta ?? 5;
  const maxCanaryAgeDays = resolvedPolicy.liveVerifiedMaxAgeDays ?? 7;

  const isIntegration =
    manifest.kind === "integration" ||
    (typeof manifest.app === "string" && !manifest.id);

  const blockers: string[] = [];

  // 1. Behaviour test execution, pass/fail, and assertion count
  const behaviourTest = manifest.ui?.behaviourTest;
  const executed = Boolean(tierEvidence?.executed);
  const passed = Boolean(tierEvidence?.passed);
  const assertions = typeof tierEvidence?.assertionCount === "number" ? tierEvidence.assertionCount : 0;

  if (!behaviourTest || !tierEvidence || !executed) {
    blockers.push("BEHAVIOUR_TEST_NOT_EXECUTED");
  } else if (!passed) {
    blockers.push("BEHAVIOUR_TEST_FAILED");
  } else if (assertions < minProd) {
    blockers.push("ASSERTIONS_BELOW_MIN");
  }

  // 2. Adapters: Production requires no adapter defaults to fake
  const adapters = manifest.adapters ?? manifest.ui?.adapters;
  if (adapters && typeof adapters === "object") {
    for (const [, adapterDef] of Object.entries(adapters)) {
      if (adapterDef && typeof adapterDef === "object" && (adapterDef as any).default === "fake") {
        blockers.push("DEFAULT_ADAPTER_FAKE");
        break;
      }
    }
  }

  // 3. Conformance kit (for bricks)
  if (!isIntegration && resolvedPolicy.requireConformanceKit?.production) {
    const hasConformanceKit =
      tierEvidence?.conformanceKit === true || tierEvidence?.skipped !== undefined;
    if (!hasConformanceKit) {
      blockers.push("CONFORMANCE_KIT_MISSING");
    }
  }

  // 4. Integration-specific: fidelity and live canary
  let fidelityReportPresent = false;
  if (isIntegration) {
    let unacknowledgedLosses = 0;
    if (fidelity) {
      fidelityReportPresent = fidelity.reportPresent !== false;
      if (typeof fidelity.unacknowledgedLosses === "number") {
        unacknowledgedLosses = fidelity.unacknowledgedLosses;
      } else if (Array.isArray(fidelity.unacknowledgedLosses)) {
        unacknowledgedLosses = fidelity.unacknowledgedLosses.length;
      } else if (typeof fidelity.unacknowledged === "number") {
        unacknowledgedLosses = fidelity.unacknowledged;
      } else if (Array.isArray(fidelity.unacknowledged)) {
        unacknowledgedLosses = fidelity.unacknowledged.length;
      } else if (fidelity.summary && typeof fidelity.summary === "object") {
        unacknowledgedLosses = (fidelity.summary.approximated ?? 0) + (fidelity.summary.unsupported ?? 0);
      } else if (Array.isArray(fidelity.unsupported)) {
        unacknowledgedLosses = fidelity.unsupported.length;
      }
    }

    if (!fidelity || !fidelityReportPresent || unacknowledgedLosses > 0) {
      blockers.push("FIDELITY_UNACKNOWLEDGED_LOSS");
    }

    // Live canary freshness
    let canaryValid = false;
    if (liveCanary) {
      if (typeof liveCanary === "boolean") {
        canaryValid = liveCanary;
      } else if (typeof liveCanary === "object") {
        if (liveCanary.isLiveVerified !== undefined) {
          canaryValid = Boolean(liveCanary.isLiveVerified);
        } else if (liveCanary.status === "pass" && liveCanary.verifiedAt) {
          const verifiedTime = Date.parse(liveCanary.verifiedAt);
          if (!isNaN(verifiedTime)) {
            const ageDays = (Date.now() - verifiedTime) / (1000 * 60 * 60 * 24);
            if (ageDays >= 0 && ageDays <= maxCanaryAgeDays) {
              canaryValid = true;
            }
          }
        }
      }
    }

    if (!canaryValid) {
      blockers.push("LIVE_CANARY_STALE");
    }
  }

  // Determine derived tier
  if (blockers.length === 0) {
    return { tier: "production", blockers: [] };
  }

  // Check if it satisfies beta
  const blocksBeta =
    blockers.includes("BEHAVIOUR_TEST_NOT_EXECUTED") ||
    blockers.includes("BEHAVIOUR_TEST_FAILED") ||
    (blockers.includes("ASSERTIONS_BELOW_MIN") && assertions < minBeta) ||
    (isIntegration && !fidelityReportPresent);

  if (!blocksBeta) {
    return { tier: "beta", blockers };
  }

  return { tier: "experimental", blockers };
}
