// H11 on the real account (epic 5, story 6): graphs stored in D1, one Workflow class, an edit changing the next run, with no
// upload. Run after scripts/poc-deploy.ts, with the same env file and state folder:
//
//   node "--env-file=C:\cephlow minimalist version\env\.env" scripts/poc-graphs.ts --state-dir "C:\cephlow minimalist version\env\poc-state"
//
// THIS WRITES TO THE ACCOUNT: graph rows and a scratch row in the proof's own D1 database, and it starts Workflow runs. It
// uploads nothing and changes no Worker, no Workflow definition and no address.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { canonical11, evaluateH11, runH11 } from "../packages/deploy/src/h11.ts";
import type { H11Result } from "../packages/deploy/src/h11.ts";
import { scanTreesForSecrets } from "../packages/deploy/src/leak-scan.ts";
import { CredentialsError, createClient, createRedactor, fileKeyStore, fileStore, findSecrets, loadCredentials, loadOrCreateAccessKey } from "../packages/deploy/src/provisioner/index.ts";

const clock = () => performance.now();
const root = resolve(import.meta.dirname, "..");
const planRepo = resolve(root, "..", "ProjectX");
const printed: string[] = [];
const out = (line: string) => {
  printed.push(line);
  console.log(line);
};

let credentials;
try {
  credentials = loadCredentials(process.env);
} catch (error) {
  if (error instanceof CredentialsError) {
    console.error(error.message);
    process.exit(2);
  }
  throw error;
}
const flag = process.argv.indexOf("--state-dir");
const stateArg = flag >= 0 ? process.argv[flag + 1] : undefined;
if (!stateArg) {
  console.error("--state-dir <folder> is required");
  process.exit(2);
}
const stateDir = resolve(stateArg);
const inside = (child: string, parent: string) => (child + sep).toLowerCase().startsWith((resolve(parent) + sep).toLowerCase());
if (inside(stateDir, root) || inside(stateDir, planRepo)) {
  console.error("the state folder must be outside both repositories: it holds the access key");
  process.exit(2);
}

// ---- what is deployed: from the H10 evidence and the ledger
const dir = join(root, "evidence", "deployed");
const h10Path = join(dir, "h10-calls.json");
if (!existsSync(h10Path)) {
  console.error("evidence/deployed/h10-calls.json is missing: run scripts/poc-deploy.ts first");
  process.exit(2);
}
const h10 = JSON.parse(readFileSync(h10Path, "utf8")) as { facts: { url: string | null; names: { suffix: string; script: string; database: string; workflow: string }; readings: { afterFourth?: { databaseId: string | null; latestVersionId: string | null } } } };
const { url, names } = h10.facts;
const databaseId = h10.facts.readings.afterFourth?.databaseId ?? null;
const ledger = fileStore(join(stateDir, "ledger.json")).read();
if (!url || !databaseId || !ledger || ledger.suffix !== names.suffix || ledger.entries.some((e) => e.status !== "created")) {
  console.error("the H10 evidence, the ledger and the account do not describe one finished deployment: run scripts/poc-deploy.ts again");
  process.exit(2);
}
const accessKey = loadOrCreateAccessKey(fileKeyStore(join(stateDir, "access-key.txt")), () => {
  throw new Error("the access key is missing: this Worker cannot be reached");
});
// Story 1.1: a deployed run starts only from the signed control-plane route, signed with the Worker's PX_TELEMETRY_SECRET
// (distinct from the access key). The Worker must have that secret set; this script reads the same value from the environment.
const signingSecret = process.env.PX_TELEMETRY_SECRET?.trim() ?? "";
if (signingSecret.length < 16 || signingSecret === accessKey) {
  console.error("PX_TELEMETRY_SECRET is not set (16+ characters, not the access key): runs can only be started with a signed request since story 1.1");
  process.exit(2);
}
const hide = createRedactor([credentials.token, credentials.accountId, accessKey, signingSecret]);

out(`H11 against ${names.script}; no upload will be made`);
const { calls, result: first } = await runH11({
  clock,
  commandStart: clock(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  createClient: (now) => createClient({ credentials, fetch: (request) => fetch(request), now, alsoHide: [accessKey] }),
  names,
  databaseId,
  url,
  accessKey,
  signingSecret,
  fetchUrl: (request) => fetch(new Request(request, { signal: AbortSignal.timeout(30_000) })),
  hide,
  nowIso: () => new Date().toISOString(),
  log: out,
  deployedVersionFromH10: h10.facts.readings.afterFourth?.latestVersionId ?? null,
});

// ---- the evidence: through the secret scan in memory, then to disk, then the repositories are scanned
const secrets = { token: credentials.token, accountId: credentials.accountId, accessKey, signingSecret };
const callsText = canonical11(calls);
for (const [name, text] of [["h11-calls.json", callsText], ["h11-result.json", JSON.stringify(first, null, 2)]] as const) {
  const hits = findSecrets(text, secrets);
  if (hits.length > 0) {
    console.error(`refusing to write ${name}: it contains ${hits.join(" and ")}`);
    process.exit(4);
  }
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
for (const name of ["h11-calls.json", "h11-result.json"]) {
  const path = join(dir, name);
  if (existsSync(path)) {
    mkdirSync(join(dir, "attempts"), { recursive: true });
    renameSync(path, join(dir, "attempts", `${stamp}-${name}`));
  }
}
writeFileSync(join(dir, "h11-calls.json"), callsText);
writeFileSync(join(dir, "h11-result.json"), `${JSON.stringify(first, null, 2)}\n`);

const scan = scanTreesForSecrets([root, ...(existsSync(planRepo) ? [planRepo] : [])], secrets);
const final: H11Result = { ...first, leakScan: scan };
const finalText = `${JSON.stringify(final, null, 2)}\n`;
const finalHits = findSecrets(finalText + printed.join("\n"), secrets);
if (finalHits.length > 0) {
  console.error(`refusing to write h11-result.json: it or the console output contains ${finalHits.join(" and ")}`);
  process.exit(4);
}
writeFileSync(join(dir, "h11-result.json"), finalText);

const attemptsPath = join(dir, "h11-attempts.json");
const attempts = existsSync(attemptsPath) ? (JSON.parse(readFileSync(attemptsPath, "utf8")) as unknown[]) : [];
attempts.push({ startedAt: calls.commandStartedAt, completed: final.completed, stoppedBecause: final.stoppedBecause ?? null });
writeFileSync(attemptsPath, `${JSON.stringify(attempts, null, 2)}\n`);

const evaluation = await evaluateH11({ callsText, result: final });
out("");
for (const [name, value] of Object.entries(evaluation.checks)) out(`  ${value ? "true " : "FALSE"}  ${name}`);
for (const note of evaluation.notes) out(`  note: ${note}`);
out(`leak scan: ${scan.filesScanned} files in the two repositories, ${scan.found.length === 0 ? "no secret found" : `FOUND: ${scan.found.join("; ")}`}`);
out(`attempt ${attempts.length} recorded; evidence in evidence/deployed/`);
process.exit(final.completed && Object.keys(evaluation.checks).length === 9 && Object.values(evaluation.checks).every(Boolean) && scan.found.length === 0 ? 0 : 1);
