import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveTier } from "../lib/derive-tier.ts";
import { checkBrickConformance } from "../check-manifests.ts";
import type { TierPolicy } from "../lib/derive-tier.ts";

const defaultPolicy: TierPolicy = {
  minAssertions: {
    production: 20,
    beta: 5,
  },
  requireConformanceKit: {
    production: true,
  },
  liveVerifiedMaxAgeDays: 7,
  integrationFidelity: {
    production: "zero-unacknowledged",
    beta: "report-present",
  },
};

describe("UC5.6 deriveTier unit tests", () => {
  it("AC3 / Task 1: production + behaviour test not executed -> derived experimental (BEHAVIOUR_TEST_NOT_EXECUTED)", () => {
    const manifest = {
      manifestVersion: 2,
      kind: "brick",
      id: "test-brick",
      version: "1.0.0",
      ui: {
        displayName: "Test Brick",
        category: "utility",
        summary: "Test brick summary",
        maturity: "production",
        behaviourTest: "test/test.test.ts",
      },
    };

    const tierEvidence = {
      id: "test-brick",
      kind: "brick" as const,
      behaviourTest: "bricks/test-brick/test/test.test.ts",
      executed: false,
      passed: false,
      testsRun: 0,
      testsSkipped: 0,
      assertionCount: 0,
    };

    const res = deriveTier(manifest, tierEvidence, null, null, defaultPolicy);
    expect(res.tier).toBe("experimental");
    expect(res.blockers).toContain("BEHAVIOUR_TEST_NOT_EXECUTED");
  });

  it("AC3: production + behaviour test failed -> derived experimental (BEHAVIOUR_TEST_FAILED)", () => {
    const manifest = {
      manifestVersion: 2,
      kind: "brick",
      id: "test-brick",
      version: "1.0.0",
      ui: {
        displayName: "Test Brick",
        category: "utility",
        summary: "Test brick summary",
        maturity: "production",
        behaviourTest: "test/test.test.ts",
      },
    };

    const tierEvidence = {
      id: "test-brick",
      kind: "brick" as const,
      behaviourTest: "bricks/test-brick/test/test.test.ts",
      executed: true,
      passed: false,
      testsRun: 5,
      testsSkipped: 0,
      assertionCount: 25,
      skipped: [],
    };

    const res = deriveTier(manifest, tierEvidence, null, null, defaultPolicy);
    expect(res.tier).toBe("experimental");
    expect(res.blockers).toContain("BEHAVIOUR_TEST_FAILED");
  });

  it("AC3 / Task 1: production + assertionCount 12 below minimum 20 -> derived beta (ASSERTIONS_BELOW_MIN)", () => {
    const manifest = {
      manifestVersion: 2,
      kind: "brick",
      id: "test-brick",
      version: "1.0.0",
      ui: {
        displayName: "Test Brick",
        category: "utility",
        summary: "Test brick summary",
        maturity: "production",
        behaviourTest: "test/test.test.ts",
      },
    };

    const tierEvidence = {
      id: "test-brick",
      kind: "brick" as const,
      behaviourTest: "bricks/test-brick/test/test.test.ts",
      executed: true,
      passed: true,
      testsRun: 3,
      testsSkipped: 0,
      assertionCount: 12,
      skipped: [],
    };

    const res = deriveTier(manifest, tierEvidence, null, null, defaultPolicy);
    expect(res.tier).toBe("beta");
    expect(res.blockers).toContain("ASSERTIONS_BELOW_MIN");
  });

  it("AC3: production + assertionCount 3 below beta minimum 5 -> derived experimental (ASSERTIONS_BELOW_MIN)", () => {
    const manifest = {
      manifestVersion: 2,
      kind: "brick",
      id: "test-brick",
      version: "1.0.0",
      ui: {
        displayName: "Test Brick",
        category: "utility",
        summary: "Test brick summary",
        maturity: "production",
        behaviourTest: "test/test.test.ts",
      },
    };

    const tierEvidence = {
      id: "test-brick",
      kind: "brick" as const,
      behaviourTest: "bricks/test-brick/test/test.test.ts",
      executed: true,
      passed: true,
      testsRun: 2,
      testsSkipped: 0,
      assertionCount: 3,
      skipped: [],
    };

    const res = deriveTier(manifest, tierEvidence, null, null, defaultPolicy);
    expect(res.tier).toBe("experimental");
    expect(res.blockers).toContain("ASSERTIONS_BELOW_MIN");
  });

  it("AC3: production + conformance kit missing -> derived beta (CONFORMANCE_KIT_MISSING)", () => {
    const manifest = {
      manifestVersion: 2,
      kind: "brick",
      id: "test-brick",
      version: "1.0.0",
      ui: {
        displayName: "Test Brick",
        category: "utility",
        summary: "Test brick summary",
        maturity: "production",
        behaviourTest: "test/test.test.ts",
      },
    };

    const tierEvidence = {
      id: "test-brick",
      kind: "brick" as const,
      behaviourTest: "bricks/test-brick/test/test.test.ts",
      executed: true,
      passed: true,
      testsRun: 10,
      testsSkipped: 0,
      assertionCount: 30,
      // skipped is undefined => conformance kit was not run
    };

    const res = deriveTier(manifest, tierEvidence, null, null, defaultPolicy);
    expect(res.tier).toBe("beta");
    expect(res.blockers).toContain("CONFORMANCE_KIT_MISSING");
  });

  it("AC3 / Task 1: production + adapters.*.default: 'fake' -> derived beta (DEFAULT_ADAPTER_FAKE)", () => {
    const manifest = {
      manifestVersion: 2,
      kind: "brick",
      id: "credit-wallet",
      version: "1.0.0",
      ui: {
        displayName: "Ledger & Credit Wallet",
        category: "billing",
        summary: "Atomic double-entry credit ledger",
        maturity: "production",
        behaviourTest: "test/credit-wallet.test.ts",
      },
      adapters: {
        paymentGateway: {
          default: "fake" as const,
        },
      },
    };

    const tierEvidence = {
      id: "credit-wallet",
      kind: "brick" as const,
      behaviourTest: "bricks/credit-wallet/test/credit-wallet.test.ts",
      executed: true,
      passed: true,
      testsRun: 15,
      testsSkipped: 0,
      assertionCount: 40,
      skipped: [],
    };

    const res = deriveTier(manifest, tierEvidence, null, null, defaultPolicy);
    expect(res.tier).toBe("beta");
    expect(res.blockers).toContain("DEFAULT_ADAPTER_FAKE");
  });

  it("AC3 / Task 1: integration production + fidelity with unacknowledged losses -> derived beta (FIDELITY_UNACKNOWLEDGED_LOSS)", () => {
    const manifest = {
      manifestVersion: 2,
      kind: "integration",
      app: "stripe",
      version: "1.0.0",
      ui: {
        displayName: "Stripe",
        category: "billing",
        summary: "Stripe integration",
        maturity: "production",
        behaviourTest: "packages/integrations/test/pack-v1-contract.workerd.test.ts",
      },
    };

    const tierEvidence = {
      id: "stripe",
      kind: "integration" as const,
      behaviourTest: "packages/integrations/test/pack-v1-contract.workerd.test.ts",
      executed: true,
      passed: true,
      testsRun: 10,
      testsSkipped: 0,
      assertionCount: 50,
    };

    const fidelity = {
      reportPresent: true,
      unacknowledgedLosses: 2,
    };

    const liveCanary = {
      app: "stripe",
      status: "pass" as const,
      verifiedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days old
      operations: [],
    };

    const res = deriveTier(manifest, tierEvidence, fidelity, liveCanary, defaultPolicy);
    expect(res.tier).toBe("beta");
    expect(res.blockers).toContain("FIDELITY_UNACKNOWLEDGED_LOSS");
  });

  it("AC3 / Task 1: integration production + live canary 9 days old -> derived beta (LIVE_CANARY_STALE)", () => {
    const manifest = {
      manifestVersion: 2,
      kind: "integration",
      app: "stripe",
      version: "1.0.0",
      ui: {
        displayName: "Stripe",
        category: "billing",
        summary: "Stripe integration",
        maturity: "production",
        behaviourTest: "packages/integrations/test/pack-v1-contract.workerd.test.ts",
      },
    };

    const tierEvidence = {
      id: "stripe",
      kind: "integration" as const,
      behaviourTest: "packages/integrations/test/pack-v1-contract.workerd.test.ts",
      executed: true,
      passed: true,
      testsRun: 10,
      testsSkipped: 0,
      assertionCount: 50,
    };

    const fidelity = {
      reportPresent: true,
      unacknowledgedLosses: 0,
    };

    const liveCanary = {
      app: "stripe",
      status: "pass" as const,
      verifiedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(), // 9 days old (> 7 days)
      operations: [],
    };

    const res = deriveTier(manifest, tierEvidence, fidelity, liveCanary, defaultPolicy);
    expect(res.tier).toBe("beta");
    expect(res.blockers).toContain("LIVE_CANARY_STALE");
  });

  it("AC1 / AC4 / Task 1: everything satisfied -> derived production with 0 blockers (brick and integration)", () => {
    // Brick satisfied
    const brickManifest = {
      manifestVersion: 2,
      kind: "brick",
      id: "audit-trail",
      version: "1.0.0",
      ui: {
        displayName: "Audit Trail",
        category: "security",
        summary: "Append-only immutable audit trail",
        maturity: "production",
        behaviourTest: "test/audit.test.ts",
      },
      adapters: {
        storage: {
          default: "real" as const,
        },
      },
    };

    const brickEvidence = {
      id: "audit-trail",
      kind: "brick" as const,
      behaviourTest: "bricks/audit-trail/test/audit.test.ts",
      executed: true,
      passed: true,
      testsRun: 5,
      testsSkipped: 0,
      assertionCount: 25,
      skipped: [],
    };

    const brickRes = deriveTier(brickManifest, brickEvidence, null, null, defaultPolicy);
    expect(brickRes.tier).toBe("production");
    expect(brickRes.blockers).toEqual([]);

    // Integration satisfied
    const intManifest = {
      manifestVersion: 2,
      kind: "integration",
      app: "stripe",
      version: "1.0.0",
      ui: {
        displayName: "Stripe",
        category: "billing",
        summary: "Stripe integration",
        maturity: "production",
        behaviourTest: "packages/integrations/test/pack-v1-contract.workerd.test.ts",
      },
    };

    const intEvidence = {
      id: "stripe",
      kind: "integration" as const,
      behaviourTest: "packages/integrations/test/pack-v1-contract.workerd.test.ts",
      executed: true,
      passed: true,
      testsRun: 10,
      testsSkipped: 0,
      assertionCount: 50,
    };

    const intFidelity = {
      reportPresent: true,
      unacknowledgedLosses: 0,
    };

    const freshCanary = {
      app: "stripe",
      status: "pass" as const,
      verifiedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      operations: [],
    };

    const intRes = deriveTier(intManifest, intEvidence, intFidelity, freshCanary, defaultPolicy);
    expect(intRes.tier).toBe("production");
    expect(intRes.blockers).toEqual([]);
  });
});

