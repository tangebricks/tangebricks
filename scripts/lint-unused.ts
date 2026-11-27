#!/usr/bin/env node
/**
 * scripts/lint-unused.ts
 *
 * Implements `pnpm lint:unused` (story 1.31): unused files, exports, types and dependencies, found by knip with the
 * repo's knip.ts. Fails (exit 1) on any finding that scripts/lint-unused-allowlist.ts does not accept by exact file,
 * kind and name, and on any allowlist entry that no longer matches a finding. Fails (exit 2) if knip itself fails.
 *
 * Every issue type knip reports counts (unused files, dependencies, unlisted dependencies, unresolved imports, exports,
 * types, duplicates, enum and namespace members, ...); only the allowlisted kinds can be accepted.
 *
 * Usage:
 *   node scripts/lint-unused.ts
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UNUSED_ALLOWLIST, type UnusedAllowance } from "./lint-unused-allowlist.ts";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** One finding: an issue kind, the file it is in (or the package.json for dependencies) and the symbol name. */
export interface UnusedFinding {
  readonly kind: string;
  readonly file: string;
  readonly name: string;
}

interface KnipSymbol {
  readonly name: string;
}

/** The shape of `knip --reporter json`: one object per file, one array per issue type. */
export interface KnipJsonReport {
  readonly issues: ReadonlyArray<{ readonly file: string } & Record<string, unknown>>;
}

/** Flattens knip's JSON report into findings. A duplicates entry becomes one finding named "a|b" (sorted). */
export function findingsOf(report: KnipJsonReport): UnusedFinding[] {
  const findings: UnusedFinding[] = [];
  for (const issue of report.issues) {
    for (const [kind, value] of Object.entries(issue)) {
      if (kind === "file" || kind === "owners" || !Array.isArray(value)) continue;
      for (const item of value as unknown[]) {
        const name = Array.isArray(item)
          ? (item as KnipSymbol[])
              .map((s) => s.name)
              .sort()
              .join("|")
          : (item as KnipSymbol).name;
        findings.push({ kind, file: issue.file, name });
      }
    }
  }
  return findings;
}

export interface UnusedCheck {
  /** Findings no allowlist entry accepts. */
  readonly unexpected: UnusedFinding[];
  /** Allowlist names that match no finding (the code was fixed, or the entry is wrong). */
  readonly stale: UnusedFinding[];
}

/** Compares the findings with the allowlist, by exact file, kind and name. */
export function checkUnused(findings: readonly UnusedFinding[], allowlist: readonly UnusedAllowance[]): UnusedCheck {
  const key = (f: UnusedFinding) => `${f.kind}\u0000${f.file}\u0000${f.name}`;
  const allowed = new Map<string, UnusedFinding>();
  for (const entry of allowlist) {
    if (entry.reason.trim().length === 0) throw new Error(`lint-unused-allowlist: ${entry.file} (${entry.kind}) has no reason`);
    for (const name of entry.names) {
      const f = { kind: entry.kind, file: entry.file, name };
      allowed.set(key(f), f);
    }
  }
  const found = new Set(findings.map(key));
  return {
    unexpected: findings.filter((f) => !allowed.has(key(f))),
    stale: [...allowed.values()].filter((f) => !found.has(key(f))),
  };
}

const LABEL: Record<string, string> = {
  files: "unused file",
  dependencies: "unused dependency",
  devDependencies: "unused devDependency",
  optionalPeerDependencies: "unused optional peer dependency",
  unlisted: "unlisted dependency",
  binaries: "unlisted binary",
  unresolved: "unresolved import",
  exports: "unused export",
  nsExports: "unused export in namespace",
  types: "unused exported type",
  nsTypes: "unused exported type in namespace",
  enumMembers: "unused enum member",
  namespaceMembers: "unused namespace member",
  duplicates: "duplicate export",
  catalog: "unused catalog entry",
  catalogReferences: "unresolved catalog reference",
  subpaths: "unused subpath export",
  cycles: "circular dependency",
};

export function formatFinding(f: UnusedFinding): string {
  return `${LABEL[f.kind] ?? f.kind}: ${f.file}: ${f.name}`;
}

/** Runs knip over the repo and returns its JSON report. Throws if knip fails or prints something that is not JSON. */
export function runKnip(root: string = repoRoot): KnipJsonReport {
  const knipBin = resolve(root, "node_modules", "knip", "bin", "knip.js");
  const result = spawnSync(process.execPath, [knipBin, "--no-progress", "--reporter", "json", "--no-exit-code"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`knip failed (exit ${result.status ?? result.signal}):\n${result.stderr}${result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout) as KnipJsonReport;
  } catch {
    throw new Error(`knip printed something that is not its JSON report:\n${result.stdout}\n${result.stderr}`);
  }
}

function main(): void {
  let report: KnipJsonReport;
  try {
    report = runKnip();
  } catch (error) {
    console.error(`LINT_UNUSED_KNIP_FAILED: ${(error as Error).message}`);
    process.exit(2);
  }
  const { unexpected, stale } = checkUnused(findingsOf(report), UNUSED_ALLOWLIST);
  for (const f of unexpected) console.error(formatFinding(f));
  for (const f of stale) console.error(`stale allowlist entry (no such finding any more): ${formatFinding(f)}`);
  if (unexpected.length > 0 || stale.length > 0) {
    console.error(
      `\nlint:unused: ${unexpected.length} finding(s), ${stale.length} stale allowlist entr${stale.length === 1 ? "y" : "ies"}. ` +
        "Delete what is unused, or unexport it. If it must stay, add an exact entry with a reason to " +
        "scripts/lint-unused-allowlist.ts (see CONTRIBUTING.md, Unused code); remove allowlist entries that no longer match.",
    );
    process.exit(1);
  }
  console.log(`lint:unused: no unused files, exports or dependencies (${UNUSED_ALLOWLIST.length} allowlisted entries).`);
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
