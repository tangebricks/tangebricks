// The wallet's money invariant on Cloudflare's hosted D1 (epic 5, story 8): H5's extra evidence, holdsOnHostedD1. The rule it applies is
// in hypotheses.json (H5's note) and was committed before this file existed. Run with the credentials loaded by Node from the env file
// and the state folder named, after scripts/poc-deploy.ts:
//
//   node "--env-file=C:\cephlow minimalist version\env\.env" scripts/poc-h5-hosted.ts --state-dir "C:\cephlow minimalist version\env\poc-state"
//
// WRITES TO THE ACCOUNT: twenty scratch workspaces and wallets, a few hundred orders and ledger rows in the proof's own database, over
// about twenty minutes. It uploads nothing and changes no Worker, Workflow or address.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadDeployment } from "../packages/deploy/src/context.ts";
import { canonicalHosted, evaluateHostedH5, runHostedH5 } from "../packages/deploy/src/h5-hosted.ts";
import type { HostedResult } from "../packages/deploy/src/h5-hosted.ts";
import { scanTreesForSecrets } from "../packages/deploy/src/leak-scan.ts";
import { overTheNetwork } from "../packages/deploy/src/network.ts";
import { CredentialsError, createClient, createRedactor, findSecrets } from "../packages/deploy/src/provisioner/index.ts";

const root = resolve(import.meta.dirname, "..");
const planRepo = resolve(root, "..", "ProjectX");
const flag = process.argv.indexOf("--state-dir");
const stateArg = flag >= 0 ? process.argv[flag + 1] : undefined;
if (!stateArg) {
  console.error("--state-dir <folder> is required");
  process.exit(2);
}
const printed: string[] = [];
const out = (line: string) => {
  printed.push(line);
  console.log(line);
};

let deployment;
try {
  deployment = loadDeployment({ root, planRepo, stateDir: stateArg, env: process.env });
} catch (error) {
  console.error(error instanceof CredentialsError || error instanceof Error ? error.message : "could not load the deployment");
  process.exit(2);
}
const { credentials, accessKey } = deployment;
const hide = createRedactor([credentials.token, credentials.accountId, accessKey]);
const runsArg = process.argv.indexOf("--runs");
const runs = runsArg >= 0 ? Number(process.argv[runsArg + 1]) : undefined;

out(`hosted money check against ${deployment.names.script}; no upload will be made`);
const { calls, result: first } = await runHostedH5({
  clock: () => performance.now(),
  commandStart: performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  createClient: (now) => createClient({ credentials, fetch: overTheNetwork, now, alsoHide: [accessKey] }),
  names: deployment.names,
  databaseId: deployment.databaseId,
  url: deployment.url,
  accessKey,
  fetchUrl: overTheNetwork,
  hide,
  nowIso: () => new Date().toISOString(),
  log: out,
  deployedVersionFromH10: deployment.deployedVersionId,
  ...(runs !== undefined ? { runs } : {}),
});

const secrets = { token: credentials.token, accountId: credentials.accountId, accessKey };
const callsText = canonicalHosted(calls);
for (const [name, text] of [["h5-hosted-calls.json", callsText], ["h5-hosted-result.json", JSON.stringify(first, null, 2)]] as const) {
  const hits = findSecrets(text, secrets);
  if (hits.length > 0) {
    console.error(`refusing to write ${name}: it contains ${hits.join(" and ")}`);
    process.exit(4);
  }
}
const dir = join(root, "evidence", "deployed");
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
for (const name of ["h5-hosted-calls.json", "h5-hosted-result.json"]) {
  if (existsSync(join(dir, name))) {
    mkdirSync(join(dir, "attempts"), { recursive: true });
    renameSync(join(dir, name), join(dir, "attempts", `${stamp}-${name}`));
  }
}
writeFileSync(join(dir, "h5-hosted-calls.json"), callsText);
writeFileSync(join(dir, "h5-hosted-result.json"), `${JSON.stringify(first, null, 2)}\n`);
const scan = scanTreesForSecrets([root, ...(existsSync(planRepo) ? [planRepo] : [])], secrets);
const final: HostedResult = { ...first, leakScan: scan };
const finalText = `${JSON.stringify(final, null, 2)}\n`;
const finalHits = findSecrets(finalText + printed.join("\n"), secrets);
if (finalHits.length > 0) {
  console.error(`refusing to write h5-hosted-result.json: it or the console output contains ${finalHits.join(" and ")}`);
  process.exit(4);
}
writeFileSync(join(dir, "h5-hosted-result.json"), finalText);
const attemptsPath = join(dir, "h5-hosted-attempts.json");
const attempts = existsSync(attemptsPath) ? (JSON.parse(readFileSync(attemptsPath, "utf8")) as unknown[]) : [];
attempts.push({ startedAt: calls.commandStartedAt, completed: final.completed, stoppedBecause: final.stoppedBecause ?? null });
writeFileSync(attemptsPath, `${JSON.stringify(attempts, null, 2)}\n`);

const evaluation = evaluateHostedH5({ callsText, result: final });
out("");
out(`holdsOnHostedD1: ${"holdsOnHostedD1" in evaluation.checks ? evaluation.checks.holdsOnHostedD1 : "not reported (inconclusive)"}`);
for (const note of evaluation.notes) out(`  note: ${note}`);
out(`leak scan: ${scan.filesScanned} files in the two repositories, ${scan.found.length === 0 ? "no secret found" : `FOUND: ${scan.found.join("; ")}`}`);
out(`attempt ${attempts.length} recorded; evidence in evidence/deployed/`);
process.exit(final.completed && evaluation.checks.holdsOnHostedD1 === true && scan.found.length === 0 ? 0 : 1);
