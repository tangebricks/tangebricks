import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { getAllTenantTables } from "./lib/tenant-tables.ts";

// Tenant query lint (AD-V2).
//
// Every SQL string in `bricks/*/src` that touches a tenant table (a table whose migration has a `workspace_id` column
// and which no manifest declares in `globalTables`) must carry a `workspace_id` predicate:
//   * SELECT / UPDATE / DELETE: the WHERE (or JOIN ... ON) clause of the query level that names the table compares
//     `workspace_id` (`workspace_id = ?`, `x.workspace_id IN (...)`, `? = workspace_id`);
//   * INSERT: `workspace_id` is in the column list.
// The check reads string and template literals wherever they are (including `a + b` concatenations), so it applies to
// `db.prepare(...)`, `scoped(...).raw(...)`, `global(...).raw(...)` and `systemScope(...).raw(...)` alike. Calls to the
// `global(db, table, reason)` and `systemScope(db, reason)` helpers with a tenant table are checked too: a reason makes
// the bypass explicit, it does not make it safe.
//
// An exemption is named, and must give a reason:
//   * an allowlist entry `{ "file": "bricks/x/src/y.ts", "table": "x_rows", "reason": "..." }`, or
//   * an inline `// tenant-lint: allow <reason>` comment directly above the query (or above the statement or array
//     element that holds it).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ALLOWLIST_PATH = join(ROOT, "scripts", "tenant-lint-allowlist.json");

export interface TenantLintViolation {
  file: string;
  line: number;
  table: string;
  message: string;
}

export interface AllowlistEntry {
  file: string;
  table: string;
  reason: string;
}

export interface TenantLintResult {
  violations: TenantLintViolation[];
  allowlistEntries: AllowlistEntry[];
  /** Inline `tenant-lint: allow` exemptions that suppressed at least one finding. */
  inlineExemptions: Array<{ file: string; line: number; table: string; reason: string }>;
  totalScannedFiles: number;
  totalBricks: number;
}

export function loadAllowlist(allowlistPath: string): {
  entries: AllowlistEntry[];
  errors: string[];
} {
  const errors: string[] = [];
  if (!existsSync(allowlistPath)) {
    return { entries: [], errors };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(allowlistPath, "utf8"));
  } catch (err) {
    errors.push(`invalid JSON in allowlist '${allowlistPath}': ${(err as Error).message}`);
    return { entries: [], errors };
  }

  const entries: AllowlistEntry[] = [];
  if (!Array.isArray(raw)) {
    errors.push("allowlist must be an array of { file, table, reason } entries");
    return { entries, errors };
  }
  for (const item of raw) {
    const obj = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const file = typeof obj.file === "string" ? obj.file.replace(/\\/g, "/").trim() : "";
    const table = typeof obj.table === "string" ? obj.table.trim() : "";
    const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
    if (!file) errors.push(`Allowlist entry ${JSON.stringify(item)} has no file`);
    if (!table) errors.push(`Allowlist entry for '${file}' names no table`);
    if (!reason) errors.push(`Allowlist entry for '${file}' (${table}) has an empty reason`);
    entries.push({ file, table, reason });
  }
  return { entries, errors };
}

