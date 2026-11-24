import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DeployTargetLintIssue {
  file: string;
  line: number;
  rule: "FORBIDDEN_CLOUDFLARE_ENV_READ" | "FORBIDDEN_HARDCODED_ACCOUNT_ID";
  snippet: string;
  message: string;
}

export interface LintDeployTargetResult {
  ok: boolean;
  scannedFiles: string[];
  exemptedHarnessFiles: string[];
  issues: DeployTargetLintIssue[];
}

const DEFAULT_SCAN_DIRS = ["packages/deploy/src", "apps/studio-api/src"] as const;

const LEGACY_TEST_HARNESS_ADAPTERS = new Set([
  "packages/deploy/src/provisioner/credentials.ts",
]);

const FORBIDDEN_ENV_PATTERNS: ReadonlyArray<{
  regex: RegExp;
  message: string;
}> = [
  {
    regex: /\bprocess\.env(?:\s*\.\s*|\s*\[\s*["'`])CLOUDFLARE_(?:ACCOUNT_ID|API_TOKEN|[A-Z0-9_]+)/,
    message:
      "Direct read of process.env.CLOUDFLARE_* is forbidden; use DeployTarget and TokenResolver",
  },
  {
    regex: /\b(?:c\.)?env(?:\s*\.\s*|\s*\[\s*["'`])CLOUDFLARE_(?:ACCOUNT_ID|API_TOKEN)\b/,
    message:
      "Reading CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN from Worker env is forbidden; use DeployTarget and TokenResolver",
  },
  {
    regex: /\bCLOUDFLARE_(?:ACCOUNT_ID|API_TOKEN)\b/,
    message:
      "Reference to CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN environment variable is forbidden in Studio deploy code",
  },
];

const HARDCODED_ACCOUNT_ID_REGEX =
  /\baccountId\s*[:=]\s*["'`][a-fA-F0-9]{32}["'`]/;

function stripCommentsFromLine(line: string): string {
  return line.replace(/\/\/.*$/, "");
}

export function scanSourceForForbiddenDeployEnvReads(
  source: string,
  filePath: string,
): DeployTargetLintIssue[] {
  const issues: DeployTargetLintIssue[] = [];
  const lines = source.split(/\r?\n/);

  for (let idx = 0; idx < lines.length; idx += 1) {
    const rawLine = lines[idx] ?? "";
    const codeLine = stripCommentsFromLine(rawLine);
    if (!codeLine.trim()) continue;

    let matchedEnvRule = false;
    for (const pattern of FORBIDDEN_ENV_PATTERNS) {
      if (pattern.regex.test(codeLine)) {
        issues.push({
          file: filePath,
          line: idx + 1,
          rule: "FORBIDDEN_CLOUDFLARE_ENV_READ",
          snippet: rawLine.trim(),
          message: pattern.message,
        });
        matchedEnvRule = true;
        break;
      }
    }

    if (!matchedEnvRule && HARDCODED_ACCOUNT_ID_REGEX.test(codeLine)) {
      issues.push({
        file: filePath,
        line: idx + 1,
        rule: "FORBIDDEN_HARDCODED_ACCOUNT_ID",
        snippet: rawLine.trim(),
        message:
          "Hard-coded 32-char hex Cloudflare accountId is forbidden; pass accountId via DeployTarget",
      });
    }
  }

  return issues;
}

function collectTypeScriptFiles(dirAbs: string): string[] {
  if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) {
    return [];
  }
  const results: string[] = [];
  for (const entry of readdirSync(dirAbs)) {
    const fullPath = join(dirAbs, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...collectTypeScriptFiles(fullPath));
    } else if (stat.isFile() && (entry.endsWith(".ts") || entry.endsWith(".tsx"))) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

export function lintDeployTarget(rootDir: string = process.cwd()): LintDeployTargetResult {
  const scannedFiles: string[] = [];
  const exemptedHarnessFiles: string[] = [];
  const issues: DeployTargetLintIssue[] = [];

  for (const relScanDir of DEFAULT_SCAN_DIRS) {
    const absDir = resolve(rootDir, relScanDir);
    for (const absFile of collectTypeScriptFiles(absDir)) {
      const relFile = relative(rootDir, absFile).replace(/\\/g, "/");
      if (LEGACY_TEST_HARNESS_ADAPTERS.has(relFile)) {
        exemptedHarnessFiles.push(relFile);
        continue;
      }
      scannedFiles.push(relFile);
      const source = readFileSync(absFile, "utf8");
      issues.push(...scanSourceForForbiddenDeployEnvReads(source, relFile));
    }
  }

  return {
    ok: issues.length === 0,
    scannedFiles,
    exemptedHarnessFiles,
    issues,
  };
}

export function runCli(rootDir: string = process.cwd()): number {
  const result = lintDeployTarget(rootDir);
  if (!result.ok) {
    for (const issue of result.issues) {
      console.error(
        `[lint-deploy-target] ${issue.file}:${issue.line} (${issue.rule}): ${issue.message}\n  > ${issue.snippet}`,
      );
    }
    return 1;
  }

  console.log(
    `[lint-deploy-target] OK (${result.scannedFiles.length} files scanned across ${DEFAULT_SCAN_DIRS.join(", ")}; 0 forbidden CLOUDFLARE_* env reads or hard-coded account IDs).`,
  );
  return 0;
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const targetDir = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
  process.exitCode = runCli(targetDir);
}
