import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DuplicatePackageGroup {
  name: string;
  dirs: string[];
}

export interface LintWorkspaceResult {
  ok: boolean;
  checked: number;
  globs: string[];
  duplicates: DuplicatePackageGroup[];
}

export function parseWorkspaceGlobs(yamlText: string): string[] {
  const lines = yamlText.split(/\r?\n/);
  const globs: string[] = [];
  let inPackages = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "");
    if (!line.trim()) continue;

    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }

    if (inPackages) {
      const itemMatch = line.match(/^\s*-\s*['"]?([^'"]+?)['"]?\s*$/);
      if (itemMatch && itemMatch[1]) {
        globs.push(itemMatch[1].trim());
        continue;
      }
      if (/^\S/.test(line)) {
        inPackages = false;
      }
    }
  }

  return globs;
}

function expandWorkspaceGlob(rootDir: string, pattern: string): string[] {
  const normalized = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized.endsWith("/*")) {
    const parentRel = normalized.slice(0, -2);
    const parentAbs = resolve(rootDir, parentRel);
    if (!existsSync(parentAbs) || !statSync(parentAbs).isDirectory()) {
      return [];
    }
    return readdirSync(parentAbs)
      .map((entry) => join(parentAbs, entry))
      .filter((entryPath) => {
        try {
          return statSync(entryPath).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  }

  const candidate = resolve(rootDir, normalized);
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    return [candidate];
  }
  return [];
}

export function lintWorkspace(rootDir: string): LintWorkspaceResult {
  const workspaceFile = resolve(rootDir, "pnpm-workspace.yaml");
  if (!existsSync(workspaceFile)) {
    throw new Error(`Missing pnpm-workspace.yaml at ${workspaceFile}`);
  }

  const yamlText = readFileSync(workspaceFile, "utf8");
  const globs = parseWorkspaceGlobs(yamlText);
  const byName = new Map<string, string[]>();
  const seenDirs = new Set<string>();
  let checked = 0;

  for (const glob of globs) {
    for (const dirAbs of expandWorkspaceGlob(rootDir, glob)) {
      if (seenDirs.has(dirAbs)) continue;
      seenDirs.add(dirAbs);

      const pkgJsonPath = join(dirAbs, "package.json");
      if (!existsSync(pkgJsonPath)) continue;

      const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { name?: unknown };
      if (typeof parsed.name !== "string" || parsed.name.trim() === "") continue;

      checked += 1;
      const relDir = relative(rootDir, dirAbs).replace(/\\/g, "/");
      const list = byName.get(parsed.name) ?? [];
      list.push(relDir);
      byName.set(parsed.name, list);
    }
  }

  const duplicates: DuplicatePackageGroup[] = [];
  for (const [name, dirs] of byName.entries()) {
    if (dirs.length > 1) {
      duplicates.push({ name, dirs: [...dirs].sort() });
    }
  }
  duplicates.sort((a, b) => a.name.localeCompare(b.name));

  return {
    ok: duplicates.length === 0,
    checked,
    globs,
    duplicates,
  };
}

export function runCli(rootDir: string = process.cwd()): number {
  const result = lintWorkspace(rootDir);
  if (!result.ok) {
    for (const dup of result.duplicates) {
      console.error(`Duplicate workspace package name "${dup.name}" found in: ${dup.dirs.join(", ")}`);
    }
    return 1;
  }

  console.log(`Workspace package names are unique (${result.checked} packages across ${result.globs.join(", ")}).`);
  return 0;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const targetDir = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
  process.exitCode = runCli(targetDir);
}