function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listSourceFiles(full));
    } else if ((entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) && !entry.name.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------------------------------------------------
// SQL analysis

// A bound value: a positional or named parameter, or a template substitution.
const BOUND = String.raw`(?:\?\d*|[:@$][A-Za-z_][A-Za-z0-9_]*|\$\{\.\.\.\})`;
const COLUMN = String.raw`(?:([A-Za-z_][A-Za-z0-9_]*)\.)?workspace_id`;
const VALUE_PREDICATES = [
  new RegExp(String.raw`^${COLUMN}\s*==?\s*${BOUND}$`, "i"),
  new RegExp(String.raw`^${BOUND}\s*==?\s*${COLUMN}$`, "i"),
  new RegExp(String.raw`^${COLUMN}\s+IN\s*\(\s*${BOUND}(?:\s*,\s*${BOUND})*\s*\)$`, "i"),
];
const JOIN_EQUALITY = new RegExp(String.raw`^${COLUMN}\s*==?\s*${COLUMN}$`, "i");
/** Any table at this query level: an unqualified `workspace_id = ?` binds whichever table owns the column. */
const ANY_TABLE = "*";

/** Splits `text` on a keyword (AND / OR) at parenthesis depth 0. */
function splitTopLevel(text: string, keyword: "AND" | "OR"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  const re = new RegExp(String.raw`\b${keyword}\b`, "iy");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0) {
      re.lastIndex = i;
      if (re.test(text) && (i === 0 || /\W/.test(text[i - 1]!))) {
        parts.push(text.slice(start, i));
        start = i + keyword.length;
        i = start - 1;
      }
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** `( ... )` wrapping the whole text, returned without the outer parentheses. */
function unwrapParens(text: string): string | undefined {
  if (!text.startsWith("(") || !text.endsWith(")")) return undefined;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    if (depth === 0 && i < text.length - 1) return undefined;
  }
  return text.slice(1, -1).trim();
}

/**
 * The names (alias or table, lower-cased, or ANY_TABLE) whose `workspace_id` the condition binds to a value on every
 * path: OR needs the binding on each side, AND needs it on one conjunct, and a join equality `a.workspace_id =
 * b.workspace_id` passes a binding from one side to the other. `IS [NOT] NULL` and comparisons with another column
 * never bind.
 */
export function boundNames(condition: string): Set<string> {
  const disjuncts = splitTopLevel(condition, "OR");
  if (disjuncts.length > 1) {
    const sets = disjuncts.map((d) => boundNames(d));
    return new Set([...sets[0]!].filter((n) => sets.every((s) => s.has(n))));
  }
  const bound = new Set<string>();
  const joins: Array<[string, string]> = [];
  const conjuncts = splitTopLevel(condition, "AND");
  while (conjuncts.length > 0) {
    const conjunct = conjuncts.shift()!;
    const inner = unwrapParens(conjunct);
    if (inner !== undefined) {
      // A parenthesised AND-group is flattened into this one (so its join equalities still propagate); a group with
      // a top-level OR is evaluated on its own.
      if (splitTopLevel(inner, "OR").length === 1) conjuncts.push(...splitTopLevel(inner, "AND"));
      else for (const n of boundNames(inner)) bound.add(n);
      continue;
    }
    for (const re of VALUE_PREDICATES) {
      const m = conjunct.match(re);
      if (m) bound.add((m[1] ?? m[2] ?? ANY_TABLE).toLowerCase());
    }
    const j = conjunct.match(JOIN_EQUALITY);
    if (j) joins.push([(j[1] ?? ANY_TABLE).toLowerCase(), (j[2] ?? ANY_TABLE).toLowerCase()]);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [a, b] of joins) {
      if (bound.has(a) && !bound.has(b)) {
        bound.add(b);
        changed = true;
      }
      if (bound.has(b) && !bound.has(a)) {
        bound.add(a);
        changed = true;
      }
    }
  }
  return bound;
}

const CLAUSE_END = String.raw`(?=\b(?:GROUP\s+BY|ORDER\s+BY|LIMIT|RETURNING|HAVING|UNION|WINDOW|(?:LEFT|RIGHT|INNER|CROSS|FULL|OUTER)\b|JOIN|WHERE|ON)\b|$)`;
const NOT_ALIAS = /^(WHERE|ON|SET|JOIN|LEFT|RIGHT|INNER|CROSS|FULL|OUTER|GROUP|ORDER|LIMIT|RETURNING|VALUES|USING|AS|NATURAL|UNION)$/i;

/** The WHERE and JOIN ... ON conditions of one query level, joined with AND. */
function levelConditions(level: string): string {
  const conditions: string[] = [];
  for (const m of level.matchAll(new RegExp(String.raw`\b(WHERE|ON)\b([\s\S]*?)${CLAUSE_END}`, "gi"))) {
    const text = m[2]!.trim();
    if (text && !/^CONFLICT\b/i.test(text)) conditions.push(`(${text})`);
  }
  return conditions.join(" AND ");
}

