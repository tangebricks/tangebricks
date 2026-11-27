// The first real deploy and H10's measurement (epic 5, story 5). Run with the credentials loaded by Node from the env file
// kept outside the repositories, and a state folder outside them too (it holds the ledger and the access key):
//
//   node "--env-file=C:\cephlow minimalist version\env\.env" scripts/poc-deploy.ts --state-dir "C:\cephlow minimalist version\env\poc-state"
//
// THIS CREATES THINGS IN THE ACCOUNT: one D1 database, one Worker with its address switched on, and one Workflow, all named
// projectx-poc-<8 hex>. Each is written to the ledger before it is asked for, and scripts/poc-teardown.ts removes exactly what
// the ledger lists. The clock starts when this process starts (module loading included) and stops at the first request that
// completes the scripted check against the deployed address; the second, third and fourth runs are not timed.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { ProjectLock } from "../packages/assembler/src/index.ts";
import { assemble } from "../packages/assembler/src/index.ts";
import { catalog } from "../packages/assembler/catalog.generated.ts";
import { bundleWorker } from "../packages/deploy/src/bundle.ts";
import { canonical, evaluateH10, runH10, withLeakScan } from "../packages/deploy/src/h10.ts";
import type { H10Result } from "../packages/deploy/src/h10.ts";
import { scanTreesForSecrets } from "../packages/deploy/src/leak-scan.ts";
import {
  CredentialsError,
  createClient,
  createRedactor,
  fileKeyStore,
  fileStore,
  findSecrets,
  loadCredentials,
  loadOrCreateAccessKey,
  memoryKeyStore,
  memoryStore,
  migrationsFrom,
  newSuffix,
  openLedger,
  formatPlan,
  planDeploy,
  resourceNames,
  telemetryWebhookConfig,
} from "../packages/deploy/src/provisioner/index.ts";
import { INVOICE_FLOW_BLUEPRINT } from "../test/support/blueprints.ts";
import { OUT_DIR, writeProject } from "../test/support/emitted.ts";
import { WORKERS_SUBDOMAIN_FILE } from "../packages/deploy/src/context.ts";
import { accountSubdomainOf, redactCallsAndResult } from "./lib/redact-subdomain.ts";

// Milliseconds since this process started, minus the time spent on the read-only plan printed before the deploy (see below).
let preflightMs = 0;
const clock = () => performance.now() - preflightMs;
const root = resolve(import.meta.dirname, "..");
const planRepo = resolve(root, "..", "ProjectX");
const COMPATIBILITY_DATE = "2026-10-01";

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
  console.error("--state-dir <folder> is required: the ledger and the access key are kept there, outside both repositories");
  process.exit(2);
}
const envFlag = process.argv.indexOf("--env");
const environment = (envFlag >= 0 ? process.argv[envFlag + 1] : "dev") as "dev" | "preview" | "production";
if (!["dev", "preview", "production"].includes(environment)) {
  console.error("--env must be dev, preview or production");
  process.exit(2);
}
const stateDir = resolve(stateArg);
const inside = (child: string, parent: string) => (child + sep).toLowerCase().startsWith((resolve(parent) + sep).toLowerCase());
if (inside(stateDir, root) || inside(stateDir, planRepo)) {
  console.error("the state folder must be outside both repositories: it holds the access key");
  process.exit(2);
}
// ---- building the project
const variantBlueprint = (variant: "base" | "changed") => ({
  ...INVOICE_FLOW_BLUEPRINT,
  bricks:
    variant === "base" ? [...INVOICE_FLOW_BLUEPRINT.bricks] : ["multi-workspace", { id: "credit-wallet", config: { creditsPerUnit: 2 } }, "dynamic-entities"],
});
async function build(variant: "base" | "changed") {
  const assembled = assemble(variantBlueprint(variant) as never, catalog, { environment });
  if (!assembled.ok) throw new Error(`assembly failed: ${assembled.errors.join("; ")}`);
  const projectDir = join(OUT_DIR, "deploy", `invoice-flow-${variant}`);
  await writeProject(projectDir, assembled.files);
  const bundle = await bundleWorker({ projectDir, environment });
  return {
    bundle: { code: bundle.code, sha256: bundle.sha256, bytes: bundle.bytes },
    compatibilityFlags: bundle.compatibilityFlags,
    migrations: migrationsFrom(assembled.files),
    lock: JSON.parse(assembled.files["project.json"]!) as ProjectLock,
  };
}

