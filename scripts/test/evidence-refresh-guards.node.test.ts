import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FINALIZE_STEPS, isRefreshable, planRefresh, stampStaged } from "../lib/refresh-evidence-core.ts";
import { h9BreakdownPath, readRawResults } from "../lib/run-results.ts";

// UC0.7 rework (review round 1): guards for evidence:refresh, verify.ts and the simulated-evidence guard.

const made: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "uc07-guards-"));
  made.push(d);
  return d;
}
function put(root: string, rel: string, body: unknown): string {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n");
  return p;
}
afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

const baseProv = {
  generatedAt: "2031-01-02T03:04:05.000Z",
  gitSha: "a".repeat(40),
  gitDirty: false,
  generator: "scripts/refresh-evidence.ts",
  inputKind: "measured" as const,
};

describe("refresh: quarantine files keep their original provenance (finding 2)", () => {
  it("stampStaged never rewrites or copies anything under quarantine/", () => {
    const root = tmp();
    const quarantine = {
      note: "hardcoded simulated values",
      provenance: {
        generatedAt: "2026-11-02T18:08:33.247Z",
        gitSha: "cb0f935d11bc21323119a20883fd8af5f96feef1",
        gitDirty: false,
        generator: "scripts/beta-readiness.ts",
        inputKind: "simulated",
        quarantined: true,
        quarantinedAt: "2026-11-02T18:08:33.247Z",
      },
    };
    const tracked = put(root, "evidence/quarantine/q.json", quarantine);
    const before = readFileSync(tracked, "utf8");
    // the old refresh copied the tracked quarantine files into staging and then re-stamped them
    put(root, "stage/quarantine/q.json", quarantine);
    put(root, "stage/a.json", { x: 1, provenance: { inputKind: "measured", generator: "g" } });
    put(root, "evidence/a.json", { x: 0, provenance: { inputKind: "measured", generator: "g" } });

    const written = stampStaged({ stagingDir: join(root, "stage"), evidenceDir: join(root, "evidence"), baseProv });

    expect(readFileSync(tracked, "utf8")).toBe(before);
    expect(written.some((p) => p.includes("quarantine"))).toBe(false);
  });

  it("isRefreshable excludes quarantine, deployed, raw results and internal records", () => {
    expect(isRefreshable("brick-tiers.json")).toBe(true);
    expect(isRefreshable("verdicts.json")).toBe(true);
    expect(isRefreshable("quarantine/cp8-beta-readiness.json")).toBe(false);
    expect(isRefreshable("importer-fidelity.json")).toBe(true);
    expect(isRefreshable("importer-fidelity.baseline.json")).toBe(false);
    expect(isRefreshable("deployed/h10-result.json")).toBe(false);
    expect(isRefreshable("raw-results.json")).toBe(false);
    expect(isRefreshable("two-brick.hashes.json")).toBe(false);
    expect(isRefreshable("two-brick.verified.json")).toBe(false);
    expect(isRefreshable("quarantine/README.md")).toBe(false);
  });
});

describe("refresh: a file nobody regenerated is an error, not a fresh stamp (finding 3)", () => {
  it("planRefresh lists tracked evidence that was not produced in this run", () => {
    const root = tmp();
    put(root, "evidence/a.json", { provenance: {} });
    put(root, "evidence/b.json", { provenance: {} });
    put(root, "evidence/quarantine/q.json", { provenance: {} });
    put(root, "evidence/deployed/d.json", {});
    put(root, "stage/a.json", { provenance: {} });
    const plan = planRefresh({ stagingDir: join(root, "stage"), evidenceDir: join(root, "evidence") });
    expect(plan.missing).toEqual(["b.json"]);
    expect(plan.toCopy).toEqual(["a.json"]);
  });

  it("stampStaged stamps regenerated files uniformly and keeps their content", () => {
    const root = tmp();
    put(root, "stage/a.json", { x: 1, provenance: { inputKind: "measured", generator: "g" } });
    put(root, "evidence/a.json", { x: 0, provenance: { inputKind: "measured", generator: "g" } });
    stampStaged({ stagingDir: join(root, "stage"), evidenceDir: join(root, "evidence"), baseProv });
    const out = JSON.parse(readFileSync(join(root, "evidence/a.json"), "utf8"));
    expect(out.x).toBe(1);
    expect(out.provenance.gitSha).toBe(baseProv.gitSha);
    expect(out.provenance.gitDirty).toBe(false);
    expect(out.provenance.generatedAt).toBe(baseProv.generatedAt);
  });
});

describe("refresh: PROOF.md is regenerated and proof:check ends the pass (finding 1)", () => {
  it("FINALIZE_STEPS runs generate-proof, then proof-check, then check-evidence, in that order", () => {
    const names = FINALIZE_STEPS.map((s) => s.replace(/^.*[\\/]/, ""));
    const gen = names.indexOf("generate-proof.ts");
    const proof = names.indexOf("proof-check.ts");
    const ev = names.indexOf("check-evidence.ts");
    expect(gen).toBeGreaterThanOrEqual(0);
    expect(proof).toBeGreaterThan(gen);
    expect(ev).toBeGreaterThan(proof);
  });
});

describe("verify: results must come from the current run, never from tracked files (finding 4)", () => {
  it("readRawResults throws NO_RUN_RESULTS for an empty run dir even when a stale tracked file exists", () => {
    const root = tmp();
    put(root, "evidence/raw-results.json", { stale: true, results: {} });
    mkdirSync(join(root, "run"), { recursive: true });
    expect(() => readRawResults(join(root, "run"))).toThrow(/NO_RUN_RESULTS/);
  });

  it("readRawResults reads the run dir when results exist", () => {
    const root = tmp();
    put(root, "run/raw-results.json", { results: { H1: { measured: 1 } } });
    expect((readRawResults(join(root, "run")) as { results: Record<string, unknown> }).results.H1).toEqual({ measured: 1 });
  });

  it("h9BreakdownPath is undefined when only a tracked h9-session.json exists", () => {
    const root = tmp();
    put(root, "evidence/h9-session.json", { scored: { conversationTokens: 1 } });
    mkdirSync(join(root, "run"), { recursive: true });
    expect(h9BreakdownPath(join(root, "run"))).toBeUndefined();
    put(root, "run/h9-session.json", { scored: {} });
    expect(h9BreakdownPath(join(root, "run"))).toBe(join(root, "run", "h9-session.json"));
  });
});