/** True when the reference to `table` at `refEnd` (alias may follow) is bound to a workspace at its query level. */
function tableIsBound(level: string, table: string, aliasText: string): boolean {
  const alias = aliasText.match(/^\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i)?.[1];
  const names = new Set([table.toLowerCase(), ANY_TABLE]);
  if (alias && !NOT_ALIAS.test(alias)) names.add(alias.toLowerCase());
  const bound = boundNames(levelConditions(level));
  return [...names].some((n) => bound.has(n));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replaces quoted SQL strings with blanks of the same length, so a table name inside a string value is not read. */
function blankSqlStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, (m) => " ".repeat(m.length));
}

/** For each index, the index of the "(" that opens the paren group around it, or -1 at top level. */
function enclosingParens(sql: string): { openAt: number[]; closeOf: Map<number, number> } {
  const openAt: number[] = Array.from({ length: sql.length }, () => -1);
  const closeOf = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === ")") {
      const open = stack.pop();
      if (open !== undefined) closeOf.set(open, i);
    }
    openAt[i] = stack.length ? stack[stack.length - 1]! : -1;
    if (ch === "(") stack.push(i);
  }
  for (const open of stack) closeOf.set(open, sql.length);
  return { openAt, closeOf };
}

/**
 * The text of the query level that holds position `pos`: the enclosing paren group (or the whole string), with any
 * nested sub-select blanked out so its WHERE cannot satisfy the outer query, and vice versa.
 */
function queryLevelText(sql: string, pos: number, parens: ReturnType<typeof enclosingParens>): string {
  const open = parens.openAt[pos]!;
  const start = open + 1;
  const end = open === -1 ? sql.length : (parens.closeOf.get(open) ?? sql.length);
  let out = "";
  let i = start;
  while (i < end) {
    if (sql[i] === "(") {
      const close = parens.closeOf.get(i) ?? end;
      const inner = sql.slice(i + 1, close);
      if (/^\s*(SELECT|WITH)\b/i.test(inner)) {
        out += " ".repeat(close - i + 1);
      } else {
        out += sql.slice(i, Math.min(close + 1, end));
      }
      i = close + 1;
      continue;
    }
    out += sql[i];
    i++;
  }
  return out;
}

/**
 * A string is read as SQL when it starts (after whitespace, parentheses or a leading template substitution) with a
 * statement or clause keyword. That keeps prose such as an error message ("Could not update credit_ledger row") out.
 */
