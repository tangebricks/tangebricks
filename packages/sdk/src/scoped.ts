import type { D1Like, D1Result, D1Statement } from "./d1.ts";
import { PLATFORM_LIMITS } from "./platform-limits.ts";

const IDENTIFIER_REGEX = /^[a-z_][a-z0-9_]*$/;
const ORDER_BY_REGEX = /^[a-z_][a-z0-9_]*(\s+(ASC|DESC))?(\s*,\s*[a-z_][a-z0-9_]*(\s+(ASC|DESC))?)*$/i;
const MAX_D1_BIND_PARAMS = PLATFORM_LIMITS.free.d1BindParams.limit;

function validateIdentifier(name: string, kind: "table" | "column"): void {
  if (!IDENTIFIER_REGEX.test(name)) {
    throw new Error(`INVALID_IDENTIFIER: ${kind} name '${name}' is invalid; must match /^[a-z_][a-z0-9_]*$/`);
  }
}

function validateBindCount(count: number, operation: string): void {
  if (count > MAX_D1_BIND_PARAMS) {
    throw new Error(`D1_BIND_LIMIT: ${operation} binds ${count} parameters, maximum allowed is ${MAX_D1_BIND_PARAMS}`);
  }
}

function validateWorkspaceId(workspaceId: string): void {
  if (
    typeof workspaceId !== "string" ||
    workspaceId.trim().length === 0 ||
    workspaceId.length > 200
  ) {
    throw new Error("TENANT_ID_INVALID: workspaceId must be a non-empty string of at most 200 characters");
  }
}

function validateWhereText(where?: string): void {
  if (!where || !where.trim()) return;
  const trimmed = where.trim();

  if (trimmed.includes(";")) {
    throw new Error("WHERE_UNSAFE: semicolons not permitted in where clause");
  }
  if (trimmed.includes("--")) {
    throw new Error("WHERE_UNSAFE: comment syntax '--' not permitted in where clause");
  }
  if (trimmed.includes("/*")) {
    throw new Error("WHERE_UNSAFE: comment syntax '/*' not permitted in where clause");
  }
  if (/\b(union|select)\b/i.test(trimmed)) {
    throw new Error("WHERE_UNSAFE: subqueries and union expressions not permitted in where clause");
  }

  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (char === "'") {
      if (inQuote && trimmed[i + 1] === "'") {
        i++; // skip escaped quote ''
      } else {
        inQuote = !inQuote;
      }
      continue;
    }
    if (!inQuote) {
      if (char === "(") {
        depth++;
      } else if (char === ")") {
        depth--;
        if (depth < 0) {
          throw new Error("WHERE_UNSAFE: unbalanced parentheses in where clause");
        }
      }
    }
  }

  if (depth !== 0 || inQuote) {
    throw new Error("WHERE_UNSAFE: unbalanced parentheses or unclosed string literal in where clause");
  }
}

function validateOrderBy(orderBy?: string): void {
  if (!orderBy || !orderBy.trim()) return;
  if (!ORDER_BY_REGEX.test(orderBy.trim())) {
    throw new Error(`ORDER_BY_UNSAFE: orderBy clause '${orderBy}' must match column sorting format`);
  }
}

