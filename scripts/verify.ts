// Usage: node scripts/verify.ts [--out <dir>] [--offline] [H1 ...]
// Runs the workerd test suite (or only the tests for the named hypotheses), turns the reports the
// tests attached into verdicts using hypotheses.json, writes evidence/verdicts.json and prints a table.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PortListSchema, checkPortedTests, parseHypotheses, verdict, withFailedFile } from "../packages/harness/src/index.ts";
import type { Hypothesis, Result, TestOutcome, VerdictName } from "../packages/harness/src/index.ts";
import { stampEvidence, writeEvidence } from "./lib/evidence-stamp.ts";
import { h9BreakdownPath, readRawResults } from "./lib/run-results.ts";
import { evaluateH10 } from "../packages/deploy/src/h10.ts";
import type { H10Result } from "../packages/deploy/src/h10.ts";
import { evaluateH11 } from "../packages/deploy/src/h11.ts";
import type { H11Result } from "../packages/deploy/src/h11.ts";
import { evaluateHostedH5 } from "../packages/deploy/src/h5-hosted.ts";
import type { HostedResult } from "../packages/deploy/src/h5-hosted.ts";
import { GLUE_SCAN_FILES, evaluateH12 } from "../packages/deploy/src/h12.ts";
import type { H12Result } from "../packages/deploy/src/h12.ts";
import { evaluateMcp } from "../packages/deploy/src/mcp-measure.ts";
import type { McpResult } from "../packages/deploy/src/mcp-measure.ts";
import { assemble } from "../packages/assembler/src/index.ts";
import { catalog } from "../packages/assembler/catalog.generated.ts";
import { TWO_BRICK_BLUEPRINT, INVOICE_FLOW_BLUEPRINT } from "../test/support/blueprints.ts";
import { verifiedPath, writeProject } from "../test/support/emitted.ts";
import { computeMaxCompatible } from "./max-compatible.ts";
import { ASSEMBLED_PROJECTS } from "../test/support/global-setup.ts";
import { checkDenialTestsRepoOwned, scanAssemblerForBrickNames, scanForEntityNames } from "../test/support/scan.ts";
import { LIVE_HYPOTHESES, OFFLINE_HYPOTHESES, TIMED_OFFLINE_HYPOTHESES, computeInputsHash } from "./proof-inputs.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let outDirOverride: string | undefined;
let offlineOnly = false;
const rawArgs = process.argv.slice(2);
const positionalIds: string[] = [];

for (let i = 0; i < rawArgs.length; i += 1) {
  const arg = rawArgs[i]!;
  if (arg === "--out") {
    const next = rawArgs[i + 1];
    if (!next) {
      console.error("Missing value for --out <dir>");
      process.exit(2);
    }
    outDirOverride = resolve(next);
    i += 1;
  } else if (arg === "--offline") {
    offlineOnly = true;
  } else {
    positionalIds.push(arg.toUpperCase());
  }
}

const repoEvidenceDir = join(root, "evidence");
const defaultRunDir = join(root, ".evidence-run");
const runDir = outDirOverride ?? defaultRunDir;
const evidenceDir = outDirOverride ?? repoEvidenceDir;
const deployedDir = existsSync(join(runDir, "deployed"))
  ? join(runDir, "deployed")
  : existsSync(join(evidenceDir, "deployed"))
    ? join(evidenceDir, "deployed")
    : join(repoEvidenceDir, "deployed");
const rawPath = join(runDir, "raw-results.json");
const verdictsPath = join(evidenceDir, "verdicts.json");

const hypotheses = parseHypotheses(JSON.parse(readFileSync(join(root, "hypotheses.json"), "utf8"))).hypotheses;
const requested = positionalIds;
for (const id of requested) {
  if (!hypotheses.some((h) => h.id === id)) {
    console.error(`Unknown hypothesis id: ${id}`);
    process.exit(2);
  }
}
const selected = requested.length > 0 ? hypotheses.filter((h) => requested.includes(h.id)) : hypotheses;

const { inputsHash } = computeInputsHash(root);
const offlineCachePath = join(tmpdir(), `projectx-poc-offline-${inputsHash}.json`);

