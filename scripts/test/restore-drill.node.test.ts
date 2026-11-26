import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createFakeCloudflare } from "../../packages/deploy/test/support/fake-cloudflare.ts";
import { createClient } from "../../packages/deploy/src/provisioner/index.ts";
import { CANARY_TABLE, assertTargetGuards, parseRestoreDrillArgs, runRestoreDrill, runTargetRestoreDrill } from "../restore-drill.ts";

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

describe("restore drill, scratch evidence file", () => {
  test("a scratch run writes evidence/restore-drill-scratch.json, never the staging evidence", async () => {
    const { client } = setupFake();
    const dir = mkdtempSync(join(tmpdir(), "drill-evidence-dir-"));
    const before = process.env.POC_EVIDENCE_DIR;
    process.env.POC_EVIDENCE_DIR = dir;
    try {
      await runRestoreDrill({ client, mode: "fake", writeEvidenceFile: true, log: () => {} });
    } finally {
      if (before === undefined) delete process.env.POC_EVIDENCE_DIR;
      else process.env.POC_EVIDENCE_DIR = before;
    }
    expect(existsSync(join(dir, "restore-drill.json"))).toBe(false);
    expect(existsSync(join(dir, "deployed", "restore-drill-result.json"))).toBe(false);
    const text = readFileSync(join(dir, "restore-drill-scratch.json"), "utf8");
    expect(JSON.parse(text)).toMatchObject({ target: "scratch" });
    expect(text).not.toMatch(/bm_\d+/);
  });
});

