import { DatabaseSync } from "node:sqlite";
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

// A D1-shaped wrapper around Node's own SQLite, so the plain-code parts of the Workflow can be tested in Node. It is only
// as good a stand-in for D1 as `prepare / bind / first / run / all` need to be; the real D1 is exercised in workerd by
// graph-workflow.node.test.ts. `reads` counts every statement that was run, so a test can say how often a table was read.
export function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  const log: string[] = [];
  const statement = (sql: string, values: unknown[] = []): D1Statement => ({
    bind: (...next) => statement(sql, next),
    first: async <Row>() => {
      await sleep(getAdapterDelay());
      log.push(sql);
      return ((db.prepare(sql).get(...(values as never[])) as Row | undefined) ?? null) as Row | null;
    },
    all: async <Row>() => {
      await sleep(getAdapterDelay());
      log.push(sql);
      const rows = db.prepare(sql).all(...(values as never[])) as Row[];
      return { results: rows, success: true, meta: { changes: 0 } } as D1Result<Row>;
    },
    run: async () => {
      await sleep(getAdapterDelay());
      log.push(sql);
      const result = db.prepare(sql).run(...(values as never[]));
      return { results: [], success: true, meta: { changes: Number(result.changes) } };
    },
  });
  const d1: D1Like = {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      await sleep(getAdapterDelay());
      return Promise.all(statements.map((s) => s.run()));
    },
    exec: async (sql) => {
      await sleep(getAdapterDelay());
      db.exec(sql);
    },
  };
  return { d1, db, statements: log, reads: (table: string) => log.filter((s) => /^\s*SELECT/i.test(s) && s.includes(table)).length };
}
