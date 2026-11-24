// Node-side helpers: write an assembled project to disk with a record of every file's hash, and later check that the
// folder still matches that record. They run before and after the tests (see global-setup.ts); a workerd test has no
// file system, so it can only import what this step has already written.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { hashFiles } from "../../packages/assembler/src/hash.ts";

export const OUT_DIR = resolve(import.meta.dirname, "..", "..", "out");

export interface Comparison {
  unchanged: boolean;
  /** How many files the comparison read back from disk. */
  checked: number;
  /** Files whose content differs from what was recorded. */
  changed: string[];
  /** Files that were recorded and are no longer there. */
  missing: string[];
  /** Files that are there and were never recorded. */
  extra: string[];
}

/** Writes the files to `dir` (replacing whatever was there) and returns each file's hash. `dir` must be inside out/. */
export async function writeProject(dir: string, files: Record<string, string>, outDir = OUT_DIR): Promise<Record<string, string>> {
  const target = resolve(dir);
  if (!target.startsWith(resolve(outDir) + sep)) throw new Error(`refusing to write outside ${outDir}: ${target}`);
  const expectedHashes = await hashFiles(files);
  if (existsSync(target)) {
    try {
      const existing = await compareProject(target, expectedHashes);
      if (existing.unchanged && existing.checked === Object.keys(files).length) {
        return expectedHashes;
      }
    } catch {
      // Fall through and rewrite the folder cleanly.
    }
  }
  rmSync(target, { recursive: true, force: true });
  for (const [path, text] of Object.entries(files)) {
    const file = resolve(target, path);
    if (!file.startsWith(target + sep)) throw new Error(`file path leaves the project folder: ${path}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return expectedHashes;
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((entry) => statSync(join(dir, entry)).isFile())
    .map((entry) => entry.split(sep).join("/"))
    .sort();
}

/** Re-reads every file under `dir` and compares it with the recorded hashes. */
export async function compareProject(dir: string, recorded: Record<string, string>): Promise<Comparison> {
  const onDisk = listFiles(dir);
  const current = await hashFiles(Object.fromEntries(onDisk.map((path) => [path, readFileSync(join(dir, path), "utf8")])));
  const changed = Object.keys(recorded).filter((path) => path in current && current[path] !== recorded[path]);
  const missing = Object.keys(recorded).filter((path) => !(path in current));
  const extra = Object.keys(current).filter((path) => !(path in recorded));
  return { unchanged: changed.length + missing.length + extra.length === 0, checked: onDisk.length, changed, missing, extra };
}

const defaultRecordDir = () => (process.env.POC_EVIDENCE_DIR ? resolve(process.env.POC_EVIDENCE_DIR) : OUT_DIR);
export const hashesPath = (project: string, outDir = defaultRecordDir()) => {
  mkdirSync(outDir, { recursive: true });
  return join(outDir, `${project}.hashes.json`);
};
export const verifiedPath = (project: string, outDir = defaultRecordDir()) => {
  mkdirSync(outDir, { recursive: true });
  return join(outDir, `${project}.verified.json`);
};
export const relativeToRepo = (path: string) => relative(resolve(OUT_DIR, ".."), path).split(sep).join("/");
