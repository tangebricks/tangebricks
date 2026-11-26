// Usage: node scripts/check-brick-claims.ts [--bricks-dir <dir>]
//
// Story 1.21: a brick's description must match its code. Every "stub / stubbed / synthetic / fake / not configured /
// quarantined" claim in a manifest's `description`, `ui.summary` or `ui.maturityReason` needs at least one
// `px-stub: <what>` code comment in that brick's `src`, placed at the stubbed code path; and a brick whose `src` has a
// `px-stub:` marker must say so in one of those texts. A brick can no longer claim a stub its code does not have, or
// hide one it does. An error code such as NOT_CONFIGURED (an honest route answer) is not a claim; "not configured"
// written as words is.
//
// Runs in CI through `pnpm catalog:conformance` (scripts/check-manifests.ts calls it) and on its own as
// `pnpm check:brick-claims`.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The words that claim a brick's code is not (fully) real. Matched case-insensitively as whole words. */
export const CLAIM_PATTERN = /\b(stub|stubs|stubbed|synthetic|fake|not configured|quarantined)\b/i;
/** A `px-stub:` marker inside a line or block comment, with the text after it. */
const MARKER_PATTERN = /(?:\/\/|\/\*|^\s*\*)\s*px-stub:(.*)$/;
const SOURCE_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs)$/;
const CLAIM_FIELDS = ["description", "ui.summary", "ui.maturityReason"] as const;

export interface BrickClaimViolation {
  brick: string;
  detail: string;
}

export interface BrickStubMarker {
  file: string;
  line: number;
  what: string;
}

function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (SOURCE_EXTENSIONS.test(name)) out.push(full);
  }
  return out;
}

/** Every `px-stub:` comment in a brick's `src`, with its file (relative to the brick) and line. */
export function findStubMarkers(brickDir: string): BrickStubMarker[] {
  const markers: BrickStubMarker[] = [];
  for (const file of listSourceFiles(join(brickDir, "src"))) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, index) => {
      const match = MARKER_PATTERN.exec(text);
      if (match) {
        markers.push({
          file: relative(brickDir, file).replace(/\\/g, "/"),
          line: index + 1,
          what: match[1]!.replace(/\*\/\s*$/, "").trim(),
        });
      }
    });
  }
  return markers;
}

function readField(manifest: Record<string, unknown>, field: (typeof CLAIM_FIELDS)[number]): string | undefined {
  const [head, tail] = field.split(".") as [string, string | undefined];
  const value = tail === undefined ? manifest[head] : (manifest[head] as Record<string, unknown> | undefined)?.[tail];
  return typeof value === "string" ? value : undefined;
}

/** The claims and markers of one brick directory (one holding `brick.manifest.json`). */
export function checkBrickClaims(brickDir: string, brickName: string): BrickClaimViolation[] {
  const manifestPath = join(brickDir, "brick.manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  const brick = typeof manifest.id === "string" ? manifest.id : brickName;

  const claims: Array<{ field: string; word: string }> = [];
  for (const field of CLAIM_FIELDS) {
    const text = readField(manifest, field);
    const match = text === undefined ? null : CLAIM_PATTERN.exec(text);
    if (match) claims.push({ field, word: match[1]! });
  }
  const markers = findStubMarkers(brickDir);
  const violations: BrickClaimViolation[] = [];

  for (const marker of markers) {
    if (marker.what.length === 0) {
      violations.push({ brick, detail: `${marker.file}:${marker.line} has an empty "px-stub:" marker; say what is stubbed ("px-stub: <what>")` });
    }
  }
  if (claims.length > 0 && markers.length === 0) {
    for (const claim of claims) {
      violations.push({
        brick,
        detail: `${claim.field} claims "${claim.word}" but no "px-stub: <what>" marker is in ${brick}/src; mark the stubbed code path or correct the text to say what the code does`,
      });
    }
  }
  if (claims.length === 0 && markers.length > 0) {
    for (const marker of markers) {
      violations.push({
        brick,
        detail: `${marker.file}:${marker.line} has "px-stub: ${marker.what}" but no description, ui.summary or ui.maturityReason says stub, synthetic, fake, not configured or quarantined`,
      });
    }
  }
  return violations;
}

/** Every brick under `bricksDir` (each subdirectory with a `brick.manifest.json`). */
export function checkAllBrickClaims(bricksDir = join(ROOT, "bricks")): BrickClaimViolation[] {
  if (!existsSync(bricksDir)) return [];
  const violations: BrickClaimViolation[] = [];
  for (const name of readdirSync(bricksDir).sort()) {
    const full = join(bricksDir, name);
    if (statSync(full).isDirectory() && existsSync(join(full, "brick.manifest.json"))) {
      violations.push(...checkBrickClaims(full, name));
    }
  }
  return violations;
}

export function formatBrickClaimViolation(v: BrickClaimViolation): string {
  return `${v.brick}: brick-claims: ${v.detail}`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dirIndex = args.indexOf("--bricks-dir");
  const bricksDir = dirIndex >= 0 && args[dirIndex + 1] ? resolve(args[dirIndex + 1]!) : join(ROOT, "bricks");
  const violations = checkAllBrickClaims(bricksDir);
  for (const v of violations) console.error(formatBrickClaimViolation(v));
  if (violations.length === 0) console.log("[check:brick-claims] every stub claim has a px-stub marker in src, and every marker a claim");
  process.exit(violations.length > 0 ? 1 : 0);
}
