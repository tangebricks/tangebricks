import { splitStatements } from "@poc/sdk";

export type DestructiveMigrationKind =
  | "drop_table"
  | "drop_column"
  | "type_narrowing"
  | "truncate"
  | "add_column_not_null"
  | "rename_table";

export interface DestructiveMigrationWarning {
  migrationName: string;
  statement: string;
  kind: DestructiveMigrationKind;
  affectedTable: string;
  affectedColumn?: string;
  message: string;
}

export type MigrationClass = "additive" | "rewrite" | "destructive";

export interface MigrationHeader {
  phase?: "expand" | "contract";
  expands?: string;
}

export interface MigrationLintResult {
  class: MigrationClass;
  findings: DestructiveMigrationWarning[];
  header?: MigrationHeader;
}

export function cleanSqlIdentifier(raw: string): string {
  const trimmed = raw.trim().replace(/^[`"[]+|[`"\]]+$/g, "");
  const parts = trimmed.split(".");
  return (parts[parts.length - 1] ?? trimmed).replace(/^[`"[]+|[`"\]]+$/g, "");
}

export interface ParsedSqlTypeInfo {
  base: string;
  rank: number;
  length: number | null;
}

export function parseSqlColumnType(rawType: string): ParsedSqlTypeInfo {
  const upper = rawType.trim().toUpperCase();
  const lenMatch = upper.match(
    /^(VARCHAR|CHAR|NVARCHAR|NCHAR|CHARACTER\s+VARYING)\s*\(\s*(\d+)\s*\)/,
  );
  if (lenMatch) {
    return {
      base: "VARCHAR",
      rank: 4,
      length: Number.parseInt(lenMatch[2]!, 10),
    };
  }
  if (
    upper.startsWith("TEXT") ||
    upper.startsWith("CLOB") ||
    upper.startsWith("JSON") ||
    upper.startsWith("BLOB") ||
    upper.startsWith("VARCHAR") ||
    upper.startsWith("NVARCHAR")
  ) {
    return { base: "TEXT", rank: 4, length: null };
  }
  if (
    upper.startsWith("REAL") ||
    upper.startsWith("DOUBLE") ||
    upper.startsWith("FLOAT") ||
    upper.startsWith("NUMERIC") ||
    upper.startsWith("DECIMAL")
  ) {
    return { base: "REAL", rank: 3, length: null };
  }
  if (upper.startsWith("BIGINT") || upper.startsWith("INT8")) {
    return { base: "BIGINT", rank: 2, length: null };
  }
  if (
    upper.startsWith("INTEGER") ||
    upper.startsWith("INT") ||
    upper.startsWith("MEDIUMINT")
  ) {
    return { base: "INTEGER", rank: 1, length: null };
  }
  if (
    upper.startsWith("SMALLINT") ||
    upper.startsWith("TINYINT") ||
    upper.startsWith("BOOLEAN") ||
    upper.startsWith("BOOL")
  ) {
    return { base: "SMALLINT", rank: 0, length: null };
  }
  return { base: upper.split(/\s+/)[0] ?? "TEXT", rank: 4, length: null };
}

export function isNarrowerSqlType(
  previousTypeRaw: string | undefined,
  nextTypeRaw: string,
): boolean {
  const nextInfo = parseSqlColumnType(nextTypeRaw);
  if (!previousTypeRaw) {
    return nextInfo.rank < 4 || nextInfo.length !== null;
  }
  const prevInfo = parseSqlColumnType(previousTypeRaw);
  if (nextInfo.rank < prevInfo.rank) {
    return true;
  }
  if (
    prevInfo.base === "TEXT" &&
    prevInfo.length === null &&
    nextInfo.length !== null
  ) {
    return true;
  }
  if (
    prevInfo.length !== null &&
    nextInfo.length !== null &&
    nextInfo.length < prevInfo.length
  ) {
    return true;
  }
  return false;
}

export function parseCreateTableColumns(
  statement: string,
): { tableName: string; columns: Record<string, string> } | null {
  const headerMatch = statement.match(
    /^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s*\(([\s\S]+)\)$/i,
  );
  if (!headerMatch) {
    return null;
  }
  const tableName = cleanSqlIdentifier(headerMatch[1]!);
  const body = headerMatch[2]!;
  const columns: Record<string, string> = {};

  const clauses: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      clauses.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) {
    clauses.push(current.trim());
  }

  for (const clause of clauses) {
    const upperClause = clause.toUpperCase();
    if (
      upperClause.startsWith("PRIMARY KEY") ||
      upperClause.startsWith("FOREIGN KEY") ||
      upperClause.startsWith("UNIQUE") ||
      upperClause.startsWith("CONSTRAINT") ||
      upperClause.startsWith("CHECK")
    ) {
      continue;
    }
    const colMatch = clause.match(
      /^([`"[]?[A-Za-z0-9_]+[`"\]]?)\s+([A-Za-z0-9_]+(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?)/,
    );
    if (colMatch) {
      const colName = cleanSqlIdentifier(colMatch[1]!);
      const colType = colMatch[2]!.trim().toUpperCase();
      columns[colName] = colType;
    }
  }

  return { tableName, columns };
}

export function parseMigrationHeader(sql: string): MigrationHeader | undefined {
  const lines = sql.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("--")) {
      const match = line.match(/^--\s*projectx:\s*(.+)$/i);
      if (match) {
        const rest = match[1]!;
        const phaseMatch = rest.match(/\bphase=(expand|contract)\b/i);
        const expandsMatch = rest.match(/\bexpands=([^\s]+)/i);
        return {
          phase: (phaseMatch?.[1]?.toLowerCase() as "expand" | "contract") ?? undefined,
          expands: expandsMatch?.[1] ?? undefined,
        };
      }
    } else {
      break;
    }
  }
  return undefined;
}

export type PriorSchemaInput =
  | Record<string, Record<string, string>>
  | string[]
  | ReadonlyArray<{ sql: string }>;

export function lintMigration(
  name: string,
  sql: string,
  priorSchema?: PriorSchemaInput,
): MigrationLintResult {
  const knownTables: Record<string, Record<string, string>> = {};
  if (priorSchema) {
    if (Array.isArray(priorSchema)) {
      for (const item of priorSchema) {
        const itemSql = typeof item === "string" ? item : (item as { sql: string }).sql;
        for (const stmt of splitStatements(itemSql)) {
          const parsed = parseCreateTableColumns(stmt);
          if (parsed) {
            knownTables[parsed.tableName] = {
              ...knownTables[parsed.tableName],
              ...parsed.columns,
            };
          }
          const addColMatch = stmt.match(
            /^ALTER\s+TABLE\s+([^\s]+)\s+ADD\s+(?:COLUMN\s+)?([^\s]+)\s+([A-Za-z0-9_]+(?:\s*\(\s*\d+\s*\))?)/i,
          );
          if (addColMatch) {
            const tbl = cleanSqlIdentifier(addColMatch[1]!);
            const col = cleanSqlIdentifier(addColMatch[2]!);
            const colType = addColMatch[3]!.trim().toUpperCase();
            knownTables[tbl] = {
              ...knownTables[tbl],
              [col]: colType,
            };
          }
        }
      }
    } else {
      for (const [tbl, cols] of Object.entries(priorSchema)) {
        knownTables[tbl] = { ...cols };
      }
    }
  }

  const statements = splitStatements(sql);
  const findings: DestructiveMigrationWarning[] = [];
  let hasRewrite = false;

  // Check if this migration uses SQLite table-rebuild pattern:
  // CREATE TABLE <temp> (...) ... DROP TABLE <orig> ... ALTER TABLE <temp> RENAME TO <orig>
  const createdInMigration = new Set<string>();
  const droppedInMigration = new Set<string>();
  const renamedFromTo = new Map<string, string>();
  for (const stmt of statements) {
    const created = parseCreateTableColumns(stmt);
    if (created) {
      createdInMigration.add(created.tableName);
    }
    const dropMatch = stmt.match(
      /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^\s;]+)/i,
    );
    if (dropMatch) {
      droppedInMigration.add(cleanSqlIdentifier(dropMatch[1]!));
    }
    const renameMatch = stmt.match(
      /^ALTER\s+TABLE\s+([^\s]+)\s+RENAME\s+TO\s+([^\s]+)$/i,
    );
    if (renameMatch) {
      const fromTable = cleanSqlIdentifier(renameMatch[1]!);
      const toTable = cleanSqlIdentifier(renameMatch[2]!);
      renamedFromTo.set(fromTable, toTable);
    }
  }

  // A table is a rebuilt target table if there is a temp table created in this migration
  // that is renamed to it, AND it was dropped in this migration.
  const rebuiltTargetTables = new Set<string>();
  for (const [from, to] of renamedFromTo) {
    if (createdInMigration.has(from) && droppedInMigration.has(to)) {
      rebuiltTargetTables.add(to);
    }
  }
  const tempCreatedTables = new Map<string, { stmt: string; columns: Record<string, string> }>();

  // Check if any statements are UPDATE
  for (const stmt of statements) {
    if (/^UPDATE\s+[^\s]+/i.test(stmt.trim())) {
      hasRewrite = true;
    }
  }

  for (const stmt of statements) {
    const created = parseCreateTableColumns(stmt);
    if (created) {
      if (renamedFromTo.has(created.tableName)) {
        tempCreatedTables.set(created.tableName, {
          stmt,
          columns: created.columns,
        });
        hasRewrite = true;
      } else {
        const prevCols = knownTables[created.tableName];
        if (prevCols) {
          for (const [col, prevType] of Object.entries(prevCols)) {
            const nextType = created.columns[col];
            if (!nextType) {
              findings.push({
                migrationName: name,
                statement: stmt,
                kind: "drop_column",
                affectedTable: created.tableName,
                affectedColumn: col,
                message: `Recreates table "${created.tableName}" without column "${col}".`,
              });
            } else if (isNarrowerSqlType(prevType, nextType)) {
              findings.push({
                migrationName: name,
                statement: stmt,
                kind: "type_narrowing",
                affectedTable: created.tableName,
                affectedColumn: col,
                message: `Narrows column "${created.tableName}.${col}" from ${prevType} to ${nextType}.`,
              });
            }
          }
        }
        knownTables[created.tableName] = { ...created.columns };
      }
      continue;
    }

    // ALTER TABLE ... ADD [COLUMN] ...
    const addColMatch = stmt.match(
      /^ALTER\s+TABLE\s+([^\s]+)\s+ADD\s+(?:COLUMN\s+)?([^\s]+)\s+([\s\S]+)$/i,
    );
    if (addColMatch) {
      const tbl = cleanSqlIdentifier(addColMatch[1]!);
      const col = cleanSqlIdentifier(addColMatch[2]!);
      const rest = addColMatch[3]!.trim();
      const hasNotNull = /\bNOT\s+NULL\b/i.test(rest);
      const hasDefault = /\bDEFAULT\b/i.test(rest);

      if (hasNotNull && !hasDefault) {
        findings.push({
          migrationName: name,
          statement: stmt,
          kind: "add_column_not_null",
          affectedTable: tbl,
          affectedColumn: col,
          message: `Adds NOT NULL column "${col}" to table "${tbl}" without a DEFAULT value.`,
        });
      }

      const colTypeMatch = rest.match(/^([A-Za-z0-9_]+(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?)/);
      const colType = colTypeMatch ? colTypeMatch[1]!.trim().toUpperCase() : "TEXT";
      knownTables[tbl] = {
        ...knownTables[tbl],
        [col]: colType,
      };
      continue;
    }

    // DROP TABLE
    const dropTableMatch = stmt.match(
      /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^\s;]+)/i,
    );
    if (dropTableMatch) {
      const affectedTable = cleanSqlIdentifier(dropTableMatch[1]!);
      if (rebuiltTargetTables.has(affectedTable)) {
        // Table rebuild pattern
        hasRewrite = true;
        const tempEntry = [...renamedFromTo.entries()].find(
          ([, target]) => target === affectedTable,
        );
        const tempInfo = tempEntry
          ? tempCreatedTables.get(tempEntry[0])
          : undefined;
        const prevCols = knownTables[affectedTable];

        if (tempInfo && prevCols) {
          for (const [col, prevType] of Object.entries(prevCols)) {
            const nextType = tempInfo.columns[col];
            if (!nextType) {
              findings.push({
                migrationName: name,
                statement: tempInfo.stmt,
                kind: "drop_column",
                affectedTable,
                affectedColumn: col,
                message: `Table rebuild on "${affectedTable}" drops column "${col}".`,
              });
            } else if (isNarrowerSqlType(prevType, nextType)) {
              findings.push({
                migrationName: name,
                statement: tempInfo.stmt,
                kind: "type_narrowing",
                affectedTable,
                affectedColumn: col,
                message: `Table rebuild on "${affectedTable}" narrows column "${col}" from ${prevType} to ${nextType}.`,
              });
            }
          }
        }

        if (tempInfo) {
          knownTables[affectedTable] = { ...tempInfo.columns };
        }
        continue;
      }

      findings.push({
        migrationName: name,
        statement: stmt,
        kind: "drop_table",
        affectedTable,
        message: `Drops table "${affectedTable}", permanently deleting all stored rows.`,
      });
      delete knownTables[affectedTable];
      continue;
    }

    // ALTER TABLE ... DROP [COLUMN]
    const dropColMatch = stmt.match(
      /^ALTER\s+TABLE\s+([^\s]+)\s+DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?([^\s;]+)/i,
    );
    if (dropColMatch) {
      const affectedTable = cleanSqlIdentifier(dropColMatch[1]!);
      const affectedColumn = cleanSqlIdentifier(dropColMatch[2]!);
      findings.push({
        migrationName: name,
        statement: stmt,
        kind: "drop_column",
        affectedTable,
        affectedColumn,
        message: `Drops column "${affectedColumn}" from table "${affectedTable}", permanently deleting its data.`,
      });
      if (knownTables[affectedTable]) {
        delete knownTables[affectedTable]![affectedColumn];
      }
      continue;
    }

    // ALTER TABLE ... ALTER/MODIFY/CHANGE COLUMN ... TYPE
    const alterTypeMatch =
      stmt.match(
        /^ALTER\s+TABLE\s+([^\s]+)\s+ALTER\s+(?:COLUMN\s+)?([^\s]+)\s+(?:SET\s+DATA\s+)?TYPE\s+(.+)$/i,
      ) ??
      stmt.match(
        /^ALTER\s+TABLE\s+([^\s]+)\s+MODIFY\s+(?:COLUMN\s+)?([^\s]+)\s+(.+)$/i,
      ) ??
      stmt.match(
        /^ALTER\s+TABLE\s+([^\s]+)\s+CHANGE\s+(?:COLUMN\s+)?[^\s]+\s+([^\s]+)\s+(.+)$/i,
      );
    if (alterTypeMatch) {
      const affectedTable = cleanSqlIdentifier(alterTypeMatch[1]!);
      const affectedColumn = cleanSqlIdentifier(alterTypeMatch[2]!);
      const nextTypeRaw = alterTypeMatch[3]!.trim();
      const prevType = knownTables[affectedTable]?.[affectedColumn];
      if (isNarrowerSqlType(prevType, nextTypeRaw)) {
        findings.push({
          migrationName: name,
          statement: stmt,
          kind: "type_narrowing",
          affectedTable,
          affectedColumn,
          message: prevType
            ? `Narrows column "${affectedTable}.${affectedColumn}" from ${prevType} to ${nextTypeRaw}.`
            : `Narrows column "${affectedTable}.${affectedColumn}" type to ${nextTypeRaw}.`,
        });
      }
      knownTables[affectedTable] = {
        ...knownTables[affectedTable],
        [affectedColumn]: nextTypeRaw.toUpperCase(),
      };
      continue;
    }

    // ALTER TABLE ... RENAME TO ...
    const renameMatch = stmt.match(
      /^ALTER\s+TABLE\s+([^\s]+)\s+RENAME\s+TO\s+([^\s]+)$/i,
    );
    if (renameMatch) {
      const fromTable = cleanSqlIdentifier(renameMatch[1]!);
      const toTable = cleanSqlIdentifier(renameMatch[2]!);
      const isRebuild =
        tempCreatedTables.has(fromTable) && rebuiltTargetTables.has(toTable);

      if (isRebuild) {
        hasRewrite = true;
        const tempInfo = tempCreatedTables.get(fromTable);
        if (tempInfo) {
          knownTables[toTable] = { ...tempInfo.columns };
          delete knownTables[fromTable];
        }
      } else {
        findings.push({
          migrationName: name,
          statement: stmt,
          kind: "rename_table",
          affectedTable: fromTable,
          message: `Renames table "${fromTable}" to "${toTable}", breaking queries referencing "${fromTable}".`,
        });
        if (knownTables[fromTable]) {
          knownTables[toTable] = { ...knownTables[fromTable]! };
          delete knownTables[fromTable];
        }
      }
      continue;
    }

    // TRUNCATE TABLE
    const truncateMatch = stmt.match(
      /^TRUNCATE\s+(?:TABLE\s+)?([^\s;]+)/i,
    );
    if (truncateMatch) {
      const affectedTable = cleanSqlIdentifier(truncateMatch[1]!);
      findings.push({
        migrationName: name,
        statement: stmt,
        kind: "truncate",
        affectedTable,
        message: `Truncates table "${affectedTable}", permanently removing all rows.`,
      });
      continue;
    }

    // DELETE FROM
    const deleteMatch = stmt.match(
      /^DELETE\s+FROM\s+([^\s;]+)(?:\s+WHERE\s+([\s\S]+))?$/i,
    );
    if (deleteMatch) {
      const affectedTable = cleanSqlIdentifier(deleteMatch[1]!);
      const whereClause = deleteMatch[2]?.trim();
      const isTrivialWhere =
        !whereClause ||
        /^1\s*=\s*1$/i.test(whereClause) ||
        /^true$/i.test(whereClause);
      if (isTrivialWhere) {
        findings.push({
          migrationName: name,
          statement: stmt,
          kind: "truncate",
          affectedTable,
          message: `Unqualified DELETE FROM "${affectedTable}" permanently removes all rows.`,
        });
      }
    }
  }

  let migrationClass: MigrationClass;
  if (findings.length > 0) {
    migrationClass = "destructive";
  } else if (hasRewrite) {
    migrationClass = "rewrite";
  } else {
    migrationClass = "additive";
  }

  const header = parseMigrationHeader(sql);
  return {
    class: migrationClass,
    findings,
    header,
  };
}
