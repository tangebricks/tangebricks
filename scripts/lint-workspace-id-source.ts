/**
 * Fails when brick source reads a workspace id from the client (AD-V1). A handler takes the workspace from the
 * verified request context the workspace middleware sets (`c.get("ctx")`), never from the query string or the body.
 *
 * Flagged in every bricks/*\/src file:
 * - query: `req.query("workspaceId")` (any quote style), `req.queries("workspaceId")`, `req.query().workspaceId`,
 *   `req.valid("query").workspaceId` and `const { workspaceId } = c.req.query()`
 * - body-read: `.workspaceId` read off `body`, `json`, `data`, `input`, `payload`, any `<x>.data` (`parsed.data`,
 *   `result.data`), `(await c.req.json())` or `c.req.valid("json" | "form")`
 * - body-destructure: `{ workspaceId } = body | json | ... | await c.req.json()`
 * - zod-schema: a `workspaceId:` key inside `z.object(...)`
 *
 * A file may be allowed a rule only through EXEMPTIONS below, each with its reason.
 *
 * Usage: node scripts/lint-workspace-id-source.ts [--bricks-dir <dir>]
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface SourceFile {
  /** Path used in the report (repo-relative, forward slashes). */
  path: string;
  text: string;
}

export interface ClientWorkspaceRead {
  file: string;
  line: number;
  rule: "query" | "body-read" | "body-destructure" | "zod-schema";
  snippet: string;
}

/** A file that is allowed one rule, with the reason. */
export interface Exemption {
  file: string;
  rule: ClientWorkspaceRead["rule"] | "*";
  reason: string;
}

const SERVICE_INPUT = "service-layer argument: `input` is the typed object the route handler built from c.get(\"ctx\"), not request data";
const WORKFLOW_INPUT = "workflow node input, story 1.1: the runtime feeds it from the trigger, not from an HTTP request";

export const EXEMPTIONS: readonly Exemption[] = [
  {
    file: "bricks/multi-workspace/src/foreign-workspace.ts",
    rule: "query",
    reason: "rejectForeignWorkspace: the one shared check that compares a caller-named workspace with ctx.workspaceId and refuses a mismatch with 403; the id is never used",
  },
  {
    file: "bricks/multi-workspace/src/foreign-workspace.ts",
    rule: "body-read",
    reason: "rejectForeignWorkspace: the one shared check that compares a caller-named workspace with ctx.workspaceId and refuses a mismatch with 403; the id is never used",
  },
  { file: "bricks/credit-wallet/src/brick.ts", rule: "zod-schema", reason: WORKFLOW_INPUT },
  { file: "bricks/credit-wallet/src/brick.ts", rule: "body-read", reason: WORKFLOW_INPUT },
  { file: "bricks/credit-wallet/src/index.ts", rule: "body-read", reason: WORKFLOW_INPUT },
  { file: "bricks/admin-console/src/admin.ts", rule: "body-read", reason: SERVICE_INPUT },
  { file: "bricks/audit-trail/src/audit.ts", rule: "body-read", reason: SERVICE_INPUT },
  { file: "bricks/checkout-gateway/src/checkout.ts", rule: "body-read", reason: SERVICE_INPUT },
  { file: "bricks/custom-domains/src/domains.ts", rule: "body-read", reason: SERVICE_INPUT },
  { file: "bricks/document-parsing/src/parser.ts", rule: "body-read", reason: SERVICE_INPUT },
  { file: "bricks/identity-federation/src/federation.ts", rule: "body-read", reason: SERVICE_INPUT },
  { file: "bricks/in-app-notifications/src/notifications.ts", rule: "body-read", reason: SERVICE_INPUT },
  { file: "bricks/live-chat/src/chat.ts", rule: "body-read", reason: SERVICE_INPUT },
  { file: "bricks/marketplace-splits/src/splits.ts", rule: "body-read", reason: SERVICE_INPUT },
  { file: "bricks/oauth-server/src/oauth.ts", rule: "body-read", reason: SERVICE_INPUT },
  { file: "bricks/outbound-webhooks/src/outbound.ts", rule: "body-read", reason: SERVICE_INPUT },
  { file: "bricks/product-analytics/src/analytics.ts", rule: "body-read", reason: SERVICE_INPUT },
  { file: "bricks/queue-jobs/src/jobs.ts", rule: "body-read", reason: SERVICE_INPUT },
  { file: "bricks/scripting-sandbox/src/sandbox.ts", rule: "body-read", reason: SERVICE_INPUT },
  { file: "bricks/user-onboarding/src/onboarding.ts", rule: "body-read", reason: SERVICE_INPUT },
  { file: "bricks/webhook-gateway/src/gateway.ts", rule: "body-read", reason: SERVICE_INPUT },
];

