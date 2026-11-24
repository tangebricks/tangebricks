#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const evidenceDir = resolve(repoRoot, "evidence");

export interface EvidenceValidationFailure {
  file: string;
  reason: string;
}

const PRE_PUBLIC_COMMITS_REL = "scripts/pre-public-commits.json";

/**
 * Frozen evidence may cite a commit from the private history that preceded the
 * public import, but only when scripts/pre-public-commits.json lists that exact
 * SHA for that exact file. Anything else must cite a commit in this repository.
 */
export function isPrePublicCommit(sha: string, rel: string, root: string = repoRoot): boolean {
  const listPath = join(root, PRE_PUBLIC_COMMITS_REL);
  if (!existsSync(listPath)) return false;
  try {
    const list = JSON.parse(readFileSync(listPath, "utf8"));
    const files = list?.commits?.[sha.toLowerCase()];
    return Array.isArray(files) && files.includes(rel);
  } catch {
    return false;
  }
}

export function getAllEvidenceJsonFiles(dir: string, root: string = dir): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const rel = relative(root, fullPath).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (rel === "deployed" || rel.startsWith("deployed/")) {
        continue;
      }
      results.push(...getAllEvidenceJsonFiles(fullPath, root));
    } else if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith(".tmp")) {
      results.push(fullPath);
    }
  }
  return results;
}

export function validateEvidenceFiles(dir: string = evidenceDir): EvidenceValidationFailure[] {
  const failures: EvidenceValidationFailure[] = [];

  const cp8Top = join(dir, "cp8-beta-readiness.json");
  if (existsSync(cp8Top)) {
    try {
      const parsed = JSON.parse(readFileSync(cp8Top, "utf8"));
      if (parsed?.provenance?.inputKind === "simulated") {
        failures.push({
          file: "evidence/cp8-beta-readiness.json",
          reason: "Simulated cp8 evidence must not exist at top level (must be quarantined)",
        });
      }
    } catch {}
  }

  const cp9Top = join(dir, "cp9-sandbox-verification.json");
  if (existsSync(cp9Top)) {
    try {
      const parsed = JSON.parse(readFileSync(cp9Top, "utf8"));
      if (parsed?.provenance?.inputKind === "simulated") {
        failures.push({
          file: "evidence/cp9-sandbox-verification.json",
          reason: "Simulated cp9 evidence must not exist at top level (must be quarantined)",
        });
      }
    } catch {}
  }

  const files = getAllEvidenceJsonFiles(dir);
  for (const file of files) {
    const rel = relative(repoRoot, file).replace(/\\/g, "/");
    let content: any;
    try {
      content = JSON.parse(readFileSync(file, "utf8"));
    } catch (err: any) {
      failures.push({ file: rel, reason: `Failed to parse JSON: ${err.message}` });
      continue;
    }

    if (!content || typeof content !== "object" || Array.isArray(content)) {
      failures.push({ file: rel, reason: "Evidence root must be a JSON object" });
      continue;
    }

    if (content.generatedAt === "2026-11-01T00:00:00.000Z") {
      failures.push({ file: rel, reason: "Top-level generatedAt is hardcoded 2026-11-01T00:00:00.000Z" });
    }

    const prov = content.provenance;
    if (!prov || typeof prov !== "object" || Array.isArray(prov)) {
      failures.push({ file: rel, reason: "Missing provenance object" });
      continue;
    }

    if (typeof prov.generatedAt !== "string" || !prov.generatedAt) {
      failures.push({ file: rel, reason: "Missing or invalid provenance.generatedAt" });
    } else if (prov.generatedAt === "2026-11-01T00:00:00.000Z") {
      failures.push({ file: rel, reason: "provenance.generatedAt equals hardcoded 2026-11-01T00:00:00.000Z" });
    } else if (isNaN(Date.parse(prov.generatedAt))) {
      failures.push({ file: rel, reason: `provenance.generatedAt is not a valid ISO date: ${prov.generatedAt}` });
    }

    if (typeof prov.gitSha !== "string" || !/^[0-9a-f]{40}$/i.test(prov.gitSha)) {
      failures.push({ file: rel, reason: `provenance.gitSha is not 40 hex chars: ${prov.gitSha}` });
    } else if (/^0{40}$/.test(prov.gitSha)) {
      failures.push({ file: rel, reason: `provenance.gitSha must not be all-zero SHA: ${prov.gitSha}` });
    } else {
      const catRes = spawnSync("git", ["cat-file", "-e", `${prov.gitSha}^{commit}`], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (catRes.status !== 0 && !isPrePublicCommit(prov.gitSha, rel)) {
        failures.push({
          file: rel,
          reason: `provenance.gitSha is not an existing commit in repository: ${prov.gitSha}`,
        });
      }
    }

    if (typeof prov.gitDirty !== "boolean") {
      failures.push({ file: rel, reason: `provenance.gitDirty is not boolean: ${prov.gitDirty}` });
    }

    if (typeof prov.generator !== "string" || !prov.generator) {
      failures.push({ file: rel, reason: "Missing or empty provenance.generator" });
    }

    if (prov.inputKind !== "measured" && prov.inputKind !== "simulated") {
      failures.push({ file: rel, reason: `Invalid provenance.inputKind: ${prov.inputKind} (must be 'measured' or 'simulated')` });
    }

    if (rel.startsWith("evidence/quarantine/") && prov.quarantined !== true) {
      failures.push({ file: rel, reason: "Quarantined evidence must carry provenance.quarantined === true" });
    }
  }

  return failures;
}

export function runCheckEvidenceCli(): number {
  // EVIDENCE_CHECK_DIR lets tests check a temporary folder instead of writing fixtures into the tracked evidence/ folder.
  const dir = process.env.EVIDENCE_CHECK_DIR ? resolve(process.env.EVIDENCE_CHECK_DIR) : evidenceDir;
  const failures = validateEvidenceFiles(dir);
  if (failures.length > 0) {
    console.error(`[check-evidence] FAIL: ${failures.length} evidence issue(s) found:\n`);
    for (const f of failures) {
      console.error(`  - ${f.file}: ${f.reason}`);
    }
    return 1;
  }

  const files = getAllEvidenceJsonFiles(dir);
  console.log(`[check-evidence] PASS: All ${files.length} evidence files have valid provenance.`);
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]).toLowerCase() ===
    resolve(fileURLToPath(import.meta.url)).toLowerCase()
) {
  const code = runCheckEvidenceCli();
  process.exit(code);
}