type RawRunPayload = {
  tests: { passed: number; failed: number };
  failedFiles: string[];
  testOutcomes: TestOutcome[];
  results: Record<string, Result>;
};
type EmittedRecord = { unchanged: boolean | null; changed?: string[]; missing?: string[]; extra?: string[]; checked?: number; expected?: number };

let raw: RawRunPayload;
let emittedRecords: Map<string, EmittedRecord | undefined>;
let runStatus = 0;

if (offlineOnly && outDirOverride && requested.length === 0 && existsSync(offlineCachePath)) {
  const cached = JSON.parse(readFileSync(offlineCachePath, "utf8")) as {
    raw: RawRunPayload;
    h9Session?: unknown;
    emitted: Record<string, EmittedRecord | undefined>;
  };
  const prov = stampEvidence("scripts/verify.ts", "measured");
  writeEvidence(rawPath, cached.raw, prov);
  if (cached.h9Session !== undefined) {
    writeEvidence(join(evidenceDir, "h9-session.json"), cached.h9Session, prov);
  }
  raw = structuredClone(cached.raw);
  emittedRecords = new Map(ASSEMBLED_PROJECTS.map((blueprint) => [blueprint.project, cached.emitted[blueprint.project]] as const));
} else {
  // Test files are named "<id>.<topic>.test.ts"; the trailing dot keeps H1 from matching H10.
  const filters =
    requested.length > 0
      ? requested.map((id) => `${id}.`)
      : offlineOnly
        ? OFFLINE_HYPOTHESES.map((id) => `${id}.`)
        : [];
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  rmSync(rawPath, { force: true });
  const recordDir = outDirOverride ?? undefined;
  // The test setup step records here, after the run, whether the assembled project is exactly as it was written. Cleared
  // first so a record left by an earlier run can never be read as this one's.
  const emittedRecordPath = verifiedPath(TWO_BRICK_BLUEPRINT.project, recordDir);
  rmSync(emittedRecordPath, { force: true });
  for (const blueprint of ASSEMBLED_PROJECTS) rmSync(verifiedPath(blueprint.project, recordDir), { force: true });
  // Setup: assemble max-compatible into out/max-compatible/ (or reuses it)
  const maxCompatibleDir = join(root, "out", "max-compatible");
  if (!existsSync(join(maxCompatibleDir, "src", "index.ts"))) {
    const maxSet = computeMaxCompatible(catalog);
    const maxBlueprint = {
      project: maxSet.project,
      bricks: maxSet.bricks,
      entities: [
        {
          name: "records",
          fields: [
            { name: "title", type: "text", required: true },
            { name: "amount", type: "number" },
          ],
        },
      ],
    };
    const assembledMax = assemble(maxBlueprint, catalog);
    if (!assembledMax.ok) {
      console.error("Failed to assemble max-compatible for verification:", assembledMax.errors);
      process.exit(1);
    }
    await writeProject(maxCompatibleDir, assembledMax.files);
  }
  const vitestBin = join(root, "node_modules", "vitest", "vitest.mjs");
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (outDirOverride) {
    childEnv.POC_EVIDENCE_DIR = outDirOverride;
  }
  const run = spawnSync(
    process.execPath,
    [
      vitestBin,
      "run",
      "--maxWorkers=2",
      "--passWithNoTests",
      "--exclude",
      "scripts/test/proof-check.tamper.node.test.ts",
      "--reporter=dot",
      "--reporter=./reporters/evidence-reporter.ts",
      ...filters,
    ],
    { cwd: root, stdio: "inherit", env: childEnv },
  );
  runStatus = run.status ?? 1;

  try {
    raw = readRawResults(runDir) as RawRunPayload;
  } catch (err) {
    console.error("The test run produced no evidence file; it did not complete.");
    console.error((err as Error).message);
    process.exit(1);
  }

  const readEmitted = (project: string): EmittedRecord | undefined => {
    const path = verifiedPath(project, recordDir);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as EmittedRecord) : undefined;
  };
  emittedRecords = new Map(ASSEMBLED_PROJECTS.map((blueprint) => [blueprint.project, readEmitted(blueprint.project)] as const));

  if (requested.length === 0 && runStatus === 0) {
    const h9Path = h9BreakdownPath(runDir);
    const h9Session = h9Path ? JSON.parse(readFileSync(h9Path, "utf8")) : undefined;
    const emittedObj: Record<string, EmittedRecord | undefined> = {};
    for (const [k, v] of emittedRecords.entries()) emittedObj[k] = v;
    try {
      writeFileSync(offlineCachePath, JSON.stringify({ raw, h9Session, emitted: emittedObj }, null, 2) + "\n");
    } catch {
      // Ignore temp cache write errors.
    }
  }
}

