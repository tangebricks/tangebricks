import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { D1Like, D1Result, D1Statement } from "../../packages/sdk/src/index.ts";

/**
 * A D1-shaped database over a SQLite file, for operator tooling run from Node (story 2.5: the balance import tool).
 * Batches run as one transaction that rolls back whole when a statement raises, as D1's do. Not a test helper; the
 * DOM tests have their own in-memory adapter under bricks/credit-wallet/client/test/support.
 */
export function openSqliteD1(path: string): D1Like & { close(): void } {
  const sqlite = new DatabaseSync(path);
  const inside = new WeakMap<object, { sql: string; params: SQLInputValue[] }>();
  const execute = ({ sql, params }: { sql: string; params: SQLInputValue[] }): D1Result => {
    const result = sqlite.prepare(sql).run(...params);
    return { results: [], success: true, meta: { changes: Number(result.changes) } };
  };
  const statement = (sql: string, params: SQLInputValue[] = []): D1Statement => {
    const stmt: D1Statement = {
      bind: (...values) => statement(sql, values as SQLInputValue[]),
      async first<Row>() {
        const row = sqlite.prepare(sql).get(...params);
        return row ? ({ ...row } as Row) : null;
      },
      async run() {
        return execute({ sql, params });
      },
      async all<Row>() {
        const rows = sqlite.prepare(sql).all(...params).map((row) => ({ ...row }) as Row);
        return { results: rows, success: true, meta: { changes: 0 } } as D1Result<Row>;
      },
    };
    inside.set(stmt, { sql, params });
    return stmt;
  };
  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((stmt) => {
          const known = inside.get(stmt);
          if (!known) throw new Error("batch was given a statement this database did not prepare");
          return execute(known);
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql) {
      sqlite.exec(sql);
    },
    close: () => sqlite.close(),
  };
}
