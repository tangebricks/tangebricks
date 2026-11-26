import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { getEvidenceDir, stampEvidence, writeEvidence } from "./lib/evidence-stamp.ts";

export interface CanonicalInScopeRow {
  id: string;
  capability: string;
  checkpoint: string;
  testFile: string;
  testCase: string;
  status: "passed" | "failed" | "missing";
  failureReason?: string;
}

export interface OutOfScopeRow {
  id: string;
  capability: string;
  decision: string;
  rationale: string;
}

export interface ParityScorecardReport {
  generatedAt: string;
  scorecardPath: string;
  totalInScope: number;
  passedInScope: number;
  failedInScope: number;
  passRate: number;
  allGreen: boolean;
  inScopeRows: CanonicalInScopeRow[];
  outOfScopeRows: OutOfScopeRow[];
}

interface VitestAssertionResult {
  title: string;
  fullName?: string;
  status: "passed" | "failed" | "skipped" | "pending" | "todo";
}

interface VitestTestResultFile {
  name: string;
  status: string;
  assertionResults?: VitestAssertionResult[];
}

interface VitestJsonReport {
  success: boolean;
  testResults?: VitestTestResultFile[];
}

function stripBackticks(value: string): string {
  return value.trim().replace(/^`+|`+$/g, "").trim();
}

export function parseMarkdownTableSection(markdown: string, headingText: string): string[][] {
  const lines = markdown.split(/\r?\n/);
  const startIdx = lines.findIndex((line) => line.includes(headingText));
  if (startIdx === -1) {
    throw new Error(`Missing required section heading: "${headingText}"`);
  }

  const rows: string[][] = [];
  let inTable = false;

  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith("## ")) {
      break;
    }
    if (!trimmed.startsWith("|")) {
      if (inTable && trimmed.length === 0) {
        break;
      }
      continue;
    }
    inTable = true;
    const cells = trimmed
      .split("|")
      .slice(1, -1)
      .map((cell) => stripBackticks(cell));

    if (cells.length === 0) continue;
    if (cells[0] === "ID" || cells.every((c) => /^-+$/.test(c))) continue;
    rows.push(cells);
  }

  return rows;
}

function runVitestAndCollectResults(
  cwdDir: string,
  files: string[],
  configPath: string | null,
  tempOutputFile: string,
): VitestTestResultFile[] {
  if (files.length === 0) return [];
  if (existsSync(tempOutputFile)) {
    rmSync(tempOutputFile, { force: true });
  }

  const configArg = configPath ? `-c ${configPath}` : "";
  const fileArgs = files.map((f) => `"${f}"`).join(" ");
  const cmd = `pnpm vitest run ${configArg} --reporter=json --outputFile="${tempOutputFile}" ${fileArgs}`;

  console.log(`[parity-scorecard] Executing (${cwdDir}): ${cmd}`);
  try {
    execSync(cmd, {
      cwd: cwdDir,
      stdio: "inherit",
    });
  } catch {
    // If a test fails, vitest exits non-zero; we still parse the JSON report to report exact row failures.
  }

  if (!existsSync(tempOutputFile)) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(tempOutputFile, "utf8")) as VitestJsonReport;
    return parsed.testResults ?? [];
  } finally {
    rmSync(tempOutputFile, { force: true });
  }
}