// "Unchanged" counts only if the comparison really read back every file the project has. A record that says unchanged
// after checking nothing, or fewer files than the project holds, is a check that did not run, not a pass.
const isChecked = (record: EmittedRecord | undefined): boolean =>
  record?.unchanged === true && typeof record.checked === "number" && record.checked > 0 && record.checked === record.expected;
const emitted = emittedRecords.get(TWO_BRICK_BLUEPRINT.project);
const emittedChecked = isChecked(emitted);
const invoiceFlowChecked = isChecked(emittedRecords.get(INVOICE_FLOW_BLUEPRINT.project));

// Checks that need the real file system or git objects cannot run inside workerd, so they run here and join the
// checks the tests reported. They are only computed for the hypotheses being verified.
const portList = PortListSchema.parse(JSON.parse(readFileSync(join(root, "ported-tests.json"), "utf8")));
const denialList = PortListSchema.parse(JSON.parse(readFileSync(join(root, "h6-denial-tests.json"), "utf8")));
const entityList = PortListSchema.parse(JSON.parse(readFileSync(join(root, "h8-entity-tests.json"), "utf8")));
const DENIAL_TESTS = "packages/assembler/test/H6.denial.test.ts";
const ENTITY_TESTS = "packages/assembler/test/H8.entities.test.ts";
// A value of null deletes the check the tests reported, leaving it "not reported" (a fail): used when the evidence a reported
// value stands on is missing, so that a `true` the tests gave cannot outlive the loss of the tests behind it.
const nodeSideChecks: Record<string, () => Record<string, boolean | null>> = {
  H5: () => {
    const check = checkPortedTests(portList, raw.testOutcomes);
    for (const problem of check.problems) console.error(`ported-tests.json: ${problem}`);
    return { portedTestsPass: check.ok };
  },
  H6: () => {
    const scan = scanAssemblerForBrickNames();
    for (const hit of scan.found) console.error(`assembler names a brick: ${hit}`);
    const assembled = assemble(TWO_BRICK_BLUEPRINT, catalog);
    const owned = assembled.ok ? checkDenialTestsRepoOwned(assembled.files, DENIAL_TESTS) : { ok: false, problems: ["the two-brick blueprint did not assemble"] };
    // The repo's own denial tests must also have run in this run (a file that was deleted from the run, or never ran, is not ownership).
    const ran = raw.testOutcomes.filter((o) => o.file?.endsWith(DENIAL_TESTS) && o.state === "passed");
    if (ran.length === 0) owned.problems.push(`no test from ${DENIAL_TESTS} ran`);
    for (const problem of owned.problems) console.error(`denial tests: ${problem}`);
    // The two booleans the report test computes are only believed if every attack it stands on really ran and passed.
    const attacks = checkPortedTests(denialList, raw.testOutcomes.filter((o) => o.file?.endsWith(DENIAL_TESTS)));
    for (const problem of attacks.problems) console.error(`h6-denial-tests.json: ${problem}`);
    const reported = raw.results.H6?.checks ?? {};
    return {
      crossTenantDenied: reported.crossTenantDenied === true && attacks.ok,
      ownWalletWorks: reported.ownWalletWorks === true && attacks.ok,
      emittedProjectUnchanged: emittedChecked,
      assemblerNamesNoBrick: scan.found.length === 0 && scan.namesChecked > 10 && scan.filesScanned >= 5,
      denialTestsRepoOwned: owned.ok && ran.length > 0,
    };
  },
  H8: () => {
    // Each check stands on its own listed tests (h8-entity-tests.json tags them): a test that FAILED makes its check false
    // (a safety failure, a kill); a test that is missing, renamed, skipped or duplicated leaves its check "not reported" (a
    // fail), because lost evidence is not evidence of a leak. The report test's own booleans must agree.
    const inFile = raw.testOutcomes.filter((o) => o.file?.endsWith(ENTITY_TESTS));
    const reported = raw.results.H8?.checks ?? {};
    const checks: Record<string, boolean | null> = {};
    for (const name of ["tenantACrud", "tenantBDenied", "bodyWorkspaceIgnored", "hostileInputsSafe", "walletStillDenied"]) {
      const mine = { ...entityList, tests: entityList.tests.filter((t) => t.supports === name) };
      const status = checkPortedTests(mine, inFile);
      for (const problem of status.problems) console.error(`h8-entity-tests.json (${name}): ${problem}`);
      const anyFailed = status.problems.some((p) => p.startsWith("failed:"));
      const anyLost = status.problems.some((p) => !p.startsWith("failed:"));
      if (anyFailed) checks[name] = false;
      else if (anyLost || !(name in reported)) checks[name] = null; // not reported: delete whatever the tests gave
      else checks[name] = reported[name] === true;
    }
    // No entity or field name may be written into code: the assembler, the shared contract, the router, or any emitted source other than the entry's own wiring.
    const generic = scanForEntityNames(INVOICE_FLOW_BLUEPRINT.entities, assemble(INVOICE_FLOW_BLUEPRINT, catalog));
    for (const hit of generic.found) console.error(`entity named in code: ${hit}`);
    return { ...checks, entityCodeIsGeneric: generic.ok, emittedProjectUnchanged: invoiceFlowChecked };
  },
};
for (const [id, compute] of Object.entries(nodeSideChecks)) {
  if (!selected.some((h) => h.id === id)) continue;
  const into = (raw.results[id] ??= {});
  const merged: Record<string, boolean> = { ...(into.checks ?? {}) };
  for (const [name, value] of Object.entries(compute())) {
    if (value === null) delete merged[name];
    else merged[name] = value;
  }
  into.checks = merged;
}

