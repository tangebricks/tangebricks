import { afterEach, describe, expect, test } from "vitest";
import { createSqliteD1 } from "./support/sqlite-d1.ts";

// The adapter only has to behave like D1 in the ways the wallet relies on (see the three facts at the top of
// bricks/credit-wallet/src/wallet.ts). They are checked here, the same way H5.control.test.ts checks workerd's D1.

const opened: Array<{ close(): void }> = [];
const open = () => {
  const db = createSqliteD1();
  opened.push(db);
  return db;
};
afterEach(() => opened.splice(0).forEach((db) => db.close()));

describe("the SQLite stand-in for D1", () => {
  test("a batch with a statement that raises rolls back whole, earlier statements included", async () => {
    const db = open();
    await db.prepare("CREATE TABLE t (id TEXT PRIMARY KEY, bal INTEGER NOT NULL CHECK (bal >= 0))").run();
    await db.prepare("INSERT INTO t VALUES ('a', 5)").run();
    await expect(
      db.batch([db.prepare("UPDATE t SET bal = bal + 100 WHERE id = 'a'"), db.prepare("UPDATE t SET bal = bal - 1000 WHERE id = 'a'")]),
    ).rejects.toThrow(/CHECK constraint failed/);
    expect((await db.prepare("SELECT bal FROM t WHERE id = 'a'").first<{ bal: number }>())?.bal).toBe(5);
  });

  test("an UPDATE that matches no rows is not an error, and the batch carries on", async () => {
    const db = open();
    await db.prepare("CREATE TABLE t (id TEXT PRIMARY KEY, bal INTEGER NOT NULL)").run();
    await db.prepare("INSERT INTO t VALUES ('a', 5)").run();
    const results = await db.batch([db.prepare("UPDATE t SET bal = bal - 1 WHERE id = 'nobody'"), db.prepare("UPDATE t SET bal = bal + 10 WHERE id = 'a'")]);
    expect(results.map((r) => r.meta.changes)).toEqual([0, 1]);
    expect((await db.prepare("SELECT bal FROM t WHERE id = 'a'").first<{ bal: number }>())?.bal).toBe(15);
  });

  test("bind, first, all and run behave as the wallet uses them", async () => {
    const db = open();
    await db.prepare("CREATE TABLE t (id TEXT, n INTEGER)").run();
    await db.prepare("INSERT INTO t VALUES (?, ?)").bind("x", 1).run();
    await db.prepare("INSERT INTO t VALUES (?, ?)").bind("y", 2).run();
    expect(await db.prepare("SELECT n FROM t WHERE id = ?").bind("y").first()).toEqual({ n: 2 });
    expect(await db.prepare("SELECT n FROM t WHERE id = ?").bind("nope").first()).toBeNull();
    expect((await db.prepare("SELECT id FROM t ORDER BY n").all()).results).toEqual([{ id: "x" }, { id: "y" }]);
  });

  test("a batch refuses a statement it did not prepare", async () => {
    const db = open();
    const other = open();
    await db.prepare("CREATE TABLE t (n INTEGER)").run();
    await expect(db.batch([other.prepare("SELECT 1")])).rejects.toThrow(/did not prepare/);
  });
});
