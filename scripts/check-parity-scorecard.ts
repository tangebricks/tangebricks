import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface ScorecardRow {
  id: string;
  capability: string;
  status: string;
  specFile: string;
  testName: string;
}

interface PlaywrightSpecResult {
  title: string;
  file: string;
  ok: boolean;
  passed: boolean;
}

interface PlaywrightSuiteNode {
  title?: string;
  file?: string;
  specs?: Array<{
    title: string;
    file: string;
    ok: boolean;
    tests?: Array<{
      status?: string;
      results?: Array<{ status?: string }>;
    }>;
  }>;
  suites?: PlaywrightSuiteNode[];
}

function stripBackticks(value: string): string {
  return value.trim().replace(/^`+|`+$/g, "").trim();
}

function parseMarkdownTableSection(markdown: string, headingText: string): string[][] {
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

    // Skip header and separator rows
    if (cells.length === 0) continue;
    if (cells[0] === "ID" || cells.every((c) => /^-+$/.test(c))) continue;
    rows.push(cells);
  }

  return rows;
}

function collectPlaywrightSpecs(
  suites: PlaywrightSuiteNode[],
  acc: PlaywrightSpecResult[] = [],
): PlaywrightSpecResult[] {
  for (const suite of suites) {
    if (Array.isArray(suite.specs)) {
      for (const spec of suite.specs) {
        const passed =
          Boolean(spec.ok) &&
          Array.isArray(spec.tests) &&
          spec.tests.length > 0 &&
          spec.tests.every(
            (t) =>
              t.status === "expected" ||
              (Array.isArray(t.results) &&
                t.results.some((r) => r.status === "passed")),
          );
        acc.push({
          title: spec.title,
          file: spec.file.replace(/\\/g, "/"),
          ok: Boolean(spec.ok),
          passed,
        });
      }
    }
    if (Array.isArray(suite.suites)) {
      collectPlaywrightSpecs(suite.suites, acc);
    }
  }
  return acc;
}

