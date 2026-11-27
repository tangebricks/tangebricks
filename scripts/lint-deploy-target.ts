import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DeployTargetLintIssue {
  file: string;
  line: number;
  rule: "FORBIDDEN_CLOUDFLARE_ENV_READ" | "FORBIDDEN_HARDCODED_ACCOUNT_ID" | "FAKE_CONTROL_PLANE_IN_PRODUCTION_PATH";
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

const LEGACY_TEST_HARNESS_ADAPTERS = new Set(["packages/deploy/src/provisioner/credentials.ts"]);

const FORBIDDEN_ENV_PATTERNS: ReadonlyArray<{
  regex: RegExp;
  message: string;
}> = [
  {
    regex: /\bprocess\.env(?:\s*\.\s*|\s*\[\s*["'`])CLOUDFLARE_(?:ACCOUNT_ID|API_TOKEN|[A-Z0-9_]+)/,
    message: "Direct read of process.env.CLOUDFLARE_* is forbidden; use DeployTarget and TokenResolver",
  },
  {
    regex: /\b(?:c\.)?env(?:\s*\.\s*|\s*\[\s*["'`])CLOUDFLARE_(?:ACCOUNT_ID|API_TOKEN)\b/,
    message: "Reading CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN from Worker env is forbidden; use DeployTarget and TokenResolver",
  },
  {
    regex: /\bCLOUDFLARE_(?:ACCOUNT_ID|API_TOKEN)\b/,
    message: "Reference to CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN environment variable is forbidden in Studio deploy code",
  },
];

const HARDCODED_ACCOUNT_ID_REGEX = /\baccountId\s*[:=]\s*["'`][a-fA-F0-9]{32}["'`]/;

function stripCommentsFromLine(line: string): string {
  return line.replace(/\/\/.*$/, "");
}

export function scanSourceForForbiddenDeployEnvReads(source: string, filePath: string): DeployTargetLintIssue[] {
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
        message: "Hard-coded 32-char hex Cloudflare accountId is forbidden; pass accountId via DeployTarget",
      });
    }
  }

  return issues;
}

/**
 * Story R53: a production Studio build must not be able to construct the in-memory Cloudflare fake. Studio's source may name
 * MockCloudflareControlPlane only in its deploy-client module. There, the checks are structural, not substring matches:
 * - the fake may be constructed only (a) as the whole of a guard line `if (studioDeployClientMode(env) === "fake") return new
 *   MockCloudflareControlPlane();` or (b) inside getStudioFakeControlPlane, whose body must OPEN with the line
 *   `if (studioDeployClientMode(env) !== "fake") throw ...`;
 * - the accessor may be called only as the whole of a guard line `if (studioDeployClientMode(env) === "fake") return
 *   getStudioFakeControlPlane(accountId, env);` (nothing else on that line);
 * - the module must keep the fake to PX_ENVIRONMENT test/development (`FAKE_DEPLOY_CLIENT_ENVIRONMENTS = ["test", "development"]`).
 * Nothing else in Studio's source may name the fake, call the accessor, or construct ByocCloudflareTarget (whose defaults are the
 * fake and a made-up token resolver).
 */
export const STUDIO_SRC_PREFIX = "apps/studio-api/src/";
export const STUDIO_DEPLOY_CLIENT_FILE = "apps/studio-api/src/deploy-client.ts";
const GUARDED_CONSTRUCT = /^\s*if \(studioDeployClientMode\(env\) === "fake"\) return new MockCloudflareControlPlane\(\);\s*$/;
const GUARDED_ACCESSOR_CALL = /^\s*if \(studioDeployClientMode\(env\) === "fake"\) return getStudioFakeControlPlane\(accountId, env\);\s*$/;
const ACCESSOR_OPENING_GUARD = /^\s*if \(studioDeployClientMode\(env\) !== "fake"\) throw new StudioDeployClientConfigError\(/;
const ENVIRONMENTS_DEFINITION = /FAKE_DEPLOY_CLIENT_ENVIRONMENTS: readonly string\[\] = \["test", "development"\];/;

export function scanStudioSourceForFakeControlPlane(source: string, filePath: string): DeployTargetLintIssue[] {
  if (!filePath.startsWith(STUDIO_SRC_PREFIX)) return [];
  const issues: DeployTargetLintIssue[] = [];
  const lines = source.split(/\r?\n/);
  const issue = (idx: number, message: string) =>
    issues.push({ file: filePath, line: idx + 1, rule: "FAKE_CONTROL_PLANE_IN_PRODUCTION_PATH", snippet: (lines[idx] ?? "").trim(), message });
  if (filePath !== STUDIO_DEPLOY_CLIENT_FILE) {
    lines.forEach((raw, idx) => {
      const code = stripCommentsFromLine(raw);
      if (/\bMockCloudflareControlPlane\b/.test(code))
        issue(idx, "Studio may name MockCloudflareControlPlane only in src/deploy-client.ts, behind the PX_DEPLOY_CLIENT=fake check");
      // ByocCloudflareTarget defaults to the fake and to a made-up token resolver (cf_scoped_token_for_...): Studio never builds one.
      else if (/\bnew\s+ByocCloudflareTarget\b|\bByocCloudflareTarget\s*\.\s*create\s*\(/.test(code))
        issue(
          idx,
          "Studio must not construct ByocCloudflareTarget (its defaults are the fake and a made-up token); use createByocProvisioner with getStudioControlPlane and createStudioTokenResolver",
        );
      else if (/\bgetStudioFakeControlPlane\s*\(/.test(code))
        issue(idx, "Studio routes must reach Cloudflare through getStudioControlPlane(accountId, env, deps); the fake accessor is for tests");
    });
    return issues;
  }
  // The accessor's body: from its signature to the closing brace at column 0. Its first statement must be the guard.
  const accessorStart = lines.findIndex((l) => /^export function getStudioFakeControlPlane\s*\(/.test(l));
  let accessorEnd = -1;
  if (accessorStart >= 0) {
    accessorEnd = lines.findIndex((l, i) => i > accessorStart && l.startsWith("}"));
    // The first statement, which may be wrapped over several lines: the code lines up to the first one ending in ";".
    const bodyCode = lines
      .slice(accessorStart + 1)
      .map((l) => stripCommentsFromLine(l).trim())
      .filter((l) => l !== "");
    const statementEnd = bodyCode.findIndex((l) => l.endsWith(";"));
    const firstStatement = statementEnd < 0 ? undefined : bodyCode.slice(0, statementEnd + 1).join(" ");
    if (!firstStatement || !ACCESSOR_OPENING_GUARD.test(firstStatement)) {
      issue(accessorStart, 'getStudioFakeControlPlane must open with if (studioDeployClientMode(env) !== "fake") throw new StudioDeployClientConfigError(...)');
    }
  }
  const insideAccessor = (idx: number) => accessorStart >= 0 && idx > accessorStart && (accessorEnd < 0 || idx < accessorEnd);
  lines.forEach((raw, idx) => {
    const code = stripCommentsFromLine(raw);
    if (/\bnew\s+MockCloudflareControlPlane\s*\(/.test(code) && !insideAccessor(idx) && !GUARDED_CONSTRUCT.test(code)) {
      issue(
        idx,
        'the fake may be constructed only on a line that is exactly: if (studioDeployClientMode(env) === "fake") return new MockCloudflareControlPlane();',
      );
    }
    if (/\bgetStudioFakeControlPlane\s*\(/.test(code) && idx !== accessorStart && !GUARDED_ACCESSOR_CALL.test(code)) {
      issue(
        idx,
        'the fake accessor may be called only on a line that is exactly: if (studioDeployClientMode(env) === "fake") return getStudioFakeControlPlane(accountId, env);',
      );
    }
  });
  if (!ENVIRONMENTS_DEFINITION.test(source)) {
    issues.push({
      file: filePath,
      line: 1,
      rule: "FAKE_CONTROL_PLANE_IN_PRODUCTION_PATH",
      snippet: "",
      message: 'deploy-client.ts must keep the fake to PX_ENVIRONMENT test/development (FAKE_DEPLOY_CLIENT_ENVIRONMENTS = ["test", "development"])',
    });
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
      issues.push(...scanStudioSourceForFakeControlPlane(source, relFile));
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
      console.error(`[lint-deploy-target] ${issue.file}:${issue.line} (${issue.rule}): ${issue.message}\n  > ${issue.snippet}`);
    }
    return 1;
  }

  console.log(
    `[lint-deploy-target] OK (${result.scannedFiles.length} files scanned across ${DEFAULT_SCAN_DIRS.join(", ")}; 0 forbidden CLOUDFLARE_* env reads, hard-coded account IDs or fake control planes reachable in production).`,
  );
  return 0;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const targetDir = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
  process.exitCode = runCli(targetDir);
}