describe("restore drill, target mode (story 1.3): one named existing staging database", () => {
  function seedStaging(name = "cephlow-app-staging") {
    const { fake, client } = setupFake();
    const uuid = fake.seedDatabase(name);
    fake.exec(name, "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT)");
    fake.exec(name, "INSERT INTO users VALUES ('u1', 'a@example.test'), ('u2', 'b@example.test')");
    fake.exec(name, "CREATE TABLE orders (id TEXT PRIMARY KEY, total REAL)");
    fake.exec(name, "INSERT INTO orders VALUES ('o1', 10)");
    return { fake, client, uuid, name };
  }
  const writes = (fake: ReturnType<typeof setupFake>["fake"]) =>
    fake.requests.filter((r) => r.method !== "GET");

  test("restores the canary after the destructive change, matches the fingerprint, drops the canary and writes redacted evidence", async () => {
    const { fake, client, uuid, name } = seedStaging();
    const dir = mkdtempSync(join(tmpdir(), "drill-evidence-"));
    const evidencePath = join(dir, "restore-drill.json");
    const result = await runTargetRestoreDrill({ client, targetDb: uuid, expectName: name, evidencePath, log: () => {} });

    expect(result.verification).toEqual({ canaryRestored: true, fingerprintMatches: true, canaryDropped: true });
    expect(result.tablesFingerprinted).toBe(2);
    expect(result.steps.map((s) => s.name)).toEqual(["preflight", "fingerprint", "createCanary", "bookmark", "destroy", "restore", "verify", "dropCanary"]);
    expect(typeof result.durationsMs.total).toBe("number");

    const db = fake.state().databases.find((d) => d.name === name)!;
    expect(db.tables).not.toContain(CANARY_TABLE);
    expect(fake.rows(name, "SELECT id FROM users ORDER BY id")).toEqual([{ id: "u1" }, { id: "u2" }]);
    expect(fake.rows(name, "SELECT id FROM orders")).toEqual([{ id: "o1" }]);
    expect(fake.requests.some((r) => r.path.endsWith("/time_travel/restore"))).toBe(true);

    const text = readFileSync(evidencePath, "utf8");
    const evidence = JSON.parse(text) as Record<string, unknown>;
    expect(evidence.target).toBe("cephlow-staging");
    expect(evidence.verification).toEqual(result.verification);
    expect(typeof evidence.startedAt).toBe("string");
    expect(evidence.provenance).toMatchObject({ generator: "scripts/restore-drill.ts", inputKind: "measured" });
    expect(text).not.toContain(uuid);
    expect(text).not.toContain(ACCOUNT);
    expect(text).not.toMatch(/bm_\d+/);
    expect(text).not.toContain("workers.dev");
  });

  test("refuses a database whose live name is not --expect-name, before any write", async () => {
    const { fake, client, uuid } = seedStaging("other-app-staging");
    await expect(
      runTargetRestoreDrill({ client, targetDb: uuid, expectName: "cephlow-app-staging", writeEvidenceFile: false, log: () => {} }),
    ).rejects.toThrow(/REFUSED.*not 'cephlow-app-staging'/);
    expect(writes(fake)).toHaveLength(0);
  });

  test("refuses an --expect-name that does not end in -staging, before any call", async () => {
    const { fake, client, uuid } = seedStaging("cephlow-app-production");
    await expect(
      runTargetRestoreDrill({ client, targetDb: uuid, expectName: "cephlow-app-production", writeEvidenceFile: false, log: () => {} }),
    ).rejects.toThrow(/REFUSED.*-staging/);
    expect(fake.requests).toHaveLength(0);
  });

  test("refuses a missing --env-file, and one inside the repository", () => {
    const uuid = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
    expect(() => assertTargetGuards({ targetDb: uuid, expectName: "x-staging" })).toThrow(/--env-file is required/);
    expect(() => assertTargetGuards({ targetDb: uuid, expectName: "x-staging", envFile: ".env" })).toThrow(/outside the repository/);
    expect(() => assertTargetGuards({ targetDb: "not-a-uuid", expectName: "x-staging", envFile: "/elsewhere/.env" })).toThrow(/uuid/);
  });

  test("CLI flags: any target flag needs all three; --fake cannot be combined; no flags keeps scratch mode", () => {
    expect(parseRestoreDrillArgs(["--fake"])).toEqual({ mode: "fake" });
    expect(parseRestoreDrillArgs(["--live"])).toEqual({ mode: "live" });
    expect(() => parseRestoreDrillArgs(["--target-db", "u", "--expect-name", "x-staging"])).toThrow(/needs --target-db/);
    expect(() => parseRestoreDrillArgs(["--target-db", "u", "--expect-name", "x-staging", "--env-file", "/e", "--fake"])).toThrow(/--fake/);
    expect(parseRestoreDrillArgs(["--target-db", "u", "--expect-name", "x-staging", "--env-file", "/e"])).toEqual({
      mode: "live",
      target: { targetDb: "u", expectName: "x-staging", envFile: "/e" },
    });
  });

  test("CLI flags: unknown arguments and --flag=value forms are refused, so a mistyped target never runs the scratch drill", () => {
    const uuid = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
    expect(() => parseRestoreDrillArgs([`--target-db=${uuid}`, "--expect-name=x-staging", "--env-file=/e"])).toThrow(/REFUSED.*two arguments/);
    expect(() => parseRestoreDrillArgs(["--target-db", uuid, "--expect-name=x-staging", "--env-file", "/e"])).toThrow(/REFUSED/);
    expect(() => parseRestoreDrillArgs(["--live", "--target", uuid])).toThrow(/REFUSED: unknown argument '--target'/);
    expect(() => parseRestoreDrillArgs(["stray"])).toThrow(/unknown argument/);
    expect(() => parseRestoreDrillArgs(["--live", "--live"])).toThrow(/twice/);
    expect(() => parseRestoreDrillArgs(["--fake", "--live"])).toThrow(/cannot be combined/);
  });

  test("the CLI exits non-zero on a --flag=value target flag instead of running the scratch drill", () => {
    const script = fileURLToPath(new URL("../restore-drill.ts", import.meta.url));
    const run = spawnSync(process.execPath, [script, "--target-db=6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f", "--expect-name=x-staging"], { encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/refused/i);
    expect(run.stdout).not.toMatch(/passed/);
  });

  test("a failure after the bookmark restores to it, drops the canary, writes no evidence and rethrows", async () => {
    const { fake, client, uuid, name } = seedStaging();
    const dir = mkdtempSync(join(tmpdir(), "drill-evidence-"));
    const evidencePath = join(dir, "restore-drill.json");
    await expect(
      runTargetRestoreDrill({ client, targetDb: uuid, expectName: name, evidencePath, log: () => {}, _failAtStep: "restore" }),
    ).rejects.toThrow(/simulated failure at restore/);
    const db = fake.state().databases.find((d) => d.name === name)!;
    expect(db.tables).not.toContain(CANARY_TABLE);
    expect(fake.rows(name, "SELECT COUNT(*) AS n FROM users")).toEqual([{ n: 2 }]);
    expect(fake.requests.filter((r) => r.path.endsWith("/time_travel/restore"))).toHaveLength(1);
    expect(existsSync(evidencePath)).toBe(false);
  });

  test("refuses to run over a leftover canary table", async () => {
    const { fake, client, uuid, name } = seedStaging();
    fake.exec(name, `CREATE TABLE ${CANARY_TABLE} (id TEXT)`);
    await expect(
      runTargetRestoreDrill({ client, targetDb: uuid, expectName: name, writeEvidenceFile: false, log: () => {} }),
    ).rejects.toThrow(/REFUSED.*already exists/);
    expect(fake.requests.filter((r) => r.method === "POST" && !r.path.endsWith("/query"))).toHaveLength(0);
  });
});