describe("UC5.6 check-manifests conformance gate integration", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    delete process.env.POC_EVIDENCE_DIR;
    delete process.env.POC_TIER_EVIDENCE_PATH;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function setupWorkspace(options: {
    brickId: string;
    declaredTier: string;
    maturityReason?: string;
    adapters?: Record<string, { default: "real" | "fake"; reason?: string }>;
    tierEvidence: {
      executed: boolean;
      passed: boolean;
      assertionCount: number;
      skipped?: Array<{ check: string; reason: string }>;
    };
  }) {
    const root = mkdtempSync(join(tmpdir(), "check-manifests-conformance-"));
    tempDirs.push(root);

    const bricksDir = join(root, "bricks");
    const brickDir = join(bricksDir, options.brickId);
    mkdirSync(join(brickDir, "src"), { recursive: true });
    mkdirSync(join(brickDir, "migrations"), { recursive: true });
    mkdirSync(join(brickDir, "test"), { recursive: true });

    writeFileSync(join(brickDir, "migrations", "0001_init.sql"), "CREATE TABLE items (id TEXT);");
    writeFileSync(join(brickDir, "src", "index.ts"), "export const routes = () => ({});");
    writeFileSync(join(brickDir, "test", "test.test.ts"), "test('ok', () => {});");
    writeFileSync(join(brickDir, "package.json"), JSON.stringify({ name: `@poc/${options.brickId}`, version: "1.0.0" }));
    writeFileSync(join(brickDir, "CHANGELOG.md"), "# Changelog\n");

    const manifest: Record<string, any> = {
      manifestVersion: 2,
      kind: "brick",
      id: options.brickId,
      version: "1.0.0",
      trust: "first-party",
      provides: [],
      requires: [],
      migrations: ["migrations/0001_init.sql"],
      routePrefixes: ["test"],
      npmDependencies: { hono: "4.13.13", zod: "4.6.7" },
      settings: {},
      ui: {
        displayName: "Test Brick",
        category: "developer",
        summary: "Test summary",
        maturity: options.declaredTier,
        maturityReason: options.maturityReason,
        behaviourTest: "test/test.test.ts",
      },
      worker: {
        package: `@poc/${options.brickId}`,
        routes: [{ factory: "routes", mountAt: "/test", options: {} }],
      },
    };

    if (options.adapters) {
      manifest.adapters = options.adapters;
    }

    writeFileSync(join(brickDir, "brick.manifest.json"), JSON.stringify(manifest, null, 2));

    const evidenceDir = join(root, "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    const tierEvidenceRow = {
      id: options.brickId,
      kind: "brick",
      behaviourTest: `bricks/${options.brickId}/test/test.test.ts`,
      executed: options.tierEvidence.executed,
      passed: options.tierEvidence.passed,
      testsRun: options.tierEvidence.executed ? 5 : 0,
      testsSkipped: 0,
      assertionCount: options.tierEvidence.assertionCount,
      ...(options.tierEvidence.skipped !== undefined ? { skipped: options.tierEvidence.skipped } : {}),
    };

    writeFileSync(join(evidenceDir, "tier-evidence.json"), JSON.stringify({ data: [tierEvidenceRow] }, null, 2));

    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, "tier-policy.json"), JSON.stringify(defaultPolicy, null, 2));

    process.env.POC_EVIDENCE_DIR = evidenceDir;

    return { root, brickDir };
  }

  it("conformance fails when declared is production but derived is beta due to default adapter fake", () => {
    const { brickDir } = setupWorkspace({
      brickId: "fake-adapter-brick",
      declaredTier: "production",
      adapters: {
        provider: { default: "fake" },
      },
      tierEvidence: {
        executed: true,
        passed: true,
        assertionCount: 25,
        skipped: [],
      },
    });

    const violations = checkBrickConformance(brickDir, "fake-adapter-brick");
    const matViolation = violations.find((v) => v.field === "ui.maturity");
    expect(matViolation).toBeDefined();
    expect(matViolation?.detail).toContain("declared production, derived beta: DEFAULT_ADAPTER_FAKE");
  });

  it("conformance passes when declared is beta and derived is beta with maturityReason set", () => {
    const { brickDir } = setupWorkspace({
      brickId: "honest-beta-brick",
      declaredTier: "beta",
      maturityReason: "DEFAULT_ADAPTER_FAKE: Provider adapter defaults to fake",
      adapters: {
        provider: { default: "fake" },
      },
      tierEvidence: {
        executed: true,
        passed: true,
        assertionCount: 25,
        skipped: [],
      },
    });

    const violations = checkBrickConformance(brickDir, "honest-beta-brick");
    const matViolations = violations.filter((v) => v.field === "ui.maturity");
    expect(matViolations).toEqual([]);
  });

  it("conformance fails when declared is production but behaviour test not executed", () => {
    const { brickDir } = setupWorkspace({
      brickId: "unexecuted-brick",
      declaredTier: "production",
      tierEvidence: {
        executed: false,
        passed: false,
        assertionCount: 0,
      },
    });

    const violations = checkBrickConformance(brickDir, "unexecuted-brick");
    const matViolation = violations.find((v) => v.field === "ui.maturity");
    expect(matViolation).toBeDefined();
    expect(matViolation?.detail).toContain("declared production, derived experimental: BEHAVIOUR_TEST_NOT_EXECUTED");
  });
});
