// Story 0.12 (R54): the README's "What works today" section is generated from evidence, live evidence carries its run
// date and a stale label, stored live results cannot change without a new run, and release:check guards releases.
// The proof:check end-to-end tamper case lives in proof-check.tamper.node.test.ts (it re-runs verify.ts).
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkReadme, extractWhatWorks, loadReadmeInputs, renderWhatWorks } from "../generate-readme.ts";
import {
  INTEGRITY_REL,
  checkLiveIntegrity,
  KNOWN_HAND_EDITS,
  isStale,
  latestReleaseFromChangelog,
  loadLiveRuns,
  readIntegrity,
  readLatestRelease,
  recordLiveIntegrity,
} from "../lib/live-evidence.ts";
import { findUnlabelledLiveEvidence } from "../release-check.ts";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const generateReadmeScript = resolve(repoRoot, "scripts/generate-readme.ts");
const readme = () => readFileSync(join(repoRoot, "README.md"), "utf8").replace(/\r\n/g, "\n");

const temps: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "readme-evidence-"));
  temps.push(root);
  cpSync(join(repoRoot, "evidence"), join(root, "evidence"), { recursive: true });
  cpSync(join(repoRoot, "hypotheses.json"), join(root, "hypotheses.json"));
  cpSync(join(repoRoot, "README.md"), join(root, "README.md"));
  return root;
}
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe("README generated section (readme:check)", () => {
  it("README_IN_SYNC: the committed README equals the generated section", () => {
    expect(checkReadme(repoRoot)).toEqual([]);
  });

  it("README numbers match verdicts.json", () => {
    const section = extractWhatWorks(readme())!;
    const verdicts = JSON.parse(readFileSync(join(repoRoot, "evidence/verdicts.json"), "utf8")) as {
      verdicts: Record<string, { verdict: string; measured: string }>;
    };
    for (const [id, v] of Object.entries(verdicts.verdicts)) {
      expect(section).toContain(`| ${id} |`);
      const row = section.split("\n").find((l) => l.startsWith(`| ${id} |`))!;
      expect(row).toContain(`| ${v.verdict} | ${v.measured} |`);
    }
  });

  it("README_DRIFT: a hand-edited number in the section fails readme:check and names the section", () => {
    const root = tempRoot();
    const p = join(root, "README.md");
    const text = readFileSync(p, "utf8");
    const tampered = text.replace(/(\d+) cases over/, (_m, n: string) => `${Number(n) + 1} cases over`);
    expect(tampered).not.toBe(text);
    writeFileSync(p, tampered, "utf8");
    const errors = checkReadme(root, repoRoot);
    expect(errors.join("\n")).toContain("What works today");

    const res = spawnSync(process.execPath, [generateReadmeScript, "--check", "--root", root], { cwd: repoRoot, encoding: "utf8" });
    expect(res.status).toBe(1);
    expect(`${res.stdout}\n${res.stderr}`).toContain("What works today");
  });

  it("VERDICT_CHANGE: verdicts.json changes and the README is not regenerated, so the check fails", () => {
    const root = tempRoot();
    const vp = join(root, "evidence/verdicts.json");
    const data = JSON.parse(readFileSync(vp, "utf8"));
    data.verdicts.H1.measured = "119 lines";
    writeFileSync(vp, JSON.stringify(data, null, 2), "utf8");
    expect(checkReadme(root, repoRoot).length).toBeGreaterThan(0);
  });

  it("H12_NOTE: the H12 row carries the hand-edit note", () => {
    const row = extractWhatWorks(readme())!.split("\n").find((l) => l.startsWith("| H12 |") && l.includes("hand-edited"));
    expect(row).toBeDefined();
    expect(row).toContain("result file edited by hand on 2026-10-28 (commit 8f83415) without a re-run");
  });

  it("lists every quarantined brick from brick-tiers.json", () => {
    const tiers = JSON.parse(readFileSync(join(repoRoot, "evidence/brick-tiers.json"), "utf8")) as {
      bricks: Array<{ id: string; reason?: string }>;
    };
    const quarantined = tiers.bricks.filter((b) => (b.reason ?? "").startsWith("QUARANTINED")).map((b) => b.id);
    expect(quarantined.length).toBeGreaterThan(0);
    const section = extractWhatWorks(readme())!;
    for (const id of quarantined) expect(section).toContain(`- \`${id}\`:`);
  });

  it("WRONG_CLAIMS: none of the seven recon §4 claims remains in the README", () => {
    const text = readme();
    const banned: RegExp[] = [
      /\b107[- ]lines?\b/i, // validator line count (actual 114)
      /14\.1\s*%/, // H9 ratio
      /[≤<]\s*40\s*%|\\le\$?\s*40\s*%/, // H9 pass threshold stated as 40%
      /\b4 (deterministic |MCP )?(MCP )?tools\b/i, // "4 MCP tools"
      /double-entry/i, // the ledger is single-entry
      /default (payment )?gateway is a fake/i, // since 0.9 there is no default gateway (503 NOT_CONFIGURED)
      /packages\/credit-wallet/, // the wallet lives in bricks/
      /843\.5\s*KiB/i, // the MCP Worker bundle, not the project
      /thresholds?[^.\n]*before[^.\n]*(code|implemented)/i, // "thresholds before code" is false for H0–H3
    ];
    for (const pattern of banned) expect(pattern.test(text), `README still matches ${pattern}`).toBe(false);
  });

  it("names the project Tangebricks, links SECURITY.md, CONTRIBUTING.md and the threat model, and states pre-1.0 status", () => {
    const text = readme();
    expect(text).toMatch(/^# Tangebricks/m);
    expect(text).toContain("](SECURITY.md)");
    expect(text).toContain("](CONTRIBUTING.md)");
    expect(text).toContain("](docs/threat-model.md)");
    expect(text).toMatch(/pre-1\.0/);
    expect(text).toMatch(/not production-ready/i);
    expect(text).toMatch(/Apache-2\.0/);
  });
});

describe("live evidence staleness (STALE_LABEL)", () => {
  const run = "2026-10-21T03:23:00.872Z";

  it("is stale when the run started before the newest released version's date, current otherwise", () => {
    expect(isStale(run, "2026-11-21")).toBe(true);
    expect(isStale(run, "2026-10-21")).toBe(false);
    expect(isStale(run, undefined)).toBe(false);
    expect(isStale(undefined, undefined)).toBe(true);
  });

  it("reads the reference release from CHANGELOG.md (newest dated version, Unreleased skipped)", () => {
    const text = ["## [Unreleased]", "", "## [0.3.0] - 2026-12-05", "", "## [0.1.0] - 2026-11-21", ""].join("\n");
    expect(latestReleaseFromChangelog(text)).toEqual({ version: "0.3.0", date: "2026-12-05" });
    expect(latestReleaseFromChangelog("## [Unreleased]\n")).toBeUndefined();
    expect(readLatestRelease(repoRoot, repoRoot)).toEqual({ version: "0.3.0", date: "2026-11-24" });
  });

  it("the generated section depends on committed files only: same inputs, same output", () => {
    expect(renderWhatWorks(loadReadmeInputs(repoRoot))).toBe(renderWhatWorks(loadReadmeInputs(repoRoot)));
  });

  it("the README shows 'stale (run YYYY-MM-DD)' for stale runs and 'current' for fresh ones", () => {
    const inputs = loadReadmeInputs(repoRoot);
    const stale = renderWhatWorks({ ...inputs, release: { version: "0.1.0", date: "2026-11-21" } });
    expect(stale).toContain("| H10 | H10, whole hypothesis | 2026-10-21T03:23:00.872Z | **stale (run 2026-10-21)** |");
    const fresh = renderWhatWorks({ ...inputs, release: { version: "0.0.1", date: "2026-10-01" } });
    expect(fresh).toContain("| H10 | H10, whole hypothesis | 2026-10-21T03:23:00.872Z | current (run 2026-10-21) |");
    expect(fresh).not.toContain("stale (run");
  });
});

describe("live evidence integrity (evidence/deployed/integrity.json)", () => {
  it("passes on the committed evidence, with H12 recorded as hand-edited, unverified", () => {
    expect(checkLiveIntegrity(repoRoot)).toEqual([]);
    const h12 = readIntegrity(repoRoot)!.files["evidence/deployed/h12-result.json"]!;
    expect(h12.status).toBe("hand-edited, unverified");
  });

  it("LIVE_TAMPER: a changed byte with the same run timestamp fails, naming the file", () => {
    const root = tempRoot();
    const p = join(root, "evidence/deployed/h10-result.json");
    writeFileSync(p, readFileSync(p, "utf8").replace('"secondsToCorrectAnswer": 16.695', '"secondsToCorrectAnswer": 16.694'), "utf8");
    const errors = checkLiveIntegrity(root);
    expect(errors.some((e) => e.includes("LIVE_TAMPER") && e.includes("evidence/deployed/h10-result.json"))).toBe(true);
    // record-live refuses to record an edit as a run, and writes nothing
    const before = readFileSync(join(root, INTEGRITY_REL), "utf8");
    const rec = recordLiveIntegrity(root);
    expect(rec.ok).toBe(false);
    expect(readFileSync(join(root, INTEGRITY_REL), "utf8")).toBe(before);
  });

  it("LIVE_RERUN: a new result with a new timestamp fails until recorded with evidence:record-live, then passes", () => {
    const root = tempRoot();
    const p = join(root, "evidence/deployed/h11-result.json");
    const data = JSON.parse(readFileSync(p, "utf8"));
    data.commandStartedAt = "2026-11-22T10:00:00.000Z";
    data.finishedAt = "2026-11-22T10:01:00.000Z";
    writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    expect(checkLiveIntegrity(root).join("\n")).toContain("LIVE_UNRECORDED_RUN");

    const res = spawnSync(process.execPath, [resolve(repoRoot, "scripts/record-live-evidence.ts"), "--root", root], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(res.status, res.stderr).toBe(0);
    expect(checkLiveIntegrity(root)).toEqual([]);
    const entry = readIntegrity(root)!.files["evidence/deployed/h11-result.json"]!;
    expect(entry.runTimestamp).toBe("2026-11-22T10:00:00.000Z");
    expect(entry.status).toBe("recorded");
  });

  it("INTEGRITY_UNREADABLE: a malformed integrity.json is reported, not thrown, and record-live refuses it", () => {
    const root = tempRoot();
    writeFileSync(join(root, INTEGRITY_REL), "{ not json", "utf8");
    const errors = checkLiveIntegrity(root);
    expect(errors.some((e) => e.startsWith("INTEGRITY_UNREADABLE"))).toBe(true);
    expect(recordLiveIntegrity(root).ok).toBe(false);
    // the README check does not crash either; it reports the section as out of date
    expect(() => checkReadme(root, repoRoot)).not.toThrow();
  });

  it("LIVE_LABEL_CHANGED: dropping H12's pinned hand-edit status or note fails", () => {
    expect(KNOWN_HAND_EDITS["evidence/deployed/h12-result.json"]?.note).toBe(
      "result file edited by hand on 2026-10-28 (commit 8f83415) without a re-run",
    );
    for (const mutate of [
      (e: Record<string, unknown>) => {
        e.status = "recorded";
      },
      (e: Record<string, unknown>) => {
        delete e.note;
      },
    ]) {
      const root = tempRoot();
      const p = join(root, INTEGRITY_REL);
      const data = JSON.parse(readFileSync(p, "utf8"));
      mutate(data.files["evidence/deployed/h12-result.json"]);
      writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
      const errors = checkLiveIntegrity(root);
      expect(errors.some((e) => e.includes("LIVE_LABEL_CHANGED") && e.includes("evidence/deployed/h12-result.json"))).toBe(true);
    }
  });

  it("UNTRACKED_LIVE: a live result file with no integrity entry fails", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "evidence/deployed/h13-result.json"),
      `${JSON.stringify({ schema: 1, commandStartedAt: "2026-11-22T00:00:00.000Z" }, null, 2)}\n`,
      "utf8",
    );
    const errors = checkLiveIntegrity(root);
    expect(errors.some((e) => e.includes("UNTRACKED_LIVE") && e.includes("evidence/deployed/h13-result.json"))).toBe(true);
  });
});

