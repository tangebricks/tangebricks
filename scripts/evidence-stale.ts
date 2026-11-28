// Prints whether the committed evidence is stale: `stale` when evidence/verdicts.json's inputsHash no longer matches the
// current proof inputs (the same comparison proof-check makes, without re-running anything), else `fresh`. Always exits
// 0 on either answer, so CI can branch on it; exits 1 only when the committed hash cannot be read.
// With GITHUB_OUTPUT set (GitHub Actions), it also writes `stale=true|false` there.
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { computeInputsHash } from "./proof-inputs.ts";

const repoRoot = resolve(import.meta.dirname, "..");

let committed: string | undefined;
try {
  committed = (JSON.parse(readFileSync(join(repoRoot, "evidence", "verdicts.json"), "utf8")) as { inputsHash?: string }).inputsHash;
} catch (error) {
  console.error(`evidence-stale: cannot read evidence/verdicts.json: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const { inputsHash: current } = computeInputsHash(repoRoot);
const stale = !committed || committed !== current;
console.log(stale ? `stale (committed inputsHash ${committed ?? "missing"}, current ${current})` : "fresh");
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `stale=${stale}\n`);
