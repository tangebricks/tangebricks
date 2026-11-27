import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const checkSandboxScript = resolve(repoRoot, "scripts/check-sandbox-verification.ts");
const mapFile = resolve(repoRoot, "scripts/sandbox-verification-map.json");

describe("Story UC0.2 — sandbox verification generator", () => {
  it("AC 3: scripts/check-sandbox-verification.ts contains no literal true assigned to any guardrail field", () => {
    const src = readFileSync(checkSandboxScript, "utf8");
    const guardrailFields = [
      "enforced",
      "liveSecretPrefixBlocked",
      "liveEgressEndpointBlocked",
      "testSecretAllowed",
      "selectAllowedWhenCapped",
      "ephemeralResourcesDestroyed",
      "blueprintDoPreserved",
      "identicalBuildHash",
      "timeToPreviewPassed",
      "hostedSandboxTargetConformancePassed",
      "workersForPlatformsDispatchPassed",
      "graphHotApplyPreserved",
      "assemblerTargetAgnostic",
    ];

    for (const field of guardrailFields) {
      const regex = new RegExp(`\\b${field}\\s*:\\s*true\\b`);
      expect(regex.test(src), `scripts/check-sandbox-verification.ts must not hardcode '${field}: true'`).toBe(false);
    }
  });

  it("AC 3 & Task 4: sandbox-verification-map.json exists and maps every report boolean to an exact test name", () => {
    expect(existsSync(mapFile), "scripts/sandbox-verification-map.json must exist").toBe(true);
    const map = JSON.parse(readFileSync(mapFile, "utf8")) as Record<string, string>;

    const requiredKeys = [
      "timeToPreviewPassed",
      "guardrails.dailyRequestQuota.enforced",
      "guardrails.d1StorageCap.enforced",
      "guardrails.d1StorageCap.selectAllowedWhenCapped",
      "guardrails.ttl7DayExpiryAndReaper.enforced",
      "guardrails.ttl7DayExpiryAndReaper.ephemeralResourcesDestroyed",
      "guardrails.ttl7DayExpiryAndReaper.blueprintDoPreserved",
      "guardrails.outboundRateLimit.enforced",
      "guardrails.livePaymentsBlocked.liveSecretPrefixBlocked",
      "guardrails.livePaymentsBlocked.liveEgressEndpointBlocked",
      "guardrails.livePaymentsBlocked.testSecretAllowed",
      "promotion.identicalBuildHash",
      "promotion.ephemeralSandboxDestroyed",
      "conformance.hostedSandboxTargetConformancePassed",
      "conformance.workersForPlatformsDispatchPassed",
      "conformance.graphHotApplyPreserved",
      "conformance.assemblerTargetAgnostic",
    ];

    for (const key of requiredKeys) {
      const val = map[key];
      expect(val, `Map must contain an entry for ${key}`).toBeDefined();
      expect(typeof val).toBe("string");
      expect(val?.length).toBeGreaterThan(10);
    }
  });

  it("AC 4: renaming/missing a mapped test makes the script exit 1 with SANDBOX_VERIFICATION_TEST_NOT_FOUND: <name>", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sbx-test-"));
    const evidenceDir = join(tempDir, "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    try {
      const stubResultsFile = join(tempDir, "stub-results.json");
      // Test results that do not include the mapped test names
      const stubResults = {
        testResults: [
          {
            assertionResults: [
              {
                fullName: "Some unrelated other test name that does not match map",
                status: "passed",
              },
            ],
          },
        ],
      };
      writeFileSync(stubResultsFile, JSON.stringify(stubResults));

      const res = spawnSync(process.execPath, [checkSandboxScript], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          POC_EVIDENCE_DIR: evidenceDir,
          SANDBOX_TEST_RESULTS_FILE: stubResultsFile,
        },
      });
      expect(res.status).toBe(1);
      const combined = `${res.stdout}\n${res.stderr}`;
      expect(combined).toContain("SANDBOX_VERIFICATION_TEST_NOT_FOUND");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("Task 2: with a stub runner that reports blocks live secret prefix as failed, script writes liveSecretPrefixBlocked: false and exits 1", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sbx-test-"));
    const evidenceDir = join(tempDir, "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    try {
      const stubResultsFile = join(tempDir, "stub-results.json");

      let map: Record<string, string> = {};
      if (existsSync(mapFile)) {
        map = JSON.parse(readFileSync(mapFile, "utf8"));
      }

      const liveSecretTestName =
        map["guardrails.livePaymentsBlocked.liveSecretPrefixBlocked"] ??
        map["liveSecretPrefixBlocked"] ??
        "Story 9.2 — Sandbox quotas, 7-day TTL expiry, and abuse/SSRF/live-payment guardrails AC 5: Live-payment credentials (sk_live_*, rk_live_*, whsec_live_*) and live payment charge endpoints fail with 403 SANDBOX_LIVE_PAYMENTS_BLOCKED, while test-mode credentials (sk_test_*) succeed";

      const assertionResults: Array<{ fullName: string; status: string }> = [];

      for (const [key, testName] of Object.entries(map)) {
        if (key === "guardrails.livePaymentsBlocked.liveSecretPrefixBlocked" || key === "liveSecretPrefixBlocked" || testName === liveSecretTestName) {
          assertionResults.push({ fullName: testName, status: "failed" });
        } else {
          assertionResults.push({ fullName: testName, status: "passed" });
        }
      }

      if (assertionResults.length === 0) {
        assertionResults.push({
          fullName: liveSecretTestName,
          status: "failed",
        });
      }

      writeFileSync(stubResultsFile, JSON.stringify({ testResults: [{ assertionResults }] }));

      const res = spawnSync(process.execPath, [checkSandboxScript], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          POC_EVIDENCE_DIR: evidenceDir,
          SANDBOX_TEST_RESULTS_FILE: stubResultsFile,
        },
      });

      expect(res.status).toBe(1);

      // Check the generated report
      const topEvidence = join(evidenceDir, "cp9-sandbox-verification.json");
      const simEvidence = join(evidenceDir, "simulated", "cp9-sandbox-verification.json");
      const outPath = existsSync(topEvidence) ? topEvidence : simEvidence;

      expect(existsSync(outPath), "Evidence JSON must be generated").toBe(true);
      const report = JSON.parse(readFileSync(outPath, "utf8"));
      expect(report.guardrails.livePaymentsBlocked.liveSecretPrefixBlocked, "liveSecretPrefixBlocked must be false").toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