// ---- --plan: what a deploy would change, read-only. Reads the account and the ledger, writes nothing to either.
if (process.argv.includes("--plan")) {
  const variantFlag = process.argv.indexOf("--variant");
  const variant = process.argv[variantFlag + 1] === "changed" ? "changed" : "base";
  const planLedgerPath = join(stateDir, "ledger.json");
  const planStore = memoryStore(existsSync(planLedgerPath) ? fileStore(planLedgerPath).read() : null); // a copy: the file is never written
  const planLedger = openLedger(planStore, () => newSuffix((n) => randomBytes(n)));
  const planAccessKey = loadOrCreateAccessKey(
    memoryKeyStore(existsSync(join(stateDir, "access-key.txt")) ? readFileSync(join(stateDir, "access-key.txt"), "utf8").trim() : null),
    (n) => randomBytes(n),
  );
  const built = await build(variant);
  const planClient = createClient({ credentials, fetch: (request) => fetch(request), now: clock, alsoHide: [planAccessKey] });
  const deployPlan = await planDeploy({
    client: planClient,
    ledger: planLedger,
    names: resourceNames(planLedger.suffix),
    accessKey: planAccessKey,
    bundle: built.bundle,
    migrations: built.migrations,
    compatibilityDate: COMPATIBILITY_DATE,
    ...(built.compatibilityFlags.length > 0 ? { compatibilityFlags: built.compatibilityFlags } : {}),
    lock: built.lock,
    catalog: catalog as never,
  });
  console.log(JSON.stringify(deployPlan, null, 2));
  process.exit(0);
}

mkdirSync(stateDir, { recursive: true });

// ---- the ledger and the key
const ledgerPath = join(stateDir, "ledger.json");
const store = fileStore(ledgerPath);
const existing = store.read();
if (existing) {
  const live = existing.entries.filter((e) => e.status !== "removed");
  if (live.length > 0) {
    console.error(
      `the ledger lists ${live.length} resource(s) not yet removed (${live.map((e) => e.name).join(", ")}). The timed run must start from nothing: run scripts/poc-teardown.ts first.`,
    );
    process.exit(5);
  }
  renameSync(ledgerPath, `${ledgerPath}.${new Date().toISOString().replace(/[:.]/g, "-")}.done`); // a finished ledger is kept, and a new suffix is used
}
const ledger = openLedger(store, () => newSuffix((n) => randomBytes(n)));
const names = resourceNames(ledger.suffix);
const accessKey = loadOrCreateAccessKey(fileKeyStore(join(stateDir, "access-key.txt")), (n) => randomBytes(n));
// Story 1.17: when Studio's root PX_TELEMETRY_SECRET is in this environment, the Worker gets its project's derived
// control-plane and webhook secrets (telemetryWebhookConfig), never the root itself. The project id is PX_PROJECT_ID, or
// the deploy's script name; scripts/poc-graphs.ts derives the same control-plane secret to sign its runs.
const rootSecret = process.env.PX_TELEMETRY_SECRET?.trim() ?? "";
const telemetryWebhook = rootSecret
  ? await telemetryWebhookConfig(process.env.PX_TELEMETRY_WEBHOOK_URL?.trim() || undefined, process.env.PX_PROJECT_ID?.trim() || names.script, rootSecret)
  : undefined;
const derivedSecrets = telemetryWebhook ? [rootSecret, telemetryWebhook.controlPlaneSecret, telemetryWebhook.signingSecret] : [];
const hide = createRedactor([credentials.token, credentials.accountId, accessKey, ...derivedSecrets]);

// ---- the plan, printed before anything is written. It reads the account with its own client (so the timed run's recorded calls are
// untouched) and its duration is taken off the clock, so the measurement still covers only the deploy. A blocking plan stops here.
{
  const started = performance.now();
  const built = await build("base");
  const preflightClient = createClient({ credentials, fetch: (request) => fetch(request), now: clock, alsoHide: [accessKey, ...derivedSecrets] });
  const plan = await planDeploy({
    client: preflightClient,
    ledger,
    names,
    accessKey,
    bundle: built.bundle,
    migrations: built.migrations,
    compatibilityDate: COMPATIBILITY_DATE,
    ...(built.compatibilityFlags.length > 0 ? { compatibilityFlags: built.compatibilityFlags } : {}),
    lock: built.lock,
    catalog: catalog as never,
  });
  out("plan (read-only, not timed):");
  for (const line of formatPlan(plan).split(/\r?\n/)) out(`  ${line}`);
  preflightMs = performance.now() - started;
  if (plan.blocking.length > 0) {
    console.error("the plan has blocking items; nothing was written");
    process.exit(6);
  }
}

out(`deploying as ${names.script} (database ${names.database}, workflow ${names.workflow}); the clock started with this process`);
const { calls, result: measured } = await runH10({
  clock,
  commandStart: 0,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  createClient: (now) => createClient({ credentials, fetch: (request) => fetch(request), now, alsoHide: [accessKey, ...derivedSecrets] }),
  names,
  ledger,
  accessKey,
  build,
  fetchUrl: (request) => fetch(new Request(request, { signal: AbortSignal.timeout(20_000) })),
  compatibilityDate: COMPATIBILITY_DATE,
  hide,
  nowIso: () => new Date().toISOString(),
  log: out,
  environment,
  lock: { identity: (variantBlueprint("base") as { identity?: string }).identity ?? "stub" },
  ...(telemetryWebhook ? { telemetryWebhook } : {}),
});