function validateScopedRawQuery(
  sql: string,
  params: unknown[],
  scopedWorkspaceId: string,
  tableName: string
): void {
  validateBindCount(params.length, "raw");

  if (sql.includes(";")) {
    throw new Error(`TENANT_PREDICATE_MISSING: raw query on table '${tableName}' cannot contain semicolons`);
  }
  if (sql.includes("--") || sql.includes("/*")) {
    throw new Error(`TENANT_PREDICATE_MISSING: raw query on table '${tableName}' cannot contain comments`);
  }
  if (/\bunion\b/i.test(sql)) {
    throw new Error(`TENANT_PREDICATE_MISSING: raw query on table '${tableName}' cannot contain UNION expressions`);
  }
  if (/\bor\b/i.test(sql)) {
    throw new Error(`TENANT_PREDICATE_MISSING: raw query on table '${tableName}' cannot contain OR operators`);
  }
  if (/\bjoin\b/i.test(sql)) {
    throw new Error(
      `TENANT_PREDICATE_MISSING: raw query on table '${tableName}' cannot contain JOIN clauses; only single-table queries are permitted`
    );
  }

  const selectMatches = sql.match(/\bselect\b/gi) ?? [];
  const isSelectStatement = /^\s*select\b/i.test(sql);
  if (isSelectStatement && selectMatches.length > 1) {
    throw new Error(
      `TENANT_PREDICATE_MISSING: raw query on table '${tableName}' cannot contain nested SELECT or subqueries; only single-table queries are permitted`
    );
  }
  if (!isSelectStatement && selectMatches.length > 0) {
    throw new Error(
      `TENANT_PREDICATE_MISSING: raw query on table '${tableName}' cannot contain nested SELECT or subqueries; only single-table queries are permitted`
    );
  }

  const fromIdx = sql.search(/\bfrom\b/i);
  if (fromIdx !== -1) {
    const afterFrom = sql.slice(fromIdx + 4);
    const whereIdx = afterFrom.search(/\b(where|group\s+by|order\s+by|limit)\b/i);
    const fromClause = whereIdx !== -1 ? afterFrom.slice(0, whereIdx) : afterFrom;
    if (fromClause.includes(",")) {
      throw new Error(
        `TENANT_PREDICATE_MISSING: raw query on table '${tableName}' cannot query multiple tables in FROM list; only single-table queries are permitted`
      );
    }
  }

  const updateIdx = sql.search(/\bupdate\b/i);
  if (updateIdx !== -1) {
    const afterUpdate = sql.slice(updateIdx + 6);
    const setIdx = afterUpdate.search(/\bset\b/i);
    const updateClause = setIdx !== -1 ? afterUpdate.slice(0, setIdx) : afterUpdate;
    if (updateClause.includes(",")) {
      throw new Error(
        `TENANT_PREDICATE_MISSING: raw query on table '${tableName}' cannot update multiple tables; only single-table queries are permitted`
      );
    }
  }

  const whereMatch = sql.match(/\bwhere\b/i);
  if (!whereMatch || whereMatch.index === undefined) {
    throw new Error(
      `TENANT_PREDICATE_MISSING: raw query on table '${tableName}' must have a WHERE clause with 'workspace_id = ?'`
    );
  }

  // Find all matches for workspace_id = ?
  const predicateRegex = /\bworkspace_id\s*=\s*\?/gi;
  let match: RegExpExecArray | null;
  let validPredicateFound = false;

  while ((match = predicateRegex.exec(sql)) !== null) {
    const matchIndex = match.index;
    if (matchIndex <= whereMatch.index) {
      continue;
    }

    // Verify workspace_id = ? is a top-level term (parentheses depth is 0 from WHERE)
    let depth = 0;
    let inQuote = false;
    for (let i = whereMatch.index; i < matchIndex; i++) {
      const c = sql[i];
      if (c === "'") {
        if (inQuote && sql[i + 1] === "'") {
          i++;
        } else {
          inQuote = !inQuote;
        }
      } else if (!inQuote) {
        if (c === "(") depth++;
        else if (c === ")") depth--;
      }
    }

    if (depth !== 0) {
      continue;
    }

    // Count how many '?' appear in sql prior to this 'workspace_id = ?' placeholder
    let placeholderIndex = 0;
    let quoteState = false;
    for (let i = 0; i < matchIndex; i++) {
      const c = sql[i];
      if (c === "'") {
        if (quoteState && sql[i + 1] === "'") {
          i++;
        } else {
          quoteState = !quoteState;
        }
      } else if (!quoteState && c === "?") {
        placeholderIndex++;
      }
    }

    // Check if the scoped workspace id is bound at that placeholder position
    if (params.length > placeholderIndex && params[placeholderIndex] === scopedWorkspaceId) {
      validPredicateFound = true;
      break;
    }
  }

  if (!validPredicateFound) {
    throw new Error(
      `TENANT_PREDICATE_MISSING: raw query on table '${tableName}' must include a top-level 'workspace_id = ?' predicate bound to scoped tenant '${scopedWorkspaceId}' at its parameter slot`
    );
  }
}

export interface SelectOptions {
  orderBy?: string;
  limit?: number;
  offset?: number;
}

