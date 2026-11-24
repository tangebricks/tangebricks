import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { encode } from "gpt-tokenizer/encoding/o200k_base";

// Token counting for H9. One function counts both sides of the comparison (the conversation and the code), so they can
// never be counted two different ways.

/** gpt-tokenizer 4.1.0 with the o200k_base encoding. A stand-in: Claude's tokenizer is not available offline, so absolute counts are estimates and only the ratio is judged. */
export const TOKENIZER = "gpt-tokenizer 4.1.0, o200k_base";
export const countTokens = (text: string): number => encode(text).length;

const repoRoot = resolve(import.meta.dirname, "..", "..");

export interface SourceFile {
  path: string;
  tokens: number;
  origin: "brick" | "generated";
  /** Set when this text is identical to a file already counted, so it is not counted again. */
  duplicateOf?: string;
}
export interface SourceCount {
  files: SourceFile[];
  /** The primary denominator: every distinct first-party text once. */
  total: number;
  /** The harsher denominator: only the files the assembler wrote, copies of brick files included. */
  generatedOnly: number;
  /** How many generated files were copies of brick files and so counted once, not twice. */
  deduplicated: number;
}

function listFiles(dir: string, keep: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((entry) => join(dir, entry))
    .filter((path) => statSync(path).isFile() && keep(path))
    .sort();
}

/**
 * The code a person or a model would otherwise have had to write or paste for this project, counted once each:
 *   - for each enabled brick, its source (src/**\/*.ts, tests excluded), its SQL migrations and its manifest;
 *   - every file the assembler wrote for the project.
 * Not counted, because it is not code anyone writes for the project: third-party packages (Hono, Zod), the shared SDK, the
 * brick's widget (the assembled project does not include it) and tests. Leaving those out makes the ratio worse, not better.
 */
export function firstPartySource(options: { packageDirs: string[]; generated: Record<string, string>; root?: string }): SourceCount {
  const root = options.root ?? repoRoot;
  const files: SourceFile[] = [];
  const seen = new Map<string, string>();
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");

  for (const dir of options.packageDirs) {
    const base = join(root, dir);
    const paths = [
      ...listFiles(join(base, "src"), (p) => p.endsWith(".ts") && !/\.(test|spec)\.ts$/.test(p)),
      ...listFiles(join(base, "migrations"), (p) => p.endsWith(".sql")),
      ...(existsSync(join(base, "brick.manifest.json")) ? [join(base, "brick.manifest.json")] : []),
    ];
    for (const path of paths) {
      const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
      const rel = relative(root, path).replaceAll("\\", "/");
      const key = hash(text);
      files.push({ path: rel, tokens: countTokens(text), origin: "brick", ...(seen.has(key) ? { duplicateOf: seen.get(key)! } : {}) });
      if (!seen.has(key)) seen.set(key, rel);
    }
  }
  let generatedOnly = 0;
  let deduplicated = 0;
  for (const [path, text] of Object.entries(options.generated).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const tokens = countTokens(text);
    generatedOnly += tokens;
    const key = hash(text);
    const duplicateOf = seen.get(key);
    files.push({ path: `generated:${path}`, tokens, origin: "generated", ...(duplicateOf ? { duplicateOf } : {}) });
    if (duplicateOf) deduplicated += 1;
    else seen.set(key, `generated:${path}`);
  }
  return { files, total: files.filter((f) => !f.duplicateOf).reduce((sum, f) => sum + f.tokens, 0), generatedOnly, deduplicated };
}
