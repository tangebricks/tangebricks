import { describe, expect, test } from "vitest";
import { createFakeCloudflare } from "../../packages/deploy/test/support/fake-cloudflare.ts";
import { createClient } from "../../packages/deploy/src/provisioner/index.ts";
import { runRestoreDrill } from "../restore-drill.ts";

const TOKEN = "cfut_Zq8rLm3VxN2pTb7YkWd4HsJc9GaE5uRo6QiXf1BvPn0AyMt";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

function setupFake() {
  const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT });
  const credentials = { token: TOKEN, accountId: ACCOUNT };
  const client = createClient({ credentials, fetch: fake.fetch });
  return { fake, client };
}

describe("D1 restore automated drill (UC9.5)", () => {
  test("runRestoreDrill against fake Cloudflare executes full restore drill, asserts canary states, tears down and returns metrics", async () => {
    const { fake, client } = setupFake();

    const result = await runRestoreDrill({
      client,
      mode: "fake",
      writeEvidenceFile: false,
    });

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.gitSha).toMatch(/^[0-9a-f]{40}$/i);
    expect(isNaN(Date.parse(result.measuredAt))).toBe(false);

    // Assert steps executed
    const stepNames = result.steps.map((s) => s.name);
    expect(stepNames).toContain("createDb");
    expect(stepNames).toContain("migrate");
    expect(stepNames).toContain("seedA");
    expect(stepNames).toContain("bookmark");
    expect(stepNames).toContain("seedB");
    expect(stepNames).toContain("restoreA");
    expect(stepNames).toContain("verifyA");
    expect(stepNames).toContain("restoreB");
    expect(stepNames).toContain("verifyB");
    expect(stepNames).toContain("teardown");

    // Assert durations
    expect(result.durationsMs).toBeDefined();
    expect(typeof result.durationsMs.total).toBe("number");
    expect(result.durationsMs.total).toBeGreaterThanOrEqual(0);
    expect(typeof result.durationsMs.createDb).toBe("number");
    expect(typeof result.durationsMs.restoreA).toBe("number");
    expect(typeof result.durationsMs.restoreB).toBe("number");

    // Assert database was torn down (scratch DB removed)
    const liveDbs = fake.state().databases.filter((d) => d.name.startsWith("px-drill-"));
    expect(liveDbs).toHaveLength(0);
  });

  test("AC2: refuses any database whose name does not start with px-drill- before any write", async () => {
    const { fake, client } = setupFake();

    await expect(
      runRestoreDrill({
        client,
        mode: "fake",
        dbName: "unauthorized-prod-db",
        writeEvidenceFile: false,
      }),
    ).rejects.toThrow(/px-drill-/i);

    // Verify nothing was created in Cloudflare
    expect(fake.state().databases).toHaveLength(0);
  });

  test("tears down scratch database even if a verification or restore step fails", async () => {
    const { fake, client } = setupFake();

    // Trigger failure during run with invalid step hook or invalid query
    await expect(
      runRestoreDrill({
        client,
        mode: "fake",
        writeEvidenceFile: false,
        _failAtStep: "restoreA",
      }),
    ).rejects.toThrow(/simulated failure at restoreA/i);

    // Verify scratch database was torn down in finally block
    const liveDbs = fake.state().databases.filter((d) => d.name.startsWith("px-drill-"));
    expect(liveDbs).toHaveLength(0);
  });
});