export function looksLikeSql(text: string): boolean {
  return /^[\s(]*(?:\$\{\.\.\.\}[\s(]*)*(SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH|FROM|JOIN|WHERE)\b/i.test(text);
}

export interface SqlFinding {
  table: string;
  /** Character offset in the SQL text, for locating the line. */
  offset: number;
  kind: "read-or-write" | "insert";
}

/**
 * Returns every reference to a tenant table in `sql` that is not guarded by a workspace predicate.
 * `sql` is a literal's text, with template substitutions written as `${...}`.
 */
export function findUnscopedTableRefs(sql: string, tenantTables: Iterable<string>): SqlFinding[] {
  const text = blankSqlStrings(sql);
  const parens = enclosingParens(text);
  const findings: SqlFinding[] = [];

  for (const table of tenantTables) {
    const ref = new RegExp(`\\b(FROM|JOIN|UPDATE|INTO)\\s+["\`]?${escapeRegex(table)}["\`]?(?![A-Za-z0-9_])`, "gi");
    for (const match of text.matchAll(ref)) {
      const keyword = match[1]!.toUpperCase();
      const at = match.index!;
      if (keyword === "INTO") {
        // INSERT/REPLACE ... INTO t (cols): workspace_id must be one of the columns.
        const after = text.slice(at + match[0].length);
        const cols = after.match(/^\s*\(([^)]*)\)/);
        if (!cols || !/\bworkspace_id\b/i.test(cols[1]!)) {
          findings.push({ table, offset: at, kind: "insert" });
        }
        continue;
      }
      // `UPDATE` inside `ON CONFLICT ... DO UPDATE SET` is not a table reference.
      if (keyword === "UPDATE" && /\bDO\s*$/i.test(text.slice(0, at))) continue;
      // DELETE FROM / SELECT ... FROM / JOIN / UPDATE: the table's workspace_id bound to a value at this query level.
      const level = queryLevelText(text, at, parens);
      const aliasText = text.slice(at + match[0].length, at + match[0].length + 40);
      if (!tableIsBound(level, table, aliasText)) {
        findings.push({ table, offset: at, kind: "read-or-write" });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------------------------------
// TypeScript traversal

/** The text of a string-ish expression: literals, templates (`${...}` kept as-is) and `+` concatenations of them. */
function stringText(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) out += "${...}" + span.literal.text;
    return out;
  }
  if (ts.isParenthesizedExpression(node)) return stringText(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = stringText(node.left);
    const right = stringText(node.right);
    if (left === undefined && right === undefined) return undefined;
    return (left ?? "${...}") + (right ?? "${...}");
  }
  return undefined;
}

function isStringRoot(node: ts.Node): node is ts.Expression {
  if (!(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || ts.isBinaryExpression(node))) {
    return false;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return false;
  // Only the outermost piece of a concatenation is a root.
  let parent = node.parent;
  while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
  if (parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken) return false;
  // The table and reason arguments of global(db, table, reason) / systemScope(db, reason) are prose, not queries.
  if (parent && ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && ["global", "systemScope"].includes(parent.expression.text)) {
    return false;
  }
  // Import specifiers and the like are not queries.
  if (parent && (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent))) return false;
  return true;
}

const ALLOW_COMMENT = /^\/\/\s*tenant-lint:\s*allow\b(.*)$/;

/**
 * Looks for a `// tenant-lint: allow <reason>` comment in the block of comment lines directly above `line` (0-based).
 * Returns the reason ("" when the comment has none), or undefined when there is no comment.
 */
function allowCommentAbove(lines: string[], line: number): string | undefined {
  for (let l = line - 1; l >= 0; l--) {
    const trimmed = (lines[l] ?? "").trim();
    if (!trimmed.startsWith("//")) return undefined;
    const match = trimmed.match(ALLOW_COMMENT);
    if (match) return (match[1] ?? "").trim();
  }
  return undefined;
}

/**
 * The lines an exemption comment may sit above for `node`: its own line, and the start line of each ancestor up to the
 * enclosing statement (stopping at an array element, so one comment above `db.batch([` does not cover every query in
 * the batch).
 */
function candidateLines(node: ts.Node, sf: ts.SourceFile): number[] {
  const lines = new Set<number>();
  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) {
    lines.add(sf.getLineAndCharacterOfPosition(current.getStart(sf)).line);
    if (ts.isStatement(current) || ts.isClassElement(current) || ts.isPropertyAssignment(current)) break;
    if (current.parent && ts.isArrayLiteralExpression(current.parent)) break;
    current = current.parent;
  }
  return [...lines];
}

type HelperKind = { kind: "global"; table: string } | { kind: "system" };

/**
 * Resolves `global(db, "t", r)`, `systemScope(db, r)`, or an identifier or `this.<field>` bound to one of them in the
 * same file.
 */
function helperOf(expr: ts.Expression, bindings: Map<string, HelperKind>): HelperKind | undefined {
  while (ts.isParenthesizedExpression(expr) || ts.isAwaitExpression(expr)) expr = expr.expression;
  if (ts.isIdentifier(expr)) return bindings.get(expr.text);
  if (ts.isPropertyAccessExpression(expr) && expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
    return bindings.get(`this.${expr.name.text}`);
  }
  if (!ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression)) return undefined;
  const name = expr.expression.text;
  if (name === "systemScope") return { kind: "system" };
  if (name === "global") {
    const tableArg = expr.arguments[1];
    if (tableArg && (ts.isStringLiteral(tableArg) || ts.isNoSubstitutionTemplateLiteral(tableArg))) {
      return { kind: "global", table: tableArg.text };
    }
  }
  return undefined;
}

function objectHasWorkspaceId(node: ts.Expression | undefined): boolean {
  if (!node || !ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some((p) => {
    if (ts.isSpreadAssignment(p)) return false;
    const name = p.name;
    return !!name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "workspace_id";
  });
}

/** A helper's `where` argument binds `table`'s workspace_id to a value (see boundNames). */
function whereHasPredicate(node: ts.Expression | undefined, table: string): boolean {
  if (!node) return false;
  const text = stringText(node);
  if (text === undefined) return false;
  const bound = boundNames(blankSqlStrings(text));
  return bound.has(table.toLowerCase()) || bound.has(ANY_TABLE);
}

export function lintTenantQueries(options?: { bricksDir?: string; allowlistPath?: string }): TenantLintResult {
  const bricksDir = options?.bricksDir ?? join(ROOT, "bricks");
  const allowlistPath = options?.allowlistPath ?? DEFAULT_ALLOWLIST_PATH;

  const { entries: allowlistEntries, errors: allowlistErrors } = loadAllowlist(allowlistPath);
  const violations: TenantLintViolation[] = [];
  const inlineExemptions: TenantLintResult["inlineExemptions"] = [];

  for (const err of allowlistErrors) {
    violations.push({ file: allowlistPath, line: 1, table: "<allowlist>", message: `${allowlistPath}:1 allowlist error: ${err}` });
  }

  const brickTablesMap = getAllTenantTables(bricksDir);
  // A brick may read another brick's tables, so every brick is checked against every tenant table.
  const tenantTables = new Set<string>();
  for (const info of brickTablesMap.values()) for (const t of info.tenantTables) tenantTables.add(t);

  let totalScannedFiles = 0;
  if (tenantTables.size === 0) {
    return { violations, allowlistEntries, inlineExemptions, totalScannedFiles, totalBricks: brickTablesMap.size };
  }

  for (const brickInfo of brickTablesMap.values()) {
    const sourceFiles = listSourceFiles(join(brickInfo.brickDir, "src"));
    totalScannedFiles += sourceFiles.length;

    for (const filePath of sourceFiles) {
      const content = readFileSync(filePath, "utf8");
      const lines = content.split(/\r?\n/);
      const relPath = relative(ROOT, filePath).replace(/\\/g, "/");
      const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
      const seen = new Set<string>();

      const report = (node: ts.Node, table: string, line: number, what: string) => {
        const key = `${line}:${table}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (allowlistEntries.some((e) => e.table === table && (e.file === relPath || relPath.endsWith(`/${e.file}`)))) return;
        for (const candidate of [line - 1, ...candidateLines(node, sf)]) {
          const reason = allowCommentAbove(lines, candidate);
          if (reason === undefined) continue;
          if (reason) {
            inlineExemptions.push({ file: relPath, line, table, reason });
            return;
          }
          violations.push({ file: relPath, line, table, message: `${relPath}:${line} ${table} (tenant-lint: allow needs a reason)` });
          return;
        }
        violations.push({ file: relPath, line, table, message: `${relPath}:${line} ${table} ${what}` });
      };

      // Identifiers, class fields (`this.x`) and typed parameters bound to global(...) / systemScope(...) in this file.
      const bindings = new Map<string, HelperKind>();
      const collect = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const helper = helperOf(node.initializer, new Map());
          if (helper) bindings.set(node.name.text, helper);
        }
        if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const helper = helperOf(node.initializer, new Map());
          if (helper) bindings.set(`this.${node.name.text}`, helper);
        }
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(node.left) &&
          node.left.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
          const helper = helperOf(node.right, new Map());
          if (helper) bindings.set(`this.${node.left.name.text}`, helper);
        }
        // A parameter typed SystemScopeDb is a systemScope() handle whose table is named per call.
        if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type && /\bSystemScopeDb\b/.test(node.type.getText(sf))) {
          bindings.set(node.name.text, { kind: "system" });
        }
        ts.forEachChild(node, collect);
      };
      collect(sf);

      const visit = (node: ts.Node) => {
        // 1. SQL text in string literals, templates and concatenations.
        if (isStringRoot(node)) {
          const text = stringText(node);
          if (text !== undefined) {
            // A call argument that contains a sub-select or FROM (a helper's where clause, say) is read as SQL too.
            const isCallArgument = !!node.parent && ts.isCallExpression(node.parent) && node.parent.arguments.includes(node as ts.Expression);
            const sql = looksLikeSql(text) || (isCallArgument && /\b(SELECT|FROM)\b/.test(text));
            for (const f of sql ? findUnscopedTableRefs(text, tenantTables) : []) {
              const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
              report(node, f.table, line, f.kind === "insert" ? "(INSERT without a workspace_id column)" : "(no workspace_id predicate in WHERE)");
            }
            return; // the pieces of a concatenation are covered by its root
          }
        }

        // 2. global(db, table, reason) whose table is not a literal cannot be checked, so it is a violation unless exempted.
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "global") {
          const tableArg = node.arguments[1];
          if (tableArg && !(ts.isStringLiteral(tableArg) || ts.isNoSubstitutionTemplateLiteral(tableArg))) {
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            report(node, "<non-literal table>", line, "(global() with a table that is not a string literal cannot be checked)");
          }
        }

        // 3. Helper methods on global(db, table, reason) and systemScope(db, reason).
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text;
          const helper = helperOf(node.expression.expression, bindings);
          if (helper && ["select", "first", "insert", "update", "delete"].includes(method)) {
            const first = node.arguments[0];
            const firstText = first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) ? first.text : undefined;
            // systemScope(...).method(table, ...) always names the table first; global(db, table, r).method(...) may
            // repeat it as an optional first argument (the SDK's overload), which is then skipped.
            const table = helper.kind === "global" ? helper.table : firstText;
            const namesTableFirst = helper.kind === "system" || firstText === helper.table;
            const args = namesTableFirst ? node.arguments.slice(1) : [...node.arguments];
            if (table && tenantTables.has(table)) {
              const ok =
                method === "insert"
                  ? objectHasWorkspaceId(args[0])
                  : method === "update"
                    ? whereHasPredicate(args[1], table)
                    : whereHasPredicate(args[0], table);
              if (!ok) {
                const line = sf.getLineAndCharacterOfPosition(node.expression.name.getStart(sf)).line + 1;
                const via = helper.kind === "global" ? "global()" : "systemScope()";
                report(node, table, line, `(${via}.${method} without a workspace_id predicate)`);
              }
            }
          }
        }

        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }

  return { violations, allowlistEntries, inlineExemptions, totalScannedFiles, totalBricks: brickTablesMap.size };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let bricksDir = join(ROOT, "bricks");
  let allowlistPath = DEFAULT_ALLOWLIST_PATH;
  const verbose = args.includes("--verbose");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--bricks-dir" && args[i + 1]) {
      bricksDir = resolve(args[++i]!);
    } else if (args[i] === "--allowlist" && args[i + 1]) {
      allowlistPath = resolve(args[++i]!);
    }
  }

  const result = lintTenantQueries({ bricksDir, allowlistPath });

  console.log(`[tenant-lint] Allowlist entries (${result.allowlistEntries.length}):`);
  if (result.allowlistEntries.length === 0) {
    console.log("  (none)");
  } else {
    for (const entry of result.allowlistEntries) {
      console.log(`  - ${entry.file} [${entry.table}]: ${entry.reason}`);
    }
  }
  console.log(`[tenant-lint] Inline exemptions: ${result.inlineExemptions.length}`);
  if (verbose) {
    for (const e of result.inlineExemptions) console.log(`  - ${e.file}:${e.line} [${e.table}]: ${e.reason}`);
  }

  if (result.violations.length > 0) {
    console.error(`\n[tenant-lint] Found ${result.violations.length} tenant query violation(s):`);
    for (const v of result.violations) {
      console.error(v.message);
    }
    process.exit(1);
  } else {
    console.log(`\n[tenant-lint] OK: 0 violations across ${result.totalBricks} bricks (${result.totalScannedFiles} files scanned).`);
    process.exit(0);
  }
}
