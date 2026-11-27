import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

export const OFFLINE_HYPOTHESES = ["H0", "H1", "H2", "H3", "H5", "H6", "H7", "H8", "H9"] as const;
export const LIVE_HYPOTHESES = ["H10", "H11", "H12"] as const;
export const TIMED_OFFLINE_HYPOTHESES = new Set<string>(["H2", "H7"]);

function sha256Text(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function walkFiles(baseRoot: string, subDir: string, filterExt?: RegExp): string[] {
  const absDir = resolve(baseRoot, subDir);
  if (!existsSync(absDir)) return [];
  let stat;
  try {
    stat = statSync(absDir);
  } catch {
    return [];
  }
  if (stat.isFile()) {
    return [relative(baseRoot, absDir).replace(/\\/g, "/")];
  }
  if (!stat.isDirectory()) return [];

  const results: string[] = [];
  const entries = readdirSync(absDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const childRel = `${subDir}/${entry.name}`.replace(/\\/g, "/");
    if (entry.isDirectory()) {
      results.push(...walkFiles(baseRoot, childRel, filterExt));
    } else if (entry.isFile()) {
      if (!filterExt || filterExt.test(entry.name)) {
        results.push(childRel);
      }
    }
  }
  return results;
}

function collectTrackedInputFiles(repoRoot: string): string[] {
  const tracked = new Set<string>([
    "hypotheses.json",
    "ported-tests.json",
    "h6-denial-tests.json",
    "h8-entity-tests.json",
    "packages/assembler/catalog.generated.ts",
  ]);

  const codeFilter = /\.(ts|tsx|sql|json)$/;
  for (const file of walkFiles(repoRoot, "test", codeFilter)) {
    tracked.add(file);
  }

  const packagesDir = resolve(repoRoot, "packages");
  if (existsSync(packagesDir)) {
    for (const pkgEntry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!pkgEntry.isDirectory() || pkgEntry.name === "node_modules") continue;
      for (const file of walkFiles(repoRoot, `packages/${pkgEntry.name}/src`, codeFilter)) {
        tracked.add(file);
      }
      for (const file of walkFiles(repoRoot, `packages/${pkgEntry.name}/test`, codeFilter)) {
        tracked.add(file);
      }
    }
  }

  const provenBricks = ["credit-wallet", "multi-workspace", "dynamic-entities"];
  for (const brickId of provenBricks) {
    for (const sub of ["src", "test", "client", "migrations"]) {
      for (const file of walkFiles(repoRoot, `bricks/${brickId}/${sub}`, codeFilter)) {
        tracked.add(file);
      }
    }
    const manifestRel = `bricks/${brickId}/brick.manifest.json`;
    if (existsSync(resolve(repoRoot, manifestRel))) {
      tracked.add(manifestRel);
    }
  }

  const bricksDir = resolve(repoRoot, "bricks");
  if (existsSync(bricksDir)) {
    for (const brickEntry of readdirSync(bricksDir, { withFileTypes: true })) {
      if (!brickEntry.isDirectory() || brickEntry.name === "node_modules") continue;
      const manifestRel = `bricks/${brickEntry.name}/brick.manifest.json`;
      if (existsSync(resolve(repoRoot, manifestRel))) {
        tracked.add(manifestRel);
      }
    }
  }

  return [...tracked].sort();
}

export interface InputsHashComputation {
  inputsHash: string;
  fileHashes: Record<string, string>;
}

export function computeInputsHash(rootDir: string, fallbackRootDir?: string): InputsHashComputation {
  const baseForDiscovery = fallbackRootDir && existsSync(resolve(fallbackRootDir, "packages")) ? fallbackRootDir : rootDir;
  const relFiles = new Set<string>(collectTrackedInputFiles(baseForDiscovery));
  if (fallbackRootDir && resolve(rootDir) !== resolve(fallbackRootDir)) {
    for (const extra of collectTrackedInputFiles(rootDir)) {
      relFiles.add(extra);
    }
  }

  const sortedFiles = [...relFiles].sort();
  const fileHashes: Record<string, string> = {};
  const manifestLines: string[] = [];

  for (const rel of sortedFiles) {
    const primaryPath = resolve(rootDir, rel);
    const fallbackPath = fallbackRootDir ? resolve(fallbackRootDir, rel) : undefined;
    let targetPath: string | undefined;
    if (existsSync(primaryPath) && statSync(primaryPath).isFile()) {
      targetPath = primaryPath;
    } else if (fallbackPath && existsSync(fallbackPath) && statSync(fallbackPath).isFile()) {
      targetPath = fallbackPath;
    }
    if (!targetPath) continue;

    const hash = sha256Text(readFileSync(targetPath, "utf8"));
    fileHashes[rel] = hash;
    manifestLines.push(`${rel}:${hash}\n`);
  }

  const inputsHash = sha256Text(manifestLines.join(""));
  return { inputsHash, fileHashes };
}

export function findModifiedInputFiles(rootDir: string, fallbackRootDir?: string, baselineFileHashes?: Record<string, string>): string[] {
  const current = computeInputsHash(rootDir, fallbackRootDir).fileHashes;
  const baseline = baselineFileHashes ?? (fallbackRootDir ? computeInputsHash(fallbackRootDir).fileHashes : {});
  const allKeys = new Set<string>([...Object.keys(current), ...Object.keys(baseline)]);
  const changed: string[] = [];
  for (const key of [...allKeys].sort()) {
    if (current[key] !== baseline[key]) {
      changed.push(key);
    }
  }
  return changed;
}