// ---- writing the evidence: first in memory through the secret scan, then to disk, then the repositories are scanned
const secrets: Record<string, string> = {
  token: credentials.token,
  accountId: credentials.accountId,
  accessKey,
  ...(telemetryWebhook ? { rootSecret, controlPlaneSecret: telemetryWebhook.controlPlaneSecret, webhookSecret: telemetryWebhook.signingSecret } : {}),
};
// the account's workers.dev subdomain never reaches the evidence; callsSha256 is taken over the redacted calls text
const { callsText, result: first } = redactCallsAndResult(canonical(calls), measured);
const dir = join(root, "evidence", "deployed");
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
for (const [name, text] of [
  ["h10-calls.json", callsText],
  ["h10-result.json", JSON.stringify(first, null, 2)],
] as const) {
  const hits = findSecrets(text, secrets);
  if (hits.length > 0) {
    console.error(`refusing to write ${name}: it contains ${hits.join(" and ")}`);
    process.exit(4);
  }
}
for (const name of ["h10-calls.json", "h10-result.json"]) {
  const path = join(dir, name);
  if (existsSync(path)) {
    mkdirSync(join(dir, "attempts"), { recursive: true });
    renameSync(path, join(dir, "attempts", `${stamp}-${name}`));
  }
}
writeFileSync(join(dir, "h10-calls.json"), callsText);
// The evidence shows the address with the account's subdomain redacted; the real one stays in the state folder (outside both
// repositories) for the later live scripts (loadDeployment, poc-graphs: resolveWorkerUrl).
const accountSubdomain = calls.facts.url ? accountSubdomainOf(calls.facts.url) : undefined;
if (accountSubdomain)
  writeFileSync(
    join(stateDir, WORKERS_SUBDOMAIN_FILE),
    `${accountSubdomain}
`,
  );
writeFileSync(join(dir, "h10-result.json"), `${JSON.stringify(first, null, 2)}\n`);

const scan = scanTreesForSecrets([root, ...(existsSync(planRepo) ? [planRepo] : [])], secrets);
const final: H10Result = withLeakScan(first, scan);
const finalText = `${JSON.stringify(final, null, 2)}\n`;
const finalHits = findSecrets(finalText + printed.join("\n"), secrets);
if (finalHits.length > 0) {
  console.error(`refusing to write h10-result.json: it or the console output contains ${finalHits.join(" and ")}`);
  process.exit(4);
}
writeFileSync(join(dir, "h10-result.json"), finalText);

const attemptsPath = join(dir, "h10-attempts.json");
const attempts = existsSync(attemptsPath) ? (JSON.parse(readFileSync(attemptsPath, "utf8")) as unknown[]) : [];
attempts.push({
  startedAt: calls.commandStartedAt,
  completed: final.completed,
  seconds: final.secondsToCorrectAnswer,
  stoppedBecause: final.stoppedBecause ?? null,
  uploadOutcome: calls.facts.upload.outcome,
});
mkdirSync(dirname(attemptsPath), { recursive: true });
writeFileSync(attemptsPath, `${JSON.stringify(attempts, null, 2)}\n`);

// ---- what the files say (the same recomputation pnpm poc:verify does)
const sources: Record<string, string> = {};
for (const file of [
  "scripts/poc-deploy.ts",
  "packages/deploy/src/h10.ts",
  ...["access-key", "cloudflare", "credentials", "deploy", "index", "ledger", "names", "redact", "teardown"].map(
    (n) => `packages/deploy/src/provisioner/${n}.ts`,
  ),
])
  sources[file] = readFileSync(join(root, file), "utf8");
const evaluation = evaluateH10({ callsText, result: final, sources, evidenceTexts: [callsText, finalText] });
out("");
out(`secondsToCorrectAnswer: ${evaluation.measured ?? "not measured"}`);
for (const [name, value] of Object.entries(evaluation.checks)) out(`  ${value ? "true " : "FALSE"}  ${name}`);
for (const note of evaluation.notes) out(`  note: ${note}`);
out(`leak scan: ${scan.filesScanned} files in the two repositories, ${scan.found.length === 0 ? "no secret found" : `FOUND: ${scan.found.join("; ")}`}`);
out(`attempt ${attempts.length} recorded; evidence in evidence/deployed/`);
if (calls.facts.url) out(`address: ${calls.facts.url}`);
process.exit(final.completed && Object.values(evaluation.checks).every(Boolean) && scan.found.length === 0 ? 0 : 1);
