import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { D1Like, D1Result, D1Statement } from "@poc/sdk";

function getAdapterDelay(): number {
  const envVal = process.env.DOM_TEST_ADAPTER_DELAY_MS;
  const num = envVal ? parseInt(envVal, 10) : 0;
  return isNaN(num) || num <= 0 ? 0 : num;
}

async function sleep(ms: number) {
  if (ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * A D1-shaped database over Node's built-in SQLite, so the DOM tests can serve the brick's real routes from Node.
 *
 * What it is: the same SQLite engine family that backs D1, with batches run as one transaction that rolls back whole
 * when a statement raises. What it is not: Cloudflare's D1, or workerd's local D1. The H5 concurrency evidence comes
 * from the workerd tests only; this adapter exists so a widget can be mounted against the real routes and real SQL,
 * and its two behaviours that the wallet relies on are pinned in sqlite-d1.test.ts.
 */
export function createSqliteD1(): D1Like & { close(): void } {
  const sqlite = new DatabaseSync(":memory:");
  const inside = new WeakMap<object, { sql: string; params: SQLInputValue[] }>();

  const execute = ({ sql, params }: { sql: string; params: SQLInputValue[] }): D1Result => {
    const result = sqlite.prepare(sql).run(...params);
    return { results: [], success: true, meta: { changes: Number(result.changes) } };
  };

  const statement = (sql: string, params: SQLInputValue[] = []): D1Statement => {
    const stmt: D1Statement = {
      bind: (...values) => statement(sql, values as SQLInputValue[]),
      async first<Row>() {
        await sleep(getAdapterDelay());
        const row = sqlite.prepare(sql).get(...params);
        return row ? ({ ...row } as Row) : null;
      },
      async run() {
        await sleep(getAdapterDelay());
        return execute({ sql, params });
      },
      async all<Row>() {
        await sleep(getAdapterDelay());
        const rows = sqlite
          .prepare(sql)
          .all(...params)
          .map((row) => ({ ...row }) as Row);
        return { results: rows, success: true, meta: { changes: 0 } } as D1Result<Row>;
      },
    };
    inside.set(stmt, { sql, params });
    return stmt;
  };

  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      await sleep(getAdapterDelay());
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
      await sleep(getAdapterDelay());
      sqlite.exec(sql);
    },
    close: () => sqlite.close(),
  };
}