// H9's ratio and call count are believed only if they can be recomputed from the breakdown the same test wrote: the ratio is
// conversation tokens over first-party code tokens, to one decimal; the call count is the number of tools/call exchanges in
// the per-message list, which must also equal the count the test states. A number that does not match (a made-up or
// hard-coded one) is removed, which leaves the hypothesis "not measured" or the check "not reported" (a fail).
if (selected.some((h) => h.id === "H9") && raw.results.H9) {
  const breakdownPath = h9BreakdownPath(runDir);
  const scored = breakdownPath
    ? (JSON.parse(readFileSync(breakdownPath, "utf8")) as { scored?: { conversationTokens?: number; firstPartySourceTokens?: number; toolCalls?: number; byMessage?: Array<{ what: string }> } }).scored
    : undefined;
  const recomputed = scored?.conversationTokens && scored.firstPartySourceTokens ? Math.round((scored.conversationTokens / scored.firstPartySourceTokens) * 1000) / 10 : undefined;
  if (raw.results.H9.measured !== undefined && (recomputed === undefined || raw.results.H9.measured !== recomputed)) {
    console.error(`H9: the reported ratio ${raw.results.H9.measured} does not match the breakdown (${recomputed ?? "no breakdown"}); treating it as not measured`);
    delete raw.results.H9.measured;
  }
  const counted = scored?.byMessage?.filter((m) => m.what.startsWith("tools/call")).length;
  if (counted === undefined || counted !== scored?.toolCalls) {
    console.error(`H9: the tool-call count (${scored?.toolCalls ?? "none"}) does not match the calls in the breakdown (${counted ?? "no breakdown"}); treating the check as not reported`);
    if (raw.results.H9.checks) delete raw.results.H9.checks.fiveToolCallsOrFewer;
  } else if (raw.results.H9.checks) {
    raw.results.H9.checks.fiveToolCallsOrFewer = counted <= 5; // from the exchanges themselves, whatever the report said
  }
}

// H10 stands on files written by `pnpm poc:deploy` against the owner's real account (evidence/deployed/). This step runs offline:
// it re-reads those files and recomputes the measurement and every check from them and from the source, and believes a claim
// only if it matches (see evaluateH10). With no files the hypothesis stays pending; files that do not agree make it a fail.
const extraNotes: Record<string, string[]> = {};

const readLfText = (filePath: string): string => readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");

