import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeCloudflare } from "../../packages/deploy/test/support/fake-cloudflare.ts";
import { createClient } from "../../packages/deploy/src/provisioner/cloudflare.ts";
import { memoryStore, openLedger } from "../../packages/deploy/src/provisioner/ledger.ts";
import { probeWorkflowLimits, writeWorkflowsLimitsEvidence } from "../probe-workflow-limits.ts";
import { getPlatformLimits, PLATFORM_LIMITS } from "../../packages/sdk/src/platform-limits.ts";
import type { WorkflowLimitsEvidence } from "../probe-workflow-limits.ts";

describe("UC7.3: probe-workflow-limits", () => {
  it("probes workflow limits against fake Cloudflare and returns structured measurements", async () => {
    const fake = createFakeCloudflare({
      token: "valid-token-12345",
      accountId: "0123456789abcdef0123456789abcdef",
      instanceDetails: (workflowName, instanceId) => {
        // Return simulated instance execution details
        if (instanceId.includes("steps-")) {
          const stepCount = parseInt(instanceId.split("steps-")[1] ?? "1", 10);
          return {
            status: "complete",
            success: true,
            output: { done: true },
            steps: Array.from({ length: stepCount }, (_, i) => ({
              name: `step-${i}`,
              type: "step",
              success: true,
              output: { index: i },
            })),
          };
        }
        if (instanceId.includes("return-bytes-")) {
          const bytes = parseInt(instanceId.split("return-bytes-")[1] ?? "1024", 10);
          return {
            status: "complete",
            success: true,
            output: "x".repeat(bytes),
            steps: [{ name: "payload-step", type: "step", success: true, output: "x".repeat(bytes) }],
          };
        }
        if (instanceId.includes("event-bytes-")) {
          const bytes = parseInt(instanceId.split("event-bytes-")[1] ?? "1024", 10);
          return {
            status: "complete",
            success: true,
            output: { received: bytes },
            steps: [{ name: "echo-event", type: "step", success: true, output: { bytes } }],
          };
        }
        if (instanceId.includes("subrequests-")) {
          const subs = parseInt(instanceId.split("subrequests-")[1] ?? "10", 10);
          return {
            status: "complete",
            success: true,
            output: { fetchesMade: subs },
            steps: [{ name: "fetch-step", type: "step", success: true, output: { count: subs } }],
          };
        }
        if (instanceId.includes("retries-")) {
          const k = parseInt(instanceId.split("retries-")[1] ?? "3", 10);
          return {
            status: "complete",
            success: true,
            output: { attempts: k + 1 },
            steps: [{ name: "retry-step", type: "step", success: true, attempts: Array.from({ length: k + 1 }) }],
          };
        }
        return {
          status: "complete",
          success: true,
          steps: [],
        };
      },
    });

    const client = createClient({
      credentials: { token: "valid-token-12345", accountId: "0123456789abcdef0123456789abcdef" },
      fetch: (req) => fake.fetch(req),
    });

    const result = await probeWorkflowLimits({
      client,
      gitSha: "0123456789abcdef0123456789abcdef01234567",
      accountPlan: "free",
      maxStepBisection: 1024,
      maxByteBisection: 1024 * 1024,
    });

    expect(result).toBeDefined();
    expect(result.maxStepsObserved).toBeGreaterThanOrEqual(256);
    expect(result.stepReturnBytesMax).toBeGreaterThanOrEqual(128 * 1024);
    expect(result.eventPayloadBytesMax).toBeGreaterThanOrEqual(128 * 1024);
    expect(result.subrequestsPerInvocation).toBeGreaterThanOrEqual(50);
    expect(result.retriesHonoured).toBeGreaterThanOrEqual(1);
    expect(result.accountPlan).toBe("free");
    expect(result.gitSha).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(new Date(result.measuredAt).getTime()).toBeGreaterThan(0);
  });

  it("refuses to write evidence if gitSha is empty or measuredAt is stale", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "uc73-evidence-"));
    try {
      const validEvidence: WorkflowLimitsEvidence = {
        maxStepsObserved: 1024,
        stepReturnBytesMax: 1024 * 1024,
        eventPayloadBytesMax: 1024 * 1024,
        subrequestsPerInvocation: 50,
        retriesHonoured: 3,
        measuredAt: new Date().toISOString(),
        gitSha: "0123456789abcdef0123456789abcdef01234567",
        accountPlan: "free",
      };

      // 1. Refuses empty gitSha
      expect(() => {
        writeWorkflowsLimitsEvidence({ ...validEvidence, gitSha: "" }, tmpDir);
      }).toThrow(/gitSha.*empty/i);

      // 2. Refuses stale or non-current measuredAt
      expect(() => {
        writeWorkflowsLimitsEvidence({ ...validEvidence, measuredAt: "2020-01-01T00:00:00.000Z" }, tmpDir);
      }).toThrow(/measuredAt.*stale|Date\.now/i);

      // 3. Writes successfully with fresh Date.now and valid gitSha
      const filePath = writeWorkflowsLimitsEvidence(validEvidence, tmpDir);
      expect(readFileSync(filePath, "utf8")).toContain("maxStepsObserved");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("PLATFORM_LIMITS cites documented defaults and prioritizes measured evidence when present", () => {
    // Documented defaults have source and date
    expect(PLATFORM_LIMITS.free.subrequests.source).toMatch(/developers\.cloudflare\.com/);
    expect(PLATFORM_LIMITS.free.subrequests.limit).toBe(50);
    expect(PLATFORM_LIMITS.paid.subrequests.limit).toBe(1000);
    expect(PLATFORM_LIMITS.free.d1BindParams.limit).toBe(100);

    // Overridden by custom evidence
    const customEvidence: WorkflowLimitsEvidence = {
      maxStepsObserved: 2048,
      stepReturnBytesMax: 2 * 1024 * 1024,
      eventPayloadBytesMax: 2 * 1024 * 1024,
      subrequestsPerInvocation: 60,
      retriesHonoured: 5,
      measuredAt: new Date().toISOString(),
      gitSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      accountPlan: "free",
    };

    const merged = getPlatformLimits("free", customEvidence);
    expect(merged.steps.limit).toBe(2048);
    expect(merged.steps.kind).toBe("measured");
    expect(merged.stepReturnBytes.limit).toBe(2 * 1024 * 1024);
    expect(merged.stepReturnBytes.kind).toBe("measured");
    expect(merged.subrequests.limit).toBe(60);
    expect(merged.subrequests.kind).toBe("measured");
    // Non-probed values retain documented source
    expect(merged.d1BindParams.limit).toBe(100);
    expect(merged.d1BindParams.kind).toBe("documented");
  });

  it("leaves nothing in the account: teardown leaves 0 active ledger entries (AC3)", async () => {
    const fake = createFakeCloudflare({
      token: "valid-token-12345",
      accountId: "0123456789abcdef0123456789abcdef",
      instanceDetails: () => ({ status: "complete", success: true, steps: [] }),
    });

    const client = createClient({
      credentials: { token: "valid-token-12345", accountId: "0123456789abcdef0123456789abcdef" },
      fetch: (req) => fake.fetch(req),
    });

    const store = memoryStore();
    const ledger = openLedger(store, () => "12345678");
    const scriptName = "projectx-poc-12345678";
    ledger.planned("worker_script", scriptName);
    fake.seedScript(scriptName);
    ledger.created("worker_script", scriptName);

    expect(ledger.entries().filter((e) => e.status !== "removed").length).toBe(1);

    await probeWorkflowLimits({
      client,
      ledger,
      gitSha: "0123456789abcdef0123456789abcdef01234567",
      maxStepBisection: 256,
      maxByteBisection: 128 * 1024,
    });

    expect(ledger.entries().filter((e) => e.status !== "removed").length).toBe(0);
  });
});
