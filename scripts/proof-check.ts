// Verifies evidence/verdicts.json and PROOF.md by re-running offline verification into a temp dir,
// checking inputsHash against current source/test/catalog inputs, comparing PROOF.md against generate-proof.ts,
// checking the README's generated "What works today" section (readme:check) and checking that no stored live result in
// evidence/deployed changed without a new run (evidence/deployed/integrity.json).
//
// Usage: node scripts/proof-check.ts [--root <dir>]
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHypotheses } from "../packages/harness/src/index.ts";
import { renderProofMarkdown, resolveBlueprintIdentity } from "./generate-proof.ts";
import { checkReadme } from "./generate-readme.ts";
import { checkLiveIntegrity } from "./lib/live-evidence.ts";
import type { VerdictsFile } from "./poc-verdict.ts";
import { TIMED_OFFLINE_HYPOTHESES, computeInputsHash, findModifiedInputFiles } from "./proof-inputs.ts";

const repoRoot = resolve(import.meta.dirname, "..");

export function runProofCheckCli(argv: string[] = process.argv.slice(2)): number {
  let targetRoot = repoRoot;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root" && argv[i + 1]) {
      targetRoot = resolve(argv[i + 1]!);
      i += 1;
    }
  }

  const proofPath = join(targetRoot, "PROOF.md");
  const verdictsPath = join(targetRoot, "evidence", "verdicts.json");
  const hypothesesPath = existsSync(join(targetRoot, "hypotheses.json"))
    ? join(targetRoot, "hypotheses.json")
    : join(repoRoot, "hypotheses.json");

  if (!existsSync(proofPath)) {
    console.error(`PROOF.md does not exist at ${proofPath}`);
    return 2;
  }

  if (!existsSync(verdictsPath)) {
    console.error(`evidence/verdicts.json does not exist at ${verdictsPath}: run pnpm poc:verify first`);
    return 2;
  }

  const proofText = readFileSync(proofPath, "utf8").replace(/\r\n/g, "\n");
  const committedData = JSON.parse(readFileSync(verdictsPath, "utf8")) as VerdictsFile;
  const hypotheses = parseHypotheses(JSON.parse(readFileSync(hypothesesPath, "utf8"))).hypotheses;

  const errors: string[] = [];

  // (c) Verify committed inputsHash matches current inputs
  const { inputsHash: currentInputsHash } = computeInputsHash(targetRoot, repoRoot);
  if (!committedData.inputsHash) {
    errors.push("evidence/verdicts.json is missing inputsHash");
  } else if (committedData.inputsHash !== currentInputsHash) {
    const modified = findModifiedInputFiles(targetRoot, repoRoot);
    const fileList = modified.length > 0 ? `; modified input files: ${modified.join(", ")}` : "";
    errors.push(
      `Stale inputsHash in evidence/verdicts.json: committed ${committedData.inputsHash} !== current ${currentInputsHash}${fileList}`,
    );
  }

  // (a) Re-run verify.ts for offline hypotheses into a temporary directory (--out <dir>, never overwriting evidence/)
  const tempOutDir = mkdtempSync(join(tmpdir(), "proof-check-verify-"));
  let freshData: VerdictsFile | undefined;
  try {
    const verifyScript = join(repoRoot, "scripts", "verify.ts");
    const run = spawnSync(process.execPath, [verifyScript, "--out", tempOutDir, "--offline"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const freshVerdictsPath = join(tempOutDir, "verdicts.json");
    if (!existsSync(freshVerdictsPath)) {
      errors.push(
        `verify.ts --out ${tempOutDir} failed to produce verdicts.json (exit ${run.status ?? "unknown"}): ${run.stderr || run.stdout}`,
      );
    } else {
      freshData = JSON.parse(readFileSync(freshVerdictsPath, "utf8")) as VerdictsFile;
    }
  } finally {
    rmSync(tempOutDir, { recursive: true, force: true });
  }

  // (b) Compare committed verdicts.json against fresh re-measurement
  if (freshData) {
    for (const h of hypotheses) {
      const committed = committedData.verdicts[h.id];
      const fresh = freshData.verdicts[h.id];
      if (!committed) {
        errors.push(`Missing verdict in evidence/verdicts.json for ${h.id}`);
        continue;
      }
      if (committed.stale === true) {
        errors.push(`Stale verdict entry in evidence/verdicts.json for ${h.id}`);
      }
      if (!fresh) {
        errors.push(`Re-measurement did not produce a verdict for ${h.id}`);
        continue;
      }
      if (committed.verdict !== fresh.verdict) {
        errors.push(
          `Verdict mismatch for ${h.id} in evidence/verdicts.json: committed "${committed.verdict}" !== re-measured "${fresh.verdict}"`,
        );
      }
      if (!TIMED_OFFLINE_HYPOTHESES.has(h.id)) {
        if (committed.measured !== fresh.measured) {
          errors.push(
            `Measured value mismatch for ${h.id} in evidence/verdicts.json: committed "${committed.measured}" !== re-measured "${fresh.measured}"`,
          );
        }
      } else {
        const expectedUnit = h.status === "live" && h.metric ? h.metric.unit : "";
        const num = Number.parseFloat(committed.measured);
        if (!Number.isFinite(num) || (expectedUnit && !committed.measured.endsWith(` ${expectedUnit}`))) {
          errors.push(
            `Invalid measured value for ${h.id} in evidence/verdicts.json: "${committed.measured}"`,
          );
        }
      }
    }
  }

  // (d) Verify PROOF.md matches proof:generate output
  try {
    const identity = resolveBlueprintIdentity(targetRoot, repoRoot);
    const expectedProof = renderProofMarkdown(committedData, hypotheses, identity).replace(/\r\n/g, "\n");
    if (proofText !== expectedProof) {
      errors.push("PROOF.md differs from proof:generate output (run pnpm proof:generate)");
    }
  } catch (err) {
    errors.push(`Failed to render expected PROOF.md from evidence/verdicts.json: ${(err as Error).message}`);
  }

  // Also check each hypothesis row in PROOF.md so any row-level tamper is named explicitly
  for (const h of hypotheses) {
    const v = committedData.verdicts[h.id];
    if (!v) continue;
    const escapedId = h.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedMeasured = v.measured.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\|\\s*${escapedId}\\s*\\|\\s*${v.verdict}\\s*\\|\\s*${escapedMeasured}\\s*\\|`, "i");
    if (!pattern.test(proofText)) {
      errors.push(
        `PROOF.md does not match verdicts.json for ${h.id}: expected "| ${h.id} | ${v.verdict} | ${v.measured} | ..."`,
      );
    }
  }

  // (e) Live evidence integrity: a stored live result must not change without a new run
  errors.push(...checkLiveIntegrity(targetRoot));

  // (f) README "What works today" section must match what the evidence generates (readme:check)
  errors.push(...checkReadme(targetRoot, repoRoot));

  if (errors.length > 0) {
    console.error("proof:check FAILED with errors:");
    for (const err of errors) console.error(`  - ${err}`);
    return 1;
  }

  console.log(
    `proof:check passed: offline hypotheses re-measured, inputsHash (${currentInputsHash.slice(0, 12)}...) verified, PROOF.md matches proof:generate, live evidence matches integrity.json, and the README section matches the evidence.`,
  );
  return 0;
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  process.exit(runProofCheckCli());
}
