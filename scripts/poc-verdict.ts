// Applies the ProjectX hypothesis register's verdict rule to evidence/verdicts.json (epic 5, story 10).
//
// Rules from hypotheses.md:
//   stop:  a kill on any mechanism the idea cannot survive without: H2, H5, H6, H10, H11.
//   pivot: kills only on accelerants: H1, H3, H7, H8, H9, H12 (H4 was retired, see docs/retired-hypotheses.md). Each kill names the claim to drop or shrink.
//   go:    no kills. Fails (between pass and kill) are listed with their gap and do not block go.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeInputsHash, findModifiedInputFiles } from "./proof-inputs.ts";

const repoRoot = resolve(import.meta.dirname, "..");

export interface VerdictEntry {
  verdict: "pass" | "fail" | "kill" | "pending";
  measured: string;
  reasons: string[];
  recordedAt: string;
  stale?: boolean;
}

export interface VerdictsFile {
  inputsHash?: string;
  generatedBy?: string;
  verdicts: Record<string, VerdictEntry>;
}

export const MECHANISM_IDS = ["H0", "H2", "H5", "H6", "H10", "H11"] as const;
export const ACCELERATOR_IDS = ["H1", "H3", "H7", "H8", "H9", "H12"] as const;
export const ALL_HYPOTHESES = [...MECHANISM_IDS, ...ACCELERATOR_IDS] as const;

export interface DecisionResult {
  decision: "go" | "pivot" | "stop";
  mechanismKills: string[];
  acceleratorKills: string[];
  fails: string[];
  passes: string[];
  reasons: string[];
}

export function computeDecision(verdicts: Record<string, VerdictEntry>): DecisionResult {
  const mechanismKills = MECHANISM_IDS.filter((id) => verdicts[id]?.verdict === "kill");
  const acceleratorKills = ACCELERATOR_IDS.filter((id) => verdicts[id]?.verdict === "kill");
  const fails = ALL_HYPOTHESES.filter((id) => verdicts[id]?.verdict === "fail");
  const passes = ALL_HYPOTHESES.filter((id) => verdicts[id]?.verdict === "pass");

  const reasons: string[] = [];
  let decision: "go" | "pivot" | "stop";

  if (mechanismKills.length > 0) {
    decision = "stop";
    reasons.push(`Core mechanism kill on: ${mechanismKills.join(", ")} (the initiative cannot survive without these)`);
  } else if (acceleratorKills.length > 0) {
    decision = "pivot";
    reasons.push(`Kills on accelerants: ${acceleratorKills.join(", ")} (claims to drop or shrink)`);
  } else {
    decision = "go";
    if (fails.length > 0) {
      reasons.push(`Passed with fails on: ${fails.join(", ")} (fails do not block go)`);
    } else {
      reasons.push(`All ${ALL_HYPOTHESES.length} hypotheses passed their threshold checks without kills or fails`);
    }
  }

  return { decision, mechanismKills, acceleratorKills, fails, passes, reasons };
}

export function runPocVerdictCli(argv: string[] = process.argv.slice(2)): number {
  let targetRoot = repoRoot;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root" && argv[i + 1]) {
      targetRoot = resolve(argv[i + 1]!);
      i += 1;
    }
  }

  const verdictsPath = join(targetRoot, "evidence", "verdicts.json");
  if (!existsSync(verdictsPath)) {
    console.error("evidence/verdicts.json does not exist: run pnpm poc:verify first");
    return 2;
  }

  const data = JSON.parse(readFileSync(verdictsPath, "utf8")) as VerdictsFile;
  const { inputsHash: currentInputsHash } = computeInputsHash(targetRoot, repoRoot);

  if (!data.inputsHash) {
    console.error("evidence/verdicts.json is missing inputsHash: run pnpm poc:verify first");
    return 2;
  }

  if (data.inputsHash !== currentInputsHash) {
    const modified = findModifiedInputFiles(targetRoot, repoRoot);
    const detail = modified.length > 0 ? ` (modified files: ${modified.join(", ")})` : "";
    console.error(
      `evidence/verdicts.json has a stale inputsHash (committed ${data.inputsHash}, current ${currentInputsHash})${detail}: run pnpm poc:verify first`,
    );
    return 2;
  }

  const staleIds = ALL_HYPOTHESES.filter((id) => data.verdicts[id]?.stale === true);
  if (staleIds.length > 0) {
    console.error(`evidence/verdicts.json has stale entries (${staleIds.join(", ")}): run pnpm poc:verify first`);
    return 2;
  }

  const missing = ALL_HYPOTHESES.filter((id) => !data.verdicts[id]);
  if (missing.length > 0) {
    console.error(`evidence/verdicts.json is incomplete; missing hypotheses: ${missing.join(", ")}`);
    return 2;
  }

  const pending = ALL_HYPOTHESES.filter((id) => data.verdicts[id]?.verdict === "pending");
  if (pending.length > 0) {
    console.error(`Cannot compute final verdict: hypotheses still pending: ${pending.join(", ")}`);
    return 2;
  }

  const result = computeDecision(data.verdicts);
  console.log("");
  console.log(`========================================`);
  console.log(`  FINAL VERDICT: ${result.decision.toUpperCase()}`);
  console.log(`========================================`);
  for (const reason of result.reasons) {
    console.log(`  - ${reason}`);
  }
  console.log("");
  console.log(
    `Summary: ${result.passes.length}/${ALL_HYPOTHESES.length} pass, ${result.fails.length} fail, ${result.mechanismKills.length + result.acceleratorKills.length} kill`,
  );

  return result.decision === "go" ? 0 : 1;
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  process.exit(runPocVerdictCli());
}