// Story 9's deployed MCP measurement against the real account: information about H9, not a check. It changes no check,
// threshold or verdict; H9 stays a Node measurement.
if (selected.some((h) => h.id === "H9")) {
  const callsPath = join(deployedDir, "mcp-calls.json");
  const resultPath = join(deployedDir, "mcp-result.json");
  if (existsSync(callsPath) && existsSync(resultPath)) {
    const evaluation = evaluateMcp({
      callsText: readLfText(callsPath),
      result: JSON.parse(readLfText(resultPath)) as McpResult,
    });
    extraNotes.H9 = evaluation.notes;
    for (const note of evaluation.notes) console.error(`H9 (deployed MCP): ${note}`);
  }
  const breakdownPath = h9BreakdownPath(runDir);
  if (breakdownPath) {
    const h9Data = JSON.parse(readFileSync(breakdownPath, "utf8")) as {
      forInformation?: {
        tenBricks?: { ratioPercent?: number; conversationTokens?: number; firstPartySourceTokens?: number };
        filteredDiscovery?: { ratioPercent?: number; conversationTokens?: number; firstPartySourceTokens?: number };
      };
    };
    const ten = h9Data.forInformation?.tenBricks;
    if (ten?.ratioPercent !== undefined) {
      console.error(`10-brick session ratio: ${ten.ratioPercent}% (${ten.conversationTokens} conversation tokens / ${ten.firstPartySourceTokens} source tokens)`);
    }
  }
}
if (selected.some((h) => h.id === "H10")) {
  const callsPath = join(deployedDir, "h10-calls.json");
  const resultPath = join(deployedDir, "h10-result.json");
  if (existsSync(callsPath) && existsSync(resultPath)) {
    const callsText = readLfText(callsPath);
    const resultText = readLfText(resultPath);
    const sources: Record<string, string> = {};
    for (const file of ["scripts/poc-deploy.ts", "packages/deploy/src/h10.ts", ...["access-key", "cloudflare", "credentials", "deploy", "index", "ledger", "names", "redact", "teardown"].map((n) => `packages/deploy/src/provisioner/${n}.ts`)]) sources[file] = readLfText(join(root, file));
    const evaluation = evaluateH10({ callsText, result: JSON.parse(resultText) as H10Result, sources, evidenceTexts: [callsText, resultText] });
    raw.results.H10 = { ...(evaluation.measured !== undefined ? { measured: evaluation.measured } : {}), checks: evaluation.checks };
    extraNotes.H10 = evaluation.notes;
    for (const note of evaluation.notes) console.error(`H10: ${note}`);
  }
}

// H5's extra evidence, holdsOnHostedD1, from the files `pnpm poc:h5-hosted` writes against the real account. Present and true: it is added to
// the checks the tests reported. Present and false: a kill. Absent or inconclusive (too many unknown outcomes): it stays unreported, and the
// scoreboard keeps saying the check has not been run, which changes nothing else.
if (selected.some((h) => h.id === "H5") && raw.results.H5) {
  const callsPath = join(deployedDir, "h5-hosted-calls.json");
  const resultPath = join(deployedDir, "h5-hosted-result.json");
  if (existsSync(callsPath) && existsSync(resultPath)) {
    const evaluation = evaluateHostedH5({ callsText: readLfText(callsPath), result: JSON.parse(readLfText(resultPath)) as HostedResult });
    if ("holdsOnHostedD1" in evaluation.checks) raw.results.H5.checks = { ...(raw.results.H5.checks ?? {}), holdsOnHostedD1: evaluation.checks.holdsOnHostedD1! };
    extraNotes.H5 = evaluation.notes;
    for (const note of evaluation.notes) console.error(`H5 (hosted D1): ${note}`);
  }
}

// H11 the same way, from the files `pnpm poc:graphs` writes. Nothing here is timed; every check is recomputed.
if (selected.some((h) => h.id === "H11")) {
  const callsPath = join(deployedDir, "h11-calls.json");
  const resultPath = join(deployedDir, "h11-result.json");
  if (existsSync(callsPath) && existsSync(resultPath)) {
    const evaluation = await evaluateH11({ callsText: readLfText(callsPath), result: JSON.parse(readLfText(resultPath)) as H11Result });
    raw.results.H11 = { checks: evaluation.checks };
    extraNotes.H11 = evaluation.notes;
    for (const note of evaluation.notes) console.error(`H11: ${note}`);
  }
}

