import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPrePublicCommit, validateEvidenceFiles } from "../check-evidence.ts";

const SHA = "eefa726944d945c25bb4606ad38c51744d8ce2cf";

function rootWithList(commits: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), "pre-public-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts/pre-public-commits.json"), JSON.stringify({ commits }));
  return root;
}

describe("pre-public commit allowlist", () => {
  it("accepts a listed SHA only for the file it is listed for", () => {
    const root = rootWithList({ [SHA]: ["evidence/importer-fidelity.baseline.json"] });
    expect(isPrePublicCommit(SHA, "evidence/importer-fidelity.baseline.json", root)).toBe(true);
    expect(isPrePublicCommit(SHA.toUpperCase(), "evidence/importer-fidelity.baseline.json", root)).toBe(true);
    expect(isPrePublicCommit(SHA, "evidence/verdicts.json", root)).toBe(false);
    expect(isPrePublicCommit("cb0f935d11bc21323119a20883fd8af5f96feef1", "evidence/importer-fidelity.baseline.json", root)).toBe(false);
  });

  it("accepts nothing when the list is missing or malformed", () => {
    const empty = mkdtempSync(join(tmpdir(), "pre-public-"));
    expect(isPrePublicCommit(SHA, "evidence/importer-fidelity.baseline.json", empty)).toBe(false);
    const bad = mkdtempSync(join(tmpdir(), "pre-public-"));
    mkdirSync(join(bad, "scripts"));
    writeFileSync(join(bad, "scripts/pre-public-commits.json"), "{not json");
    expect(isPrePublicCommit(SHA, "evidence/importer-fidelity.baseline.json", bad)).toBe(false);
  });

  it("the committed evidence passes evidence:check", () => {
    expect(validateEvidenceFiles()).toEqual([]);
  });
});