describe("release:check", () => {
  it("passes on the committed README for a release cut after the live runs (all labelled stale)", () => {
    const problems = findUnlabelledLiveEvidence(readme(), loadLiveRuns(repoRoot), "2026-11-21T00:00:00Z");
    expect(problems).toEqual([]);
  });

  it("fails when live evidence predates the release commit and is not labelled stale", () => {
    const unlabelled = readme().replace(/\*\*stale \(run (\d{4}-\d{2}-\d{2})\)\*\*/g, "current (run $1)");
    const problems = findUnlabelledLiveEvidence(unlabelled, loadLiveRuns(repoRoot), "2026-11-21T00:00:00Z");
    expect(problems.length).toBe(5);
    expect(problems.join("\n")).toContain("H12");
  });

  it("looks only at the Live evidence table: removing the label there fails even though the hypotheses table keeps it", () => {
    const text = readme();
    const liveRow = text.split("\n").find((l) => l.startsWith("| H12 | H12, whole hypothesis |"))!;
    expect(liveRow).toContain("stale (run 2026-10-21)");
    const unlabelled = text.replace(liveRow, liveRow.replace("**stale (run 2026-10-21)**", "current (run 2026-10-21)"));
    const hypRow = unlabelled.split("\n").find((l) => l.startsWith("| H12 | A brick"))!;
    expect(hypRow).toContain("stale (run 2026-10-21)");
    const problems = findUnlabelledLiveEvidence(unlabelled, loadLiveRuns(repoRoot), "2026-11-21T00:00:00Z");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("H12");
  });

  it("ignores live runs newer than the release commit", () => {
    const unlabelled = readme().replace(/\*\*stale \(run (\d{4}-\d{2}-\d{2})\)\*\*/g, "current (run $1)");
    expect(findUnlabelledLiveEvidence(unlabelled, loadLiveRuns(repoRoot), "2026-10-01T00:00:00Z")).toEqual([]);
  });

  it("the CLI passes at HEAD", () => {
    const res = spawnSync(process.execPath, [resolve(repoRoot, "scripts/release-check.ts")], { cwd: repoRoot, encoding: "utf8" });
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
  });
});