// H12 the same way, from the files the live widget test writes. "No glue code" is judged here from the files as they are NOW and must
// agree with the hashes taken when the live test ran. The owner's look at the page, if recorded, is shown with their words and judges nothing.
if (selected.some((h) => h.id === "H12")) {
  const callsPath = join(deployedDir, "h12-calls.json");
  const resultPath = join(deployedDir, "h12-result.json");
  if (existsSync(callsPath) && existsSync(resultPath)) {
    const sources = Object.fromEntries(GLUE_SCAN_FILES.map((p) => [p, readLfText(join(root, p))]));
    const evaluation = evaluateH12({ callsText: readLfText(callsPath), result: JSON.parse(readLfText(resultPath)) as H12Result, sources });
    raw.results.H12 = { checks: evaluation.checks };
    extraNotes.H12 = evaluation.notes;
    const sightingPath = join(deployedDir, "h12-owner.json");
    if (existsSync(sightingPath)) {
      const sighting = JSON.parse(readFileSync(sightingPath, "utf8")) as { at?: string; words?: string; assistantDescription?: string };
      extraNotes.H12.push(`the owner looked at the page${sighting.at ? ` (${sighting.at})` : ""} and said: "${sighting.words ?? ""}" (recorded, not a check)`);
      if (sighting.assistantDescription) extraNotes.H12.push(sighting.assistantDescription);
    }
    for (const note of extraNotes.H12) console.error(`H12: ${note}`);
  }
}

// A test file named "<id>.<topic>.test.ts" that has a failing test, or failed to load, counts against
// that hypothesis whether or not its report test passed.
const brokenFileFor = (id: string): string | undefined =>
  raw.failedFiles.find((file) => (file.split("/").pop() ?? "").startsWith(`${id}.`));

interface Row {
  id: string;
  title: string;
  verdict: VerdictName;
  measured: string;
  reasons: string[];
  note?: string;
  caveat?: string;
}

function describe(h: Hypothesis, result: Result | undefined): string {
  if (h.status !== "live" || !result) return "-";
  if (result.measured !== undefined && h.metric) return `${result.measured} ${h.metric.unit}`;
  const checks = Object.values(result.checks ?? {});
  return checks.length > 0 ? `${checks.filter(Boolean).length}/${checks.length} checks` : "-";
}

const rows: Row[] = selected.map((h) => {
  const result = raw.results[h.id];
  // Applies to every live row, so a failing sibling test cannot hide behind a passing report test.
  const outcome = h.status === "live" ? withFailedFile(verdict(h, result), brokenFileFor(h.id)?.split("/").pop()) : verdict(h, result);
  return {
    id: h.id,
    title: h.title,
    verdict: outcome.verdict,
    measured: describe(h, result),
    reasons: [...outcome.reasons, ...(extraNotes[h.id] ?? [])],
    ...(h.status === "live" && h.note ? { note: h.note } : {}),
    ...(h.status === "live" && h.caveat ? { caveat: h.caveat } : {}),
  };
});

// A filtered run refreshes only the rows it ran. Rows it did not run are kept; if inputsHash changed since the full run,
// non-refreshed rows are marked stale so a regression elsewhere cannot hide behind an old pass.
mkdirSync(evidenceDir, { recursive: true });
const previousPath = existsSync(verdictsPath) ? verdictsPath : join(repoEvidenceDir, "verdicts.json");
const previousFile: { inputsHash?: string; generatedBy?: string; verdicts?: Record<string, Record<string, unknown>> } = existsSync(previousPath)
  ? (JSON.parse(readFileSync(previousPath, "utf8")) as { inputsHash?: string; generatedBy?: string; verdicts?: Record<string, Record<string, unknown>> })
  : {};
const previous = previousFile.verdicts ?? {};
const sameInputs = previousFile.inputsHash === inputsHash;

const verdicts: Record<string, Record<string, unknown>> =
  requested.length > 0
    ? Object.fromEntries(
        Object.entries(previous).map(([id, entry]) => [
          id,
          sameInputs ? { ...entry } : { ...entry, stale: true },
        ]),
      )
    : {};