export interface ScopedDb {
  readonly workspaceId: string;
  select<T = Record<string, unknown>>(
    table: string,
    where?: string,
    params?: unknown[],
    options?: SelectOptions
  ): Promise<T[]>;
  first<T = Record<string, unknown>>(
    table: string,
    where?: string,
    params?: unknown[]
  ): Promise<T | null>;
  insert(table: string, row: Record<string, unknown>): Promise<D1Result>;
  update(
    table: string,
    set: Record<string, unknown>,
    where?: string,
    params?: unknown[]
  ): Promise<D1Result>;
  delete(table: string, where?: string, params?: unknown[]): Promise<D1Result>;
  raw(sql: string, params?: unknown[]): D1Statement & PromiseLike<D1Result>;
}

export interface GlobalDbTable {
  readonly table: string;
  readonly reason: string;
  select<T = Record<string, unknown>>(
    where?: string,
    params?: unknown[],
    options?: SelectOptions
  ): Promise<T[]>;
  select<T = Record<string, unknown>>(
    table: string,
    where?: string,
    params?: unknown[],
    options?: SelectOptions
  ): Promise<T[]>;
  first<T = Record<string, unknown>>(
    where?: string,
    params?: unknown[]
  ): Promise<T | null>;
  first<T = Record<string, unknown>>(
    table: string,
    where?: string,
    params?: unknown[]
  ): Promise<T | null>;
  insert(
    rowOrTable: Record<string, unknown> | string,
    maybeRow?: Record<string, unknown>
  ): Promise<D1Result>;
  update(
    setOrTable: Record<string, unknown> | string,
    maybeSetOrWhere?: unknown,
    maybeWhereOrParams?: unknown,
    maybeParams?: unknown[]
  ): Promise<D1Result>;
  delete(
    whereOrTable?: string,
    maybeWhereOrParams?: unknown,
    maybeParams?: unknown[]
  ): Promise<D1Result>;
  raw(sql: string, params?: unknown[]): D1Statement & PromiseLike<D1Result>;
}

function createStatementProxy(
  db: D1Like,
  sql: string,
  initialParams: unknown[],
  validateParams?: (params: unknown[]) => void
): D1Statement & PromiseLike<D1Result> {
  validateParams?.(initialParams);
  let currentStmt = db.prepare(sql).bind(...initialParams);

  const proxy: D1Statement & PromiseLike<D1Result> = {
    bind(...values: unknown[]) {
      validateParams?.(values);
      currentStmt = db.prepare(sql).bind(...values);
      return proxy;
    },
    first<Row = Record<string, unknown>>() {
      return currentStmt.first<Row>();
    },
    run() {
      return currentStmt.run();
    },
    all<Row = Record<string, unknown>>() {
      return currentStmt.all<Row>();
    },
    // oxlint-disable-next-line unicorn/no-thenable -- the statement proxy is awaitable on purpose: `await stmt` runs it like `stmt.all()`.
    then(onfulfilled, onrejected) {
      return currentStmt.all().then(onfulfilled, onrejected);
    },
  };

  return proxy;
}

class ScopedDbImpl implements ScopedDb {
  #workspaceId: string;
  private readonly db: D1Like;

  constructor(db: D1Like, workspaceId: string) {
    validateWorkspaceId(workspaceId);
    this.db = db;
    this.#workspaceId = workspaceId;
    Object.freeze(this);
  }

  get workspaceId(): string {
    return this.#workspaceId;
  }

  async select<T = Record<string, unknown>>(
    table: string,
    where?: string,
    params: unknown[] = [],
    options?: SelectOptions
  ): Promise<T[]> {
    validateIdentifier(table, "table");
    validateWhereText(where);
    validateOrderBy(options?.orderBy);

    const bound = [...params, this.workspaceId];
    validateBindCount(bound.length, "select");

    let sql = `SELECT * FROM ${table} WHERE `;
    if (where && where.trim()) {
      sql += `(${where.trim()}) AND workspace_id = ?`;
    } else {
      sql += `workspace_id = ?`;
    }

    if (options?.orderBy) {
      sql += ` ORDER BY ${options.orderBy}`;
    }
    if (typeof options?.limit === "number") {
      sql += ` LIMIT ${options.limit}`;
    }
    if (typeof options?.offset === "number") {
      sql += ` OFFSET ${options.offset}`;
    }

    const res = await this.db.prepare(sql).bind(...bound).all<T>();
    return res.results;
  }