function main(): void {
  const rootDir = process.cwd();
  const scorecardPath = resolve(rootDir, "docs/n8n-parity-scorecard.md");
  const reportPath = resolve(rootDir, "test-results/playwright-report.json");

  if (!existsSync(scorecardPath)) {
    console.error(`[scorecard] FAIL: Missing ${scorecardPath}`);
    process.exit(1);
  }

  const markdown = readFileSync(scorecardPath, "utf8");
  const cp3RawRows = parseMarkdownTableSection(markdown, "CP3 Build Rows");
  const cp4RawRows = parseMarkdownTableSection(markdown, "CP4 Run Rows");
  const oosRawRows = parseMarkdownTableSection(
    markdown,
    "Explicit Out-of-Scope Rows",
  );

  if (cp3RawRows.length < 16) {
    console.error(
      `[scorecard] FAIL: Expected at least 16 CP3 Build Rows, found ${cp3RawRows.length}`,
    );
    process.exit(1);
  }

  if (cp4RawRows.length < 6) {
    console.error(
      `[scorecard] FAIL: Expected at least 6 CP4 Run Rows, found ${cp4RawRows.length}`,
    );
    process.exit(1);
  }

  if (oosRawRows.length === 0) {
    console.error("[scorecard] FAIL: Explicit Out-of-Scope Rows table is empty");
    process.exit(1);
  }

  const cp3Rows: ScorecardRow[] = cp3RawRows.map((cells) => ({
    id: cells[0] ?? "",
    capability: cells[1] ?? "",
    status: cells[2] ?? "",
    specFile: cells[3] ?? "",
    testName: cells[4] ?? "",
  }));

  const cp4Rows: ScorecardRow[] = cp4RawRows.map((cells) => ({
    id: cells[0] ?? "",
    capability: cells[1] ?? "",
    status: cells[2] ?? "",
    specFile: cells[3] ?? "",
    testName: cells[4] ?? "",
  }));

  const allVerifiedRows = [...cp3Rows, ...cp4Rows];

  const loadExecutedSpecs = (): PlaywrightSpecResult[] => {
    if (!existsSync(reportPath)) return [];
    const reportJson = JSON.parse(readFileSync(reportPath, "utf8")) as {
      suites?: PlaywrightSuiteNode[];
    };
    return collectPlaywrightSpecs(reportJson.suites ?? []);
  };

  let executedSpecs = loadExecutedSpecs();
  const hasAllReferencedSpecs = allVerifiedRows.every((row) => {
    const normalizedBasename = row.specFile.replace(/\\/g, "/").split("/").pop()!;
    return executedSpecs.some(
      (s) =>
        (s.file === row.specFile || s.file.endsWith(normalizedBasename)) &&
        s.title === row.testName,
    );
  });

  if (!hasAllReferencedSpecs) {
    const specFiles = Array.from(new Set(allVerifiedRows.map((r) => r.specFile)));
    console.log(
      "[scorecard] Partial or missing Playwright JSON report detected; running CP3/CP4 Playwright E2E suite to refresh report...",
    );
    execSync(`pnpm playwright test ${specFiles.join(" ")}`, {
      cwd: rootDir,
      stdio: "inherit",
    });
    executedSpecs = loadExecutedSpecs();
  }

  const errors: string[] = [];

  const verifyRowGroup = (
    rows: ScorecardRow[],
    expectedPrefix: string,
    expectedStatus: string,
  ) => {
    for (const row of rows) {
      if (!row.id.startsWith(expectedPrefix)) {
        errors.push(`Row "${row.id}" does not start with ${expectedPrefix}`);
      }
      if (row.status !== expectedStatus) {
        errors.push(
          `Row ${row.id} (${row.capability}) has status "${row.status}" instead of "${expectedStatus}"`,
        );
      }
      const absSpecPath = resolve(rootDir, row.specFile);
      if (!existsSync(absSpecPath)) {
        errors.push(
          `Row ${row.id} (${row.capability}) references missing spec file "${row.specFile}"`,
        );
        continue;
      }

      const specSource = readFileSync(absSpecPath, "utf8");
      if (!specSource.includes(row.testName)) {
        errors.push(
          `Row ${row.id} (${row.capability}): test name "${row.testName}" not found in source file "${row.specFile}"`,
        );
      }

      const normalizedBasename = row.specFile
        .replace(/\\/g, "/")
        .split("/")
        .pop()!;
      const matchingReportSpec = executedSpecs.find(
        (s) =>
          (s.file === row.specFile || s.file.endsWith(normalizedBasename)) &&
          s.title === row.testName,
      );

      if (!matchingReportSpec) {
        errors.push(
          `Row ${row.id} (${row.capability}): test "${row.testName}" (${row.specFile}) was not found in ${reportPath}`,
        );
      } else if (!matchingReportSpec.passed) {
        errors.push(
          `Row ${row.id} (${row.capability}): test "${row.testName}" (${row.specFile}) did not pass in latest Playwright report`,
        );
      }
    }
  };

  verifyRowGroup(cp3Rows, "CP3-", "verified: CP3");
  verifyRowGroup(cp4Rows, "CP4-", "verified: CP4");

  for (const cells of oosRawRows) {
    const id = cells[0] ?? "";
    const decision = cells[2] ?? "";
    if (decision !== "out-of-scope") {
      errors.push(
        `Out-of-scope row ${id} has decision "${decision}" instead of "out-of-scope"`,
      );
    }
  }

  if (errors.length > 0) {
    console.error("[scorecard] FAIL:");
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log(
    `[scorecard] PASS: ${cp3Rows.length} CP3 Build Rows verified green, ${cp4Rows.length} CP4 Run Rows verified green against Playwright report, ${oosRawRows.length} Explicit Out-of-Scope Rows documented.`,
  );
}

main();