const nowIso = new Date().toISOString();
const liveSet = new Set<string>(LIVE_HYPOTHESES);

for (const row of rows) {
  const prevEntry = previous[row.id];
  const prevRecordedAt = typeof prevEntry?.recordedAt === "string" ? prevEntry.recordedAt : undefined;
  if (
    !outDirOverride &&
    sameInputs &&
    TIMED_OFFLINE_HYPOTHESES.has(row.id) &&
    prevEntry !== undefined &&
    prevEntry.verdict === row.verdict &&
    typeof prevEntry.measured === "string" &&
    JSON.stringify(prevEntry.reasons) === JSON.stringify(row.reasons)
  ) {
    row.measured = prevEntry.measured;
  }
  const sameRowOutcome =
    prevEntry !== undefined &&
    prevEntry.verdict === row.verdict &&
    prevEntry.measured === row.measured &&
    JSON.stringify(prevEntry.reasons) === JSON.stringify(row.reasons);
  const rowRecordedAt =
    liveSet.has(row.id) && prevRecordedAt
      ? prevRecordedAt
      : sameInputs && sameRowOutcome && prevRecordedAt
        ? prevRecordedAt
        : nowIso;
  verdicts[row.id] = { verdict: row.verdict, measured: row.measured, reasons: row.reasons, recordedAt: rowRecordedAt };
}

const generatedBy =
  requested.length > 0 && !sameInputs
    ? `node scripts/verify.ts ${requested.join(" ")}`
    : "node scripts/verify.ts";

const prov = stampEvidence("scripts/verify.ts", "measured");
writeEvidence(
  verdictsPath,
  {
    inputsHash,
    generatedBy,
    verdicts,
  },
  prov,
);

const pad = (text: string, width: number) => text.padEnd(width);
console.log("");
console.log(`${pad("Id", 5)}${pad("Verdict", 9)}${pad("Measured", 16)}Title`);
console.log(`${pad("--", 5)}${pad("-------", 9)}${pad("--------", 16)}-----`);
for (const row of rows) {
  console.log(`${pad(row.id, 5)}${pad(row.verdict, 9)}${pad(row.measured, 16)}${row.title}`);
  if (row.verdict !== "pending") {
    // a pass can carry a note too (an extra check that has not been run); anything else would have made it a fail
    for (const reason of row.reasons) console.log(`${" ".repeat(5)}  - ${reason}`);
  }
  if ((row.verdict === "fail" || row.verdict === "kill") && row.note) console.log(`${" ".repeat(5)}  note: ${row.note}`);
  if (row.caveat && row.verdict !== "pending") console.log(`${" ".repeat(5)}  caveat: ${row.caveat}`);
}
const counts: Record<string, number> = {};
for (const row of rows) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;
console.log("");
console.log(
  `Tests: ${raw.tests.passed} passed, ${raw.tests.failed} failed. Verdicts: ` +
    (["pass", "fail", "kill", "pending"] as const).map((v) => `${counts[v] ?? 0} ${v}`).join(", "),
);

const killed = rows.some((row) => row.verdict === "kill");

// The records were read above, before the hypotheses' Node-side checks needed them; here they are reported, one line per project.
let emittedBroken = false;
for (const [project, record] of emittedRecords) {
  if (record === undefined) {
    console.log(`Assembled project ${project}: not checked in this run`);
  } else if (isChecked(record)) {
    console.log(`Assembled project ${project}: unchanged since it was written (${record.checked} files re-read and compared)`);
  } else if (record.unchanged === true) {
    emittedBroken = true;
    console.error(`Assembled project ${project}: the record says unchanged but the check did not read the files back (checked ${record.checked ?? "nothing"} of ${record.expected ?? "?"})`);
  } else {
    emittedBroken = true;
    const detail = [...(record.changed ?? []).map((f) => `changed ${f}`), ...(record.missing ?? []).map((f) => `missing ${f}`), ...(record.extra ?? []).map((f) => `extra ${f}`)];
    console.error(`Assembled project ${project}: ${record.unchanged === false ? "CHANGED while the tests ran (" + detail.join(", ") + ")" : "the run did not finish checking it"}`);
  }
}

process.exit(runStatus !== 0 || killed || emittedBroken ? 1 : 0);