function main(): void {
  const rootDir = process.cwd();
  const scorecardPath = resolve(rootDir, "docs/n8n-parity-scorecard.md");
  const evidenceDir = getEvidenceDir();
  const outputPath = resolve(evidenceDir, "n8n-parity-scorecard.json");

  if (!existsSync(scorecardPath)) {
    console.error(`[parity-scorecard] FAIL: Missing ${scorecardPath}`);
    process.exit(1);
  }

  const markdown = readFileSync(scorecardPath, "utf8");
  const canonicalRawRows = parseMarkdownTableSection(
    markdown,
    "CP8 Canonical 12-Row Parity Scorecard",
  );
  const oosRawRows = parseMarkdownTableSection(
    markdown,
    "Explicit Out-of-Scope Rows",
  );

  if (canonicalRawRows.length !== 12) {
    console.error(
      `[parity-scorecard] FAIL: Expected exactly 12 canonical in-scope rows, found ${canonicalRawRows.length}`,
    );
    process.exit(1);
  }

  if (oosRawRows.length < 4) {
    console.error(
      `[parity-scorecard] FAIL: Expected at least 4 Explicit Out-of-Scope rows, found ${oosRawRows.length}`,
    );
    process.exit(1);
  }

  const outOfScopeRows: OutOfScopeRow[] = oosRawRows.map((cells) => ({
    id: cells[0] ?? "",
    capability: cells[1] ?? "",
    decision: cells[2] ?? "",
    rationale: cells[3] ?? "",
  }));

  for (const oos of outOfScopeRows) {
    if (oos.decision !== "out-of-scope") {
      console.error(
        `[parity-scorecard] FAIL: Out-of-scope row ${oos.id} has invalid decision "${oos.decision}"`,
      );
      process.exit(1);
    }
  }

  const inScopeRows: CanonicalInScopeRow[] = canonicalRawRows.map((cells) => ({
    id: cells[0] ?? "",
    capability: cells[1] ?? "",
    checkpoint: cells[2] ?? "",
    testFile: cells[3] ?? "",
    testCase: cells[4] ?? "",
    status: "missing",
  }));

  const uniqueFiles = Array.from(new Set(inScopeRows.map((r) => r.testFile)));
  const studioWebFiles = uniqueFiles.filter((f) => f.startsWith("apps/studio-web/"));
  const workerFiles = uniqueFiles.filter((f) => !f.startsWith("apps/studio-web/"));

  // Pre-verify file existence & testCase presence in source
  for (const row of inScopeRows) {
    const absPath = resolve(rootDir, row.testFile);
    if (!existsSync(absPath)) {
      row.status = "missing";
      row.failureReason = `Test file does not exist: ${row.testFile}`;
      continue;
    }
    const source = readFileSync(absPath, "utf8");
    if (!source.includes(row.testCase)) {
      row.status = "missing";
      row.failureReason = `Test case "${row.testCase}" not found in ${row.testFile}`;
    }
  }

  mkdirSync(evidenceDir, { recursive: true });
  const tmpWebReport = resolve(evidenceDir, ".tmp-vitest-studio-web.json");
  const tmpWorkerReport = resolve(evidenceDir, ".tmp-vitest-worker.json");

  const webResults = runVitestAndCollectResults(
    resolve(rootDir, "apps/studio-web"),
    studioWebFiles.map((f) => f.replace(/^apps\/studio-web\//, "")),
    "vitest.config.ts",
    tmpWebReport,
  );
  const workerResults = runVitestAndCollectResults(
    rootDir,
    workerFiles,
    null,
    tmpWorkerReport,
  );

  const allTestFileResults = [...webResults, ...workerResults];

  for (const row of inScopeRows) {
    if (row.failureReason) continue;

    const normalizedTarget = row.testFile.replace(/\\/g, "/");
    const matchingFileResult = allTestFileResults.find((tr) =>
      tr.name.replace(/\\/g, "/").endsWith(normalizedTarget),
    );

    if (!matchingFileResult) {
      row.status = "failed";
      row.failureReason = `No Vitest execution result recorded for ${row.testFile}`;
      continue;
    }

    const matchingAssertion = (matchingFileResult.assertionResults ?? []).find(
      (a) => a.title === row.testCase || (a.fullName && a.fullName.includes(row.testCase)),
    );

    if (!matchingAssertion) {
      row.status = "failed";
      row.failureReason = `Assertion "${row.testCase}" did not execute in ${row.testFile}`;
    } else if (matchingAssertion.status === "passed") {
      row.status = "passed";
    } else {
      row.status = "failed";
      row.failureReason = `Assertion "${row.testCase}" finished with status "${matchingAssertion.status}"`;
    }
  }

  const passedInScope = inScopeRows.filter((r) => r.status === "passed").length;
  const failedInScope = inScopeRows.length - passedInScope;
  const passRate = Number((passedInScope / inScopeRows.length).toFixed(4));
  const allGreen = passedInScope === inScopeRows.length;

  const prov = stampEvidence("scripts/parity-scorecard.ts", "measured");
  const report: ParityScorecardReport = {
    generatedAt: prov.generatedAt,
    scorecardPath: "docs/n8n-parity-scorecard.md",
    totalInScope: inScopeRows.length,
    passedInScope,
    failedInScope,
    passRate,
    allGreen,
    inScopeRows,
    outOfScopeRows,
  };

  writeEvidence(outputPath, report, prov);

  console.log(
    `\n[parity-scorecard] Summary: ${passedInScope}/${inScopeRows.length} canonical in-scope rows green (${outOfScopeRows.length} explicit out-of-scope rows documented).`,
  );
  console.log(`[parity-scorecard] Wrote ${outputPath}`);

  if (!allGreen) {
    console.error("[parity-scorecard] FAIL: One or more in-scope rows failed or are missing:");
    for (const row of inScopeRows.filter((r) => r.status !== "passed")) {
      console.error(`  - ${row.id} (${row.capability}): ${row.failureReason ?? row.status}`);
    }
    process.exit(1);
  }
}

main();