const RECEIVERS = String.raw`(?:body|json|data|input|payload)`;
const QUERY_PATTERNS: RegExp[] = [
  /\breq\.quer(?:y|ies)\(\s*(["'`])workspaceId\1\s*\)/,
  /\breq\.query\(\s*\)\??\.workspaceId\b/,
  /\breq\.valid\(\s*(["'`])query\1\s*\)\??\.workspaceId\b/,
  /\{[^{}]*\bworkspaceId\b[^{}]*\}\s*=\s*(?:await\s+)?(?:c\.)?req\.(?:query\(|valid\(\s*["'`]query)/,
];
const BODY_READS: RegExp[] = [
  new RegExp(String.raw`(?<![\w$.])${RECEIVERS}\??\.workspaceId\b`),
  /[\w$\])]\??\.data\??\.workspaceId\b/, // parsed.data, result.data, anything.data
  /\(\s*await\s+(?:c\.)?req\.json\(\s*\)\s*\)\??\.workspaceId\b/,
  /\breq\.valid\(\s*(["'`])(?:json|form)\1\s*\)\??\.workspaceId\b/,
  /\(\s*[\w$]+\s+as\s+[^()]*\)\??\.workspaceId\b/, // (body as { workspaceId?: unknown }).workspaceId
];
const BODY_DESTRUCTURE = new RegExp(
  String.raw`\{[^{}]*\bworkspaceId\b[^{}]*\}\s*=\s*(?:await\s+)?(?:${RECEIVERS}\b|[\w$]+\.data\b|(?:c\.)?req\.(?:json\(|valid\(\s*["'` + "`" + String.raw`](?:json|form)))`,
);

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Ranges [start, end) of every `z.object( ... )` argument list, matched by paren balance. */
function zodObjectRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /\bz\.object\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < text.length && depth > 0; i++) {
      const ch = text[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    ranges.push([start, i]);
  }
  return ranges;
}

function exempt(file: string, rule: ClientWorkspaceRead["rule"], exemptions: readonly Exemption[]): boolean {
  return exemptions.some((e) => e.file === file && (e.rule === "*" || e.rule === rule));
}

/** Every client workspace-id read in the given files. Pure: no I/O. */
export function findClientWorkspaceReads(files: readonly SourceFile[], exemptions: readonly Exemption[] = EXEMPTIONS): ClientWorkspaceRead[] {
  const out: ClientWorkspaceRead[] = [];
  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    const add = (rule: ClientWorkspaceRead["rule"], line: number) => {
      if (exempt(file.path, rule, exemptions)) return;
      if (out.some((r) => r.file === file.path && r.line === line && r.rule === rule)) return;
      out.push({ file: file.path, line, rule, snippet: (lines[line - 1] ?? "").trim() });
    };

    lines.forEach((text, i) => {
      if (/^\s*(?:\/\/|\*|\/\*)/.test(text)) return; // comments describe the rule; they do not break it
      if (QUERY_PATTERNS.some((p) => p.test(text))) add("query", i + 1);
      if (BODY_READS.some((p) => p.test(text))) add("body-read", i + 1);
      if (BODY_DESTRUCTURE.test(text)) add("body-destructure", i + 1);
    });

    for (const [start, end] of zodObjectRanges(file.text)) {
      const inner = file.text.slice(start, end);
      const key = /(?<![\w$.])workspaceId\s*\??\s*:/g;
      let k: RegExpExecArray | null;
      while ((k = key.exec(inner))) add("zod-schema", lineOf(file.text, start + k.index));
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function walkTs(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkTs(full, acc);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) acc.push(full);
  }
}

/** Reads `bricks/*\/src/**\/*.ts` under `bricksDir`. */
export function collectBrickSources(bricksDir: string, root: string = ROOT): SourceFile[] {
  const files: string[] = [];
  for (const brick of readdirSync(bricksDir).sort()) {
    const src = join(bricksDir, brick, "src");
    if (existsSync(src) && statSync(src).isDirectory()) walkTs(src, files);
  }
  return files.sort().map((full) => ({ path: relative(root, full).replace(/\\/g, "/"), text: readFileSync(full, "utf8") }));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let bricksDir = join(ROOT, "bricks");
  for (let i = 0; i < args.length; i++) if (args[i] === "--bricks-dir" && args[i + 1]) bricksDir = resolve(args[++i]!);

  const sources = collectBrickSources(bricksDir);
  const reads = findClientWorkspaceReads(sources);
  for (const e of EXEMPTIONS) console.log(`[workspace-id-lint] exempt ${e.file} (${e.rule}): ${e.reason}`);
  if (reads.length > 0) {
    console.error(`[workspace-id-lint] ${reads.length} client workspace-id read(s); take the workspace from c.get("ctx") instead:`);
    for (const r of reads) console.error(`${r.file}:${r.line} [${r.rule}] ${r.snippet}`);
    process.exit(1);
  }
  console.log(`[workspace-id-lint] OK: no client workspace-id reads in ${sources.length} brick source files.`);
}