  async first<T = Record<string, unknown>>(
    table: string,
    where?: string,
    params: unknown[] = []
  ): Promise<T | null> {
    validateIdentifier(table, "table");
    validateWhereText(where);

    const bound = [...params, this.workspaceId];
    validateBindCount(bound.length, "first");

    let sql = `SELECT * FROM ${table} WHERE `;
    if (where && where.trim()) {
      sql += `(${where.trim()}) AND workspace_id = ?`;
    } else {
      sql += `workspace_id = ?`;
    }
    sql += ` LIMIT 1`;

    return this.db.prepare(sql).bind(...bound).first<T>();
  }

  async insert(table: string, row: Record<string, unknown>): Promise<D1Result> {
    validateIdentifier(table, "table");
    if (
      row.workspace_id !== undefined &&
      row.workspace_id !== null &&
      row.workspace_id !== this.workspaceId
    ) {
      throw new Error(
        `TENANT_ID_CONFLICT: cannot insert row with workspace_id '${row.workspace_id}' into scoped workspace '${this.workspaceId}'`
      );
    }

    const data: Record<string, unknown> = { ...row, workspace_id: this.workspaceId };
    const keys = Object.keys(data);
    for (const k of keys) {
      validateIdentifier(k, "column");
    }

    const placeholders = keys.map(() => "?").join(", ");
    const values = keys.map((k) => data[k]);
    validateBindCount(values.length, "insert");

    const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`;
    return this.db.prepare(sql).bind(...values).run();
  }

  async update(
    table: string,
    set: Record<string, unknown>,
    where?: string,
    params: unknown[] = []
  ): Promise<D1Result> {
    validateIdentifier(table, "table");
    validateWhereText(where);

    if (
      set.workspace_id !== undefined &&
      set.workspace_id !== null &&
      set.workspace_id !== this.workspaceId
    ) {
      throw new Error(
        `TENANT_ID_CONFLICT: cannot update workspace_id to '${set.workspace_id}' in scoped workspace '${this.workspaceId}'`
      );
    }

    const setObj = { ...set };
    delete setObj.workspace_id;

    const setKeys = Object.keys(setObj);
    if (setKeys.length === 0) {
      return { results: [], success: true, meta: { changes: 0 } };
    }

    for (const k of setKeys) {
      validateIdentifier(k, "column");
    }

    const setClause = setKeys.map((k) => `${k} = ?`).join(", ");
    const setValues = setKeys.map((k) => setObj[k]);

    let whereClause = `WHERE `;
    if (where && where.trim()) {
      whereClause += `(${where.trim()}) AND workspace_id = ?`;
    } else {
      whereClause += `workspace_id = ?`;
    }

    const bound = [...setValues, ...params, this.workspaceId];
    validateBindCount(bound.length, "update");

    const sql = `UPDATE ${table} SET ${setClause} ${whereClause}`;
    return this.db.prepare(sql).bind(...bound).run();
  }

  async delete(table: string, where?: string, params: unknown[] = []): Promise<D1Result> {
    validateIdentifier(table, "table");
    validateWhereText(where);

    let whereClause = `WHERE `;
    if (where && where.trim()) {
      whereClause += `(${where.trim()}) AND workspace_id = ?`;
    } else {
      whereClause += `workspace_id = ?`;
    }

    const bound = [...params, this.workspaceId];
    validateBindCount(bound.length, "delete");

    const sql = `DELETE FROM ${table} ${whereClause}`;
    return this.db.prepare(sql).bind(...bound).run();
  }

  raw(sql: string, params: unknown[] = []): D1Statement & PromiseLike<D1Result> {
    const tableMatch = sql.match(/\b(?:from|update|into|join)\s+([a-z_][a-z0-9_]*)/i);
    const tableName: string = tableMatch?.[1] ?? "unknown";

    const validator = (p: unknown[]) => {
      validateScopedRawQuery(sql, p, this.workspaceId, tableName);
    };

    return createStatementProxy(this.db, sql, params, validator);
  }
}

class GlobalDbTableImpl implements GlobalDbTable {
  private readonly db: D1Like;
  readonly table: string;
  readonly reason: string;

  constructor(db: D1Like, table: string, reason: string) {
    validateIdentifier(table, "table");
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new Error(`GLOBAL_REASON_REQUIRED: accessing global table '${table}' requires a non-empty reason string`);
    }
    this.db = db;
    this.table = table;
    this.reason = reason;
  }

  private resolveArgs(
    arg0?: string,
    arg1?: unknown,
    arg2?: unknown,
    arg3?: SelectOptions
  ): { where?: string; params: unknown[]; options?: SelectOptions } {
    if (arg0 === this.table) {
      return {
        where: typeof arg1 === "string" ? arg1 : undefined,
        params: Array.isArray(arg2) ? arg2 : [],
        options: arg3,
      };
    }
    return {
      where: typeof arg0 === "string" ? arg0 : undefined,
      params: Array.isArray(arg1) ? (arg1 as unknown[]) : [],
      options: (arg2 && typeof arg2 === "object" && !Array.isArray(arg2)) ? (arg2 as SelectOptions) : undefined,
    };
  }

  select<T = Record<string, unknown>>(
    where?: string,
    params?: unknown[],
    options?: SelectOptions
  ): Promise<T[]>;
  select<T = Record<string, unknown>>(
    table: string,
    where?: string,
    params?: unknown[],
    options?: SelectOptions
  ): Promise<T[]>;
  async select<T = Record<string, unknown>>(
    whereOrTable?: string,
    paramsOrWhere?: unknown,
    maybeParams?: unknown,
    maybeOptions?: SelectOptions
  ): Promise<T[]> {
    const { where, params, options } = this.resolveArgs(
      whereOrTable,
      paramsOrWhere,
      maybeParams,
      maybeOptions
    );
    validateBindCount(params.length, "global.select");
    validateOrderBy(options?.orderBy);

    let sql = `SELECT * FROM ${this.table}`;
    if (where && where.trim()) {
      sql += ` WHERE ${where.trim()}`;
    }

    if (options?.orderBy) {
      sql += ` ORDER BY ${options.orderBy}`;
    }
    if (typeof options?.limit === "number") {
      sql += ` LIMIT ${options.limit}`;
    }
    if (typeof options?.offset === "number") {
      sql += ` OFFSET ${options.offset}`;
    }

    const res = await this.db.prepare(sql).bind(...params).all<T>();
    return res.results;
  }

  async first<T = Record<string, unknown>>(
    whereOrTable?: string,
    paramsOrWhere?: unknown,
    maybeParams?: unknown[]
  ): Promise<T | null> {
    const { where, params } = this.resolveArgs(whereOrTable, paramsOrWhere, maybeParams);
    validateBindCount(params.length, "global.first");

    let sql = `SELECT * FROM ${this.table}`;
    if (where && where.trim()) {
      sql += ` WHERE ${where.trim()}`;
    }
    sql += ` LIMIT 1`;

    return this.db.prepare(sql).bind(...params).first<T>();
  }

  async insert(
    rowOrTable: Record<string, unknown> | string,
    maybeRow?: Record<string, unknown>
  ): Promise<D1Result> {
    const row =
      typeof rowOrTable === "string" && maybeRow ? maybeRow : (rowOrTable as Record<string, unknown>);

    const keys = Object.keys(row);
    for (const k of keys) {
      validateIdentifier(k, "column");
    }

    const placeholders = keys.map(() => "?").join(", ");
    const values = keys.map((k) => row[k]);
    validateBindCount(values.length, "global.insert");

    const sql = `INSERT INTO ${this.table} (${keys.join(", ")}) VALUES (${placeholders})`;
    return this.db.prepare(sql).bind(...values).run();
  }

  async update(
    setOrTable: Record<string, unknown> | string,
    maybeSetOrWhere?: unknown,
    maybeWhereOrParams?: unknown,
    maybeParams?: unknown[]
  ): Promise<D1Result> {
    let set: Record<string, unknown>;
    let where: string | undefined;
    let params: unknown[] = [];

    if (typeof setOrTable === "string") {
      set = maybeSetOrWhere as Record<string, unknown>;
      where = typeof maybeWhereOrParams === "string" ? maybeWhereOrParams : undefined;
      params = Array.isArray(maybeParams) ? maybeParams : [];
    } else {
      set = setOrTable;
      where = typeof maybeSetOrWhere === "string" ? maybeSetOrWhere : undefined;
      params = Array.isArray(maybeWhereOrParams) ? maybeWhereOrParams : [];
    }

    const keys = Object.keys(set);
    if (keys.length === 0) {
      return { results: [], success: true, meta: { changes: 0 } };
    }

    for (const k of keys) {
      validateIdentifier(k, "column");
    }

    const setClause = keys.map((k) => `${k} = ?`).join(", ");
    const setValues = keys.map((k) => set[k]);

    let sql = `UPDATE ${this.table} SET ${setClause}`;
    if (where && where.trim()) {
      sql += ` WHERE ${where.trim()}`;
    }

    const bound = [...setValues, ...params];
    validateBindCount(bound.length, "global.update");

    return this.db.prepare(sql).bind(...bound).run();
  }

  async delete(
    whereOrTable?: string,
    maybeWhereOrParams?: unknown,
    maybeParams?: unknown[]
  ): Promise<D1Result> {
    const { where, params } = this.resolveArgs(whereOrTable, maybeWhereOrParams, maybeParams);
    validateBindCount(params.length, "global.delete");

    let sql = `DELETE FROM ${this.table}`;
    if (where && where.trim()) {
      sql += ` WHERE ${where.trim()}`;
    }

    return this.db.prepare(sql).bind(...params).run();
  }

  raw(sql: string, params: unknown[] = []): D1Statement & PromiseLike<D1Result> {
    const validator = (p: unknown[]) => {
      validateBindCount(p.length, "global.raw");
    };
    return createStatementProxy(this.db, sql, params, validator);
  }
}

export function scoped(db: D1Like, workspaceId: string): ScopedDb {
  return new ScopedDbImpl(db, workspaceId);
}

export function global(db: D1Like, table: string, reason: string): GlobalDbTable {
  return new GlobalDbTableImpl(db, table, reason);
}

export interface SystemScopeDb {
  readonly reason: string;
  select<T = Record<string, unknown>>(
    table: string,
    where?: string,
    params?: unknown[],
    options?: SelectOptions
  ): Promise<T[]>;
  first<T = Record<string, unknown>>(
    table: string,
    where?: string,
    params?: unknown[]
  ): Promise<T | null>;
  insert(table: string, row: Record<string, unknown>): Promise<D1Result>;
  update(
    table: string,
    set: Record<string, unknown>,
    where?: string,
    params?: unknown[]
  ): Promise<D1Result>;
  delete(table: string, where?: string, params?: unknown[]): Promise<D1Result>;
  raw(sql: string, params?: unknown[]): D1Statement & PromiseLike<D1Result>;
}

class SystemScopeDbImpl implements SystemScopeDb {
  readonly reason: string;
  private readonly db: D1Like;

  constructor(db: D1Like, reason: string) {
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new Error("SYSTEM_SCOPE_REASON_REQUIRED: systemScope requires a non-empty reason string");
    }
    this.reason = reason;
    this.db = db;
    Object.freeze(this);
  }

  async select<T = Record<string, unknown>>(
    table: string,
    where?: string,
    params: unknown[] = [],
    options?: SelectOptions
  ): Promise<T[]> {
    return global(this.db, table, this.reason).select<T>(where, params, options);
  }

  async first<T = Record<string, unknown>>(
    table: string,
    where?: string,
    params: unknown[] = []
  ): Promise<T | null> {
    return global(this.db, table, this.reason).first<T>(where, params);
  }

  async insert(table: string, row: Record<string, unknown>): Promise<D1Result> {
    return global(this.db, table, this.reason).insert(row);
  }

  async update(
    table: string,
    set: Record<string, unknown>,
    where?: string,
    params: unknown[] = []
  ): Promise<D1Result> {
    return global(this.db, table, this.reason).update(set, where, params);
  }

  async delete(table: string, where?: string, params: unknown[] = []): Promise<D1Result> {
    return global(this.db, table, this.reason).delete(where, params);
  }

  raw(sql: string, params: unknown[] = []): D1Statement & PromiseLike<D1Result> {
    return global(this.db, "system", this.reason).raw(sql, params);
  }
}

export function systemScope(db: D1Like, reason: string): SystemScopeDb {
  return new SystemScopeDbImpl(db, reason);
}

