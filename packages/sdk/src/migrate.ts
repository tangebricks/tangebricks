import type { D1Like } from "./d1.ts";

/**
 * Splits a SQL string into individual executable statements using a single-pass tokenizer.
 * Properly tracks single-quoted strings (with '' escapes), double-quoted identifiers (with "" escapes),
 * backtick identifiers (with `` escapes), bracket identifiers ([...]), line comments (--...),
 * block comments (/*...*\/), CREATE [TEMP] TRIGGER blocks with internal semicolons, and CASE...END expressions.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  const len = sql.length;

  let sawCreate = false;
  let inCreateTrigger = false;
  let triggerDepth = 0;
  let caseDepth = 0;

  while (i < len) {
    const ch = sql[i]!;

    // 1. Single-quote string literal '...'
    if (ch === "'") {
      current += "'";
      i++;
      while (i < len) {
        if (sql[i] === "'") {
          current += "'";
          if (i + 1 < len && sql[i + 1] === "'") {
            current += "'";
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          current += sql[i]!;
          i++;
        }
      }
      continue;
    }

    // 2. Double-quote identifier "..."
    if (ch === '"') {
      current += '"';
      i++;
      while (i < len) {
        if (sql[i] === '"') {
          current += '"';
          if (i + 1 < len && sql[i + 1] === '"') {
            current += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          current += sql[i]!;
          i++;
        }
      }
      continue;
    }

    // 3. Backtick identifier `...`
    if (ch === "`") {
      current += "`";
      i++;
      while (i < len) {
        if (sql[i] === "`") {
          current += "`";
          if (i + 1 < len && sql[i + 1] === "`") {
            current += "`";
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          current += sql[i]!;
          i++;
        }
      }
      continue;
    }

    // 4. Bracket identifier [...]
    if (ch === "[") {
      current += "[";
      i++;
      while (i < len) {
        if (sql[i] === "]") {
          current += "]";
          if (i + 1 < len && sql[i + 1] === "]") {
            current += "]";
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          current += sql[i]!;
          i++;
        }
      }
      continue;
    }

    // 5. Line comment --...
    if (ch === "-" && i + 1 < len && sql[i + 1] === "-") {
      i += 2;
      while (i < len && sql[i] !== "\n" && sql[i] !== "\r") {
        i++;
      }
      if (i < len && sql[i] === "\r" && i + 1 < len && sql[i + 1] === "\n") {
        i += 2;
      } else if (i < len && (sql[i] === "\r" || sql[i] === "\n")) {
        i++;
      }
      current += "\n";
      continue;
    }

    // 6. Block comment /*...*/
    if (ch === "/" && i + 1 < len && sql[i + 1] === "*") {
      i += 2;
      while (i < len) {
        if (sql[i] === "*" && i + 1 < len && sql[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      current += " ";
      continue;
    }

    // 7. Semicolon delimiter
    if (ch === ";") {
      if (triggerDepth === 0) {
        const stmt = current.trim();
        if (stmt.length > 0) {
          statements.push(stmt);
        }
        current = "";
        sawCreate = false;
        inCreateTrigger = false;
        caseDepth = 0;
      } else {
        current += ";";
      }
      i++;
      continue;
    }

    // 8. Word tokens for trigger and CASE tracking
    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      while (i < len && /[a-zA-Z0-9_]/.test(sql[i]!)) {
        i++;
      }
      const rawWord = sql.slice(start, i);
      const upper = rawWord.toUpperCase();
      current += rawWord;

      if (triggerDepth === 0) {
        if (upper === "CREATE") {
          sawCreate = true;
        } else if (sawCreate && (upper === "TEMP" || upper === "TEMPORARY")) {
          // sawCreate remains true
        } else if (sawCreate && upper === "TRIGGER") {
          inCreateTrigger = true;
          sawCreate = false;
        } else if (inCreateTrigger && upper === "BEGIN") {
          triggerDepth++;
          inCreateTrigger = false;
        } else if (upper === "CASE") {
          caseDepth++;
        } else if (upper === "END") {
          if (caseDepth > 0) {
            caseDepth--;
          }
        } else if (sawCreate) {
          sawCreate = false;
        }
      } else {
        if (upper === "CASE") {
          caseDepth++;
        } else if (upper === "END") {
          if (caseDepth > 0) {
            caseDepth--;
          } else {
            triggerDepth--;
          }
        }
      }
      continue;
    }

    // 9. All other characters (whitespace, punctuation, numbers, etc.)
    current += ch;
    i++;
  }

  // Trailing statement without semicolon
  const trailing = current.trim();
  if (trailing.length > 0) {
    statements.push(trailing);
  }

  return statements;
}

export async function applyMigration(db: D1Like, sql: string): Promise<number> {
  const statements = splitStatements(sql);
  for (const statement of statements) await db.prepare(statement).run();
  return statements.length;
}
