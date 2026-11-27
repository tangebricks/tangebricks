#!/usr/bin/env node
/**
 * scripts/check-licenses.ts
 *
 * Fails closed on dependency licences. Reads `pnpm licenses list --json` (all dependencies, dev included) and
 * exits 1 if any package carries a licence that is not on the allowlist and not covered by a named exception.
 *
 * SPDX handling: parentheses are stripped, the expression is split on ` OR ` (any allowed branch passes), and each
 * branch is split on ` AND ` (every part must be allowed). Licences are allowed by SPDX id, not by package name, so
 * platform binaries that differ between Windows dev boxes and Linux CI resolve the same way.
 *
 * Usage:
 *   node scripts/check-licenses.ts
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface LicensePackage {
  name: string;
  versions: string[];
}

/** Shape of `pnpm licenses list --json`: licence string -> packages carrying it. */
export type LicenseMap = Record<string, LicensePackage[]>;

export interface Offender {
  name: string;
  version: string;
  license: string;
}

export const ALLOWED_LICENSES: ReadonlySet<string> = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "MPL-2.0",
  "CC0-1.0",
  "CC-BY-4.0",
  "Unlicense",
  "MIT-0",
  "BlueOak-1.0.0",
  "Python-2.0",
  "Zlib",
]);

export interface LicenseException {
  /** Exact package name, or a prefix when `prefix` is true. */
  match: string;
  prefix?: boolean;
  /** The licence string this exception covers; anything else on the package is still checked normally. */
  license: string;
  reason: string;
}

export const LICENSE_EXCEPTIONS: readonly LicenseException[] = [
  {
    match: "@img/sharp-",
    prefix: true,
    license: "Apache-2.0 AND LGPL-3.0-or-later",
    reason: "sharp platform binaries bundle libvips (LGPL-3.0-or-later), dynamically linked; LGPL permits this use.",
  },
  {
    match: "@img/sharp-libvips-",
    prefix: true,
    license: "LGPL-3.0-or-later",
    reason: "Prebuilt libvips shared library loaded dynamically by sharp (Linux CI resolves these); LGPL permits this use.",
  },
  {
    match: "splaytree-ts",
    license: "BDS-3-Clause",
    reason: "Typo for BSD-3-Clause in the package manifest; upstream licence file is BSD-3-Clause.",
  },
  {
    match: "wellknown",
    license: "BSD",
    reason: "Non-SPDX 'BSD' in the package manifest; the shipped LICENSE file is WTFPL-2.0 (permissive, no conditions).",
  },
];

function findException(name: string, license: string): LicenseException | undefined {
  return LICENSE_EXCEPTIONS.find((e) => e.license === license && (e.prefix ? name.startsWith(e.match) : name === e.match));
}

/**
 * True when the SPDX expression is satisfiable using only allowlisted licences. Respects parentheses; AND binds
 * tighter than OR. Malformed input (unbalanced parentheses, dangling operators, empty) returns false.
 */
export function isAllowedExpression(expression: string): boolean {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let pos = 0;
  // Grammar: or := and ("OR" and)* ; and := atom ("AND" atom)* ; atom := "(" or ")" | licence-id
  const parseOr = (): boolean | null => {
    let result = parseAnd();
    if (result === null) return null;
    while (tokens[pos] === "OR") {
      pos++;
      const rhs = parseAnd();
      if (rhs === null) return null;
      result = result || rhs;
    }
    return result;
  };
  const parseAnd = (): boolean | null => {
    let result = parseAtom();
    if (result === null) return null;
    while (tokens[pos] === "AND") {
      pos++;
      const rhs = parseAtom();
      if (rhs === null) return null;
      result = result && rhs;
    }
    return result;
  };
  const parseAtom = (): boolean | null => {
    const token = tokens[pos++];
    if (token === undefined || token === ")" || token === "AND" || token === "OR") return null;
    if (token === "(") {
      const inner = parseOr();
      if (inner === null || tokens[pos++] !== ")") return null;
      return inner;
    }
    return ALLOWED_LICENSES.has(token);
  };
  const result = parseOr();
  return result === true && pos === tokens.length;
}

/** Pure check: returns every package whose licence is neither allowed nor excepted. */
export function checkLicenses(map: LicenseMap): Offender[] {
  const offenders: Offender[] = [];
  for (const [license, packages] of Object.entries(map)) {
    if (isAllowedExpression(license)) continue;
    for (const pkg of packages) {
      if (findException(pkg.name, license)) continue;
      offenders.push({ name: pkg.name, version: pkg.versions.join(", "), license });
    }
  }
  return offenders;
}

export function countPackages(map: LicenseMap): number {
  return Object.values(map).reduce((n, pkgs) => n + pkgs.length, 0);
}

function main(): void {
  const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const raw = execFileSync("pnpm licenses list --json", {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: true,
  });
  const map = JSON.parse(raw) as LicenseMap;
  const offenders = checkLicenses(map);
  const total = countPackages(map);
  if (total === 0) {
    console.error("licenses:check FAILED — `pnpm licenses list --json` returned no packages; refusing to pass an empty check.");
    process.exit(1);
  }
  if (offenders.length > 0) {
    console.error(`licenses:check FAILED — ${offenders.length} of ${total} packages have a licence that is not allowed:`);
    for (const o of offenders) {
      console.error(`  ${o.name}@${o.version}: ${o.license}`);
    }
    console.error("Add the licence to ALLOWED_LICENSES or a named, reasoned entry to LICENSE_EXCEPTIONS in scripts/check-licenses.ts.");
    process.exit(1);
  }
  console.log(`licenses:check OK — ${total} packages checked, all licences allowed.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
