import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLiveVerified, runAppCanary, validateCanaryPlan, type CanaryPlan } from "../lib/live-canary.ts";

describe("Live canary harness against provider sandboxes (UC5.5)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "live-canary-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("(a) Without required secret env var, canary writes status: 'skipped', reason: 'CANARY_SECRET_MISSING' and is not verified", async () => {
    const result = await runAppCanary("stripe", {
      env: {},
      evidenceDir: tempDir,
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("CANARY_SECRET_MISSING");

    const evidenceFile = join(tempDir, "stripe.json");
    expect(existsSync(evidenceFile)).toBe(true);
    const content = JSON.parse(readFileSync(evidenceFile, "utf8"));
    expect(content.app).toBe("stripe");
    expect(content.status).toBe("skipped");
    expect(content.reason).toBe("CANARY_SECRET_MISSING");

    // Must not be marked live-verified
    expect(isLiveVerified("stripe", new Date(), { evidenceDir: tempDir })).toBe(false);
  });

  test("(b) A secret matching live-key patterns (sk_live_, rk_live_, whsec_live_) aborts with CANARY_LIVE_CREDENTIAL_REFUSED", async () => {
    await expect(
      runAppCanary("stripe", {
        env: { CANARY_STRIPE_TOKEN: "sk_" + "live_abcdef1234567890abcdef1234" },
        evidenceDir: tempDir,
      }),
    ).rejects.toThrow(/CANARY_LIVE_CREDENTIAL_REFUSED/);

    await expect(
      runAppCanary("stripe", {
        env: { CANARY_STRIPE_TOKEN: "rk_" + "live_sec998877665544332211" },
        evidenceDir: tempDir,
      }),
    ).rejects.toThrow(/CANARY_LIVE_CREDENTIAL_REFUSED/);
  });

  test("(c) A stub executor returning success writes evidence/live-canary/<app>.json with status: 'pass', verifiedAt and gitSha", async () => {
    const fakeToken = "sk_test_fake_sandbox_key_9900";
    const mockFetcher = async (_req: Request | string) => {
      return new Response(JSON.stringify({ object: "list", data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await runAppCanary("stripe", {
      env: { CANARY_STRIPE_TOKEN: fakeToken },
      evidenceDir: tempDir,
      fetcher: mockFetcher as typeof fetch,
    });

    expect(result.status).toBe("pass");
    expect(result.app).toBe("stripe");
    expect(result.verifiedAt).toBeDefined();
    expect(isNaN(Date.parse(result.verifiedAt!))).toBe(false);
    expect(result.gitSha).toMatch(/^[0-9a-f]{40}$/i);
    expect(result.operations.length).toBeGreaterThan(0);
    expect(result.operations[0]!.httpStatus).toBe(200);

    const evidenceFile = join(tempDir, "stripe.json");
    expect(existsSync(evidenceFile)).toBe(true);
    const content = JSON.parse(readFileSync(evidenceFile, "utf8"));
    expect(content.app).toBe("stripe");
    expect(content.status).toBe("pass");
    expect(content.gitSha).toBe(result.gitSha);

    // Is marked live-verified
    expect(isLiveVerified("stripe", new Date(), { evidenceDir: tempDir })).toBe(true);
  });

  test("AC1: Secret scrubbing removes any secret values from written evidence", async () => {
    const fakeToken = "sk_test_canary_super_secret_token_1234";
    const mockFetcher = async () => {
      return new Response(
        JSON.stringify({
          object: "customer",
          id: "cus_123",
          echoed_secret: fakeToken,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    await runAppCanary("stripe", {
      env: { CANARY_STRIPE_TOKEN: fakeToken },
      evidenceDir: tempDir,
      fetcher: mockFetcher as typeof fetch,
    });

    const evidenceFile = join(tempDir, "stripe.json");
    const rawText = readFileSync(evidenceFile, "utf8");
    expect(rawText).not.toContain(fakeToken);
  });

  test("AC2: isLiveVerified returns false for evidence older than 7 days, for skipped, and for fail", () => {
    const now = new Date("2026-11-05T12:00:00.000Z");

    // Fresh pass (2 days old) -> true
    writeFileSync(
      join(tempDir, "fresh.json"),
      JSON.stringify({
        app: "fresh",
        status: "pass",
        verifiedAt: "2026-11-03T12:00:00.000Z",
      }),
    );
    expect(isLiveVerified("fresh", now, { evidenceDir: tempDir })).toBe(true);

    // Stale pass (8 days old) -> false
    writeFileSync(
      join(tempDir, "stale.json"),
      JSON.stringify({
        app: "stale",
        status: "pass",
        verifiedAt: "2026-10-27T12:00:00.000Z",
      }),
    );
    expect(isLiveVerified("stale", now, { evidenceDir: tempDir })).toBe(false);

    // Skipped -> false
    writeFileSync(
      join(tempDir, "skipped.json"),
      JSON.stringify({
        app: "skipped",
        status: "skipped",
        reason: "CANARY_SECRET_MISSING",
        verifiedAt: "2026-11-05T11:00:00.000Z",
      }),
    );
    expect(isLiveVerified("skipped", now, { evidenceDir: tempDir })).toBe(false);

    // Fail -> false
    writeFileSync(
      join(tempDir, "failed.json"),
      JSON.stringify({
        app: "failed",
        status: "fail",
        verifiedAt: "2026-11-05T11:00:00.000Z",
      }),
    );
    expect(isLiveVerified("failed", now, { evidenceDir: tempDir })).toBe(false);

    // Nonexistent -> false
    expect(isLiveVerified("missing", now, { evidenceDir: tempDir })).toBe(false);
  });

  test("AC3: Canary plan validation refuses write ops without sandboxOnly: true", () => {
    const validPlan: CanaryPlan = {
      app: "stripe",
      secretEnv: "CANARY_STRIPE_TOKEN",
      operations: [
        {
          operationId: "listCustomers",
          inputs: {},
          expect: { status: 200 },
        },
        {
          operationId: "createCustomer",
          inputs: { name: "test" },
          sandboxOnly: true,
          expect: { status: 200 },
        },
      ],
    };

    expect(() => validateCanaryPlan(validPlan)).not.toThrow();

    const invalidWritePlan: CanaryPlan = {
      app: "stripe",
      secretEnv: "CANARY_STRIPE_TOKEN",
      operations: [
        {
          operationId: "createCustomer",
          inputs: { name: "test" },
          // sandboxOnly is missing for a write operation!
          expect: { status: 200 },
        },
      ],
    };

    expect(() => validateCanaryPlan(invalidWritePlan)).toThrow(/sandboxOnly/i);
  });
});
